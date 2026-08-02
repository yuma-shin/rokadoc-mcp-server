/**
 * エラーハンドリング・フォーマット
 *
 * HTTPステータスコードに基づくエラー分類、MCP形式エラーレスポンス生成、
 * およびAPI Key値のサニタイズ処理を提供する。
 */

import { ErrorType, McpToolResult } from "../types.js";

/**
 * API Key値をエラーメッセージから除去するサニタイズ処理
 * @param message - サニタイズ対象の文字列
 * @param apiKey - 除去対象のAPI Key値
 * @returns API Key値が "***" に置換された文字列
 */
export function sanitizeApiKey(message: string, apiKey: string): string {
  if (!apiKey) {
    return message;
  }
  // グローバル置換で全出現箇所をマスク
  return message.split(apiKey).join("***");
}

/**
 * MCP形式のエラーレスポンスを生成する
 *
 * メッセージ構造: [エラー種別] 説明文\n---\n詳細情報\n---\n対処法
 *
 * @param type - エラー種別（ErrorType列挙型の値）
 * @param message - エラー説明文（詳細情報と対処法を含む場合は "\n---\n" で区切る）
 * @returns isError: true を含むMcpToolResult
 */
export function formatMcpError(
  type: ErrorType,
  message: string,
): McpToolResult {
  const formattedMessage = `[${type}] ${message}`;
  return {
    content: [{ type: "text", text: formattedMessage }],
    isError: true,
  };
}

/**
 * 未知のエラーからHTTPステータスコードを抽出する
 */
function getStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    // response.status パターン（fetch API等）
    if ("response" in error) {
      const response = (error as { response: unknown }).response;
      if (response && typeof response === "object" && "status" in response) {
        const status = (response as { status: unknown }).status;
        if (typeof status === "number") {
          return status;
        }
      }
    }
    // status プロパティ直接保持パターン
    if ("status" in error) {
      const status = (error as { status: unknown }).status;
      if (typeof status === "number") {
        return status;
      }
    }
    // statusCode プロパティパターン
    if ("statusCode" in error) {
      const statusCode = (error as { statusCode: unknown }).statusCode;
      if (typeof statusCode === "number") {
        return statusCode;
      }
    }
  }
  return undefined;
}

/**
 * エラーからレスポンスボディ（先頭500文字）を抽出する
 */
function getResponseBody(error: unknown): string {
  if (error && typeof error === "object") {
    // response.data パターン
    if ("response" in error) {
      const response = (error as { response: unknown }).response;
      if (response && typeof response === "object") {
        if ("data" in response) {
          const data = (response as { data: unknown }).data;
          const text = typeof data === "string" ? data : JSON.stringify(data);
          return text.slice(0, 500);
        }
        if ("body" in response) {
          const body = (response as { body: unknown }).body;
          const text = typeof body === "string" ? body : JSON.stringify(body);
          return text.slice(0, 500);
        }
      }
    }
    // body プロパティ直接保持パターン
    if ("body" in error) {
      const body = (error as { body: unknown }).body;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return text.slice(0, 500);
    }
  }
  return "";
}

/**
 * エラーメッセージ文字列を取得する
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

/**
 * タイムアウトエラーかどうかを判定する
 */
function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    // AbortError（fetch API のタイムアウト）
    if (error.name === "AbortError") {
      return true;
    }
    // メッセージに "timeout" を含む
    if (error.message.toLowerCase().includes("timeout")) {
      return true;
    }
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
      return true;
    }
  }
  return false;
}

/**
 * ネットワーク接続エラーかどうかを判定する
 */
function isConnectionError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      message.includes("dns") ||
      message.includes("getaddrinfo") ||
      message.includes("enetunreach") ||
      message.includes("ehostunreach")
    ) {
      return true;
    }
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ENETUNREACH" ||
      code === "EHOSTUNREACH"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 未知のエラーをHTTPステータスコードに基づいて分類し、
 * MCP形式のエラーレスポンスを生成する
 *
 * 分類ルール:
 * - HTTP 401/403 → 認証エラー
 * - タイムアウト（AbortError、"timeout"含むメッセージ） → タイムアウト
 * - DNS/TCP失敗（ECONNREFUSED, ENOTFOUND等） → 接続エラー
 * - その他4xx/5xx → APIエラー（ステータスコード + ボディ先頭500文字）
 * - その他 → APIエラー
 *
 * @param error - 分類対象のエラー（unknown型）
 * @returns MCP形式エラーレスポンス
 */
export function handleApiError(error: unknown): McpToolResult {
  // HTTPステータスコードベースの判定
  const statusCode = getStatusCode(error);

  if (statusCode !== undefined) {
    // 認証エラー: HTTP 401/403
    if (statusCode === 401 || statusCode === 403) {
      return formatMcpError(
        ErrorType.AUTH_ERROR,
        `rokadoc APIへの認証に失敗しました。\n---\nHTTP ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Forbidden"}\n---\n環境変数 ROKADOC_API_KEY に設定されたAPIキーが正しいことを確認してください。`,
      );
    }

    // その他 4xx/5xx → APIエラー
    if (statusCode >= 400) {
      const body = getResponseBody(error);
      const bodyInfo = body ? `\nレスポンスボディ: ${body}` : "";
      return formatMcpError(
        ErrorType.API_ERROR,
        `rokadoc APIがエラーを返却しました。\n---\nHTTP ${statusCode}${bodyInfo}\n---\nリクエスト内容を確認し、再度お試しください。`,
      );
    }
  }

  // タイムアウトエラー
  if (isTimeoutError(error)) {
    return formatMcpError(
      ErrorType.TIMEOUT,
      `rokadoc APIへの接続がタイムアウトしました。\n---\n${getErrorMessage(error)}\n---\n環境変数 ROKADOC_BASE_URL に設定された接続先URLが正しいことを確認してください。`,
    );
  }

  // 接続エラー（DNS/TCP）
  if (isConnectionError(error)) {
    return formatMcpError(
      ErrorType.CONNECTION_ERROR,
      `rokadoc APIへの接続に失敗しました。\n---\n${getErrorMessage(error)}\n---\nネットワーク接続および ROKADOC_BASE_URL に設定されたURLが正しいことを確認してください。`,
    );
  }

  // その他のエラー → APIエラーとして処理
  return formatMcpError(
    ErrorType.API_ERROR,
    `予期しないエラーが発生しました。\n---\n${getErrorMessage(error)}\n---\nエラーが継続する場合は、設定とネットワーク接続を確認してください。`,
  );
}

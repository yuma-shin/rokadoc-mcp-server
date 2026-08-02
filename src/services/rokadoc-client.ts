/**
 * rokadoc API HTTPクライアント
 *
 * rokadoc APIとの全通信を担当する。
 * - 全リクエストに `api-key` ヘッダーを付与
 * - 送信先をBase URLのホストのみに制限
 * - 30秒タイムアウト設定（AbortController使用）
 * - リトライロジック（5xx/ネットワークエラー: 最大3回、2秒間隔。4xxはリトライなし）
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  ServerConfig,
  ConversionJob,
  SearchResult,
  SearchResponse,
  ListConversionsResponse,
  GetConversionResultResponse,
  Space,
  ListSpacesResponse,
  DEFAULT_RETRY_CONFIG,
} from "../types.js";
import { isAllowedHost } from "../utils/url-validator.js";

/** ページ範囲指定オプション */
interface PageRange {
  from_page?: number;
  to_page?: number;
  space_id?: string;
}

/** 検索オプション */
interface SearchOptions {
  tags?: string[];
  max_results?: number;
  tags_filter_include?: boolean;
  space_id?: string;
}

/** 変換リクエストレスポンス */
interface ConversionResponse {
  code: number;
  status: string;
  conversion_id: string;
}

/** 変換結果ドキュメント */
// GetConversionResultResponse is imported from types.ts

/** リクエストタイムアウト（ミリ秒） */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * rokadoc APIクライアント
 *
 * コンストラクタで ServerConfig を受け取り、全APIメソッドで共通の
 * ヘッダー付与・ホスト検証・タイムアウト・リトライ処理を適用する。
 */
export class RokadocApiClient {
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /**
   * 共通リクエストメソッド
   *
   * - ホスト検証: Base URLのホスト以外へのリクエストを拒否
   * - api-key ヘッダー付与
   * - 30秒タイムアウト（AbortController）
   * - リトライ: 5xx/ネットワークエラーは最大3回・2秒間隔、4xxはリトライなし
   */
  private async request<T>(url: string, options: RequestInit): Promise<T> {
    // ホスト検証
    if (!isAllowedHost(url, this.config.baseUrl)) {
      throw new Error(`リクエスト先ホストが許可されていません: ${url}`);
    }

    const { maxRetries, retryDelay, retryableStatuses } = DEFAULT_RETRY_CONFIG;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // リトライ待機（初回は待機なし）
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            ...options.headers,
            "api-key": this.config.apiKey,
          },
        });

        clearTimeout(timeoutId);

        // 成功レスポンス
        if (response.ok) {
          return (await response.json()) as T;
        }

        // 4xx: リトライなし、即座にエラー
        if (response.status >= 400 && response.status < 500) {
          const body = await response.text().catch(() => "");
          const error = new Error(
            `HTTP ${response.status}: ${response.statusText}`,
          );
          Object.assign(error, {
            status: response.status,
            body: body.slice(0, 500),
          });
          throw error;
        }

        // 5xx: リトライ対象か確認
        if (retryableStatuses.includes(response.status)) {
          const body = await response.text().catch(() => "");
          const retryError = new Error(
            `HTTP ${response.status}: ${response.statusText}`,
          );
          Object.assign(retryError, {
            status: response.status,
            body: body.slice(0, 500),
          });
          lastError = retryError;
          continue;
        }

        // その他の5xxステータス（retryableStatusesに含まれない場合）
        const body = await response.text().catch(() => "");
        const error = new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
        Object.assign(error, {
          status: response.status,
          body: body.slice(0, 500),
        });
        throw error;
      } catch (error) {
        clearTimeout(timeoutId);

        // 4xxエラーや意図的にthrowされたエラーはそのまま再throw
        if (
          error instanceof Error &&
          "status" in error &&
          typeof (error as { status: unknown }).status === "number"
        ) {
          const status = (error as { status: number }).status;
          if (status >= 400 && status < 500) {
            throw error;
          }
        }

        // ネットワークエラー/タイムアウト → リトライ対象
        lastError = error;
        if (attempt < maxRetries) {
          continue;
        }
      }
    }

    // 全リトライ失敗後、最後のエラーをthrow
    throw lastError;
  }

  /**
   * ドキュメント変換リクエスト
   *
   * POST /v1/api/conversions (multipart/form-data)
   *
   * @param filePath - 変換対象のファイルパス
   * @param options - ページ範囲指定（任意）
   * @returns 変換ジョブIDとステータス
   */
  async createConversion(
    filePath: string,
    options?: PageRange,
  ): Promise<ConversionResponse> {
    const url = `${this.config.baseUrl}/v1/api/conversions`;

    const fileBuffer = await readFile(filePath);
    const fileName = basename(filePath);

    const formData = new FormData();
    formData.append("upload_file", new Blob([fileBuffer]), fileName);
    formData.append("vllm_name", "null");
    formData.append("layout_algo_names", "miner_layout_text_line");
    formData.append("layout_algo_names", "com_layout_only");
    formData.append("layout_algo_names", "com_layout_text_line");

    if (options?.from_page !== undefined) {
      formData.append("from_page", String(options.from_page));
    }
    if (options?.to_page !== undefined) {
      formData.append("to_page", String(options.to_page));
    }
    if (options?.space_id !== undefined) {
      formData.append("space_id", options.space_id);
    }

    return this.request<ConversionResponse>(url, {
      method: "POST",
      body: formData,
    });
  }

  /**
   * 変換ジョブ一覧取得
   *
   * GET /v1/user/conversions
   *
   * @param spaceId - スペースID（任意）
   * @returns 変換ジョブの配列
   */
  async listConversions(spaceId?: string): Promise<ConversionJob[]> {
    let url = `${this.config.baseUrl}/v1/user/conversions`;
    if (spaceId) {
      url += `?space_id=${encodeURIComponent(spaceId)}`;
    }

    const response = await this.request<ListConversionsResponse>(url, {
      method: "GET",
    });

    return response.data;
  }

  /**
   * 変換結果取得
   *
   * GET /v1/user/conversions/{id}/document
   *
   * @param conversionId - 変換ジョブID
   * @param spaceId - スペースID（任意）
   * @returns 変換結果レスポンス（status, roka_response等を含む）
   */
  async getConversionResult(
    conversionId: string,
    spaceId?: string,
  ): Promise<GetConversionResultResponse> {
    let url = `${this.config.baseUrl}/v1/user/conversions/${encodeURIComponent(conversionId)}/document`;
    if (spaceId) {
      url += `?space_id=${encodeURIComponent(spaceId)}`;
    }

    return this.request<GetConversionResultResponse>(url, {
      method: "GET",
    });
  }

  /**
   * ユーザーがアクセス可能なスペース一覧を取得
   *
   * GET /v1/user/spaces/join
   *
   * @returns スペース情報の配列（space_id, space_name）
   */
  async listSpaces(): Promise<Space[]> {
    const url = `${this.config.baseUrl}/v1/user/spaces/join`;

    const response = await this.request<ListSpacesResponse>(url, {
      method: "GET",
    });

    return response.data;
  }

  /**
   * RAGドキュメント検索
   *
   * GET /v1/api/search
   *
   * @param query - 検索クエリ（message パラメータとして送信）
   * @param options - 検索オプション（タグフィルタ、最大件数、スペースID）
   * @returns 検索結果の配列
   */
  async searchDocuments(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams();
    params.append("message", query);

    if (options?.max_results !== undefined) {
      params.append("search_top_k", String(options.max_results));
    }
    if (options?.tags !== undefined && options.tags.length > 0) {
      for (const tag of options.tags) {
        params.append("tags_filter", tag);
      }
      params.append(
        "tags_filter_include",
        String(options.tags_filter_include ?? true),
      );
    }
    if (options?.space_id !== undefined) {
      params.append("space_id", options.space_id);
    }

    const url = `${this.config.baseUrl}/v1/api/search?${params.toString()}`;

    const response = await this.request<SearchResponse>(url, {
      method: "GET",
    });

    return response.search_result;
  }
}

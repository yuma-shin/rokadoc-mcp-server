/**
 * MCPサーバーのツール登録
 *
 * サーバー名・バージョンの定義と、4つのツール登録処理を提供する。
 * index.ts とテストの両方から利用され、登録内容の重複定義を防ぐ。
 *
 * 各ツールには MCP 仕様の4つのアノテーションヒント
 * （readOnlyHint / destructiveHint / idempotentHint / openWorldHint）を
 * 明示的に指定し、ホストがユーザーに影響範囲を事前提示できるようにする。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RokadocApiClient } from "./services/rokadoc-client.js";
import { handleConvertDocument } from "./tools/convert-document.js";
import { handleListConversions } from "./tools/list-conversions.js";
import { handleGetConversionResult } from "./tools/get-conversion-result.js";
import { handleSearchDocuments } from "./tools/search-documents.js";

/** MCPサーバー名 */
export const SERVER_NAME = "rokadoc-mcp-server";

/** MCPサーバーバージョン */
export const SERVER_VERSION = "1.0.0";

/**
 * スペース指定の共通パラメータ
 *
 * space_id が指定されている場合はそれを使用し、
 * space_name のみが指定されている場合はスペース一覧APIでIDを解決する。
 */
const spaceParams = {
  space_id: z.string().optional().describe("スペースID"),
  space_name: z
    .string()
    .optional()
    .describe("スペース名（space_id が指定されている場合は無視されます）"),
};

/**
 * 読み取り専用ツール共通のアノテーション
 *
 * rokadoc APIに対してGETのみを行い、リモートの状態を変更しない。
 * 同一入力での再実行は追加の副作用を持たない（べき等）。
 * 外部サービス（rokadoc API）と通信するため openWorldHint は true。
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * 4つのツールを MCPサーバーに登録する
 *
 * @param server - 登録先の McpServer インスタンス
 * @param apiClient - rokadoc APIクライアント
 */
export function registerTools(
  server: McpServer,
  apiClient: RokadocApiClient,
): void {
  // convert_document: 変換ジョブを新規作成するため書き込み系
  // 既存データの削除・上書きは行わないため destructiveHint は false
  // 呼び出しごとに新しい conversion_id が払い出されるため冪等ではない
  server.registerTool(
    "convert_document",
    {
      title: "ドキュメント変換",
      description:
        "ドキュメントファイルをrokadocに送信して構造化テキストに変換する",
      inputSchema: {
        file_path: z.string().min(1).describe("変換対象のファイルパス"),
        from_page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("開始ページ（正の整数）"),
        to_page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("終了ページ（正の整数）"),
        ...spaceParams,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      return handleConvertDocument(args, apiClient) as Promise<CallToolResult>;
    },
  );

  // list_conversions: ジョブ一覧をGETするのみ
  server.registerTool(
    "list_conversions",
    {
      title: "変換ジョブ一覧",
      description: "変換ジョブの一覧を取得する",
      inputSchema: { ...spaceParams },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      return handleListConversions(args, apiClient) as Promise<CallToolResult>;
    },
  );

  // get_conversion_result: 変換結果をGETするのみ
  server.registerTool(
    "get_conversion_result",
    {
      title: "変換結果取得",
      description: "指定された変換ジョブの結果を取得する",
      inputSchema: {
        conversion_id: z.string().min(1).describe("変換ジョブID"),
        ...spaceParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      return handleGetConversionResult(
        args,
        apiClient,
      ) as Promise<CallToolResult>;
    },
  );

  // search_documents: RAG検索をGETするのみ
  server.registerTool(
    "search_documents",
    {
      title: "ドキュメント検索",
      description: "rokadocに登録されたドキュメントに対してRAG検索を実行する",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(1000)
          .describe("検索クエリ（1〜1000文字）"),
        tags: z
          .array(z.string())
          .optional()
          .describe("タグフィルタ（AND条件）"),
        max_results: z
          .number()
          .int()
          .positive()
          .max(5)
          .default(3)
          .optional()
          .describe("最大取得件数（デフォルト: 3、最大: 5）"),
        ...spaceParams,
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      return handleSearchDocuments(args, apiClient) as Promise<CallToolResult>;
    },
  );
}

/**
 * ツール登録済みの MCPサーバーインスタンスを生成する
 *
 * @param apiClient - rokadoc APIクライアント
 * @returns 4つのツールが登録された McpServer
 */
export function createServer(apiClient: RokadocApiClient): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server, apiClient);

  return server;
}

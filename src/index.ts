/**
 * rokadoc MCPサーバー エントリーポイント
 *
 * McpServerインスタンスの作成、設定読み込み、ツール登録、
 * stdioトランスポート起動、シャットダウン処理を行う。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { RokadocApiClient } from "./services/rokadoc-client.js";
import { handleConvertDocument } from "./tools/convert-document.js";
import { handleListConversions } from "./tools/list-conversions.js";
import { handleGetConversionResult } from "./tools/get-conversion-result.js";
import { handleSearchDocuments } from "./tools/search-documents.js";

async function main() {
  // 設定読み込みと検証（失敗時はプロセス終了）
  const config = loadConfig();

  // APIクライアント作成
  const apiClient = new RokadocApiClient(config);

  // MCPサーバーインスタンス作成
  const server = new McpServer({
    name: "rokadoc-mcp-server",
    version: "1.0.0",
  });

  // ツール登録: convert_document
  server.tool(
    "convert_document",
    "ドキュメントファイルをrokadocに送信して構造化テキストに変換する",
    {
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
      space_id: z.string().optional().describe("スペースID"),
      space_name: z
        .string()
        .optional()
        .describe("スペース名（space_idに優先されない）"),
    },
    async (args) => {
      return handleConvertDocument(args, apiClient) as Promise<CallToolResult>;
    },
  );

  // ツール登録: list_conversions
  server.tool(
    "list_conversions",
    "変換ジョブの一覧を取得する",
    {
      space_id: z.string().optional().describe("スペースID"),
      space_name: z
        .string()
        .optional()
        .describe("スペース名（space_idに優先されない）"),
    },
    async (args) => {
      return handleListConversions(args, apiClient) as Promise<CallToolResult>;
    },
  );

  // ツール登録: get_conversion_result
  server.tool(
    "get_conversion_result",
    "指定された変換ジョブの結果を取得する",
    {
      conversion_id: z.string().min(1).describe("変換ジョブID"),
      space_id: z.string().optional().describe("スペースID"),
      space_name: z
        .string()
        .optional()
        .describe("スペース名（space_idに優先されない）"),
    },
    async (args) => {
      return handleGetConversionResult(
        args,
        apiClient,
      ) as Promise<CallToolResult>;
    },
  );

  // ツール登録: search_documents
  server.tool(
    "search_documents",
    "rokadocに登録されたドキュメントに対してRAG検索を実行する",
    {
      query: z.string().min(1).max(1000).describe("検索クエリ（1〜1000文字）"),
      tags: z.array(z.string()).optional().describe("タグフィルタ（AND条件）"),
      max_results: z
        .number()
        .int()
        .positive()
        .max(5)
        .default(3)
        .optional()
        .describe("最大取得件数（デフォルト: 3、最大: 5）"),
      space_id: z.string().optional().describe("スペースID"),
      space_name: z
        .string()
        .optional()
        .describe("スペース名（space_idに優先されない）"),
    },
    async (args) => {
      return handleSearchDocuments(args, apiClient) as Promise<CallToolResult>;
    },
  );

  // stdioトランスポートの作成とサーバー接続
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // グレースフルシャットダウン処理
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `[起動エラー] MCPサーバーの起動に失敗しました: ${error}\n`,
  );
  process.exit(1);
});

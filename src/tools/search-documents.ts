/**
 * search_documents ツール
 *
 * RAGドキュメント検索を実行し、関連ドキュメントのコンテキスト・ページ番号等を返す。
 * - Zodスキーマによる入力バリデーション
 * - 空白のみクエリのバリデーションエラー
 * - space_name指定時はスペース一覧から対応するspace_idを解決
 * - space_id/space_name未指定時は全スペースから検索
 * - RokadocApiClientを介した検索実行
 */

import { z } from "zod";
import { RokadocApiClient } from "../services/rokadoc-client.js";
import { McpToolResult, ErrorType } from "../types.js";
import { formatMcpError, handleApiError } from "../utils/error-handler.js";

/**
 * search_documents ツール入力スキーマ
 *
 * - query: 必須、1〜1000文字（APIの message パラメータに対応）
 * - tags: 任意、文字列配列（APIの tags_filter パラメータに対応、AND条件フィルタ）
 * - max_results: 任意、正の整数、最大5、デフォルト3（APIの search_top_k パラメータに対応）
 * - space_id: 任意、スペースID文字列（直接指定）
 * - space_name: 任意、スペース名（名前からspace_idを解決する）
 */
export const searchDocumentsInputSchema = z.object({
  query: z.string().min(1).max(1000),
  tags: z.array(z.string()).optional(),
  max_results: z.number().int().positive().max(5).default(3).optional(),
  space_id: z.string().optional(),
  space_name: z.string().optional(),
});

export type SearchDocumentsInput = z.infer<typeof searchDocumentsInputSchema>;

/**
 * search_documents ツールハンドラー
 *
 * @param input - バリデーション済みの検索入力
 * @param client - rokadoc APIクライアント
 * @returns MCP形式のツール結果
 */
export async function handleSearchDocuments(
  input: SearchDocumentsInput,
  client: RokadocApiClient,
): Promise<McpToolResult> {
  // 空白のみクエリチェック（Zod min(1) は空文字を弾くが空白のみは通過するため）
  if (input.query.trim() === "") {
    return formatMcpError(
      ErrorType.VALIDATION_ERROR,
      `検索クエリが空白のみです。\n---\n有効な検索テキストを入力してください。\n---\n1文字以上1000文字以下の検索クエリを指定してください。`,
    );
  }

  // スペースIDの解決
  let resolvedSpaceId = input.space_id;

  // space_nameが指定されている場合、スペース一覧からspace_idを解決する
  if (input.space_name && !resolvedSpaceId) {
    try {
      const spaces = await client.listSpaces();
      const matched = spaces.find((s) => s.space_name === input.space_name);
      if (!matched) {
        return formatMcpError(
          ErrorType.VALIDATION_ERROR,
          `指定されたスペース名が見つかりません: "${input.space_name}"\n---\nアクセス可能なスペース一覧に該当するスペースが存在しません。\n---\nスペース名が正しいことを確認してください。`,
        );
      }
      resolvedSpaceId = matched.space_id;
    } catch (error) {
      return handleApiError(error);
    }
  }

  try {
    const results = await client.searchDocuments(input.query, {
      tags: input.tags,
      max_results: input.max_results ?? 3,
      space_id: resolvedSpaceId,
    });

    const formatted = results.map((r) => ({
      document_name: r.pdf_name,
      context: r.context,
      page_number: r.page_number,
      conversion_id: r.conversion_id,
      tags: r.tags,
    }));

    return {
      content: [
        { type: "text", text: JSON.stringify({ results: formatted }, null, 2) },
      ],
    };
  } catch (error) {
    return handleApiError(error);
  }
}

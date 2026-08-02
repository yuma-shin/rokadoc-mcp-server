/**
 * list_conversions ツール
 *
 * ユーザーの変換ジョブ一覧を取得し、
 * conversion_id、ステータス、作成日時を含むレスポンスを返す。
 * - space_id または space_name でスペースを指定可能
 * - 未指定時は全スペースのジョブを取得
 */

import { z } from "zod";
import { RokadocApiClient } from "../services/rokadoc-client.js";
import { McpToolResult, ErrorType } from "../types.js";
import { formatMcpError, handleApiError } from "../utils/error-handler.js";

/**
 * list_conversions ツール入力スキーマ
 */
export const listConversionsInputSchema = z.object({
  space_id: z.string().optional(),
  space_name: z.string().optional(),
});

export type ListConversionsInput = z.infer<typeof listConversionsInputSchema>;

/**
 * list_conversions ツールハンドラー
 *
 * RokadocApiClientを介してジョブ一覧を取得し、
 * conversion_id、status、document_name、created_date、updated_date を含むフォーマットで返却する。
 *
 * @param input - バリデーション済み入力（space_id/space_name任意）
 * @param client - rokadoc APIクライアント
 * @returns MCP形式のツール結果
 */
export async function handleListConversions(
  input: ListConversionsInput,
  client: RokadocApiClient,
): Promise<McpToolResult> {
  // スペースIDの解決
  let resolvedSpaceId = input.space_id;
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
    const conversions = await client.listConversions(resolvedSpaceId);

    // Format response with conversion_id, status, document_name, created_date, updated_date
    const formatted = conversions.map((job) => ({
      conversion_id: job.conversion_id,
      status: job.status,
      document_name: job.document_name,
      created_date: job.created_date,
      updated_date: job.updated_date,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ conversions: formatted }, null, 2),
        },
      ],
    };
  } catch (error) {
    return handleApiError(error);
  }
}

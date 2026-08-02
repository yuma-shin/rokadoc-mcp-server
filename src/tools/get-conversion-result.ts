/**
 * get_conversion_result ツール
 *
 * 指定されたconversion_idの変換結果ドキュメントを取得する。
 * - Zodスキーマによる入力バリデーション（conversion_id: 必須文字列）
 * - RokadocApiClientを介した変換結果取得
 * - ジョブ未存在時（HTTP 404）のエラーメッセージ返却
 * - ジョブ未完了時（HTTP 200 + roka_response: null）のエラーメッセージ + 現在ステータス返却
 */

import { z } from "zod";
import { RokadocApiClient } from "../services/rokadoc-client.js";
import { McpToolResult, ErrorType } from "../types.js";
import { formatMcpError, handleApiError } from "../utils/error-handler.js";

/**
 * get_conversion_result ツール入力スキーマ
 */
export const getConversionResultInputSchema = z.object({
  conversion_id: z.string().min(1, "conversion_idは必須です"),
  space_id: z.string().optional(),
  space_name: z.string().optional(),
});

export type GetConversionResultInput = z.infer<
  typeof getConversionResultInputSchema
>;

/**
 * get_conversion_result ツールハンドラー
 *
 * 指定されたconversion_idの変換結果を取得し、MCP形式で返却する。
 * APIは未完了時もHTTP 200を返し、data.roka_responseがnullになる。
 *
 * @param input - バリデーション済み入力（conversion_id）
 * @param client - rokadoc APIクライアント
 * @returns 変換結果ドキュメントまたはエラーレスポンス
 */
export async function handleGetConversionResult(
  input: GetConversionResultInput,
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
    const result = await client.getConversionResult(
      input.conversion_id,
      resolvedSpaceId,
    );

    // ジョブ未完了: roka_responseがnullの場合
    if (result.data.roka_response === null) {
      return {
        content: [
          {
            type: "text",
            text: `ジョブが未完了です。\n\nconversion_id: ${input.conversion_id}\n現在のステータス: ${result.data.status}\n\nジョブの完了後に再度お試しください。`,
          },
        ],
      };
    }

    // 変換結果を整形して返却
    const output = {
      conversion_id: result.data.conversion_id,
      document_name: result.data.document_name,
      status: result.data.status,
      roka_response: result.data.roka_response,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  } catch (error) {
    // HTTPステータスコードに基づくエラー分類
    if (error && typeof error === "object" && "status" in error) {
      const status = (error as { status: number }).status;

      // HTTP 404: ジョブが見つからない
      if (status === 404) {
        return formatMcpError(
          ErrorType.API_ERROR,
          `指定されたジョブが見つかりません。\n---\nconversion_id: ${input.conversion_id}\n---\nconversion_idが正しいことを確認してください。`,
        );
      }
    }

    // その他のエラー（認証エラー、タイムアウト、接続エラー等）は共通ハンドラーに委譲
    return handleApiError(error);
  }
}

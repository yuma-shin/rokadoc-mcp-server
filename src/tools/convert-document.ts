/**
 * convert_document ツール
 *
 * ファイルをrokadoc APIに送信してMarkdownへの変換を開始する。
 * - Zodスキーマによる入力バリデーション
 * - ファイル形式チェック（PDF, Word, Excel, PowerPoint）
 * - ページ範囲バリデーション
 * - ファイル存在チェック
 * - RokadocApiClientを介したAPI呼び出し
 */

import { z } from "zod";
import { access } from "node:fs/promises";
import { extname } from "node:path";
import { RokadocApiClient } from "../services/rokadoc-client.js";
import { McpToolResult, ErrorType } from "../types.js";
import { formatMcpError, handleApiError } from "../utils/error-handler.js";

/** サポートされるファイル拡張子 */
const SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

/** Zod入力スキーマ */
export const convertDocumentInputSchema = z.object({
  file_path: z.string().min(1, "ファイルパスは必須です"),
  from_page: z.number().int().positive().optional(),
  to_page: z.number().int().positive().optional(),
  space_id: z.string().optional(),
  space_name: z.string().optional(),
});

/** 入力型 */
export type ConvertDocumentInput = z.infer<typeof convertDocumentInputSchema>;

/**
 * convert_document ツールハンドラー
 *
 * @param input - バリデーション済み入力パラメータ
 * @param client - rokadoc APIクライアント
 * @returns MCP形式のツール結果
 */
export async function handleConvertDocument(
  input: ConvertDocumentInput,
  client: RokadocApiClient,
): Promise<McpToolResult> {
  const filePath = input.file_path;

  // 1. ファイル拡張子チェック
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return formatMcpError(
      ErrorType.VALIDATION_ERROR,
      `未対応のファイル形式です: ${ext}\n---\n指定されたファイル: ${filePath}\n---\nサポートされるファイル形式: PDF (.pdf), Word (.doc, .docx), Excel (.xls, .xlsx), PowerPoint (.ppt, .pptx)`,
    );
  }

  // 2. ページ範囲バリデーション
  if (
    input.from_page !== undefined &&
    input.to_page !== undefined &&
    input.from_page > input.to_page
  ) {
    return formatMcpError(
      ErrorType.VALIDATION_ERROR,
      `無効なページ範囲です: from_page (${input.from_page}) が to_page (${input.to_page}) より大きい値です。\n---\nfrom_page=${input.from_page}, to_page=${input.to_page}\n---\nfrom_page には to_page 以下の値を指定してください。`,
    );
  }

  // 3. ファイル存在チェック
  try {
    await access(filePath);
  } catch {
    return formatMcpError(
      ErrorType.VALIDATION_ERROR,
      `ファイルが見つかりません: ${filePath}\n---\n指定されたパスにファイルが存在しません。\n---\nファイルパスが正しいことを確認してください。`,
    );
  }

  // 4. スペースIDの解決
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

  // 5. API呼び出し
  try {
    const result = await client.createConversion(filePath, {
      from_page: input.from_page,
      to_page: input.to_page,
      space_id: resolvedSpaceId,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    return handleApiError(error);
  }
}

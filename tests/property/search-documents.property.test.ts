/**
 * search_documents プロパティテスト
 *
 * Property 4: 空白のみの検索クエリの拒否
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 5.4
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  handleSearchDocuments,
  searchDocumentsInputSchema,
} from "../../src/tools/search-documents.js";
import { RokadocApiClient } from "../../src/services/rokadoc-client.js";

describe("Feature: rokadoc-mcp-server, Property 4: 空白のみの検索クエリの拒否", () => {
  /**
   * 空白文字のみ（スペース、タブ、改行等）で構成される長さ1以上の任意文字列について、
   * handleSearchDocuments はバリデーションエラーを返却する。
   *
   * Zodのmin(1)は空文字列を弾くが、空白のみの文字列はmin(1)を通過するため、
   * ハンドラー内のtrim()チェックで拒否されることを検証する。
   *
   * **Validates: Requirements 5.4**
   */
  it("空白文字のみのクエリ（長さ1以上）に対しバリデーションエラーが返却される", async () => {
    // モッククライアント（バリデーションで弾かれるため呼ばれない）
    const mockClient = {
      searchDocuments: () => Promise.resolve([]),
    } as unknown as RokadocApiClient;

    await fc.assert(
      fc.asyncProperty(
        // 空白文字のみで構成される長さ1以上の文字列を生成
        fc
          .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u3000"), {
            minLength: 1,
            maxLength: 100,
          })
          .map((chars) => chars.join("")),
        async (whitespaceQuery) => {
          const result = await handleSearchDocuments(
            { query: whitespaceQuery },
            mockClient,
          );

          // isError が true であること
          expect(result.isError).toBe(true);

          // レスポンステキストにバリデーションエラーと空白に関するメッセージが含まれること
          const text = result.content[0].text;
          expect(text).toContain("バリデーションエラー");
          expect(text).toContain("空白のみ");
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 空文字列はZodスキーマのmin(1)によりパース時点で拒否されることを検証する。
   *
   * **Validates: Requirements 5.4**
   */
  it("空文字列はZodスキーマにより拒否される", () => {
    const result = searchDocumentsInputSchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });
});

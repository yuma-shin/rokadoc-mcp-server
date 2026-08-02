/**
 * エラーハンドリング プロパティベーステスト
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 7.3, 7.4, 7.7
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  formatMcpError,
  handleApiError,
} from "../../src/utils/error-handler.js";
import { ErrorType } from "../../src/types.js";

/**
 * Property 10: エラーレスポンス形式準拠
 *
 * 任意のエラー状態でisError: true、type: "text"、エラー種別文言が含まれることを検証
 *
 * **Validates: Requirements 7.4, 7.7**
 */
describe("Feature: rokadoc-mcp-server, Property 10: エラーレスポンス形式準拠", () => {
  const allErrorTypes = Object.values(ErrorType) as ErrorType[];

  it("任意のErrorTypeとメッセージに対し、formatMcpErrorはisError: true、type: 'text'、エラー種別文言を含むレスポンスを返す", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allErrorTypes),
        fc.string({ minLength: 1, maxLength: 200 }),
        (errorType: ErrorType, message: string) => {
          const result = formatMcpError(errorType, message);

          // isError: true が設定されている
          expect(result.isError).toBe(true);

          // content配列が存在し、少なくとも1要素ある
          expect(result.content).toBeDefined();
          expect(result.content.length).toBeGreaterThanOrEqual(1);

          // content[0].type が "text" である
          expect(result.content[0].type).toBe("text");

          // content[0].text にエラー種別文言が含まれる
          expect(result.content[0].text).toContain(errorType);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("任意のHTTPエラー（401/403）に対し、handleApiErrorは認証エラー種別を含むレスポンスを返す", () => {
    fc.assert(
      fc.property(fc.constantFrom(401, 403), (statusCode: number) => {
        const error = { status: statusCode };
        const result = handleApiError(error);

        expect(result.isError).toBe(true);
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain(ErrorType.AUTH_ERROR);
      }),
      { numRuns: 100 },
    );
  });

  it("タイムアウトエラーに対し、handleApiErrorはタイムアウト種別を含むレスポンスを返す", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("AbortError", "timeout", "ETIMEDOUT"),
        (errorIndicator: string) => {
          let error: unknown;
          if (errorIndicator === "AbortError") {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            error = e;
          } else if (errorIndicator === "timeout") {
            error = new Error("Connection timeout occurred");
          } else {
            error = { code: errorIndicator, message: "timed out" };
          }

          const result = handleApiError(error);

          expect(result.isError).toBe(true);
          expect(result.content[0].type).toBe("text");
          expect(result.content[0].text).toContain(ErrorType.TIMEOUT);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("接続エラーに対し、handleApiErrorは接続エラー種別を含むレスポンスを返す", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "ECONNREFUSED",
          "ENOTFOUND",
          "ENETUNREACH",
          "EHOSTUNREACH",
        ),
        (errorCode: string) => {
          const error = { code: errorCode, message: `connect ${errorCode}` };
          // Error instance with message pattern
          const errorInstance = new Error(
            `getaddrinfo ${errorCode} example.com`,
          );

          const result1 = handleApiError(error);
          expect(result1.isError).toBe(true);
          expect(result1.content[0].type).toBe("text");
          expect(result1.content[0].text).toContain(ErrorType.CONNECTION_ERROR);

          const result2 = handleApiError(errorInstance);
          expect(result2.isError).toBe(true);
          expect(result2.content[0].type).toBe("text");
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 11: HTTPエラーステータスのフォーマット
 *
 * 任意の4xx/5xx（401/403除く）でステータスコードとボディ先頭500文字が含まれることを検証
 *
 * **Validates: Requirements 7.3**
 */
describe("Feature: rokadoc-mcp-server, Property 11: HTTPエラーステータスのフォーマット", () => {
  // 400-599 の範囲から 401, 403 を除外するジェネレータ
  const httpErrorStatusArb = fc
    .integer({ min: 400, max: 599 })
    .filter((status) => status !== 401 && status !== 403);

  it("任意の4xx/5xx（401/403除く）ステータスコードに対し、エラーメッセージにステータスコード数値が含まれる", () => {
    fc.assert(
      fc.property(
        httpErrorStatusArb,
        fc.string({ minLength: 0, maxLength: 1000 }),
        (statusCode: number, bodyText: string) => {
          const error = { status: statusCode, body: bodyText };
          const result = handleApiError(error);

          // isError: true が設定されている
          expect(result.isError).toBe(true);

          // content[0].type が "text" である
          expect(result.content[0].type).toBe("text");

          // ステータスコードの数値がメッセージに含まれる
          expect(result.content[0].text).toContain(String(statusCode));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("レスポンスボディが500文字以下の場合、ボディ全体がエラーメッセージに含まれる", () => {
    fc.assert(
      fc.property(
        httpErrorStatusArb,
        fc.string({ minLength: 1, maxLength: 500 }),
        (statusCode: number, bodyText: string) => {
          const error = { status: statusCode, body: bodyText };
          const result = handleApiError(error);

          // ボディテキストがメッセージに含まれる
          expect(result.content[0].text).toContain(bodyText);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("レスポンスボディが500文字を超える場合、先頭500文字のみがエラーメッセージに含まれる", () => {
    fc.assert(
      fc.property(
        httpErrorStatusArb,
        fc.string({ minLength: 501, maxLength: 2000 }),
        (statusCode: number, bodyText: string) => {
          const error = { status: statusCode, body: bodyText };
          const result = handleApiError(error);

          const first500 = bodyText.slice(0, 500);
          const char501 = bodyText[500];

          // 先頭500文字が含まれる
          expect(result.content[0].text).toContain(first500);

          // 501文字目以降のテキスト全体は含まれない（先頭500文字に501文字目が偶然一致しない限り）
          // bodyText全体が含まれないことを検証
          if (bodyText.length > 500) {
            expect(result.content[0].text).not.toContain(bodyText);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("エラーレスポンスはAPIエラー種別を含む", () => {
    fc.assert(
      fc.property(
        httpErrorStatusArb,
        fc.string({ minLength: 0, maxLength: 100 }),
        (statusCode: number, bodyText: string) => {
          const error = { status: statusCode, body: bodyText };
          const result = handleApiError(error);

          // APIエラー種別文言が含まれる
          expect(result.content[0].text).toContain(ErrorType.API_ERROR);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * セキュリティプロパティテスト
 *
 * Property 7: 送信先ホスト制限
 * Property 8: API Key非開示
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 6.1, 6.4, 6.6
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { isAllowedHost } from "../../src/utils/url-validator.js";
import {
  sanitizeApiKey,
  formatMcpError,
} from "../../src/utils/error-handler.js";
import { ErrorType } from "../../src/types.js";

describe("Feature: rokadoc-mcp-server, Property 7: 送信先ホスト制限", () => {
  /**
   * 任意のURL文字列について、そのホスト部分がBase URLのホストと一致しない場合、
   * isAllowedHost は false を返却する。
   *
   * **Validates: Requirements 6.1, 6.6**
   */
  it("Base URLのホストと不一致の任意URLに対しリクエスト送信が拒否される", () => {
    fc.assert(
      fc.property(
        // Base URLのホスト名を生成
        fc.webAuthority({ withPort: false }).map((host) => `https://${host}`),
        // リクエストURLのホスト名を生成（Base URLとは異なるホスト）
        fc.webAuthority({ withPort: false }).map((host) => `https://${host}`),
        fc.webPath(),
        (baseUrl, requestHost, path) => {
          // ホストが同一の場合はスキップ（異なるホストのペアのみ検証）
          const baseHost = new URL(baseUrl).host;
          const reqHost = new URL(requestHost).host;
          fc.pre(baseHost !== reqHost);

          const requestUrl = `${requestHost}${path}`;
          const result = isAllowedHost(requestUrl, baseUrl);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Base URLのホストと一致するURLに対しリクエスト送信が許可される", () => {
    fc.assert(
      fc.property(
        fc.webAuthority({ withPort: false }),
        fc.webPath(),
        (host, path) => {
          const baseUrl = `https://${host}`;
          const requestUrl = `https://${host}${path}`;
          const result = isAllowedHost(requestUrl, baseUrl);
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("無効なURL形式の場合は拒否される（false を返す）", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => {
          try {
            new URL(s);
            return false; // 有効なURLはフィルタアウト
          } catch {
            return true; // 無効なURLのみ対象
          }
        }),
        fc.webAuthority({ withPort: false }).map((host) => `https://${host}`),
        (invalidUrl, baseUrl) => {
          const result = isAllowedHost(invalidUrl, baseUrl);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: rokadoc-mcp-server, Property 8: API Key非開示", () => {
  /**
   * 任意のAPI Key値と任意のエラー状態の組み合わせについて、
   * サニタイズ処理後のメッセージにAPI Keyの値が含まれない。
   *
   * **Validates: Requirements 6.4**
   */

  // 英数字とハイフン・アンダースコアのみでAPI Keyを生成（実際のAPI Keyに近い形式）
  // フォーマット文字（"[", "]", "*"等）を含まないことで、sanitize後の検証を正確に行う
  const alphanumChars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  const apiKeyArb = fc
    .array(fc.constantFrom(...alphanumChars.split("")), {
      minLength: 3,
      maxLength: 50,
    })
    .map((chars) => chars.join(""));

  it("sanitizeApiKey: 任意のAPI Key値がメッセージから除去される", () => {
    fc.assert(
      fc.property(
        apiKeyArb,
        fc.string({ minLength: 0, maxLength: 200 }),
        fc.string({ minLength: 0, maxLength: 200 }),
        (apiKey, prefix, suffix) => {
          // API Keyを含むメッセージを生成
          const message = `${prefix}${apiKey}${suffix}`;
          const result = sanitizeApiKey(message, apiKey);
          expect(result).not.toContain(apiKey);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("sanitizeApiKey: API Keyが複数回出現する場合も全て除去される", () => {
    fc.assert(
      fc.property(
        apiKeyArb,
        fc.integer({ min: 2, max: 5 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (apiKey, repeatCount, separator) => {
          // API Keyを複数回含むメッセージを生成
          const parts = Array(repeatCount).fill(apiKey);
          const message = parts.join(separator);
          const result = sanitizeApiKey(message, apiKey);
          expect(result).not.toContain(apiKey);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("formatMcpError: サニタイズ後にformatMcpErrorを呼び出した場合、レスポンスにAPI Keyが含まれない", () => {
    fc.assert(
      fc.property(
        apiKeyArb,
        fc.constantFrom(
          ErrorType.AUTH_ERROR,
          ErrorType.TIMEOUT,
          ErrorType.CONNECTION_ERROR,
          ErrorType.API_ERROR,
          ErrorType.VALIDATION_ERROR,
        ),
        fc.string({ minLength: 1, maxLength: 200 }),
        (apiKey, errorType, errorDetail) => {
          // API Keyを含むエラーメッセージを生成しサニタイズ
          const rawMessage = `Error occurred with key ${apiKey}: ${errorDetail}`;
          const sanitizedMessage = sanitizeApiKey(rawMessage, apiKey);

          // formatMcpErrorでMCPレスポンスを生成
          const result = formatMcpError(errorType, sanitizedMessage);

          // レスポンスのテキストにAPI Keyが含まれないことを検証
          for (const content of result.content) {
            expect(content.text).not.toContain(apiKey);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("formatMcpError: 任意のエラー種別でisError: trueが設定される", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ErrorType.AUTH_ERROR,
          ErrorType.TIMEOUT,
          ErrorType.CONNECTION_ERROR,
          ErrorType.API_ERROR,
          ErrorType.VALIDATION_ERROR,
        ),
        fc.string({ minLength: 1, maxLength: 200 }),
        (errorType, message) => {
          const result = formatMcpError(errorType, message);
          expect(result.isError).toBe(true);
          expect(result.content.length).toBeGreaterThan(0);
          expect(result.content[0].type).toBe("text");
        },
      ),
      { numRuns: 100 },
    );
  });
});

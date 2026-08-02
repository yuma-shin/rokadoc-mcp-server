/**
 * URL検証プロパティベーステスト
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 2.4, 2.5, 6.5
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  normalizeBaseUrl,
  validateUrlFormat,
} from "../../src/utils/url-validator.js";

/**
 * 有効なHTTP/HTTPS URLを生成するArbitrary
 * ホスト名 + オプションのパスで構成される
 */
const validHostArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/),
    fc.constantFrom(".com", ".net", ".org", ".co.jp", ".io"),
  )
  .map(([name, tld]) => name + tld);

const validPathArb = fc
  .array(fc.stringMatching(/^[a-z0-9_-]{1,10}$/), {
    minLength: 0,
    maxLength: 3,
  })
  .map((segments) => (segments.length > 0 ? "/" + segments.join("/") : ""));

const schemeArb = fc.constantFrom("http://", "https://");

const validUrlArb = fc
  .tuple(schemeArb, validHostArb, validPathArb)
  .map(([scheme, host, path]) => scheme + host + path);

/**
 * 末尾スラッシュ（1個以上）を生成するArbitrary
 */
const trailingSlashesArb = fc
  .integer({ min: 1, max: 5 })
  .map((n) => "/".repeat(n));

describe("Feature: rokadoc-mcp-server, Property 1: URL末尾スラッシュ正規化", () => {
  /**
   * **Validates: Requirements 2.4**
   *
   * 任意の有効なHTTP/HTTPS URLに対し、末尾に0個以上のスラッシュが付加されている場合、
   * 正規化後のURLは末尾スラッシュを含まない。
   */
  it("任意の有効なHTTP/HTTPS URLに対し末尾スラッシュが除去される", () => {
    fc.assert(
      fc.property(validUrlArb, trailingSlashesArb, (url, slashes) => {
        const urlWithSlashes = url + slashes;
        const normalized = normalizeBaseUrl(urlWithSlashes);
        // 正規化後のURLは末尾スラッシュを含まない
        expect(normalized.endsWith("/")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("末尾スラッシュがないURLでも正規化後は末尾スラッシュを含まない", () => {
    fc.assert(
      fc.property(validUrlArb, (url) => {
        const normalized = normalizeBaseUrl(url);
        expect(normalized.endsWith("/")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: rokadoc-mcp-server, Property 2: 不正URL形式の拒否", () => {
  /**
   * **Validates: Requirements 2.5**
   *
   * 任意の文字列について、"http://" または "https://" で始まらない場合、
   * URL形式検証は当該文字列を拒否する。
   */

  /**
   * http/httpsで始まらない任意文字列を生成するArbitrary
   */
  const invalidSchemeStringArb = fc
    .string({ minLength: 0, maxLength: 100 })
    .filter((s) => !s.startsWith("http://") && !s.startsWith("https://"));

  it("http/httpsで始まらない任意文字列が拒否される", () => {
    fc.assert(
      fc.property(invalidSchemeStringArb, (input) => {
        expect(validateUrlFormat(input)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("代表的な不正スキームが拒否される", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "ftp://",
          "file://",
          "ssh://",
          "ws://",
          "wss://",
          "mailto:",
          "javascript:",
          "",
          "htt://",
          "httpx://",
        ),
        validHostArb,
        (scheme, host) => {
          expect(validateUrlFormat(scheme + host)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: rokadoc-mcp-server, Property 9: HTTPからHTTPSへの自動変換", () => {
  /**
   * **Validates: Requirements 6.5**
   *
   * 任意の"http://"で始まるURLについて、正規化処理はスキームを"https://"に変換し、
   * ホスト・パス部分は保持する。
   */
  const httpUrlArb = fc
    .tuple(validHostArb, validPathArb)
    .map(([host, path]) => "http://" + host + path);

  it("http://で始まる任意URLがhttps://に変換される", () => {
    fc.assert(
      fc.property(httpUrlArb, (url) => {
        const normalized = normalizeBaseUrl(url);
        // https://で始まることを検証
        expect(normalized.startsWith("https://")).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("http://からhttps://への変換でホスト・パス部分は保持される", () => {
    fc.assert(
      fc.property(httpUrlArb, (url) => {
        const normalized = normalizeBaseUrl(url);
        // "http://" を取り除いた部分と "https://" を取り除いた部分が一致する
        const originalRest = url.slice("http://".length).replace(/\/+$/, "");
        const normalizedRest = normalized.slice("https://".length);
        expect(normalizedRest).toBe(originalRest);
      }),
      { numRuns: 100 },
    );
  });

  it("https://で始まるURLはスキームが変更されない", () => {
    const httpsUrlArb = fc
      .tuple(validHostArb, validPathArb)
      .map(([host, path]) => "https://" + host + path);

    fc.assert(
      fc.property(httpsUrlArb, (url) => {
        const normalized = normalizeBaseUrl(url);
        expect(normalized.startsWith("https://")).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

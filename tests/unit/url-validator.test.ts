import { describe, it, expect } from "vitest";
import {
  normalizeBaseUrl,
  validateUrlFormat,
  isAllowedHost,
} from "../../src/utils/url-validator.js";

describe("url-validator", () => {
  describe("normalizeBaseUrl", () => {
    it("末尾スラッシュを除去する", () => {
      expect(normalizeBaseUrl("https://example.com/")).toBe(
        "https://example.com",
      );
    });

    it("複数の末尾スラッシュを除去する", () => {
      expect(normalizeBaseUrl("https://example.com///")).toBe(
        "https://example.com",
      );
    });

    it("末尾スラッシュがない場合はそのまま返す", () => {
      expect(normalizeBaseUrl("https://example.com")).toBe(
        "https://example.com",
      );
    });

    it("http://をhttps://に変換する", () => {
      expect(normalizeBaseUrl("http://example.com")).toBe(
        "https://example.com",
      );
    });

    it("パス付きURLの末尾スラッシュを除去する", () => {
      expect(normalizeBaseUrl("https://example.com/api/v1/")).toBe(
        "https://example.com/api/v1",
      );
    });
  });

  describe("validateUrlFormat", () => {
    it("https://で始まるURLを有効と判定する", () => {
      expect(validateUrlFormat("https://example.com")).toBe(true);
    });

    it("http://で始まるURLを有効と判定する", () => {
      expect(validateUrlFormat("http://example.com")).toBe(true);
    });

    it("ftp://で始まるURLを無効と判定する", () => {
      expect(validateUrlFormat("ftp://example.com")).toBe(false);
    });

    it("スキームなしの文字列を無効と判定する", () => {
      expect(validateUrlFormat("example.com")).toBe(false);
    });

    it("空文字列を無効と判定する", () => {
      expect(validateUrlFormat("")).toBe(false);
    });
  });

  describe("isAllowedHost", () => {
    it("同じホストのURLを許可する", () => {
      expect(
        isAllowedHost("https://example.com/api/v1", "https://example.com"),
      ).toBe(true);
    });

    it("異なるホストのURLを拒否する", () => {
      expect(
        isAllowedHost("https://evil.com/api/v1", "https://example.com"),
      ).toBe(false);
    });

    it("不正なURLの場合はfalseを返す", () => {
      expect(isAllowedHost("not-a-url", "https://example.com")).toBe(false);
    });

    it("ポート番号が異なる場合は拒否する", () => {
      expect(
        isAllowedHost(
          "https://example.com:8080/api",
          "https://example.com:3000",
        ),
      ).toBe(false);
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  sanitizeApiKey,
  formatMcpError,
  handleApiError,
} from "../../src/utils/error-handler.js";
import { ErrorType } from "../../src/types.js";

describe("error-handler", () => {
  describe("sanitizeApiKey", () => {
    it("メッセージ中のAPI Key値を***に置換する", () => {
      const result = sanitizeApiKey(
        "Error with key: my-secret-key",
        "my-secret-key",
      );
      expect(result).toBe("Error with key: ***");
      expect(result).not.toContain("my-secret-key");
    });

    it("API Keyが空文字列の場合はメッセージをそのまま返す", () => {
      const result = sanitizeApiKey("Error message", "");
      expect(result).toBe("Error message");
    });

    it("複数出現箇所を全て置換する", () => {
      const result = sanitizeApiKey("key=abc, again key=abc", "abc");
      expect(result).toBe("key=***, again key=***");
    });
  });

  describe("formatMcpError", () => {
    it("isError: trueを含むレスポンスを返す", () => {
      const result = formatMcpError(ErrorType.API_ERROR, "テストエラー");
      expect(result.isError).toBe(true);
    });

    it("content配列にtype: textのエントリを含む", () => {
      const result = formatMcpError(ErrorType.AUTH_ERROR, "認証失敗");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
    });

    it("エラー種別をメッセージに含める", () => {
      const result = formatMcpError(ErrorType.TIMEOUT, "タイムアウト");
      expect(result.content[0].text).toContain(ErrorType.TIMEOUT);
    });
  });

  describe("handleApiError", () => {
    it("HTTP 401を認証エラーとして分類する", () => {
      const error = { status: 401 };
      const result = handleApiError(error);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ErrorType.AUTH_ERROR);
    });

    it("HTTP 403を認証エラーとして分類する", () => {
      const error = { status: 403 };
      const result = handleApiError(error);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ErrorType.AUTH_ERROR);
    });

    it("HTTP 500をAPIエラーとして分類する", () => {
      const error = { status: 500 };
      const result = handleApiError(error);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ErrorType.API_ERROR);
    });

    it("AbortErrorをタイムアウトエラーとして分類する", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      const result = handleApiError(error);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ErrorType.TIMEOUT);
    });

    it("ECONNREFUSED を接続エラーとして分類する", () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:3000");
      const result = handleApiError(error);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ErrorType.CONNECTION_ERROR);
    });

    it("レスポンスボディを500文字に切り詰める", () => {
      const longBody = "x".repeat(1000);
      const error = { status: 500, body: longBody };
      const result = handleApiError(error);
      // ボディがレスポンスに含まれるが500文字以内
      const text = result.content[0].text;
      expect(text).toContain("x".repeat(500));
      expect(text).not.toContain("x".repeat(501));
    });
  });
});

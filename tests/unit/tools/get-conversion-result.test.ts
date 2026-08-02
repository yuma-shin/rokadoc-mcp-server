import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleGetConversionResult,
  getConversionResultInputSchema,
} from "../../../src/tools/get-conversion-result.js";
import { RokadocApiClient } from "../../../src/services/rokadoc-client.js";

// RokadocApiClientをモック
vi.mock("../../../src/services/rokadoc-client.js");

describe("get_conversion_result ツール", () => {
  let mockClient: { getConversionResult: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = {
      getConversionResult: vi.fn(),
    };
  });

  describe("入力バリデーション", () => {
    it("有効なconversion_idを受け付ける", () => {
      const result = getConversionResultInputSchema.safeParse({
        conversion_id: "abc-123",
      });
      expect(result.success).toBe(true);
    });

    it("空文字列のconversion_idを拒否する", () => {
      const result = getConversionResultInputSchema.safeParse({
        conversion_id: "",
      });
      expect(result.success).toBe(false);
    });

    it("conversion_idが未指定の場合を拒否する", () => {
      const result = getConversionResultInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("正常系", () => {
    it("変換結果ドキュメントを返却する", async () => {
      mockClient.getConversionResult.mockResolvedValue({
        code: 200,
        data: {
          status: "Succeeded",
          conversion_id: "conv-123",
          document_name: "sample.pdf",
          roka_response: {
            meta: { separate_method: "page" },
            document_summary: "",
            units: [
              {
                unit: 1,
                title: "",
                body: "",
                chunk_context: "",
                elements: [
                  {
                    type: "text",
                    coordinates: [
                      [0, 0],
                      [100, 100],
                    ],
                    text: "テスト内容",
                    page: 1,
                    reading_order: 1,
                  },
                ],
                description: "テスト内容",
                width: 2481,
                height: 3508,
              },
            ],
          },
        },
      });

      const result = await handleGetConversionResult(
        { conversion_id: "conv-123" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.conversion_id).toBe("conv-123");
      expect(parsed.document_name).toBe("sample.pdf");
      expect(parsed.status).toBe("Succeeded");
      expect(parsed.roka_response.units).toHaveLength(1);
      expect(mockClient.getConversionResult).toHaveBeenCalledWith(
        "conv-123",
        undefined,
      );
    });
  });

  describe("エラー系", () => {
    it("HTTP 404: ジョブが見つからないエラーを返却する", async () => {
      const error = new Error("HTTP 404: Not Found");
      Object.assign(error, { status: 404, body: "" });
      mockClient.getConversionResult.mockRejectedValue(error);

      const result = await handleGetConversionResult(
        { conversion_id: "nonexistent-id" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "指定されたジョブが見つかりません",
      );
      expect(result.content[0].text).toContain("nonexistent-id");
    });

    it("ジョブ未完了時（roka_response: null）にステータスを含むメッセージを返却する", async () => {
      mockClient.getConversionResult.mockResolvedValue({
        code: 200,
        data: {
          status: "Pending",
          conversion_id: "pending-id",
          document_name: "sample.pdf",
          roka_response: null,
        },
      });

      const result = await handleGetConversionResult(
        { conversion_id: "pending-id" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("ジョブが未完了です");
      expect(result.content[0].text).toContain("pending-id");
      expect(result.content[0].text).toContain("Pending");
      expect(result.content[0].text).toContain(
        "ジョブの完了後に再度お試しください",
      );
    });

    it("Running ステータスで未完了のメッセージを返却する", async () => {
      mockClient.getConversionResult.mockResolvedValue({
        code: 200,
        data: {
          status: "Running",
          conversion_id: "running-id",
          document_name: "report.docx",
          roka_response: null,
        },
      });

      const result = await handleGetConversionResult(
        { conversion_id: "running-id" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("ジョブが未完了です");
      expect(result.content[0].text).toContain("Running");
    });

    it("HTTP 401: 認証エラーをhandleApiErrorに委譲する", async () => {
      const error = new Error("HTTP 401: Unauthorized");
      Object.assign(error, { status: 401, body: "" });
      mockClient.getConversionResult.mockRejectedValue(error);

      const result = await handleGetConversionResult(
        { conversion_id: "some-id" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("認証エラー");
    });

    it("タイムアウトエラーをhandleApiErrorに委譲する", async () => {
      const error = new Error("timeout");
      error.name = "AbortError";
      mockClient.getConversionResult.mockRejectedValue(error);

      const result = await handleGetConversionResult(
        { conversion_id: "timeout-id" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("タイムアウト");
    });

    it("接続エラーをhandleApiErrorに委譲する", async () => {
      const error = new Error("getaddrinfo ENOTFOUND example.com");
      Object.assign(error, { code: "ENOTFOUND" });
      mockClient.getConversionResult.mockRejectedValue(error);

      const result = await handleGetConversionResult(
        { conversion_id: "conn-error-id" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("接続エラー");
    });
  });
});

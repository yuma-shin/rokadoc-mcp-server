import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleListConversions } from "../../../src/tools/list-conversions.js";
import { RokadocApiClient } from "../../../src/services/rokadoc-client.js";

describe("list_conversions ツール", () => {
  let mockClient: {
    listConversions: ReturnType<typeof vi.fn>;
    listSpaces: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      listConversions: vi.fn(),
      listSpaces: vi.fn(),
    };
  });

  describe("正常系", () => {
    it("変換ジョブ一覧をconversion_id、status、document_name、created_date、updated_date付きで返却する", async () => {
      mockClient.listConversions.mockResolvedValue([
        {
          conversion_id: "conv-001",
          status: "Succeeded",
          document_name: "sample.pdf",
          created_date: "202501151030",
          updated_date: "202501151031",
        },
        {
          conversion_id: "conv-002",
          status: "Running",
          document_name: "report.docx",
          created_date: "202501151100",
          updated_date: "202501151100",
        },
        {
          conversion_id: "conv-003",
          status: "Pending",
          document_name: "data.xlsx",
          created_date: "202501151130",
          updated_date: "202501151130",
        },
      ]);

      const result = await handleListConversions(
        {},
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.conversions).toHaveLength(3);
      expect(parsed.conversions[0]).toEqual({
        conversion_id: "conv-001",
        status: "Succeeded",
        document_name: "sample.pdf",
        created_date: "202501151030",
        updated_date: "202501151031",
      });
      expect(parsed.conversions[1]).toEqual({
        conversion_id: "conv-002",
        status: "Running",
        document_name: "report.docx",
        created_date: "202501151100",
        updated_date: "202501151100",
      });
      expect(parsed.conversions[2]).toEqual({
        conversion_id: "conv-003",
        status: "Pending",
        document_name: "data.xlsx",
        created_date: "202501151130",
        updated_date: "202501151130",
      });
    });

    it("空のジョブ一覧の場合、空のconversions配列を返却する", async () => {
      mockClient.listConversions.mockResolvedValue([]);

      const result = await handleListConversions(
        {},
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.conversions).toEqual([]);
    });
  });

  describe("APIエラー", () => {
    it("APIクライアントがエラーをスローした場合、handleApiErrorでフォーマットされる", async () => {
      const error = new Error("HTTP 500: Internal Server Error");
      Object.assign(error, { status: 500, body: "server error" });
      mockClient.listConversions.mockRejectedValue(error);

      const result = await handleListConversions(
        {},
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("APIエラー");
    });

    it("認証エラー（401）がhandleApiErrorに委譲される", async () => {
      const error = new Error("HTTP 401: Unauthorized");
      Object.assign(error, { status: 401, body: "" });
      mockClient.listConversions.mockRejectedValue(error);

      const result = await handleListConversions(
        {},
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("認証エラー");
    });

    it("タイムアウトエラーがhandleApiErrorに委譲される", async () => {
      const error = new Error("timeout");
      error.name = "AbortError";
      mockClient.listConversions.mockRejectedValue(error);

      const result = await handleListConversions(
        {},
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("タイムアウト");
    });
  });
});

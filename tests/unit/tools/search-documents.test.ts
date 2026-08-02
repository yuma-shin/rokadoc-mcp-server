import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleSearchDocuments,
  searchDocumentsInputSchema,
} from "../../../src/tools/search-documents.js";
import { RokadocApiClient } from "../../../src/services/rokadoc-client.js";

describe("search_documents ツール", () => {
  let mockClient: {
    searchDocuments: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      searchDocuments: vi.fn(),
    };
  });

  describe("Zodスキーマバリデーション", () => {
    it("有効なクエリを受け付ける", () => {
      const result = searchDocumentsInputSchema.safeParse({
        query: "検索テスト",
      });
      expect(result.success).toBe(true);
    });

    it("1000文字を超えるクエリを拒否する", () => {
      const longQuery = "あ".repeat(1001);
      const result = searchDocumentsInputSchema.safeParse({
        query: longQuery,
      });
      expect(result.success).toBe(false);
    });

    it("1000文字ちょうどのクエリを受け付ける", () => {
      const maxQuery = "a".repeat(1000);
      const result = searchDocumentsInputSchema.safeParse({
        query: maxQuery,
      });
      expect(result.success).toBe(true);
    });

    it("空文字列のクエリを拒否する", () => {
      const result = searchDocumentsInputSchema.safeParse({
        query: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("正常系", () => {
    it("検索結果をdocument_name、context、page_number付きで返却する", async () => {
      mockClient.searchDocuments.mockResolvedValue([
        {
          context: "本システムの設計方針は...",
          unit: {
            unit: 1,
            title: "",
            body: "",
            chunk_context: "",
            elements: [],
            description: "",
            width: 0,
            height: 0,
          },
          pdf_name: "設計書.pdf",
          page_number: 1,
          roka_algorithm: null,
          conversion_id: "abc-123",
          user_id: "user1",
          tags: [],
        },
        {
          context: "機能要件として...",
          unit: {
            unit: 2,
            title: "",
            body: "",
            chunk_context: "",
            elements: [],
            description: "",
            width: 0,
            height: 0,
          },
          pdf_name: "仕様書.docx",
          page_number: 3,
          roka_algorithm: null,
          conversion_id: "def-456",
          user_id: "user1",
          tags: ["設計"],
        },
      ]);

      const result = await handleSearchDocuments(
        { query: "設計方針" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0]).toEqual({
        document_name: "設計書.pdf",
        context: "本システムの設計方針は...",
        page_number: 1,
        conversion_id: "abc-123",
        tags: [],
      });
      expect(parsed.results[1]).toEqual({
        document_name: "仕様書.docx",
        context: "機能要件として...",
        page_number: 3,
        conversion_id: "def-456",
        tags: ["設計"],
      });
    });
  });

  describe("空白のみクエリのバリデーション", () => {
    it("空白のみのクエリにバリデーションエラーを返却する", async () => {
      const result = await handleSearchDocuments(
        { query: "   " },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("バリデーションエラー");
      expect(result.content[0].text).toContain("空白のみ");
      expect(mockClient.searchDocuments).not.toHaveBeenCalled();
    });

    it("タブ文字のみのクエリにバリデーションエラーを返却する", async () => {
      const result = await handleSearchDocuments(
        { query: "\t\t" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("バリデーションエラー");
      expect(mockClient.searchDocuments).not.toHaveBeenCalled();
    });
  });

  describe("tagsパラメータ", () => {
    it("tagsをクライアントに渡す", async () => {
      mockClient.searchDocuments.mockResolvedValue([]);

      await handleSearchDocuments(
        { query: "テスト", tags: ["設計", "仕様"] },
        mockClient as unknown as RokadocApiClient,
      );

      expect(mockClient.searchDocuments).toHaveBeenCalledWith("テスト", {
        tags: ["設計", "仕様"],
        max_results: 3,
        space_id: undefined,
      });
    });
  });

  describe("max_resultsパラメータ", () => {
    it("カスタムmax_resultsをクライアントに渡す", async () => {
      mockClient.searchDocuments.mockResolvedValue([]);

      await handleSearchDocuments(
        { query: "テスト", max_results: 5 },
        mockClient as unknown as RokadocApiClient,
      );

      expect(mockClient.searchDocuments).toHaveBeenCalledWith("テスト", {
        tags: undefined,
        max_results: 5,
        space_id: undefined,
      });
    });

    it("max_results未指定時はデフォルト3をクライアントに渡す", async () => {
      mockClient.searchDocuments.mockResolvedValue([]);

      await handleSearchDocuments(
        { query: "テスト" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(mockClient.searchDocuments).toHaveBeenCalledWith("テスト", {
        tags: undefined,
        max_results: 3,
        space_id: undefined,
      });
    });
  });

  describe("space_idパラメータ", () => {
    it("space_idをクライアントに渡す", async () => {
      mockClient.searchDocuments.mockResolvedValue([]);

      await handleSearchDocuments(
        { query: "テスト", space_id: "space-123" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(mockClient.searchDocuments).toHaveBeenCalledWith("テスト", {
        tags: undefined,
        max_results: 3,
        space_id: "space-123",
      });
    });
  });

  describe("APIエラー", () => {
    it("APIクライアントがエラーをスローした場合、handleApiErrorでフォーマットされる", async () => {
      const error = new Error("HTTP 500: Internal Server Error");
      Object.assign(error, { status: 500, body: "server error" });
      mockClient.searchDocuments.mockRejectedValue(error);

      const result = await handleSearchDocuments(
        { query: "テスト" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("APIエラー");
    });

    it("接続エラーがhandleApiErrorに委譲される", async () => {
      const error = new Error("getaddrinfo ENOTFOUND example.com");
      Object.assign(error, { code: "ENOTFOUND" });
      mockClient.searchDocuments.mockRejectedValue(error);

      const result = await handleSearchDocuments(
        { query: "テスト" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("接続エラー");
    });
  });
});

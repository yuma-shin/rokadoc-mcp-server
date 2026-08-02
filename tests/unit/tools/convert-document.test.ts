import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleConvertDocument,
  convertDocumentInputSchema,
} from "../../../src/tools/convert-document.js";
import { RokadocApiClient } from "../../../src/services/rokadoc-client.js";

// node:fs/promises をモック
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

import { access } from "node:fs/promises";

const mockAccess = vi.mocked(access);

describe("convert_document ツール", () => {
  let mockClient: {
    createConversion: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      createConversion: vi.fn(),
    };
    // デフォルト: ファイル存在
    mockAccess.mockResolvedValue(undefined);
  });

  describe("Zodスキーマバリデーション", () => {
    it("有効な入力を受け付ける", () => {
      const result = convertDocumentInputSchema.safeParse({
        file_path: "/path/to/document.pdf",
        from_page: 1,
        to_page: 5,
      });
      expect(result.success).toBe(true);
    });

    it("file_pathのみでも受け付ける", () => {
      const result = convertDocumentInputSchema.safeParse({
        file_path: "/path/to/document.docx",
      });
      expect(result.success).toBe(true);
    });

    it("空のfile_pathを拒否する", () => {
      const result = convertDocumentInputSchema.safeParse({
        file_path: "",
      });
      expect(result.success).toBe(false);
    });

    it("file_path未指定を拒否する", () => {
      const result = convertDocumentInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("負のfrom_pageを拒否する", () => {
      const result = convertDocumentInputSchema.safeParse({
        file_path: "/path/to/doc.pdf",
        from_page: -1,
      });
      expect(result.success).toBe(false);
    });

    it("負のto_pageを拒否する", () => {
      const result = convertDocumentInputSchema.safeParse({
        file_path: "/path/to/doc.pdf",
        to_page: -5,
      });
      expect(result.success).toBe(false);
    });

    it("0のfrom_pageを拒否する（正の整数が必要）", () => {
      const result = convertDocumentInputSchema.safeParse({
        file_path: "/path/to/doc.pdf",
        from_page: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("正常系", () => {
    it("有効なPDFファイルでAPIが呼ばれ、conversion_idとstatusが返却される", async () => {
      mockClient.createConversion.mockResolvedValue({
        conversion_id: "conv-abc-123",
        status: "accepted",
      });

      const result = await handleConvertDocument(
        { file_path: "/docs/report.pdf" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.conversion_id).toBe("conv-abc-123");
      expect(parsed.status).toBe("accepted");
      expect(mockClient.createConversion).toHaveBeenCalledWith(
        "/docs/report.pdf",
        {
          from_page: undefined,
          to_page: undefined,
          space_id: undefined,
        },
      );
    });

    it("ページ範囲指定付きでAPIが呼ばれる", async () => {
      mockClient.createConversion.mockResolvedValue({
        conversion_id: "conv-xyz",
        status: "accepted",
      });

      const result = await handleConvertDocument(
        { file_path: "/docs/report.docx", from_page: 2, to_page: 10 },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBeUndefined();
      expect(mockClient.createConversion).toHaveBeenCalledWith(
        "/docs/report.docx",
        {
          from_page: 2,
          to_page: 10,
          space_id: undefined,
        },
      );
    });
  });

  describe("ファイル未存在エラー", () => {
    it("ファイルが存在しない場合、バリデーションエラーを返却する", async () => {
      mockAccess.mockRejectedValue(
        new Error("ENOENT: no such file or directory"),
      );

      const result = await handleConvertDocument(
        { file_path: "/nonexistent/file.pdf" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.content[0].text).toContain("ファイルが見つかりません");
      expect(result.content[0].text).toContain("/nonexistent/file.pdf");
      expect(mockClient.createConversion).not.toHaveBeenCalled();
    });
  });

  describe("非対応ファイル形式エラー", () => {
    it(".txt ファイルを拒否する", async () => {
      const result = await handleConvertDocument(
        { file_path: "/docs/readme.txt" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("未対応のファイル形式");
      expect(result.content[0].text).toContain(".txt");
      expect(result.content[0].text).toContain("PDF");
      expect(mockClient.createConversion).not.toHaveBeenCalled();
    });

    it(".jpg ファイルを拒否する", async () => {
      const result = await handleConvertDocument(
        { file_path: "/images/photo.jpg" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("未対応のファイル形式");
      expect(result.content[0].text).toContain(".jpg");
    });

    it(".html ファイルを拒否する", async () => {
      const result = await handleConvertDocument(
        { file_path: "/web/page.html" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("未対応のファイル形式");
      expect(result.content[0].text).toContain(".html");
    });
  });

  describe("無効ページ範囲エラー", () => {
    it("from_page > to_page の場合、バリデーションエラーを返却する", async () => {
      const result = await handleConvertDocument(
        { file_path: "/docs/report.pdf", from_page: 10, to_page: 3 },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("無効なページ範囲");
      expect(result.content[0].text).toContain("from_page");
      expect(result.content[0].text).toContain("to_page");
      expect(mockClient.createConversion).not.toHaveBeenCalled();
    });
  });

  describe("APIエラー", () => {
    it("APIクライアントがエラーをスローした場合、handleApiErrorでフォーマットされる", async () => {
      const error = new Error("HTTP 500: Internal Server Error");
      Object.assign(error, { status: 500, body: "server error" });
      mockClient.createConversion.mockRejectedValue(error);

      const result = await handleConvertDocument(
        { file_path: "/docs/report.pdf" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("APIエラー");
    });

    it("認証エラー（401）がhandleApiErrorに委譲される", async () => {
      const error = new Error("HTTP 401: Unauthorized");
      Object.assign(error, { status: 401, body: "" });
      mockClient.createConversion.mockRejectedValue(error);

      const result = await handleConvertDocument(
        { file_path: "/docs/report.pdf" },
        mockClient as unknown as RokadocApiClient,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("認証エラー");
    });
  });
});

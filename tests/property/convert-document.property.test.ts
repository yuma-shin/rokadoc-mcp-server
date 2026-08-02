/**
 * convert_document プロパティベーステスト
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 3.3, 3.6, 3.8
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { handleConvertDocument } from "../../src/tools/convert-document.js";
import { RokadocApiClient } from "../../src/services/rokadoc-client.js";

// fs モジュールのモック
vi.mock("node:fs/promises", () => ({
  access: vi.fn().mockResolvedValue(undefined),
}));

/**
 * モッククライアントを生成する
 */
function createMockClient(
  overrides?: Partial<RokadocApiClient>,
): RokadocApiClient {
  return {
    createConversion: vi.fn().mockResolvedValue({
      conversion_id: "test-id-123",
      status: "accepted",
    }),
    listConversions: vi.fn().mockResolvedValue([]),
    getConversionResult: vi.fn().mockResolvedValue({ document: "" }),
    searchDocuments: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as RokadocApiClient;
}

/**
 * Property 5: 無効ページ範囲の拒否
 *
 * from_page > to_page（両方正の整数）でエラーが返却されることを検証
 *
 * **Validates: Requirements 3.3**
 */
describe("Feature: rokadoc-mcp-server, Property 5: 無効ページ範囲の拒否", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("from_page > to_page の任意ページ範囲でバリデーションエラーが返される", async () => {
    const mockClient = createMockClient();

    await fc.assert(
      fc.asyncProperty(
        // to_page: 1〜999 の正の整数
        fc.integer({ min: 1, max: 999 }),
        // offset: 1〜1000 (from_page = to_page + offset で from_page > to_page を保証)
        fc.integer({ min: 1, max: 1000 }),
        async (toPage, offset) => {
          const fromPage = toPage + offset;

          const result = await handleConvertDocument(
            {
              file_path: "test.pdf",
              from_page: fromPage,
              to_page: toPage,
            },
            mockClient,
          );

          // エラーが返されること
          expect(result.isError).toBe(true);
          // エラーメッセージに「無効なページ範囲」が含まれること
          expect(result.content[0].text).toContain("無効なページ範囲");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("from_page === to_page の場合はエラーにならない（有効な範囲）", async () => {
    const mockClient = createMockClient();

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async (page) => {
        const result = await handleConvertDocument(
          {
            file_path: "test.pdf",
            from_page: page,
            to_page: page,
          },
          mockClient,
        );

        // エラーにならないこと
        expect(result.isError).not.toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 6: 非対応ファイル形式の拒否
 *
 * 対応拡張子以外の任意ファイル名でエラーが返却されることを検証
 *
 * **Validates: Requirements 3.6**
 */
describe("Feature: rokadoc-mcp-server, Property 6: 非対応ファイル形式の拒否", () => {
  const SUPPORTED_EXTENSIONS = [
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * 対応拡張子以外の拡張子を生成するArbitrary
   * ドットで始まり、アルファベット1〜10文字の拡張子を生成し、サポート対象を除外
   */
  const unsupportedExtArb = fc
    .stringMatching(/^[a-z]{1,10}$/)
    .map((ext) => `.${ext}`)
    .filter((ext) => !SUPPORTED_EXTENSIONS.includes(ext));

  it("対応拡張子以外の任意ファイル名でバリデーションエラーが返される", async () => {
    const mockClient = createMockClient();

    await fc.assert(
      fc.asyncProperty(unsupportedExtArb, async (ext) => {
        const result = await handleConvertDocument(
          {
            file_path: `document${ext}`,
          },
          mockClient,
        );

        // エラーが返されること
        expect(result.isError).toBe(true);
        // エラーメッセージに「未対応のファイル形式」が含まれること
        expect(result.content[0].text).toContain("未対応のファイル形式");
      }),
      { numRuns: 100 },
    );
  });

  it("拡張子なしのファイル名でもバリデーションエラーが返される", async () => {
    const mockClient = createMockClient();

    await fc.assert(
      fc.asyncProperty(
        fc
          .stringMatching(/^[a-zA-Z0-9_-]{1,20}$/)
          .filter((name) => !name.includes(".")),
        async (filename) => {
          const result = await handleConvertDocument(
            {
              file_path: filename,
            },
            mockClient,
          );

          // エラーが返されること
          expect(result.isError).toBe(true);
          // エラーメッセージに「未対応のファイル形式」が含まれること
          expect(result.content[0].text).toContain("未対応のファイル形式");
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 13: ページ範囲パラメータ転送
 *
 * 有効な任意ページ範囲がAPIリクエストに正確に含まれることを検証
 *
 * **Validates: Requirements 3.8**
 */
describe("Feature: rokadoc-mcp-server, Property 13: ページ範囲パラメータ転送", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("有効な任意ページ範囲がcreateConversionに正確に渡される", async () => {
    await fc.assert(
      fc.asyncProperty(
        // from_page: 1〜500 の正の整数
        fc.integer({ min: 1, max: 500 }),
        // offset: 0〜500 (to_page = from_page + offset で from_page <= to_page を保証)
        fc.integer({ min: 0, max: 500 }),
        async (fromPage, offset) => {
          const toPage = fromPage + offset;
          const createConversionMock = vi.fn().mockResolvedValue({
            conversion_id: "test-id-123",
            status: "accepted",
          });
          const mockClient = createMockClient({
            createConversion: createConversionMock,
          } as unknown as Partial<RokadocApiClient>);

          await handleConvertDocument(
            {
              file_path: "test.pdf",
              from_page: fromPage,
              to_page: toPage,
            },
            mockClient,
          );

          // createConversion が呼ばれること
          expect(createConversionMock).toHaveBeenCalledTimes(1);
          // 第1引数: ファイルパス、第2引数: ページ範囲オプション
          expect(createConversionMock).toHaveBeenCalledWith("test.pdf", {
            from_page: fromPage,
            to_page: toPage,
            space_id: undefined,
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("from_pageのみ指定の場合もcreateConversionに正確に渡される", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async (fromPage) => {
        const createConversionMock = vi.fn().mockResolvedValue({
          conversion_id: "test-id-123",
          status: "accepted",
        });
        const mockClient = createMockClient({
          createConversion: createConversionMock,
        } as unknown as Partial<RokadocApiClient>);

        await handleConvertDocument(
          {
            file_path: "test.pdf",
            from_page: fromPage,
          },
          mockClient,
        );

        expect(createConversionMock).toHaveBeenCalledTimes(1);
        expect(createConversionMock).toHaveBeenCalledWith("test.pdf", {
          from_page: fromPage,
          to_page: undefined,
          space_id: undefined,
        });
      }),
      { numRuns: 100 },
    );
  });

  it("to_pageのみ指定の場合もcreateConversionに正確に渡される", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), async (toPage) => {
        const createConversionMock = vi.fn().mockResolvedValue({
          conversion_id: "test-id-123",
          status: "accepted",
        });
        const mockClient = createMockClient({
          createConversion: createConversionMock,
        } as unknown as Partial<RokadocApiClient>);

        await handleConvertDocument(
          {
            file_path: "test.pdf",
            to_page: toPage,
          },
          mockClient,
        );

        expect(createConversionMock).toHaveBeenCalledTimes(1);
        expect(createConversionMock).toHaveBeenCalledWith("test.pdf", {
          from_page: undefined,
          to_page: toPage,
          space_id: undefined,
        });
      }),
      { numRuns: 100 },
    );
  });
});

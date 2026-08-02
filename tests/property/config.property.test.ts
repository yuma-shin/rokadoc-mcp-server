/**
 * 設定管理プロパティベーステスト
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 2.6
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { loadConfig } from "../../src/config.js";

describe("Feature: rokadoc-mcp-server, Property 3: 空白のみのAPI Keyの拒否", () => {
  /**
   * **Validates: Requirements 2.6**
   *
   * 任意の空白文字（スペース、タブ、改行等）のみで構成される文字列について、
   * API Key検証は当該文字列を未設定として拒否する。
   */

  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  /**
   * 空白文字のみの文字列を生成するArbitrary
   * スペース、タブ、改行、キャリッジリターン、フォームフィード、垂直タブを含む
   */
  const whitespaceOnlyArb = fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
      minLength: 1,
      maxLength: 50,
    })
    .map((chars) => chars.join(""));

  it("空白文字のみの任意文字列がAPI Key検証で拒否される", () => {
    fc.assert(
      fc.property(whitespaceOnlyArb, (whitespaceKey) => {
        vi.stubEnv("ROKADOC_API_KEY", whitespaceKey);
        vi.stubEnv("ROKADOC_BASE_URL", "https://rokadoc.ntt.com");

        // loadConfig は空白のみのAPI Keyに対して process.exit(1) を呼び出す
        expect(() => {
          loadConfig();
        }).toThrow("process.exit called");

        expect(exitSpy).toHaveBeenCalledWith(1);

        // 次のイテレーションのためにスパイの呼び出し記録をリセット
        exitSpy.mockClear();
      }),
      { numRuns: 100 },
    );
  });
});

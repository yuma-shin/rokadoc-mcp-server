/**
 * 設定管理プロパティベーステスト
 *
 * Feature: rokadoc-mcp-server
 * Validates: Requirements 2.6
 *
 * Feature: npm-package-distribution（非回帰）
 * Validates: Requirements 1.4, 1.5, 1.7, 1.8
 * `src/config.ts` の振る舞いが起動経路（Docker / npx）に依存しないことを
 * 示すための非回帰プロパティであり、実装は変更していない。
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

/**
 * 以降は npm_package_distribution の非回帰プロパティである。
 * 要件1.4 / 1.5 / 1.7 / 1.8 は既存 `loadConfig()` の振る舞いであり、
 * 本機能では `src/` を変更しない。ここでは起動経路に依存せず同一の値・
 * 同一の終了挙動になることを、環境変数の生成器で網羅的に確認する。
 */

/** 空白文字のみで構成される文字列（1文字以上）。 */
const blankStringArb = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
    minLength: 1,
    maxLength: 20,
  })
  .map((chars) => chars.join(""));

/** 前後に付加する空白（空文字列を含む）。 */
const paddingArb = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
    minLength: 0,
    maxLength: 10,
  })
  .map((chars) => chars.join(""));

/** 有効なホスト名。 */
const validHostArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/),
    fc.constantFrom(".com", ".net", ".org", ".co.jp", ".io"),
  )
  .map(([name, tld]) => name + tld);

/** 有効なパス（空文字列を含む）。 */
const validPathArb = fc
  .array(fc.stringMatching(/^[a-z0-9_-]{1,10}$/), {
    minLength: 0,
    maxLength: 3,
  })
  .map((segments) => (segments.length > 0 ? "/" + segments.join("/") : ""));

/**
 * `loadConfig()` 検証用の共通スパイ。
 * `process.exit` は例外化し、標準エラー出力は抑止する。
 * 環境変数は未設定（delete）を扱う必要があるため `process.env` を直接退避する。
 */
function useConfigEnvironment(): {
  exitSpy: () => ReturnType<typeof vi.spyOn>;
  stderrSpy: () => ReturnType<typeof vi.spyOn>;
} {
  const originalEnv = process.env;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  return {
    exitSpy: () => exitSpy,
    stderrSpy: () => stderrSpy,
  };
}

describe("Feature: npm-package-distribution, 非回帰: ROKADOC_API_KEY の前後空白除去", () => {
  /**
   * **Validates: Requirements 1.4, 1.5**
   *
   * 任意の空白文字列で前後を囲まれたAPI Keyについて、`loadConfig()` は
   * 前後の空白を除去した値を返す（内部の空白は保持する）。また未設定・
   * 空文字列・空白のみのいずれについても終了コード1で終了する。
   */
  const spies = useConfigEnvironment();

  /** 前後に空白を持たない非空のAPI Key本体（内部の空白は許容する）。 */
  const apiKeyCoreArb = fc
    .string({ minLength: 1, maxLength: 40 })
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  it("前後を任意の空白で囲まれたAPI Keyがtrimされた値として使用される", () => {
    fc.assert(
      fc.property(
        paddingArb,
        apiKeyCoreArb,
        paddingArb,
        (leading, core, trailing) => {
          process.env.ROKADOC_API_KEY = leading + core + trailing;
          process.env.ROKADOC_BASE_URL = "https://rokadoc.ntt.com";

          const config = loadConfig();

          expect(config.apiKey).toBe(core);
          expect(spies.exitSpy()).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("未設定・空文字列・空白のみのAPI Keyはいずれも終了コード1で拒否される", () => {
    const blankApiKeyArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(""),
      blankStringArb,
    );

    fc.assert(
      fc.property(blankApiKeyArb, (apiKey) => {
        if (apiKey === undefined) {
          delete process.env.ROKADOC_API_KEY;
        } else {
          process.env.ROKADOC_API_KEY = apiKey;
        }
        process.env.ROKADOC_BASE_URL = "https://rokadoc.ntt.com";

        expect(() => {
          loadConfig();
        }).toThrow("process.exit called");

        expect(spies.exitSpy()).toHaveBeenCalledWith(1);
        // 標準エラー出力へメッセージを出す（標準出力には書かない）
        expect(spies.stderrSpy()).toHaveBeenCalled();

        spies.exitSpy().mockClear();
        spies.stderrSpy().mockClear();
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: npm-package-distribution, 非回帰: ROKADOC_BASE_URL の既定値適用と正規化", () => {
  /**
   * **Validates: Requirements 1.7**
   *
   * `ROKADOC_BASE_URL` が未設定・空文字列・空白のみの場合は既定値
   * `https://api.rokadoc.ntt.com` を適用し、値が指定された場合は
   * 末尾スラッシュ除去と `http` から `https` への変換を適用した値を使用する。
   */
  useConfigEnvironment();

  const DEFAULT_BASE_URL = "https://api.rokadoc.ntt.com";

  it("未設定・空文字列・空白のみのいずれでも既定値が適用される", () => {
    const blankBaseUrlArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(""),
      blankStringArb,
    );

    fc.assert(
      fc.property(blankBaseUrlArb, (baseUrl) => {
        process.env.ROKADOC_API_KEY = "test-api-key";
        if (baseUrl === undefined) {
          delete process.env.ROKADOC_BASE_URL;
        } else {
          process.env.ROKADOC_BASE_URL = baseUrl;
        }

        const config = loadConfig();

        expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
      }),
      { numRuns: 100 },
    );
  });

  it("指定された値には末尾スラッシュ除去とhttps化が適用される", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http://", "https://"),
        validHostArb,
        validPathArb,
        fc.integer({ min: 0, max: 5 }),
        (scheme, host, path, slashCount) => {
          process.env.ROKADOC_API_KEY = "test-api-key";
          process.env.ROKADOC_BASE_URL =
            scheme + host + path + "/".repeat(slashCount);

          const config = loadConfig();

          // スキームは常に https、末尾スラッシュは除去、ホスト・パスは保持
          expect(config.baseUrl).toBe("https://" + host + path);
          expect(config.baseUrl.endsWith("/")).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: npm-package-distribution, 非回帰: 不正なROKADOC_BASE_URLでの終了", () => {
  /**
   * **Validates: Requirements 1.8**
   *
   * `http://` または `https://` で始まらない任意の非空白値に対して、
   * `loadConfig()` は標準エラー出力へメッセージを出力し終了コード1で終了する。
   */
  const spies = useConfigEnvironment();

  /** http/https で始まらない非空白の任意文字列。 */
  const invalidBaseUrlArb = fc.oneof(
    fc
      .tuple(
        fc.constantFrom(
          "ftp://",
          "file://",
          "ssh://",
          "ws://",
          "wss://",
          "mailto:",
          "javascript:",
          "htt://",
          "httpx://",
          "http:/",
          "https:/",
          "//",
          "",
        ),
        validHostArb,
      )
      .map(([scheme, host]) => scheme + host),
    fc
      .string({ minLength: 1, maxLength: 60 })
      .filter(
        (s) =>
          s.trim() !== "" &&
          !s.startsWith("http://") &&
          !s.startsWith("https://"),
      ),
    // 先頭に空白を含む有効URLは、空白除去されずに形式検証されるため拒否される
    fc
      .tuple(
        blankStringArb,
        fc.constantFrom("http://", "https://"),
        validHostArb,
      )
      .map(([leading, scheme, host]) => leading + scheme + host),
  );

  it("http/httpsで始まらない任意の値が終了コード1で拒否される", () => {
    fc.assert(
      fc.property(invalidBaseUrlArb, (baseUrl) => {
        process.env.ROKADOC_API_KEY = "test-api-key";
        process.env.ROKADOC_BASE_URL = baseUrl;

        expect(() => {
          loadConfig();
        }).toThrow("process.exit called");

        expect(spies.exitSpy()).toHaveBeenCalledWith(1);
        expect(spies.stderrSpy()).toHaveBeenCalled();

        spies.exitSpy().mockClear();
        spies.stderrSpy().mockClear();
      }),
      { numRuns: 100 },
    );
  });
});

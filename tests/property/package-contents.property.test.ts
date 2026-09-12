/**
 * Package_Tarball 収録判定のプロパティベーステスト（タスク2.4）
 *
 * Feature: npm-package-distribution, Property 3: Package_Tarballの収録判定は許可リストと一致する
 *
 * `package.json` の `files: ["dist", "LICENSE.md"]` と npm の常時収録ルール
 * （`package.json` / `README*` / `LICENSE*`）をモデル化した `isPackagedPath` を検証する。
 * 真になるのは `dist/` 配下と `package.json` / `README.md` / `LICENSE.md` に限られる。
 *
 * **Validates: Requirements 2.2, 2.3, 2.4**
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { isPackagedPath } from "../../scripts/lib/release.mjs";

/** パス区切りは `npm pack --json` の出力と同じ `/` を前提とする。 */
const SEPARATOR = "/";

/** 収録される固定パス（npm常時収録 + `files` 明示）。 */
const INCLUDED_EXACT_PATHS = [
  "package.json",
  "README.md",
  "LICENSE.md",
] as const;

/** 要件2.3が列挙する除外対象ディレクトリ。 */
const EXCLUDED_DIRECTORIES = [
  "src",
  "tests",
  "docs",
  ".github",
  ".kiro",
  "node_modules",
  "scripts",
] as const;

/** 要件2.3が列挙する除外対象ファイル（ルート直下）。 */
const EXCLUDED_ROOT_FILES = [
  ".npmrc",
  "NPM.md",
  "DOCKERHUB.md",
  "tsconfig.json",
  "vitest.config.ts",
  "renovate.json5",
  ".gitignore",
  "package-lock.json",
  "Dockerfile",
  ".dockerignore",
  // Package_Prepack_Process の退避ファイル（要件9.9）
  ".readme-github.bak",
] as const;

/** パス1要素。`.` / `..` は相対パスの意味が変わるため除外する。 */
const segmentArb = fc
  .stringMatching(/^[A-Za-z0-9._-]{1,12}$/)
  .filter((s) => s !== "." && s !== "..");

/** `dist/` 配下の任意の深さのファイルパス（`dist/index.js` / `dist/tools/x.js.map` など）。 */
const distPathArb = fc
  .array(segmentArb, { minLength: 0, maxLength: 3 })
  .chain((dirs) =>
    segmentArb.map((file) => ["dist", ...dirs, file].join(SEPARATOR)),
  );

/** 除外対象ディレクトリ配下の任意のパス。 */
const excludedDirPathArb = fc
  .constantFrom(...EXCLUDED_DIRECTORIES)
  .chain((dir) =>
    fc
      .array(segmentArb, { minLength: 1, maxLength: 3 })
      .map((rest) => [dir, ...rest].join(SEPARATOR)),
  );

/** `.env` で始まる任意の名称（`.env` / `.env.local` / `.env.production` など）。 */
const dotEnvNameArb = fc
  .stringMatching(/^[A-Za-z0-9._-]{0,10}$/)
  .map((suffix) => `.env${suffix}`);

/**
 * 収録される（真になる）パスかをモデル上で判定する補助関数。
 * 生成器のフィルタにのみ使用し、アサーションの期待値には使わない
 * （実装のコピーを期待値にすると検証にならないため）。
 */
const looksIncluded = (path: string): boolean =>
  path.startsWith("dist") ||
  path.startsWith("README") ||
  path.startsWith("LICENSE") ||
  path.startsWith("package.json");

/** 収録対象と紛れない任意の相対パス文字列。 */
const arbitraryExcludedPathArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0 && !looksIncluded(s));

describe("Feature: npm-package-distribution, Property 3: Package_Tarballの収録判定は許可リストと一致する", () => {
  /**
   * **Validates: Requirements 2.2, 2.4**
   *
   * `dist/` 配下の任意のパスは常に収録される（`.gitignore` の `dist/` より
   * `files` 許可リストが優先される）。
   */
  it("dist/ 配下の任意のパスは常に収録される", () => {
    fc.assert(
      fc.property(distPathArb, (path) => {
        expect(isPackagedPath(path)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * npmが常に収録するファイルと `files` に明示したファイルは収録される。
   */
  it("package.json / README.md / LICENSE.md は収録される", () => {
    fc.assert(
      fc.property(fc.constantFrom(...INCLUDED_EXACT_PATHS), (path) => {
        expect(isPackagedPath(path)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.3**
   *
   * `src/` `tests/` `docs/` `.github/` `.kiro/` `node_modules/` `scripts/`
   * 配下の任意のパスは常に除外される。
   */
  it("除外対象ディレクトリ配下の任意のパスは収録されない", () => {
    fc.assert(
      fc.property(excludedDirPathArb, (path) => {
        expect(isPackagedPath(path)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.3**
   *
   * `.env` で始まる名称（秘密情報を含み得る）は常に除外される。
   */
  it(".env で始まる任意の名称は収録されない", () => {
    fc.assert(
      fc.property(dotEnvNameArb, (path) => {
        expect(isPackagedPath(path)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.3**
   *
   * `.npmrc`（CIのsetup-nodeが生成し得る）・`NPM.md`・`DOCKERHUB.md`・
   * `tsconfig.json`・`vitest.config.ts`・`renovate.json5`・`.gitignore`・
   * `package-lock.json`・`.readme-github.bak` は常に除外される。
   */
  it("除外対象のルート直下ファイルは収録されない", () => {
    fc.assert(
      fc.property(fc.constantFrom(...EXCLUDED_ROOT_FILES), (path) => {
        expect(isPackagedPath(path)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 2.2, 2.3**
   *
   * 許可リスト外の任意の相対パス文字列は収録されない（判定が「限られる」ことの検証）。
   */
  it("許可リスト外の任意の相対パス文字列は収録されない", () => {
    fc.assert(
      fc.property(arbitraryExcludedPathArb, (path) => {
        expect(isPackagedPath(path)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * 全域関数であり例外を投げない。非文字列・空文字列は偽を返す。
   */
  it("非文字列と空文字列は例外を投げずに偽を返す", () => {
    const nonStringArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
      fc.boolean(),
      fc.array(fc.string()),
      fc.object(),
    );

    fc.assert(
      fc.property(nonStringArb, (value) => {
        expect(isPackagedPath(value)).toBe(false);
      }),
      { numRuns: 100 },
    );

    expect(isPackagedPath("")).toBe(false);
  });
});

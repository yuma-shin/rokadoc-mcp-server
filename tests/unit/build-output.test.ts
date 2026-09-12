import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ビルド成果物（dist/）と `src/` の対応、および標準出力への書き込みが
 * `src/` 配下に存在しないことを検証する。
 *
 * - 要件1.6: `src/` 配下の各TypeScriptモジュールに対応するJavaScriptファイルと
 *   型定義ファイルが生成されること。
 * - 要件1.9: 標準出力へはJSON-RPC 2.0メッセージのみを書き込むこと
 *   （本ファイルでは静的近似による非回帰ガードとして検証する。動的検証は
 *   統合テスト `cli-startup` 側の担当）。
 *
 * リポジトリルートは `process.cwd()` ではなく `import.meta.url` から解決する。
 */
const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(testDir, "..", "..");
const srcDir = join(repoRoot, "src");
const distDir = join(repoRoot, "dist");

/** `src/` の構成から一意に決まるモジュール数。増減したら期待値を更新する。 */
const EXPECTED_MODULE_COUNT = 11;

/** 1モジュールにつき生成される成果物の拡張子（`tsconfig.json` の declaration / declarationMap / sourceMap がすべて true）。 */
const ARTIFACT_SUFFIXES = [".js", ".d.ts", ".js.map", ".d.ts.map"] as const;

/** ディレクトリを再帰走査し、`baseDir` からの相対パス（区切りは `/`）の一覧を返す。 */
function listFilesRecursively(baseDir: string, currentDir: string = baseDir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolute = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursively(baseDir, absolute));
    } else if (entry.isFile()) {
      results.push(relative(baseDir, absolute).split("\\").join(posix.sep));
    }
  }
  return results.sort();
}

/** `src/` を再帰走査して得た `.ts` モジュールの相対パス一覧（拡張子なし）。 */
const moduleBaseNames = listFilesRecursively(srcDir)
  .filter((relativePath) => relativePath.endsWith(".ts"))
  .map((relativePath) => relativePath.slice(0, -".ts".length));

/** 期待する `dist/` の収録集合（11モジュール × 4種 = 44ファイル）。 */
const expectedDistFiles = moduleBaseNames
  .flatMap((base) => ARTIFACT_SUFFIXES.map((suffix) => `${base}${suffix}`))
  .sort();

/**
 * 成果物依存テストの実行可否。
 * `dist/index.js` が存在しない場合、CIではビルド後に実行されるため成果物の不在自体が異常であり失敗させる。
 * ローカルでは理由付きスキップとする（タスク4.7と同一方針）。
 */
const distAvailable = existsSync(join(distDir, "index.js"));
const isCI = process.env.CI !== undefined && process.env.CI !== "";

describe("build output: src/ と dist/ の対応（要件1.6）", () => {
  it(`src/ 配下の .ts モジュールが ${EXPECTED_MODULE_COUNT} 件である`, () => {
    expect(
      moduleBaseNames.length,
      `src/ 配下の .ts モジュール数が期待値と異なる。` +
        `モジュールを追加・削除した場合は tests/unit/build-output.test.ts の EXPECTED_MODULE_COUNT ` +
        `（現在 ${EXPECTED_MODULE_COUNT}）と、設計書 design.md の「Package_Tarball マニフェスト」節の` +
        `期待ファイル数（dist/ ${EXPECTED_MODULE_COUNT * ARTIFACT_SUFFIXES.length} 件 / tarball 47 件）を更新すること。` +
        `実際に検出したモジュール: ${moduleBaseNames.join(", ")}`,
    ).toBe(EXPECTED_MODULE_COUNT);
  });

  it("dist/index.js が存在する（CIでは必須）", () => {
    if (!distAvailable) {
      if (isCI) {
        expect.fail(
          "dist/index.js が存在しない。CIではビルド後にテストが実行されるため、" +
            "成果物の不在は異常である（`npm run build` の失敗を確認すること）。",
        );
      }
      // ローカルでは未ビルド状態を許容する。
      console.warn("dist/index.js が存在しないため成果物依存の検証をスキップした。`npm run build` を実行すること。");
      return;
    }
    expect(existsSync(join(distDir, "index.js"))).toBe(true);
  });

  describe.runIf(distAvailable)("各モジュールに対応する成果物が存在する", () => {
    for (const base of moduleBaseNames) {
      for (const suffix of ARTIFACT_SUFFIXES) {
        const relativePath = `${base}${suffix}`;
        it(`dist/${relativePath} が存在する`, () => {
          const absolute = join(distDir, relativePath);
          expect(existsSync(absolute), `dist/${relativePath} が存在しない（src/${base}.ts に対応する成果物）`).toBe(
            true,
          );
          expect(statSync(absolute).isFile()).toBe(true);
        });
      }
    }
  });

  it.runIf(distAvailable)("dist/ に期待集合以外のファイルが存在しない（要件2.2の閉じた収録集合）", () => {
    const actualDistFiles = listFilesRecursively(distDir);
    const extras = actualDistFiles.filter((path) => !expectedDistFiles.includes(path));
    expect(
      extras,
      `dist/ に src/ の構成から導出できないファイルが存在する。` +
        `prebuild（scripts/clean-dist.mjs）が機能していない、または削除済みモジュールの孤児ファイルが残っている可能性がある。`,
    ).toEqual([]);
    expect(actualDistFiles).toEqual(expectedDistFiles);
    expect(actualDistFiles).toHaveLength(EXPECTED_MODULE_COUNT * ARTIFACT_SUFFIXES.length);
  });
});

/**
 * 要件1.9の静的近似。
 *
 * 限界: 文字列リテラルやコメント内の出現も検出する素朴な走査である（偽陽性の可能性がある）。
 * それでも「標準出力への書き込みが増えていないこと」の非回帰ガードとして機能する。
 * 標準エラー出力への書き込み（`console.error` / `console.warn` / `process.stderr.write`）は
 * 要件1.9で許容されているため検出対象にしない。
 */
describe("build output: src/ が標準出力へ書き込まないこと（要件1.9の静的近似）", () => {
  const forbiddenPatterns: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    { label: "console.log", pattern: /console\s*\.\s*log\b/ },
    { label: "console.info", pattern: /console\s*\.\s*info\b/ },
    { label: "process.stdout.write", pattern: /process\s*\.\s*stdout\s*\.\s*write\b/ },
  ];

  const srcTsFiles = listFilesRecursively(srcDir).filter((relativePath) => relativePath.endsWith(".ts"));

  it("走査対象の .ts ファイルが1件以上ある", () => {
    expect(srcTsFiles.length).toBeGreaterThan(0);
  });

  for (const relativePath of srcTsFiles) {
    for (const { label, pattern } of forbiddenPatterns) {
      it(`src/${relativePath} に ${label} が出現しない`, () => {
        const source = readFileSync(join(srcDir, relativePath), "utf8");
        const matchedLines = source
          .split(/\r?\n/)
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter(({ line }) => pattern.test(line));
        expect(
          matchedLines.map(({ lineNumber, line }) => `${lineNumber}: ${line.trim()}`),
          `src/${relativePath} に ${label} が出現する。標準出力にはJSON-RPC 2.0メッセージのみを書き込むこと` +
            `（診断・エラー出力は process.stderr.write / console.error を使う）。`,
        ).toEqual([]);
      });
    }
  }

  it("標準エラー出力への書き込みは検出対象にしない", () => {
    const allowedSamples = [
      'console.error("diagnostic")',
      'console.warn("diagnostic")',
      'process.stderr.write("diagnostic\\n")',
    ];
    for (const sample of allowedSamples) {
      for (const { pattern } of forbiddenPatterns) {
        expect(pattern.test(sample), `${sample} を誤検出している`).toBe(false);
      }
    }
  });
});

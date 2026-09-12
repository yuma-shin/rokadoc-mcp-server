import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isPackagedPath } from "../../scripts/lib/release.mjs";
import {
  copyRepositoryTo,
  readTarballEntries,
  runNpmPack,
  stripPackagePrefix,
  toPosix,
  type PackReport,
} from "./lib/pack-tarball.js";

/**
 * Package_Tarball の実測テスト（要件2-2 / 2-3 / 2-4 / 2-7 / 9-8 / 9-9 / 9-11、Property 3）
 *
 * `npm pack` を1回実行し、生成されたtarballの実バイト列から収録内容を取得して次を検証する。
 *
 * - 収録ファイル集合が期待47ファイル（`dist/` 44件 + `package.json` / `README.md` / `LICENSE.md`）と厳密一致する
 * - 除外対象（`src/` `tests/` `docs/` 配下、`NPM.md` `tsconfig.json` など）が1件も含まれない
 * - `dist/index.js` が含まれる（`.gitignore` の `dist/` より `files` が優先される）
 * - `entryCount <= 120` かつ圧縮後 `size <= 1 MB`
 * - 収録された `README.md` が `NPM.md`（NPM_Readme）とバイト単位で一致する
 * - `postpack` により作業ツリーの `README.md` が元の内容へ戻り、退避ファイルが残らない
 * - 実測された収録集合が `isPackagedPath`（Property 3 のモデル）の判定と一致する
 *
 * ## 方式の選択（タスク1.2の確認結果に基づく）
 *
 * prerequisites.md タスク1.2 のとおり、`npm pack --dry-run --json` でも `prepack` / `postpack`
 * は実行される。しかし `--dry-run` ではtarballが生成されないため、収録された `README.md` の
 * **内容**（要件9-8 / 9-11）をバイト単位で検証できない。そこで実tarball生成方式を採る。
 * `--json` 出力（`files[].path` / `entryCount` / `size`）は `--dry-run` と実生成のいずれでも
 * 同一スキーマで得られるため、要件2-7の判定に必要な情報も同時に取得できる。
 *
 * ## リポジトリ作業ツリーを汚さない理由（重要）
 *
 * `npm pack` は `prepack` により作業ツリーの `README.md` を `NPM.md` の内容へ差し替える。
 * vitest はテストファイルを並列実行するため、リポジトリルートで `npm pack` を実行すると
 * 差し替え中の `README.md` を他のテスト（`tests/unit/documentation-consistency.test.ts` は
 * モジュール読み込み時に実 `README.md` を読む）が観測して間欠的に失敗し得る。
 *
 * したがって本テストは、リポジトリを一時ディレクトリへ複製（`node_modules` と `.git` を除く）し、
 * **複製側で** `npm pack` を実行する。これにより次の2点を同時に満たす。
 *
 * 1. 実リポジトリの `README.md` は1バイトも変更されない（他テストとの競合が構造的に起きない。
 *    テストが途中で失敗しても復元漏れが起こり得ない）
 * 2. 実行される `package.json` の `prepack` / `postpack` と `scripts/pack-readme.mjs` は本物であり、
 *    差し替え・復元の検証（要件9-8 / 9-9）は複製側の作業ツリーに対して成立する
 *
 * 複製側と実リポジトリで同一のtarballが生成されることは実測で確認している（`entryCount` 47 /
 * 圧縮後サイズが両者一致）。tarballは複製側のルートへ生成させるため、パス引数の受け渡しが不要で
 * Windowsのクォート差異の影響を受けない。
 *
 * ## Windows での注意
 *
 * - tarball内および `npm pack --json` の `files[].path` の区切りは常に `/` である。
 *   ディスク走査で得た相対パスは `/` へ正規化してから比較する。
 * - Node.js 20 以降は `.cmd` を `shell` なしで起動できないため、win32 では `npm.cmd` を
 *   `shell: true` で起動する。引数はリテラルのみでパスを含めないため、クォートの問題は生じない。
 */

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(testDir, "..", "..");
const srcDir = join(repoRoot, "src");

/** 1モジュールにつき生成される成果物の拡張子（`build-output.test.ts` と同一）。 */
const ARTIFACT_SUFFIXES = [".js", ".d.ts", ".js.map", ".d.ts.map"] as const;

/** `files` フィールドとnpmの常時収録ルールにより収録されるルート直下のファイル。 */
const ROOT_PACKAGED_FILES = [
  "LICENSE.md",
  "README.md",
  "package.json",
] as const;

/** 期待する収録ファイル数（`dist/` 44件 + ルート3件）。 */
const EXPECTED_ENTRY_COUNT = 47;

/** 要件2-7の上限。 */
const MAX_ENTRY_COUNT = 120;
const MAX_TARBALL_SIZE_BYTES = 1024 * 1024;

/** 収録されてはならないディレクトリ（相対パスの先頭一致で判定する）。 */
const EXCLUDED_DIRECTORY_PREFIXES = [
  "src/",
  "tests/",
  "docs/",
  ".github/",
  ".kiro/",
  "scripts/",
  "node_modules/",
] as const;

/** 収録されてはならないルート直下のファイル。 */
const EXCLUDED_EXACT_FILES = [
  "Dockerfile",
  ".dockerignore",
  "NPM.md",
  "DOCKERHUB.md",
  "tsconfig.json",
  "tsconfig.test.json",
  "vitest.config.ts",
  "renovate.json5",
  ".gitignore",
  ".npmrc",
  "package-lock.json",
  ".readme-github.bak",
] as const;

/** ディレクトリを再帰走査し、`baseDir` からの相対パス（区切りは `/`）の一覧を返す。 */
function listFilesRecursively(
  baseDir: string,
  currentDir: string = baseDir,
  skipTopLevel: ReadonlyArray<string> = [],
): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const absolute = join(currentDir, entry.name);
    const relativePath = toPosix(relative(baseDir, absolute));
    if (skipTopLevel.includes(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...listFilesRecursively(baseDir, absolute, skipTopLevel));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }
  return results.sort();
}

/** `src/` の構成から導出した期待収録集合（44 + 3 = 47件、昇順）。 */
const expectedPackagedPaths: ReadonlyArray<string> = listFilesRecursively(
  srcDir,
)
  .filter((relativePath) => relativePath.endsWith(".ts"))
  .map((relativePath) => relativePath.slice(0, -".ts".length))
  .flatMap((base) => ARTIFACT_SUFFIXES.map((suffix) => `dist/${base}${suffix}`))
  .concat(ROOT_PACKAGED_FILES)
  .sort();

/**
 * 成果物依存テストの共通方針（`shebang.test.ts` / `build-output.test.ts` と同一）:
 * `dist/index.js` が無い場合、CIではビルド後に実行されるため異常として失敗させ、
 * ローカルでは理由付きでスキップする。
 */
const distAvailable = existsSync(join(repoRoot, "dist", "index.js"));
const isCI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * `npm pack --json` の実行と tarball の解析手順は
 * `tests/integration/npm-readme-substitution.test.ts` と共通であり、
 * `./lib/pack-tarball.ts`（`copyRepositoryTo` / `runNpmPack` / `readTarballEntries` /
 * `stripPackagePrefix` / `PackReport`）へ切り出してある。
 */

/** `npm pack` の実行結果（複製した作業ツリー上での実測値）。 */
interface PackOutcome {
  readonly report: PackReport;
  /** tarball内の通常ファイル（キーは `package/` を除いた相対パス、区切りは `/`）。 */
  readonly tarballFiles: Map<string, Buffer>;
  /** tarball内の全エントリパス（`package/` 接頭辞を含む生の値）。 */
  readonly rawEntryPaths: ReadonlyArray<string>;
  /** `npm pack` 実行後の複製側 `README.md`。 */
  readonly readmeAfterPack: Buffer;
  /** 複製側に退避ファイル（`.readme-github.bak`）が残っているか。 */
  readonly backupLeftBehind: boolean;
}

let workDir: string | null = null;
let packOutcome: PackOutcome | null = null;
let packFailure: Error | null = null;

/** リポジトリの `README.md` / `NPM.md`（複製前の実バイト列）。 */
const repositoryReadme = readFileSync(join(repoRoot, "README.md"));
const npmReadme = readFileSync(join(repoRoot, "NPM.md"));

/** 実行結果を取り出す。取得に失敗している場合は原因を示して失敗させる。 */
function requirePackOutcome(): PackOutcome {
  if (packFailure !== null) {
    throw packFailure;
  }
  if (packOutcome === null) {
    throw new Error("npm pack の実行結果が取得できていない");
  }
  return packOutcome;
}

beforeAll(() => {
  if (!distAvailable) {
    return;
  }
  try {
    workDir = mkdtempSync(join(tmpdir(), "rokadoc-pack-"));
    const tree = join(workDir, "repo");

    // `node_modules` と `.git` を除いてリポジトリを複製し、複製側で `npm pack` を実行する。
    // tarballは複製側のルートへ生成される（パス引数が不要になり、Windowsでのクォート差異を避けられる）。
    copyRepositoryTo(tree);
    const { report, tarballPath } = runNpmPack(tree);
    const rawFiles = readTarballEntries(tarballPath);
    const tarballFiles = stripPackagePrefix(rawFiles);

    packOutcome = {
      report,
      tarballFiles,
      rawEntryPaths: [...rawFiles.keys()],
      readmeAfterPack: readFileSync(join(tree, "README.md")),
      backupLeftBehind: existsSync(join(tree, ".readme-github.bak")),
    };
  } catch (error) {
    packFailure = error instanceof Error ? error : new Error(String(error));
  }
}, 180_000);

afterAll(() => {
  if (workDir !== null) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe("Package_Tarball の実測（要件2-2 / 2-3 / 2-4 / 2-7 / 9-8 / 9-9 / 9-11）", () => {
  it("dist/ が生成されている（CIでは必須）", () => {
    if (!distAvailable) {
      if (isCI) {
        expect.fail(
          "dist/index.js が存在しない。CIではビルド後にテストが実行されるため、" +
            "成果物の不在は異常である（`npm run build` の失敗を確認すること）。",
        );
      }
      console.warn(
        "dist/index.js が存在しないため tarball 実測テストをスキップした。`npm run build` を実行すること。",
      );
      return;
    }
    expect(distAvailable).toBe(true);
  });

  describe.runIf(distAvailable)("npm pack の実行結果", () => {
    it("npm pack が成功し `--json` 出力を解析できる", () => {
      const { report } = requirePackOutcome();
      expect(report.filename).toMatch(
        /^rokadoc-mcp-server-\d+\.\d+\.\d+\.tgz$/,
      );
      expect(report.files.length).toBe(report.entryCount);
    });

    it(`収録ファイル集合が期待${EXPECTED_ENTRY_COUNT}ファイルと厳密一致する（要件2-2）`, () => {
      const { report } = requirePackOutcome();
      const actual = report.files.map((file) => file.path).sort();
      expect(
        expectedPackagedPaths.length,
        "期待集合の件数が47ではない（src/ のモジュール構成が変わった場合は " +
          "design.md と本テストの期待値を更新すること）",
      ).toBe(EXPECTED_ENTRY_COUNT);
      expect(
        actual,
        "tarballの収録集合が `dist/` 44件 + package.json / README.md / LICENSE.md と一致しない",
      ).toEqual([...expectedPackagedPaths]);
    });

    it("tarballの実エントリが `--json` の files[] と一致し、すべて `package/` 配下である", () => {
      const { report, tarballFiles, rawEntryPaths } = requirePackOutcome();
      const notPrefixed = rawEntryPaths.filter(
        (path) => !path.startsWith("package/"),
      );
      expect(
        notPrefixed,
        "tarball内に `package/` 接頭辞を持たないエントリが存在する",
      ).toEqual([]);
      expect([...tarballFiles.keys()].sort()).toEqual(
        report.files.map((file) => file.path).sort(),
      );
    });

    it("`dist/index.js` が含まれる（`.gitignore` の `dist/` より `files` が優先される。要件2-4）", () => {
      const { tarballFiles } = requirePackOutcome();
      // `.gitignore` に `dist/` の除外設定が存在することを前提として確認する。
      const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
      expect(
        /^\s*dist\/?\s*$/m.test(gitignore),
        ".gitignore に `dist/` の除外設定が無い。要件2-4の前提が崩れている",
      ).toBe(true);
      expect(tarballFiles.has("dist/index.js")).toBe(true);
      expect(
        (tarballFiles.get("dist/index.js") as Buffer).length,
      ).toBeGreaterThan(0);
    });

    it("除外対象が1件も含まれない（要件2-3）", () => {
      const { report } = requirePackOutcome();
      const paths = report.files.map((file) => file.path);

      const includedFromExcludedDirectories = paths.filter((path) =>
        EXCLUDED_DIRECTORY_PREFIXES.some((prefix) => path.startsWith(prefix)),
      );
      expect(
        includedFromExcludedDirectories,
        "除外対象ディレクトリ配下のファイルが収録されている",
      ).toEqual([]);

      const includedExcludedFiles = paths.filter((path) =>
        EXCLUDED_EXACT_FILES.includes(
          path as (typeof EXCLUDED_EXACT_FILES)[number],
        ),
      );
      expect(includedExcludedFiles, "除外対象ファイルが収録されている").toEqual(
        [],
      );

      const includedDotEnvFiles = paths.filter((path) =>
        path.split("/").pop()?.startsWith(".env"),
      );
      expect(
        includedDotEnvFiles,
        "`.env` で始まる名称のファイルが収録されている",
      ).toEqual([]);
    });

    it(`entryCount が ${MAX_ENTRY_COUNT} 以下、圧縮後サイズが 1 MB 以下である（要件2-7）`, () => {
      const { report } = requirePackOutcome();
      expect(report.entryCount).toBe(EXPECTED_ENTRY_COUNT);
      expect(report.entryCount).toBeLessThanOrEqual(MAX_ENTRY_COUNT);
      expect(
        report.size,
        `圧縮後サイズが 1 MB を超えている: ${report.size} バイト`,
      ).toBeLessThanOrEqual(MAX_TARBALL_SIZE_BYTES);
      expect(report.size).toBeGreaterThan(0);
    });

    it("収録された `README.md` が `NPM.md` とバイト単位で一致する（要件9-8 / 9-11）", () => {
      const { report, tarballFiles } = requirePackOutcome();
      const packagedReadme = tarballFiles.get("README.md");
      expect(
        packagedReadme,
        "tarballに README.md が含まれていない",
      ).toBeDefined();
      expect(
        (packagedReadme as Buffer).equals(npmReadme),
        "tarball内の README.md が NPM.md とバイト一致しない（prepack による差し替えが機能していない）",
      ).toBe(true);
      // `--json` の files[].size でも同じ結論になることを確認する。
      const readmeEntry = report.files.find(
        (file) => file.path === "README.md",
      );
      expect(readmeEntry?.size).toBe(npmReadme.length);
      // GitHub向け README.md（Release_Documentation）とは異なる内容であること。
      expect(
        (packagedReadme as Buffer).equals(repositoryReadme),
        "tarball内の README.md が GitHub向け README.md と同一である（差し替えが行われていない）",
      ).toBe(false);
    });

    it("pack 終了後に作業ツリーの `README.md` が元の内容へ戻り、退避ファイルが残らない（要件9-9）", () => {
      const { readmeAfterPack, backupLeftBehind } = requirePackOutcome();
      expect(
        readmeAfterPack.equals(repositoryReadme),
        "npm pack 実行後の README.md が元の内容へ復元されていない（postpack が機能していない）",
      ).toBe(true);
      expect(
        backupLeftBehind,
        "退避ファイル `.readme-github.bak` が残っている（postpack が削除していない）",
      ).toBe(false);
    });

    it("リポジトリの作業ツリーは一切変更されていない（README.md / 退避ファイル）", () => {
      // 本テストは複製側で `npm pack` を実行するため、実リポジトリは変更されない。
      expect(
        readFileSync(join(repoRoot, "README.md")).equals(repositoryReadme),
        "リポジトリの README.md が変更されている",
      ).toBe(true);
      expect(existsSync(join(repoRoot, ".readme-github.bak"))).toBe(false);
    });
  });

  /**
   * Property 3 のモデル（`isPackagedPath`）と npm の実挙動の一致検証。
   *
   * リポジトリを走査して得た全相対パスについて、モデルの判定と実測の収録有無が一致することを
   * 主張する。npmの `files` 解釈が将来変わってモデルが乖離した場合、ここで検出できる。
   */
  describe.runIf(distAvailable)(
    "isPackagedPath モデルと実挙動の一致（Property 3）",
    () => {
      it("実測の収録集合とモデルの判定が全パスで一致する", () => {
        const { report } = requirePackOutcome();
        const packedPaths = new Set(report.files.map((file) => file.path));
        const candidates = listFilesRecursively(repoRoot, repoRoot, [
          "node_modules",
          ".git",
        ]);
        expect(
          candidates.length,
          "リポジトリ走査で候補パスが得られなかった",
        ).toBeGreaterThan(EXPECTED_ENTRY_COUNT);

        const disagreements = candidates.filter(
          (path) => isPackagedPath(path) !== packedPaths.has(path),
        );
        expect(
          disagreements.map(
            (path) =>
              `${path}: モデル=${String(isPackagedPath(path))} / 実測=${String(
                packedPaths.has(path),
              )}`,
          ),
          "isPackagedPath の判定が npm の実挙動と一致しないパスがある",
        ).toEqual([]);
      });

      it("収録された全パスに対してモデルが真を返す", () => {
        const { report } = requirePackOutcome();
        const falseNegatives = report.files
          .map((file) => file.path)
          .filter((path) => !isPackagedPath(path));
        expect(
          falseNegatives,
          "収録されているのにモデルが偽を返すパスがある",
        ).toEqual([]);
      });
    },
  );
});

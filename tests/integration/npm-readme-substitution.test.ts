import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyRepositoryTo,
  extractTarball,
  repositoryRoot,
  runNpmPack,
  type PackReport,
} from "./lib/pack-tarball.js";

/**
 * Package_Prepack_Process の実測テスト（要件9-8 / 9-9、Property 4）
 *
 * `substitute` → 実tarball生成 → 展開 → `restore` の一連を一時ディレクトリで実行し、
 * tarball内の `README.md` が `NPM.md`（NPM_Readme）とバイト一致し、作業ツリーが
 * Release_Documentation（GitHub向け `README.md`）の内容へ復元されることを検証する。
 *
 * ## `tarball-contents.test.ts`（タスク8.1）との違い
 *
 * 8.1 は `npm pack` を1回実行して**収録内容の集合**（件数・除外・サイズ）を検証する。
 * 本テストは**差し替えと復元の手順そのもの**を対象とし、次の2経路を明示的に通す。
 *
 * | 経路               | 実行方法                                              | 検証の焦点                                       |
 * | ------------------ | ----------------------------------------------------- | ------------------------------------------------ |
 * | 明示実行           | `node scripts/pack-readme.mjs substitute` → `npm pack --ignore-scripts` → 展開 → `restore` | 各段階の中間状態（退避ファイルの内容を含む） |
 * | ライフサイクル経由 | `npm pack`（`prepack` / `postpack` が走る）           | 明示実行と同一の tarball 内容になること           |
 *
 * 明示実行では `--ignore-scripts` を付けて `prepack` / `postpack` を止め、
 * 「差し替え済みの作業ツリーがそのまま収録される」ことと「`restore` が単独で作業ツリーを
 * 元へ戻す」ことを分離して観測する。ライフサイクル経由の tarball と明示実行の tarball の
 * `README.md` が一致することは、ローカルでの生成と NPM_Publish_Workflow 経由の生成が
 * 同一内容の `README.md` を収録すること（要件9-8）の実測的な裏付けである。
 *
 * ## 既存の Property 4 テストとの関係
 *
 * `tests/property/pack-readme.property.test.ts` は `scripts/pack-readme.mjs` を任意の内容・
 * 任意の操作列（失敗注入を含む）に対して検証する。そこで扱わないのは「実際の `npm pack` が
 * 生成した tarball の中身」であり、本テストがその1点を担う。
 *
 * ## リポジトリ作業ツリーを汚さない理由（重要）
 *
 * `substitute` と `npm pack` はいずれも作業ツリーの `README.md` を書き換える。vitest は
 * テストファイルを並列実行するため、リポジトリルートで実行すると差し替え中の `README.md` を
 * 他のテスト（`tests/unit/documentation-consistency.test.ts` はモジュール読み込み時に実
 * `README.md` を読む）が観測して間欠的に失敗し得る。したがって本テストはリポジトリを一時
 * ディレクトリへ複製し、**複製側のみ**を操作する（`./lib/pack-tarball.ts` 参照）。実行される
 * `package.json` の `prepack` / `postpack` と `scripts/pack-readme.mjs` は本物である。
 *
 * ## 比較方法
 *
 * 内容の比較はすべて Buffer のバイト比較で行う。要件9-8 が求めるのは「NPM_Readme と同一内容の
 * `README.md`」であり、文字コード変換や改行変換が挟まっていないことまで主張する必要がある。
 */

/** `scripts/pack-readme.mjs` の実行結果。 */
interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** tarball の生成結果と展開結果。 */
interface PackArtifacts {
  readonly report: PackReport;
  /** 展開先ディレクトリ（`package/` を剥がした状態で配置される）。 */
  readonly extractedDir: string;
  /** 展開されたファイルの相対パス（区切りは `/`）と内容。 */
  readonly entries: Map<string, Buffer>;
}

/** 一連の手順の観測結果。 */
interface SubstitutionOutcome {
  /** 複製直後の複製側 `README.md`（GitHub向け内容と一致するはず）。 */
  readonly readmeInCopy: Buffer;
  /** 明示実行した `substitute` の結果。 */
  readonly substitute: RunResult;
  readonly readmeAfterSubstitute: Buffer;
  readonly backupAfterSubstitute: Buffer | null;
  readonly npmReadmeAfterSubstitute: Buffer;
  /** `--ignore-scripts` 付きの `npm pack`（差し替え済みの状態を収録する）。 */
  readonly explicitPack: PackArtifacts;
  readonly readmeAfterExplicitPack: Buffer;
  readonly backupExistsAfterExplicitPack: boolean;
  /** 明示実行した `restore` の結果。 */
  readonly restore: RunResult;
  readonly readmeAfterRestore: Buffer;
  readonly backupExistsAfterRestore: boolean;
  /** 退避ファイルが無い状態での2回目の `restore`（冪等性）。 */
  readonly redundantRestore: RunResult;
  readonly readmeAfterRedundantRestore: Buffer;
  /** `prepack` / `postpack` を伴う `npm pack`。 */
  readonly lifecyclePack: PackArtifacts;
  readonly readmeAfterLifecyclePack: Buffer;
  readonly backupExistsAfterLifecyclePack: boolean;
}

/** リポジトリの `README.md` / `NPM.md`（複製前の実バイト列）。 */
const githubReadme = readFileSync(join(repositoryRoot, "README.md"));
const npmReadme = readFileSync(join(repositoryRoot, "NPM.md"));

let workDir: string | null = null;
let outcome: SubstitutionOutcome | null = null;
let failure: Error | null = null;

/** 観測結果を取り出す。取得に失敗している場合は原因を示して失敗させる。 */
function requireOutcome(): SubstitutionOutcome {
  if (failure !== null) {
    throw failure;
  }
  if (outcome === null) {
    throw new Error("substitute / pack / restore の観測結果が取得できていない");
  }
  return outcome;
}

/**
 * 複製側の `scripts/pack-readme.mjs` を実プロセスとして実行する。
 *
 * オプションを与えず既定パスを使う。既定パスはスクリプト自身の位置から導出されるため、
 * `cwd` を複製ツリーの外（一時ディレクトリの直下）にしても複製側のファイルが対象になる。
 * この点も併せて確認するため、あえて `cwd` をツリー外にしている。
 *
 * @param tree 複製したリポジトリのルート
 * @param cwd 実行時のカレントディレクトリ
 * @param subcommand `substitute` または `restore`
 * @returns 終了コードと標準出力・標準エラー出力
 */
function runPackReadme(
  tree: string,
  cwd: string,
  subcommand: "substitute" | "restore",
): RunResult {
  const result = spawnSync(
    process.execPath,
    [join(tree, "scripts", "pack-readme.mjs"), subcommand],
    { cwd, encoding: "utf8", windowsHide: true },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * `npm pack` を実行し、生成された tarball を展開する。
 *
 * @param tree 複製したリポジトリのルート（tarball もここへ生成される）
 * @param extractedDir 展開先
 * @param extraArgs `npm pack` への追加引数
 * @returns `--json` 出力と展開結果
 */
function packAndExtract(
  tree: string,
  extractedDir: string,
  extraArgs: readonly string[] = [],
): PackArtifacts {
  const { report, tarballPath } = runNpmPack(tree, extraArgs);
  const entries = extractTarball(tarballPath, extractedDir);
  return { report, extractedDir, entries };
}

beforeAll(() => {
  try {
    workDir = mkdtempSync(join(tmpdir(), "rokadoc-readme-sub-"));
    const tree = join(workDir, "repo");
    copyRepositoryTo(tree);

    const readme = join(tree, "README.md");
    const backup = join(tree, ".readme-github.bak");
    const readmeInCopy = readFileSync(readme);

    // 1. 明示的な `substitute`（prepack が呼ぶものと同一のコマンド）。
    const substitute = runPackReadme(tree, workDir, "substitute");
    const readmeAfterSubstitute = readFileSync(readme);
    const backupAfterSubstitute = existsSync(backup)
      ? readFileSync(backup)
      : null;
    const npmReadmeAfterSubstitute = readFileSync(join(tree, "NPM.md"));

    // 2. 差し替え済みの作業ツリーを収録する（`--ignore-scripts` で prepack / postpack を止める）。
    const explicitPack = packAndExtract(
      tree,
      join(workDir, "extracted-explicit"),
      ["--ignore-scripts"],
    );
    const readmeAfterExplicitPack = readFileSync(readme);
    const backupExistsAfterExplicitPack = existsSync(backup);

    // 3. 明示的な `restore`（postpack が呼ぶものと同一のコマンド）。
    const restore = runPackReadme(tree, workDir, "restore");
    const readmeAfterRestore = readFileSync(readme);
    const backupExistsAfterRestore = existsSync(backup);

    // 4. 退避ファイルが無い状態での再実行（冪等性）。
    const redundantRestore = runPackReadme(tree, workDir, "restore");
    const readmeAfterRedundantRestore = readFileSync(readme);

    // 5. ライフサイクル経由（`prepack` / `postpack` が走る）。
    const lifecyclePack = packAndExtract(
      tree,
      join(workDir, "extracted-lifecycle"),
    );
    const readmeAfterLifecyclePack = readFileSync(readme);
    const backupExistsAfterLifecyclePack = existsSync(backup);

    outcome = {
      readmeInCopy,
      substitute,
      readmeAfterSubstitute,
      backupAfterSubstitute,
      npmReadmeAfterSubstitute,
      explicitPack,
      readmeAfterExplicitPack,
      backupExistsAfterExplicitPack,
      restore,
      readmeAfterRestore,
      backupExistsAfterRestore,
      redundantRestore,
      readmeAfterRedundantRestore,
      lifecyclePack,
      readmeAfterLifecyclePack,
      backupExistsAfterLifecyclePack,
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
}, 300_000);

afterAll(() => {
  if (workDir !== null) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe("Package_Prepack_Process の substitute → pack → 展開 → restore（要件9-8 / 9-9）", () => {
  it("複製したリポジトリの `README.md` は GitHub向け内容から始まる", () => {
    const { readmeInCopy } = requireOutcome();
    expect(
      readmeInCopy.equals(githubReadme),
      "複製直後の README.md がリポジトリの README.md と一致しない（複製処理の不具合）",
    ).toBe(true);
    // 前提として GitHub向けと npm向けは異なる内容である（差し替えの有無が観測可能であること）。
    expect(
      githubReadme.equals(npmReadme),
      "README.md と NPM.md が同一内容であるため差し替えの有無を観測できない",
    ).toBe(false);
  });

  it("`substitute` は README.md を NPM.md へ差し替え、GitHub向け内容を退避する（要件9-8）", () => {
    const { substitute, readmeAfterSubstitute, backupAfterSubstitute } =
      requireOutcome();

    expect(substitute.exitCode, `stderr: ${substitute.stderr}`).toBe(0);
    // ログは標準エラー出力のみ（`npm pack --json` の標準出力を汚さない）。
    expect(substitute.stdout).toBe("");
    expect(
      readmeAfterSubstitute.equals(npmReadme),
      "substitute 後の README.md が NPM.md とバイト一致しない",
    ).toBe(true);
    expect(
      backupAfterSubstitute,
      "退避ファイル `.readme-github.bak` が作られていない",
    ).not.toBeNull();
    expect(
      (backupAfterSubstitute as Buffer).equals(githubReadme),
      "退避ファイルの内容が GitHub向け README.md と一致しない",
    ).toBe(true);
  });

  it("差し替え元の `NPM.md` は変更されない", () => {
    const { npmReadmeAfterSubstitute } = requireOutcome();
    expect(npmReadmeAfterSubstitute.equals(npmReadme)).toBe(true);
  });

  it("展開した tarball の `README.md` が `NPM.md` とバイト一致する（要件9-8）", () => {
    const { explicitPack } = requireOutcome();
    const extractedReadme = readFileSync(
      join(explicitPack.extractedDir, "README.md"),
    );

    expect(
      extractedReadme.equals(npmReadme),
      "展開した README.md が NPM.md とバイト一致しない",
    ).toBe(true);
    expect(
      extractedReadme.equals(githubReadme),
      "展開した README.md が GitHub向け README.md と同一である（差し替えが収録に反映されていない）",
    ).toBe(false);
    // `--json` の files[].size でも同じ結論になることを確認する。
    const readmeEntry = explicitPack.report.files.find(
      (file) => file.path === "README.md",
    );
    expect(readmeEntry?.size).toBe(npmReadme.length);
  });

  it("tarball に `NPM.md` と退避ファイルは収録されない", () => {
    const { explicitPack } = requireOutcome();
    const paths = [...explicitPack.entries.keys()].sort();

    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
    expect(paths).not.toContain("NPM.md");
    expect(
      paths,
      "退避ファイルが収録されている（pack 時に作業ツリーへ存在していても収録対象外であること）",
    ).not.toContain(".readme-github.bak");
    expect(paths.filter((path) => path.endsWith(".tgz"))).toEqual([]);
  });

  it("`--ignore-scripts` 付きの pack は作業ツリーを差し替えたままにする", () => {
    const { readmeAfterExplicitPack, backupExistsAfterExplicitPack } =
      requireOutcome();
    // `--ignore-scripts` により postpack が走らないため、この時点では差し替え状態が続く。
    // ここが崩れる場合、後続の `restore` 単独検証が「既に復元済み」を見てしまい主張が空になる。
    expect(
      readmeAfterExplicitPack.equals(npmReadme),
      "`npm pack --ignore-scripts` の後に README.md が差し替え状態でない（ライフサイクルが走った可能性）",
    ).toBe(true);
    expect(backupExistsAfterExplicitPack).toBe(true);
  });

  it("`restore` は作業ツリーを GitHub向け内容へ戻し、退避ファイルを削除する（要件9-9）", () => {
    const { restore, readmeAfterRestore, backupExistsAfterRestore } =
      requireOutcome();

    expect(restore.exitCode, `stderr: ${restore.stderr}`).toBe(0);
    expect(restore.stdout).toBe("");
    expect(
      readmeAfterRestore.equals(githubReadme),
      "restore 後の README.md が GitHub向け内容へ戻っていない",
    ).toBe(true);
    expect(
      backupExistsAfterRestore,
      "退避ファイル `.readme-github.bak` が残っている",
    ).toBe(false);
  });

  it("退避ファイルが無い状態の `restore` は正常終了し作業ツリーを変えない（冪等）", () => {
    const { redundantRestore, readmeAfterRedundantRestore } = requireOutcome();

    expect(redundantRestore.exitCode, `stderr: ${redundantRestore.stderr}`).toBe(
      0,
    );
    expect(redundantRestore.stdout).toBe("");
    expect(readmeAfterRedundantRestore.equals(githubReadme)).toBe(true);
  });

  it("ライフサイクル経由の pack も同一内容の `README.md` を収録し、作業ツリーを復元する（要件9-8 / 9-9）", () => {
    const {
      explicitPack,
      lifecyclePack,
      readmeAfterLifecyclePack,
      backupExistsAfterLifecyclePack,
    } = requireOutcome();

    const lifecycleReadme = readFileSync(
      join(lifecyclePack.extractedDir, "README.md"),
    );
    const explicitReadme = readFileSync(
      join(explicitPack.extractedDir, "README.md"),
    );

    expect(
      lifecycleReadme.equals(npmReadme),
      "prepack 経由で生成した tarball の README.md が NPM.md とバイト一致しない",
    ).toBe(true);
    expect(
      lifecycleReadme.equals(explicitReadme),
      "明示実行とライフサイクル経由で収録される README.md が異なる",
    ).toBe(true);
    expect(
      readmeAfterLifecyclePack.equals(githubReadme),
      "postpack 実行後の README.md が GitHub向け内容へ復元されていない",
    ).toBe(true);
    expect(
      backupExistsAfterLifecyclePack,
      "postpack 実行後に退避ファイル `.readme-github.bak` が残っている",
    ).toBe(false);
  });

  it("リポジトリの作業ツリーは一切変更されていない", () => {
    // 本テストは複製側のみを操作するため、実リポジトリは変更されない。
    expect(
      readFileSync(join(repositoryRoot, "README.md")).equals(githubReadme),
      "リポジトリの README.md が変更されている",
    ).toBe(true);
    expect(
      readFileSync(join(repositoryRoot, "NPM.md")).equals(npmReadme),
    ).toBe(true);
    expect(existsSync(join(repositoryRoot, ".readme-github.bak"))).toBe(false);
  });
});

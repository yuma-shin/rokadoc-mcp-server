/**
 * Package_Prepack_Process（`scripts/pack-readme.mjs`）のプロパティベーステスト。
 *
 * Feature: npm-package-distribution, Property 4: Package_Prepack_Processは差し替えと復元の両方の事後条件を常に満たす
 *
 * > _任意の_ 2つのテキスト内容（GitHub向けREADME内容 G と NPM_Readme内容 N、G ≠ N を含む）と、
 * > _任意の_ `substitute` / `restore` / 失敗注入付き `substitute` の操作列に対して、最後に
 * > `restore` を1回適用した後、作業ツリーの `README.md` の内容は常に G と一致する。かつ、操作列の
 * > 途中で `substitute` が成功した任意の時点において `README.md` の内容は N と一致する。
 * > `substitute` の連続適用は退避内容を破壊しない（冪等）。
 *
 * **Validates: Requirements 9.8, 9.9**
 *
 * 検証方法について:
 *
 * - 対象はCLIスクリプトであるため、`process.execPath` で実プロセスとして起動し、終了コードと
 *   ファイルシステムの状態を観測する。パスは `--readme` / `--npm-readme` / `--backup` で注入する。
 * - 作業ディレクトリは `mkdtempSync(os.tmpdir())` 配下に作る。リポジトリ直下に一時ファイルを
 *   置くと `npm pack` の収録件数テスト（prerequisites.md タスク1.2）を汚すため。
 * - 内容の比較はすべて Buffer 同士のバイト比較で行う。要件9.8が求めるのは「NPM_Readmeと同一内容の
 *   `README.md`」であり、改行変換や文字コード変換が挟まっていないことまで含めて主張する必要がある。
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリルートの絶対パス（`tests/property/` から2階層上）。 */
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 被テスト対象スクリプトの絶対パス。 */
const SCRIPT_PATH = resolve(REPOSITORY_ROOT, "scripts", "pack-readme.mjs");

/** 一時作業ディレクトリの集合。異常終了時にも後始末できるよう保持する。 */
const createdDirectories = new Set<string>();

afterAll(() => {
  for (const directory of createdDirectories) {
    // 読み取り専用属性が残っていると削除に失敗し得るため、書き込み可へ戻してから消す。
    const readme = join(directory, "README.md");
    if (existsSync(readme)) {
      try {
        chmodSync(readme, 0o666);
      } catch {
        // 後始末の失敗はテスト結果に影響させない。
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  createdDirectories.clear();
});

/** 一時作業ディレクトリ上のパス一覧。 */
interface Workspace {
  /** 一時作業ディレクトリ。 */
  readonly directory: string;
  /** 差し替え・復元の対象（GitHub向け `README.md` 相当）。 */
  readonly readme: string;
  /** 差し替え元（`NPM.md` 相当）。 */
  readonly npmReadme: string;
  /** 退避ファイル（`.readme-github.bak` 相当）。 */
  readonly backup: string;
  /** 存在しない `NPM.md` のパス（失敗注入用）。 */
  readonly absentNpmReadme: string;
  /** 通常ファイルではない退避先のパス（失敗注入用）。 */
  readonly backupDirectory: string;
  /** 親ディレクトリが存在しない `README.md` のパス（失敗注入用）。 */
  readonly unreachableReadme: string;
}

/**
 * 一時作業ディレクトリを作り、`README.md` と `NPM.md` を配置する。
 *
 * @param githubReadme GitHub向け `README.md` の内容
 * @param npmReadme NPM_Readme の内容
 * @returns 作成した作業ディレクトリのパス一覧
 */
function createWorkspace(githubReadme: Buffer, npmReadme: Buffer): Workspace {
  const directory = mkdtempSync(join(tmpdir(), "rokadoc-pack-readme-"));
  createdDirectories.add(directory);

  const workspace: Workspace = {
    directory,
    readme: join(directory, "README.md"),
    npmReadme: join(directory, "NPM.md"),
    backup: join(directory, ".readme-github.bak"),
    absentNpmReadme: join(directory, "absent-NPM.md"),
    backupDirectory: join(directory, "backup-as-directory"),
    unreachableReadme: join(directory, "absent-directory", "README.md"),
  };

  writeFileSync(workspace.readme, githubReadme);
  writeFileSync(workspace.npmReadme, npmReadme);
  mkdirSync(workspace.backupDirectory);

  return workspace;
}

/**
 * 一時作業ディレクトリを削除する。
 *
 * @param workspace 削除対象
 * @returns なし
 */
function removeWorkspace(workspace: Workspace): void {
  if (existsSync(workspace.readme)) {
    try {
      chmodSync(workspace.readme, 0o666);
    } catch {
      // 後始末の失敗はテスト結果に影響させない。
    }
  }
  rmSync(workspace.directory, { recursive: true, force: true });
  createdDirectories.delete(workspace.directory);
}

/** スクリプトの実行結果。 */
interface RunResult {
  /** 終了コード。 */
  readonly exitCode: number | null;
  /** 標準出力（常に空であるべき）。 */
  readonly stdout: string;
  /** 標準エラー出力。 */
  readonly stderr: string;
}

/**
 * オプションを `--name value` 形式と `--name=value` 形式のいずれかへ整形する。
 *
 * 両形式が等価に扱われることを操作列の生成に織り込むため、形式も生成対象とする。
 *
 * @param useEqualsForm `--name=value` 形式を使う場合 `true`
 * @param options オプション名と値の組
 * @returns `spawnSync` へ渡す引数配列
 */
function formatOptions(
  useEqualsForm: boolean,
  options: readonly (readonly [string, string])[],
): string[] {
  return options.flatMap(([name, value]) =>
    useEqualsForm ? [`${name}=${value}`] : [name, value],
  );
}

/**
 * `scripts/pack-readme.mjs` を実プロセスとして実行する。
 *
 * @param workspace 作業ディレクトリ（`cwd` として使う）
 * @param args サブコマンドとオプション
 * @returns 終了コードと標準出力・標準エラー出力
 */
function runPackReadme(workspace: Workspace, args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: workspace.directory,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** 操作列を構成する1操作。`fail:` で始まる種別は失敗注入付き `substitute` を表す。 */
type Operation =
  | { readonly kind: "substitute"; readonly useEqualsForm: boolean }
  | { readonly kind: "restore"; readonly useEqualsForm: boolean }
  /** `NPM.md` 不在（要件9.10の経路）。作業ツリーへ触れる前に失敗する。 */
  | { readonly kind: "fail:npm-readme-absent" }
  /** 退避先が通常ファイルではない。退避の直前で失敗する。 */
  | { readonly kind: "fail:backup-not-a-file" }
  /** 対象 `README.md` の親ディレクトリが存在しない（ENOENT）。 */
  | { readonly kind: "fail:readme-unreachable" }
  /** 複写そのものが失敗する（design.md 4層の復元保証の層3）。 */
  | { readonly kind: "fail:copy-blocked" };

/**
 * `substitute` を実行する。
 *
 * @param workspace 作業ディレクトリ
 * @param useEqualsForm `--name=value` 形式を使う場合 `true`
 * @param overrides 差し替えるパス（失敗注入用）
 * @returns 実行結果
 */
function runSubstitute(
  workspace: Workspace,
  useEqualsForm: boolean,
  overrides: { readme?: string; npmReadme?: string; backup?: string } = {},
): RunResult {
  return runPackReadme(workspace, [
    "substitute",
    ...formatOptions(useEqualsForm, [
      ["--readme", overrides.readme ?? workspace.readme],
      ["--npm-readme", overrides.npmReadme ?? workspace.npmReadme],
      ["--backup", overrides.backup ?? workspace.backup],
    ]),
  ]);
}

/**
 * `restore` を実行する。
 *
 * @param workspace 作業ディレクトリ
 * @param useEqualsForm `--name=value` 形式を使う場合 `true`
 * @returns 実行結果
 */
function runRestore(workspace: Workspace, useEqualsForm: boolean): RunResult {
  return runPackReadme(workspace, [
    "restore",
    ...formatOptions(useEqualsForm, [
      ["--readme", workspace.readme],
      ["--backup", workspace.backup],
    ]),
  ]);
}

/**
 * 1操作を適用する。
 *
 * 失敗注入のうち `fail:copy-blocked` は対象 `README.md` を読み取り専用にして複写を失敗させる。
 * 注入の副作用（属性変更）は操作の完了時に必ず戻す。
 *
 * @param workspace 作業ディレクトリ
 * @param operation 適用する操作
 * @returns 実行結果
 */
function applyOperation(workspace: Workspace, operation: Operation): RunResult {
  switch (operation.kind) {
    case "substitute":
      return runSubstitute(workspace, operation.useEqualsForm);
    case "restore":
      return runRestore(workspace, operation.useEqualsForm);
    case "fail:npm-readme-absent":
      return runSubstitute(workspace, false, {
        npmReadme: workspace.absentNpmReadme,
      });
    case "fail:backup-not-a-file":
      return runSubstitute(workspace, false, {
        backup: workspace.backupDirectory,
      });
    case "fail:readme-unreachable":
      return runSubstitute(workspace, false, {
        readme: workspace.unreachableReadme,
      });
    case "fail:copy-blocked":
      chmodSync(workspace.readme, 0o444);
      try {
        return runSubstitute(workspace, false);
      } finally {
        chmodSync(workspace.readme, 0o666);
      }
  }
}

/**
 * `fail:copy-blocked` の注入手法が当該環境で実際に失敗を起こすか確認する。
 *
 * 読み取り専用属性による書き込み禁止はWindowsでは `EPERM` を、POSIXでは `EACCES` を生じるが、
 * root で実行した場合は書き込みが成功してしまう。注入が効かない環境で偽の主張を立てないよう、
 * モジュール読み込み時に一度だけ実測して判定する。
 *
 * @returns 注入により非ゼロ終了する場合 `true`
 */
function detectCopyBlockInjection(): boolean {
  const workspace = createWorkspace(
    Buffer.from("github\n", "utf8"),
    Buffer.from("npm\n", "utf8"),
  );
  try {
    const result = applyOperation(workspace, { kind: "fail:copy-blocked" });
    return result.exitCode !== 0 && readFileSync(workspace.readme).equals(Buffer.from("github\n", "utf8"));
  } finally {
    removeWorkspace(workspace);
  }
}

/** 複写失敗の注入が有効な環境か。 */
const COPY_BLOCK_INJECTION_WORKS = detectCopyBlockInjection();

/**
 * ファイルをバイト列として読む。
 *
 * @param path 対象パス
 * @returns 内容
 */
function readBytes(path: string): Buffer {
  return readFileSync(path);
}

/**
 * バイト列の一致を主張する。差分の判別を可能にするため16進表現で比較する。
 *
 * @param actual 実際の内容
 * @param expected 期待する内容
 * @returns なし
 */
function expectSameBytes(actual: Buffer, expected: Buffer): void {
  expect(actual.toString("hex")).toBe(expected.toString("hex"));
}

/** 素朴なテキスト処理では壊れやすい行の候補。 */
const LINE_CANDIDATES = [
  "# rokadoc MCP Server",
  "npm配布向けの説明（日本語・全角スペース　を含む）",
  "\tタブ始まりの行",
  "",
  "絵文字 🚀 とサロゲートペア 𠮷",
  "`NPM.md` / `README.md` / .readme-github.bak",
  "末尾に空白が続く行   ",
  "非ASCIIバイト: Ã©Â£ ÎÎ² ÐÐ±",
];

/** 改行の種別（CRLF / LF）。 */
const eolArbitrary: fc.Arbitrary<string> = fc.constantFrom("\n", "\r\n");

/**
 * README / NPM_Readme の内容。空ファイル、CRLF/LF、末尾改行の有無、
 * UTF-8として妥当でない任意バイト列（BOM付きを含む）を含む。
 */
const contentArbitrary: fc.Arbitrary<Buffer> = fc.oneof(
  // 空ファイル（境界値）
  { weight: 1, arbitrary: fc.constant(Buffer.alloc(0)) },
  // 現実的なMarkdown断片。改行種別と末尾改行の有無を揺らがせる
  {
    weight: 4,
    arbitrary: fc
      .tuple(
        fc.array(
          fc.oneof(
            fc.constantFrom(...LINE_CANDIDATES),
            fc.string({ maxLength: 24 }),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        eolArbitrary,
        fc.boolean(),
        fc.boolean(),
      )
      .map(([lines, eol, hasTrailingEol, hasBom]) =>
        Buffer.concat([
          hasBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
          Buffer.from(lines.join(eol) + (hasTrailingEol ? eol : ""), "utf8"),
        ]),
      ),
  },
  // 任意バイト列（NULバイトや不正なUTF-8列を含む）
  {
    weight: 2,
    arbitrary: fc.uint8Array({ maxLength: 64 }).map((bytes) => Buffer.from(bytes)),
  },
);

/**
 * GitHub向け内容 G と NPM_Readme内容 N の組。プロパティ本文が要求する G ≠ N を保証する
 * （G = N では「差し替わった」ことが観測できず主張が空になるため）。
 */
const distinctContentsArbitrary: fc.Arbitrary<readonly [Buffer, Buffer]> = fc
  .tuple(contentArbitrary, contentArbitrary)
  .filter(([github, npmReadme]) => !github.equals(npmReadme));

/** 成功する操作（`substitute` / `restore`）。 */
const successOperationArbitrary: fc.Arbitrary<Operation> = fc
  .tuple(fc.constantFrom("substitute" as const, "restore" as const), fc.boolean())
  .map(([kind, useEqualsForm]): Operation => ({ kind, useEqualsForm }));

/** 失敗注入付き `substitute`。当該環境で実際に失敗する手法のみを含める。 */
const failureOperationArbitrary: fc.Arbitrary<Operation> = fc.constantFrom(
  ...([
    { kind: "fail:npm-readme-absent" },
    { kind: "fail:backup-not-a-file" },
    { kind: "fail:readme-unreachable" },
    ...(COPY_BLOCK_INJECTION_WORKS
      ? [{ kind: "fail:copy-blocked" } as const]
      : []),
  ] as const satisfies readonly Operation[]),
);

/**
 * 操作列の1要素。プロセス起動を伴うため、成功操作を多めに引いて列を短く保つ。
 */
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 3, arbitrary: successOperationArbitrary },
  { weight: 2, arbitrary: failureOperationArbitrary },
);

describe("Feature: npm-package-distribution, Property 4: Package_Prepack_Processは差し替えと復元の両方の事後条件を常に満たす", () => {
  it(
    "`substitute` 後の README.md は NPM.md とバイト一致し、退避ファイルは元の内容を保持する",
    () => {
      fc.assert(
        fc.property(
          distinctContentsArbitrary,
          fc.boolean(),
          ([github, npmReadme], useEqualsForm) => {
            const workspace = createWorkspace(github, npmReadme);
            try {
              const result = runSubstitute(workspace, useEqualsForm);

              expect(result.exitCode).toBe(0);
              expect(result.stdout).toBe("");
              expectSameBytes(readBytes(workspace.readme), npmReadme);
              expect(existsSync(workspace.backup)).toBe(true);
              expectSameBytes(readBytes(workspace.backup), github);
              // 差し替え元は変更されない
              expectSameBytes(readBytes(workspace.npmReadme), npmReadme);
            } finally {
              removeWorkspace(workspace);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    240_000,
  );

  it(
    "`substitute` → `restore` で README.md は元のバイト列へ戻り退避ファイルは削除される",
    () => {
      fc.assert(
        fc.property(
          distinctContentsArbitrary,
          fc.boolean(),
          fc.boolean(),
          ([github, npmReadme], substituteForm, restoreForm) => {
            const workspace = createWorkspace(github, npmReadme);
            try {
              expect(runSubstitute(workspace, substituteForm).exitCode).toBe(0);

              const result = runRestore(workspace, restoreForm);

              expect(result.exitCode).toBe(0);
              expect(result.stdout).toBe("");
              expectSameBytes(readBytes(workspace.readme), github);
              expect(existsSync(workspace.backup)).toBe(false);
            } finally {
              removeWorkspace(workspace);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    240_000,
  );

  it(
    "退避ファイルが無い `restore` は終了コード0で作業ツリーを変更しない（冪等）",
    () => {
      fc.assert(
        fc.property(
          distinctContentsArbitrary,
          fc.integer({ min: 1, max: 3 }),
          ([github, npmReadme], repetitions) => {
            const workspace = createWorkspace(github, npmReadme);
            try {
              for (let attempt = 0; attempt < repetitions; attempt += 1) {
                const result = runRestore(workspace, attempt % 2 === 0);

                expect(result.exitCode).toBe(0);
                expect(result.stdout).toBe("");
                expectSameBytes(readBytes(workspace.readme), github);
                expect(existsSync(workspace.backup)).toBe(false);
              }
            } finally {
              removeWorkspace(workspace);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    240_000,
  );

  it(
    "`substitute` の連続適用は退避内容を破壊せず、その後の `restore` で元の内容へ戻る",
    () => {
      fc.assert(
        fc.property(
          distinctContentsArbitrary,
          fc.integer({ min: 2, max: 3 }),
          ([github, npmReadme], substitutions) => {
            const workspace = createWorkspace(github, npmReadme);
            try {
              for (let attempt = 0; attempt < substitutions; attempt += 1) {
                const result = runSubstitute(workspace, attempt % 2 === 0);

                expect(result.exitCode).toBe(0);
                expect(result.stdout).toBe("");
                expectSameBytes(readBytes(workspace.readme), npmReadme);
                // 2回目以降も退避内容はGitHub向け内容のまま（上書きしない）
                expectSameBytes(readBytes(workspace.backup), github);
              }

              expect(runRestore(workspace, false).exitCode).toBe(0);
              expectSameBytes(readBytes(workspace.readme), github);
              expect(existsSync(workspace.backup)).toBe(false);
            } finally {
              removeWorkspace(workspace);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    240_000,
  );

  it(
    "NPM.md 不在の `substitute` は非ゼロ終了し、README.md と退避ファイルを変更しない",
    () => {
      fc.assert(
        fc.property(
          distinctContentsArbitrary,
          ([github, npmReadme]) => {
            const workspace = createWorkspace(github, npmReadme);
            try {
              const result = applyOperation(workspace, {
                kind: "fail:npm-readme-absent",
              });

              expect(result.exitCode).not.toBe(0);
              expect(result.stdout).toBe("");
              expectSameBytes(readBytes(workspace.readme), github);
              expect(existsSync(workspace.backup)).toBe(false);
            } finally {
              removeWorkspace(workspace);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    240_000,
  );

  it.skipIf(!COPY_BLOCK_INJECTION_WORKS)(
    "複写が失敗する `substitute` は README.md の内容を保ったまま非ゼロ終了する",
    () => {
      fc.assert(
        fc.property(
          distinctContentsArbitrary,
          fc.boolean(),
          ([github, npmReadme], substituteFirst) => {
            const workspace = createWorkspace(github, npmReadme);
            try {
              // 退避ファイルが既にある場合（差し替え済み）と無い場合の双方を通す
              if (substituteFirst) {
                expect(runSubstitute(workspace, false).exitCode).toBe(0);
              }
              const before = readBytes(workspace.readme);

              const result = applyOperation(workspace, {
                kind: "fail:copy-blocked",
              });

              expect(result.exitCode).not.toBe(0);
              expect(result.stdout).toBe("");
              expectSameBytes(readBytes(workspace.readme), before);
              // 退避ファイルが作られた場合、その内容はGitHub向け内容である
              if (existsSync(workspace.backup)) {
                expectSameBytes(readBytes(workspace.backup), github);
              }

              // 最後の restore で必ず元へ戻る
              expect(runRestore(workspace, false).exitCode).toBe(0);
              expectSameBytes(readBytes(workspace.readme), github);
            } finally {
              removeWorkspace(workspace);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    240_000,
  );

  it(
    "任意の操作列の後に `restore` を1回適用すると README.md は常に元のバイト列へ戻る",
    () => {
      fc.assert(
        fc.property(
          distinctContentsArbitrary,
          fc.array(operationArbitrary, { minLength: 1, maxLength: 4 }),
          fc.boolean(),
          ([github, npmReadme], operations, finalRestoreForm) => {
            const workspace = createWorkspace(github, npmReadme);
            try {
              for (const operation of operations) {
                const before = readBytes(workspace.readme);
                const result = applyOperation(workspace, operation);

                // ログは常に標準エラー出力のみ（`npm pack --json` の標準出力を汚さない）
                expect(result.stdout).toBe("");

                if (operation.kind === "substitute") {
                  expect(result.exitCode).toBe(0);
                  // 成功した任意の時点で README.md は NPM_Readme と一致する
                  expectSameBytes(readBytes(workspace.readme), npmReadme);
                  expect(existsSync(workspace.backup)).toBe(true);
                  expectSameBytes(readBytes(workspace.backup), github);
                } else if (operation.kind === "restore") {
                  expect(result.exitCode).toBe(0);
                  expectSameBytes(readBytes(workspace.readme), github);
                  expect(existsSync(workspace.backup)).toBe(false);
                } else {
                  // 失敗注入は非ゼロ終了し、README.md の内容を変えない
                  expect(result.exitCode).not.toBe(0);
                  expectSameBytes(readBytes(workspace.readme), before);
                  if (existsSync(workspace.backup)) {
                    expectSameBytes(readBytes(workspace.backup), github);
                  }
                }
              }

              const finalRestore = runRestore(workspace, finalRestoreForm);

              expect(finalRestore.exitCode).toBe(0);
              expect(finalRestore.stdout).toBe("");
              expectSameBytes(readBytes(workspace.readme), github);
              expect(existsSync(workspace.backup)).toBe(false);
              // 差し替え元は一貫して変更されない
              expectSameBytes(readBytes(workspace.npmReadme), npmReadme);
            } finally {
              removeWorkspace(workspace);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    600_000,
  );
});

#!/usr/bin/env node
/**
 * Package_Prepack_Process: Package_Tarball 収録用に `README.md` を `NPM.md`
 * （NPM_Readme）の内容へ差し替え、tarball 生成後に元の内容へ復元する（要件9.8 / 9.9 / 9.10）。
 *
 * 使い方:
 *
 * ```
 * node scripts/pack-readme.mjs substitute [オプション]   # prepack から呼ぶ
 * node scripts/pack-readme.mjs restore    [オプション]   # postpack から呼ぶ
 * ```
 *
 * オプション（いずれも `--name <path>` と `--name=<path>` の両形式を受け付ける。
 * 相対パスは呼び出し時のカレントディレクトリを基準に解決する）:
 *
 * | オプション            | 既定値                  | 用途                             |
 * | --------------------- | ----------------------- | -------------------------------- |
 * | `--readme <path>`     | `<repoRoot>/README.md`  | 差し替え・復元の対象             |
 * | `--npm-readme <path>` | `<repoRoot>/NPM.md`     | 差し替え元（NPM_Readme）         |
 * | `--backup <path>`     | `<repoRoot>/.readme-github.bak` | 退避ファイル             |
 *
 * `substitute` の手順:
 *
 * 1. `NPM.md` の存在を確認する。不在なら**何も変更せず**非ゼロ終了し、tarball を作らせない
 *    （要件9.10）。エラーメッセージには「`NPM.md` が必要である」旨を含める。git依存
 *    インストール時（npm は git URL 経由のインストールでも `prepack` を実行する）に
 *    失敗した際の原因追跡を可能にするため。
 * 2. `README.md` を退避ファイルへコピーする。**既存の退避ファイルは上書きしない。**
 *    これが `prepack` の二重実行（および `postpack` 失敗後の再実行）を安全にする
 *    （design.md「4層の復元保証」の層2）。
 * 3. `NPM.md` の内容を `README.md` へ複写する。複写に失敗した場合は退避ファイルから
 *    即復元してから非ゼロ終了する（層3）。
 *
 * `restore` の手順: 退避ファイルの内容を `README.md` へ書き戻し、退避ファイルを削除する。
 * 退避ファイルが無い場合も終了コード0で正常終了する（冪等。層1）。
 *
 * 制約:
 * - **Node.js組込みモジュール（`node:fs` / `node:path` / `node:url`）のみに依存する。**
 *   `prepack` は devDependencies が未インストールの環境（git依存インストール時など）でも
 *   動作しなければならない。
 * - 既定パスは `process.cwd()` ではなく**本ファイル自身の位置**（`import.meta.url`）から
 *   導出する。npm がどのディレクトリからスクリプトを起動しても同じファイルを指すため。
 * - ファイルは Buffer として読み書きする。文字コード変換・改行変換を挟まないことで、
 *   tarball の `README.md` が `NPM.md` とバイト単位で一致することを保証する（要件9.8）。
 * - ログは標準エラー出力へ出す。`npm pack --json` などの標準出力を汚さないため
 *   （prerequisites.md タスク1.2 の方針）。
 *
 * 終了コード: 0 = 正常終了 / 1 = 実行時の失敗（`NPM.md` 不在・I/Oエラー）/
 * 2 = 引数の誤り（未知のサブコマンド・未知のオプション・値の欠落）。
 *
 * @module scripts/pack-readme
 */

import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 本ファイルの絶対パス（`<repoRoot>/scripts/pack-readme.mjs`）。
 *
 * @type {string}
 */
const scriptPath = fileURLToPath(import.meta.url);

/**
 * リポジトリルートの絶対パス。`process.cwd()` に依存しない。
 *
 * @type {string}
 */
const repositoryRoot = resolve(dirname(scriptPath), "..");

/**
 * 対象パスの既定値（リポジトリルート基準）。
 *
 * @type {{ readme: string, npmReadme: string, backup: string }}
 */
const DEFAULT_PATHS = {
  readme: resolve(repositoryRoot, "README.md"),
  npmReadme: resolve(repositoryRoot, "NPM.md"),
  backup: resolve(repositoryRoot, ".readme-github.bak"),
};

/**
 * 使い方の説明（標準エラー出力へ出す）。
 *
 * @type {string}
 */
const USAGE = [
  "使い方: node scripts/pack-readme.mjs <substitute|restore> [オプション]",
  "",
  "  substitute  README.md を退避してから NPM.md の内容へ差し替える（prepack）",
  "  restore     退避ファイルから README.md を復元する（postpack。冪等）",
  "",
  "オプション（既定値はリポジトリルート基準）:",
  "  --readme <path>      差し替え・復元の対象（既定: README.md）",
  "  --npm-readme <path>  差し替え元の NPM_Readme（既定: NPM.md）",
  "  --backup <path>      退避ファイル（既定: .readme-github.bak）",
].join("\n");

/**
 * ログ1行を標準エラー出力へ書く。
 *
 * @param {string} message 出力するメッセージ
 * @returns {void}
 */
function log(message) {
  process.stderr.write(`pack-readme: ${message}\n`);
}

/**
 * 例外をログ用の1行文字列へ変換する。
 *
 * @param {unknown} error 発生した例外
 * @returns {string} ログに含める説明
 */
function describeError(error) {
  if (error instanceof Error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

/**
 * 例外が「対象が存在しない」ことを示すか判定する。
 *
 * @param {unknown} error 発生した例外
 * @returns {boolean} `ENOENT` の場合 `true`
 */
function isNotFound(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    /** @type {{ code?: string }} */ (error).code === "ENOENT"
  );
}

/**
 * 通常ファイルとして存在するか判定する。
 *
 * ディレクトリやシンボリックリンクは「存在しない」とは区別し、判定不能として扱わずに
 * `false` を返す（呼び出し側が想定外の状態としてエラーにできるようにするため、
 * 存在確認とは別に種別も返す）。
 *
 * @param {string} path 判定対象の絶対パス
 * @returns {{ exists: boolean, isFile: boolean }} 存在有無と通常ファイルか否か
 */
function inspectFile(path) {
  try {
    const stats = lstatSync(path);
    return { exists: true, isFile: stats.isFile() };
  } catch (error) {
    if (isNotFound(error)) {
      return { exists: false, isFile: false };
    }
    throw error;
  }
}

/**
 * コマンドライン引数を解析する。
 *
 * @param {readonly string[]} argv `process.argv.slice(2)` に相当する配列
 * @returns {{ ok: true, command: "substitute" | "restore", paths: { readme: string, npmReadme: string, backup: string } } | { ok: false, message: string }}
 *   解析結果。失敗時は理由を `message` に含める
 */
function parseArguments(argv) {
  if (argv.length === 0) {
    return { ok: false, message: "サブコマンドが指定されていません。" };
  }

  const [command, ...rest] = argv;
  if (command !== "substitute" && command !== "restore") {
    return {
      ok: false,
      message: `未知のサブコマンドです: ${command}（substitute または restore を指定してください）`,
    };
  }

  /** @type {{ readme: string, npmReadme: string, backup: string }} */
  const paths = { ...DEFAULT_PATHS };
  /** @type {Record<string, "readme" | "npmReadme" | "backup">} */
  const optionKeys = {
    "--readme": "readme",
    "--npm-readme": "npmReadme",
    "--backup": "backup",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const separatorIndex = argument.indexOf("=");
    const name =
      separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
    const key = optionKeys[name];

    if (key === undefined) {
      return { ok: false, message: `未知のオプションです: ${argument}` };
    }

    /** @type {string | undefined} */
    let value;
    if (separatorIndex === -1) {
      index += 1;
      value = rest[index];
    } else {
      value = argument.slice(separatorIndex + 1);
    }

    if (value === undefined || value === "") {
      return { ok: false, message: `${name} の値が指定されていません。` };
    }

    // 相対パスは呼び出し時のカレントディレクトリ基準で解決する（テストからの注入用）。
    paths[key] = resolve(value);
  }

  return { ok: true, command, paths };
}

/**
 * `substitute`: `README.md` を退避してから `NPM.md` の内容へ差し替える。
 *
 * @param {{ readme: string, npmReadme: string, backup: string }} paths 対象パス
 * @returns {number} 終了コード（0: 正常終了 / 1: 失敗）
 */
function substitute(paths) {
  // 1. NPM_Readme の存在確認。ここを通過するまで作業ツリーを一切変更しない（要件9.10）。
  /** @type {{ exists: boolean, isFile: boolean }} */
  let npmReadmeState;
  try {
    npmReadmeState = inspectFile(paths.npmReadme);
  } catch (error) {
    log(
      `NPM.md の状態を取得できませんでした: ${paths.npmReadme} (${describeError(error)})`,
    );
    return 1;
  }

  if (!npmReadmeState.exists || !npmReadmeState.isFile) {
    log(
      `npm配布向けREADME（NPM.md）が見つかりません: ${paths.npmReadme}。` +
        "Package_Tarball の README.md には NPM.md の内容を収録するため、" +
        "`NPM.md` が必要である。リポジトリルートに NPM.md を作成してから再実行してください。",
    );
    return 1;
  }

  /** @type {Buffer} 差し替え元の内容。改行変換を避けるため Buffer のまま扱う。 */
  let npmReadmeContent;
  try {
    npmReadmeContent = readFileSync(paths.npmReadme);
  } catch (error) {
    log(
      `NPM.md を読み取れませんでした: ${paths.npmReadme} (${describeError(error)})`,
    );
    return 1;
  }

  // 2. 退避。既存の退避ファイルは上書きしない（prepack の二重実行を安全にする）。
  /** @type {{ exists: boolean, isFile: boolean }} */
  let backupState;
  try {
    backupState = inspectFile(paths.backup);
  } catch (error) {
    log(
      `退避ファイルの状態を取得できませんでした: ${paths.backup} (${describeError(error)})`,
    );
    return 1;
  }

  if (backupState.exists && !backupState.isFile) {
    log(
      `退避ファイルの位置が通常ファイルではありません: ${paths.backup}。手動で確認してください。`,
    );
    return 1;
  }

  if (backupState.exists) {
    log(
      `退避ファイルが既に存在するため退避を省略しました（GitHub向け README.md の内容を保持）: ${paths.backup}`,
    );
  } else {
    /** @type {Buffer} 退避する現在の README.md の内容。 */
    let currentReadme;
    try {
      currentReadme = readFileSync(paths.readme);
    } catch (error) {
      log(
        `README.md を読み取れませんでした: ${paths.readme} (${describeError(error)})`,
      );
      return 1;
    }

    try {
      // `wx` により、直前の存在確認との競合が起きても既存の退避ファイルを壊さない。
      writeFileSync(paths.backup, currentReadme, { flag: "wx" });
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        /** @type {{ code?: string }} */ (error).code === "EEXIST"
      ) {
        log(
          `退避ファイルが既に存在するため退避を省略しました: ${paths.backup}`,
        );
      } else {
        log(
          `README.md を退避できませんでした: ${paths.backup} (${describeError(error)})`,
        );
        return 1;
      }
    }
    log(`README.md を退避しました: ${paths.readme} -> ${paths.backup}`);
  }

  // 3. 複写。失敗したら退避ファイルから即復元してから非ゼロ終了する。
  try {
    writeFileSync(paths.readme, npmReadmeContent);
  } catch (error) {
    log(
      `README.md へ NPM.md の内容を複写できませんでした: ${paths.readme} (${describeError(error)})`,
    );
    rollbackFromBackup(paths);
    return 1;
  }

  log(
    `README.md を NPM.md の内容へ差し替えました: ${paths.npmReadme} -> ${paths.readme}（${npmReadmeContent.length} バイト）`,
  );
  return 0;
}

/**
 * 差し替え途中の失敗から復旧する。退避ファイルの内容を `README.md` へ書き戻す。
 *
 * 退避ファイルは**削除しない**。後続の `restore`（`postpack` またはワークフローの
 * 復元ステップ）が再度復元・削除できる状態を保ち、復旧処理自体が失敗した場合にも
 * GitHub向け内容の唯一の控えを失わないようにするためである。
 *
 * @param {{ readme: string, backup: string }} paths 対象パス
 * @returns {boolean} 復元できた場合 `true`
 */
function rollbackFromBackup(paths) {
  try {
    const backupContent = readFileSync(paths.backup);
    writeFileSync(paths.readme, backupContent);
  } catch (error) {
    log(
      `退避ファイルからの復元に失敗しました: ${paths.backup} -> ${paths.readme} (${describeError(error)})。` +
        `README.md の内容を手動で確認してください（退避ファイルは削除していません）。`,
    );
    return false;
  }
  log(
    `退避ファイルから README.md を復元しました（退避ファイルは保持）: ${paths.backup} -> ${paths.readme}`,
  );
  return true;
}

/**
 * `restore`: 退避ファイルから `README.md` を復元し、退避ファイルを削除する。
 *
 * 退避ファイルが存在しない場合は何もせず正常終了する（冪等）。
 *
 * @param {{ readme: string, backup: string }} paths 対象パス
 * @returns {number} 終了コード（0: 正常終了 / 1: 失敗）
 */
function restore(paths) {
  /** @type {{ exists: boolean, isFile: boolean }} */
  let backupState;
  try {
    backupState = inspectFile(paths.backup);
  } catch (error) {
    log(
      `退避ファイルの状態を取得できませんでした: ${paths.backup} (${describeError(error)})`,
    );
    return 1;
  }

  if (!backupState.exists) {
    // 冪等性: prepack が走っていない場合・既に復元済みの場合は正常終了とする。
    log(`退避ファイルが存在しません（復元不要）: ${paths.backup}`);
    return 0;
  }

  if (!backupState.isFile) {
    log(
      `退避ファイルの位置が通常ファイルではありません: ${paths.backup}。手動で確認してください。`,
    );
    return 1;
  }

  /** @type {Buffer} */
  let backupContent;
  try {
    backupContent = readFileSync(paths.backup);
  } catch (error) {
    log(
      `退避ファイルを読み取れませんでした: ${paths.backup} (${describeError(error)})`,
    );
    return 1;
  }

  try {
    writeFileSync(paths.readme, backupContent);
  } catch (error) {
    log(
      `README.md を復元できませんでした: ${paths.readme} (${describeError(error)})。` +
        "退避ファイルは削除していないため再実行で復元できます。",
    );
    return 1;
  }

  // 復元が完了してから退避ファイルを削除する。途中で中断されても再実行で同じ結果になる。
  try {
    unlinkSync(paths.backup);
  } catch (error) {
    if (!isNotFound(error)) {
      log(
        `README.md は復元しましたが退避ファイルを削除できませんでした: ${paths.backup} (${describeError(error)})`,
      );
      return 1;
    }
  }

  log(
    `README.md を復元し退避ファイルを削除しました: ${paths.backup} -> ${paths.readme}（${backupContent.length} バイト）`,
  );
  return 0;
}

/**
 * エントリーポイント。
 *
 * @returns {number} 終了コード（0: 正常終了 / 1: 実行時の失敗 / 2: 引数の誤り）
 */
function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    log(parsed.message);
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  return parsed.command === "substitute"
    ? substitute(parsed.paths)
    : restore(parsed.paths);
}

process.exit(main());

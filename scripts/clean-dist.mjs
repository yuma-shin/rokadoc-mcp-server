#!/usr/bin/env node
/**
 * `dist/`（Build_Artifact の出力先）を再帰削除する（要件2.2）。
 *
 * `package.json` の `prebuild` から呼び出し、ビルド前に出力先を空にすることで
 * Package_Tarball の収録集合が `src/` の構成から一意に決まることを担保する
 * （リネーム・削除されたモジュールの古い成果物が `dist/` に残り、孤児ファイルとして
 * tarball へ混入するのを防ぐ）。
 *
 * 制約:
 * - **Node.js組込みモジュールのみに依存し、外部依存を持たない**。`prepack` /
 *   `prebuild` は devDependencies が未インストールの環境（git依存インストール時など）
 *   でも動作しなければならない。
 * - 削除対象はリポジトリルート直下の `dist/` ただ1つに限る。対象パスは
 *   `process.cwd()` ではなく**本ファイル自身の位置**（`import.meta.url`）から導出する。
 *   npm がどのディレクトリからスクリプトを起動しても同じ場所を指すようにするため。
 * - ログは標準エラー出力へ出す。`npm pack --json` などの標準出力を汚さないため
 *   （prerequisites.md タスク1.2 の方針）。
 *
 * 冪等であり、`dist/` が存在しない場合も終了コード0で正常終了する。
 *
 * @module scripts/clean-dist
 */

import { lstatSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 削除対象のディレクトリ名（リポジトリルート直下）。
 *
 * @type {string}
 */
const TARGET_DIRECTORY_NAME = "dist";

/**
 * 本ファイルの絶対パス（`<repoRoot>/scripts/clean-dist.mjs`）。
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
 * 削除対象の絶対パス。
 *
 * @type {string}
 */
const distPath = join(repositoryRoot, TARGET_DIRECTORY_NAME);

/**
 * ログ1行を標準エラー出力へ書く。
 *
 * @param {string} message 出力するメッセージ
 * @returns {void}
 */
function log(message) {
  process.stderr.write(`clean-dist: ${message}\n`);
}

/**
 * 削除対象がリポジトリルート直下の `dist/` そのものであることを検証する。
 *
 * `distPath` は本ファイルの位置から機械的に導出しているため通常は成立するが、
 * 想定外のパスに対して再帰削除を実行しないための最後の防波堤として明示的に検査する。
 *
 * @param {string} target 検証する絶対パス
 * @returns {boolean} リポジトリルート直下の `dist/` である場合 `true`
 */
function isRepositoryDist(target) {
  const normalized = resolve(target);
  return (
    basename(normalized) === TARGET_DIRECTORY_NAME &&
    dirname(normalized) === resolve(repositoryRoot) &&
    normalized !== resolve(repositoryRoot)
  );
}

/**
 * `dist/` を再帰削除する。存在しない場合は何もしない。
 *
 * @returns {number} 終了コード（0: 正常終了 / 1: 削除失敗または想定外の状態）
 */
function main() {
  if (!isRepositoryDist(distPath)) {
    log(
      `削除対象がリポジトリルート直下の ${TARGET_DIRECTORY_NAME}/ ではないため中止しました: ${distPath}`,
    );
    return 1;
  }

  /** @type {import("node:fs").Stats | undefined} 対象の状態（シンボリックリンクは追跡しない）。 */
  let stats;
  try {
    stats = lstatSync(distPath);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      /** @type {{ code?: string }} */ (error).code === "ENOENT"
    ) {
      // 冪等性: 未生成・既削除の状態は正常終了として扱う。
      log(`${TARGET_DIRECTORY_NAME}/ は存在しません（削除不要）: ${distPath}`);
      return 0;
    }
    log(
      `${TARGET_DIRECTORY_NAME}/ の状態を取得できませんでした: ${distPath} (${describeError(error)})`,
    );
    return 1;
  }

  // ディレクトリ以外（ファイル・シンボリックリンク等）は想定外の状態である。
  // シンボリックリンクを削除するとリンク先の扱いが利用者の意図に依存するため、
  // 自動では手を付けず、明示的なエラーで人間の判断に委ねる。
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    log(
      `${TARGET_DIRECTORY_NAME} がディレクトリではないため削除しませんでした: ${distPath}`,
    );
    return 1;
  }

  try {
    rmSync(distPath, { recursive: true, force: true });
  } catch (error) {
    log(
      `${TARGET_DIRECTORY_NAME}/ の削除に失敗しました: ${distPath} (${describeError(error)})`,
    );
    return 1;
  }

  log(`${TARGET_DIRECTORY_NAME}/ を削除しました: ${distPath}`);
  return 0;
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

process.exit(main());

#!/usr/bin/env node
/**
 * Package_Manifest（`package.json`）の単一フィールドを書き換えるCLI（要件5.2 / 6.1 / 6.5）。
 *
 * 使い方:
 * ```
 * node scripts/set-package-field.mjs <field> <value> [manifest-path]
 * ```
 *
 * - `<field>` は `version` または `name` のみを受け付ける（設計「スクリプト構成」）。
 * - 書き換え前の値と後の値の双方を標準出力へ出す（`formatVersionRewriteLog`）。
 * - **コミット・タグ作成・pushは一切行わない**（要件5.2 / 6.2）。git操作を含まない。
 * - `[manifest-path]` は省略可（既定はリポジトリルートの `package.json`）。
 *   テストや動作確認で任意の複製に対して実行できるようにするための注入点である。
 *
 * 制約:
 * - **Node.js組込みモジュールのみに依存する**（`node:fs` / `node:path` / `node:url`）。
 *   devDependencies が未インストールの環境でも動作しなければならない。
 * - 書き戻し時に元ファイルのJSON整形（インデント幅・改行コード・末尾改行）を保つ。
 *   これによりCI上の `git diff` が対象フィールドの1行のみになる。
 *
 * 終了コード: 成功 `0` / 引数不正・読み込み不能・パース不能・書き込み失敗 `1`。
 *
 * @module scripts/set-package-field
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatVersionRewriteLog, setPackageField } from "./lib/release.mjs";

/**
 * 書き換えを許可するフィールド（設計「スクリプト構成」/ 要件5.2 / 6.1）。
 * 許可リスト方式にすることで、フィールド名の打ち間違いによる
 * `files` / `scripts` などの破壊を防ぐ。
 *
 * @type {ReadonlyArray<string>}
 */
const ALLOWED_FIELDS = ["version", "name"];

/** 既定のインデント（`package.json` の慣習）。 */
const DEFAULT_INDENT = "  ";

/** 使い方の説明（引数不正時に標準エラー出力へ出す）。 */
const USAGE =
  "使い方: node scripts/set-package-field.mjs <field> <value> [manifest-path]\n" +
  `  <field>: ${ALLOWED_FIELDS.join(" | ")}\n` +
  "  <value>: 書き換え後の値（空文字列は不可）";

/**
 * リポジトリルートの `package.json` の絶対パスを求める。
 *
 * @returns {string} 既定のPackage_Manifestのパス
 */
function defaultManifestPath() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDirectory, "..", "package.json");
}

/**
 * ファイル本文からJSONの整形スタイルを読み取る。
 *
 * インデントは最初に現れる字下げ付きの行から、改行コードは `\r\n` の有無から、
 * 末尾改行は最終文字から判定する。
 *
 * @param {string} text 元ファイルの本文
 * @returns {{ indent: string, eol: string, trailingNewline: boolean }} 整形スタイル
 */
function detectJsonFormat(text) {
  const indentMatch = /\r?\n([ \t]+)\S/.exec(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";

  return {
    indent: indentMatch === null ? DEFAULT_INDENT : indentMatch[1],
    eol,
    trailingNewline: /\r?\n$/.test(text),
  };
}

/**
 * オブジェクトを元ファイルと同じ整形でJSON文字列へ直列化する。
 *
 * `JSON.stringify` は常に `\n` を使うため、`\r\n` のファイルでは改行を置換する。
 *
 * @param {Record<string, unknown>} manifest 直列化する対象
 * @param {{ indent: string, eol: string, trailingNewline: boolean }} format 整形スタイル
 * @returns {string} 書き戻す本文
 */
function serializeManifest(manifest, format) {
  const json = JSON.stringify(manifest, null, format.indent);
  const body = format.eol === "\n" ? json : json.split("\n").join(format.eol);

  return format.trailingNewline ? `${body}${format.eol}` : body;
}

/**
 * 致命的エラーを報告して非ゼロ終了する。
 *
 * @param {string} message 運用者向けのメッセージ
 * @param {string} [detail] 補足（使い方など）
 * @returns {never}
 */
function fail(message, detail) {
  process.stderr.write(`${message}\n`);
  if (detail !== undefined) {
    process.stderr.write(`${detail}\n`);
  }
  process.exit(1);
}

/**
 * CLIの本体。
 *
 * @returns {void}
 */
function main() {
  const [field, value, manifestPathArgument, ...rest] = process.argv.slice(2);

  if (field === undefined || value === undefined) {
    fail("引数が不足しています。", USAGE);
  }
  if (rest.length > 0) {
    fail(`引数が多すぎます（余分な引数: ${rest.length} 個）。`, USAGE);
  }
  if (!ALLOWED_FIELDS.includes(field)) {
    fail(
      `書き換え対象として許可されていないフィールドです: "${field}"（許可: ${ALLOWED_FIELDS.join(" / ")}）`,
      USAGE,
    );
  }
  if (value === "") {
    fail(`フィールド "${field}" に空文字列は設定できません。`, USAGE);
  }

  const manifestPath =
    manifestPathArgument === undefined || manifestPathArgument === ""
      ? defaultManifestPath()
      : path.resolve(manifestPathArgument);

  /** @type {string} */
  let original;
  try {
    original = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return fail(
      `Package_Manifest を読み込めませんでした: ${manifestPath}`,
      error instanceof Error ? error.message : String(error),
    );
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(original);
  } catch (error) {
    return fail(
      `Package_Manifest をJSONとして解析できませんでした: ${manifestPath}`,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(
      `Package_Manifest のトップレベルがJSONオブジェクトではありません: ${manifestPath}`,
    );
  }

  const manifest = /** @type {Record<string, unknown>} */ (parsed);
  const previousValue = manifest[field];
  // 書き換え前の値がない場合も「(未設定)」としてログに残す（要件6.5）。
  const previousForLog =
    previousValue === undefined ? "(未設定)" : String(previousValue);

  const updated = setPackageField(manifest, field, value);
  const format = detectJsonFormat(original);
  const nextText = serializeManifest(updated, format);

  // 内容が変わらない場合はファイルへ触れない（不要な差分・mtime更新を作らない）。
  if (nextText !== original) {
    try {
      writeFileSync(manifestPath, nextText, "utf8");
    } catch (error) {
      return fail(
        `Package_Manifest を書き込めませんでした: ${manifestPath}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  process.stdout.write(
    `${formatVersionRewriteLog(previousForLog, value, field)}\n`,
  );
  process.stdout.write(`対象ファイル: ${manifestPath}\n`);
  if (nextText === original) {
    process.stdout.write(
      "書き換え後の内容が元と同一のため、ファイルは変更していません。\n",
    );
  }
  process.stdout.write(
    "コミット・タグ作成・pushは行いません（ワークスペース内の変更のみ）。\n",
  );
}

main();

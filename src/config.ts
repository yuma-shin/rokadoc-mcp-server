/**
 * 設定管理モジュール
 *
 * 環境変数からサーバー設定を読み込み、バリデーション・正規化を行う。
 * バリデーション失敗時は標準エラー出力にメッセージを出力し process.exit(1) で終了する。
 */

import { ServerConfig } from "./types.js";
import { normalizeBaseUrl, validateUrlFormat } from "./utils/url-validator.js";

/** デフォルトのrokadoc API Base URL */
const DEFAULT_BASE_URL = "https://api.rokadoc.ntt.com";

/**
 * 環境変数からサーバー設定を読み込み、検証・正規化して返す。
 *
 * - ROKADOC_API_KEY: 必須。未設定・空文字列・空白のみは拒否
 * - ROKADOC_BASE_URL: 任意。未設定・空文字列の場合はデフォルト値を使用
 *   - URL形式検証（http/https スキーム必須）
 *   - 末尾スラッシュ除去、http→https自動変換
 *
 * @returns 正規化済みのサーバー設定
 */
export function loadConfig(): ServerConfig {
  // 1. ROKADOC_API_KEY の読み込みと検証
  const apiKey = process.env.ROKADOC_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    process.stderr.write(
      "[設定エラー] 環境変数 ROKADOC_API_KEY が設定されていないか、空白のみです。有効なAPIキーを設定してください。\n",
    );
    process.exit(1);
  }

  // 2. ROKADOC_BASE_URL の読み込みと検証
  const rawBaseUrl = process.env.ROKADOC_BASE_URL;
  let baseUrl: string;

  if (!rawBaseUrl || rawBaseUrl.trim() === "") {
    // 未設定または空文字列の場合はデフォルト値を使用
    baseUrl = DEFAULT_BASE_URL;
  } else {
    // URL形式検証
    if (!validateUrlFormat(rawBaseUrl)) {
      process.stderr.write(
        `[設定エラー] 環境変数 ROKADOC_BASE_URL の値が不正なURL形式です。"http://" または "https://" で始まるURLを指定してください。\n`,
      );
      process.exit(1);
    }

    // URL正規化（末尾スラッシュ除去、http→https変換）
    baseUrl = normalizeBaseUrl(rawBaseUrl);
  }

  // 3. 正規化済み設定を返却
  return {
    baseUrl,
    apiKey: apiKey.trim(),
  };
}

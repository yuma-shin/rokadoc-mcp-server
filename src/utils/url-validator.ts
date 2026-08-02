/**
 * URL検証・正規化ユーティリティ
 *
 * rokadoc MCPサーバーのBase URL検証、正規化、
 * およびリクエスト送信先のホスト制限チェックを提供する。
 */

/**
 * Base URLを正規化する。
 * - 末尾スラッシュを除去する
 * - "http://" スキームを "https://" に変換し、標準エラー出力に警告を出力する
 *
 * @param url - 正規化対象のURL文字列
 * @returns 正規化済みのURL文字列
 */
export function normalizeBaseUrl(url: string): string {
  let normalized = url;

  // http:// → https:// 変換（警告出力付き）
  if (normalized.startsWith("http://")) {
    process.stderr.write(
      `[警告] Base URLが "http://" で設定されています。セキュリティのため "https://" に自動変換します: ${normalized}\n`,
    );
    normalized = "https://" + normalized.slice("http://".length);
  }

  // 末尾スラッシュを除去（複数のスラッシュにも対応）
  normalized = normalized.replace(/\/+$/, "");

  return normalized;
}

/**
 * URL形式を検証する。
 * "http://" または "https://" で始まる場合のみ有効とする。
 *
 * @param url - 検証対象のURL文字列
 * @returns URL形式が有効であればtrue、そうでなければfalse
 */
export function validateUrlFormat(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * リクエストURLのホストがBase URLのホストと一致するかを検証する。
 * 送信先をBase URLのホストのみに制限するためのセキュリティチェック。
 *
 * @param requestUrl - リクエスト送信先のURL文字列
 * @param baseUrl - 許可されたBase URL文字列
 * @returns ホストが一致すればtrue、そうでなければfalse
 */
export function isAllowedHost(requestUrl: string, baseUrl: string): boolean {
  try {
    const requestHost = new URL(requestUrl).host;
    const allowedHost = new URL(baseUrl).host;
    return requestHost === allowedHost;
  } catch {
    // URLパースに失敗した場合は不許可とする
    return false;
  }
}

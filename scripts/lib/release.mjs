/**
 * リリース判定ロジックの純関数群（Node.js ESM）。
 *
 * NPM_Publish_Workflow（`.github/workflows/publish-npm.yml`）の判断ロジック
 * （バージョン導出・収録判定・結果集約・エラー分類・リトライ方針・ログ整形・
 * マニフェスト書き換え）を、vitestから直接テストできる純関数として取り出す。
 * ワークフローYAMLはこれらを呼び出すだけの薄い層に保つ。
 *
 * 制約:
 * - **Node.js組込みモジュールのみに依存し、外部依存を持たない**。
 *   `prepack` から呼ばれる経路（git依存インストール時など devDependencies が
 *   未インストールの環境）でも動作しなければならないため。本ファイルは
 *   現時点で import を1つも持たない。
 * - 型は手書きの `scripts/lib/release.d.mts` が唯一の真実の源である。
 *   本ファイルのシグネチャを変更したら `.d.mts` も必ず同期させる（自動同期の
 *   仕組みは持たない。レビュー時の確認事項）。
 *
 * 本ファイルはタスク2.1で**シグネチャとJSDocのみ**を定義し、各関数の本体を
 * 後続タスク（2.3 / 2.5 / 2.7 / 2.9 / 2.11）で実装したものである。
 * 現在は公開APIのすべてが実装済みである。
 *
 * @module scripts/lib/release
 */

/**
 * Release_Tagの期待形式（人間可読）。拒否結果のメッセージに含める。
 *
 * @type {string}
 */
const EXPECTED_TAG_FORMAT = "v<major>.<minor>.<patch>";

/**
 * 有効なRelease_Tagの判定基準（唯一の真実の源）。
 * 先頭の `v` + 先頭ゼロなし・6桁以下の整数3要素のみを受理する。
 *
 * @type {RegExp}
 */
const VALID_TAG_PATTERN =
  /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

/**
 * 有効なPackage_Versionの判定基準（`VALID_TAG_PATTERN` から先頭の `v` を除いたもの）。
 *
 * @type {RegExp}
 */
const VALID_VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

/**
 * Package_Tarball 内のパス区切り（`npm pack --json` の出力と同じ `/`）。
 *
 * @type {string}
 */
const SEPARATOR = "/";

/**
 * `package.json` の `files` によって配下全体が収録されるディレクトリ（要件2.1 / 2.2 / 2.4）。
 *
 * @type {ReadonlyArray<string>}
 */
const PACKAGED_DIRECTORIES = ["dist"];

/**
 * ルート直下で収録される固定ファイル（npmの常時収録 + `files` の明示。要件2.2）。
 *
 * @type {ReadonlyArray<string>}
 */
const PACKAGED_EXACT_FILES = ["package.json", "README.md", "LICENSE.md"];

/**
 * 公開処理の既定の境界値（要件4.10 / 4.12 / 5.9 / 5.11）。
 * `withRetry` の既定オプションとして使う。
 */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MIN_INTERVAL_MS = 10_000;
const DEFAULT_BUDGET_MS = 600_000;

/**
 * `registryLabel` が指定されなかった場合にログへ入れる既定の呼称。
 * トークン値やURLを含めない（要件4.11 / 5.10）。
 *
 * @type {string}
 */
const DEFAULT_REGISTRY_LABEL = "対象レジストリ";

/**
 * 公開失敗の分類として認める値の全量（`withRetry` が分類器の返り値を検証するために使う）。
 *
 * @type {ReadonlyArray<PublishErrorCategory>}
 */
const PUBLISH_ERROR_CATEGORIES = ["retryable", "conflict", "auth", "unknown"];

/**
 * `timeout` コマンドが打ち切りを示すために使う終了コード（要件4.12 / 5.9）。
 *
 * @type {number}
 */
const TIMEOUT_EXIT_CODE = 124;

/**
 * ジョブを失敗させない Registry_Publish_Step の結果（要件5.7）。
 * これ以外（`failed` および想定外の値）はすべて失敗として集約する。
 *
 * @type {ReadonlyArray<PublishStepResult>}
 */
const NON_FAILING_STEP_RESULTS = ["success", "skipped"];

/**
 * `isBlankToken` が「空白のみ」と判定する文字（要件4.9）。
 * スペース / タブ / 改行 / キャリッジリターン / フォームフィード / 垂直タブ。
 * `\s`（Unicode空白やBOMを含む）ではなくこの6種に限定する。
 *
 * @type {RegExp}
 */
const BLANK_TOKEN_PATTERN = /^[ \t\n\r\f\v]*$/;

/**
 * `conflict` を確定させるエラーコード（要件5.8。prerequisites.md 7節）。
 *
 * @type {ReadonlyArray<string>}
 */
const CONFLICT_CODES = ["EPUBLISHCONFLICT", "E409"];

/**
 * `E403` を `conflict` 側へ振り分ける本文の文字列。
 * 公開npmレジストリの重複公開は HTTP 403 で返るため、`E403` 単独では
 * `conflict` と `auth` を区別できない（prerequisites.md 7節）。
 *
 * @type {ReadonlyArray<string>}
 */
const CONFLICT_PHRASES = ["cannot publish over", "previously published"];

/**
 * `auth` を確定させるエラーコード（`E403` は上記phraseを含まない場合のみ）。
 *
 * @type {ReadonlyArray<string>}
 */
const AUTH_CODES = ["ENEEDAUTH", "E401", "EOTP", "EAUTHIP"];

/**
 * 権限不足・重複公開の双方で使われる曖昧なエラーコード。
 *
 * @type {string}
 */
const AMBIGUOUS_FORBIDDEN_CODE = "E403";

/**
 * `retryable` を確定させるエラーコード（ネットワーク到達不能・一時障害）。
 *
 * @type {ReadonlyArray<string>}
 */
const RETRYABLE_CODES = [
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ESOCKETTIMEDOUT",
  "E500",
  "E502",
  "E503",
  "E504",
];

/**
 * 分類ごとの運用者向け処理指示（要件5.8 / 4.10 / 5.11）。
 *
 * `auth` の指示には取り下げ操作（`unpublish` / `deprecate`）を含めない。
 * 既に他レジストリへ公開済みのPackage_Versionには手を加えない方針である。
 *
 * @type {Readonly<Record<PublishErrorCategory, string>>}
 */
const PUBLISH_ERROR_INSTRUCTIONS = {
  retryable:
    "ネットワーク到達不能またはレジストリの一時的な障害の可能性があります。10秒以上の間隔をおいて、同一バージョンに対して合計3回までの範囲で再試行してください。",
  conflict:
    "同一のPackage_Versionが既に公開されています。当該レジストリへの公開はスキップ扱いとし、再試行しないでください。内容を変更して公開する場合は新しいRelease_Tagを作成してください。",
  auth: "認証が拒否されたか権限が不足しています。再試行せず、対象レジストリのRegistry_Credential（GitHub Secretsの設定値、およびGITHUB_TOKENの packages: write 権限）を確認してください。既に公開済みのPackage_Versionには一切変更を加えないでください。",
  unknown:
    "既知の分類に該当しない失敗です。再試行せず、公開コマンドの出力全体を確認して原因を特定してください。",
};

/**
 * 装飾プレフィックス（`npm ERR!` 等）に依存せず、エラーコードの出現を判定する。
 *
 * 行頭パターンを要求せず、単語境界付きの部分一致で判定するため、
 * `npm ERR! code E409` / `code=E409` / `E409` のいずれの形でも一致する。
 * 単語境界を課すのは `E500` が `E5000` のような別の値に誤一致しないようにするため。
 *
 * @param {string} stderr 検査対象の標準エラー出力
 * @param {string} code 検査するエラーコード（例: `E409`）
 * @returns {boolean} 出現する場合 `true`
 */
function containsErrorCode(stderr, code) {
  return new RegExp(`\\b${code}\\b`, "i").test(stderr);
}

/**
 * 標準エラー出力に指定の文字列が（大文字小文字を区別せず）含まれるかを判定する。
 *
 * @param {string} stderr 検査対象の標準エラー出力
 * @param {string} phrase 検査する文字列
 * @returns {boolean} 含まれる場合 `true`
 */
function containsPhrase(stderr, phrase) {
  return stderr.toLowerCase().includes(phrase.toLowerCase());
}

/**
 * Registry_Publish_Step の結果。
 *
 * - `success`: 当該レジストリへ公開完了
 * - `skipped`: 公開要求を送信せず正常終了（同一バージョンが公開済み等）
 * - `failed`: 公開できなかった
 *
 * @typedef {"success" | "skipped" | "failed"} PublishStepResult
 */

/**
 * 公開失敗の分類（要件5.8 / 4.10 / 5.11）。
 *
 * @typedef {"retryable" | "conflict" | "auth" | "unknown"} PublishErrorCategory
 */

/**
 * タグからのバージョン導出に成功した結果。
 *
 * @typedef {object} VersionDerivationSuccess
 * @property {true} ok 成功を示す判別子
 * @property {string} version 先頭の `v` をちょうど1個除去した値（例: `1.0.7`）
 */

/**
 * タグからのバージョン導出を拒否した結果。要件6.3 / 6.7 に従い、
 * 実際のタグ値と期待形式の双方を必ず含む。
 *
 * @typedef {object} VersionDerivationFailure
 * @property {false} ok 拒否を示す判別子
 * @property {string} tag 入力された実際のタグ値（`String(tag)` 相当）
 * @property {string} expectedFormat 期待する形式（`v<major>.<minor>.<patch>`）
 * @property {string} message `tag` と `expectedFormat` の双方を部分文字列として含むログ用メッセージ
 */

/**
 * @typedef {VersionDerivationSuccess | VersionDerivationFailure} VersionDerivationResult
 */

/**
 * `classifyPublishError` の返り値。
 *
 * @typedef {object} PublishErrorClassification
 * @property {PublishErrorCategory} category 分類結果（4値のいずれか1つ）
 * @property {boolean} retryable 再試行してよいか。`conflict` / `auth` では常に `false`
 * @property {string} instruction 運用者向けの処理指示。`auth` の場合でも取り下げ操作（`unpublish` / `deprecate`）を含めない
 */

/**
 * 1回の公開試行の結果（`withRetry` に渡す操作の返り値）。
 *
 * @typedef {object} PublishAttemptSuccess
 * @property {true} ok 成功を示す判別子
 */

/**
 * @typedef {object} PublishAttemptFailure
 * @property {false} ok 失敗を示す判別子
 * @property {string} stderr 標準エラー出力（`classifyPublishError` に渡す）
 * @property {number} exitCode 終了コード（`124` は `timeout` による打ち切り）
 */

/**
 * @typedef {PublishAttemptSuccess | PublishAttemptFailure} PublishAttemptOutcome
 */

/**
 * `withRetry` の事前検証条件。ひとつでも `ok: false` があれば
 * 公開操作を1回も呼び出さずに `failed` を確定させる（要件2.6 / 6.3 / 9.10）。
 *
 * @typedef {object} PublishPrecondition
 * @property {string} name 条件名（例: `tag-format` / `build-artifact` / `npm-readme`）
 * @property {boolean} ok 条件を満たすか
 */

/**
 * `withRetry` のオプション。時間関連はすべて注入可能とし、
 * テストで実時間の待機を発生させない（`vi.useFakeTimers()` と併用する）。
 *
 * @typedef {object} WithRetryOptions
 * @property {number} [maxAttempts=3] 最大試行回数（要件4.10 / 5.11）
 * @property {number} [minIntervalMs=10000] 連続する試行の最小間隔（ミリ秒。要件4.10）
 * @property {number} [budgetMs=600000] 1レジストリあたりの総予算（ミリ秒。要件4.12 / 5.9）
 * @property {ReadonlyArray<PublishPrecondition>} [preconditions] 事前検証条件
 * @property {() => number} [now] 現在時刻の取得（既定: `Date.now`）
 * @property {(ms: number) => Promise<void>} [sleep] 待機処理（既定: `setTimeout` による待機）
 * @property {(stderr: string, exitCode: number) => PublishErrorClassification} [classify] エラー分類（既定: `classifyPublishError`）
 * @property {string} [registryLabel] ログに含めるレジストリ名
 */

/**
 * `withRetry` の最終結果。
 *
 * @typedef {object} RetryOutcome
 * @property {PublishStepResult} result Registry_Publish_Step に記録する結果
 * @property {number} attempts 公開操作を実際に呼び出した回数（`maxAttempts` 以下。事前検証失敗時は `0`）
 * @property {number} elapsedMs `now()` 基準の総経過時間
 * @property {"succeeded" | "conflict" | "auth" | "unknown" | "exhausted" | "timeout" | "precondition"} reason 結果の理由
 * @property {PublishErrorCategory | undefined} category 最後の失敗の分類（失敗していない場合は `undefined`）
 * @property {ReadonlyArray<string>} logs 出力すべきログ行（トークン値を含まない）
 */

/**
 * Release_Tag（例: `v1.0.7`）から Package_Version（例: `1.0.7`）を導出する。
 *
 * `^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$` に
 * **完全一致**する場合のみ成功とし、先頭の `v` をちょうど1個だけ除去した値を返す。
 * プレリリース識別子（`-rc.1`）・ビルドメタデータ（`+build`）・先頭ゼロ・
 * 1000000以上の要素・非数値要素・要素数が3でないもの・先頭が `v` でないもの・
 * 前後の空白・空文字列はすべて拒否する（要件6.3 / 6.7）。
 *
 * 例外は投げない（全域関数）。非文字列が渡された場合も拒否結果を返す。
 *
 * @param {unknown} tag 検査対象のタグ値（`GITHUB_REF_NAME` 相当）
 * @returns {VersionDerivationResult} 成功時は `{ ok: true, version }`、拒否時は実タグ値と期待形式を含む結果
 * @see Property 1, Property 2
 * @todo 実装はタスク2.3
 */
export function deriveVersionFromTag(tag) {
  if (typeof tag === "string" && VALID_TAG_PATTERN.test(tag)) {
    // 先頭の `v` をちょうど1個だけ除去する（`replace(/^v+/, "")` にはしない）。
    return { ok: true, version: tag.slice(1) };
  }

  // 非文字列も拒否結果として返す（全域関数）。`String(symbol)` は例外になるため個別に扱う。
  const actual =
    typeof tag === "string"
      ? tag
      : typeof tag === "symbol"
        ? tag.toString()
        : String(tag);
  return {
    ok: false,
    tag: actual,
    expectedFormat: EXPECTED_TAG_FORMAT,
    message: `Release_Tag が期待形式に一致しません: 実際の値="${actual}" / 期待形式="${EXPECTED_TAG_FORMAT}"`,
  };
}

/**
 * 2つの Package_Version を3要素の数値タプルの辞書式順序で比較する。
 *
 * `a` が `b` より小さければ負値、等しければ `0`、大きければ正値（`-1` / `0` / `1`）を返す。
 * 全順序（反射性・反対称性・推移性）を満たす。
 *
 * 入力は `deriveVersionFromTag` が返す形式（`<major>.<minor>.<patch>`。先頭の `v` を含まない）
 * を前提とし、その形式に一致しない値に対しては `TypeError` を投げる。
 *
 * @param {string} a 比較対象のバージョン（例: `1.0.7`）
 * @param {string} b 比較対象のバージョン（例: `1.0.10`）
 * @returns {-1 | 0 | 1} 比較結果
 * @throws {TypeError} いずれかが `<major>.<minor>.<patch>` 形式でない場合
 * @see Property 11
 * @todo 実装はタスク2.3
 */
export function compareSemver(a, b) {
  const left = parseVersionComponents(a, "a");
  const right = parseVersionComponents(b, "b");

  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * `<major>.<minor>.<patch>` を3要素の数値タプルへ変換する。
 *
 * @param {string} version 変換対象のバージョン文字列
 * @param {string} argumentName 例外メッセージに含める引数名
 * @returns {[number, number, number]} 数値タプル
 * @throws {TypeError} `version` が `<major>.<minor>.<patch>` 形式でない場合
 */
function parseVersionComponents(version, argumentName) {
  if (typeof version !== "string" || !VALID_VERSION_PATTERN.test(version)) {
    throw new TypeError(
      `compareSemver: 引数 ${argumentName} は <major>.<minor>.<patch> 形式でなければなりません（実際の値: ${JSON.stringify(version)}）`,
    );
  }

  const [major, minor, patch] = version.split(".");
  return [Number(major), Number(minor), Number(patch)];
}

/**
 * 相対パスが Package_Tarball に収録されるかを判定する（要件2.2 / 2.3 / 2.4）。
 *
 * `package.json` の `files: ["dist", "LICENSE.md"]` と、npmが常に収録する
 * ルール（`package.json` / `README*` / `LICENSE*`）をモデル化した純関数である。
 * 真になるのは `dist/` 配下・`package.json` / `README.md` / `LICENSE.md` に限られ、
 * `src/` `tests/` `docs/` `.github/` `.kiro/` `node_modules/` `scripts/` 配下、
 * `.env` で始まる名称、`.npmrc`、`NPM.md`、`DOCKERHUB.md`、`tsconfig.json`、
 * `vitest.config.ts`、`renovate.json5`、`.gitignore`、`package-lock.json`、
 * `.readme-github.bak` に対しては常に偽を返す。
 *
 * パス区切りは `npm pack --json` の出力と同じ `/` を前提とする。
 * 例外は投げない（非文字列・空文字列は偽）。
 *
 * @param {unknown} path 収録判定の対象となるリポジトリルート相対パス（例: `dist/index.js`）
 * @returns {boolean} tarballに収録される場合 `true`
 * @see Property 3
 */
export function isPackagedPath(path) {
  if (typeof path !== "string" || path === "") {
    return false;
  }

  // npmの常時収録ルール（`package.json` / `README*` / `LICENSE*`）と `files` の
  // `LICENSE.md` を、本リポジトリに実在するファイル名に限定してモデル化する。
  // `README*` / `LICENSE*` へ一般化しないのは、Property 3 が「真になるのは
  // `dist/` 配下と下記3ファイルに限られる」ことを要求しているため
  // （要件2.2 / 2.3。`NPM.md` や `.readme-github.bak` は収録されない）。
  if (PACKAGED_EXACT_FILES.includes(path)) {
    return true;
  }

  // 区切りは `npm pack --json` の出力と同じ `/` のみを認める。
  // `dist\index.js` のような別区切りは1要素として扱われ、偽になる。
  const segments = path.split(SEPARATOR);

  // `dist` 単体（ディレクトリ自体）や `dist/` のような末尾空要素は収録物ではない。
  // 先頭要素が許可ディレクトリで、以降に1個以上の正常な要素が続く場合のみ真。
  if (segments.length < 2 || !PACKAGED_DIRECTORIES.includes(segments[0])) {
    return false;
  }

  // `dist/../src/index.ts` や `dist//index.js` のように許可ディレクトリから
  // 抜け出し得る／正規形でないパスは収録判定の対象外として偽を返す。
  return segments
    .slice(1)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * 全 Registry_Publish_Step の結果からジョブの終了コードを集約する（要件5.7）。
 *
 * `failed` がひとつでもあれば非ゼロ（`1`）、すべてが `success` または `skipped`
 * なら `0` を返す。結果が空配列の場合は `0` を返す。
 *
 * @param {ReadonlyArray<PublishStepResult>} results 各ステップの結果（順序は問わない）
 * @returns {0 | 1} ジョブの終了コード
 * @see Property 5
 */
export function aggregateExitCode(results) {
  if (!Array.isArray(results)) {
    throw new TypeError(
      `aggregateExitCode: results は配列でなければなりません（実際の型: ${typeof results}）`,
    );
  }

  // `success` / `skipped` 以外はすべて失敗として扱う（安全側）。
  // `failed` はもちろん、想定外の値でジョブが黙って成功扱いになることを避ける。
  return results.every((result) => NON_FAILING_STEP_RESULTS.includes(result))
    ? 0
    : 1;
}

/**
 * Registry_Credential が「未設定」として扱われるかを判定する（要件4.9 / 4.5）。
 *
 * 空文字列、および空白文字（スペース / タブ / 改行 / キャリッジリターン /
 * フォームフィード / 垂直タブ）のみで構成される文字列に対して真を返す。
 * `undefined` / `null` / 非文字列も未設定として真を返す。
 * トークン値そのものは返り値にもログにも一切含めない。
 *
 * @param {unknown} token 判定対象のトークン（`NODE_AUTH_TOKEN` 相当）
 * @returns {boolean} 未設定として扱う場合 `true`
 * @see Property 7
 */
export function isBlankToken(token) {
  // 非文字列（環境変数が存在しない場合の `undefined` を含む）は未設定として扱う。
  // トークン値そのものは返り値にもログにも一切含めない（判定結果は真偽値のみ）。
  if (typeof token !== "string") {
    return true;
  }

  return BLANK_TOKEN_PATTERN.test(token);
}

/**
 * 公開失敗の標準エラー出力と終了コードから失敗の種類を分類する（要件5.8 / 4.10 / 5.11）。
 *
 * 分類に使うトークンは実機検証（prerequisites.md「7. classifyPublishError が分類に
 * 使う文字列」）で確定したものを用いる。大文字小文字は区別せず、行頭の
 * `npm ERR!` などの装飾プレフィックスには依存しない（npmのメジャーバージョンで
 * 変わり得るため）。
 *
 * - `conflict`: `EPUBLISHCONFLICT` / `E409` /（`E403` かつ `cannot publish over` または `previously published`）
 * - `auth`: `ENEEDAUTH` / `E401` / `EOTP` / `EAUTHIP` /（`E403` で上記conflict文字列を含まないもの）
 * - `retryable`: `ENOTFOUND` / `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `EAI_AGAIN` /
 *   `ESOCKETTIMEDOUT` / `E500` / `E502` / `E503` / `E504` / 終了コード `124`（`timeout` による打ち切り）
 * - `unknown`: 上記いずれにも該当しないもの
 *
 * `conflict` と `auth` は常に `retryable: false` とする。`auth` の `instruction` には
 * 取り下げ操作（`unpublish` / `deprecate`）を含めない（要件5.8）。
 *
 * @param {string} stderr 公開コマンドの標準エラー出力
 * @param {number} exitCode 公開コマンドの終了コード
 * @returns {PublishErrorClassification} 分類結果・再試行可否・処理指示
 * @see Property 9
 */
export function classifyPublishError(stderr, exitCode) {
  const output = typeof stderr === "string" ? stderr : "";
  const category = categorizePublishError(output, exitCode);

  return {
    category,
    // 再試行可否は分類から一意に決まる。`conflict` / `auth` / `unknown` は常に再試行しない。
    retryable: category === "retryable",
    instruction: PUBLISH_ERROR_INSTRUCTIONS[category],
  };
}

/**
 * 標準エラー出力と終了コードから分類だけを求める（`classifyPublishError` の内部処理）。
 *
 * 判定順は conflict → auth → retryable とする。`conflict` / `auth` は
 * レジストリ側が確定的に拒否した状態であり、同一の出力に一時障害の文字列が
 * 併記されていても再試行してはならないため、ネットワーク系より先に判定する。
 * 例外として終了コード `124`（`timeout` による打ち切り）は出力が空にもなり得るため
 * 最優先で `retryable` とする。
 *
 * @param {string} stderr 公開コマンドの標準エラー出力
 * @param {number} exitCode 公開コマンドの終了コード
 * @returns {PublishErrorCategory} 分類結果
 */
function categorizePublishError(stderr, exitCode) {
  if (exitCode === TIMEOUT_EXIT_CODE) {
    return "retryable";
  }

  const hasConflictPhrase = CONFLICT_PHRASES.some((phrase) =>
    containsPhrase(stderr, phrase),
  );
  const isForbidden = containsErrorCode(stderr, AMBIGUOUS_FORBIDDEN_CODE);

  if (
    CONFLICT_CODES.some((code) => containsErrorCode(stderr, code)) ||
    (isForbidden && hasConflictPhrase)
  ) {
    return "conflict";
  }

  // `E403` は権限不足でも重複公開でも同じコードになるため、上でconflictを
  // 除外したあとの `E403` を `auth` として扱う（prerequisites.md 7節）。
  if (
    AUTH_CODES.some((code) => containsErrorCode(stderr, code)) ||
    isForbidden
  ) {
    return "auth";
  }

  if (RETRYABLE_CODES.some((code) => containsErrorCode(stderr, code))) {
    return "retryable";
  }

  return "unknown";
}

/**
 * 公開成功ログを整形する（要件4.11 / 5.10）。
 *
 * 返す文字列は `packageName` と `version` を必ず部分文字列として含む。
 * トークン値は引数に取らないため出力に含まれ得ない。
 *
 * @param {string} packageName 公開したパッケージ名（スコープ付きを含む）
 * @param {string} version 公開した Package_Version
 * @param {string} [registryLabel] レジストリ名（指定時はログに含める）
 * @returns {string} ログ1行
 * @see Property 10
 */
export function formatPublishSuccessLog(packageName, version, registryLabel) {
  // 入力値をそのまま埋め込む（加工すると部分文字列として含まれなくなる）。
  const target = `${packageName}@${version}`;

  return registryLabel === undefined || registryLabel === ""
    ? `公開に成功しました: ${target}`
    : `公開に成功しました: ${target} -> ${registryLabel}`;
}

/**
 * Package_Manifest のフィールド書き換えログを整形する（要件6.5）。
 *
 * 返す文字列は書き換え前の値と後の値の双方を必ず部分文字列として含む。
 * `version` 以外（`name` など）の書き換えにも再利用する。
 * トークン値は引数に取らないため出力に含まれ得ない。
 *
 * @param {string} previousValue 書き換え前の値
 * @param {string} nextValue 書き換え後の値
 * @param {string} [field="version"] 書き換えたフィールド名
 * @returns {string} ログ1行
 * @see Property 10
 */
export function formatVersionRewriteLog(previousValue, nextValue, field) {
  const fieldName = field === undefined || field === "" ? "version" : field;

  // 前後の値は加工せずそのまま含める（要件6.5）。
  return `Package_Manifest の ${fieldName} を書き換えました: "${previousValue}" -> "${nextValue}"`;
}

/**
 * 公開操作をリトライ方針とタイムアウト予算の内側で実行する
 * （要件4.10 / 4.12 / 5.9 / 5.11）。
 *
 * 不変条件:
 * - `operation` の呼び出し回数は `maxAttempts`（既定3）以下である。
 * - 連続する試行の間隔は `minIntervalMs`（既定10000ms）以上である。
 * - `now()` 基準の総経過時間が `budgetMs`（既定600000ms）を超えた時点で中断し、
 *   `result: "failed"` / `reason: "timeout"` を返す。
 * - `preconditions` にひとつでも `ok: false` があれば `operation` を1回も呼ばず、
 *   `attempts: 0` / `result: "failed"` / `reason: "precondition"` を返す。
 * - 再試行するのは分類が `retryable` の場合のみ。`conflict` は `skipped`（重複公開は
 *   ジョブを落とさない。要件4.7 / 5.6）、`auth` と `unknown` は `failed` として即座に確定する。
 *
 * 例外は投げない（`operation` が例外を投げた場合は `unknown` 相当の失敗として扱う）。
 *
 * @param {(attempt: number) => Promise<PublishAttemptOutcome>} operation 1回の公開試行（`attempt` は1始まり）
 * @param {WithRetryOptions} [options] 境界値と時間関数の注入
 * @returns {Promise<RetryOutcome>} 最終結果
 * @see Property 6
 */
export async function withRetry(operation, options) {
  const settings = normalizeRetryOptions(options);
  /** @type {string[]} */
  const logs = [];

  // 事前検証（要件2.6 / 6.3 / 9.10）。ひとつでも失敗があれば `operation` を1回も呼ばない。
  const failedPreconditions = settings.preconditions.filter(
    (precondition) =>
      precondition === null ||
      typeof precondition !== "object" ||
      precondition.ok !== true,
  );

  // `now()` は注入され得るため、例外を投げても全体が失敗しないよう保護する。
  let lastKnownMs = 0;
  const safeNow = () => {
    try {
      const value = settings.now();
      if (typeof value === "number" && Number.isFinite(value)) {
        lastKnownMs = value;
      }
    } catch {
      // 時刻取得に失敗した場合は直近の観測値をそのまま使う（例外は投げない）。
    }
    return lastKnownMs;
  };

  const startedAtMs = safeNow();
  const elapsedMs = () => safeNow() - startedAtMs;

  /** 実際に `operation` を呼び出した回数。 */
  let attempts = 0;
  /** @type {PublishErrorCategory | undefined} 最後の失敗の分類。 */
  let lastCategory;

  /**
   * 最終結果を組み立てる（`attempts` と経過時間は呼び出し時点の値を使う）。
   *
   * @param {PublishStepResult} result
   * @param {RetryOutcome["reason"]} reason
   * @param {PublishErrorCategory | undefined} category
   * @returns {RetryOutcome}
   */
  const finish = (result, reason, category) => ({
    result,
    attempts,
    elapsedMs: elapsedMs(),
    reason,
    category,
    logs,
  });

  if (failedPreconditions.length > 0) {
    for (const precondition of failedPreconditions) {
      logs.push(
        `事前検証に失敗しました: ${preconditionName(precondition)}（${settings.registryLabel} への公開要求は送信しません）`,
      );
    }
    return finish("failed", "precondition", undefined);
  }

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    // 予算を使い切ったあとに新たな試行を開始しない（要件4.12 / 5.9）。
    if (elapsedMs() >= settings.budgetMs) {
      logs.push(
        `総予算 ${settings.budgetMs}ms を超えたため ${settings.registryLabel} への公開を中断しました（試行 ${attempts} 回）`,
      );
      return finish("failed", "timeout", lastCategory);
    }

    attempts = attempt;

    /** @type {PublishAttemptOutcome | undefined} */
    let attemptOutcome;
    try {
      attemptOutcome = await operation(attempt);
    } catch {
      // 公開コマンドの起動自体に失敗した場合は `unknown` 相当として即座に確定させる。
      // 例外の内容はトークン値を含み得るためログへ転記しない。
      lastCategory = "unknown";
      logs.push(
        `${settings.registryLabel} への公開試行 ${attempt} 回目が例外で終了しました（分類: unknown）。再試行しません。`,
      );
      return finish("failed", "unknown", "unknown");
    }

    if (
      attemptOutcome !== null &&
      typeof attemptOutcome === "object" &&
      attemptOutcome.ok === true
    ) {
      logs.push(
        `${settings.registryLabel} への公開に成功しました（試行 ${attempt} 回目）`,
      );
      return finish("success", "succeeded", undefined);
    }

    const stderr =
      attemptOutcome !== null &&
      typeof attemptOutcome === "object" &&
      typeof attemptOutcome.stderr === "string"
        ? attemptOutcome.stderr
        : "";
    const exitCode =
      attemptOutcome !== null &&
      typeof attemptOutcome === "object" &&
      typeof attemptOutcome.exitCode === "number"
        ? attemptOutcome.exitCode
        : 1;

    /** @type {PublishErrorClassification | undefined} */
    let classification;
    try {
      classification = settings.classify(stderr, exitCode);
    } catch {
      // 分類器が例外を投げた場合は `unknown` として扱う（例外は投げない）。
      classification = undefined;
    }

    const category = normalizeErrorCategory(classification);
    lastCategory = category;
    // 標準エラー出力そのものはトークン値を含み得るためログへ転記しない。
    logs.push(
      `${settings.registryLabel} への公開試行 ${attempt} 回目が失敗しました（分類: ${category} / 終了コード: ${exitCode}）`,
    );
    if (
      classification !== null &&
      typeof classification === "object" &&
      typeof classification.instruction === "string" &&
      classification.instruction !== ""
    ) {
      logs.push(classification.instruction);
    }

    // 再試行するのは `retryable` のみ。`conflict` / `auth` / `unknown` は即座に確定させる。
    if (category === "conflict") {
      // 重複公開はジョブを落とさない（要件4.7 / 5.6）。
      return finish("skipped", "conflict", category);
    }
    if (category !== "retryable") {
      return finish("failed", category, category);
    }

    // 予算超過の判定を試行回数の判定より先に行う（打ち切りの理由を `timeout` に寄せる）。
    if (elapsedMs() >= settings.budgetMs) {
      logs.push(
        `総予算 ${settings.budgetMs}ms を超えたため ${settings.registryLabel} への公開を中断しました（試行 ${attempts} 回）`,
      );
      return finish("failed", "timeout", category);
    }
    if (attempt >= settings.maxAttempts) {
      logs.push(
        `最大試行回数 ${settings.maxAttempts} 回に達したため ${settings.registryLabel} への公開を断念しました`,
      );
      return finish("failed", "exhausted", category);
    }

    try {
      await settings.sleep(settings.minIntervalMs);
    } catch {
      // 最小間隔を保証できないため、これ以上の再試行は行わない（例外は投げない）。
      logs.push(
        `待機処理が失敗したため ${settings.registryLabel} への再試行を打ち切りました`,
      );
      return finish("failed", "exhausted", category);
    }
  }

  // ループ内で必ず return するため到達しないが、全域性のための保険とする。
  return finish(
    "failed",
    attempts === 0 ? "timeout" : "exhausted",
    lastCategory,
  );
}

/**
 * `withRetry` のオプションを既定値で補完する（`withRetry` の内部処理）。
 *
 * 不正な値（負値・非整数・非数値）は既定値へ落とす。`0` は有効な
 * `minIntervalMs` / `budgetMs` として尊重する。
 *
 * @param {WithRetryOptions | undefined} options 呼び出し元が渡したオプション
 * @returns {{
 *   maxAttempts: number,
 *   minIntervalMs: number,
 *   budgetMs: number,
 *   preconditions: ReadonlyArray<PublishPrecondition>,
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   classify: (stderr: string, exitCode: number) => PublishErrorClassification,
 *   registryLabel: string,
 * }} 補完済みの設定
 */
function normalizeRetryOptions(options) {
  const source = options !== null && typeof options === "object" ? options : {};

  return {
    maxAttempts: positiveIntegerOr(source.maxAttempts, DEFAULT_MAX_ATTEMPTS),
    minIntervalMs: nonNegativeNumberOr(
      source.minIntervalMs,
      DEFAULT_MIN_INTERVAL_MS,
    ),
    budgetMs: nonNegativeNumberOr(source.budgetMs, DEFAULT_BUDGET_MS),
    preconditions: Array.isArray(source.preconditions)
      ? source.preconditions
      : [],
    now: typeof source.now === "function" ? source.now : Date.now,
    sleep: typeof source.sleep === "function" ? source.sleep : defaultSleep,
    classify:
      typeof source.classify === "function"
        ? source.classify
        : classifyPublishError,
    registryLabel:
      typeof source.registryLabel === "string" && source.registryLabel !== ""
        ? source.registryLabel
        : DEFAULT_REGISTRY_LABEL,
  };
}

/**
 * 正の整数ならその値を、そうでなければ既定値を返す。
 *
 * @param {unknown} value 検査する値
 * @param {number} fallback 既定値
 * @returns {number} 採用する値
 */
function positiveIntegerOr(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * 0以上の有限数ならその値を、そうでなければ既定値を返す。
 *
 * @param {unknown} value 検査する値
 * @param {number} fallback 既定値
 * @returns {number} 採用する値
 */
function nonNegativeNumberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * 事前検証条件のログ用表示名を求める（`withRetry` の内部処理）。
 *
 * @param {unknown} precondition 事前検証条件
 * @returns {string} ログに含める名称
 */
function preconditionName(precondition) {
  if (
    precondition !== null &&
    typeof precondition === "object" &&
    typeof precondition.name === "string" &&
    precondition.name !== ""
  ) {
    return precondition.name;
  }
  return "(名称未設定の事前検証)";
}

/**
 * 分類器の返り値から分類を取り出す（`withRetry` の内部処理）。
 * 4値のいずれでもない場合は `unknown` として扱う。
 *
 * @param {unknown} classification 分類器の返り値
 * @returns {PublishErrorCategory} 分類
 */
function normalizeErrorCategory(classification) {
  const category =
    classification !== null && typeof classification === "object"
      ? classification.category
      : undefined;

  return PUBLISH_ERROR_CATEGORIES.includes(category) ? category : "unknown";
}

/**
 * `withRetry` の既定の待機処理（`setTimeout` によるスリープ）。
 * Node.js組込みのグローバル `setTimeout` のみを使う（外部依存を持たない制約）。
 *
 * @param {number} ms 待機するミリ秒
 * @returns {Promise<void>} 待機完了
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Package_Manifest の単一フィールドを書き換えた新しいオブジェクトを返す（要件5.2 / 6.1）。
 *
 * 入力オブジェクトを破壊せず、対象フィールドのみを新しい値へ変更する。
 * それ以外のすべてのキーと値（および既存キーの並び順）を保持し、
 * JSONとしての往復（`JSON.parse(JSON.stringify(result))`）が成立する。
 * 対象フィールドが存在しない場合は末尾に追加する。
 *
 * 値のコピーは浅い（入れ子のオブジェクトや配列は入力と同一の参照を共有する）。
 * 本関数は入力・返り値のいずれも変更しないため、`package.json` の読み書きに
 * 用いる限りこの共有は観測できない。
 *
 * @param {Readonly<Record<string, unknown>>} manifest パース済みの `package.json` 相当のオブジェクト
 * @param {string} field 書き換えるフィールド名（`version` / `name`）
 * @param {string} value 新しい値
 * @returns {Record<string, unknown>} 書き換え後の新しいオブジェクト
 * @throws {TypeError} `manifest` がオブジェクト（配列を除く）でない場合、または `field` が空でない文字列でない場合
 * @see Property 8
 */
export function setPackageField(manifest, field, value) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  ) {
    throw new TypeError(
      `setPackageField: manifest はオブジェクトでなければなりません（実際の型: ${manifest === null ? "null" : Array.isArray(manifest) ? "array" : typeof manifest}）`,
    );
  }
  if (typeof field !== "string" || field === "") {
    throw new TypeError(
      `setPackageField: field は空でない文字列でなければなりません（実際の値: ${JSON.stringify(field)}）`,
    );
  }

  /** @type {Record<string, unknown>} */
  const result = {};
  let replaced = false;

  // `Object.keys` の順序（自前の列挙可能な文字列キーの挿入順）をそのまま再現する。
  // これにより既存キーの並び順が保たれ、対象フィールドは元の位置で値だけが変わる。
  for (const key of Object.keys(manifest)) {
    const nextValue = key === field ? value : manifest[key];
    if (key === field) {
      replaced = true;
    }
    defineOwnField(result, key, nextValue);
  }

  // 対象フィールドが存在しない場合は末尾に追加する。
  if (!replaced) {
    defineOwnField(result, field, value);
  }

  return result;
}

/**
 * 自前の列挙可能プロパティとして値を定義する（`setPackageField` の内部処理）。
 *
 * 代入（`obj[key] = value`）ではなく `Object.defineProperty` を使うのは、
 * `__proto__` のようなキーが代入ではプロトタイプ設定として解釈され、
 * 自前キーとして保持されない（=「他のすべてのキーを保持する」に反する）ためである。
 *
 * @param {Record<string, unknown>} target 書き込み先
 * @param {string} key キー
 * @param {unknown} value 値
 * @returns {void}
 */
function defineOwnField(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

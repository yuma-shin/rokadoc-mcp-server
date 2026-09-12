/**
 * `scripts/lib/release.mjs` に対する手書きの型宣言。
 *
 * `module: NodeNext` の解決規則により、`release.mjs` への import は
 * 同一ディレクトリの `release.d.mts` から型を得る（タスク1.3の決定）。
 * 実装（`.mjs`）のシグネチャを変更したら本ファイルも必ず同期させる。
 * 自動同期の仕組みは持たないため、レビュー時の確認事項とする。
 *
 * 実装本体は後続タスク（2.3 / 2.5 / 2.7 / 2.9 / 2.11）で追加する。
 * 本ファイルはタスク2.1で定義した公開APIの全量である。
 */

/**
 * Registry_Publish_Step の結果。
 *
 * - `success`: 当該レジストリへ公開完了
 * - `skipped`: 公開要求を送信せず正常終了（同一バージョンが公開済み等）
 * - `failed`: 公開できなかった
 */
export type PublishStepResult = "success" | "skipped" | "failed";

/** 公開失敗の分類（要件5.8 / 4.10 / 5.11）。 */
export type PublishErrorCategory =
  | "retryable"
  | "conflict"
  | "auth"
  | "unknown";

/** タグからのバージョン導出に成功した結果。 */
export interface VersionDerivationSuccess {
  readonly ok: true;
  /** 先頭の `v` をちょうど1個除去した値（例: `1.0.7`）。 */
  readonly version: string;
}

/**
 * タグからのバージョン導出を拒否した結果。
 * 要件6.3 / 6.7 に従い、実際のタグ値と期待形式の双方を必ず含む。
 */
export interface VersionDerivationFailure {
  readonly ok: false;
  /** 入力された実際のタグ値。 */
  readonly tag: string;
  /** 期待する形式（`v<major>.<minor>.<patch>`）。 */
  readonly expectedFormat: string;
  /** `tag` と `expectedFormat` の双方を部分文字列として含むログ用メッセージ。 */
  readonly message: string;
}

export type VersionDerivationResult =
  | VersionDerivationSuccess
  | VersionDerivationFailure;

/** `classifyPublishError` の返り値。 */
export interface PublishErrorClassification {
  /** 分類結果（4値のいずれか1つ）。 */
  readonly category: PublishErrorCategory;
  /** 再試行してよいか。`conflict` / `auth` では常に `false`。 */
  readonly retryable: boolean;
  /**
   * 運用者向けの処理指示。
   * `auth` の場合でも取り下げ操作（`unpublish` / `deprecate`）を含めない。
   */
  readonly instruction: string;
}

/** 1回の公開試行が成功した結果。 */
export interface PublishAttemptSuccess {
  readonly ok: true;
}

/** 1回の公開試行が失敗した結果。 */
export interface PublishAttemptFailure {
  readonly ok: false;
  /** 標準エラー出力（`classifyPublishError` に渡す）。 */
  readonly stderr: string;
  /** 終了コード（`124` は `timeout` による打ち切り）。 */
  readonly exitCode: number;
}

export type PublishAttemptOutcome =
  | PublishAttemptSuccess
  | PublishAttemptFailure;

/**
 * `withRetry` の事前検証条件。ひとつでも `ok: false` があれば
 * 公開操作を1回も呼び出さずに `failed` を確定させる（要件2.6 / 6.3 / 9.10）。
 */
export interface PublishPrecondition {
  /** 条件名（例: `tag-format` / `build-artifact` / `npm-readme`）。 */
  readonly name: string;
  readonly ok: boolean;
}

/**
 * `withRetry` のオプション。時間関連はすべて注入可能とし、
 * テストで実時間の待機を発生させない（`vi.useFakeTimers()` と併用する）。
 */
export interface WithRetryOptions {
  /** 最大試行回数（既定 `3`。要件4.10 / 5.11）。 */
  readonly maxAttempts?: number;
  /** 連続する試行の最小間隔（ミリ秒。既定 `10000`。要件4.10）。 */
  readonly minIntervalMs?: number;
  /** 1レジストリあたりの総予算（ミリ秒。既定 `600000`。要件4.12 / 5.9）。 */
  readonly budgetMs?: number;
  /** 事前検証条件。 */
  readonly preconditions?: ReadonlyArray<PublishPrecondition>;
  /** 現在時刻の取得（既定: `Date.now`）。 */
  readonly now?: () => number;
  /** 待機処理（既定: `setTimeout` による待機）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** エラー分類（既定: `classifyPublishError`）。 */
  readonly classify?: (
    stderr: string,
    exitCode: number,
  ) => PublishErrorClassification;
  /** ログに含めるレジストリ名。 */
  readonly registryLabel?: string;
}

/** `withRetry` の最終結果。 */
export interface RetryOutcome {
  /** Registry_Publish_Step に記録する結果。 */
  readonly result: PublishStepResult;
  /**
   * 公開操作を実際に呼び出した回数（`maxAttempts` 以下。
   * 事前検証失敗時は `0`）。
   */
  readonly attempts: number;
  /** `now()` 基準の総経過時間（ミリ秒）。 */
  readonly elapsedMs: number;
  /** 結果の理由。 */
  readonly reason:
    | "succeeded"
    | "conflict"
    | "auth"
    | "unknown"
    | "exhausted"
    | "timeout"
    | "precondition";
  /** 最後の失敗の分類（失敗していない場合は `undefined`）。 */
  readonly category?: PublishErrorCategory;
  /** 出力すべきログ行（トークン値を含まない）。 */
  readonly logs: ReadonlyArray<string>;
}

/**
 * Release_Tag（例: `v1.0.7`）から Package_Version（例: `1.0.7`）を導出する。
 *
 * `^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$` に
 * 完全一致する場合のみ成功とし、先頭の `v` をちょうど1個だけ除去した値を返す。
 * 例外は投げない（全域関数）。
 *
 * 検証対象: Property 1 / Property 2（要件6.1 / 6.3 / 6.6 / 6.7）
 */
export declare function deriveVersionFromTag(
  tag: unknown,
): VersionDerivationResult;

/**
 * 2つの Package_Version を3要素の数値タプルの辞書式順序で比較する。
 * 全順序（反射性・反対称性・推移性）を満たす。
 *
 * 入力が `<major>.<minor>.<patch>` 形式でない場合は `TypeError` を投げる。
 *
 * 検証対象: Property 11（要件3.3）
 */
export declare function compareSemver(a: string, b: string): -1 | 0 | 1;

/**
 * 相対パスが Package_Tarball に収録されるかを判定する。
 * 真になるのは `dist/` 配下・`package.json` / `README.md` / `LICENSE.md` に限られる。
 *
 * 検証対象: Property 3（要件2.2 / 2.3 / 2.4）
 */
export declare function isPackagedPath(path: unknown): boolean;

/**
 * 全 Registry_Publish_Step の結果からジョブの終了コードを集約する。
 * `failed` がひとつでもあれば `1`、すべてが `success` / `skipped` なら `0`。
 *
 * 検証対象: Property 5（要件5.7）
 */
export declare function aggregateExitCode(
  results: ReadonlyArray<PublishStepResult>,
): 0 | 1;

/**
 * Registry_Credential が「未設定」として扱われるかを判定する。
 * 空文字列・空白文字のみの文字列・非文字列に対して `true` を返す。
 *
 * 検証対象: Property 7（要件4.9 / 4.5）
 */
export declare function isBlankToken(token: unknown): boolean;

/**
 * 公開失敗の標準エラー出力と終了コードから失敗の種類を分類する。
 * `conflict` / `auth` は常に `retryable: false`。
 * `auth` の `instruction` に取り下げ操作（`unpublish` / `deprecate`）を含めない。
 *
 * 検証対象: Property 9（要件5.8 / 4.10 / 5.11）
 */
export declare function classifyPublishError(
  stderr: string,
  exitCode: number,
): PublishErrorClassification;

/**
 * 公開成功ログを整形する。返り値は `packageName` と `version` を
 * 必ず部分文字列として含む。
 *
 * 検証対象: Property 10（要件4.11 / 5.10）
 */
export declare function formatPublishSuccessLog(
  packageName: string,
  version: string,
  registryLabel?: string,
): string;

/**
 * Package_Manifest のフィールド書き換えログを整形する。
 * 返り値は書き換え前後の値の双方を必ず部分文字列として含む。
 *
 * 検証対象: Property 10（要件6.5）
 */
export declare function formatVersionRewriteLog(
  previousValue: string,
  nextValue: string,
  field?: string,
): string;

/**
 * 公開操作をリトライ方針とタイムアウト予算の内側で実行する。
 * 呼び出し回数は `maxAttempts` 以下、間隔は `minIntervalMs` 以上、
 * 総経過時間が `budgetMs` を超えた時点で中断して `failed` を返す。
 * 例外は投げない。
 *
 * 検証対象: Property 6（要件4.10 / 4.12 / 5.9 / 5.11）
 */
export declare function withRetry(
  operation: (attempt: number) => Promise<PublishAttemptOutcome>,
  options?: WithRetryOptions,
): Promise<RetryOutcome>;

/**
 * Package_Manifest の単一フィールドを書き換えた新しいオブジェクトを返す。
 * 対象フィールド以外のすべてのキーと値、および既存キーの並び順を保持する。
 *
 * 検証対象: Property 8（要件5.2 / 6.1）
 */
export declare function setPackageField(
  manifest: Readonly<Record<string, unknown>>,
  field: string,
  value: string,
): Record<string, unknown>;

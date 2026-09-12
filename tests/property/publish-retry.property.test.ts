/**
 * 公開処理のリトライ方針・タイムアウト予算・事前検証ゲートのプロパティベーステスト。
 *
 * Feature: npm-package-distribution
 * Property 6: リトライとタイムアウトの方針は常に境界内に収まる
 *
 * **Validates: Requirements 2.6, 4.10, 4.12, 5.9, 5.11, 6.3, 9.10**
 *
 * 時間関連はすべて `withRetry` のフック（`now` / `sleep`）に仮想クロックを注入して
 * 制御し、実時間の待機を一切発生させない。あわせて `vi.useFakeTimers()` を有効化し、
 * 実装が誤って実タイマーへ依存した場合にも実時間を消費しないことを担保する。
 *
 * 分類ロジック（`classifyPublishError`。タスク2.7）への依存を避けるため、
 * `classify` フックにテスト内のモデル分類器を注入する。本ファイルが検証するのは
 * `withRetry` の境界条件のみである。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fc from "fast-check";
import { withRetry } from "../../scripts/lib/release.mjs";
import type {
  PublishAttemptOutcome,
  PublishErrorCategory,
  PublishErrorClassification,
  PublishPrecondition,
} from "../../scripts/lib/release.mjs";

/** 既定の境界値（`scripts/lib/release.mjs` の既定オプションと同じ値）。 */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MIN_INTERVAL_MS = 10_000;
const DEFAULT_BUDGET_MS = 600_000;

const REGISTRY_LABEL = "Public_NPM_Registry";

/** 疑似的な標準エラー出力に埋め込む分類マーカー。 */
const STDERR_MARKER = "mock-category";

const markStderr = (category: PublishErrorCategory): string =>
  `npm ERR! ${STDERR_MARKER}=${category} 疑似的な公開失敗出力`;

const classificationOf = (
  category: PublishErrorCategory,
): PublishErrorClassification => ({
  category,
  retryable: category === "retryable",
  instruction: `疑似分類 ${category} に対する処理指示`,
});

/**
 * `withRetry` に注入するモデル分類器。
 * 終了コード124（`timeout` による打ち切り）は再試行可能として扱う。
 */
const classify = (
  stderr: string,
  exitCode: number,
): PublishErrorClassification => {
  if (exitCode === 124) {
    return classificationOf("retryable");
  }
  const categories: readonly PublishErrorCategory[] = [
    "retryable",
    "conflict",
    "auth",
    "unknown",
  ];
  for (const category of categories) {
    if (stderr.includes(`${STDERR_MARKER}=${category}`)) {
      return classificationOf(category);
    }
  }
  return classificationOf("unknown");
};

/** 1回の公開試行の振る舞い指定。 */
type AttemptKind =
  | "ok"
  | "retryable"
  | "conflict"
  | "auth"
  | "unknown"
  | "throw";

interface AttemptSpec {
  readonly kind: AttemptKind;
  /** 当該試行が仮想クロック上で消費する時間。 */
  readonly durationMs: number;
}

/** 実際に観測された1回の試行。 */
interface AttemptRecord {
  /** `operation` に渡された `attempt` 引数（1始まりであることを期待する）。 */
  readonly attemptArg: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly ok: boolean;
  /** 予算切れによる打ち切りを織り込んだ実効分類（成功時は `undefined`）。 */
  readonly effectiveCategory: PublishErrorCategory | undefined;
}

const categoryOf = (kind: AttemptKind): PublishErrorCategory | undefined => {
  switch (kind) {
    case "ok":
      return undefined;
    // 例外を投げた試行は `unknown` 相当の失敗として扱われる。
    case "throw":
      return "unknown";
    default:
      return kind;
  }
};

interface Harness {
  readonly operation: (attempt: number) => Promise<PublishAttemptOutcome>;
  readonly records: readonly AttemptRecord[];
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** 仮想クロックの現在値。 */
  readonly currentMs: () => number;
}

/**
 * 仮想クロック上で動作する公開試行を組み立てる。
 *
 * 実運用の `timeout <残予算> npm publish` を模して、指定所要時間が残予算を
 * 超える場合は残予算だけ消費し、終了コード124の失敗を返す。
 */
const createHarness = (
  specs: readonly AttemptSpec[],
  baseMs: number,
  budgetMs: number,
): Harness => {
  const clock = { current: baseMs };
  const records: AttemptRecord[] = [];

  const now = (): number => clock.current;
  const sleep = async (ms: number): Promise<void> => {
    clock.current += Math.max(0, ms);
  };

  const operation = async (attempt: number): Promise<PublishAttemptOutcome> => {
    const spec = specs[records.length % specs.length] as AttemptSpec;
    const startMs = clock.current;
    const remainingMs = Math.max(0, budgetMs - (startMs - baseMs));
    const consumedMs = Math.min(spec.durationMs, remainingMs);
    clock.current = startMs + consumedMs;

    const timedOut = consumedMs < spec.durationMs;
    const ok = !timedOut && spec.kind === "ok";
    records.push({
      attemptArg: attempt,
      startMs,
      endMs: clock.current,
      ok,
      effectiveCategory: timedOut ? "retryable" : categoryOf(spec.kind),
    });

    if (timedOut) {
      return { ok: false, stderr: markStderr("retryable"), exitCode: 124 };
    }
    if (spec.kind === "throw") {
      throw new Error("公開コマンドの起動に失敗しました");
    }
    if (spec.kind === "ok") {
      return { ok: true };
    }
    return { ok: false, stderr: markStderr(spec.kind), exitCode: 1 };
  };

  return {
    operation,
    records,
    now,
    sleep,
    currentMs: () => clock.current,
  };
};

const attemptKindArb = fc.constantFrom<AttemptKind>(
  "ok",
  "retryable",
  "conflict",
  "auth",
  "unknown",
  "throw",
);

const attemptSpecArb = (maxDurationMs: number): fc.Arbitrary<AttemptSpec> =>
  fc.record({
    kind: attemptKindArb,
    durationMs: fc.integer({ min: 0, max: maxDurationMs }),
  });

/** `now()` の基準時刻。絶対時刻への依存がないことを確かめるため任意値とする。 */
const baseMsArb = fc.integer({ min: 0, max: 5_000_000 });

describe("Feature: npm-package-distribution, Property 6: リトライとタイムアウトの方針は常に境界内に収まる", () => {
  beforeEach(() => {
    // 実装が誤って実タイマーへ依存しても実時間を消費しないようにする。
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * **Validates: Requirements 4.10, 4.12, 5.9, 5.11**
   *
   * 任意の成功・失敗パターン列と任意の所要時間列に対して、
   * 試行回数・試行間隔・総予算の境界がすべて守られ、例外が投げられない。
   */
  it(
    "任意の試行パターンに対して試行回数・間隔・予算の境界を常に守り例外を投げない",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            baseMs: baseMsArb,
            maxAttempts: fc.integer({ min: 1, max: 5 }),
            minIntervalMs: fc.constantFrom(0, 1, 1_000, 10_000, 30_000),
            budgetMs: fc.constantFrom(1_000, 60_000, 600_000, 1_200_000),
            specs: fc.array(attemptSpecArb(400_000), {
              minLength: 1,
              maxLength: 6,
            }),
          }),
          async (config) => {
            const harness = createHarness(
              config.specs,
              config.baseMs,
              config.budgetMs,
            );

            const outcome = await withRetry(harness.operation, {
              maxAttempts: config.maxAttempts,
              minIntervalMs: config.minIntervalMs,
              budgetMs: config.budgetMs,
              now: harness.now,
              sleep: harness.sleep,
              classify,
              registryLabel: REGISTRY_LABEL,
            });

            const records = harness.records;

            // 結果の形状
            expect(["success", "skipped", "failed"]).toContain(outcome.result);
            expect([
              "succeeded",
              "conflict",
              "auth",
              "unknown",
              "exhausted",
              "timeout",
              "precondition",
            ]).toContain(outcome.reason);
            expect(Array.isArray(outcome.logs)).toBe(true);
            for (const line of outcome.logs) {
              expect(typeof line).toBe("string");
            }

            // 試行回数は maxAttempts 以下。予算が正なので最低1回は試行する。
            expect(outcome.attempts).toBe(records.length);
            expect(outcome.attempts).toBeLessThanOrEqual(config.maxAttempts);
            expect(outcome.attempts).toBeGreaterThanOrEqual(1);

            // `attempt` 引数は1始まりの連番
            records.forEach((record, index) => {
              expect(record.attemptArg).toBe(index + 1);
            });

            // 予算を使い切った後に新たな試行を開始しない
            for (const record of records) {
              expect(record.startMs - config.baseMs).toBeLessThan(
                config.budgetMs,
              );
            }

            // 連続する試行の間隔は minIntervalMs 以上
            for (let i = 1; i < records.length; i += 1) {
              const gapMs =
                (records[i] as AttemptRecord).startMs -
                (records[i - 1] as AttemptRecord).endMs;
              expect(gapMs).toBeGreaterThanOrEqual(config.minIntervalMs);
            }

            // 再試行するのは分類が retryable の失敗の場合のみ。
            // したがって最終試行以外はすべて retryable な失敗である。
            for (let i = 0; i < records.length - 1; i += 1) {
              const record = records[i] as AttemptRecord;
              expect(record.ok).toBe(false);
              expect(record.effectiveCategory).toBe("retryable");
            }

            // 経過時間は仮想クロックと整合し、予算超過は timeout として確定する
            const lastRecord = records[records.length - 1] as AttemptRecord;
            expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
              lastRecord.endMs - config.baseMs,
            );
            expect(outcome.elapsedMs).toBeLessThanOrEqual(
              harness.currentMs() - config.baseMs,
            );
            if (outcome.elapsedMs > config.budgetMs) {
              expect(outcome.result).toBe("failed");
              expect(outcome.reason).toBe("timeout");
            }

            // 最終試行の実効分類と結果の対応
            if (lastRecord.ok) {
              expect(outcome.result).toBe("success");
              expect(outcome.reason).toBe("succeeded");
              expect(outcome.category).toBeUndefined();
            } else {
              expect(outcome.category).toBe(lastRecord.effectiveCategory);
              switch (lastRecord.effectiveCategory) {
                case "conflict":
                  expect(outcome.result).toBe("skipped");
                  expect(outcome.reason).toBe("conflict");
                  break;
                case "auth":
                  expect(outcome.result).toBe("failed");
                  expect(outcome.reason).toBe("auth");
                  break;
                case "unknown":
                  expect(outcome.result).toBe("failed");
                  expect(outcome.reason).toBe("unknown");
                  break;
                default:
                  // retryable な失敗で終わるのは、試行を使い切った場合か
                  // 予算を使い切った場合のみ
                  expect(outcome.result).toBe("failed");
                  expect(["exhausted", "timeout"]).toContain(outcome.reason);
                  if (outcome.reason === "exhausted") {
                    expect(outcome.attempts).toBe(config.maxAttempts);
                  }
                  break;
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );

  /**
   * **Validates: Requirements 4.12, 5.9**
   *
   * 総経過時間が予算を超えた時点で中断し、`failed` / `timeout` を返す。
   */
  it(
    "予算を超過した時点で中断して failed / timeout を返す",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            baseMs: baseMsArb,
            maxAttempts: fc.integer({ min: 1, max: 5 }),
            minIntervalMs: fc.constantFrom(0, 1_000, 10_000),
            budgetMs: fc.integer({ min: 1_000, max: 600_000 }),
            overshootMs: fc.integer({ min: 1, max: 100_000 }),
          }),
          async (config) => {
            const harness = createHarness(
              [
                {
                  kind: "retryable",
                  durationMs: config.budgetMs + config.overshootMs,
                },
              ],
              config.baseMs,
              config.budgetMs,
            );

            const outcome = await withRetry(harness.operation, {
              maxAttempts: config.maxAttempts,
              minIntervalMs: config.minIntervalMs,
              budgetMs: config.budgetMs,
              now: harness.now,
              sleep: harness.sleep,
              classify,
              registryLabel: REGISTRY_LABEL,
            });

            expect(outcome.result).toBe("failed");
            expect(outcome.reason).toBe("timeout");
            // 最初の試行で予算を使い切るため、以降の試行は開始されない
            expect(outcome.attempts).toBe(1);
            expect(harness.records).toHaveLength(1);
            expect(outcome.elapsedMs).toBeGreaterThanOrEqual(config.budgetMs);
            expect(outcome.logs.some((line) => line.includes(REGISTRY_LABEL))).toBe(
              true,
            );
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );

  /**
   * **Validates: Requirements 4.10, 5.11**
   *
   * 再試行するのは分類が `retryable` の場合のみ。
   * `conflict` は即座に `skipped`、`auth` / `unknown` は即座に `failed` となる。
   */
  it(
    "retryable 以外の分類では1回の試行で確定する",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            baseMs: baseMsArb,
            maxAttempts: fc.integer({ min: 2, max: 5 }),
            kind: fc.constantFrom<AttemptKind>("conflict", "auth", "unknown"),
            durationMs: fc.integer({ min: 0, max: 1_000 }),
          }),
          async (config) => {
            const harness = createHarness(
              [{ kind: config.kind, durationMs: config.durationMs }],
              config.baseMs,
              DEFAULT_BUDGET_MS,
            );

            const outcome = await withRetry(harness.operation, {
              maxAttempts: config.maxAttempts,
              minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
              budgetMs: DEFAULT_BUDGET_MS,
              now: harness.now,
              sleep: harness.sleep,
              classify,
              registryLabel: REGISTRY_LABEL,
            });

            expect(outcome.attempts).toBe(1);
            expect(harness.records).toHaveLength(1);
            expect(outcome.category).toBe(config.kind);
            if (config.kind === "conflict") {
              expect(outcome.result).toBe("skipped");
              expect(outcome.reason).toBe("conflict");
            } else {
              expect(outcome.result).toBe("failed");
              expect(outcome.reason).toBe(config.kind);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );

  /**
   * **Validates: Requirements 4.10, 4.12, 5.9, 5.11**
   *
   * `retryable` な失敗が続く場合は最大試行回数まで再試行して `exhausted` で確定し、
   * 途中で成功した場合はその時点で打ち切る。オプション省略時は既定の境界値
   * （最大3回 / 間隔10000ms / 予算600000ms）が適用される。
   */
  it(
    "retryable な失敗は最大試行回数まで再試行し、成功時点で打ち切る",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            baseMs: baseMsArb,
            useDefaults: fc.boolean(),
            maxAttempts: fc.integer({ min: 1, max: 5 }),
            minIntervalMs: fc.constantFrom(0, 1_000, 10_000, 45_000),
            succeedAtRatio: fc.double({
              min: 0,
              max: 1,
              noNaN: true,
            }),
            eventuallySucceeds: fc.boolean(),
            durationMs: fc.integer({ min: 0, max: 1_000 }),
          }),
          async (config) => {
            const maxAttempts = config.useDefaults
              ? DEFAULT_MAX_ATTEMPTS
              : config.maxAttempts;
            const minIntervalMs = config.useDefaults
              ? DEFAULT_MIN_INTERVAL_MS
              : config.minIntervalMs;

            // 成功する試行番号（1始まり）。成功しない場合は maxAttempts + 1 とする。
            const succeedAt = config.eventuallySucceeds
              ? Math.min(
                  maxAttempts,
                  Math.max(1, Math.ceil(config.succeedAtRatio * maxAttempts)),
                )
              : maxAttempts + 1;

            const specs: AttemptSpec[] = [];
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
              specs.push({
                kind: attempt === succeedAt ? "ok" : "retryable",
                durationMs: config.durationMs,
              });
            }

            const harness = createHarness(
              specs,
              config.baseMs,
              DEFAULT_BUDGET_MS,
            );

            const outcome = await withRetry(
              harness.operation,
              config.useDefaults
                ? {
                    now: harness.now,
                    sleep: harness.sleep,
                    classify,
                    registryLabel: REGISTRY_LABEL,
                  }
                : {
                    maxAttempts,
                    minIntervalMs,
                    budgetMs: DEFAULT_BUDGET_MS,
                    now: harness.now,
                    sleep: harness.sleep,
                    classify,
                    registryLabel: REGISTRY_LABEL,
                  },
            );

            const expectedAttempts = Math.min(succeedAt, maxAttempts);
            expect(outcome.attempts).toBe(expectedAttempts);
            expect(harness.records).toHaveLength(expectedAttempts);
            expect(outcome.attempts).toBeLessThanOrEqual(maxAttempts);

            // 連続する試行の間隔は minIntervalMs 以上
            for (let i = 1; i < harness.records.length; i += 1) {
              const gapMs =
                (harness.records[i] as AttemptRecord).startMs -
                (harness.records[i - 1] as AttemptRecord).endMs;
              expect(gapMs).toBeGreaterThanOrEqual(minIntervalMs);
            }
            expect(outcome.elapsedMs).toBeGreaterThanOrEqual(
              (expectedAttempts - 1) * minIntervalMs,
            );

            if (succeedAt <= maxAttempts) {
              expect(outcome.result).toBe("success");
              expect(outcome.reason).toBe("succeeded");
            } else {
              expect(outcome.result).toBe("failed");
              expect(outcome.reason).toBe("exhausted");
              expect(outcome.category).toBe("retryable");
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );

  /**
   * **Validates: Requirements 2.6, 6.3, 9.10**
   *
   * 事前検証（タグ形式 / Build_Artifact / NPM_Readme）にひとつでも失敗があれば、
   * 公開関数は1回も呼び出されず `failed` / `precondition` で確定する。
   * すべて成功している場合は通常どおり公開処理へ進む。
   */
  it(
    "事前検証に失敗した場合は公開関数を1回も呼び出さない",
    async () => {
      const preconditionNameArb = fc.constantFrom(
        "tag-format",
        "build-artifact",
        "npm-readme",
      );

      const failingPreconditionsArb: fc.Arbitrary<PublishPrecondition[]> = fc
        .array(
          fc.record({ name: preconditionNameArb, ok: fc.boolean() }),
          { minLength: 1, maxLength: 4 },
        )
        .chain((preconditions) =>
          fc
            .integer({ min: 0, max: preconditions.length - 1 })
            .map((failingIndex) =>
              preconditions.map((precondition, index) =>
                index === failingIndex
                  ? { ...precondition, ok: false }
                  : precondition,
              ),
            ),
        );

      await fc.assert(
        fc.asyncProperty(
          baseMsArb,
          failingPreconditionsArb,
          async (baseMs, preconditions) => {
            const harness = createHarness(
              [{ kind: "ok", durationMs: 0 }],
              baseMs,
              DEFAULT_BUDGET_MS,
            );

            const outcome = await withRetry(harness.operation, {
              preconditions,
              now: harness.now,
              sleep: harness.sleep,
              classify,
              registryLabel: REGISTRY_LABEL,
            });

            expect(harness.records).toHaveLength(0);
            expect(outcome.attempts).toBe(0);
            expect(outcome.result).toBe("failed");
            expect(outcome.reason).toBe("precondition");

            const failedName = preconditions.find(
              (precondition) => !precondition.ok,
            )?.name as string;
            expect(
              outcome.logs.some((line) => line.includes(failedName)),
            ).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );

  /**
   * **Validates: Requirements 2.6, 6.3, 9.10**
   *
   * 事前検証がすべて成功している場合は公開処理を実行する（対照条件）。
   */
  it(
    "事前検証がすべて成功している場合は公開処理を実行する",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          baseMsArb,
          fc.array(
            fc.constantFrom("tag-format", "build-artifact", "npm-readme"),
            { minLength: 0, maxLength: 3 },
          ),
          async (baseMs, names) => {
            const harness = createHarness(
              [{ kind: "ok", durationMs: 0 }],
              baseMs,
              DEFAULT_BUDGET_MS,
            );

            const outcome = await withRetry(harness.operation, {
              preconditions: names.map((name) => ({ name, ok: true })),
              now: harness.now,
              sleep: harness.sleep,
              classify,
              registryLabel: REGISTRY_LABEL,
            });

            expect(outcome.attempts).toBe(1);
            expect(harness.records).toHaveLength(1);
            expect(outcome.result).toBe("success");
            expect(outcome.reason).toBe("succeeded");
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );

  /**
   * **Validates: Requirements 4.10, 5.11**
   *
   * `operation` が例外を投げても `withRetry` は例外を投げず、
   * `unknown` 相当の失敗として確定する。
   */
  it(
    "operation が例外を投げても withRetry は例外を投げない",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          baseMsArb,
          fc.integer({ min: 1, max: 5 }),
          async (baseMs, maxAttempts) => {
            const harness = createHarness(
              [{ kind: "throw", durationMs: 0 }],
              baseMs,
              DEFAULT_BUDGET_MS,
            );

            const outcome = await withRetry(harness.operation, {
              maxAttempts,
              minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
              budgetMs: DEFAULT_BUDGET_MS,
              now: harness.now,
              sleep: harness.sleep,
              classify,
              registryLabel: REGISTRY_LABEL,
            });

            expect(outcome.attempts).toBe(1);
            expect(outcome.result).toBe("failed");
            expect(outcome.reason).toBe("unknown");
            expect(outcome.category).toBe("unknown");
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );
});

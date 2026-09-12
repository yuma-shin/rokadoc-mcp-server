/**
 * 公開結果モデルのプロパティベーステスト（Property 5, 7, 9, 10）
 *
 * Feature: npm-package-distribution
 * Validates: Requirements 4.5, 4.7, 4.9, 4.10, 4.11, 5.1, 5.6, 5.7, 5.8, 5.10, 5.11, 6.5
 *
 * 対象は `scripts/lib/release.mjs` の純関数
 * （`aggregateExitCode` / `isBlankToken` / `classifyPublishError` /
 * `formatPublishSuccessLog` / `formatVersionRewriteLog`）である。
 * ワークフローYAML側のStep構造は純関数ではないため、上記の純関数を組み合わせた
 * 最小のモデル（`runRegistryPublishStep`）を本ファイル内に置き、
 * 「公開要求が送信されないこと」「Step 2 が Step 1 の結果に依らず実行されること」を
 * 呼び出し回数として観測する。
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  aggregateExitCode,
  classifyPublishError,
  formatPublishSuccessLog,
  formatVersionRewriteLog,
  isBlankToken,
} from "../../scripts/lib/release.mjs";
import type { PublishStepResult } from "../../scripts/lib/release.mjs";

/** Registry_Publish_Step の結果の全域（3値）。 */
const STEP_RESULTS: readonly PublishStepResult[] = [
  "success",
  "skipped",
  "failed",
];

/** 公開済みバージョン照会（`probe_published`）の3状態。 */
type ProbeResult = "published" | "not-published" | "unknown";

/** 1回の公開試行の結果。 */
type PublishOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly stderr: string; readonly exitCode: number };

interface StepModelInput {
  readonly token: unknown;
  readonly probe: ProbeResult;
  readonly packageName: string;
  readonly version: string;
  readonly registryLabel: string;
  readonly publish?: () => PublishOutcome;
}

interface StepModelOutcome {
  readonly result: PublishStepResult;
  /** `npm publish` に相当する公開要求を実際に送信した回数。 */
  readonly publishCalls: number;
  readonly logs: readonly string[];
}

/**
 * Registry_Publish_Step（`publish-npm.yml` のStep 1 / Step 2）の最小モデル。
 *
 * 判断はすべて `scripts/lib/release.mjs` の純関数に委ねる。
 * ここに独自の判定ロジックを持たせない（持たせるとテストが自作ロジックの
 * 検証になってしまう）。
 *
 * - Registry_Credential が未設定（`isBlankToken`）なら公開要求を送信せず `failed`（要件4.9）
 * - 照会結果が「公開済み」なら公開要求を送信せず `skipped`（要件4.7 / 5.6）
 * - 公開失敗時の確定は `classifyPublishError` の分類に従う（要件5.8 / 5.11）
 */
function runRegistryPublishStep(input: StepModelInput): StepModelOutcome {
  const logs: string[] = [];

  if (isBlankToken(input.token)) {
    logs.push(
      `[${input.registryLabel}] Registry_Credential が未設定のため公開要求を送信しません`,
    );
    return { result: "failed", publishCalls: 0, logs };
  }

  if (input.probe === "published") {
    logs.push(
      `[${input.registryLabel}] ${input.packageName}@${input.version} は公開済みのためスキップします`,
    );
    return { result: "skipped", publishCalls: 0, logs };
  }

  const publish = input.publish ?? (() => ({ ok: true }) as PublishOutcome);
  const outcome = publish();
  const publishCalls = 1;

  if (outcome.ok) {
    logs.push(
      formatPublishSuccessLog(
        input.packageName,
        input.version,
        input.registryLabel,
      ),
    );
    return { result: "success", publishCalls, logs };
  }

  const classification = classifyPublishError(
    outcome.stderr,
    outcome.exitCode,
  );
  logs.push(
    `[${input.registryLabel}] 公開に失敗しました (${classification.category}): ${classification.instruction}`,
  );
  return {
    result: classification.category === "conflict" ? "skipped" : "failed",
    publishCalls,
    logs,
  };
}

/** `<major>.<minor>.<patch>` 形式のPackage_Versionを生成する。 */
const versionArb = fc
  .tuple(
    fc.integer({ min: 0, max: 999_999 }),
    fc.integer({ min: 0, max: 999_999 }),
    fc.integer({ min: 0, max: 999_999 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** Public_Package_Name / Scoped_Package_Name に相当するパッケージ名を生成する。 */
const packageNameArb = fc.oneof(
  fc.constantFrom(
    "rokadoc-mcp-server",
    "@yuma-shin/rokadoc-mcp-server",
    "a",
    "@s/x",
  ),
  fc.stringMatching(/^(@[a-z0-9-]{1,12}\/)?[a-z0-9][a-z0-9._-]{0,20}$/),
);

const registryLabelArb = fc.constantFrom(
  "https://registry.npmjs.org",
  "https://npm.pkg.github.com",
);

/** 空白文字のみ、または空文字列のRegistry_Credentialを生成する。 */
const blankTokenArb = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
    minLength: 0,
    maxLength: 12,
  })
  .map((chars) => chars.join(""));

/**
 * 秘密情報に見えるRegistry_Credentialを生成する。
 * ログ出力へ混入した場合に確実に検出できるよう、十分に長く一意な形とする。
 */
const secretTokenArb = fc.stringMatching(/^npm_[A-Za-z0-9]{36}$/);

/**
 * 分類トークンを一切含まないノイズ文字列を生成する。
 * 分類対象のトークンはすべて `E` を含むため、`e` / `E` を除いた文字集合を使う。
 */
const noiseStderrArb = fc.stringMatching(/^[a-df-zA-DF-Z0-9 :.,/_-]{0,60}$/);

/** `retryable` に分類されるべき標準エラー出力の断片（prerequisites.md 7節）。 */
const retryableTokens = [
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
] as const;

/** `conflict` に分類されるべき標準エラー出力の断片。 */
const conflictStderrs = [
  "npm ERR! code EPUBLISHCONFLICT\nnpm ERR! Cannot publish rokadoc-mcp-server@1.0.7 over existing version.",
  "npm ERR! code E409\nnpm ERR! 409 Conflict - PUT https://npm.pkg.github.com/@yuma-shin%2frokadoc-mcp-server",
  "npm ERR! code E403\nnpm ERR! 403 Forbidden - PUT https://registry.npmjs.org/rokadoc-mcp-server - You cannot publish over the previously published versions: 1.0.7.",
] as const;

/** `auth` に分類されるべき標準エラー出力の断片。 */
const authStderrs = [
  "npm ERR! code ENEEDAUTH\nnpm ERR! need auth This command requires you to be logged in to https://registry.npmjs.org/",
  "npm ERR! code E401\nnpm ERR! Unable to authenticate, your authentication token seems to be invalid.",
  "npm ERR! code EOTP\nnpm ERR! This operation requires a one-time password from your authenticator.",
  "npm ERR! code EAUTHIP\nnpm ERR! Unable to authenticate, your IP is not allowed.",
  "npm ERR! code E403\nnpm ERR! 403 Forbidden - PUT https://npm.pkg.github.com/@yuma-shin%2frokadoc-mcp-server - permission_denied: write_package",
] as const;

/** 分類対象トークンを含む標準エラー出力を、前後のノイズ付きで組み立てる。 */
function withNoise(core: string, prefix: string, suffix: string): string {
  return `${prefix}\n${core}\n${suffix}`;
}

/** 分類トークンと衝突しない終了コード（124は `timeout` 専用のため除く）。 */
const nonTimeoutExitCodeArb = fc
  .integer({ min: 1, max: 255 })
  .filter((code) => code !== 124);

/*
 * Feature: npm-package-distribution, Property 5: Registry_Publish_Stepの結果集約と
 * Step 2の必ずの実行 — 任意のRegistry_Publish_Step結果の組（success / skipped / failed
 * の3値 × 3値の9通りすべて）に対して、(a) Step 1 の結果が何であってもStep 2の公開処理が
 * 実行され、(b) aggregateExitCode は少なくとも一方が failed のとき非ゼロを返し、両方が
 * success または skipped のとき 0 を返す。また、公開済みバージョンの照会結果が「公開済み」
 * である場合、当該ステップの結果は常に skipped となり公開要求は1回も送信されない。
 */
describe("Feature: npm-package-distribution, Property 5: Registry_Publish_Stepの結果集約とStep 2の必ずの実行", () => {
  /**
   * **Validates: Requirements 5.7**
   *
   * 3値 × 3値の9通りを全列挙する（生成器による反復ではなく網羅）。
   */
  it("9通りの結果の組すべてで終了コードが集約規則と一致する", () => {
    const seen: string[] = [];

    for (const step1 of STEP_RESULTS) {
      for (const step2 of STEP_RESULTS) {
        seen.push(`${step1}/${step2}`);
        const expected =
          step1 === "failed" || step2 === "failed" ? 1 : (0 as 0 | 1);
        expect(aggregateExitCode([step1, step2])).toBe(expected);
        // 集約は順序に依存しない
        expect(aggregateExitCode([step2, step1])).toBe(expected);
      }
    }

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  /**
   * **Validates: Requirements 5.7**
   *
   * Step 2 の結果が Step 1 の結果によって隠蔽されないこと（両者が常に集約へ寄与する）。
   */
  it("Step 1 の結果に関わらず Step 2 の結果が集約に反映される", () => {
    for (const step1 of STEP_RESULTS) {
      expect(aggregateExitCode([step1, "failed"])).toBe(1);
      expect(aggregateExitCode([step1, "success"])).toBe(
        step1 === "failed" ? 1 : 0,
      );
      expect(aggregateExitCode([step1, "skipped"])).toBe(
        step1 === "failed" ? 1 : 0,
      );
    }
  });

  /**
   * **Validates: Requirements 5.1**
   *
   * Step 1 の結果9通り（3値 × Step 2 の3経路）に対して、Step 2 の公開処理が必ず実行される。
   */
  it("Step 1 の結果が何であっても Step 2 の公開処理が実行される", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STEP_RESULTS),
        packageNameArb,
        versionArb,
        secretTokenArb,
        (step1, packageName, version, token) => {
          const step2 = runRegistryPublishStep({
            token,
            probe: "not-published",
            packageName,
            version,
            registryLabel: "https://npm.pkg.github.com",
            publish: () => ({ ok: true }),
          });

          // Step 1 の結果は Step 2 の実行可否に影響しない
          expect(step2.publishCalls).toBe(1);
          expect(step2.result).toBe("success");
          expect(aggregateExitCode([step1, step2.result])).toBe(
            step1 === "failed" ? 1 : 0,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.7, 5.6**
   */
  it("照会結果が公開済みなら公開要求を送信せず skipped になる", () => {
    fc.assert(
      fc.property(
        packageNameArb,
        versionArb,
        registryLabelArb,
        secretTokenArb,
        (packageName, version, registryLabel, token) => {
          const step = runRegistryPublishStep({
            token,
            probe: "published",
            packageName,
            version,
            registryLabel,
            publish: () => {
              throw new Error(
                "公開済みバージョンに対して公開要求を送信してはならない",
              );
            },
          });

          expect(step.result).toBe("skipped");
          expect(step.publishCalls).toBe(0);
          // skipped はジョブを落とさない
          expect(aggregateExitCode([step.result, "success"])).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/*
 * Feature: npm-package-distribution, Property 7: 空白のみの認証情報は未設定として扱われ
 * 公開要求を発生させない — 任意の空白文字（スペース、タブ、改行、キャリッジリターン、
 * フォームフィード、垂直タブ）のみで構成される文字列および空文字列に対して、isBlankToken
 * は真を返し、当該トークンを与えた場合の公開処理は公開関数を1回も呼び出さずに結果 failed
 * を記録し、返却するログにはトークンの値そのものが含まれない。
 */
describe("Feature: npm-package-distribution, Property 7: 空白のみの認証情報は未設定として扱われ公開要求を発生させない", () => {
  /**
   * **Validates: Requirements 4.9**
   */
  it("空白のみ・空文字列のトークンは未設定と判定される", () => {
    fc.assert(
      fc.property(blankTokenArb, (token) => {
        expect(isBlankToken(token)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.9, 4.5**
   */
  it("未設定のトークンでは公開要求を送信せず failed を記録しトークン値をログに含めない", () => {
    fc.assert(
      fc.property(
        blankTokenArb,
        packageNameArb,
        versionArb,
        registryLabelArb,
        (token, packageName, version, registryLabel) => {
          const step = runRegistryPublishStep({
            token,
            probe: "not-published",
            packageName,
            version,
            registryLabel,
            publish: () => {
              throw new Error(
                "認証情報が未設定の場合に公開要求を送信してはならない",
              );
            },
          });

          expect(step.result).toBe("failed");
          expect(step.publishCalls).toBe(0);

          // ログはトークン値に依存しない（依存しなければ値は漏れ得ない）
          const baseline = runRegistryPublishStep({
            token: "",
            probe: "not-published",
            packageName,
            version,
            registryLabel,
          });
          expect(step.logs).toEqual(baseline.logs);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.9**
   *
   * 未設定判定が「常に真」に退化していないこと（非空白のトークンでは公開要求が送信される）。
   */
  it("空白以外を含むトークンは未設定と判定されず公開要求が送信される", () => {
    fc.assert(
      fc.property(
        secretTokenArb,
        packageNameArb,
        versionArb,
        registryLabelArb,
        (token, packageName, version, registryLabel) => {
          expect(isBlankToken(token)).toBe(false);

          const step = runRegistryPublishStep({
            token,
            probe: "not-published",
            packageName,
            version,
            registryLabel,
            publish: () => ({ ok: true }),
          });

          expect(step.publishCalls).toBe(1);
          expect(step.logs.join("\n")).not.toContain(token);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.9**
   *
   * Secretsが未設定の場合（環境変数が存在しない）も未設定として扱う。
   */
  it("非文字列のトークンは未設定として扱われる", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.boolean(),
          fc.object(),
          fc.array(fc.string()),
        ),
        (token) => {
          expect(isBlankToken(token)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/*
 * Feature: npm-package-distribution, Property 9: 公開エラーの分類は再試行可否を一意に
 * 決定する — 任意の公開失敗の出力（標準エラー出力文字列と終了コードの組）に対して、
 * classifyPublishError は retryable（ネットワーク到達不能・レジストリ一時障害）、
 * conflict（同一バージョン公開済み）、auth（認証拒否・権限不足）、unknown のいずれか1つを
 * 返し、conflict と auth に対しては常に再試行不可と判定する。分類結果が auth の場合、
 * 返却される処理指示に取り下げ操作（unpublish / deprecate）は含まれない。
 */
describe("Feature: npm-package-distribution, Property 9: 公開エラーの分類は再試行可否を一意に決定する", () => {
  const categories = ["retryable", "conflict", "auth", "unknown"] as const;

  /**
   * **Validates: Requirements 5.8, 4.10, 5.11**
   *
   * 任意の出力に対する全域性・一意性・決定性、および `conflict` / `auth` の再試行不可。
   */
  it("任意の標準エラー出力と終了コードに対し4値のいずれか1つを一意に返す", () => {
    const anyStderrArb = fc.oneof(
      noiseStderrArb,
      fc.string(),
      fc.constantFrom(
        ...retryableTokens.map((token) => `npm ERR! code ${token}`),
      ),
      fc.constantFrom(...conflictStderrs),
      fc.constantFrom(...authStderrs),
    );

    fc.assert(
      fc.property(
        anyStderrArb,
        fc.integer({ min: 0, max: 255 }),
        (stderr, exitCode) => {
          const classification = classifyPublishError(stderr, exitCode);

          expect(categories).toContain(classification.category);
          expect(typeof classification.retryable).toBe("boolean");
          expect(typeof classification.instruction).toBe("string");
          expect(classification.instruction.length).toBeGreaterThan(0);

          // 再試行可否は分類から一意に決まる
          expect(classification.retryable).toBe(
            classification.category === "retryable",
          );
          if (
            classification.category === "conflict" ||
            classification.category === "auth"
          ) {
            expect(classification.retryable).toBe(false);
          }
          if (classification.category === "auth") {
            const instruction = classification.instruction.toLowerCase();
            expect(instruction).not.toContain("unpublish");
            expect(instruction).not.toContain("deprecate");
          }

          // 同一入力に対して同一の結果（決定性）
          expect(classifyPublishError(stderr, exitCode)).toEqual(classification);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.10, 5.11**
   */
  it("ネットワーク到達不能・レジストリ一時障害・タイムアウトは retryable に分類される", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...retryableTokens),
        noiseStderrArb,
        noiseStderrArb,
        nonTimeoutExitCodeArb,
        (token, prefix, suffix, exitCode) => {
          const stderr = withNoise(`npm ERR! code ${token}`, prefix, suffix);
          const classification = classifyPublishError(stderr, exitCode);

          expect(classification.category).toBe("retryable");
          expect(classification.retryable).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.10, 4.12, 5.9**
   *
   * 終了コード124（`timeout` による打ち切り）は retryable。
   */
  it("終了コード124は retryable に分類される", () => {
    fc.assert(
      fc.property(noiseStderrArb, (stderr) => {
        const classification = classifyPublishError(stderr, 124);

        expect(classification.category).toBe("retryable");
        expect(classification.retryable).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.8, 5.11**
   */
  it("重複バージョンは conflict に分類され再試行しない", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...conflictStderrs),
        noiseStderrArb,
        noiseStderrArb,
        nonTimeoutExitCodeArb,
        (core, prefix, suffix, exitCode) => {
          const classification = classifyPublishError(
            withNoise(core, prefix, suffix),
            exitCode,
          );

          expect(classification.category).toBe("conflict");
          expect(classification.retryable).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.8**
   */
  it("認証拒否・権限不足は auth に分類され取り下げ操作を指示しない", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...authStderrs),
        noiseStderrArb,
        noiseStderrArb,
        nonTimeoutExitCodeArb,
        (core, prefix, suffix, exitCode) => {
          const classification = classifyPublishError(
            withNoise(core, prefix, suffix),
            exitCode,
          );

          expect(classification.category).toBe("auth");
          expect(classification.retryable).toBe(false);

          const instruction = classification.instruction.toLowerCase();
          expect(instruction).not.toContain("unpublish");
          expect(instruction).not.toContain("deprecate");
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 5.8**
   *
   * 分類トークンを含まない出力は unknown（かつ再試行しない）。
   */
  it("分類トークンを含まない出力は unknown に分類される", () => {
    fc.assert(
      fc.property(noiseStderrArb, nonTimeoutExitCodeArb, (stderr, exitCode) => {
        const classification = classifyPublishError(stderr, exitCode);

        expect(classification.category).toBe("unknown");
        expect(classification.retryable).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

/*
 * Feature: npm-package-distribution, Property 10: ログ整形は入力値を常に含み秘密情報を
 * 含まない — 任意のパッケージ名文字列とバージョン文字列に対して、formatPublishSuccessLog
 * の返す文字列は両者を部分文字列として含む。任意の2つのバージョン文字列（書き換え前・
 * 書き換え後）に対して、formatVersionRewriteLog の返す文字列は両者を部分文字列として含む。
 * 任意のトークン文字列に対して、これらのログ整形関数の出力にトークン文字列は含まれない。
 */
describe("Feature: npm-package-distribution, Property 10: ログ整形は入力値を常に含み秘密情報を含まない", () => {
  /**
   * **Validates: Requirements 4.11, 5.10, 4.5**
   */
  it("公開成功ログはパッケージ名とバージョンを含みトークン値を含まない", () => {
    fc.assert(
      fc.property(
        packageNameArb,
        versionArb,
        fc.option(registryLabelArb, { nil: undefined }),
        secretTokenArb,
        (packageName, version, registryLabel, token) => {
          const log = formatPublishSuccessLog(
            packageName,
            version,
            registryLabel,
          );

          expect(log).toContain(packageName);
          expect(log).toContain(version);
          expect(log).not.toContain(token);
          if (registryLabel !== undefined) {
            expect(log).toContain(registryLabel);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.5, 4.5**
   */
  it("書き換えログは書き換え前後の値を含みトークン値を含まない", () => {
    fc.assert(
      fc.property(
        versionArb,
        versionArb,
        fc.option(fc.constantFrom("version", "name"), { nil: undefined }),
        secretTokenArb,
        (previousValue, nextValue, field, token) => {
          const log = formatVersionRewriteLog(previousValue, nextValue, field);

          expect(log).toContain(previousValue);
          expect(log).toContain(nextValue);
          expect(log).not.toContain(token);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.5**
   *
   * `name` の書き換え（`rokadoc-mcp-server` → `@yuma-shin/rokadoc-mcp-server`）にも
   * 同一関数を再利用する。
   */
  it("name の書き換えでも前後の値を含む", () => {
    fc.assert(
      fc.property(
        packageNameArb,
        packageNameArb,
        secretTokenArb,
        (previousValue, nextValue, token) => {
          const log = formatVersionRewriteLog(previousValue, nextValue, "name");

          expect(log).toContain(previousValue);
          expect(log).toContain(nextValue);
          expect(log).not.toContain(token);
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { describe, it, expect } from "vitest";

// タスク2.1で定義した `scripts/lib/release.mjs` の公開APIが、
// vitest 実行時（esbuildによる `.mjs` 解決）と
// `tsc -p tsconfig.test.json --noEmit`（手書き `scripts/lib/release.d.mts`）の
// 双方から参照できることを固定する。
// 各関数の振る舞いはタスク2.2以降のプロパティテストで検証する。
import * as release from "../../scripts/lib/release.mjs";

const EXPECTED_EXPORTS = [
  "deriveVersionFromTag",
  "compareSemver",
  "isPackagedPath",
  "aggregateExitCode",
  "isBlankToken",
  "classifyPublishError",
  "formatPublishSuccessLog",
  "formatVersionRewriteLog",
  "withRetry",
  "setPackageField",
] as const;

describe("scripts/lib/release.mjs の公開API（タスク2.1）", () => {
  it.each(EXPECTED_EXPORTS)("%s を関数としてエクスポートする", (name) => {
    expect(typeof release[name]).toBe("function");
  });

  it("公開APIは上記10関数のみである", () => {
    expect(Object.keys(release).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });
});

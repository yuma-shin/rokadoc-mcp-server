/**
 * Package_Manifest 書き換え（`setPackageField`）のプロパティベーステスト。
 *
 * Feature: npm-package-distribution
 * Validates: Requirements 5.2, 6.1
 *
 * 対象は `scripts/lib/release.mjs` の純関数 `setPackageField` である。
 * 本ファイルはタスク2.10（テストファースト）で作成しており、実装は
 * タスク2.11で行う。したがって実装前の時点では全アサーションが
 * `not implemented: 実装はタスク2.11` により失敗する。
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { setPackageField } from "../../scripts/lib/release.mjs";

/**
 * オブジェクトのキーとして扱うと `Object` のプロトタイプ汚染や
 * 特殊な挙動を招く名称。仕様（要件5.2 / 6.1）が扱う対象ではないため
 * 生成器から除外する。
 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const KEY_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split("");

/**
 * 配列インデックスとして解釈されるキー名（`"4"` など）を除外する。
 *
 * ECMAScriptの仕様上、通常のオブジェクトの自前キーの列挙順は
 * 「整数インデックスキーを昇順で先に、それ以外を挿入順で後に」と定められている。
 * したがって `"4"` のようなキーは、どの実装であっても挿入順を保持できず
 * （`JSON.parse` の結果すら先頭へ並べ替わる）、
 * 「未存在のフィールドは末尾へ追加する」という主張が成立し得ない。
 * `package.json` のフィールド名に純粋な整数は現れないため、生成器から除外する。
 */
const isArrayIndexKey = (key: string): boolean =>
  String(Number(key)) === key && Number.isInteger(Number(key));

/** `package.json` のキーとして現実的な識別子。 */
const keyNameArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...KEY_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""))
  .filter((key) => !RESERVED_KEYS.has(key) && !isArrayIndexKey(key));

/** `1.0.7` 形式の Package_Version。 */
const versionArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 999_999 }),
    fc.integer({ min: 0, max: 999_999 }),
    fc.integer({ min: 0, max: 999_999 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

/** 素のパッケージ名およびスコープ付きパッケージ名。 */
const packageNameArb: fc.Arbitrary<string> = fc.oneof(
  keyNameArb.map((name) => name.toLowerCase()),
  fc
    .tuple(keyNameArb, keyNameArb)
    .map(([scope, name]) => `@${scope.toLowerCase()}/${name.toLowerCase()}`),
);

/** `^1.2.3` 形式などの依存バージョン範囲。 */
const semverRangeArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom("", "^", "~", ">="), versionArb)
  .map(([prefix, version]) => `${prefix}${version}`);

/**
 * JSONとして表現可能な任意の値。`-0` と非有限数、`undefined` は
 * JSONの往復が定義されないため生成しない。
 */
const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec<{
  jsonValue: unknown;
}>((tie) => ({
  jsonValue: fc.oneof(
    { maxDepth: 3 },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.string({ maxLength: 20 }),
    fc.array(tie("jsonValue"), { maxLength: 3 }),
    fc.dictionary(keyNameArb, tie("jsonValue"), { maxKeys: 3 }),
  ),
})).jsonValue;

/** 依存関係マップ（`dependencies` / `devDependencies`）。 */
const dependencyMapArb: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  packageNameArb,
  semverRangeArb,
  { maxKeys: 5 },
);

/**
 * 実際の `package.json` に現れるフィールドの生成器。
 * 入れ子のマップ・配列・オブジェクトを含めることで
 * 「対象以外をすべて保持する」という主張を意味のあるものにする。
 */
const REALISTIC_FIELDS: Record<string, fc.Arbitrary<unknown>> = {
  name: packageNameArb,
  version: versionArb,
  description: fc.string({ maxLength: 60 }),
  type: fc.constantFrom("module", "commonjs"),
  main: fc.constantFrom("dist/index.js", "index.js", "./dist/index.js"),
  bin: fc.dictionary(
    packageNameArb,
    fc.constantFrom("dist/index.js", "dist/cli.js"),
    { minKeys: 1, maxKeys: 2 },
  ),
  scripts: fc.dictionary(keyNameArb, fc.string({ maxLength: 40 }), {
    maxKeys: 6,
  }),
  keywords: fc.array(keyNameArb, { maxLength: 6 }),
  files: fc.array(fc.constantFrom("dist", "LICENSE.md", "bin"), {
    maxLength: 3,
  }),
  license: fc.constantFrom("MIT", "Apache-2.0"),
  engines: fc.record({ node: fc.constantFrom(">=22", ">=20", ">=18") }),
  repository: fc.record({
    type: fc.constant("git"),
    url: packageNameArb.map((name) => `https://github.com/owner/${name}`),
  }),
  bugs: fc.record({
    url: packageNameArb.map(
      (name) => `https://github.com/owner/${name}/issues`,
    ),
  }),
  publishConfig: fc.record({
    access: fc.constantFrom("public", "restricted"),
    registry: fc.constantFrom(
      "https://registry.npmjs.org",
      "https://npm.pkg.github.com",
    ),
  }),
  dependencies: dependencyMapArb,
  devDependencies: dependencyMapArb,
  peerDependenciesMeta: fc.dictionary(
    packageNameArb,
    fc.record({ optional: fc.boolean() }),
    { maxKeys: 2 },
  ),
};

type Entry = readonly [string, unknown];

const realisticEntryArb: fc.Arbitrary<Entry> = fc.oneof(
  ...Object.entries(REALISTIC_FIELDS).map(([key, valueArb]) =>
    valueArb.map((value): Entry => [key, value]),
  ),
);

const extraEntryArb: fc.Arbitrary<Entry> = fc
  .tuple(keyNameArb, jsonValueArb)
  .map(([key, value]): Entry => [key, value]);

/**
 * `package.json` の形をした任意のオブジェクト。
 * `name` と `version` は常に含み（設計のProperty 8本文に従う）、
 * それ以外は現実的なフィールドと任意の追加キーを任意の並び順で持つ。
 */
const manifestArb: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    packageNameArb,
    versionArb,
    fc.uniqueArray(fc.oneof(realisticEntryArb, extraEntryArb), {
      selector: (entry) => entry[0],
      maxLength: 14,
    }),
  )
  .map(([name, version, entries]) => {
    const rest = entries.filter(([key]) => key !== "name" && key !== "version");
    // `name` / `version` の位置も並び順の一部として揺らがせる
    const head: Entry[] = [
      ["name", name],
      ["version", version],
    ];
    const insertAt = rest.length === 0 ? 0 : rest.length % (rest.length + 1);
    const ordered: Entry[] = [
      ...rest.slice(0, insertAt),
      ...head,
      ...rest.slice(insertAt),
    ];
    return Object.fromEntries(ordered) as Record<string, unknown>;
  });

/** 書き換え対象フィールド名（既存フィールドと未存在フィールドの双方を含む）。 */
const fieldArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("version", "name") },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      ...Object.keys(REALISTIC_FIELDS).filter(
        (key) => key !== "name" && key !== "version",
      ),
    ),
  },
  { weight: 2, arbitrary: keyNameArb },
);

/** 書き換え後の値（`version` / `name` の実際の用途に加えて任意文字列）。 */
const valueArb: fc.Arbitrary<string> = fc.oneof(
  versionArb,
  packageNameArb,
  fc.string({ maxLength: 30 }),
);

describe("Feature: npm-package-distribution, Property 8: マニフェスト書き換えは対象フィールド以外を保持する", () => {
  /**
   * **Validates: Requirements 5.2, 6.1**
   *
   * 任意のJSONオブジェクト（`name` と `version` に加えて任意個の追加フィールドを持つ）と
   * 任意の書き換え対象フィールド名・値に対して、`setPackageField` は当該フィールドのみを
   * 新しい値へ変更し、それ以外のすべてのキーと値を保持し、再度パースして同一の構造を
   * 得られる（JSONとしての往復）。
   */

  it("入力オブジェクトを破壊しない", () => {
    fc.assert(
      fc.property(manifestArb, fieldArb, valueArb, (manifest, field, value) => {
        const snapshot = structuredClone(manifest);

        setPackageField(manifest, field, value);

        expect(manifest).toEqual(snapshot);
        expect(Object.keys(manifest)).toEqual(Object.keys(snapshot));
      }),
      { numRuns: 100 },
    );
  });

  it("対象フィールドのみが変わり、他のすべてのキーと値を保持する", () => {
    fc.assert(
      fc.property(manifestArb, fieldArb, valueArb, (manifest, field, value) => {
        const result = setPackageField(manifest, field, value);

        expect(result).not.toBe(manifest);
        expect(result[field]).toBe(value);

        for (const key of Object.keys(manifest)) {
          if (key === field) continue;
          expect(result[key]).toEqual(manifest[key]);
        }

        // 対象フィールド以外の新しいキーが増えていないこと
        const expectedKeys = Object.keys(manifest).includes(field)
          ? Object.keys(manifest)
          : [...Object.keys(manifest), field];
        expect(new Set(Object.keys(result))).toEqual(new Set(expectedKeys));
      }),
      { numRuns: 100 },
    );
  });

  it("既存キーの並び順を保持し、未存在のフィールドは末尾へ追加する", () => {
    fc.assert(
      fc.property(manifestArb, fieldArb, valueArb, (manifest, field, value) => {
        const originalKeys = Object.keys(manifest);
        const result = setPackageField(manifest, field, value);
        const resultKeys = Object.keys(result);

        if (originalKeys.includes(field)) {
          expect(resultKeys).toEqual(originalKeys);
        } else {
          expect(resultKeys).toEqual([...originalKeys, field]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("JSONとしての往復が成立する", () => {
    fc.assert(
      fc.property(manifestArb, fieldArb, valueArb, (manifest, field, value) => {
        const result = setPackageField(manifest, field, value);
        const roundTripped = JSON.parse(JSON.stringify(result)) as Record<
          string,
          unknown
        >;

        expect(roundTripped).toEqual(result);
        expect(Object.keys(roundTripped)).toEqual(Object.keys(result));
        expect(roundTripped[field]).toBe(value);
      }),
      { numRuns: 100 },
    );
  });

  it("同一フィールド・同一値の2回適用は冪等である", () => {
    fc.assert(
      fc.property(manifestArb, fieldArb, valueArb, (manifest, field, value) => {
        const once = setPackageField(manifest, field, value);
        const twice = setPackageField(once, field, value);

        expect(twice).toEqual(once);
        expect(Object.keys(twice)).toEqual(Object.keys(once));
      }),
      { numRuns: 100 },
    );
  });

  it("`version` → `name` の順に適用するとその2フィールドのみが変わる", () => {
    fc.assert(
      fc.property(
        manifestArb,
        versionArb,
        packageNameArb,
        (manifest, nextVersion, nextName) => {
          const snapshot = structuredClone(manifest);

          const afterVersion = setPackageField(
            manifest,
            "version",
            nextVersion,
          );
          const afterName = setPackageField(afterVersion, "name", nextName);

          expect(afterName["version"]).toBe(nextVersion);
          expect(afterName["name"]).toBe(nextName);

          for (const key of Object.keys(snapshot)) {
            if (key === "version" || key === "name") continue;
            expect(afterName[key]).toEqual(snapshot[key]);
          }

          // 並び順は元のマニフェストのまま（`name` / `version` は既存キー）
          expect(Object.keys(afterName)).toEqual(Object.keys(snapshot));
          // 元のオブジェクトは破壊されない
          expect(manifest).toEqual(snapshot);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Release_Tag からのバージョン導出とセマンティックバージョン比較の
 * プロパティベーステスト（タスク2.2 / Property 1, 2, 11）。
 *
 * Feature: npm-package-distribution
 * Validates: Requirements 6.1, 6.3, 6.6, 6.7, 3.3
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  deriveVersionFromTag,
  compareSemver,
} from "../../scripts/lib/release.mjs";

/** `scripts/lib/release.mjs` が採用する有効タグの唯一の判定基準。 */
const VALID_TAG_PATTERN =
  /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

/** 期待するタグ形式（拒否結果に必ず含まれる文字列）。 */
const EXPECTED_TAG_FORMAT = "v<major>.<minor>.<patch>";

/** 有効な要素値（0以上999999以下の整数）。`String(n)` は先頭ゼロを生まない。 */
const componentArb = fc.integer({ min: 0, max: 999_999 });

/**
 * 小さな値域を混ぜることで、比較プロパティで等価・近接するバージョンの組が
 * 十分な頻度で生成されるようにする。
 */
const biasedComponentArb = fc.oneof(
  fc.integer({ min: 0, max: 2 }),
  componentArb,
);

const versionTripleArb = fc.tuple(
  biasedComponentArb,
  biasedComponentArb,
  biasedComponentArb,
);

const versionStringArb = versionTripleArb.map(
  ([major, minor, patch]) => `${major}.${minor}.${patch}`,
);

/** 有効なRelease_Tag（`v` + 整数3要素）。 */
const validTagArb = fc
  .tuple(componentArb, componentArb, componentArb)
  .map(([major, minor, patch]) => ({
    tag: `v${major}.${minor}.${patch}`,
    version: `${major}.${minor}.${patch}`,
  }));

describe("Feature: npm-package-distribution, Property 1: 有効なRelease_Tagからのバージョン導出は全域かつ往復する", () => {
  /**
   * **Validates: Requirements 6.1, 6.6**
   *
   * 任意の3整数（各0以上999999以下）から構成したタグ `v{M}.{m}.{p}` に対して、
   * `deriveVersionFromTag` は例外を投げずに値を返し、その結果は先頭の `v` を
   * ちょうど1個除去した文字列と一致し、`"v" + 結果` が元のタグと一致する。
   */
  it("有効なタグは例外を投げずに導出され、先頭のvを1個除去した値と一致する", () => {
    fc.assert(
      fc.property(validTagArb, ({ tag, version }) => {
        const result = deriveVersionFromTag(tag);

        expect(result.ok).toBe(true);
        if (result.ok !== true) {
          return;
        }
        expect(result.version).toBe(version);
      }),
      { numRuns: 100 },
    );
  });

  it("導出結果に v を付け直すと元のタグ文字列へ戻る（往復）", () => {
    fc.assert(
      fc.property(validTagArb, ({ tag }) => {
        const result = deriveVersionFromTag(tag);

        expect(result.ok).toBe(true);
        if (result.ok !== true) {
          return;
        }
        expect(`v${result.version}`).toBe(tag);
        // 先頭の `v` はちょうど1個だけ除去される（`##` ではない）
        expect(result.version.startsWith("v")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: npm-package-distribution, Property 2: 無効なタグはすべて拒否される", () => {
  /**
   * **Validates: Requirements 6.3, 6.7**
   *
   * プレリリース識別子、ビルドメタデータ、先頭ゼロ、1000000以上の要素、
   * 非数値要素、要素数が3でないもの、先頭が `v` でないもの、前後に空白を
   * 含むもの、空文字列のいずれに対しても、`deriveVersionFromTag` は値を
   * 返さず拒否し、拒否結果には実際のタグ値と期待形式の双方が含まれる。
   */

  /** プレリリース識別子付き（`v1.2.3-rc.1` など）。 */
  const prereleaseTagArb = fc
    .tuple(
      componentArb,
      componentArb,
      componentArb,
      fc.constantFrom("-rc.1", "-beta.1", "-alpha", "-0", "-SNAPSHOT"),
    )
    .map(
      ([major, minor, patch, suffix]) => `v${major}.${minor}.${patch}${suffix}`,
    );

  /** ビルドメタデータ付き（`v1.2.3+build.5` など）。 */
  const buildMetadataTagArb = fc
    .tuple(
      componentArb,
      componentArb,
      componentArb,
      fc.constantFrom("+build.5", "+20240101", "+sha.abc123"),
    )
    .map(
      ([major, minor, patch, suffix]) => `v${major}.${minor}.${patch}${suffix}`,
    );

  /** いずれかの要素が先頭ゼロを持つ（`v01.2.3` / `v1.00.3` など）。 */
  const leadingZeroTagArb = fc
    .tuple(
      fc.integer({ min: 0, max: 99_999 }),
      fc.integer({ min: 0, max: 99_999 }),
      fc.integer({ min: 0, max: 99_999 }),
      fc.integer({ min: 0, max: 2 }),
      fc.integer({ min: 1, max: 3 }),
    )
    .map(([major, minor, patch, position, zeros]) => {
      const parts = [String(major), String(minor), String(patch)];
      parts[position] = "0".repeat(zeros) + parts[position];
      return `v${parts.join(".")}`;
    });

  /** いずれかの要素が1000000以上（6桁上限を超える）。 */
  const outOfRangeTagArb = fc
    .tuple(
      componentArb,
      componentArb,
      componentArb,
      fc.integer({ min: 1_000_000, max: 99_999_999 }),
      fc.integer({ min: 0, max: 2 }),
    )
    .map(([major, minor, patch, big, position]) => {
      const parts = [String(major), String(minor), String(patch)];
      parts[position] = String(big);
      return `v${parts.join(".")}`;
    });

  /** 非数値要素を含む（`v1.x.3` など）。 */
  const nonNumericTagArb = fc
    .tuple(
      componentArb,
      componentArb,
      componentArb,
      fc.constantFrom("x", "1a", "a1", "-1", "1.5", "٣", "１", "", " 1", "+1"),
      fc.integer({ min: 0, max: 2 }),
    )
    .map(([major, minor, patch, bad, position]) => {
      const parts = [String(major), String(minor), String(patch)];
      parts[position] = bad;
      return `v${parts.join(".")}`;
    });

  /** 要素数が3でない（1・2・4・5要素）。 */
  const wrongArityTagArb = fc
    .array(componentArb, { minLength: 1, maxLength: 5 })
    .filter((parts) => parts.length !== 3)
    .map((parts) => `v${parts.join(".")}`);

  /** 先頭が `v` でない、または `v` が過剰。 */
  const badPrefixTagArb = fc
    .tuple(
      fc.constantFrom("", "V", "vv", "ver", "release-v", "=v", "tags/v", "1v"),
      componentArb,
      componentArb,
      componentArb,
    )
    .map(
      ([prefix, major, minor, patch]) => `${prefix}${major}.${minor}.${patch}`,
    );

  /** 前後に空白を含む。 */
  const whitespaceTagArb = fc
    .tuple(
      fc.constantFrom("", " ", "\t", "\n", "\r", "  "),
      componentArb,
      componentArb,
      componentArb,
      fc.constantFrom("", " ", "\t", "\n", "\r\n"),
    )
    .filter(([lead, , , , trail]) => lead !== "" || trail !== "")
    .map(
      ([lead, major, minor, patch, trail]) =>
        `${lead}v${major}.${minor}.${patch}${trail}`,
    );

  /** 空文字列および空白のみ。 */
  const emptyTagArb = fc.constantFrom("", " ", "\t", "\n", "   ");

  const invalidTagArb = fc
    .oneof(
      prereleaseTagArb,
      buildMetadataTagArb,
      leadingZeroTagArb,
      outOfRangeTagArb,
      nonNumericTagArb,
      wrongArityTagArb,
      badPrefixTagArb,
      whitespaceTagArb,
      emptyTagArb,
    )
    // 生成器の取り違えによる有効タグの混入を防ぐ安全網
    .filter((tag) => !VALID_TAG_PATTERN.test(tag));

  it("無効なタグは拒否され、拒否結果に実タグ値と期待形式の双方が含まれる", () => {
    fc.assert(
      fc.property(invalidTagArb, (tag) => {
        const result = deriveVersionFromTag(tag);

        expect(result.ok).toBe(false);
        if (result.ok !== false) {
          return;
        }
        expect(result.tag).toBe(tag);
        expect(result.expectedFormat).toBe(EXPECTED_TAG_FORMAT);
        // ログ用メッセージは実タグ値と期待形式の双方を部分文字列として含む
        expect(result.message).toContain(tag);
        expect(result.message).toContain(EXPECTED_TAG_FORMAT);
        // 拒否結果に version フィールドは存在しない
        expect("version" in result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("プレリリース識別子およびビルドメタデータを含むタグは常に拒否される", () => {
    fc.assert(
      fc.property(fc.oneof(prereleaseTagArb, buildMetadataTagArb), (tag) => {
        const result = deriveVersionFromTag(tag);
        expect(result.ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: npm-package-distribution, Property 11: セマンティックバージョン比較は全順序である", () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * 任意の2バージョン（各要素0以上999999以下）に対して `compareSemver` は
   * 反射性・反対称性を満たし、任意の3バージョンに対して推移性を満たす。
   * かつ結果は3要素の数値タプルの辞書式順序と一致する。
   */
  const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

  /** 3要素の数値タプルの辞書式順序（期待値のモデル）。 */
  const lexicographicSign = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
  ): number => {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) {
        return a[i] < b[i] ? -1 : 1;
      }
    }
    return 0;
  };

  it("反射性: 同一バージョンの比較は常に0である", () => {
    fc.assert(
      fc.property(versionStringArb, (version) => {
        expect(compareSemver(version, version)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it("反対称性: 引数を入れ替えると符号が反転する", () => {
    fc.assert(
      fc.property(versionStringArb, versionStringArb, (a, b) => {
        const forward = compareSemver(a, b);
        const backward = compareSemver(b, a);

        expect([-1, 0, 1]).toContain(forward);
        expect([-1, 0, 1]).toContain(backward);

        // `toBe` は `Object.is` 判定であり `Object.is(0, -0)` は false である。
        // `a === b` のときは forward / backward がともに 0 になるため、
        // `expect(sign(forward)).toBe(-sign(backward))` と書くと `0` と `-0` の
        // 比較になって失敗する（生成器が等価な組を作ったときだけ落ちる）。
        // 符号の和が 0 であることを主張すれば -0 に依存せず反対称性を表せる。
        expect(sign(forward) + sign(backward)).toBe(0);

        // 等価判定は双方向で一致する（片側だけが 0 になることはない）。
        expect(forward === 0).toBe(backward === 0);

        // 等価でない組では符号が必ず反転する（どちらも 0 にならない）。
        // ここでの `-sign(forward)` は ±1 のみを取り、-0 は生じない。
        if (forward !== 0) {
          expect(sign(backward)).toBe(-sign(forward));
        }
      }),
      { numRuns: 100 },
    );
  });

  it("推移性: a <= b かつ b <= c ならば a <= c である", () => {
    fc.assert(
      fc.property(
        versionStringArb,
        versionStringArb,
        versionStringArb,
        (a, b, c) => {
          const ab = compareSemver(a, b);
          const bc = compareSemver(b, c);

          if (ab <= 0 && bc <= 0) {
            expect(compareSemver(a, c)).toBeLessThanOrEqual(0);
          }
          if (ab < 0 && bc < 0) {
            expect(compareSemver(a, c)).toBeLessThan(0);
          }
          if (ab === 0 && bc === 0) {
            expect(compareSemver(a, c)).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("比較結果は3要素の数値タプルの辞書式順序と一致する", () => {
    fc.assert(
      fc.property(versionTripleArb, versionTripleArb, (a, b) => {
        const versionA = a.join(".");
        const versionB = b.join(".");

        expect(compareSemver(versionA, versionB)).toBe(
          lexicographicSign(
            a as [number, number, number],
            b as [number, number, number],
          ),
        );
      }),
      { numRuns: 100 },
    );
  });
});

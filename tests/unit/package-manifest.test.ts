import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { compareSemver } from "../../scripts/lib/release.mjs";

// Package_Manifest（`package.json`）の形状を固定するユニットテスト（タスク4.6）。
//
// リポジトリルートは `import.meta.url` から解決する。`process.cwd()` は
// vitest の起動位置に依存するため使わない。
const REPO_ROOT = new URL("../../", import.meta.url);

/**
 * Package_Version / Release_Tag の判定基準。
 * `scripts/lib/release.mjs` の `VALID_VERSION_PATTERN` / `VALID_TAG_PATTERN` と
 * 同一の形（先頭ゼロなし・6桁以下の整数3要素）にそろえている。
 * `compareSemver` はこの形式に一致しない入力に対して `TypeError` を投げるため、
 * 比較へ渡す値は必ず本パターンで濾しておく必要がある。
 */
const VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const RELEASE_TAG_PATTERN =
  /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

/** 期待する実行時依存（要件2.5）。 */
const EXPECTED_DEPENDENCIES = ["@modelcontextprotocol/sdk", "zod"] as const;

/**
 * 期待する開発時依存（要件2.5）。
 *
 * タスク1.4の決定により `yaml`（ワークフローYAMLの構造検証用）が加わっているため、
 * design.md のユニットテスト節が挙げる4要素ではなく**5要素**を期待値とする
 * （prerequisites.md「タスク1.4 ... 後続タスクへの帰結」を参照）。
 */
const EXPECTED_DEV_DEPENDENCIES = [
  "@types/node",
  "fast-check",
  "typescript",
  "vitest",
  "yaml",
] as const;

function readTextFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}

function readJsonObject(relativePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readTextFile(relativePath));
  return asRecord(parsed, relativePath);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} はオブジェクトである必要がある`);
  }
  return value as Record<string, unknown>;
}

/** ドット区切りのパスで入れ子の値を取り出す（存在しない場合は `undefined`）。 */
function getPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** オブジェクトの自前キーを昇順で返す。 */
function sortedKeys(value: unknown, label: string): string[] {
  return Object.keys(asRecord(value, label)).sort();
}

/**
 * `git tag --sort=-v:refname` から Release_Tag 形式のタグのみを抽出し、
 * 最大のバージョン（先頭の `v` を除いた値）を返す。
 *
 * gitが利用できない環境、リポジトリでない場所、タグが1件もない場合は
 * `undefined` を返す。プレリリースタグや `publish.yml` が push するメジャー
 * エイリアスタグ（`v1`）は `compareSemver` が受理しないため除外する。
 */
function latestReleaseTagVersion(): string | undefined {
  const result = spawnSync("git", ["tag", "--sort=-v:refname"], {
    cwd: fileURLToPath(REPO_ROOT),
    encoding: "utf8",
  });

  if (result.error !== undefined || result.status !== 0) {
    return undefined;
  }

  const versions = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((tag) => RELEASE_TAG_PATTERN.test(tag))
    .map((tag) => tag.slice(1));

  if (versions.length === 0) {
    return undefined;
  }

  // git の並び順に依存せず、`compareSemver` で最大値を求める。
  return versions.reduce((max, version) =>
    compareSemver(version, max) > 0 ? version : max,
  );
}

const manifest = readJsonObject("package.json");
const lockfile = readJsonObject("package-lock.json");
const licenseText = readTextFile("LICENSE.md");
const latestTagVersion = latestReleaseTagVersion();

describe("package.json の形状（タスク4.6）", () => {
  describe("bin（要件1.1 / 3.1）", () => {
    it("キー集合が rokadoc-mcp-server 1件のみと厳密一致する", () => {
      expect(sortedKeys(manifest.bin, "package.json の bin")).toEqual([
        "rokadoc-mcp-server",
      ]);
    });

    it("CLI_Entrypoint が dist/index.js である", () => {
      expect(getPath(manifest, "bin.rokadoc-mcp-server")).toBe("dist/index.js");
    });
  });

  describe("files（要件2.1）", () => {
    it("dist と LICENSE.md を含む", () => {
      expect(manifest.files).toEqual(
        expect.arrayContaining(["dist", "LICENSE.md"]),
      );
    });
  });

  describe("メタデータの各値（要件3.1 / 3.4〜3.8 / 5.3）", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["name", "rokadoc-mcp-server"],
      ["type", "module"],
      ["main", "dist/index.js"],
      ["license", "MIT"],
      ["publishConfig.access", "public"],
      ["engines.node", ">=22"],
      ["repository.type", "git"],
      ["repository.url", "https://github.com/yuma-shin/rokadoc-mcp-server"],
      ["bugs.url", "https://github.com/yuma-shin/rokadoc-mcp-server/issues"],
    ];

    it.each(cases)("%s が %s である", (path, expected) => {
      expect(getPath(manifest, path)).toBe(expected);
    });
  });

  describe("description / keywords の境界値（要件3.2）", () => {
    it("description が1文字以上200文字以下の文字列である", () => {
      const { description } = manifest;
      expect(typeof description).toBe("string");
      expect((description as string).length).toBeGreaterThanOrEqual(1);
      expect((description as string).length).toBeLessThanOrEqual(200);
    });

    it("keywords が1個以上10個以下の非空文字列の配列である", () => {
      const { keywords } = manifest;
      expect(Array.isArray(keywords)).toBe(true);
      const list = keywords as unknown[];
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.length).toBeLessThanOrEqual(10);
      for (const keyword of list) {
        expect(typeof keyword).toBe("string");
        expect((keyword as string).length).toBeGreaterThan(0);
      }
    });
  });

  describe("version（要件3.3）", () => {
    it("セマンティックバージョニング形式に一致する", () => {
      expect(manifest.version).toEqual(expect.any(String));
      expect(manifest.version as string).toMatch(VERSION_PATTERN);
    });

    // gitが使えない環境（tarball展開後・git未インストール等）では下限比較のみを
    // スキップする。形式検証は常に実行する。
    it.skipIf(latestTagVersion === undefined)(
      "リポジトリ最新の Release_Tag から v を除いた値以上である",
      () => {
        expect(
          compareSemver(manifest.version as string, latestTagVersion as string),
        ).toBeGreaterThanOrEqual(0);
      },
    );
  });

  describe("依存関係の分割（要件2.5）", () => {
    it("dependencies のキー集合が実行時依存2件と厳密一致する", () => {
      expect(
        sortedKeys(manifest.dependencies, "package.json の dependencies"),
      ).toEqual([...EXPECTED_DEPENDENCIES].sort());
    });

    it("devDependencies のキー集合が開発時依存5件と厳密一致する", () => {
      expect(
        sortedKeys(manifest.devDependencies, "package.json の devDependencies"),
      ).toEqual([...EXPECTED_DEV_DEPENDENCIES].sort());
    });

    it("dependencies と devDependencies の積集合が空である", () => {
      const runtime = new Set(
        sortedKeys(manifest.dependencies, "package.json の dependencies"),
      );
      const overlap = sortedKeys(
        manifest.devDependencies,
        "package.json の devDependencies",
      ).filter((name) => runtime.has(name));
      expect(overlap).toEqual([]);
    });
  });

  describe("package-lock.json との整合", () => {
    // ルートと `packages[""]` の2箇所のどちらかだけが更新されると、
    // `npm ci` 後のバージョンが `package.json` とずれる。
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["version", lockfile.version],
      // `getPath` はドット区切りで辿るため、末尾の空セグメントが `packages[""]` を指す。
      ['packages[""].version', getPath(lockfile, "packages..version")],
    ];

    it.each(cases)("%s が package.json の version と一致する", (_, actual) => {
      expect(actual).toBe(manifest.version);
    });
  });
});

describe("LICENSE.md（要件3.4）", () => {
  it("本文が MIT License を含む", () => {
    expect(licenseText).toContain("MIT License");
  });
});

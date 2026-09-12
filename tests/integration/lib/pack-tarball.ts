/**
 * 統合テスト用の共通ヘルパ: リポジトリ複製・`npm pack` 実行・tarball 解析。
 *
 * `tests/integration/tarball-contents.test.ts`（要件2-2 ほか）と
 * `tests/integration/npm-readme-substitution.test.ts`（要件9-8 / 9-9）の双方が
 * 同一の手順でtarballを取得できるようにするための実装であり、テスト本体は含まない
 * （`vitest.config.ts` の `include` は `tests/**\/*.test.ts` のみを収集する）。
 *
 * ## 設計上の要点
 *
 * - **リポジトリ作業ツリーを汚さない**: `npm pack` は `prepack` により作業ツリーの
 *   `README.md` を `NPM.md` の内容へ差し替える。vitest はテストファイルを並列実行するため、
 *   リポジトリルートで `npm pack` を実行すると差し替え中の `README.md` を他のテスト
 *   （`tests/unit/documentation-consistency.test.ts` はモジュール読み込み時に実 `README.md`
 *   を読む）が観測して間欠的に失敗し得る。したがって `copyRepositoryTo` で一時ディレクトリへ
 *   複製し、**複製側で** `npm pack` を実行する。
 * - **tarballは複製側のルートへ生成させる**: パス引数の受け渡しが不要になり、Windows での
 *   クォート差異の影響を受けない。
 * - **内容の比較は Buffer のバイト比較で行う**: 要件9-8 が求めるのは「NPM_Readmeと同一内容の
 *   `README.md`」であり、文字コード変換・改行変換が挟まっていないことまで主張する必要がある。
 * - **Windows**: tarball内および `npm pack --json` の `files[].path` の区切りは常に `/` である。
 *   また Node.js 20 以降は `.cmd` を `shell` なしで起動できないため、win32 では `npm.cmd` を
 *   `shell: true` で起動する（引数はリテラルのみでパスを含めないためクォートの問題は生じない）。
 *
 * @module tests/integration/lib/pack-tarball
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/** リポジトリルートの絶対パス（`tests/integration/lib/` から3階層上）。 */
export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** 複製から除外するルート直下のディレクトリ。 */
const COPY_EXCLUDED_TOP_LEVEL = ["node_modules", ".git"] as const;

/** OS依存の区切り文字を `/` へ正規化する。 */
export function toPosix(path: string): string {
  return path.split(sep).join(posix.sep);
}

/**
 * リポジトリを一時ディレクトリへ複製する（`node_modules` と `.git` を除く）。
 *
 * `npm pack` は依存関係のインストールを必要とせず、`prepack` は Node.js 組込みモジュール
 * のみに依存するため、`node_modules` を複製しなくても本物のライフサイクルが実行できる。
 *
 * @param destination 複製先（存在しない場合は作成される）
 * @returns 複製先の絶対パス
 */
export function copyRepositoryTo(destination: string): string {
  cpSync(repositoryRoot, destination, {
    recursive: true,
    filter: (source: string): boolean => {
      const relativePath = relative(repositoryRoot, source);
      if (relativePath === "") {
        return true;
      }
      const topLevel = relativePath.split(sep)[0];
      return !COPY_EXCLUDED_TOP_LEVEL.includes(
        topLevel as (typeof COPY_EXCLUDED_TOP_LEVEL)[number],
      );
    },
  });
  return destination;
}

/** `npm pack --json` の出力要素（prerequisites.md タスク1.2 で実測したスキーマ）。 */
export interface PackFileEntry {
  readonly path: string;
  readonly size: number;
}

/** `npm pack --json` の出力（要素1個の配列の中身）。 */
export interface PackReport {
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly entryCount: number;
  readonly files: ReadonlyArray<PackFileEntry>;
}

/** `npm pack --json` の標準出力を検証しながら `PackReport` へ変換する。 */
export function parsePackReport(stdout: string): PackReport {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(
      `npm pack --json の出力が要素1個の配列ではない: ${stdout.slice(0, 500)}`,
    );
  }
  const report = parsed[0] as Partial<PackReport>;
  const { filename, size, unpackedSize, entryCount, files } = report;
  if (
    typeof filename !== "string" ||
    typeof size !== "number" ||
    typeof unpackedSize !== "number" ||
    typeof entryCount !== "number" ||
    !Array.isArray(files)
  ) {
    throw new Error(
      `npm pack --json の出力に期待するフィールドが無い（npmのバージョン差異の可能性）: ` +
        `${JSON.stringify(Object.keys(report))}`,
    );
  }
  for (const file of files) {
    if (typeof file.path !== "string" || typeof file.size !== "number") {
      throw new Error(
        `files[] の要素に path / size が無い: ${JSON.stringify(file)}`,
      );
    }
  }
  return { filename, size, unpackedSize, entryCount, files };
}

/** `npm pack` の実行結果。 */
export interface NpmPackResult {
  /** `--json` 出力の解析結果。 */
  readonly report: PackReport;
  /** 生成されたtarballの絶対パス（`cwd` 直下）。 */
  readonly tarballPath: string;
}

/**
 * 指定ディレクトリで `npm pack --json` を実行する。
 *
 * @param cwd 実行ディレクトリ（**リポジトリルートを渡してはならない**。上記「設計上の要点」参照）
 * @param extraArgs 追加引数（例: `["--ignore-scripts"]`）
 * @returns `--json` 出力と生成されたtarballのパス
 */
export function runNpmPack(
  cwd: string,
  extraArgs: readonly string[] = [],
): NpmPackResult {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["pack", "--json", ...extraArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // Node.js 20 以降は `.cmd` を shell なしで起動できない。引数にパスを含めないため安全である。
    shell: process.platform === "win32",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `npm pack が失敗した（終了コード ${String(result.status)}）:\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  const report = parsePackReport(result.stdout);
  const tarballPath = join(cwd, report.filename);
  if (!existsSync(tarballPath)) {
    throw new Error(
      `生成されたtarballが見つからない: ${report.filename}（実行ディレクトリの内容: ` +
        `${readdirSync(cwd).join(", ")}）`,
    );
  }
  return { report, tarballPath };
}

/** tarヘッダのNUL終端文字列フィールドを読む。 */
function readHeaderString(
  header: Buffer,
  offset: number,
  length: number,
): string {
  const raw = header.subarray(offset, offset + length).toString("utf8");
  const terminator = raw.indexOf("\0");
  return terminator === -1 ? raw : raw.slice(0, terminator);
}

/** pax拡張ヘッダから `path=` の上書き値を取り出す（無ければ `null`）。 */
function readPaxPath(content: Buffer): string | null {
  for (const record of content.toString("utf8").split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match !== null) {
      return match[1];
    }
  }
  return null;
}

/**
 * tarアーカイブ（非圧縮）を解析し、通常ファイルのパスと内容を返す。
 *
 * npmが生成するtarballは通常ファイルのみ・`package/` 接頭辞付きの短いパスであることを
 * 実測しているが、pax拡張ヘッダ（`x` / `g`）とGNU longname（`L`）にも念のため対応する。
 */
export function parseTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let overriddenName: string | null = null;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readHeaderString(header, 0, 100);
    const prefix = readHeaderString(header, 345, 155);
    const sizeField = readHeaderString(header, 124, 12).trim();
    const size = sizeField === "" ? 0 : Number.parseInt(sizeField, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`tarヘッダのサイズフィールドが不正である: "${sizeField}"`);
    }
    const typeFlag = String.fromCharCode(header[156]);
    const contentStart = offset + 512;
    const content = buffer.subarray(contentStart, contentStart + size);
    offset = contentStart + Math.ceil(size / 512) * 512;

    if (typeFlag === "x" || typeFlag === "g") {
      const paxPath = readPaxPath(content);
      if (paxPath !== null) {
        overriddenName = paxPath;
      }
      continue;
    }
    if (typeFlag === "L") {
      overriddenName = content.toString("utf8").replace(/\0+$/, "");
      continue;
    }

    const entryPath =
      overriddenName ?? (prefix === "" ? name : `${prefix}/${name}`);
    overriddenName = null;

    // 通常ファイルのみを収録対象として数える（`0` / NUL は通常ファイル、`5` はディレクトリ）。
    if (typeFlag === "0" || typeFlag === "\0") {
      files.set(entryPath, Buffer.from(content));
    }
  }
  return files;
}

/**
 * tarball（gzip圧縮）を読み、通常ファイルのパスと内容を返す。
 *
 * キーはtarball内の生のパス（`package/` 接頭辞を含む）。
 *
 * @param tarballPath tarballの絶対パス
 * @returns エントリパスと内容の対応
 */
export function readTarballEntries(tarballPath: string): Map<string, Buffer> {
  return parseTar(gunzipSync(readFileSync(tarballPath)));
}

/** `package/` 接頭辞を除いたキーへ付け替える。 */
export function stripPackagePrefix(
  entries: ReadonlyMap<string, Buffer>,
): Map<string, Buffer> {
  const stripped = new Map<string, Buffer>();
  for (const [rawPath, content] of entries) {
    stripped.set(rawPath.replace(/^package\//, ""), content);
  }
  return stripped;
}

/**
 * tarballをディレクトリへ展開し、展開されたファイルのパスと内容を返す。
 *
 * `npm install <tarball>` と同様に `package/` 接頭辞を剥がして `destination` 直下へ配置する。
 * 収録パスに親ディレクトリ参照（`..`）や絶対パスが含まれる場合は展開せず失敗させる
 * （tarball自体は自プロジェクトの生成物だが、展開先の外へ書き込む経路を残さない）。
 *
 * @param tarballPath tarballの絶対パス
 * @param destination 展開先ディレクトリ（存在しない場合は作成される）
 * @returns 展開後の相対パス（区切りは `/`）と内容の対応
 */
export function extractTarball(
  tarballPath: string,
  destination: string,
): Map<string, Buffer> {
  const entries = stripPackagePrefix(readTarballEntries(tarballPath));
  const extracted = new Map<string, Buffer>();

  mkdirSync(destination, { recursive: true });
  for (const [relativePath, content] of entries) {
    const segments = relativePath.split("/");
    if (
      relativePath === "" ||
      relativePath.startsWith("/") ||
      /^[A-Za-z]:/.test(relativePath) ||
      segments.includes("..")
    ) {
      throw new Error(`展開先の外を指すエントリが含まれている: ${relativePath}`);
    }
    const target = join(destination, ...segments);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    extracted.set(relativePath, content);
  }
  return extracted;
}

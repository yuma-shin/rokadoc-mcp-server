import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * シバン行の不変条件テスト（要件1-2 / 1-6）
 *
 * CLI_Entrypoint（`dist/index.js`）が `npx` / 直接実行のいずれでもNode.jsで
 * 起動できるよう、次を固定する。
 *
 * - 先頭3バイトがUTF-8 BOM（`EF BB BF`）ではない
 * - 先頭が `#!/usr/bin/env node` で始まり、その直後が改行である
 * - シバン行より前に空行・空白文字が存在しない
 *
 * ファイルは必ずBufferとして読む。文字列へデコードするとBOMや改行コードの差異
 * （CRLF / LF）が観測できなくなるためである。
 */

// リポジトリルートは import.meta.url から解決する（process.cwd() に依存しない）。
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..");

const SHEBANG = "#!/usr/bin/env node";
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * 成果物依存テストの共通方針:
 * `dist/` が未生成の場合、CI（`process.env.CI` が設定されている）では失敗させる。
 * CIではビルド後にテストが走るため、成果物がないこと自体が異常である。
 * ローカルでは理由付きでスキップする。
 */
function requireArtifact(relativePath: string): Buffer | null {
  const absolutePath = resolve(repoRoot, relativePath);
  if (existsSync(absolutePath)) {
    return readFileSync(absolutePath);
  }
  if (process.env.CI) {
    throw new Error(
      `ビルド成果物 ${relativePath} が存在しない（CIではビルド後に実行されるため異常である）。` +
        `\`npm run build\` の実行結果を確認すること。`,
    );
  }
  return null;
}

/** スキップ時にテスト名へ添える理由（ローカルで `dist/` 未生成の場合のみ発生する）。 */
function suffix(artifact: Buffer | null): string {
  return artifact === null
    ? "（スキップ: dist/ が未生成。`npm run build` 後に検証される）"
    : "";
}

/** シバン行に関する全アサーションをまとめて適用する。 */
function assertShebang(buffer: Buffer, label: string): void {
  // 1. 先頭3バイトがUTF-8 BOMでないこと。
  expect(
    buffer.subarray(0, 3).equals(UTF8_BOM),
    `${label}: 先頭にUTF-8 BOMが存在する`,
  ).toBe(false);

  // 2. 先頭バイトから直ちにシバン行が始まること（前置される空白・空行がない）。
  //    `indexOf` ではなく先頭一致で判定することで、前に何かが挿入された場合を弾く。
  const head = buffer.subarray(0, SHEBANG.length).toString("latin1");
  expect(head, `${label}: 1バイト目から ${SHEBANG} で始まっていない`).toBe(
    SHEBANG,
  );

  // 3. シバン行の直後が改行であること。
  //    `src/index.ts` は作業ツリー上CRLF、`dist/index.js` は tsc によりLFへ
  //    正規化されるため、`\n` と `\r\n` の双方を許容する。
  const terminator = buffer.subarray(SHEBANG.length, SHEBANG.length + 2);
  const isLf = terminator[0] === 0x0a;
  const isCrLf = terminator[0] === 0x0d && terminator[1] === 0x0a;
  expect(
    isLf || isCrLf,
    `${label}: シバン行の直後が改行（LF または CRLF）でない: ${JSON.stringify(
      terminator.toString("latin1"),
    )}`,
  ).toBe(true);
}

describe("シバン行の不変条件", () => {
  describe("src/index.ts", () => {
    const source = readFileSync(resolve(repoRoot, "src/index.ts"));

    it("BOMなし・1行目がシバン行・前置の空白や空行がない", () => {
      assertShebang(source, "src/index.ts");
    });

    it("2行目がJSDocコメントの開始である（空行が挿入されていない）", () => {
      const lines = source.toString("utf8").split(/\r?\n/);
      expect(lines[0]).toBe(SHEBANG);
      expect(lines[1]).toBe("/**");
    });
  });

  describe("dist/index.js（CLI_Entrypoint）", () => {
    const artifact = requireArtifact("dist/index.js");

    it.skipIf(artifact === null)(
      `BOMなし・1行目がシバン行・前置の空白や空行がない${suffix(artifact)}`,
      () => {
        assertShebang(artifact as Buffer, "dist/index.js");
      },
    );

    it.skipIf(artifact === null)(
      `シバン行がLFで終端されている（Unix環境での \`#!\` 解釈のため）${suffix(artifact)}`,
      () => {
        expect((artifact as Buffer)[SHEBANG.length]).toBe(0x0a);
      },
    );
  });

  describe("dist/index.d.ts", () => {
    const declaration = requireArtifact("dist/index.d.ts");

    /**
     * 実挙動の記録（判断の根拠は prerequisites.md「要注意: タスク4.7の期待値と実挙動の不一致」）:
     * `tsc` は `src/index.ts` 先頭のシバン行を型定義ファイルにも出力する
     * （typescript 5.9.3 / 7.0.2 の双方で再現）。
     *
     * これは要件違反ではない。要件1-2 / 1-6 が対象とするのはCLI_Entrypoint
     * （`dist/index.js`）のみであり、型定義ファイルは実行されないため無害である。
     * `postbuild` での除去も行わない（`dist/index.d.ts.map` の行番号がずれる）。
     *
     * 以下は「現在の挙動」を固定するアサーションであり、シバン行の存在を
     * 要求するものではない。将来 `tsc` の挙動が変わって消えた場合に気付ける
     * ようにしておくのが目的で、その際は本アサーションを緩めればよい。
     */
    it.skipIf(declaration === null)(
      `先頭のシバン行は tsc の副作用として許容する（必須ではない）${suffix(declaration)}`,
      () => {
        const head = (declaration as Buffer)
          .subarray(0, SHEBANG.length)
          .toString("latin1");
        expect(head).toBe(SHEBANG);
      },
    );

    it.skipIf(declaration === null)(
      `BOMが付与されていない${suffix(declaration)}`,
      () => {
        expect((declaration as Buffer).subarray(0, 3).equals(UTF8_BOM)).toBe(
          false,
        );
      },
    );
  });
});

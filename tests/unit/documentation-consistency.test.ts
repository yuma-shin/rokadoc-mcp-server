import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// ドキュメント整合性テスト（タスク7.3）。
//
// `package.json` と `src/config.ts` を単一の真実の源として、
// `README.md`（Release_Documentation）と `NPM.md`（NPM_Readme）の双方に
// 共有値・設定例・非回帰要素が存在することを機械的に検証する。
// 要件3-7 / 8-1〜8-9 / 9-1〜9-7 に対応する。
//
// 限界: 要件8-7「対比して記載する」のような自然言語の質的判断は機械検証できない。
// ここでは節見出しと双方の配布形態への言及の存在に検証対象を限定し、
// 記述内容の妥当性は人手レビューに委ねる。
const REPO_ROOT = new URL("../../", import.meta.url);

function readTextFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface CodeBlock {
  /** フェンスの言語指定（小文字化。無指定の場合は空文字列）。 */
  readonly lang: string;
  /** フェンス内の本文。 */
  readonly body: string;
}

/**
 * Markdownからフェンス付きコードブロックを抽出する。
 *
 * リスト項目内にインデントされたブロック（`README.md` の `.npmrc` 例）も
 * 拾えるよう、開始・終了フェンスの前の空白を許容する。
 */
const CODE_BLOCK_PATTERN =
  /^[ \t]*```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const pattern = new RegExp(CODE_BLOCK_PATTERN.source, "gm");
  let match: RegExpExecArray | null = pattern.exec(markdown);
  while (match !== null) {
    blocks.push({
      lang: (match[1] ?? "").toLowerCase(),
      body: match[2] ?? "",
    });
    match = pattern.exec(markdown);
  }
  return blocks;
}

/** コードブロックを除去した本文（見出し抽出時にコード中の `#` を拾わないため）。 */
function stripCodeBlocks(markdown: string): string {
  return markdown.replace(new RegExp(CODE_BLOCK_PATTERN.source, "gm"), "");
}

/** H1 と H2 の見出しテキストを出現順に返す。 */
function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of stripCodeBlocks(markdown).split(/\r?\n/)) {
    const match = /^(#{1,2})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match !== null) {
      headings.push(`${match[1] ?? ""} ${match[2] ?? ""}`);
    }
  }
  return headings;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `servers` / `mcpServers` の直下に並ぶサーバー定義オブジェクトを返す。 */
function serverEntries(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  const container = value[key];
  if (!isRecord(container)) {
    return [];
  }
  return Object.values(container).filter(isRecord);
}

/**
 * 指定キー（`servers` / `mcpServers`）を持ち、`command` が `npx` で、
 * かつ `ROKADOC_API_KEY` への言及を含むJSONコードブロックを返す。
 */
function npxClientExamples(blocks: readonly CodeBlock[], key: string): CodeBlock[] {
  return blocks.filter((block) => {
    if (block.lang !== "json" || !block.body.includes("ROKADOC_API_KEY")) {
      return false;
    }
    const entries = serverEntries(parseJsonOrUndefined(block.body), key);
    return entries.some((entry) => entry.command === "npx");
  });
}

/** コードブロック内に現れる絶対パス形式（`/...` または `C:\...`）の行を返す。 */
function absolutePathLines(blocks: readonly CodeBlock[]): string[] {
  return blocks
    .flatMap((block) => block.body.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => /^(\/[^\s"]|[A-Za-z]:\\)/.test(line));
}

const manifest = parseJsonOrUndefined(readTextFile("package.json"));
if (!isRecord(manifest)) {
  throw new Error("package.json はオブジェクトである必要がある");
}
const configSource = readTextFile("src/config.ts");
const readme = readTextFile("README.md");
const npmReadme = readTextFile("NPM.md");

const packageName = manifest.name;
const enginesNode = isRecord(manifest.engines) ? manifest.engines.node : undefined;

/** `src/config.ts` の `DEFAULT_BASE_URL` を単一の真実の源として抽出する。 */
const defaultBaseUrl = /DEFAULT_BASE_URL\s*=\s*"([^"]+)"/.exec(configSource)?.[1];

/** `src/config.ts` が標準エラー出力へ書き出すAPIキー未設定メッセージ（要件8-8）。 */
const apiKeyErrorMessage =
  /"(\[設定エラー\] 環境変数 ROKADOC_API_KEY[^"]*?)\\n"/.exec(configSource)?.[1];

const readmeBlocks = extractCodeBlocks(readme);
const npmReadmeBlocks = extractCodeBlocks(npmReadme);

const DOCUMENTS: ReadonlyArray<
  readonly [label: string, text: string, blocks: readonly CodeBlock[]]
> = [
  ["README.md", readme, readmeBlocks],
  ["NPM.md", npmReadme, npmReadmeBlocks],
];

describe("真実の源からの共有値の抽出", () => {
  it("package.json の name / engines.node が文字列として取得できる", () => {
    expect(packageName).toBe("rokadoc-mcp-server");
    expect(enginesNode).toBe(">=22");
  });

  it("src/config.ts から DEFAULT_BASE_URL とAPIキー未設定メッセージを抽出できる", () => {
    expect(defaultBaseUrl).toBe("https://api.rokadoc.ntt.com");
    expect(apiKeyErrorMessage).toEqual(expect.any(String));
  });
});

describe("共有値の相互一致（要件3-7 / 8-1 / 8-9 / 9-6）", () => {
  const sharedValues: ReadonlyArray<readonly [label: string, value: string]> = [
    ["環境変数名 ROKADOC_API_KEY", "ROKADOC_API_KEY"],
    ["環境変数名 ROKADOC_BASE_URL", "ROKADOC_BASE_URL"],
    ["ROKADOC_BASE_URL の既定値", defaultBaseUrl as string],
    ["Node.js 最小メジャーバージョン", enginesNode as string],
    ["パッケージ名", packageName as string],
  ];

  const cases = DOCUMENTS.flatMap(([docLabel, text]) =>
    sharedValues.map(
      ([valueLabel, value]) => [docLabel, valueLabel, value, text] as const,
    ),
  );

  it.each(cases)("%s に %s（%s）が出現する", (_docLabel, _valueLabel, value, text) => {
    expect(text).toContain(value);
  });
});

describe("MCPクライアント設定例のJSON（要件8-3 / 9-5）", () => {
  const jsonBlockCases = DOCUMENTS.flatMap(([docLabel, , blocks]) =>
    blocks
      .filter((block) => block.lang === "json")
      .map((block, index) => [docLabel, index, block] as const),
  );

  it.each(jsonBlockCases)(
    "%s の json コードブロック #%i が JSON.parse 可能である",
    (_docLabel, _index, block) => {
      expect(() => JSON.parse(block.body)).not.toThrow();
    },
  );

  const keyCases = DOCUMENTS.flatMap(([docLabel, , blocks]) =>
    (["servers", "mcpServers"] as const).map(
      (key) => [docLabel, key, blocks] as const,
    ),
  );

  it.each(keyCases)(
    "%s に %s キーの npx 設定例が1件以上あり ROKADOC_API_KEY を含む",
    (_docLabel, key, blocks) => {
      expect(npxClientExamples(blocks, key).length).toBeGreaterThanOrEqual(1);
    },
  );
});

describe("絶対パス指定例（要件8-4 / 9-5）", () => {
  const cases = DOCUMENTS.map(
    ([docLabel, , blocks]) => [docLabel, blocks] as const,
  );

  it.each(cases)(
    "%s に絶対パス形式の例が1件以上ある",
    (_docLabel, blocks) => {
      expect(absolutePathLines(blocks).length).toBeGreaterThanOrEqual(1);
    },
  );
});

describe("README.md の記載（要件8-2 / 8-5 / 8-6 / 8-7 / 8-8 / 8-9）", () => {
  const cases: ReadonlyArray<readonly [label: string, needle: string]> = [
    // 8-6: 既存Docker手順の非回帰
    ["Dockerイメージ取得手順", "docker pull"],
    ["コンテナ起動手順", "docker run"],
    ["トラブルシューティング節", "## トラブルシューティング"],
    // 8-7: 配布形態の選択指針
    ["配布形態の選択節", "## 配布形態の選択"],
    // 8-2: npx 起動手順
    ["npx 起動コマンド", "npx -y rokadoc-mcp-server"],
    // 8-5: GitHub Packages からの取得手順
    ["スコープのレジストリ設定", "@yuma-shin:registry"],
    ["GitHub Packages のレジストリURL", "npm.pkg.github.com"],
    ["Scoped_Package_Name", "@yuma-shin/rokadoc-mcp-server"],
    // 8-9: NPM_Readme への参照
    ["NPM.md へのリンク", "](NPM.md)"],
    // 8-8: 起動失敗条件の観測事象
    ["EBADENGINE への言及", "EBADENGINE"],
  ];

  it.each(cases)("%s（%s）が存在する", (_label, needle) => {
    expect(readme).toContain(needle);
  });

  it("APIキー未設定時のエラーメッセージが src/config.ts と一致する（要件8-8）", () => {
    expect(readme).toContain(apiKeyErrorMessage as string);
  });

  it("バージョン固定コマンドの形式を記載している（要件8-2）", () => {
    expect(readme).toMatch(/npx\s+-y\s+"?rokadoc-mcp-server@\d+\.\d+\.\d+/);
  });
});

describe("NPM.md の節構成（要件9-1 / 9-2）", () => {
  const EXPECTED_HEADINGS = [
    "# rokadoc MCP Server",
    "## クイックスタート",
    "## バージョン指定",
    "## 前提条件",
    "## 環境変数",
    "## 提供ツール",
    "## MCPクライアント設定例",
    "## ファイルパスの扱い",
    "## プロンプト例",
    "## 対応ファイル形式",
    "## ソースコード",
    "## ライセンス",
  ] as const;

  it("H1 と H2 の見出しが期待する12節と厳密一致する", () => {
    expect(extractHeadings(npmReadme)).toEqual([...EXPECTED_HEADINGS]);
  });

  const contentCases: ReadonlyArray<readonly [label: string, needle: string]> = [
    ["ソースコードへのリンク", "https://github.com/yuma-shin/rokadoc-mcp-server"],
    ["ライセンス表記", "MIT"],
    ["対応ファイル形式（PDF）", "PDF (.pdf)"],
    ["対応ファイル形式（Word）", "Word (.doc, .docx)"],
    ["対応ファイル形式（Excel）", "Excel (.xls, .xlsx)"],
    ["対応ファイル形式（PowerPoint）", "PowerPoint (.ppt, .pptx)"],
  ];

  it.each(contentCases)("%s（%s）が存在する", (_label, needle) => {
    expect(npmReadme).toContain(needle);
  });
});

describe("NPM.md の提供ツールとバージョン指定（要件9-3 / 9-4）", () => {
  const toolCases: ReadonlyArray<readonly [string]> = [
    ["convert_document"],
    ["list_conversions"],
    ["get_conversion_result"],
    ["search_documents"],
  ];

  it.each(toolCases)("提供ツール %s を記載している", (tool) => {
    expect(npmReadme).toContain(tool);
  });

  const versionCases: ReadonlyArray<readonly [label: string, needle: string]> = [
    ["特定バージョン固定", "@<version>"],
    ["最新リリース", "@latest"],
    ["メジャーバージョン追従", "@^"],
    ["マイナーバージョン追従", "@~"],
  ];

  it.each(versionCases)("バージョン指定 %s（%s）を記載している", (_label, needle) => {
    expect(npmReadme).toContain(needle);
  });
});

describe("NPM.md に Docker 固有記述がない（要件9-7）", () => {
  const FORBIDDEN = [
    "docker run",
    "docker pull",
    "-v ",
    "/workspace",
    "linux/amd64",
    "linux/arm64",
  ] as const;

  it.each(FORBIDDEN.map((word) => [word] as const))(
    "禁止語 %s が出現しない",
    (word) => {
      expect(npmReadme).not.toContain(word);
    },
  );
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { TestContext } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  copyRepositoryTo,
  repositoryRoot,
  runNpmPack,
} from "./lib/pack-tarball.js";

/**
 * CLI起動テスト（要件1-3 / 1-5 / 1-9 / 7-4）
 *
 * `npm pack` で生成したtarballを一時ディレクトリへ `npm install <tarball>` でインストールし、
 * 登録された `node_modules/.bin/rokadoc-mcp-server` を実プロセスとして起動して次を検証する。
 *
 * - `ROKADOC_API_KEY` 設定時、プロセス起動から5秒以内にJSON-RPC 2.0 `initialize` へ応答する（要件1-3）
 * - 標準出力に出現するのはJSON-RPCメッセージのみである（要件1-9 の動的検証）
 * - `ROKADOC_API_KEY` 未設定時、標準エラー出力へAPIキー未設定のメッセージを出し、
 *   `initialize` へ応答せず終了コード1で終了する（要件1-5）
 * - `node dist/index.js` 形式の直接起動でも `initialize` へ応答する（Docker起動経路の非回帰。要件7-4）
 *
 * 既存の `tests/unit/mcp-server.test.ts` はサーバー生成関数を直接呼ぶインプロセステストであり、
 * 本テストは「配布物として取り出したものが起動するか」という別の関心を扱うため重複しない。
 *
 * ## プロセス起動は3回のみ
 *
 * 実プロセスの起動はコストが高いため、起動回数は3回（シム経由で鍵あり / 鍵なし、`node dist/index.js`
 * 直接起動）に限る。鍵ありの起動結果は要件1-3 と要件1-9 の双方のアサーションで共有する
 * （`runShimWithKeyOnce()`）。vitest は同一ファイル内のテストを順に実行するため共有に競合はない。
 *
 * ## 計測方針（5秒アサーションの扱いの判断記録）
 *
 * 要件1-3 が定める5秒は「NPM_Packageの取得完了後に開始されるMCP_Serverプロセスの起動時点」を
 * 起点とする。したがって計測起点は `spawn` の直前であり、`npm install`（npxのダウンロード相当）は
 * `beforeAll` で済ませて計測窓から外す。
 *
 * 実測値（Windows 11 / Node.js 22 / npm 9、ローカル）は シム経由 約0.40秒、`node dist/index.js`
 * 直接起動 約0.32秒 であり、5秒の予算に対して1桁の余裕がある。よって**5秒アサーションはスモークへ
 * 格下げせず、上限値としてそのまま維持する**（タスク8.3 の「計測が不安定な場合は格下げする」判断に
 * 対する記録）。安定性のための手当ては次の2点に限る。
 *
 * 1. 応答待ちの打ち切りは5秒ではなく20秒（`RESPONSE_WATCHDOG_MS`）で行う。5秒で打ち切ると
 *    「起動はしたが遅い」場合に「応答なし」と区別できなくなるため、打ち切りは十分長く取り、
 *    5秒は**計測値に対するアサーション**として独立させる。これにより失敗時のメッセージが
 *    「6.2秒かかった」のように原因を示す形になる。
 * 2. 5秒を超えた場合は間欠失敗として黙らせず、実測値を添えて失敗させる。将来この計測が
 *    CIで不安定になった場合は、本コメントの判断を更新した上で `it` を
 *    「応答が返ること（スモーク）」と「参考値のログ出力」へ分割すること。
 *
 * ## ネットワーク依存の扱い
 *
 * `npm install <tarball>` は実行時依存（`@modelcontextprotocol/sdk` / `zod`）をレジストリから取得する
 * ためネットワークを要する。取得に失敗した場合は、成果物依存テストの共通方針（`tests/unit/shebang.test.ts`
 * 参照）に合わせて **CIでは失敗**、ローカルでは理由付きスキップとする。ネットワーク以外の原因
 * （tarballが壊れている、`bin` が登録されない等）は配布物の欠陥であり、ローカルでも失敗させる。
 *
 * ## Windows での注意
 *
 * - npmが生成する実行シムは `rokadoc-mcp-server`（sh用）と `rokadoc-mcp-server.cmd`（cmd用）であり、
 *   win32 では後者を起動する。Node.js 20 以降は `.cmd` を `shell` なしで起動できないため `shell: true`
 *   を指定する。この場合 `cmd.exe` が中間プロセスとなるため、強制終了はプロセスツリーごと
 *   （`taskkill /T /F`）行う。
 * - `npm install` へ渡すtarballは一旦インストール先へ複写し、`./<ファイル名>` という空白を含まない
 *   相対指定で渡す（`shell: true` 実行時のクォート差異を避けるため。`lib/pack-tarball.ts` と同じ方針）。
 */

/** JSON-RPC の `initialize` に用いるリクエストID。 */
const REQUEST_ID = 1;

/** 要件1-3 が定める起動から `initialize` 応答までの上限。 */
const STARTUP_BUDGET_MS = 5_000;

/** 応答待ちの打ち切り（5秒アサーションとは独立。上記「計測方針」参照）。 */
const RESPONSE_WATCHDOG_MS = 20_000;

/** 標準入力を閉じてからプロセス終了を待つ猶予（超過時はプロセスツリーを強制終了する）。 */
const TERMINATION_GRACE_MS = 5_000;

/** `npm install` の上限時間（計測窓には含まれない）。 */
const INSTALL_TIMEOUT_MS = 300_000;

/** ネットワーク起因と判断する `npm install` の失敗メッセージ。 */
const NETWORK_FAILURE_SIGNATURES = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ERR_SOCKET_TIMEOUT",
  "network",
  "getaddrinfo",
  "request to https://registry.npmjs.org",
] as const;

const isCI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * 成果物依存テストの共通方針（`tests/unit/shebang.test.ts` / `tarball-contents.test.ts` と同一）:
 * `dist/index.js` が無い場合、CIではビルド後に実行されるため異常として失敗させ、
 * ローカルでは理由付きでスキップする。
 */
const distAvailable = existsSync(join(repositoryRoot, "dist", "index.js"));

/** JSON-RPC 2.0 メッセージの最小形。 */
interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: unknown;
}

/** インストール済みCLIの配置。 */
interface CliFixture {
  /** `npm install` を実行した一時ディレクトリ。 */
  readonly installDir: string;
  /** インストールされたパッケージのルート（`node_modules/rokadoc-mcp-server`）。 */
  readonly packageDir: string;
  /** 起動に用いる実行シムの絶対パス（win32 では `.cmd`）。 */
  readonly binPath: string;
  /** POSIX用シム（拡張子なし）の絶対パス。存在確認に用いる。 */
  readonly posixBinPath: string;
  /** cmd用シムの絶対パス。存在確認に用いる（win32 以外では存在しない）。 */
  readonly cmdBinPath: string;
}

/** セットアップ失敗の分類。 */
interface SetupFailure {
  /** `network`: 環境要因（ローカルではスキップ） / `defect`: 配布物の欠陥（常に失敗）。 */
  readonly kind: "network" | "defect";
  readonly error: Error;
}

let workDir: string | null = null;
let fixture: CliFixture | null = null;
let setupFailure: SetupFailure | null = null;

/** `npm` の実行ファイル名（win32 では `.cmd`）。 */
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/** 失敗メッセージがネットワーク起因を示すか判定する。 */
function looksLikeNetworkFailure(text: string): boolean {
  return NETWORK_FAILURE_SIGNATURES.some((signature) =>
    text.includes(signature),
  );
}

beforeAll(() => {
  if (!distAvailable) {
    return;
  }
  try {
    workDir = mkdtempSync(join(tmpdir(), "rokadoc-cli-"));

    // 1. リポジトリを複製し、複製側で `npm pack` する（実リポジトリの `README.md` を汚さない。
    //    理由は `lib/pack-tarball.ts` の「設計上の要点」を参照）。
    const tree = join(workDir, "repo");
    copyRepositoryTo(tree);
    const { tarballPath } = runNpmPack(tree);

    // 2. インストール先を用意する。`private: true` の最小マニフェストを置き、
    //    リポジトリの依存関係とは無関係な素の環境でインストールする。
    const installDir = join(workDir, "install");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, "package.json"),
      `${JSON.stringify(
        {
          name: "rokadoc-cli-startup-probe",
          version: "1.0.0",
          private: true,
        },
        null,
        2,
      )}\n`,
    );

    // 3. tarballをインストール先へ複写し、空白を含まない相対指定でインストールする。
    const tarballName = basename(tarballPath);
    copyFileSync(tarballPath, join(installDir, tarballName));
    const install = spawnSync(
      npmCommand,
      [
        "install",
        `./${tarballName}`,
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        "--ignore-scripts",
        "--loglevel=error",
      ],
      {
        cwd: installDir,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: INSTALL_TIMEOUT_MS,
        // Node.js 20 以降は `.cmd` を shell なしで起動できない。引数にパスを含めないため安全である。
        shell: process.platform === "win32",
      },
    );
    if (install.error !== undefined) {
      throw install.error;
    }
    if (install.status !== 0) {
      const detail =
        `npm install <tarball> が失敗した（終了コード ${String(install.status)}）:\n` +
        `stdout: ${install.stdout}\nstderr: ${install.stderr}`;
      setupFailure = {
        kind: looksLikeNetworkFailure(`${install.stdout}${install.stderr}`)
          ? "network"
          : "defect",
        error: new Error(detail),
      };
      return;
    }

    const binDir = join(installDir, "node_modules", ".bin");
    const posixBinPath = join(binDir, "rokadoc-mcp-server");
    const cmdBinPath = join(binDir, "rokadoc-mcp-server.cmd");
    fixture = {
      installDir,
      packageDir: join(installDir, "node_modules", "rokadoc-mcp-server"),
      binPath: process.platform === "win32" ? cmdBinPath : posixBinPath,
      posixBinPath,
      cmdBinPath,
    };
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    setupFailure = {
      kind: looksLikeNetworkFailure(normalized.message) ? "network" : "defect",
      error: normalized,
    };
  }
}, 600_000);

afterAll(() => {
  if (workDir !== null) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

/**
 * インストール済みCLIを取り出す。
 *
 * ネットワーク起因の失敗はローカルでのみスキップし、それ以外は原因を示して失敗させる。
 */
function requireFixture(context: TestContext): CliFixture {
  if (fixture !== null) {
    return fixture;
  }
  if (setupFailure === null) {
    throw new Error("インストール済みCLIの準備結果が取得できていない");
  }
  if (setupFailure.kind === "network" && !isCI) {
    console.warn(
      "レジストリへ到達できないため CLI起動テストをスキップした（CIでは失敗として扱う）:\n" +
        setupFailure.error.message,
    );
    context.skip();
  }
  throw setupFailure.error;
}

/** 子プロセスへ渡す環境変数を組み立てる。 */
function buildChildEnv(
  overrides: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 開発者のシェルに設定済みの値が混入すると鍵未設定ケースが成立しないため、明示的に除去する。
  delete env.ROKADOC_API_KEY;
  delete env.ROKADOC_BASE_URL;
  // 標準出力へ余計な出力を行う可能性のある注入設定を排除する（要件1-9 の検証を汚さないため）。
  delete env.NODE_OPTIONS;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/** プロセスツリーを強制終了する（win32 では `cmd.exe` の子まで落とす）。 */
function forceKillTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGKILL");
}

/** `initialize` リクエスト1行（改行区切りJSON）。 */
const initializeRequest = `${JSON.stringify({
  jsonrpc: "2.0",
  id: REQUEST_ID,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cli-startup-test", version: "1.0.0" },
  },
})}\n`;

/** 1回の起動の観測結果。 */
interface ServerRun {
  /** 起動から `initialize` 応答受信までの経過ms（応答が無ければ `null`）。 */
  readonly elapsedToResponseMs: number | null;
  /** 受信した `initialize` の応答（無ければ `null`）。 */
  readonly response: JsonRpcMessage | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** 猶予時間内に終了せず強制終了したか。 */
  readonly forciblyTerminated: boolean;
}

/** 起動対象の指定。 */
interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * プロセスを起動して `initialize` を1件送り、終了までを観測する。
 *
 * 計測起点は `spawn` の直前（要件1-3 の「プロセスの起動時点」）。応答を受け取った時点で
 * 標準入力を閉じ、プロセスの自然終了を待つ（`StdioServerTransport` は標準入力の終了で
 * 読み取りハンドルを失い、他のハンドルが無いためイベントループが空になって終了する）。
 */
async function runInitialize(spec: LaunchSpec): Promise<ServerRun> {
  // `.cmd` は shell 経由でのみ起動できる（Node.js 20 以降）。
  const useShell =
    process.platform === "win32" && spec.command.toLowerCase().endsWith(".cmd");

  const startedAt = performance.now();
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: buildChildEnv(spec.env),
    stdio: ["pipe", "pipe", "pipe"],
    shell: useShell,
    windowsHide: true,
  });

  return await new Promise<ServerRun>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let elapsedToResponseMs: number | null = null;
    let response: JsonRpcMessage | null = null;
    let forciblyTerminated = false;
    let consumedLines = 0;
    let graceTimer: NodeJS.Timeout | null = null;

    const watchdog = setTimeout(() => {
      // 応答が来ないケース（鍵未設定など、および想定外の無応答）はここで打ち切る。
      closeInput();
    }, RESPONSE_WATCHDOG_MS);

    /** 標準入力を閉じ、猶予時間内に終了しなければ強制終了する。 */
    function closeInput(): void {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      if (graceTimer === null) {
        graceTimer = setTimeout(() => {
          forciblyTerminated = true;
          forceKillTree(child);
        }, TERMINATION_GRACE_MS);
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (response !== null) {
        return;
      }
      // 改行で完結した行だけを解析する（部分行を `JSON.parse` に渡さない）。
      const lines = stdout.split("\n");
      const complete = lines.slice(0, -1);
      for (; consumedLines < complete.length; consumedLines += 1) {
        const line = complete[consumedLines].trim();
        if (line === "") {
          continue;
        }
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(line) as JsonRpcMessage;
        } catch {
          // JSON以外が出力された場合は要件1-9 のアサーションで検出する（ここでは無視する）。
          continue;
        }
        if (parsed.id === REQUEST_ID) {
          response = parsed;
          elapsedToResponseMs = performance.now() - startedAt;
          closeInput();
          break;
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(watchdog);
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      reject(error);
    });

    // 標準出力が閉じるまで待つため `exit` ではなく `close` を使う。
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      resolve({
        elapsedToResponseMs,
        response,
        stdout,
        stderr,
        exitCode: code,
        signal,
        forciblyTerminated,
      });
    });

    // 起動直後に書き込む。プロセス側の準備が終わる前でもパイプにバッファされる。
    child.stdin.on("error", () => {
      // 鍵未設定でプロセスが即終了した場合の EPIPE を無視する（終了コードで判定する）。
    });
    child.stdin.write(initializeRequest);
  });
}

/** 鍵ありのシム起動は要件1-3 と要件1-9 で共有する（起動回数を抑えるため）。 */
let shimWithKeyRun: ServerRun | null = null;

async function runShimWithKeyOnce(cli: CliFixture): Promise<ServerRun> {
  if (shimWithKeyRun === null) {
    shimWithKeyRun = await runInitialize({
      command: cli.binPath,
      args: [],
      cwd: cli.installDir,
      env: { ROKADOC_API_KEY: "dummy-api-key-for-startup-test" },
    });
  }
  return shimWithKeyRun;
}

/** 標準出力の各行がJSON-RPC 2.0 メッセージであることを検証する。 */
function assertOnlyJsonRpcOnStdout(stdout: string): void {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  expect(lines.length, "標準出力に1行も出力されていない").toBeGreaterThan(0);
  for (const line of lines) {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(line) as JsonRpcMessage;
    } catch {
      expect.fail(
        `標準出力にJSON-RPCメッセージ以外が出力された: ${JSON.stringify(line)}`,
      );
    }
    expect(
      parsed.jsonrpc,
      `標準出力の行が JSON-RPC 2.0 ではない: ${JSON.stringify(line)}`,
    ).toBe("2.0");
    const isMessage =
      parsed.id !== undefined ||
      (typeof parsed.method === "string" && parsed.method !== "");
    expect(
      isMessage,
      `標準出力の行が要求・応答・通知のいずれでもない: ${JSON.stringify(line)}`,
    ).toBe(true);
  }
}

describe("配布物としてのCLI起動（要件1-3 / 1-5 / 1-9 / 7-4）", () => {
  it("dist/ が生成されている（CIでは必須）", () => {
    if (!distAvailable) {
      if (isCI) {
        expect.fail(
          "dist/index.js が存在しない。CIではビルド後にテストが実行されるため、" +
            "成果物の不在は異常である（`npm run build` の失敗を確認すること）。",
        );
      }
      console.warn(
        "dist/index.js が存在しないため CLI起動テストをスキップした。`npm run build` を実行すること。",
      );
      return;
    }
    expect(distAvailable).toBe(true);
  });

  describe.runIf(distAvailable)(
    "tarball を一時ディレクトリへインストールした状態",
    () => {
      it("`node_modules/.bin/rokadoc-mcp-server` が登録され、パッケージ本体が展開される", (context) => {
        const cli = requireFixture(context);

        expect(
          existsSync(cli.posixBinPath),
          "実行シム `node_modules/.bin/rokadoc-mcp-server` が生成されていない",
        ).toBe(true);
        if (process.platform === "win32") {
          expect(
            existsSync(cli.cmdBinPath),
            "Windows用シム `rokadoc-mcp-server.cmd` が生成されていない",
          ).toBe(true);
        }
        expect(
          existsSync(join(cli.packageDir, "dist", "index.js")),
          "インストールされたパッケージに dist/index.js が含まれていない",
        ).toBe(true);
      });

      it(`ROKADOC_API_KEY 設定時、起動から ${STARTUP_BUDGET_MS}ms 以内に initialize へ応答する（要件1-3）`, async (context) => {
        const cli = requireFixture(context);
        const run = await runShimWithKeyOnce(cli);

        expect(
          run.response,
          `initialize への応答を受信できなかった。stderr: ${run.stderr}`,
        ).not.toBeNull();
        const response = run.response as JsonRpcMessage;
        expect(response.jsonrpc).toBe("2.0");
        expect(response.id).toBe(REQUEST_ID);
        expect(
          response.error,
          `initialize がエラー応答を返した: ${JSON.stringify(response.error)}`,
        ).toBeUndefined();

        const result = response.result as
          | { serverInfo?: { name?: string }; protocolVersion?: string }
          | undefined;
        expect(result?.serverInfo?.name).toBe("rokadoc-mcp-server");
        expect(typeof result?.protocolVersion).toBe("string");

        const elapsed = run.elapsedToResponseMs as number;
        expect(
          elapsed,
          `起動から initialize 応答までが ${STARTUP_BUDGET_MS}ms を超えた: ` +
            `${elapsed.toFixed(0)}ms（npm install の時間は計測に含めていない）`,
        ).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
      }, 60_000);

      it("標準出力にはJSON-RPCメッセージのみが出現する（要件1-9）", async (context) => {
        const cli = requireFixture(context);
        const run = await runShimWithKeyOnce(cli);

        assertOnlyJsonRpcOnStdout(run.stdout);
        // 正常起動時は診断メッセージが出ないことも確認する。ただし Node.js 自身の
        // DeprecationWarning / ExperimentalWarning は実行環境に依存して標準エラー出力へ
        // 現れ得るため、完全な空文字列ではなく本サーバーの診断出力の不在を主張する。
        for (const marker of ["[設定エラー]", "[起動エラー]", "[警告]"]) {
          expect(
            run.stderr,
            `正常起動時に診断メッセージが出力された: ${run.stderr}`,
          ).not.toContain(marker);
        }
        expect(
          run.forciblyTerminated,
          "標準入力を閉じてもプロセスが終了せず強制終了された",
        ).toBe(false);
      }, 60_000);

      it("ROKADOC_API_KEY 未設定時、標準エラー出力へ理由を出し、応答せず終了コード1で終了する（要件1-5）", async (context) => {
        const cli = requireFixture(context);
        const run = await runInitialize({
          command: cli.binPath,
          args: [],
          cwd: cli.installDir,
          env: { ROKADOC_API_KEY: undefined },
        });

        expect(
          run.stderr,
          "標準エラー出力に環境変数名 ROKADOC_API_KEY への言及がない",
        ).toContain("ROKADOC_API_KEY");
        expect(run.stderr).toContain("設定されていない");
        expect(
          run.stdout,
          `initialize へ応答してはならないのに標準出力があった: ${run.stdout}`,
        ).toBe("");
        expect(run.response, "initialize へ応答が返された").toBeNull();
        expect(
          run.exitCode,
          `終了コードが1ではない（signal: ${String(run.signal)}）`,
        ).toBe(1);
        expect(
          run.forciblyTerminated,
          "自発的に終了せず強制終了された（MCPハンドシェイクを開始せず終了する要件を満たしていない）",
        ).toBe(false);
      }, 60_000);

      it("`node dist/index.js` 形式の直接起動でも initialize へ応答する（要件7-4）", async (context) => {
        const cli = requireFixture(context);
        // Dockerfile の `WORKDIR /app` + `ENTRYPOINT ["node", "dist/index.js"]` と同一形式で起動する。
        const run = await runInitialize({
          command: process.execPath,
          args: ["dist/index.js"],
          cwd: cli.packageDir,
          env: { ROKADOC_API_KEY: "dummy-api-key-for-startup-test" },
        });

        expect(
          run.response,
          `直接起動で initialize への応答を受信できなかった。stderr: ${run.stderr}`,
        ).not.toBeNull();
        expect((run.response as JsonRpcMessage).id).toBe(REQUEST_ID);
        expect((run.response as JsonRpcMessage).error).toBeUndefined();
        assertOnlyJsonRpcOnStdout(run.stdout);

        const elapsed = run.elapsedToResponseMs as number;
        expect(
          elapsed,
          `直接起動での initialize 応答までが ${STARTUP_BUDGET_MS}ms を超えた: ${elapsed.toFixed(0)}ms`,
        ).toBeLessThanOrEqual(STARTUP_BUDGET_MS);
      }, 60_000);
    },
  );
});

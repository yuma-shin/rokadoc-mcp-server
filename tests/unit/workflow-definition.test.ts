import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";

// ワークフロー定義の構造を固定するユニットテスト（タスク5.6）。
//
// YAMLのパース手段はタスク1.4の決定に従い `yaml`（devDependency / 推移的依存なし）を使う。
// `yaml` の既定スキーマ（YAML 1.2 core）では `on:` が真偽値へ解釈されないため
// `doc.on` で直接アクセスできる。将来パーサ差異が生じた場合に検知できるよう、
// キー `"on"` の存在自体もアサーションしている。
//
// 静的禁止検査（`set -x` / トークンの出力 / git 書き込み操作 / 取り下げ操作）の対象は
// `publish-npm.yml` のみである。既存 `publish.yml` は `git tag -f` / `git push --force`
// を含むため（Update major version tag ステップ）、同じ検査を当てると必ず失敗する。
// 要件4-5 / 5-8 / 6-2 / 7-6 はいずれも NPM_Publish_Workflow 側の制約である。
const REPO_ROOT = new URL("../../", import.meta.url);

const NPM_WORKFLOW_PATH = ".github/workflows/publish-npm.yml";
const DOCKER_WORKFLOW_PATH = ".github/workflows/publish.yml";
const DOCKERFILE_PATH = "Dockerfile";
const PACKAGE_JSON_PATH = "package.json";

function readText(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} はマッピングである必要がある`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} は配列である必要がある`);
  }
  return value;
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

function parseWorkflow(relativePath: string): Record<string, unknown> {
  const parsed: unknown = parse(readText(relativePath));
  return asRecord(parsed, relativePath);
}

/** ワークフローのステップ1件を、必要な属性だけ取り出した形に正規化したもの。 */
interface WorkflowStep {
  /** `steps` 配列上の位置（0起点）。順序アサーションに使う。 */
  readonly index: number;
  /** 表示用のラベル。`name` が無いステップは `run` / `uses` の1行目を使う。 */
  readonly label: string;
  readonly id: string | undefined;
  readonly ifCondition: string | undefined;
  readonly run: string | undefined;
  readonly uses: string | undefined;
  readonly env: Record<string, unknown>;
  /** `continue-on-error` キーが存在するか（値の真偽ではなくキーの有無を見る）。 */
  readonly hasContinueOnError: boolean;
  readonly raw: Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toStep(value: unknown, index: number, label: string): WorkflowStep {
  const raw = asRecord(value, `${label} の steps[${String(index)}]`);
  const run = optionalString(raw.run);
  const uses = optionalString(raw.uses);
  const name = optionalString(raw.name);
  const firstLine = (run ?? uses ?? "").split(/\r?\n/)[0]?.trim() ?? "";

  return {
    index,
    label: name ?? firstLine,
    id: optionalString(raw.id),
    ifCondition: optionalString(raw.if),
    run,
    uses,
    env:
      raw.env === undefined
        ? {}
        : asRecord(raw.env, `${label} の steps[${String(index)}].env`),
    hasContinueOnError: Object.prototype.hasOwnProperty.call(
      raw,
      "continue-on-error",
    ),
    raw,
  };
}

function stepsOfJob(
  workflow: Record<string, unknown>,
  jobName: string,
  label: string,
): WorkflowStep[] {
  const job = asRecord(
    getPath(workflow, `jobs.${jobName}`),
    `${label} の jobs.${jobName}`,
  );
  return asArray(job.steps, `${label} の jobs.${jobName}.steps`).map(
    (step, index) => toStep(step, index, `${label}#${jobName}`),
  );
}

/** 行頭が `#` の行（コメント行のみ）を落とす。行末コメントは落とさない。 */
function stripFullLineComments(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => line.trim().length > 0);
}

/**
 * `run` 本文のうち、静的禁止検査の対象となる実行行のみを返す。
 * `[ステップラベル, 行]` の組で返し、失敗時にどのステップの行かが分かるようにする。
 */
function executableRunLines(
  steps: readonly WorkflowStep[],
): ReadonlyArray<readonly [string, string]> {
  return steps.flatMap((step) =>
    step.run === undefined
      ? []
      : stripFullLineComments(step.run).map(
          (line) => [step.label, line.trim()] as const,
        ),
  );
}

/** ジョブ名 → `needs` に列挙された依存ジョブ名。 */
function jobNeeds(
  workflow: Record<string, unknown>,
  label: string,
): ReadonlyArray<readonly [string, readonly string[]]> {
  const jobs = asRecord(workflow.jobs, `${label} の jobs`);
  return Object.entries(jobs).map(([jobName, job]) => {
    const needs = asRecord(job, `${label} の jobs.${jobName}`).needs;
    if (needs === undefined) {
      return [jobName, []] as const;
    }
    if (typeof needs === "string") {
      return [jobName, [needs]] as const;
    }
    const list = asArray(needs, `${label} の jobs.${jobName}.needs`).map(
      (entry) => String(entry),
    );
    return [jobName, list] as const;
  });
}

/** `uses:` 行を生テキストから抽出する（SHA固定とバージョンコメントを検査するため）。 */
function usesLines(workflowText: string): string[] {
  return workflowText
    .split(/\r?\n/)
    .map((line) => /^\s*(?:-\s+)?uses:\s*(\S.*?)\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

/** `owner/repo@sha` 形式の `uses` から `owner/repo` と SHA を取り出す。 */
function actionShaMap(workflowText: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const line of usesLines(workflowText)) {
    const match = /^([^@\s]+)@([0-9a-f]{40})/.exec(line);
    if (match === null) {
      continue;
    }
    const action = match[1];
    const sha = match[2];
    const shas = map.get(action) ?? new Set<string>();
    shas.add(sha);
    map.set(action, shas);
  }
  return map;
}

/** 行末の `\` による継続行を1行へ畳み、各行を trim した配列を返す。 */
function dockerfileLines(dockerfile: string): string[] {
  return dockerfile
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim());
}

/** 指定ステージ（`FROM ... AS <stage>`）の命令行のみを返す。 */
function dockerStageLines(dockerfile: string, stage: string): string[] {
  const lines = dockerfileLines(dockerfile);
  const start = lines.findIndex((line) =>
    new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${stage}\\b`, "i").test(line),
  );
  if (start === -1) {
    throw new Error(`${DOCKERFILE_PATH} に 'AS ${stage}' ステージが存在しない`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^FROM\s/i.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** `COPY` 命令のコピー元・コピー先（フラグを除いたもの）。 */
interface CopyInstruction {
  readonly line: string;
  readonly sources: readonly string[];
  readonly destination: string;
}

function parseCopy(line: string): CopyInstruction | undefined {
  const match = /^COPY\s+(.*)$/i.exec(line);
  if (match === null) {
    return undefined;
  }
  const tokens = (match[1] as string)
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith("--"));
  if (tokens.length < 2) {
    return undefined;
  }
  return {
    line,
    sources: tokens.slice(0, -1),
    destination: tokens[tokens.length - 1] as string,
  };
}

/** `./` と末尾 `/` を落とした比較用のパス表現。 */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * `COPY` 命令が、ビルドコンテキスト上の `target`（例: `scripts/clean-dist.mjs`）を
 * イメージ内の同一相対パスへ取り込むかを判定する。
 * ディレクトリ単位のコピー（`COPY scripts/ ./scripts/`）も配下のファイルを覆うものとして扱い、
 * コピー先が相対パスを保たない場合（`COPY scripts/ ./tools/`）は覆わないものとする。
 */
function copyCovers(copy: CopyInstruction, target: string): boolean {
  const destination = normalizePath(copy.destination);
  const targetDirectory = target.includes("/")
    ? target.slice(0, target.lastIndexOf("/"))
    : "";

  return copy.sources.some((source) => {
    const normalized = normalizePath(source);
    if (normalized === "" || normalized === ".") {
      // ビルドコンテキスト全体のコピー。
      return destination === "" || destination === ".";
    }
    if (normalized === target) {
      // 単一ファイル指定。コピー先は所属ディレクトリか同一パスのみ。
      return destination === targetDirectory || destination === target;
    }
    if (target.startsWith(`${normalized}/`)) {
      // ディレクトリごとのコピー。イメージ内で相対パスが保たれる場合のみ解決できる。
      return destination === "" || destination === normalized;
    }
    return false;
  });
}

/**
 * `npm run <name>` のライフサイクル連鎖（`pre<name>` / `<name>` / `post<name>` と
 * その中で呼ばれる `npm run` の連鎖）に含まれるコマンド本文をすべて返す。
 */
function lifecycleCommands(
  scriptName: string,
  scripts: Readonly<Record<string, string>>,
  visited: Set<string> = new Set<string>(),
): string[] {
  if (visited.has(scriptName)) {
    return [];
  }
  visited.add(scriptName);

  const commands: string[] = [];
  for (const name of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
    const command = scripts[name];
    if (typeof command !== "string") {
      continue;
    }
    commands.push(command);
    for (const nested of command.matchAll(
      /\bnpm\s+run(?:-script)?\s+([\w:.-]+)/g,
    )) {
      commands.push(
        ...lifecycleCommands(nested[1] as string, scripts, visited),
      );
    }
  }
  return commands;
}

/** ライフサイクル連鎖が参照する `scripts/*.mjs` のパス一覧（package.json から導出）。 */
function referencedScriptFiles(
  scriptName: string,
  scripts: Readonly<Record<string, string>>,
): string[] {
  const paths = new Set<string>();
  for (const command of lifecycleCommands(scriptName, scripts)) {
    for (const match of command.matchAll(
      /(?:^|[\s"'`=(])((?:\.\/)?scripts\/[\w.\-/]+\.mjs)/g,
    )) {
      paths.add(normalizePath(match[1] as string));
    }
  }
  return [...paths].sort();
}

const npmWorkflowText = readText(NPM_WORKFLOW_PATH);
const dockerWorkflowText = readText(DOCKER_WORKFLOW_PATH);
const dockerfileText = readText(DOCKERFILE_PATH);

const packageJson = asRecord(
  JSON.parse(readText(PACKAGE_JSON_PATH)),
  PACKAGE_JSON_PATH,
);
const packageScripts = asRecord(
  packageJson.scripts,
  `${PACKAGE_JSON_PATH} の scripts`,
) as Record<string, string>;
/** `npm run build` 実行時にイメージ内へ存在していなければならない scripts/*.mjs。 */
const buildScriptFiles = referencedScriptFiles("build", packageScripts);

const npmWorkflow = parseWorkflow(NPM_WORKFLOW_PATH);
const dockerWorkflow = parseWorkflow(DOCKER_WORKFLOW_PATH);

const npmJobs = asRecord(npmWorkflow.jobs, `${NPM_WORKFLOW_PATH} の jobs`);
const npmPublishJob = asRecord(
  npmJobs.publish,
  `${NPM_WORKFLOW_PATH} の jobs.publish`,
);
const npmSteps = stepsOfJob(npmWorkflow, "publish", NPM_WORKFLOW_PATH);
const npmRunLines = executableRunLines(npmSteps);

/** `run` 本文が完全一致するステップ（`npm ci` など名前なしステップの特定に使う）。 */
function stepByRun(command: string): WorkflowStep {
  const found = npmSteps.filter((step) => step.run?.trim() === command);
  if (found.length !== 1) {
    throw new Error(
      `run が '${command}' のステップがちょうど1つ存在する必要がある（実際: ${String(found.length)}件）`,
    );
  }
  return found[0] as WorkflowStep;
}

function stepByNameFragment(fragment: string): WorkflowStep {
  const found = npmSteps.filter((step) => step.label.includes(fragment));
  if (found.length !== 1) {
    throw new Error(
      `名前に '${fragment}' を含むステップがちょうど1つ存在する必要がある（実際: ${String(found.length)}件）`,
    );
  }
  return found[0] as WorkflowStep;
}

const installStep = stepByRun("npm ci");
const testStep = stepByRun("npm test");

/**
 * `run` 本文の実行行（コメント行と空行を除いたもの）を返す。
 *
 * ログ出力メッセージ中の文字列（例: `echo "... npm run build の結果を ..."`）を
 * コマンド実行と誤検出しないよう、コマンド検出は行頭アンカー付きの正規表現で行う。
 */
function runCommandLines(step: WorkflowStep): string[] {
  return step.run === undefined
    ? []
    : stripFullLineComments(step.run).map((line) => line.trim());
}

/** ビルドを実行するステップ（`npm run build` または `tsc` の直接起動）。 */
const buildSteps = npmSteps.filter((step) =>
  runCommandLines(step).some((line) =>
    /^(?:npm run build|npx tsc|tsc)\b/.test(line),
  ),
);
/** レジストリへ公開要求を送るステップ。 */
const publishSteps = npmSteps.filter((step) =>
  runCommandLines(step).some((line) => /\bnpm publish\b/.test(line)),
);
const publishStep1 = stepByNameFragment("Registry_Publish_Step 1");
const publishStep2 = stepByNameFragment("Registry_Publish_Step 2");
const configureGhpStep = stepByNameFragment(
  "Configure npm for GitHub Packages",
);

describe(`${NPM_WORKFLOW_PATH}: トリガー定義（要件4.1 / 4.8 / 7.5）`, () => {
  it("キー 'on' が文字列キーとして存在する（YAML 1.1 の真偽値解釈になっていない）", () => {
    expect(Object.prototype.hasOwnProperty.call(npmWorkflow, "on")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(npmWorkflow, "true")).toBe(
      false,
    );
  });

  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    // v* ではなく v*.*.* とする（publish.yml が強制pushする v1 形式に一致させない）
    ["on.push.tags", ["v*.*.*"]],
    ["on.push.branches", ["main"]],
    ["on.pull_request.branches", ["main"]],
  ];

  it.each(cases)("%s が %j と厳密一致する", (path, expected) => {
    expect(getPath(npmWorkflow, path)).toEqual(expected);
  });
});

describe(`${NPM_WORKFLOW_PATH}: permissions（要件4.6 / 5.4 / 6.2）`, () => {
  const permissions = asRecord(
    npmWorkflow.permissions,
    `${NPM_WORKFLOW_PATH} の permissions`,
  );

  it("キー集合が3項目と厳密一致する", () => {
    expect(Object.keys(permissions).sort()).toEqual([
      "contents",
      "id-token",
      "packages",
    ]);
  });

  const cases: ReadonlyArray<readonly [string, string]> = [
    // checkout のみ。タグ作成・push は行わない（要件6.2）
    ["contents", "read"],
    // npm provenance（要件4.6）
    ["id-token", "write"],
    // GitHub Packages 公開（要件5.4）
    ["packages", "write"],
  ];

  it.each(cases)("%s が %s である", (key, expected) => {
    expect(permissions[key]).toBe(expected);
  });
});

describe(`${NPM_WORKFLOW_PATH}: ジョブとステップの構造（要件4.2 / 4.3 / 5.5）`, () => {
  it("ジョブがひとつ（publish）だけ定義されている", () => {
    // ビルドと公開が同一ジョブ内で完結することが、再ビルドなしの前提（要件5.5）
    expect(Object.keys(npmJobs)).toEqual(["publish"]);
  });

  it("timeout-minutes が30以下である", () => {
    const timeout = npmPublishJob["timeout-minutes"];
    expect(typeof timeout).toBe("number");
    expect(timeout as number).toBeGreaterThan(0);
    expect(timeout as number).toBeLessThanOrEqual(30);
  });

  it("npm ci → build → test → 公開ステップ の順序が成立する", () => {
    expect(buildSteps).toHaveLength(1);
    expect(publishSteps.length).toBeGreaterThan(0);

    const buildIndex = (buildSteps[0] as WorkflowStep).index;
    expect(installStep.index).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(testStep.index);

    for (const step of publishSteps) {
      expect(testStep.index).toBeLessThan(step.index);
    }
  });

  it("ビルドを実行するステップはジョブ内に1つだけで、Step 2 より前にのみ現れる", () => {
    // 要件5.5: GitHub Packages 向けの再ビルドを行わない
    expect(buildSteps.map((step) => step.label)).toEqual(["npm run build"]);
    expect((buildSteps[0] as WorkflowStep).index).toBeLessThan(
      publishStep2.index,
    );
  });

  it("npm ci / build / test のいずれにも continue-on-error が付いていない", () => {
    // 要件4.3: いずれかが失敗した時点で公開要求を1回も送らずに中断する
    const guarded = [installStep, buildSteps[0] as WorkflowStep, testStep];
    expect(
      guarded
        .filter((step) => step.hasContinueOnError)
        .map((step) => step.label),
    ).toEqual([]);
  });

  it("ジョブ内のどのステップにも continue-on-error が付いていない", () => {
    expect(
      npmSteps.filter((step) => step.hasContinueOnError).map((s) => s.label),
    ).toEqual([]);
  });

  it("全 uses が owner/repo@<40桁hex> # v<major> 形式である", () => {
    // 要件4.1: 既存 publish.yml と同じSHA固定の書式を踏襲する
    const lines = usesLines(npmWorkflowText);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+$/);
    }
  });
});

describe(`${NPM_WORKFLOW_PATH}: 公開ステップの条件と認証（要件4.5 / 4.8 / 5.1 / 5.4）`, () => {
  it("公開ステップが2件（公開npmレジストリ / GitHub Packages）である", () => {
    expect(publishSteps.map((step) => step.label)).toEqual([
      publishStep1.label,
      publishStep2.label,
    ]);
  });

  it("全公開ステップの if に IS_RELEASE_TAG 条件が付いている", () => {
    // 要件4.8: タグ以外のトリガーでは公開要求を1回も送信しない
    for (const step of [...publishSteps, configureGhpStep]) {
      expect(step.ifCondition).toBeDefined();
      expect(step.ifCondition as string).toContain("IS_RELEASE_TAG");
    }
  });

  it("Step 2 の if に Step 1 の結果を参照する式が含まれない", () => {
    // 要件5.1: Step 1 の成功・スキップ・失敗に関わらず Step 2 を必ず実行する
    const forbidden = [
      "NPM_RESULT",
      "steps.",
      "outcome",
      "conclusion",
      "success()",
      "failure()",
      "cancelled()",
    ];
    for (const step of [configureGhpStep, publishStep2]) {
      const condition = step.ifCondition as string;
      for (const token of forbidden) {
        expect(condition).not.toContain(token);
      }
    }
  });

  const tokenCases: ReadonlyArray<readonly [string, string]> = [
    ["Step 1", "${{ secrets.NPM_TOKEN }}"],
    ["Step 2", "${{ secrets.GITHUB_TOKEN }}"],
  ];

  it.each(tokenCases)(
    "%s の NODE_AUTH_TOKEN が %s である",
    (label, expected) => {
      const step = label === "Step 1" ? publishStep1 : publishStep2;
      expect(step.env.NODE_AUTH_TOKEN).toBe(expected);
    },
  );
});

describe(`${NPM_WORKFLOW_PATH}: provenance とバージョン導出（要件4.6 / 6.6）`, () => {
  it("--provenance が公開npmレジストリ側の publish にのみ付与されている", () => {
    // 要件4.6 はWHERE条件。GitHub Packages 側には付与しない
    expect(
      npmSteps
        .filter((step) =>
          runCommandLines(step).some((line) => line.includes("--provenance")),
        )
        .map((step) => step.label),
    ).toEqual([publishStep1.label]);

    const step1PublishLines = runCommandLines(publishStep1).filter((line) =>
      /\bnpm publish\b/.test(line),
    );
    expect(step1PublishLines.length).toBeGreaterThan(0);
    for (const line of step1PublishLines) {
      expect(line).toContain("--provenance");
    }

    const step2PublishLines = runCommandLines(publishStep2).filter((line) =>
      /\bnpm publish\b/.test(line),
    );
    expect(step2PublishLines.length).toBeGreaterThan(0);
    for (const line of step2PublishLines) {
      expect(line).not.toContain("--provenance");
    }
  });

  it("バージョン導出ステップが1つだけ存在する", () => {
    expect(npmSteps.filter((step) => step.id === "version")).toHaveLength(1);
    // GITHUB_OUTPUT へ version を書き出すステップも1つだけ
    expect(
      npmSteps.filter((step) =>
        runCommandLines(step).some((line) =>
          /version=.*>>\s*"?\$\{?GITHUB_OUTPUT/.test(line),
        ),
      ),
    ).toHaveLength(1);
  });

  it("両公開ステップが同一のバージョン出力を参照する", () => {
    // 要件6.6: 両レジストリへ同一の Package_Version を使う
    const expression = "${{ steps.version.outputs.version }}";
    expect(publishStep1.env.PACKAGE_VERSION).toBe(expression);
    expect(publishStep2.env.PACKAGE_VERSION).toBe(expression);

    // ファイル全体で参照されるステップIDが version 1種のみであること
    const referenced = new Set(
      [...npmWorkflowText.matchAll(/steps\.([\w-]+)\.outputs\.version/g)].map(
        (match) => match[1],
      ),
    );
    expect([...referenced]).toEqual(["version"]);
  });
});

describe(`${NPM_WORKFLOW_PATH}: 静的禁止検査（要件4.5 / 5.4 / 5.8 / 6.2 / 7.6）`, () => {
  it("run 本文の検査対象行が抽出できている", () => {
    expect(npmRunLines.length).toBeGreaterThan(0);
  });

  it("シェルトレース（set -x / set -o xtrace）を有効にしていない", () => {
    // set -uo pipefail / set -euo pipefail / set +e は許容する（-x のみを禁止）
    const offenders = npmRunLines.filter(
      ([, line]) =>
        /(?:^|[\s;&|(])set\s+[-+][a-wyzA-WYZ]*x/.test(line) ||
        /(?:^|[\s;&|(])set\s+[-+]o\s+xtrace\b/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("トークン変数の値を echo / printf していない", () => {
    // 文字列リテラルとしての 'NPM_TOKEN' 等の言及は許容し、変数展開のみを禁止する
    const tokenExpansion =
      /\$\{?\{?\s*(?:secrets\.[\w-]+|NODE_AUTH_TOKEN|NPM_TOKEN|GITHUB_TOKEN|GHP_TOKEN)/;
    const offenders = npmRunLines.filter(
      ([, line]) =>
        /\b(?:echo|printf)\b/.test(line) && tokenExpansion.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("git commit / git tag / git push を実行していない", () => {
    // 要件6.2: 書き換えはワークスペース内に限定し、コミット・タグ・pushを行わない
    const offenders = npmRunLines.filter(([, line]) =>
      /\bgit\s+(?:commit|tag|push)\b/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("npm unpublish / npm deprecate を実行していない", () => {
    // 要件5.8 / 7.6: 公開済み成果物の取り下げ・上書きを行わない
    const offenders = npmRunLines.filter(([, line]) =>
      /\bnpm\s+(?:unpublish|deprecate)\b/.test(line),
    );
    expect(offenders).toEqual([]);
  });
});

describe(`${DOCKER_WORKFLOW_PATH}: 非回帰ガード（要件7.1 / 7.2 / 7.5 / 7.6）`, () => {
  it("ファイルが存在し、パースできる", () => {
    expect(dockerWorkflowText.length).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(dockerWorkflow, "on")).toBe(
      true,
    );
  });

  const triggerCases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["on.push.branches", ["main"]],
    // v* のまま。プレリリースタグでもDockerイメージのみが公開される既存挙動を変えない
    ["on.push.tags", ["v*"]],
    ["on.pull_request.branches", ["main"]],
  ];

  it.each(triggerCases)("%s が %j と厳密一致する", (path, expected) => {
    expect(getPath(dockerWorkflow, path)).toEqual(expected);
  });

  it("docker/metadata-action の tags に4定義が存在する", () => {
    const jobs = asRecord(
      dockerWorkflow.jobs,
      `${DOCKER_WORKFLOW_PATH} の jobs`,
    );
    const tags = Object.keys(jobs)
      .flatMap((jobName) =>
        stepsOfJob(dockerWorkflow, jobName, DOCKER_WORKFLOW_PATH),
      )
      .filter(
        (step) => step.uses?.startsWith("docker/metadata-action@") === true,
      )
      .flatMap((step) => {
        const value = getPath(step.raw, "with.tags");
        return typeof value === "string"
          ? value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          : [];
      });

    expect(tags).toEqual([
      "type=semver,pattern={{version}}",
      "type=semver,pattern={{major}}.{{minor}}",
      "type=semver,pattern={{major}}",
      "type=raw,value=latest",
    ]);
  });

  it("strategy.matrix に linux/amd64 と linux/arm64 の双方が存在する", () => {
    const jobs = asRecord(
      dockerWorkflow.jobs,
      `${DOCKER_WORKFLOW_PATH} の jobs`,
    );
    const platforms = Object.entries(jobs).flatMap(([jobName, job]) => {
      const include = getPath(
        asRecord(job, `${DOCKER_WORKFLOW_PATH} の jobs.${jobName}`),
        "strategy.matrix.include",
      );
      return Array.isArray(include)
        ? include.map(
            (entry) =>
              asRecord(entry, `${jobName} の matrix.include 要素`).platform,
          )
        : [];
    });

    expect(platforms).toEqual(
      expect.arrayContaining(["linux/amd64", "linux/arm64"]),
    );
  });

  it("両ワークフローが needs で相互参照していない", () => {
    // 要件7.6: 一方の失敗が他方の実行を止めない
    const npmNeeds = jobNeeds(npmWorkflow, NPM_WORKFLOW_PATH);
    expect(npmNeeds.flatMap(([, needs]) => needs)).toEqual([]);

    const dockerJobNames = new Set(
      Object.keys(asRecord(dockerWorkflow.jobs, "jobs")),
    );
    for (const [jobName, needs] of jobNeeds(
      dockerWorkflow,
      DOCKER_WORKFLOW_PATH,
    )) {
      for (const dependency of needs) {
        expect(
          dockerJobNames.has(dependency),
          `${DOCKER_WORKFLOW_PATH} の ${jobName}.needs が同一ファイル内のジョブ以外を参照している: ${dependency}`,
        ).toBe(true);
      }
    }
  });

  it("両ワークフローで共通のActionは同一SHAに固定されている", () => {
    const npmActions = actionShaMap(npmWorkflowText);
    const dockerActions = actionShaMap(dockerWorkflowText);
    const shared = [...npmActions.keys()].filter((action) =>
      dockerActions.has(action),
    );

    expect(shared.length).toBeGreaterThan(0);
    for (const action of shared) {
      expect([...(npmActions.get(action) as Set<string>)]).toEqual([
        ...(dockerActions.get(action) as Set<string>),
      ]);
    }
  });
});

describe(`${DOCKERFILE_PATH}: 起動コマンドの非回帰ガード（要件7.4）`, () => {
  it('ENTRYPOINT が ["node", "dist/index.js"] のままである', () => {
    const entrypoints = dockerfileText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("ENTRYPOINT"));

    expect(entrypoints).toEqual(['ENTRYPOINT ["node", "dist/index.js"]']);
  });
});

describe(`${DOCKERFILE_PATH}: builderステージのビルド依存ガード（要件7.3）`, () => {
  const builderLines = dockerStageLines(dockerfileText, "builder");
  const buildRunIndex = builderLines.findIndex((line) =>
    /^RUN\s+npm\s+run\s+build\b/.test(line),
  );
  const copiesBeforeBuild = builderLines
    .slice(0, buildRunIndex === -1 ? 0 : buildRunIndex)
    .map((line) => parseCopy(line))
    .filter((copy): copy is CopyInstruction => copy !== undefined)
    // 他ステージからのコピー（`--from=`）はビルドコンテキストの解決に使えない。
    .filter((copy) => !/--from=/i.test(copy.line));

  it("builderステージに `RUN npm run build` が存在する", () => {
    expect(buildRunIndex).toBeGreaterThanOrEqual(0);
  });

  it("build のライフサイクル連鎖が参照する scripts/*.mjs を package.json から導出できる", () => {
    // 導出結果が空だと以降の検査が空振りするため、非空であること自体を固定する。
    expect(buildScriptFiles.length).toBeGreaterThan(0);
  });

  it.each(buildScriptFiles)(
    "%s が `RUN npm run build` より前に COPY されている",
    (scriptPath) => {
      // 要件7.3: prebuild / postbuild で起動されるスクリプトがイメージ内に無いと
      // `npm run build` が MODULE_NOT_FOUND で失敗し、Dockerビルドが終了コード0で完了しない。
      const covering = copiesBeforeBuild.filter((copy) =>
        copyCovers(copy, scriptPath),
      );
      expect(
        covering.map((copy) => copy.line),
        `${DOCKERFILE_PATH} の builderステージが ${scriptPath} を \`RUN npm run build\` より前にコピーしていない`,
      ).not.toEqual([]);
    },
  );

  it("production ステージは scripts/ を必要としない（インストール時ライフサイクルが無い）", () => {
    // `npm ci --omit=dev` は preinstall / install / postinstall / prepare を実行するが、
    // package.json はそれらを定義していないため production 側のコピーは不要。
    const installLifecycle = [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
    ];
    expect(
      installLifecycle.filter((name) =>
        Object.prototype.hasOwnProperty.call(packageScripts, name),
      ),
    ).toEqual([]);
  });
});

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Phase1ReadinessRunResult, ValidationOpsReport } from "@turnkeyai/core-types";

interface BaselineOptions {
  runs: number;
  transportCycles: number;
  soakCycles: number;
  port: number;
  dataDir: string;
  jsonPath?: string;
  releaseSkipBuild: boolean;
}

interface BaselineRunSummary {
  runNumber: number;
  status: Phase1ReadinessRunResult["status"];
  durationMs: number;
  failedStages: number;
  nextCommand: string;
  readinessStatus: ValidationOpsReport["readiness"]["status"];
  northStarStatus: ValidationOpsReport["closedLoop"]["closedLoopStatus"];
  closedLoopCases: number;
  totalCases: number;
  closedLoopRate: number;
  silentFailureCases: number;
  ambiguousFailureCases: number;
  stageSummaries: Array<{
    stageId: string;
    status: "passed" | "failed";
    summary: string;
    commandHint: string;
    artifactPath?: string;
  }>;
}

interface BaselineReport {
  status: "passed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  runs: BaselineRunSummary[];
  consecutivePassedRuns: number;
  requiredRuns: number;
  transportCycles: number;
  soakCycles: number;
  releaseSkipBuild: boolean;
  daemon: {
    port: number;
    dataDir: string;
  };
  finalValidationOps?: ValidationOpsReport;
  failureReasons: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
await mkdir(options.dataDir, { recursive: true });
if (options.jsonPath) {
  await mkdir(path.dirname(path.resolve(process.cwd(), options.jsonPath)), { recursive: true });
}

let daemon: ChildProcessWithoutNullStreams | undefined;
let stopping = false;

try {
  daemon = await startDaemon(options);
  await waitForDaemon(options.port, 30_000);

  const runs: BaselineRunSummary[] = [];
  const failureReasons: string[] = [];

  for (let index = 0; index < options.runs; index += 1) {
    const runNumber = index + 1;
    console.log(
      `Phase 1 baseline run ${runNumber}/${options.runs}: phase1-readiness ${options.transportCycles} ${options.soakCycles}`
    );
    const result = await postPhase1Readiness(options);
    const summary = summarizeRun(runNumber, result);
    runs.push(summary);
    const runFailures = validateRun(summary);
    failureReasons.push(...runFailures.map((reason) => `run ${runNumber}: ${reason}`));
    console.log(
      `- status=${summary.status} readiness=${summary.readinessStatus} northStar=${summary.northStarStatus} closedLoop=${summary.closedLoopCases}/${summary.totalCases} rate=${formatRate(summary.closedLoopRate)} silent=${summary.silentFailureCases} ambiguous=${summary.ambiguousFailureCases}`
    );
  }

  const finalValidationOps = await getValidationOps(options.port);
  failureReasons.push(...validateFinalValidationOps(finalValidationOps).map((reason) => `final validation-ops: ${reason}`));
  const completedAt = Date.now();
  const report: BaselineReport = {
    status: failureReasons.length === 0 ? "passed" : "failed",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    runs,
    consecutivePassedRuns: countLeadingCleanRuns(runs),
    requiredRuns: options.runs,
    transportCycles: options.transportCycles,
    soakCycles: options.soakCycles,
    releaseSkipBuild: options.releaseSkipBuild,
    daemon: {
      port: options.port,
      dataDir: options.dataDir,
    },
    finalValidationOps,
    failureReasons,
  };

  console.log(
    `Phase 1 baseline: ${report.status} (${report.consecutivePassedRuns}/${report.requiredRuns} clean runs, durationMs=${report.durationMs})`
  );
  console.log(
    `final north-star=${finalValidationOps.closedLoop.closedLoopStatus} closedLoop=${finalValidationOps.closedLoop.closedLoopCases}/${finalValidationOps.closedLoop.totalCases} rate=${formatRate(finalValidationOps.closedLoop.closedLoopRate)}`
  );

  if (options.jsonPath) {
    const resolvedPath = path.resolve(process.cwd(), options.jsonPath);
    await writeFile(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`wrote ${resolvedPath}`);
  }

  process.exitCode = report.status === "passed" ? 0 : 1;
} finally {
  stopping = true;
  if (daemon && !daemon.killed) {
    daemon.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  if (!stopping && daemon && !daemon.killed) {
    daemon.kill("SIGTERM");
  }
  process.exit(130);
});

function parseArgs(args: string[]): BaselineOptions {
  let runs = 3;
  let transportCycles = 3;
  let soakCycles = 3;
  let port = 4109;
  let dataDir = path.join(os.tmpdir(), `turnkeyai-phase1-baseline-${Date.now()}`);
  let jsonPath: string | undefined;
  let releaseSkipBuild = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runs") {
      runs = readPositiveInteger(args, index, "--runs");
      index += 1;
      continue;
    }
    if (arg === "--transport-cycles") {
      transportCycles = readPositiveInteger(args, index, "--transport-cycles");
      index += 1;
      continue;
    }
    if (arg === "--soak-cycles") {
      soakCycles = readPositiveInteger(args, index, "--soak-cycles");
      index += 1;
      continue;
    }
    if (arg === "--port") {
      port = readPositiveInteger(args, index, "--port");
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      dataDir = readValue(args, index, "--data-dir");
      index += 1;
      continue;
    }
    if (arg === "--json") {
      jsonPath = readValue(args, index, "--json");
      index += 1;
      continue;
    }
    if (arg === "--release-skip-build") {
      releaseSkipBuild = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    runs,
    transportCycles,
    soakCycles,
    port,
    dataDir: path.resolve(process.cwd(), dataDir),
    ...(jsonPath ? { jsonPath } : {}),
    releaseSkipBuild,
  };
}

function readPositiveInteger(args: string[], index: number, flag: string): number {
  const value = readValue(args, index, flag);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

async function startDaemon(input: BaselineOptions): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn("npm", ["run", "daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TURNKEYAI_DAEMON_PORT: String(input.port),
      TURNKEYAI_DATA_DIR: input.dataDir,
    },
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(prefixLines("daemon", chunk.toString()));
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(prefixLines("daemon", chunk.toString()));
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`daemon exited unexpectedly code=${String(code)} signal=${String(signal)}`);
    }
  });
  return child;
}

async function waitForDaemon(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`daemon did not become healthy within ${timeoutMs}ms: ${String(lastError)}`);
}

async function postPhase1Readiness(input: BaselineOptions): Promise<Phase1ReadinessRunResult> {
  const response = await fetch(`http://127.0.0.1:${input.port}/phase1-readiness/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transportCycles: input.transportCycles,
      soakCycles: input.soakCycles,
      releaseSkipBuild: input.releaseSkipBuild,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`phase1 readiness failed with HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as Phase1ReadinessRunResult;
}

async function getValidationOps(port: number): Promise<ValidationOpsReport> {
  const response = await fetch(`http://127.0.0.1:${port}/validation-ops?limit=50`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`validation-ops failed with HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as ValidationOpsReport;
}

function summarizeRun(runNumber: number, result: Phase1ReadinessRunResult): BaselineRunSummary {
  return {
    runNumber,
    status: result.status,
    durationMs: result.durationMs,
    failedStages: result.failedStages,
    nextCommand: result.nextCommand,
    readinessStatus: result.validationOps.readiness.status,
    northStarStatus: result.northStar.closedLoopStatus,
    closedLoopCases: result.northStar.closedLoopCases,
    totalCases: result.northStar.totalCases,
    closedLoopRate: result.northStar.closedLoopRate,
    silentFailureCases: result.northStar.silentFailureCases,
    ambiguousFailureCases: result.northStar.ambiguousFailureCases,
    stageSummaries: result.stages.map((stage) => ({
      stageId: stage.stageId,
      status: stage.status,
      summary: stage.summary,
      commandHint: stage.commandHint,
      ...(stage.artifactPath ? { artifactPath: stage.artifactPath } : {}),
    })),
  };
}

function validateRun(summary: BaselineRunSummary): string[] {
  const failures: string[] = [];
  if (summary.status !== "passed") {
    failures.push(`readiness status is ${summary.status}`);
  }
  if (summary.failedStages !== 0) {
    failures.push(`failed stages=${summary.failedStages}`);
  }
  if (summary.readinessStatus !== "passed") {
    failures.push(`readiness gate status is ${summary.readinessStatus}`);
  }
  if (summary.northStarStatus !== "completed") {
    failures.push(`north-star status is ${summary.northStarStatus}`);
  }
  if (summary.closedLoopRate !== 1) {
    failures.push(`closed-loop rate is ${formatRate(summary.closedLoopRate)}`);
  }
  if (summary.closedLoopCases !== summary.totalCases) {
    failures.push(`closed-loop cases=${summary.closedLoopCases}/${summary.totalCases}`);
  }
  if (summary.silentFailureCases !== 0) {
    failures.push(`silent failures=${summary.silentFailureCases}`);
  }
  if (summary.ambiguousFailureCases !== 0) {
    failures.push(`ambiguous failures=${summary.ambiguousFailureCases}`);
  }
  return failures;
}

function validateFinalValidationOps(report: ValidationOpsReport): string[] {
  const failures: string[] = [];
  if (report.readiness.status !== "passed") {
    failures.push(`readiness status is ${report.readiness.status}`);
  }
  if (report.closedLoop.closedLoopStatus !== "completed") {
    failures.push(`north-star status is ${report.closedLoop.closedLoopStatus}`);
  }
  if (report.closedLoop.closedLoopRate !== 1) {
    failures.push(`closed-loop rate is ${formatRate(report.closedLoop.closedLoopRate)}`);
  }
  if (report.closedLoop.closedLoopCases !== report.closedLoop.totalCases) {
    failures.push(`closed-loop cases=${report.closedLoop.closedLoopCases}/${report.closedLoop.totalCases}`);
  }
  if (report.closedLoop.silentFailureCases !== 0) {
    failures.push(`silent failures=${report.closedLoop.silentFailureCases}`);
  }
  if (report.closedLoop.ambiguousFailureCases !== 0) {
    failures.push(`ambiguous failures=${report.closedLoop.ambiguousFailureCases}`);
  }
  return failures;
}

function countLeadingCleanRuns(runs: BaselineRunSummary[]): number {
  let count = 0;
  for (const run of runs) {
    if (validateRun(run).length > 0) {
      break;
    }
    count += 1;
  }
  return count;
}

function prefixLines(prefix: string, value: string): string {
  return value
    .split(/(\r?\n)/)
    .map((part) => (part === "\n" || part === "\r\n" || part.length === 0 ? part : `[${prefix}] ${part}`))
    .join("");
}

function formatRate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

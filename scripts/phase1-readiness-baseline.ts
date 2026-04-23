import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Phase1BaselineRunResult } from "@turnkeyai/core-types";

interface BaselineOptions {
  runs: number;
  transportCycles: number;
  soakCycles: number;
  port: number;
  dataDir: string;
  jsonPath?: string;
  releaseSkipBuild: boolean;
}

const options = parseArgs(process.argv.slice(2));
if (options.jsonPath) {
  await mkdir(path.dirname(path.resolve(process.cwd(), options.jsonPath)), { recursive: true });
}

let daemon: ChildProcessWithoutNullStreams | undefined;
let stopping = false;

process.on("SIGINT", () => {
  if (!stopping && daemon && !daemon.killed) {
    daemon.kill("SIGTERM");
  }
  process.exit(130);
});

try {
  daemon = await startDaemon(options);
  await waitForDaemon(options.port, 30_000);

  const result = await postPhase1Baseline(options);
  console.log(
    `Phase 1 baseline: status=${result.status} cleanRuns=${result.consecutivePassedRuns}/${result.requiredRuns} durationMs=${result.durationMs}`
  );
  console.log(
    `north-star=${result.northStar.closedLoopStatus} closedLoop=${result.northStar.closedLoopCases}/${result.northStar.totalCases} rate=${formatRate(result.northStar.closedLoopRate)}`
  );
  console.log(`baseline=${result.baseline.status} next=${result.nextCommand}`);
  if (result.failureReasons.length > 0) {
    for (const reason of result.failureReasons) {
      console.log(`- ${reason}`);
    }
  }

  if (options.jsonPath) {
    const resolvedPath = path.resolve(process.cwd(), options.jsonPath);
    await writeFile(
      resolvedPath,
      `${JSON.stringify({ ...result, daemon: { port: options.port, dataDir: options.dataDir } }, null, 2)}\n`,
      "utf8"
    );
    console.log(`wrote ${resolvedPath}`);
  }

  process.exitCode = result.status === "passed" ? 0 : 1;
} finally {
  stopping = true;
  if (daemon && !daemon.killed) {
    daemon.kill("SIGTERM");
  }
}

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

async function postPhase1Baseline(input: BaselineOptions): Promise<Phase1BaselineRunResult> {
  const response = await fetch(`http://127.0.0.1:${input.port}/phase1-baseline/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runs: input.runs,
      transportCycles: input.transportCycles,
      soakCycles: input.soakCycles,
      releaseSkipBuild: input.releaseSkipBuild,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`phase1 baseline failed with HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as Phase1BaselineRunResult;
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

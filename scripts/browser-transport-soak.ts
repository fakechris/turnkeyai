import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  runBrowserTransportSoak,
  type BrowserTransportSoakTarget,
} from "@turnkeyai/qc-runtime/browser-transport-soak";

const execFile = promisify(execFileCallback);

const args = process.argv.slice(2);
let cycles = 3;
let timeoutMs = 60_000;
let relayPeerCount = 2;
let verifyReconnect = true;
let verifyWorkflowLog = true;
let jsonPath: string | null = null;
let targets: BrowserTransportSoakTarget[] = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--cycles") {
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("missing value for --cycles");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("--cycles must be a positive integer");
    }
    cycles = parsed;
    index += 1;
    continue;
  }
  if (arg === "--timeout-ms") {
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("missing value for --timeout-ms");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("--timeout-ms must be a positive number");
    }
    timeoutMs = Math.trunc(parsed);
    index += 1;
    continue;
  }
  if (arg === "--relay-peer-count") {
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("missing value for --relay-peer-count");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("--relay-peer-count must be a positive integer");
    }
    relayPeerCount = parsed;
    index += 1;
    continue;
  }
  if (arg === "--targets") {
    const raw = args[index + 1];
    if (!raw || raw.startsWith("-")) {
      throw new Error("missing value for --targets");
    }
    const parsedTargets = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const invalidTargets = parsedTargets.filter((item) => item !== "relay" && item !== "direct-cdp");
    if (invalidTargets.length > 0) {
      throw new Error(`unknown --targets entries: ${invalidTargets.join(", ")}`);
    }
    if (parsedTargets.length === 0) {
      throw new Error("--targets requires at least one target");
    }
    targets = parsedTargets as BrowserTransportSoakTarget[];
    index += 1;
    continue;
  }
  if (arg === "--no-verify-reconnect") {
    verifyReconnect = false;
    continue;
  }
  if (arg === "--no-verify-workflow-log") {
    verifyWorkflowLog = false;
    continue;
  }
  if (arg === "--json") {
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("missing path for --json");
    }
    jsonPath = value;
    index += 1;
    continue;
  }
}

const result = await runBrowserTransportSoak(
  {
    cycles,
    targets,
    timeoutMs,
    relayPeerCount,
    verifyReconnect,
    verifyWorkflowLog,
  },
  {
    runner: async ({ target, timeoutMs: runTimeoutMs, relayPeerCount: runPeerCount, verifyReconnect, verifyWorkflowLog }) => {
      const commandArgs =
        target === "relay"
          ? buildRelaySmokeArgs(runTimeoutMs, runPeerCount, verifyReconnect, verifyWorkflowLog)
          : buildDirectCdpSmokeArgs(runTimeoutMs, verifyReconnect, verifyWorkflowLog);
      const startedAt = Date.now();
      try {
        const { stdout, stderr } = await execFile("npm", commandArgs, {
          cwd: process.cwd(),
          maxBuffer: 16 * 1024 * 1024,
          timeout: runTimeoutMs,
          killSignal: "SIGTERM",
        });
        return {
          exitCode: 0,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        const failure = error as {
          code?: string | number;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message ?? String(error),
          durationMs: Date.now() - startedAt,
        };
      }
    },
  }
);

console.log(
  `Browser transport soak: ${result.status} (${result.passedCycles}/${result.totalCycles} cycles passed, ${result.failedTargetRuns}/${result.totalTargetRuns} failed target runs)`
);
console.log(`targets: ${result.targets.join(", ")}`);
for (const cycle of result.cycleResults) {
  console.log(`- cycle=${cycle.cycleNumber} status=${cycle.status} durationMs=${cycle.durationMs}`);
  for (const target of cycle.targets) {
    console.log(
      `  ${target.target}: status=${target.status} bucket=${target.failureBucket} durationMs=${target.durationMs} summary=${target.summary}`
    );
  }
}
for (const aggregate of result.targetAggregates) {
  console.log(
    `aggregate ${aggregate.target}: passed=${aggregate.passedCycles}/${aggregate.cycles} failed=${aggregate.failedCycles}`
  );
  for (const bucket of aggregate.failureBuckets) {
    console.log(`  bucket=${bucket.bucket} count=${bucket.count}`);
  }
}

if (jsonPath) {
  const resolvedPath = path.resolve(process.cwd(), jsonPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.exit(result.failedTargetRuns === 0 ? 0 : 1);

function buildRelaySmokeArgs(
  timeoutMs: number,
  relayPeerCount: number,
  verifyReconnect: boolean,
  verifyWorkflowLog: boolean
): string[] {
  const args = ["run", "relay:smoke", "--", "--timeout-ms", String(timeoutMs), "--peer-count", String(relayPeerCount)];
  if (verifyReconnect) {
    args.push("--verify-reconnect");
  }
  if (verifyWorkflowLog) {
    args.push("--verify-workflow-log");
  }
  return args;
}

function buildDirectCdpSmokeArgs(
  timeoutMs: number,
  verifyReconnect: boolean,
  verifyWorkflowLog: boolean
): string[] {
  const args = ["run", "cdp:smoke", "--", "--timeout-ms", String(timeoutMs)];
  if (verifyReconnect) {
    args.push("--verify-reconnect");
  }
  if (verifyWorkflowLog) {
    args.push("--verify-workflow-log");
  }
  return args;
}

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS,
  joinRealAcceptanceScenarios,
} from "@turnkeyai/qc-runtime/real-llm-acceptance-defaults";
import { buildValidationOpsRecordFromRealLlmAcceptance } from "@turnkeyai/qc-runtime/validation-ops-inspection";
import { FileValidationOpsRunStore } from "@turnkeyai/team-store/ops/file-validation-ops-run-store";

interface RealAcceptanceOptions {
  modelCatalogPath?: string;
  dataDir?: string;
  missionJsonPath?: string;
  cdpTimeoutMs: number;
  scenarioTimeoutMs: number;
  skipBrowserTooluse: boolean;
  recordValidationOps: boolean;
  writeMissionJson: boolean;
  tooluseScenarios?: string;
  missionScenarios?: string;
}

interface RuntimeConfig {
  dataDir?: string | null;
}

const DEFAULT_TOOLUSE_BROWSER_SCENARIOS = joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS);
const DEFAULT_TOOLUSE_NON_BROWSER_SCENARIOS = joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS);
const DEFAULT_MISSION_SCENARIOS = joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS);

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
const runId = buildRealAcceptanceRunId(startedAt);
const missionJsonPath = resolveMissionJsonPath(options, runId);
console.log("real acceptance starting");
console.log(`browser-tooluse: ${options.skipBrowserTooluse ? "skipped" : "enabled"}`);
console.log(`tooluse-scenarios: ${resolveTooluseScenarios(options)}`);
console.log(`mission-scenarios: ${options.missionScenarios ?? DEFAULT_MISSION_SCENARIOS}`);
console.log(`validation-ops-record: ${options.recordValidationOps ? resolveValidationOpsDataDir(options) : "disabled"}`);
console.log(`mission-json-report: ${missionJsonPath ?? "disabled"}`);

try {
  await runCommand("tool-use real matrix", buildTooluseArgs(options));
  ensureMissionJsonParentDirectory(missionJsonPath);
  await runCommand("mission real matrix", buildMissionArgs(options, missionJsonPath));
  const completedAt = Date.now();
  await recordValidationOps(options, {
    runId,
    startedAt,
    completedAt,
    status: "passed",
    missionJsonPath,
  });
  console.log(`real acceptance passed in ${completedAt - startedAt}ms`);
} catch (error) {
  const completedAt = Date.now();
  await recordValidationOps(options, {
    runId,
    startedAt,
    completedAt,
    status: "failed",
    error: errorMessage(error),
    missionJsonPath,
  });
  throw error;
}

function parseArgs(args: string[]): RealAcceptanceOptions {
  const options: RealAcceptanceOptions = {
    cdpTimeoutMs: 45_000,
    scenarioTimeoutMs: 240_000,
    skipBrowserTooluse: false,
    recordValidationOps: true,
    writeMissionJson: true,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model-catalog") {
      options.modelCatalogPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--cdp-timeout-ms") {
      options.cdpTimeoutMs = readPositiveInteger(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--data-dir") {
      options.dataDir = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--mission-json") {
      options.missionJsonPath = readValue(args, index, arg);
      options.writeMissionJson = true;
      index += 1;
      continue;
    }
    if (arg === "--scenario-timeout-ms") {
      options.scenarioTimeoutMs = readPositiveInteger(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--tooluse-scenarios") {
      options.tooluseScenarios = readScenarioList(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--mission-scenarios") {
      options.missionScenarios = readScenarioList(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--skip-browser-tooluse") {
      options.skipBrowserTooluse = true;
      continue;
    }
    if (arg === "--no-record-validation-ops") {
      options.recordValidationOps = false;
      continue;
    }
    if (arg === "--no-mission-json") {
      options.writeMissionJson = false;
      options.missionJsonPath = undefined;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function buildTooluseArgs(options: RealAcceptanceOptions): string[] {
  const args = [
    "run",
    "tooluse:e2e:real-matrix",
    "--",
    "--matrix-scenarios",
    resolveTooluseScenarios(options),
    "--scenario-timeout-ms",
    String(options.scenarioTimeoutMs),
  ];
  if (!options.skipBrowserTooluse) {
    args.push("--with-browser", "--cdp-timeout-ms", String(options.cdpTimeoutMs));
  }
  if (options.modelCatalogPath) {
    args.push("--model-catalog", options.modelCatalogPath);
  }
  return args;
}

function resolveTooluseScenarios(options: RealAcceptanceOptions): string {
  return options.tooluseScenarios ?? (
    options.skipBrowserTooluse ? DEFAULT_TOOLUSE_NON_BROWSER_SCENARIOS : DEFAULT_TOOLUSE_BROWSER_SCENARIOS
  );
}

function buildMissionArgs(options: RealAcceptanceOptions, missionJsonPath: string | null): string[] {
  const args = [
    "run",
    "mission:e2e",
    "--",
    "--matrix-scenarios",
    options.missionScenarios ?? DEFAULT_MISSION_SCENARIOS,
    "--scenario-timeout-ms",
    String(options.scenarioTimeoutMs),
  ];
  if (options.modelCatalogPath) {
    args.push("--model-catalog", options.modelCatalogPath);
  }
  if (missionJsonPath) {
    args.push("--json", missionJsonPath);
  }
  return args;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function readPositiveInteger(args: string[], index: number, flag: string): number {
  const value = readValue(args, index, flag);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function readScenarioList(args: string[], index: number, flag: string): string {
  const value = readValue(args, index, flag);
  const scenarios = value
    .split(",")
    .map((scenario) => scenario.trim())
    .filter(Boolean);
  if (scenarios.length === 0) {
    throw new Error(`${flag} must include at least one scenario`);
  }
  return scenarios.join(",");
}

function runCommand(label: string, args: string[]): Promise<void> {
  console.log(`real acceptance step starting: ${label}`);
  const startedAt = Date.now();
  const child = spawn("npm", args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        console.log(`real acceptance step passed: ${label} (${Date.now() - startedAt}ms)`);
        resolve();
        return;
      }
      reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}`));
    });
  });
}

async function recordValidationOps(
  options: RealAcceptanceOptions,
  result: {
    runId: string;
    startedAt: number;
    completedAt: number;
    status: "passed" | "failed";
    error?: string;
    missionJsonPath: string | null;
  }
): Promise<void> {
  if (!options.recordValidationOps) return;
  const dataDir = resolveValidationOpsDataDir(options);
  const store = new FileValidationOpsRunStore({ rootDir: path.join(dataDir, "validation-ops-runs") });
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: result.runId,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    status: result.status,
    tooluseScenarios: splitScenarios(resolveTooluseScenarios(options)),
    missionScenarios: splitScenarios(options.missionScenarios ?? DEFAULT_MISSION_SCENARIOS),
    browserTooluseEnabled: !options.skipBrowserTooluse,
    ...(result.missionJsonPath && existsSync(result.missionJsonPath)
      ? { artifactPath: path.relative(process.cwd(), result.missionJsonPath) }
      : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  await store.put(record);
  console.log(`validation-ops recorded: ${record.runId} (${record.status})`);
}

function resolveValidationOpsDataDir(options: RealAcceptanceOptions): string {
  if (options.dataDir?.trim()) {
    return path.resolve(process.cwd(), options.dataDir.trim());
  }
  if (process.env.TURNKEYAI_DATA_DIR?.trim()) {
    return path.resolve(process.cwd(), process.env.TURNKEYAI_DATA_DIR.trim());
  }
  const rootDir = process.env.TURNKEYAI_HOME?.trim() || path.join(homedir(), ".turnkeyai");
  const config = readRuntimeConfig(path.join(rootDir, "config.json"));
  if (config?.dataDir?.trim()) {
    return path.resolve(process.cwd(), config.dataDir.trim());
  }
  return path.join(rootDir, "data");
}

function resolveMissionJsonPath(options: RealAcceptanceOptions, runId: string): string | null {
  if (!options.writeMissionJson) return null;
  if (options.missionJsonPath?.trim()) {
    return path.resolve(process.cwd(), options.missionJsonPath.trim());
  }
  if (!options.recordValidationOps) return null;
  const filename = `${encodeURIComponent(runId)}-mission-e2e.json`;
  return path.join(resolveValidationOpsDataDir(options), "validation-artifacts", "real-llm-acceptance", filename);
}

function ensureMissionJsonParentDirectory(missionJsonPath: string | null): void {
  if (!missionJsonPath) return;
  mkdirSync(path.dirname(missionJsonPath), { recursive: true });
}

function readRuntimeConfig(configFile: string): RuntimeConfig | null {
  if (!existsSync(configFile)) return null;
  try {
    return JSON.parse(readFileSync(configFile, "utf8")) as RuntimeConfig;
  } catch {
    return null;
  }
}

function splitScenarios(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function buildRealAcceptanceRunId(startedAt: number): string {
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `validation-ops:real-llm-acceptance:${stamp}:${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "unknown error";
}

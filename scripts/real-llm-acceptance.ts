import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS,
  DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS,
  joinRealAcceptanceScenarios,
} from "@turnkeyai/qc-runtime/real-llm-acceptance-defaults";
import { summarizeMissionE2eReportForValidationOps } from "@turnkeyai/qc-runtime/real-llm-acceptance-summary";
import { buildValidationOpsRecordFromRealLlmAcceptance } from "@turnkeyai/qc-runtime/validation-ops-inspection";
import { FileValidationOpsRunStore } from "@turnkeyai/team-store/ops/file-validation-ops-run-store";

export interface RealAcceptanceOptions {
  modelCatalogPath?: string;
  dataDir?: string;
  missionJsonPath?: string;
  cdpTimeoutMs: number;
  scenarioTimeoutMs: number;
  skipTooluse: boolean;
  skipBrowserTooluse: boolean;
  recordValidationOps: boolean;
  writeMissionJson: boolean;
  tooluseScenarios?: string;
  missionScenarios?: string;
}

export interface RealAcceptanceCommandStep {
  label: string;
  args: string[];
}

export interface RealAcceptancePlan {
  runId: string;
  startedAt: number;
  missionJsonPath: string | null;
  tooluseScenarios: string[];
  missionScenarios: string[];
  browserTooluseEnabled: boolean;
  validationOpsDataDir: string | null;
  steps: RealAcceptanceCommandStep[];
}

interface RuntimeConfig {
  dataDir?: string | null;
}

const DEFAULT_TOOLUSE_BROWSER_SCENARIOS = joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_TOOLUSE_BROWSER_SCENARIOS);
const DEFAULT_TOOLUSE_NON_BROWSER_SCENARIOS = joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_TOOLUSE_NON_BROWSER_SCENARIOS);
const DEFAULT_MISSION_SCENARIOS = joinRealAcceptanceScenarios(DEFAULT_REAL_ACCEPTANCE_MISSION_SCENARIOS);

export async function runRealAcceptanceCli(args: string[]): Promise<void> {
  const options = parseRealAcceptanceArgs(args);
  const plan = buildRealAcceptancePlan(options, { startedAt: Date.now() });
  console.log("real acceptance starting");
  console.log(`tooluse: ${options.skipTooluse ? "skipped" : "enabled"}`);
  console.log(`browser-tooluse: ${plan.browserTooluseEnabled ? "enabled" : "skipped"}`);
  console.log(`tooluse-scenarios: ${plan.tooluseScenarios.length > 0 ? plan.tooluseScenarios.join(",") : "skipped"}`);
  console.log(`mission-scenarios: ${plan.missionScenarios.join(",")}`);
  console.log(`validation-ops-record: ${plan.validationOpsDataDir ?? "disabled"}`);
  console.log(`mission-json-report: ${plan.missionJsonPath ?? "disabled"}`);

  try {
    ensureMissionJsonParentDirectory(plan.missionJsonPath);
    for (const step of plan.steps) {
      await runCommand(step.label, step.args);
    }
    const completedAt = Date.now();
    await recordValidationOps(options, plan, {
      completedAt,
      status: "passed",
    });
    console.log(`real acceptance passed in ${completedAt - plan.startedAt}ms`);
  } catch (error) {
    const completedAt = Date.now();
    await recordValidationOps(options, plan, {
      completedAt,
      status: "failed",
      error: errorMessage(error),
    });
    throw error;
  }
}

export function parseRealAcceptanceArgs(args: string[]): RealAcceptanceOptions {
  const options: RealAcceptanceOptions = {
    cdpTimeoutMs: 45_000,
    scenarioTimeoutMs: 240_000,
    skipTooluse: false,
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
    if (arg === "--skip-tooluse") {
      options.skipTooluse = true;
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
  if (options.skipTooluse && options.tooluseScenarios) {
    throw new Error("--tooluse-scenarios cannot be combined with --skip-tooluse");
  }
  return options;
}

export function buildRealAcceptancePlan(
  options: RealAcceptanceOptions,
  input: { startedAt: number; runId?: string }
): RealAcceptancePlan {
  const runId = input.runId ?? buildRealAcceptanceRunId(input.startedAt);
  const missionJsonPath = resolveMissionJsonPath(options, runId);
  return {
    runId,
    startedAt: input.startedAt,
    missionJsonPath,
    tooluseScenarios: options.skipTooluse ? [] : splitScenarios(resolveTooluseScenarios(options)),
    missionScenarios: splitScenarios(options.missionScenarios ?? DEFAULT_MISSION_SCENARIOS),
    browserTooluseEnabled: !options.skipTooluse && !options.skipBrowserTooluse,
    validationOpsDataDir: options.recordValidationOps ? resolveValidationOpsDataDir(options) : null,
    steps: [
      ...(options.skipTooluse ? [] : [{ label: "tool-use real matrix", args: buildTooluseArgs(options) }]),
      { label: "mission real matrix", args: buildMissionArgs(options, missionJsonPath) },
    ],
  };
}

export function buildTooluseArgs(options: RealAcceptanceOptions): string[] {
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

export function resolveTooluseScenarios(options: RealAcceptanceOptions): string {
  return options.tooluseScenarios ?? (
    options.skipBrowserTooluse ? DEFAULT_TOOLUSE_NON_BROWSER_SCENARIOS : DEFAULT_TOOLUSE_BROWSER_SCENARIOS
  );
}

export function buildMissionArgs(options: RealAcceptanceOptions, missionJsonPath: string | null): string[] {
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
  plan: RealAcceptancePlan,
  result: {
    completedAt: number;
    status: "passed" | "failed";
    error?: string;
  }
): Promise<void> {
  if (!options.recordValidationOps) return;
  const dataDir = plan.validationOpsDataDir ?? resolveValidationOpsDataDir(options);
  const store = new FileValidationOpsRunStore({ rootDir: path.join(dataDir, "validation-ops-runs") });
  const missionReport = plan.missionJsonPath && existsSync(plan.missionJsonPath)
    ? summarizeMissionJson(plan.missionJsonPath)
    : null;
  const record = buildValidationOpsRecordFromRealLlmAcceptance({
    runId: plan.runId,
    startedAt: plan.startedAt,
    completedAt: result.completedAt,
    status: result.status,
    tooluseScenarios: plan.tooluseScenarios,
    missionScenarios: plan.missionScenarios,
    browserTooluseEnabled: plan.browserTooluseEnabled,
    ...(plan.missionJsonPath && existsSync(plan.missionJsonPath)
      ? {
          artifactPath: path.relative(process.cwd(), plan.missionJsonPath),
          ...(missionReport ? { missionReport } : {}),
        }
      : {}),
    ...(result.error ? { error: result.error } : {}),
  });
  await store.put(record);
  console.log(`validation-ops recorded: ${record.runId} (${record.status})`);
}

function summarizeMissionJson(missionJsonPath: string): ReturnType<typeof summarizeMissionE2eReportForValidationOps> {
  try {
    return summarizeMissionE2eReportForValidationOps(JSON.parse(readFileSync(missionJsonPath, "utf8")) as unknown);
  } catch {
    return null;
  }
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

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  await runRealAcceptanceCli(process.argv.slice(2));
}

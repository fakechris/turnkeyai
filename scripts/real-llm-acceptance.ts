import { spawn } from "node:child_process";

interface RealAcceptanceOptions {
  modelCatalogPath?: string;
  cdpTimeoutMs: number;
  scenarioTimeoutMs: number;
  skipBrowserTooluse: boolean;
  tooluseScenarios?: string;
  missionScenarios?: string;
}

const DEFAULT_TOOLUSE_BROWSER_SCENARIOS = "basic,approval,followup,timeout,complex";
const DEFAULT_TOOLUSE_NON_BROWSER_SCENARIOS = "basic,approval,followup,timeout";
const DEFAULT_MISSION_SCENARIOS = "basic,comparison,followup,cancel,approval,browser-dynamic,timeout-recovery";

const options = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
console.log("real acceptance starting");
console.log(`browser-tooluse: ${options.skipBrowserTooluse ? "skipped" : "enabled"}`);
console.log(`tooluse-scenarios: ${resolveTooluseScenarios(options)}`);
console.log(`mission-scenarios: ${options.missionScenarios ?? DEFAULT_MISSION_SCENARIOS}`);

await runCommand("tool-use real matrix", buildTooluseArgs(options));
await runCommand("mission real matrix", buildMissionArgs(options));

console.log(`real acceptance passed in ${Date.now() - startedAt}ms`);

function parseArgs(args: string[]): RealAcceptanceOptions {
  const options: RealAcceptanceOptions = {
    cdpTimeoutMs: 45_000,
    scenarioTimeoutMs: 240_000,
    skipBrowserTooluse: false,
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

function buildMissionArgs(options: RealAcceptanceOptions): string[] {
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildRealLlmAbMarkdownReport,
  validateRealLlmAbAcceptanceReport,
  type RealLlmAbRequiredSuite,
} from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";

export interface RealLlmAbAcceptanceCheckOptions {
  jsonPath: string;
  requiredSuite?: RealLlmAbRequiredSuite;
  markdownOutPath?: string;
}

export function parseRealLlmAbAcceptanceCheckArgs(args: string[]): RealLlmAbAcceptanceCheckOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let jsonPath: string | undefined;
  let requiredSuite: RealLlmAbRequiredSuite | undefined;
  let markdownOutPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      jsonPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--suite") {
      const value = readValue(args, index, arg);
      if (value !== "core") {
        throw new Error("--suite must be core");
      }
      requiredSuite = value;
      index += 1;
      continue;
    }
    if (arg === "--markdown-out") {
      markdownOutPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!jsonPath) {
    throw new Error("missing required --json <path>");
  }
  return { jsonPath, ...(requiredSuite ? { requiredSuite } : {}), ...(markdownOutPath ? { markdownOutPath } : {}) };
}

export async function runRealLlmAbAcceptanceCheckCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbAcceptanceCheckArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbAcceptanceCheckHelpText());
    return;
  }
  const report = JSON.parse(readFileSync(options.jsonPath, "utf8")) as unknown;
  const validation = validateRealLlmAbAcceptanceReport(report, { requiredSuite: options.requiredSuite });
  if (options.markdownOutPath) {
    const markdown = buildRealLlmAbMarkdownReport(report, { requiredSuite: options.requiredSuite });
    mkdirSync(path.dirname(path.resolve(options.markdownOutPath)), { recursive: true });
    writeFileSync(options.markdownOutPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    console.log(`real LLM A/B markdown report written: ${options.markdownOutPath}`);
  }
  if (validation.status !== "passed") {
    console.error("real LLM A/B acceptance failed");
    for (const failure of validation.failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("real LLM A/B acceptance passed");
  console.log(`scenarios=${validation.summary?.scenarioCount ?? 0}`);
  console.log(`comparable=${validation.summary?.comparableScenarios ?? 0}`);
  console.log(`turnkeyaiWins=${validation.summary?.turnkeyaiWins ?? 0}`);
  console.log(`turnkeyaiLosses=${validation.summary?.turnkeyaiLosses ?? 0}`);
  if (options.requiredSuite) {
    console.log(`suite=${options.requiredSuite}`);
  }
}

export function buildRealLlmAbAcceptanceCheckHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B acceptance report check",
    "",
    "Usage:",
    "  npm run acceptance:ab:check -- --json <path> [--suite core] [--markdown-out <path>]",
    "",
    "The report must contain natural same-scenario TurnkeyAI and reference-system evidence.",
    "--suite core requires the full core scenario set before treating the report as complete capability evidence.",
    "--markdown-out writes a conclusion-first run report with losses, root-cause buckets, and next PR guidance.",
    "Prompts that force exact tool calls, fixed markers, or exact final-answer shapes are rejected.",
  ].join("\n");
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRealLlmAbAcceptanceCheckCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

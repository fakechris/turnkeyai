import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { validateRealLlmAbAcceptanceReport } from "@turnkeyai/qc-runtime/real-llm-ab-acceptance";

export interface RealLlmAbAcceptanceCheckOptions {
  jsonPath: string;
}

export function parseRealLlmAbAcceptanceCheckArgs(args: string[]): RealLlmAbAcceptanceCheckOptions | { help: true } {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    return { help: true };
  }
  let jsonPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      jsonPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!jsonPath) {
    throw new Error("missing required --json <path>");
  }
  return { jsonPath };
}

export async function runRealLlmAbAcceptanceCheckCli(args: string[]): Promise<void> {
  const options = parseRealLlmAbAcceptanceCheckArgs(args);
  if ("help" in options) {
    console.log(buildRealLlmAbAcceptanceCheckHelpText());
    return;
  }
  const report = JSON.parse(readFileSync(options.jsonPath, "utf8")) as unknown;
  const validation = validateRealLlmAbAcceptanceReport(report);
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
}

export function buildRealLlmAbAcceptanceCheckHelpText(): string {
  return [
    "TurnkeyAI real LLM A/B acceptance report check",
    "",
    "Usage:",
    "  npm run acceptance:ab:check -- --json <path>",
    "",
    "The report must contain natural same-scenario TurnkeyAI and reference-system evidence.",
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

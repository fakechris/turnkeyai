import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_VALIDATION_SOAK_SELECTORS,
  runValidationSoakSeries,
} from "@turnkeyai/qc-runtime/validation-soak-series";

const args = process.argv.slice(2);
let cycles = 5;
let jsonPath: string | null = null;
let selectors: string[] = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--cycles") {
    const rawValue = Number(args[index + 1] ?? "");
    if (Number.isInteger(rawValue) && rawValue > 0) {
      cycles = rawValue;
    }
    index += 1;
    continue;
  }
  if (arg === "--selectors") {
    const raw = args[index + 1] ?? "";
    selectors = raw
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    index += 1;
    continue;
  }
  if (arg === "--json") {
    jsonPath = args[index + 1] ?? null;
    index += 1;
    continue;
  }
  selectors.push(arg);
}

const effectiveSelectors = selectors.length > 0 ? selectors : [...DEFAULT_VALIDATION_SOAK_SELECTORS];
const result = runValidationSoakSeries({
  cycles,
  selectors: effectiveSelectors,
});

console.log(
  `Validation soak series: ${result.status} (${result.passedCycles}/${result.totalCycles} cycles passed, ${result.failedCases}/${result.totalCases} failed cases)`
);
console.log(`selectors: ${result.selectors.join(", ")}`);
for (const cycle of result.cycles) {
  console.log(
    `- cycle=${cycle.cycleNumber} status=${cycle.status} suites=${cycle.totalSuites} items=${cycle.totalItems} cases=${cycle.totalCases} failedCases=${cycle.failedCases} durationMs=${cycle.durationMs}`
  );
  for (const suite of cycle.suites) {
    console.log(
      `  ${suite.suiteId}: status=${suite.status} items=${suite.totalItems} failedItems=${suite.failedItems} cases=${suite.totalCases} failedCases=${suite.failedCases}`
    );
  }
}

if (jsonPath) {
  const resolvedPath = path.resolve(process.cwd(), jsonPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

process.exit(result.failedCycles === 0 ? 0 : 1);

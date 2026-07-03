// Stage 8 engine cleanup (Batch 0.5) — architecture guard.
//
// HARD INVARIANT (plan "Dependency Rules" / "Non-Negotiable Cleanup Invariants"):
// no packages/role-runtime/src/react-engine/* module may import
// ../llm-response-generator (or re-export its helpers). If a helper is needed it
// must move into the owning react-engine module or a neutral shared role-runtime
// module. This test fails the build if any react-engine source file reaches back
// into the composition root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROLE_RUNTIME_DIR = path.dirname(ENGINE_DIR);
const LLM_RESPONSE_GENERATOR = path.join(
  ROLE_RUNTIME_DIR,
  "llm-response-generator.ts",
);

/** Forbidden import specifiers: the composition root and any known re-exporter. */
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+["'][^"']*llm-response-generator["']/,
  /import\s*\(\s*["'][^"']*llm-response-generator["']\s*\)/,
  /require\(\s*["'][^"']*llm-response-generator["']\s*\)/,
];

function engineSourceFiles(): string[] {
  return readdirSync(ENGINE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => path.join(ENGINE_DIR, name));
}

test("no react-engine module imports llm-response-generator", () => {
  const offenders: string[] = [];
  for (const file of engineSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(source)) {
        offenders.push(`${path.basename(file)} matches ${pattern}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `react-engine modules must not import the composition root:\n${offenders.join("\n")}`,
  );
});

test("architecture guard actually scans real react-engine files", () => {
  // Guard against a false-green from an empty scan: there must be several source
  // files, and known modules must be present.
  const files = engineSourceFiles().map((f) => path.basename(f));
  assert.ok(files.length >= 5, `expected react-engine modules, saw ${files.length}`);
  assert.ok(files.includes("types.ts"));
  assert.ok(files.includes("hook-policy-trace.ts"));
  assert.ok(files.includes("hook-orchestration-contract.ts"));
});

test("forced engine tool rounds do not record provider protocol rounds directly", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async executeRuntimeForcedToolRound");
  const end = source.indexOf("\n  private async emitToolProgressSafely", start);
  assert.notEqual(start, -1, "executeRuntimeForcedToolRound must exist");
  assert.notEqual(end, -1, "executeRuntimeForcedToolRound boundary must be found");
  const helperSource = source.slice(start, end);

  assert.equal(
    helperSource.includes("recordProviderToolProtocolRoundSafely"),
    false,
    "forced engine tool rounds must route provider protocol observability through EngineRunObserver",
  );
});

test("forced engine tool rounds delegate observer-owned trace persistence when available", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async executeRuntimeForcedToolRound");
  const end = source.indexOf("\n  private async emitToolProgressSafely", start);
  assert.notEqual(start, -1, "executeRuntimeForcedToolRound must exist");
  assert.notEqual(end, -1, "executeRuntimeForcedToolRound boundary must be found");
  const helperSource = source.slice(start, end);

  assert.equal(
    helperSource.includes("input.observer.observeRuntimeForcedToolRound"),
    true,
    "engine forced tool rounds must delegate trace/progress/persistence to EngineRunObserver when present",
  );
});

test("terminal final synthesis provider-schema repair request routes through terminal controller", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf(
    "private async generateFinalAfterToolRoundLimit",
  );
  const end = source.indexOf("\n  private async executeToolCalls", start);
  assert.notEqual(start, -1, "generateFinalAfterToolRoundLimit must exist");
  assert.notEqual(
    end,
    -1,
    "generateFinalAfterToolRoundLimit boundary must be found",
  );
  const helperSource = source.slice(start, end);

  assert.equal(
    helperSource.includes("shouldRepairExtraneousProviderTableSchema"),
    false,
    "terminal final synthesis provider-schema repair decisions must not use direct predicate calls",
  );
  assert.equal(
    helperSource.includes("evaluateNaturalFinish"),
    false,
    "terminal final synthesis provider-schema repair decisions must not evaluate the repair registry directly in the adapter",
  );
  assert.equal(
    helperSource.includes("evaluateFinalSynthesisProviderSchemaRepair"),
    false,
    "terminal final synthesis provider-schema repair decisions must not be evaluated directly in the adapter",
  );
  assert.equal(
    helperSource.includes("buildExtraneousProviderTableSchemaRepairMessages"),
    false,
    "terminal final synthesis provider-schema repair message construction must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("buildFinalSynthesisProviderSchemaRepairRequest"),
    true,
    "terminal final synthesis provider-schema repair message construction must route through TerminalCloseoutController",
  );
  assert.equal(
    helperSource.includes("buildToolCallArtifactCleanupMessages"),
    false,
    "terminal final synthesis tool-call cleanup message construction must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("containsAnyToolCallForm"),
    false,
    "terminal final synthesis tool-call artifact decisions must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("buildFinalSynthesisToolCallArtifactRepairRequest"),
    true,
    "terminal final synthesis tool-call cleanup requests must route through TerminalCloseoutController",
  );
  assert.equal(
    helperSource.includes("completeFinalSynthesisToolCallArtifactRepair"),
    true,
    "terminal final synthesis tool-call cleanup completion must route through TerminalCloseoutController",
  );
});

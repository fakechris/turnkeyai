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
const TOOL_USE = path.join(ROLE_RUNTIME_DIR, "tool-use.ts");

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
  const source = readFileSync(TOOL_USE, "utf8");
  const start = source.indexOf("export async function executeRuntimeForcedToolRound");
  const end = source.indexOf(
    "\nexport function createWorkerSessionToolExecutor",
    start,
  );
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
  const source = readFileSync(TOOL_USE, "utf8");
  const start = source.indexOf("export async function executeRuntimeForcedToolRound");
  const end = source.indexOf(
    "\nexport function createWorkerSessionToolExecutor",
    start,
  );
  assert.notEqual(start, -1, "executeRuntimeForcedToolRound must exist");
  assert.notEqual(end, -1, "executeRuntimeForcedToolRound boundary must be found");
  const helperSource = source.slice(start, end);

  assert.equal(
    helperSource.includes("input.observer.observeRuntimeForcedToolRound"),
    true,
    "engine forced tool rounds must delegate trace/progress/persistence to EngineRunObserver when present",
  );
});

test("forced runtime provider protocol fallback routes through tool-history owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async recordRuntimeForcedToolRoundProviderProtocol"),
    false,
    "adapter must not keep a private forced-round provider protocol wrapper",
  );
  assert.equal(
    source.includes("recordRuntimeForcedToolRoundProviderProtocolSafely({"),
    true,
    "adapter should call the neutral forced-round provider protocol recorder",
  );
});

test("terminal final synthesis provider-schema repair request routes through terminal controller", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf(
    "private async generateFinalAfterToolRoundLimit",
  );
  const end =
    source.indexOf("\n  private async executeToolCalls", start) >= 0
      ? source.indexOf("\n  private async executeToolCalls", start)
      : source.indexOf("\n  private async executeRuntimeForcedToolRound", start) >= 0
        ? source.indexOf("\n  private async executeRuntimeForcedToolRound", start)
        : source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
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
    helperSource.includes("buildFinalSynthesisSourceMessages"),
    false,
    "terminal final synthesis source-message construction must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("prepareToolHistoryForGateway"),
    false,
    "terminal final synthesis gateway message preparation must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("summarizeToolResultPruning"),
    false,
    "terminal final synthesis pruning summary construction must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("buildToolFreeGatewayInput"),
    false,
    "terminal final synthesis tool-free gateway input construction must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("buildFinalSynthesisGatewayRequest"),
    false,
    "terminal final synthesis gateway request construction must not be orchestrated directly in the adapter",
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
    false,
    "terminal final synthesis provider-schema repair request construction must not be orchestrated directly in the adapter",
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
    false,
    "terminal final synthesis tool-call cleanup request construction must not be orchestrated directly in the adapter",
  );
  assert.equal(
    helperSource.includes("completeFinalSynthesisToolCallArtifactRepair"),
    false,
    "terminal final synthesis tool-call cleanup completion must not be orchestrated directly in the adapter",
  );
  assert.equal(
    helperSource.includes("mergeFinalSynthesisRepairResult"),
    false,
    "terminal final synthesis repair merging must not be orchestrated directly in the adapter",
  );
  assert.equal(
    helperSource.includes("buildFinalSynthesisErrorFallback"),
    false,
    "terminal final synthesis gateway-error fallback must not be orchestrated directly in the adapter",
  );
  assert.equal(
    helperSource.includes("synthesizeFinalAfterToolRoundLimit"),
    true,
    "terminal final synthesis orchestration must route through TerminalCloseoutController",
  );
});

test("terminal completed closeout repair gateway input routes through terminal controller", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const hookStart = source.indexOf(
    "await terminalCloseout.handleTerminalCloseoutHook({",
  );
  assert.notEqual(hookStart, -1, "terminal closeout hook handoff must exist");
  const start = source.indexOf("completedCloseout: {", hookStart);
  const end = source.indexOf("\n              },\n            });", start);
  assert.notEqual(start, -1, "completed closeout handoff must exist");
  assert.notEqual(end, -1, "completed closeout handoff boundary must be found");
  const handoffSource = source.slice(start, end);

  assert.equal(
    handoffSource.includes("prepareToolHistoryForGateway"),
    false,
    "completed closeout repair gateway message preparation must not stay in the adapter",
  );
  assert.equal(
    handoffSource.includes("buildToolFreeGatewayInput"),
    false,
    "completed closeout repair tool-free gateway input construction must not stay in the adapter",
  );
  assert.equal(
    handoffSource.includes("baseGatewayInput: initialGatewayInput"),
    true,
    "completed closeout handoff must pass the base gateway input into TerminalCloseoutController",
  );
  assert.equal(
    handoffSource.includes("synthesizeRepair: async ({ gatewayInput })"),
    true,
    "completed closeout repair synthesis must receive controller-built gateway input",
  );
});

test("engine model gateway request construction routes through neutral gateway builder", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("const model: ModelClient = {");
  const end = source.indexOf("\n    };\n\n    const toolDefinitions", start);
  assert.notEqual(start, -1, "engine model client must exist");
  assert.notEqual(end, -1, "engine model client boundary must be found");
  const modelSource = source.slice(start, end);

  assert.equal(
    modelSource.includes("prepareToolHistoryForGateway"),
    false,
    "engine model gateway message preparation must not stay in the adapter",
  );
  assert.equal(
    modelSource.includes("buildToolFreeGatewayInput"),
    false,
    "engine model tool-free gateway input construction must not stay in the adapter",
  );
  assert.equal(
    modelSource.includes("summarizeToolResultPruning"),
    false,
    "engine model pruning summary construction must not stay in the adapter",
  );
  assert.equal(
    modelSource.includes("buildToolRoundGatewayRequest"),
    true,
    "engine model gateway request construction must route through the neutral gateway builder",
  );
});

test("tool-result pruning boundary recording routes through neutral pruning owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async recordToolResultPruningBoundary"),
    false,
    "tool-result pruning boundary recording must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes('boundaryKind: "tool_result_pruning"'),
    false,
    "tool-result pruning boundary metadata construction must live in tool-history-pruning",
  );
  assert.equal(
    source.includes("recordToolResultPruningBoundarySafely({"),
    true,
    "adapter should call the neutral safe pruning boundary recorder",
  );
});

test("request-envelope reduced retry gateway input routes through neutral gateway builder", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async generateWithEnvelopeRetry");
  const end =
    source.indexOf("\n  private async flushPreCompactionMemorySafely", start) >= 0
      ? source.indexOf("\n  private async flushPreCompactionMemorySafely", start)
      : source.indexOf("\n  private async generateFinalAfterToolRoundLimit", start);
  assert.notEqual(start, -1, "generateWithEnvelopeRetry must exist");
  assert.notEqual(end, -1, "generateWithEnvelopeRetry boundary must be found");
  const helperSource = source.slice(start, end);

  assert.equal(
    helperSource.includes("replaceInitialPromptMessages"),
    false,
    "request-envelope retry prompt-message replacement must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("deriveToolResultEnvelope"),
    false,
    "request-envelope retry tool-result envelope recomputation must not stay in the adapter",
  );
  assert.equal(
    helperSource.includes("buildReducedRetryGatewayInput"),
    true,
    "request-envelope retry gateway input construction must route through the neutral gateway builder",
  );
});

test("pre-compaction memory flush routes through flusher owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async flushPreCompactionMemorySafely"),
    false,
    "pre-compaction memory flush safety must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes("flushPreCompactionMemorySafely({"),
    true,
    "adapter should call the pre-compaction memory owner safe flusher",
  );
});

test("request-envelope reduction boundary recording routes through reducer owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async recordReductionBoundary"),
    false,
    "request-envelope reduction boundary recording must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes('boundaryKind: "request_envelope_reduction"'),
    false,
    "request-envelope reduction boundary metadata construction must live in request-envelope-reducer",
  );
  assert.equal(
    source.includes("recordReductionBoundarySafely({"),
    true,
    "adapter should call the neutral safe reduction boundary recorder",
  );
});

test("prompt assembly compaction boundary recording routes through prompt owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async recordAssemblyBoundary"),
    false,
    "prompt assembly boundary recording must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes('boundaryKind: "prompt_compaction"'),
    false,
    "prompt assembly compaction boundary metadata construction must live in prompt-policy",
  );
  assert.equal(
    source.includes("recordPromptAssemblyBoundarySafely({"),
    true,
    "adapter should call the prompt owner safe assembly boundary recorder",
  );
});

test("provider tool protocol boundary recording routes through neutral history owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async recordProviderToolProtocolRound"),
    false,
    "provider tool protocol boundary recording must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes('boundaryKind: "provider_tool_protocol_round"'),
    false,
    "provider tool protocol boundary metadata construction must live outside the adapter",
  );
  assert.equal(
    source.includes("recordProviderToolProtocolRoundSafely({"),
    true,
    "adapter should call the neutral safe provider protocol boundary recorder",
  );
});

test("runtime tool progress safe recording routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async recordToolProgressSafely"),
    false,
    "runtime tool progress safe recording must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes("recordRoleToolProgressSafely({"),
    true,
    "adapter should call the neutral safe runtime tool progress recorder",
  );
});

test("native tool trace persistence routes through native message owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async persistNativeToolTraceSafely"),
    false,
    "native tool trace persistence must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes("persistNativeToolTraceSafely({"),
    true,
    "adapter should call the neutral safe native tool trace persister",
  );
});

test("runtime tool progress emission routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const toolUseSource = readFileSync(TOOL_USE, "utf8");

  assert.equal(
    source.includes("private async emitToolProgressSafely"),
    false,
    "runtime tool progress emission must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes("executeRoleToolCalls({"),
    true,
    "adapter should call the neutral role tool-call executor",
  );
  assert.equal(
    toolUseSource.includes("emitRoleToolProgressSafely({"),
    true,
    "role tool-call executor should own safe runtime progress emission",
  );
});

test("role tool-call execution routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async executeToolCalls"),
    false,
    "role tool-call execution must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes("executeRoleToolCalls({"),
    true,
    "adapter should call the neutral role tool-call executor",
  );
});

test("forced runtime tool-round orchestration routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    source.includes("private async executeRuntimeForcedToolRound"),
    false,
    "forced runtime tool-round orchestration must not stay as an adapter-private method",
  );
  assert.equal(
    source.includes("executeRuntimeForcedToolRound({"),
    true,
    "adapter should call the neutral forced runtime tool-round runner",
  );
});

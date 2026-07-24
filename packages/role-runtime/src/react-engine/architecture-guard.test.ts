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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  DEFAULT_PROMPT_SECTION_DEFINITIONS,
  auditDefaultPromptRegistry,
} from "../prompt-registry";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROLE_RUNTIME_DIR = path.dirname(ENGINE_DIR);
const LLM_RESPONSE_GENERATOR = path.join(
  ROLE_RUNTIME_DIR,
  "llm-response-generator.ts",
);
const GATEWAY_ENVELOPE_RETRY = path.join(
  ROLE_RUNTIME_DIR,
  "gateway-envelope-retry.ts",
);
const TERMINAL_FINAL_SYNTHESIS = path.join(
  ROLE_RUNTIME_DIR,
  "terminal-final-synthesis.ts",
);
const TOOL_USE = path.join(ROLE_RUNTIME_DIR, "tool-use.ts");
const TOOL_PROTOCOL = path.join(ROLE_RUNTIME_DIR, "tool-protocol.ts");
const TOOL_DEFINITION_FILTER = path.join(
  ROLE_RUNTIME_DIR,
  "tool-definition-filter.ts",
);
const OPERATION_TIMEOUT_BUDGET = path.join(
  ROLE_RUNTIME_DIR,
  "operation-timeout-budget.ts",
);
const SUB_AGENT_WORKER_HANDLER = path.join(
  ROLE_RUNTIME_DIR,
  "sub-agent-worker-handler.ts",
);
const ENGINE_RUN_OBSERVER = path.join(ENGINE_DIR, "engine-run-observer.ts");
const RUNTIME_POLICY_DIR = path.join(ROLE_RUNTIME_DIR, "runtime-policy");
const RUNTIME_FACTS_DIR = path.join(ROLE_RUNTIME_DIR, "runtime-facts");
const GATEWAY_INPUT_BUILDER = path.join(
  ROLE_RUNTIME_DIR,
  "gateway-input-builder.ts",
);
const PACKAGES_DIR = path.resolve(ROLE_RUNTIME_DIR, "../..");
const TEAM_RUNTIME_DIR = path.join(PACKAGES_DIR, "team-runtime/src");

const FORBIDDEN_RUNTIME_FIXTURE_LITERALS = [
  "Vendor Alpha",
  "Vendor Beta",
  "$19 per seat",
  "$29 per workspace",
  "DeepSeek V4",
  "OpenRouter",
  "Together",
  "Fireworks",
  "agent workbench",
  "Incident Commander",
  "Frame Captain",
  "P-42",
];

const FORBIDDEN_RUNTIME_FIXTURE_MARKER = /\bTURNKEYAI_[A-Z0-9_]+_OK\b/;

const ACTIVE_ENGINE_POLICY_FILES = [
  "permission-policy.ts",
  "tool-call-normalizer.ts",
  "continuation-controller.ts",
  "closeout-policy-registry.ts",
  "repair-policy-registry.ts",
  "completed-closeout-controller.ts",
  "terminal-closeout-controller.ts",
];

const CORE_FACT_HELPER_NAME_PATTERN =
  /^(?:collectSessionToolResultRecords|inferWorkerKindFromSessionKey|inferRequiredFinalSynthesisDeliverables|should(?:Repair|Force|Continue|Suppress)\w+|mentions\w+|taskRequests\w+|taskRequires\w+|collect\w*(?:Evidence|Browser|Recovery|Failure)\w*|latestPermission\w+|hasPermission\w+|infer\w*Stream\w*)$/;

const CORE_FACT_HELPER_REFERENCE_PATTERN =
  /\b((?:collectSessionToolResultRecords|inferWorkerKindFromSessionKey|inferRequiredFinalSynthesisDeliverables|should(?:Repair|Force|Continue|Suppress)\w+|mentions\w+|taskRequests\w+|taskRequires\w+|collect\w*(?:Evidence|Browser|Recovery|Failure)\w*|latestPermission\w+|hasPermission\w+|infer\w*Stream\w*))\s*\(/g;

const CORE_FACT_HELPER_ALLOWLIST = new Set<string>([]);

const POLICY_TEXT_VIEW_NAMES = [
  "FinalSynthesisTextViews",
  "sourceBoundedEvidenceText",
  "completedSessionEvidenceText",
  "naturalFinishEvidenceText",
  "toolTraceResultContent",
  "approvalWaitTimeoutRuntimeEvidence",
  "runtimeEvidenceText",
  "toolResultContentText",
];

const TASK_LANGUAGE_HELPER_REFERENCE_PATTERN =
  /\b(taskPrompt[A-Za-z0-9_]*|taskLooksLike[A-Za-z0-9_]*|taskAllows[A-Za-z0-9_]*|requestsApproval[A-Za-z0-9_]*|expectsExact[A-Za-z0-9_]*|disclaimsApprovalGatedBrowserAction|is(?:AppliedApprovalBrowserContinuation|CoverageCriticalDelegationTask|ProviderSearchPricingResearchTask|TwoSourceComparisonTask))\s*\(/g;

/** Forbidden import specifiers: the composition root and any known re-exporter. */
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /from\s+["'][^"']*llm-response-generator["']/,
  /import\s*\(\s*["'][^"']*llm-response-generator["']\s*\)/,
  /require\(\s*["'][^"']*llm-response-generator["']\s*\)/,
];

function regexLiteralTexts(source: string): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const regexes: string[] = [];
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (token === ts.SyntaxKind.RegularExpressionLiteral) {
      regexes.push(scanner.getTokenText());
    }
  }
  return regexes;
}

function engineSourceFiles(): string[] {
  return readdirSync(ENGINE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => path.join(ENGINE_DIR, name));
}

function runtimePolicyCoreFiles(): string[] {
  try {
    return readdirSync(RUNTIME_POLICY_DIR)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => !name.endsWith(".test.ts"))
      .filter((name) => name !== "types.ts")
      .filter((name) => name !== "renderers.ts")
      .map((name) => path.join(RUNTIME_POLICY_DIR, name));
  } catch {
    return [];
  }
}

function runtimePolicyDecisionCoreFiles(): string[] {
  try {
    return readdirSync(RUNTIME_POLICY_DIR)
      .filter((name) => name.endsWith("-core.ts"))
      .map((name) => path.join(RUNTIME_POLICY_DIR, name));
  } catch {
    return [];
  }
}

function runtimeFactSourceFiles(): string[] {
  try {
    return readdirSync(RUNTIME_FACTS_DIR)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => !name.endsWith(".test.ts"))
      .filter((name) => name !== "types.ts")
      .map((name) => path.join(RUNTIME_FACTS_DIR, name));
  } catch {
    return [];
  }
}

function activePolicySourceFiles(): string[] {
  return [
    ...ACTIVE_ENGINE_POLICY_FILES.map((name) => path.join(ENGINE_DIR, name)),
    ...runtimePolicyCoreFiles(),
  ];
}

function coreFactReferenceSourceFiles(): string[] {
  return [
    LLM_RESPONSE_GENERATOR,
    GATEWAY_INPUT_BUILDER,
    path.join(ENGINE_DIR, "evidence-ledger.ts"),
    path.join(ROLE_RUNTIME_DIR, "task-facts-shared.ts"),
    ...activePolicySourceFiles(),
  ];
}

function activeRuntimeBoundarySourceFiles(): string[] {
  return [
    LLM_RESPONSE_GENERATOR,
    GATEWAY_INPUT_BUILDER,
    ...runtimeFactSourceFiles(),
    ...runtimePolicyCoreFiles(),
    ...ACTIVE_ENGINE_POLICY_FILES.map((name) => path.join(ENGINE_DIR, name)),
  ];
}

function coreFactExportSourceFiles(): string[] {
  return [
    path.join(ROLE_RUNTIME_DIR, "task-facts-shared.ts"),
  ];
}

function exportedFunctionNames(source: string): string[] {
  return Array.from(
    source.matchAll(/^export\s+function\s+([A-Za-z0-9_]+)\b/gm),
    (match) => match[1]!,
  );
}

function exportedValueNames(source: string): string[] {
  return Array.from(
    source.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)\b/gm),
    (match) => match[1]!,
  );
}

function exportedRuntimeNames(source: string): string[] {
  return [...exportedFunctionNames(source), ...exportedValueNames(source)];
}

function importedNamesFrom(source: string, modules: readonly string[]): string[] {
  const moduleSet = new Set(modules);
  const names = new Set<string>();
  const importPattern =
    /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2]!;
    if (!moduleSet.has(specifier)) continue;
    for (const rawName of match[1]!.split(",")) {
      const name = rawName
        .replace(/\/\/.*$/g, "")
        .replace(/\btype\s+/g, "")
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) {
        names.add(name);
      }
    }
  }
  return Array.from(names).sort();
}

function importReferencesFrom(
  source: string,
  fileName = "source.ts",
): Array<{ moduleSpecifier: string; isTypeOnly: boolean }> {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: Array<{ moduleSpecifier: string; isTypeOnly: boolean }> = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    imports.push({
      moduleSpecifier: statement.moduleSpecifier.text,
      isTypeOnly: statement.importClause?.isTypeOnly === true,
    });
  }
  return imports;
}

function coreFactHelperExportNames(source: string): string[] {
  return exportedRuntimeNames(source).filter(
    (name) =>
      CORE_FACT_HELPER_NAME_PATTERN.test(name) &&
      !CORE_FACT_HELPER_ALLOWLIST.has(name),
  );
}

function coreFactHelperReferences(source: string): string[] {
  return Array.from(
    new Set(
      Array.from(
        source.matchAll(CORE_FACT_HELPER_REFERENCE_PATTERN),
        (match) => match[1]!,
      ).filter((name) => !CORE_FACT_HELPER_ALLOWLIST.has(name)),
    ),
  );
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

test("role response generation has one engine path and no inline escape hatch", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  assert.equal(source.includes("private async runEngine"), true);
  assert.equal(source.includes("TURNKEYAI_REACT_ENGINE"), false);
  assert.equal(source.includes("reactEngine?:"), false);
  assert.equal(source.includes("runViaReActEngine"), false);
  assert.equal(
    existsSync(path.join(RUNTIME_POLICY_DIR, "inline-policy-runner.ts")),
    false,
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
  const runnerSource = readFileSync(
    path.join(ENGINE_DIR, "engine-forced-tool-round-runner.ts"),
    "utf8",
  );

  assert.equal(
    source.includes("private async recordRuntimeForcedToolRoundProviderProtocol"),
    false,
    "adapter must not keep a private forced-round provider protocol wrapper",
  );
  assert.equal(
    runnerSource.includes("recordRuntimeForcedToolRoundProviderProtocolSafely({"),
    true,
    "forced-round owner should call the neutral provider protocol recorder",
  );
});

test("engine forced runtime tool-round executor wiring routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("executeRuntimeForcedToolRound({"),
    false,
    "engine forced-round execution wiring must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("createRoleEngineRuntimeForcedToolRoundRunner({"),
    true,
    "runEngine should create role-engine forced-round runners through the react-engine owner",
  );
});

test("engine forced runtime tool-round role wiring routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const runnerSource = readFileSync(
    path.join(ENGINE_DIR, "engine-forced-tool-round-runner.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("createEngineRuntimeForcedToolRoundRunner({"),
    false,
    "engine forced-round role wiring must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("providerRuntimeProgressRecorder:"),
    false,
    "engine forced-round provider-recorder selection must live with the runner owner",
  );
  assert.equal(
    engineSource.includes("createRoleEngineRuntimeForcedToolRoundRunner({"),
    true,
    "runEngine should create role-engine forced-round runners through the owner",
  );
  assert.equal(
    runnerSource.includes("providerRuntimeProgressRecorder:"),
    true,
    "forced-round runner owner should bind provider protocol recorder selection",
  );
});

test("engine final generated reply assembly routes through final-response owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("buildRuntimeDerivedMissionReport("),
    false,
    "engine final mission report assembly must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("summarizeModelUseTrace("),
    false,
    "engine final model-use summary assembly must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("createEngineFinalResponseBuilder({"),
    true,
    "runEngine should build final replies through the react-engine owner",
  );
});

test("engine agent event consumption routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("for await (const event of agent.run("),
    false,
    "engine ReAct event consumption must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("createRoleEngineAgentRunner"),
    true,
    "runEngine should consume ReAct events through the react-engine runner factory",
  );
});

test("authoritative effect lifecycle is fail-closed and stays outside observers", () => {
  const adapterSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const runnerSource = readFileSync(
    path.join(ENGINE_DIR, "engine-agent-runner.ts"),
    "utf8",
  );
  const observerSource = readFileSync(ENGINE_RUN_OBSERVER, "utf8");
  const toolUseSource = readFileSync(TOOL_USE, "utf8");
  const executeStart = toolUseSource.indexOf(
    "export async function executeRoleToolCalls",
  );
  const executeEnd = toolUseSource.indexOf(
    "export interface RuntimeForcedToolRoundObserver",
    executeStart,
  );
  const executeSource = toolUseSource.slice(executeStart, executeEnd);

  assert.equal(
    adapterSource.includes("runJournal.effectLedger.admit"),
    true,
    "engine composition must persist effect admission for normal and forced rounds",
  );
  assert.equal(
    adapterSource.includes("runJournal.effectLedger.start"),
    true,
    "engine composition must persist effect start before dispatch",
  );
  assert.equal(
    adapterSource.includes("runJournal.effectLedger.recordResult"),
    true,
    "engine composition must persist effect receipts",
  );
  assert.ok(
    runnerSource.indexOf("effectLifecycle?.onStarted") <
      runnerSource.indexOf("observer.onToolStarted"),
    "normal tool start must reach the authoritative ledger before observers",
  );
  assert.equal(
    runnerSource.includes("onToolExecutionStart: async"),
    true,
    "normal tool start persistence must run at the actual dispatch boundary",
  );
  assert.equal(
    runnerSource.includes("onToolExecutionResult: async"),
    true,
    "normal tool receipts must persist at the actual executor-return boundary",
  );
  assert.equal(
    adapterSource.includes("runToolBatch: async (calls, runOne, hookCtx)"),
    true,
    "engine batch scheduling must execute through agent-core's authoritative runOne boundary",
  );
  assert.equal(
    adapterSource.includes("_runOne"),
    false,
    "engine batch scheduling must not discard the authoritative runOne executor",
  );
  assert.ok(
    runnerSource.indexOf("priorResults.get(call.id)") <
      runnerSource.indexOf("effectLifecycle?.onStarted"),
    "normal execution must return a prior receipt before start or dispatch",
  );
  assert.ok(
    runnerSource.indexOf("effectLifecycle?.onResult") <
      runnerSource.indexOf("observer.onToolResult"),
    "normal tool receipt must reach the authoritative ledger before observers",
  );
  assert.equal(
    observerSource.includes("effectLedger"),
    false,
    "EngineRunObserver must not own authoritative effect state",
  );
  assert.ok(
    executeSource.indexOf("await input.onAdmitted?.(call)") <
      executeSource.indexOf("activeToolLoop.executor.execute"),
    "forced tool admission must persist before external dispatch",
  );
  assert.ok(
    executeSource.indexOf("await input.onStarted?.(call)") <
      executeSource.indexOf("activeToolLoop.executor.execute"),
    "forced tool start must persist before external dispatch",
  );
  assert.ok(
    executeSource.indexOf("const priorResult = await input.onAdmitted?.(call)") <
      executeSource.indexOf("await input.onStarted?.(call)"),
    "forced execution must return a prior receipt before start or dispatch",
  );
  assert.ok(
    executeSource.indexOf("assertUniqueRoleToolCallIds(input.toolCalls)") <
      executeSource.indexOf("await input.onAdmitted?.(call)"),
    "forced execution must reject duplicate ids before any admission or dispatch",
  );
});

test("engine ReAct agent creation routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const runnerSource = readFileSync(
    path.join(ENGINE_DIR, "engine-agent-runner.ts"),
    "utf8",
  );

  assert.equal(
    source.includes('from "@turnkeyai/agent-core/react-agent"'),
    false,
    "adapter must not import the ReAct agent factory directly",
  );
  assert.equal(
    engineSource.includes("createReActAgent<RoleToolContext>({"),
    false,
    "engine ReAct agent construction must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("maxRounds: maxRounds + 1"),
    false,
    "engine ReAct agent boundary-round adjustment must live with the runner owner",
  );
  assert.equal(
    engineSource.includes("createRoleEngineAgentRunner"),
    true,
    "runEngine should create the ReAct runner through the react-engine owner",
  );
  assert.equal(
    runnerSource.includes("createReActAgent"),
    true,
    "engine agent runner owner should bind the agent-core factory",
  );
});

test("engine task intent facts are built at the adapter boundary and consumed by owners", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("const taskFacts = buildTaskFacts({"),
    true,
    "runEngine should build one TaskFacts snapshot at the composition boundary",
  );
  for (const forbiddenAccess of [
    "taskFacts.requestedTableColumns",
    "taskFacts.providerSupportSchemaRequested",
    "taskFacts.browserVisibleEvidenceRequired",
    "taskFacts.productSignalDashboardEvidenceRequested",
    "taskFacts.timeoutRecoveryRequested",
    "taskFacts.awaitingContextSetupOnly",
    "taskFacts.requiredIndependentEvidenceStreams",
  ]) {
    assert.equal(
      engineSource.includes(forbiddenAccess),
      false,
      `runEngine must pass task facts through, not branch on ${forbiddenAccess}`,
    );
  }

  const ownerExpectations: Array<[string, string]> = [
    ["permission-policy.ts", "input.taskFacts.awaitingContextSetupOnly"],
    [
      "continuation-controller.ts",
      "buildIndependentEvidenceStreamsPolicyFacts(input)",
    ],
    [
      "repair-policy-registry.ts",
      "buildNaturalFinishRepairPolicyFacts(input)",
    ],
  ];
  for (const [fileName, expectedSource] of ownerExpectations) {
    const ownerSource = readFileSync(path.join(ENGINE_DIR, fileName), "utf8");
    assert.equal(
      ownerSource.includes(expectedSource),
      true,
      `${fileName} should consume typed TaskFacts in the owner module`,
    );
  }
});

test("engine role toolkit wiring routes through toolkit owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("const toolkit: Toolkit<RoleToolContext>"),
    false,
    "engine role toolkit construction must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("createEngineRoleToolkit({"),
    true,
    "runEngine should create the ReAct toolkit through the react-engine owner",
  );
});

test("engine onToolCalls hook routes through tool-call normalizer owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const normalizerSource = readFileSync(
    path.join(ENGINE_DIR, "tool-call-normalizer.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("buildToolCallNormalizationContext({"),
    false,
    "engine onToolCalls normalization context construction must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("normalizeEngineToolCalls("),
    false,
    "engine onToolCalls normalizer invocation must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("truncateForRecoveryBudget({"),
    false,
    "engine onToolCalls recovery-budget truncation must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("applyEngineToolCallsHook({"),
    true,
    "runEngine should delegate onToolCalls to the normalizer owner",
  );
  assert.equal(
    normalizerSource.includes("normalizeEngineToolCalls("),
    true,
    "tool-call normalizer owner should keep the normalizer invocation",
  );
  assert.equal(
    normalizerSource.includes("truncateForRecoveryBudget({"),
    true,
    "tool-call normalizer owner should bind recovery-budget truncation",
  );
});

test("engine execution budget hooks route through execution-budget owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const budgetSource = readFileSync(
    path.join(ENGINE_DIR, "execution-budget-controller.ts"),
    "utf8",
  );
  const validatorSource = readFileSync(
    path.join(ENGINE_DIR, "tool-argument-validator.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("limitToolCallsPerRound({"),
    false,
    "engine onBeforeExecute admission must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("runToolBatch<RoleToolContext>({"),
    false,
    "engine runToolBatch hook wiring must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("applyEngineBeforeExecuteHook({"),
    true,
    "runEngine should delegate onBeforeExecute to the execution-budget owner",
  );
  assert.equal(
    engineSource.includes("createToolArgumentValidator(toolDefinitions)"),
    true,
    "runEngine should compile the exact offered tool schemas once per run",
  );
  assert.equal(
    engineSource.includes("applyToolArgumentValidationBeforeAdmission({"),
    true,
    "runEngine should validate tool arguments before budget admission",
  );
  assert.equal(
    engineSource.includes("runEngineToolBatchHook({"),
    true,
    "runEngine should delegate runToolBatch to the execution-budget owner",
  );
  assert.equal(
    budgetSource.includes("limitToolCallsPerRound({"),
    true,
    "execution-budget owner should keep per-round admission logic",
  );
  assert.equal(
    budgetSource.includes("runToolBatch<RoleToolContext>({"),
    true,
    "execution-budget owner should keep role tool-batch wiring",
  );
  assert.equal(
    validatorSource.indexOf("input.validator.validate(input.calls)") <
      validatorSource.indexOf("input.admit(validated.executable)"),
    true,
    "tool schema validation must run before execution-budget admission",
  );
});

test("engine pending-call closeout hook routes through closeout-policy owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const hookStart = engineSource.indexOf("onToolCallsClose: (calls, state)");
  const hookEnd = engineSource.indexOf(
    "        // Stage 7 S7 + S5:",
    hookStart,
  );
  assert.notEqual(hookStart, -1, "onToolCallsClose hook must exist");
  assert.notEqual(hookEnd, -1, "onToolCallsClose hook boundary must be found");
  const hookSource = engineSource.slice(hookStart, hookEnd);
  const registrySource = readFileSync(
    path.join(ENGINE_DIR, "closeout-policy-registry.ts"),
    "utf8",
  );

  assert.equal(
    hookSource.includes("applyPendingCallsCloseout("),
    false,
    "engine pending-call closeout flow must not call the generic registry application inline",
  );
  assert.equal(
    hookSource.includes("countNativeToolCalls(toolTrace)"),
    false,
    "engine pending-call closeout hook must not compute used tool calls inline",
  );
  assert.equal(
    hookSource.includes("runEvidence.snapshot(state.messages)"),
    false,
    "engine pending-call closeout hook must not read evidence snapshots inline",
  );
  assert.equal(
    hookSource.includes("applyPendingCallsCloseoutHook("),
    true,
    "runEngine should delegate onToolCallsClose to the closeout-policy owner",
  );
  assert.equal(
    registrySource.includes("applyPendingCallsCloseout("),
    true,
    "closeout-policy owner should keep generic pending-closeout application",
  );
});

test("engine lightweight hook entrypoints route through their owners", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  const suppressStart = engineSource.indexOf(
    "onSuppressToolCalls: (calls, state, ctx)",
  );
  const suppressEnd = engineSource.indexOf(
    "        // Stage 5 PR2d pending-call closeouts:",
    suppressStart,
  );
  assert.notEqual(suppressStart, -1, "onSuppressToolCalls hook must exist");
  assert.notEqual(suppressEnd, -1, "onSuppressToolCalls boundary must be found");
  const suppressSource = engineSource.slice(suppressStart, suppressEnd);

  const afterExecuteStart = engineSource.indexOf("onAfterExecute: (results)");
  const afterExecuteEnd = engineSource.indexOf(
    "        // Stage 7 S4: empty-round session-continuation injection.",
    afterExecuteStart,
  );
  assert.notEqual(afterExecuteStart, -1, "onAfterExecute hook must exist");
  assert.notEqual(afterExecuteEnd, -1, "onAfterExecute boundary must be found");
  const afterExecuteSource = engineSource.slice(
    afterExecuteStart,
    afterExecuteEnd,
  );

  const roundEmptyStart = engineSource.indexOf("onRoundEmpty: (state)");
  const roundEmptyEnd = engineSource.indexOf(
    "        // Stage 6: post-synthesis repairs",
    roundEmptyStart,
  );
  assert.notEqual(roundEmptyStart, -1, "onRoundEmpty hook must exist");
  assert.notEqual(roundEmptyEnd, -1, "onRoundEmpty boundary must be found");
  const roundEmptySource = engineSource.slice(roundEmptyStart, roundEmptyEnd);

  assert.equal(
    suppressSource.includes("if (!activeToolLoop || calls.length === 0)"),
    false,
    "suppress-tool-calls active/empty gating must live with PermissionPolicy",
  );
  assert.equal(
    suppressSource.includes("active: Boolean(activeToolLoop)"),
    true,
    "onSuppressToolCalls should pass active state into PermissionPolicy",
  );
  assert.equal(
    afterExecuteSource.includes("evidenceLedger.currentRound(results)"),
    false,
    "post-execute current-round evidence reads must live with CloseoutPolicyRegistry",
  );
  assert.equal(
    afterExecuteSource.includes("applyPostExecuteCloseout("),
    false,
    "post-execute generic closeout application must not stay inline in runEngine",
  );
  assert.equal(
    afterExecuteSource.includes("applyPostExecuteCloseoutHook("),
    true,
    "onAfterExecute should delegate hook flow to CloseoutPolicyRegistry",
  );
  assert.equal(
    roundEmptySource.includes("const action = continuation.onRoundEmpty({"),
    false,
    "round-empty action selection must not stay inline in runEngine",
  );
  assert.equal(
    roundEmptySource.includes("applyRoundEmptyAction(action)"),
    false,
    "round-empty action application must not stay inline in runEngine",
  );
  assert.equal(
    roundEmptySource.includes("applyRoundEmptyHook({"),
    true,
    "onRoundEmpty should delegate action selection/application to ContinuationController",
  );
});

test("engine natural-finish repair hook routes through repair-policy owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const hookStart = engineSource.indexOf("onRepairRound: (state, ctx)");
  const hookEnd = engineSource.indexOf(
    "        // Stage 5 closeout-answer producer.",
    hookStart,
  );
  assert.notEqual(hookStart, -1, "onRepairRound hook must exist");
  assert.notEqual(hookEnd, -1, "onRepairRound boundary must be found");
  const hookSource = engineSource.slice(hookStart, hookEnd);
  const repairSource = readFileSync(
    path.join(ENGINE_DIR, "repair-policy-registry.ts"),
    "utf8",
  );

  assert.equal(
    hookSource.includes("if (!activeToolLoop)"),
    false,
    "natural-finish repair active-loop gating must live with RepairPolicyRegistry",
  );
  assert.equal(
    hookSource.includes("countNativeToolCalls(toolTrace)"),
    false,
    "natural-finish repair recovery budget accounting must live with RepairPolicyRegistry",
  );
  assert.equal(
    hookSource.includes("applyNaturalFinishRepair({"),
    false,
    "natural-finish repair application must not stay inline in runEngine",
  );
  assert.equal(
    hookSource.includes("applyNaturalFinishRepairHook("),
    true,
    "onRepairRound should delegate hook flow to RepairPolicyRegistry",
  );
  assert.equal(
    repairSource.includes("applyNaturalFinishRepair({"),
    true,
    "repair-policy owner should keep natural-finish repair application",
  );
});

test("engine model-call-error hook routes through terminal closeout owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const hookStart = engineSource.indexOf(
    "onModelCallError: async (error, state",
  );
  const hookEnd = engineSource.indexOf(
    "        // Capture the live message history",
    hookStart,
  );
  assert.notEqual(hookStart, -1, "onModelCallError hook must exist");
  assert.notEqual(hookEnd, -1, "onModelCallError boundary must be found");
  const hookSource = engineSource.slice(hookStart, hookEnd);
  const terminalSource = readFileSync(
    path.join(ENGINE_DIR, "terminal-closeout-controller.ts"),
    "utf8",
  );

  assert.equal(
    hookSource.includes("isAbortError(error)"),
    false,
    "model-call-error abort classification must live with TerminalCloseoutController",
  );
  assert.equal(
    hookSource.includes("runState.captureFinalMessages(state.messages)"),
    false,
    "model-call-error final-message capture must live with TerminalCloseoutController",
  );
  assert.equal(
    hookSource.includes("runEvidence.snapshot(state.messages)"),
    false,
    "model-call-error evidence snapshot reads must live with TerminalCloseoutController",
  );
  assert.equal(
    hookSource.includes("countNativeToolCalls(toolTrace)"),
    false,
    "model-call-error tool-count accounting must live with TerminalCloseoutController",
  );
  assert.equal(
    hookSource.includes("completeModelCallErrorFlow("),
    false,
    "model-call-error hook must not call the lower-level flow directly",
  );
  assert.equal(
    hookSource.includes("completeModelCallErrorHook("),
    true,
    "onModelCallError should delegate hook state capture to TerminalCloseoutController",
  );
  assert.equal(
    terminalSource.includes("completeModelCallErrorFlow("),
    true,
    "terminal controller should keep the lower-level model-error flow",
  );
});

test("engine terminate decision hook routes through closeout-policy owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const hookStart = engineSource.indexOf("onTerminate: async (reason, state");
  const hookEnd = engineSource.indexOf(
    "          const terminalCompletion =",
    hookStart,
  );
  assert.notEqual(hookStart, -1, "onTerminate hook must exist");
  assert.notEqual(hookEnd, -1, "onTerminate decision boundary must be found");
  const decisionSource = engineSource.slice(hookStart, hookEnd);
  const registrySource = readFileSync(
    path.join(ENGINE_DIR, "closeout-policy-registry.ts"),
    "utf8",
  );

  assert.equal(
    decisionSource.includes("countNativeToolCalls(toolTrace)"),
    false,
    "terminate hook tool-count accounting must live with CloseoutPolicyRegistry",
  );
  assert.equal(
    decisionSource.includes("runEvidence.snapshot(state.messages)"),
    false,
    "terminate hook evidence snapshot reads must live with CloseoutPolicyRegistry",
  );
  assert.equal(
    decisionSource.includes("runState.pendingCloseout()"),
    false,
    "terminate hook pending-closeout reads must live with CloseoutPolicyRegistry",
  );
  assert.equal(
    decisionSource.includes("runState.timeoutSignal()"),
    false,
    "terminate hook timeout-signal reads must live with CloseoutPolicyRegistry",
  );
  assert.equal(
    decisionSource.includes("closeoutPolicy.evaluateTerminate({"),
    false,
    "terminate hook must not call the lower-level terminate evaluator directly",
  );
  assert.equal(
    decisionSource.includes("closeoutPolicy.evaluateTerminateHook({"),
    true,
    "onTerminate should delegate decision input assembly to CloseoutPolicyRegistry",
  );
  assert.equal(
    registrySource.includes("evaluateTerminateHook("),
    true,
    "closeout-policy owner should expose the terminate hook entrypoint",
  );
});

test("engine completed terminal handoff routes through terminal closeout owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const hookStart = engineSource.indexOf("onTerminate: async (reason, state");
  const hookEnd = engineSource.indexOf(
    "          if (terminalCompletion.kind === \"rearm\")",
    hookStart,
  );
  assert.notEqual(hookStart, -1, "onTerminate hook must exist");
  assert.notEqual(hookEnd, -1, "onTerminate terminal handoff boundary must be found");
  const hookSource = engineSource.slice(hookStart, hookEnd);
  const terminalSource = readFileSync(
    path.join(ENGINE_DIR, "terminal-closeout-controller.ts"),
    "utf8",
  );

  assert.equal(
    hookSource.includes("completedSession: runState.completedSession()"),
    false,
    "completed terminal handoff must not read completed session state in the adapter",
  );
  assert.equal(
    hookSource.includes(
      "completedSessionToolResults:\n                  runState.completedSessionToolResults()",
    ),
    false,
    "completed terminal handoff must not read completed tool results in the adapter",
  );
  assert.equal(
    hookSource.includes("repairMarkers: (ctx.repairMarkers ??= [])"),
    false,
    "completed terminal handoff must not initialize repair markers in the adapter",
  );
  assert.equal(
    hookSource.includes("completedCloseoutHook: {"),
    true,
    "onTerminate should delegate completed terminal handoff assembly to TerminalCloseoutController",
  );
  assert.equal(
    terminalSource.includes("buildCompletedCloseoutHookInput("),
    true,
    "terminal closeout owner should expose the completed handoff builder",
  );
});

test("engine policy owners consume completed/timeout facts through EvidenceLedger", () => {
  const offenders: string[] = [];
  for (const name of [
    "continuation-controller.ts",
    "closeout-policy-registry.ts",
    "completed-closeout-controller.ts",
    "terminal-closeout-controller.ts",
  ]) {
    const source = readFileSync(path.join(ENGINE_DIR, name), "utf8");
    if (
      source.includes("findCompletedSessionEvidence") ||
      source.includes("findSubAgentToolTimeout")
    ) {
      offenders.push(name);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `engine policy owners must consume EvidenceLedger typed facts, not raw finder helpers:\n${offenders.join("\n")}`,
  );

  const continuationSource = readFileSync(
    path.join(ENGINE_DIR, "continuation-controller.ts"),
    "utf8",
  );
  assert.equal(
    continuationSource.includes("roundEvidence.timeoutSignals[0]"),
    true,
    "continuation hook must read typed timeout facts from EvidenceLedger",
  );
  assert.equal(
    continuationSource.includes(
      "collectCompletedSessionFinalContents(roundEvidence.completedSessions)",
    ),
    true,
    "continuation hook must read typed completed-session facts from EvidenceLedger",
  );

  const closeoutSource = readFileSync(
    path.join(ENGINE_DIR, "closeout-policy-registry.ts"),
    "utf8",
  );
  assert.equal(
    closeoutSource.includes("roundEvidence.completedSessions.length > 0"),
    true,
    "closeout hook must read typed completed-session facts from EvidenceLedger",
  );
  assert.equal(
    closeoutSource.includes("roundEvidence.timeoutSignals[0]"),
    true,
    "closeout hook must read typed timeout facts from EvidenceLedger",
  );
});

test("engine terminal synthesis callbacks route through terminal closeout owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const hookStart = engineSource.indexOf("onTerminate: async (reason, state");
  const hookEnd = engineSource.indexOf(
    "          if (terminalCompletion.kind === \"rearm\")",
    hookStart,
  );
  assert.notEqual(hookStart, -1, "onTerminate hook must exist");
  assert.notEqual(hookEnd, -1, "onTerminate terminal handoff boundary must be found");
  const hookSource = engineSource.slice(hookStart, hookEnd);
  const terminalSource = readFileSync(
    path.join(ENGINE_DIR, "terminal-closeout-controller.ts"),
    "utf8",
  );

  assert.equal(
    hookSource.includes("synthesize: async ({"),
    false,
    "terminal synthesis callback wiring must not stay inline in the adapter",
  );
  assert.equal(
    hookSource.includes("synthesizeToolCallArtifactCleanup: async ({ messages })"),
    false,
    "completed cleanup synthesis callback wiring must not stay inline in the adapter",
  );
  assert.equal(
    hookSource.includes("synthesizeFinalAfterToolRoundLimit({"),
    false,
    "onTerminate must not call the final-synthesis runner directly inside callback wiring",
  );
  assert.equal(
    hookSource.includes("terminalCloseout.buildTerminalSynthesisHook({"),
    true,
    "onTerminate should delegate terminal synthesis callback wiring to TerminalCloseoutController",
  );
  assert.equal(
    hookSource.includes("terminalCloseout.buildCompletedToolCallArtifactCleanupHook({"),
    true,
    "onTerminate should delegate completed cleanup callback wiring to TerminalCloseoutController",
  );
  assert.equal(
    terminalSource.includes("buildTerminalSynthesisHook"),
    true,
    "terminal closeout owner should expose terminal synthesis callback builder",
  );
  assert.equal(
    terminalSource.includes("buildCompletedToolCallArtifactCleanupHook"),
    true,
    "terminal closeout owner should expose completed cleanup callback builder",
  );
});

test("engine approval wait-timeout fallback hook routes through terminal closeout owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const hookStart = engineSource.indexOf("onTerminate: async (reason, state");
  const hookEnd = engineSource.indexOf(
    "          if (terminalCompletion.kind === \"rearm\")",
    hookStart,
  );
  assert.notEqual(hookStart, -1, "onTerminate hook must exist");
  assert.notEqual(hookEnd, -1, "onTerminate terminal handoff boundary must be found");
  const hookSource = engineSource.slice(hookStart, hookEnd);
  const terminalSource = readFileSync(
    path.join(ENGINE_DIR, "terminal-closeout-controller.ts"),
    "utf8",
  );

  assert.equal(
    hookSource.includes("reason === \"tool_evidence_fallback\""),
    false,
    "approval wait-timeout fallback reason gating must live with TerminalCloseoutController",
  );
  assert.equal(
    hookSource.includes("approvalWaitTimeoutFallback: {"),
    false,
    "approval wait-timeout fallback input assembly must not stay inline in the adapter",
  );
  assert.equal(
    hookSource.includes(
      "approval wait-timeout repair omitted required pending evidence",
    ),
    false,
    "approval wait-timeout fallback error construction must live with TerminalCloseoutController",
  );
  assert.equal(
    hookSource.includes("terminalCloseout.buildApprovalWaitTimeoutFallbackHook({"),
    true,
    "onTerminate should delegate approval wait-timeout fallback hook assembly to TerminalCloseoutController",
  );
  assert.equal(
    terminalSource.includes("buildApprovalWaitTimeoutFallbackHook("),
    true,
    "terminal closeout owner should expose approval wait-timeout fallback hook builder",
  );
});

test("engine permission policy facts route through EvidenceLedger", () => {
  const repairSource = readFileSync(
    path.join(ENGINE_DIR, "repair-policy-registry.ts"),
    "utf8",
  );
  const closeoutSource = readFileSync(
    path.join(ENGINE_DIR, "closeout-policy-registry.ts"),
    "utf8",
  );

  assert.equal(
    repairSource.includes("permissionFacts?: PermissionEvidenceFacts"),
    true,
    "repair policies should accept typed permission facts from EvidenceLedger",
  );
  assert.equal(
    repairSource.includes("permissionFacts: evidence.permission"),
    true,
    "natural-finish repair hook should pass EvidenceLedger permission facts",
  );
  assert.equal(
    closeoutSource.includes("terminateEvidence.approvalEvidenceText"),
    true,
    "terminate closeout should read approval wait-timeout text through EvidenceLedger approval evidence",
  );
});

test("engine run-state role value typing routes through run-state owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("type RoleEngineRunStateValues"),
    false,
    "role-engine run-state value typing must not stay local to runEngine",
  );
  assert.equal(
    engineSource.includes("createRoleEngineRunState()"),
    true,
    "runEngine should create typed role-engine run state through the owner",
  );
});

test("engine run observer wiring routes through observer owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("createEngineRunObserver(toolTrace, {"),
    false,
    "engine run observer dependency wiring must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("recordToolProgress: (call, progress) =>"),
    false,
    "engine run observer tool-progress callback wiring must live with the observer owner",
  );
  assert.equal(
    engineSource.includes("recordProviderToolProtocolRound: (round) =>"),
    false,
    "engine run observer provider-protocol callback wiring must live with the observer owner",
  );
  assert.equal(
    engineSource.includes("persistNativeToolTrace: (options) =>"),
    false,
    "engine run observer native-trace persistence callback wiring must live with the observer owner",
  );
  assert.equal(
    engineSource.includes("createRoleEngineRunObserver({"),
    true,
    "runEngine should create observers through the react-engine owner",
  );
});

test("terminal final synthesis provider-schema repair request routes through terminal controller", () => {
  const adapterSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  assert.equal(
    adapterSource.includes("private async generateFinalAfterToolRoundLimit"),
    false,
    "terminal final synthesis gateway wrapper must not stay as an adapter-private method",
  );
  assert.equal(
    adapterSource.includes("createTerminalFinalSynthesisRunner({"),
    true,
    "adapter should create neutral terminal final synthesis runners",
  );
  const helperSource = readFileSync(TERMINAL_FINAL_SYNTHESIS, "utf8");

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

test("terminal final synthesis dependency injection routes through neutral runner", () => {
  const adapterSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const ownerSource = readFileSync(TERMINAL_FINAL_SYNTHESIS, "utf8");

  assert.equal(
    adapterSource.includes("type InlineFinalSynthesisInput"),
    false,
    "inline final-synthesis dependency-injection input type must not stay in the adapter",
  );
  assert.equal(
    adapterSource.includes("type EngineFinalSynthesisInput"),
    false,
    "engine final-synthesis dependency-injection input type must not stay in the adapter",
  );
  assert.equal(
    adapterSource.includes("createTerminalFinalSynthesisRunner({"),
    true,
    "adapter should create final-synthesis runners from the neutral owner",
  );
  assert.equal(
    ownerSource.includes("generateFinalAfterToolRoundLimit({"),
    true,
    "terminal final synthesis runner should delegate to the neutral final-synthesis wrapper",
  );
});

test("terminal completed closeout repair gateway input routes through terminal controller", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const hookStart = source.indexOf(
    "await terminalCloseout.handleTerminalCloseoutHook({",
  );
  assert.notEqual(hookStart, -1, "terminal closeout hook handoff must exist");
  const start = source.indexOf("completedCloseoutHook: {", hookStart);
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
  assert.equal(
    source.includes("const model: ModelClient = {"),
    false,
    "engine model client wrapper must not stay inline in the adapter",
  );
  assert.equal(
    source.includes("createRoleEngineModelClient({"),
    true,
    "adapter should create the role-engine model client through the react-engine owner",
  );
  const modelSource = readFileSync(path.join(ENGINE_DIR, "engine-model-client.ts"), "utf8");

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

test("engine model client role-runtime wiring routes through model owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const modelSource = readFileSync(
    path.join(ENGINE_DIR, "engine-model-client.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("createEngineModelClient({"),
    false,
    "engine model client dependency wiring must not stay inline in runEngine",
  );
  assert.equal(
    engineSource.includes("recordPruning: (snapshot) =>"),
    false,
    "engine model pruning callback wiring must live with the model owner",
  );
  assert.equal(
    engineSource.includes("recordToolResultPruningBoundarySafely({"),
    false,
    "engine model pruning boundary recorder call must live with the model owner",
  );
  assert.equal(
    engineSource.includes("createRoleEngineModelClient({"),
    true,
    "runEngine should create role-engine model clients through the owner",
  );
  assert.equal(
    modelSource.includes("recordToolResultPruningBoundarySafely({"),
    true,
    "engine model owner should bind role-runtime pruning boundary recording",
  );
});

test("tool-result pruning boundary recording routes through neutral pruning owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const modelSource = readFileSync(
    path.join(ENGINE_DIR, "engine-model-client.ts"),
    "utf8",
  );

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
    modelSource.includes("recordToolResultPruningBoundarySafely({"),
    true,
    "engine model owner should call the neutral safe pruning boundary recorder",
  );
});

test("request-envelope reduced retry gateway input routes through neutral gateway builder", () => {
  const adapterSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  assert.equal(
    adapterSource.includes("private async generateWithEnvelopeRetry"),
    false,
    "request-envelope retry orchestration must not stay as an adapter-private method",
  );
  const source = readFileSync(GATEWAY_ENVELOPE_RETRY, "utf8");

  assert.equal(
    source.includes("replaceInitialPromptMessages"),
    false,
    "request-envelope retry prompt-message replacement must not stay in the retry owner",
  );
  assert.equal(
    source.includes("deriveToolResultEnvelope"),
    false,
    "request-envelope retry tool-result envelope recomputation must not stay in the retry owner",
  );
  assert.equal(
    source.includes("buildReducedRetryGatewayInput"),
    true,
    "request-envelope retry gateway input construction must route through the neutral gateway builder",
  );
});

test("request-envelope retry orchestration routes through neutral gateway owner", () => {
  const adapterSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    adapterSource.includes("private async generateWithEnvelopeRetry"),
    false,
    "adapter must not keep request-envelope retry orchestration as a private method",
  );
  assert.equal(
    adapterSource.includes("generateWithEnvelopeRetry({"),
    true,
    "adapter should call the neutral request-envelope retry owner",
  );

  const ownerSource = readFileSync(GATEWAY_ENVELOPE_RETRY, "utf8");
  assert.equal(
    ownerSource.includes("buildReducedRetryGatewayInput({"),
    true,
    "request-envelope retry owner should delegate reduced gateway input construction",
  );
});

test("pre-compaction memory flush routes through flusher owner", () => {
  const adapterSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const retrySource = readFileSync(GATEWAY_ENVELOPE_RETRY, "utf8");

  assert.equal(
    adapterSource.includes("private async flushPreCompactionMemorySafely"),
    false,
    "pre-compaction memory flush safety must not stay as an adapter-private method",
  );
  assert.equal(
    adapterSource.includes("flushPreCompactionMemorySafely({"),
    false,
    "adapter should not call the pre-compaction memory owner after retry orchestration moves out",
  );
  assert.equal(
    adapterSource.includes("preCompactionMemoryFlusher: this.preCompactionMemoryFlusher"),
    true,
    "adapter should inject the memory flusher into the request-envelope retry owner",
  );
  assert.equal(
    retrySource.includes("flushPreCompactionMemorySafely({"),
    true,
    "request-envelope retry owner should call the pre-compaction memory owner safe flusher",
  );
});

test("the engine composition root installs typed loop compaction and run journaling", () => {
  const adapterSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");

  assert.equal(
    adapterSource.includes("createCompactionController({"),
    true,
    "engine composition must create the calibrated loop compaction owner",
  );
  assert.equal(
    adapterSource.includes("createRuntimeCheckpointSummarizer({"),
    true,
    "checkpoint compaction must use the tool-free summarizer owner",
  );
  assert.equal(
    adapterSource.includes("onRoundMessages: async (messages, round, hookCtx) =>"),
    true,
    "engine hooks must route pre-model messages through checkpoint compaction",
  );
  assert.equal(
    adapterSource.includes("createRunJournal({"),
    true,
    "engine composition must create the durable round journal owner",
  );
  assert.equal(
    adapterSource.includes("createTaskPlanController()"),
    true,
    "engine composition must install typed task-plan maintenance",
  );
  assert.ok(
    adapterSource.indexOf("compactionController.applyRoundMessagesHook(") <
      adapterSource.indexOf("taskPlanController.applyRoundMessagesHook({") &&
      adapterSource.indexOf("taskPlanController.applyRoundMessagesHook({") <
        adapterSource.indexOf("checkpointRunJournalSafely("),
    "compaction and typed task-plan maintenance must precede the safe journal boundary",
  );
  assert.equal(
    adapterSource.includes("forceCompact: ({ messages, round }) =>"),
    true,
    "request-envelope overflow must route through the same persistent compaction owner",
  );
});

test("request-envelope reduction boundary recording routes through reducer owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const finalResponseSource = readFileSync(
    path.join(ENGINE_DIR, "engine-final-response.ts"),
    "utf8",
  );

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
    finalResponseSource.includes("recordReductionBoundarySafely({"),
    true,
    "engine final-response owner should call the neutral reduction boundary recorder",
  );
});

test("engine request-envelope reduction boundary wiring routes through final response owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runEngine must exist");
  assert.notEqual(end, -1, "runEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const finalResponseSource = readFileSync(
    path.join(ENGINE_DIR, "engine-final-response.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("recordReductionBoundarySafely({"),
    false,
    "engine reduction boundary recorder wiring must not stay in runEngine",
  );
  assert.equal(
    engineSource.includes("const reductionSnapshot = runState.reductionSnapshot();"),
    false,
    "engine reduction snapshot wiring must not stay in runEngine",
  );
  assert.equal(
    engineSource.includes("recordEngineReductionBoundary({"),
    true,
    "runEngine should record reduction boundaries through the final response owner",
  );
  assert.equal(
    finalResponseSource.includes("recordReductionBoundarySafely({"),
    true,
    "engine final response owner should delegate to the neutral reduction recorder",
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
  const observerSource = readFileSync(ENGINE_RUN_OBSERVER, "utf8");

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
    observerSource.includes("recordProviderToolProtocolRoundSafely({"),
    true,
    "engine observer should call the neutral provider protocol boundary recorder",
  );
});

test("runtime tool progress safe recording routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const observerSource = readFileSync(ENGINE_RUN_OBSERVER, "utf8");

  assert.equal(
    source.includes("private async recordToolProgressSafely"),
    false,
    "runtime tool progress safe recording must not stay as an adapter-private method",
  );
  assert.equal(
    observerSource.includes("recordRoleToolProgressSafely({"),
    true,
    "engine observer owner should call the neutral safe runtime tool progress recorder",
  );
});

test("native tool trace persistence routes through native message owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const observerSource = readFileSync(ENGINE_RUN_OBSERVER, "utf8");

  assert.equal(
    source.includes("private async persistNativeToolTraceSafely"),
    false,
    "native tool trace persistence must not stay as an adapter-private method",
  );
  assert.equal(
    observerSource.includes("persistNativeToolTraceSafely({"),
    true,
    "engine observer should call the neutral native tool trace persister",
  );
});

test("runtime tool progress emission routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const observerSource = readFileSync(ENGINE_RUN_OBSERVER, "utf8");
  const toolUseSource = readFileSync(TOOL_USE, "utf8");

  assert.equal(
    source.includes("private async emitToolProgressSafely"),
    false,
    "runtime tool progress emission must not stay as an adapter-private method",
  );
  assert.equal(
    observerSource.includes("recordRoleToolProgressSafely({"),
    true,
    "engine observer should route progress through the neutral recorder",
  );
  assert.equal(
    toolUseSource.includes("emitRoleToolProgressSafely({"),
    true,
    "role tool-call executor should own safe runtime progress emission",
  );
});

test("role tool-call execution routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const toolkitSource = readFileSync(
    path.join(ENGINE_DIR, "engine-role-toolkit.ts"),
    "utf8",
  );

  assert.equal(
    source.includes("private async executeToolCalls"),
    false,
    "role tool-call execution must not stay as an adapter-private method",
  );
  assert.equal(
    toolkitSource.includes("activeToolLoop.executor.execute({"),
    true,
    "engine toolkit owner should delegate calls to the configured role executor",
  );
});

test("forced runtime tool-round orchestration routes through tool-use owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const runnerSource = readFileSync(
    path.join(ENGINE_DIR, "engine-forced-tool-round-runner.ts"),
    "utf8",
  );

  assert.equal(
    source.includes("private async executeRuntimeForcedToolRound"),
    false,
    "forced runtime tool-round orchestration must not stay as an adapter-private method",
  );
  assert.equal(
    runnerSource.includes("executeRuntimeForcedToolRound({"),
    true,
    "engine forced-round owner should call the neutral runtime runner",
  );
});

test("policy modules do not add unregistered regex detector branches", () => {
  const offenders: string[] = [];
  for (const file of activePolicySourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const regex of regexLiteralTexts(source)) {
      offenders.push(`${path.basename(file)}: ${regex}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "new policy regex must move to typed facts or legacy-text-detectors metadata",
  );
});

test("active engine and adapter code do not call core fact helpers", () => {
  const offenders: string[] = [];
  for (const file of coreFactReferenceSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const helper of coreFactHelperReferences(source)) {
      offenders.push(`${path.basename(file)}: ${helper}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `active runtime code must consume typed producers instead of core fact helpers:\n${offenders.join("\n")}`,
  );
});

test("EvidenceLedger does not import tool-loop-shared", () => {
  const source = readFileSync(path.join(ENGINE_DIR, "evidence-ledger.ts"), "utf8");
  assert.equal(
    /from\s+["']\.\.\/tool-loop-shared["']/.test(source),
    false,
    "EvidenceLedger must aggregate runtime-facts producers, not tool-loop-shared text helpers",
  );
});

test("active runtime policy boundary does not import tool-loop-shared", () => {
  const offenders: string[] = [];
  for (const file of activeRuntimeBoundarySourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (/from\s+["'][^"']*tool-loop-shared["']/.test(source)) {
      offenders.push(path.relative(ROLE_RUNTIME_DIR, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `active runtime policy/fact modules must not depend on tool-loop-shared:\n${offenders.join("\n")}`,
  );
});

test("active runtime policy boundary does not use renamed legacy fact shims", () => {
  const offenders: string[] = [];
  for (const file of activeRuntimeBoundarySourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (source.includes("inline-policy-compat")) {
      offenders.push(`${path.relative(ROLE_RUNTIME_DIR, file)}: inline-policy-compat`);
    }
    for (const match of source.matchAll(/\breadLegacy[A-Za-z0-9_]+\b/g)) {
      offenders.push(`${path.relative(ROLE_RUNTIME_DIR, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `active runtime code must consume producer-owned facts, not renamed legacy shims:\n${offenders.join("\n")}`,
  );
});

test("policy-text-facts facade is retired", () => {
  assert.equal(
    existsSync(path.join(RUNTIME_FACTS_DIR, "policy-text-facts.ts")),
    false,
    "runtime-facts/policy-text-facts.ts must not return as an active owner or compatibility facade",
  );
  const offenders: string[] = [];
  for (const file of activeRuntimeBoundarySourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (source.includes("policy-text-facts")) {
      offenders.push(path.relative(ROLE_RUNTIME_DIR, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `active runtime code must import concrete fact/render modules, not policy-text-facts:\n${offenders.join("\n")}`,
  );
});

test("split fact and render modules keep dependency direction", () => {
  const offenders: string[] = [];
  const toolProtocol = path.join(ROLE_RUNTIME_DIR, "tool-protocol.ts");
  for (const ref of importReferencesFrom(
    readFileSync(toolProtocol, "utf8"),
    toolProtocol,
  )) {
    if (
      ref.moduleSpecifier.includes("runtime-facts") ||
      ref.moduleSpecifier.includes("runtime-policy")
    ) {
      offenders.push(`tool-protocol.ts -> ${ref.moduleSpecifier}`);
    }
  }

  for (const rel of [
    "runtime-facts/text-fallback-readers.ts",
    "runtime-facts/repair-marker-facts.ts",
  ]) {
    const file = path.join(ROLE_RUNTIME_DIR, rel);
    const source = readFileSync(file, "utf8");
    for (const ref of importReferencesFrom(source, file)) {
      if (ref.moduleSpecifier.includes("runtime-policy")) {
        offenders.push(`${rel} -> ${ref.moduleSpecifier}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `facts/protocol modules must not depend upward on runtime-policy:\n${offenders.join("\n")}`,
  );
});

test("runtime policy cores import runtime facts as types only", () => {
  const offenders: string[] = [];
  for (const file of runtimePolicyDecisionCoreFiles()) {
    const source = readFileSync(file, "utf8");
    for (const ref of importReferencesFrom(source, file)) {
      if (
        ref.moduleSpecifier.includes("../runtime-facts/") &&
        !ref.isTypeOnly
      ) {
        offenders.push(`${path.basename(file)} -> ${ref.moduleSpecifier}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `runtime-policy/*-core.ts may consume fact shapes only via import type:\n${offenders.join("\n")}`,
  );
});

test("text fallback export budget only shrinks", () => {
  const budget = JSON.parse(
    readFileSync(path.join(ENGINE_DIR, "fact-export-budget.json"), "utf8"),
  ) as Record<string, number>;
  for (const [rel, max] of Object.entries(budget)) {
    const file = path.join(ROLE_RUNTIME_DIR, rel);
    if (!existsSync(file)) continue;
    const count = exportedRuntimeNames(readFileSync(file, "utf8")).length;
    assert.ok(
      count <= max,
      `${rel} exports ${count} > budget ${max}; typed replacements must shrink, never grow`,
    );
  }
});

test("active policy and adapter code do not call task-language detector helpers", () => {
  const offenders: string[] = [];
  for (const file of [
    LLM_RESPONSE_GENERATOR,
    ...ACTIVE_ENGINE_POLICY_FILES.map((name) => path.join(ENGINE_DIR, name)),
    ...runtimePolicyCoreFiles(),
  ]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(TASK_LANGUAGE_HELPER_REFERENCE_PATTERN)) {
      offenders.push(`${path.relative(ROLE_RUNTIME_DIR, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `task-language parsing must go through TaskIntentFacts:\n${offenders.join("\n")}`,
  );
});

test("active policy modules do not receive final-synthesis text views", () => {
  const offenders: string[] = [];
  for (const file of activePolicySourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const field of POLICY_TEXT_VIEW_NAMES) {
      if (source.includes(field)) {
        offenders.push(`${path.basename(file)}: ${field}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `policy modules must not inspect final-synthesis text views:\n${offenders.join("\n")}`,
  );
});

test("tool-loop-shared facade is retired", () => {
  assert.equal(
    existsSync(path.join(ROLE_RUNTIME_DIR, "tool-loop-shared.ts")),
    false,
    "tool-loop-shared.ts must not return as a compatibility facade",
  );
  const offenders: string[] = [];
  for (const file of activeRuntimeBoundarySourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (/from\s+["'][^"']*tool-loop-shared["']/.test(source)) {
      offenders.push(path.relative(ROLE_RUNTIME_DIR, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `active runtime code must import concrete split modules, not tool-loop-shared:\n${offenders.join("\n")}`,
  );
});

test("shared fact source files do not export core Stage 8 fact helpers", () => {
  const offenders: string[] = [];
  for (const file of coreFactExportSourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const name of coreFactHelperExportNames(source)) {
      offenders.push(`${path.basename(file)}: ${name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `shared files must not own core Stage 8 fact helpers:\n${offenders.join("\n")}`,
  );
});

test("core fact helper allowlist entries point at real exports", () => {
  const exports = new Set(
    coreFactExportSourceFiles().flatMap((file) =>
      exportedRuntimeNames(readFileSync(file, "utf8")),
    ),
  );
  const missing = Array.from(CORE_FACT_HELPER_ALLOWLIST).filter(
    (name) => !exports.has(name),
  );
  assert.deepEqual(
    missing,
    [],
    `core fact helper allowlist entries must be real task-facts-shared exports:\n${missing.join("\n")}`,
  );
});

test("active runtime policy is free of acceptance-fixture literals", () => {
  const roots = [
    path.join(PACKAGES_DIR, "role-runtime/src"),
    path.join(PACKAGES_DIR, "app-gateway/src"),
  ];
  const offenders: string[] = [];
  const sourceFiles = roots.flatMap((root) =>
    runtimeProductionSourceFiles(root),
  );
  assert.ok(
    sourceFiles.length > 100,
    `fixture guard must scan the active runtime tree, got ${sourceFiles.length} files`,
  );
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const literal of FORBIDDEN_RUNTIME_FIXTURE_LITERALS) {
      if (source.includes(literal)) {
        offenders.push(
          `${path.relative(PACKAGES_DIR, file)}: ${literal}`,
        );
      }
    }
    const marker = source.match(FORBIDDEN_RUNTIME_FIXTURE_MARKER)?.[0];
    if (marker) {
      offenders.push(`${path.relative(PACKAGES_DIR, file)}: ${marker}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `acceptance fixtures must stay in tests/harnesses, never active runtime policy:\n${offenders.join("\n")}`,
  );
});

test("time authority is task-text independent and cannot restore timeout floors", () => {
  const budgetSource = readFileSync(OPERATION_TIMEOUT_BUDGET, "utf8");
  assert.deepEqual(
    regexLiteralTexts(budgetSource),
    [],
    "operation-timeout-budget.ts must compose numeric bounds only",
  );
  for (const forbidden of ["taskPrompt", "messages", "toolTrace"]) {
    assert.equal(
      budgetSource.includes(forbidden),
      false,
      `operation-timeout-budget.ts must not receive ${forbidden}`,
    );
  }

  const activeTimeSource = [
    TOOL_USE,
    TOOL_PROTOCOL,
    SUB_AGENT_WORKER_HANDLER,
    path.join(ENGINE_DIR, "execution-budget-controller.ts"),
    path.join(ENGINE_DIR, "closeout-policy-registry.ts"),
    path.join(ENGINE_DIR, "tool-call-normalizer.ts"),
  ].map((file) => readFileSync(file, "utf8")).join("\n");
  for (const forbidden of [
    "applyLocalBrowserTaskTimeoutFloors",
    "resolveSlowLoopbackOpenTimeoutMs",
    "requiredTimeoutContinuationPastWallClock",
    'name: "boundedSourceTimeoutBudget"',
    'name: "supplementalLocalTimeoutProbe"',
  ]) {
    assert.equal(
      activeTimeSource.includes(forbidden),
      false,
      `active time authority must not restore ${forbidden}`,
    );
  }
});

test("retired synthetic recovery text cannot control production runtime", () => {
  const sourceFiles = [ROLE_RUNTIME_DIR, TEAM_RUNTIME_DIR].flatMap((root) =>
    runtimeProductionSourceFiles(root),
  );
  const forbidden = [
    "System recovery: the previous final answer did not satisfy required goal slots",
    "Automatic recovery attempt",
    "shouldSuppressMentionDispatchAfterFinalRecoveryBudget",
    "readPolicyForceSlowSourceRecoveryContinuation",
    "resolveRecoveryToolBudgetForActivation",
    "countRecoveryToolCallsBeforeActivation",
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const marker of forbidden) {
      if (source.includes(marker)) {
        offenders.push(`${path.relative(PACKAGES_DIR, file)}: ${marker}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `retired recovery prose must not admit, suppress, continue, or budget production work:\n${offenders.join("\n")}`,
  );
});

test("model mode does not filter caller-approved tools from task text", () => {
  assert.equal(
    existsSync(TOOL_DEFINITION_FILTER),
    false,
    "task-text tool filtering must not return to the standard model loop",
  );
  const generatorSource = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  for (const forbidden of [
    "filterToolDefinitionsForTask",
    "taskRequestsFocusedDurableMemoryRecall",
    "taskAllowsTaskTrackingTools",
  ]) {
    assert.equal(
      generatorSource.includes(forbidden),
      false,
      `model-mode composition must not use semantic tool filter ${forbidden}`,
    );
  }
  assert.match(
    generatorSource,
    /const toolDefinitions = activeToolLoop\s*\? activeToolLoop\.executor\.definitions\(\)\s*: undefined;/,
    "model mode must pass the caller-approved executor definitions through unchanged",
  );
});

test("retired policy characterization cannot be enabled by production composition", () => {
  const allowedOwners = new Set([
    LLM_RESPONSE_GENERATOR,
    path.join(ENGINE_DIR, "tool-call-normalizer.ts"),
  ]);
  const offenders = runtimeProductionSourceFiles(PACKAGES_DIR)
    .filter((file) => !allowedOwners.has(file))
    .filter((file) =>
      readFileSync(file, "utf8").includes("testOnlyCharacterizeRetiredPolicies"),
    )
    .map((file) => path.relative(PACKAGES_DIR, file));
  assert.deepEqual(
    offenders,
    [],
    `only the isolated characterization harness may expose retired policy behavior:\n${offenders.join("\n")}`,
  );
});

test("prompt registry has no dead route, duplicate authority, or missing owner", () => {
  const audit = auditDefaultPromptRegistry();
  assert.equal(audit.valid, true, JSON.stringify(audit));
  assert.deepEqual(audit.unreachableSectionIds, []);
  assert.deepEqual(audit.missingRouteIds, []);
  assert.deepEqual(audit.duplicateAuthorityKeys, []);
  const workspaceRoot = path.dirname(PACKAGES_DIR);
  const missingOwners = DEFAULT_PROMPT_SECTION_DEFINITIONS
    .filter(
      (definition) =>
        !existsSync(path.join(workspaceRoot, definition.owner)),
    )
    .map((definition) => definition.owner);
  assert.deepEqual(
    missingOwners,
    [],
    `prompt registry owners must exist:\n${missingOwners.join("\n")}`,
  );
  assert.match(
    readFileSync(
      path.join(ROLE_RUNTIME_DIR, "prompt", "prompt-assembler.ts"),
      "utf8",
    ),
    /PROMPT_ASSEMBLY_SECTION_IDS/,
  );
  assert.match(
    readFileSync(
      path.join(ROLE_RUNTIME_DIR, "tool-capability-registry.ts"),
      "utf8",
    ),
    /TOOL_PROMPT_GROUP_SECTION_IDS/,
  );
});

function runtimeProductionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "mock" || entry.name === "fixtures") continue;
      files.push(...runtimeProductionSourceFiles(file));
      continue;
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".spec.ts") ||
      entry.name === "mission-demo-fixtures.ts"
    ) {
      continue;
    }
    files.push(file);
  }
  return files;
}

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
const GATEWAY_ENVELOPE_RETRY = path.join(
  ROLE_RUNTIME_DIR,
  "gateway-envelope-retry.ts",
);
const TERMINAL_FINAL_SYNTHESIS = path.join(
  ROLE_RUNTIME_DIR,
  "terminal-final-synthesis.ts",
);
const TOOL_USE = path.join(ROLE_RUNTIME_DIR, "tool-use.ts");
const ENGINE_RUN_OBSERVER = path.join(ENGINE_DIR, "engine-run-observer.ts");

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

test("engine forced runtime tool-round executor wiring routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("executeRuntimeForcedToolRound({"),
    false,
    "engine forced-round execution wiring must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("createRoleEngineRuntimeForcedToolRoundRunner({"),
    true,
    "runViaReActEngine should create role-engine forced-round runners through the react-engine owner",
  );
});

test("engine forced runtime tool-round role wiring routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const runnerSource = readFileSync(
    path.join(ENGINE_DIR, "engine-forced-tool-round-runner.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("createEngineRuntimeForcedToolRoundRunner({"),
    false,
    "engine forced-round role wiring must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("providerRuntimeProgressRecorder:"),
    false,
    "engine forced-round provider-recorder selection must live with the runner owner",
  );
  assert.equal(
    engineSource.includes("createRoleEngineRuntimeForcedToolRoundRunner({"),
    true,
    "runViaReActEngine should create role-engine forced-round runners through the owner",
  );
  assert.equal(
    runnerSource.includes("providerRuntimeProgressRecorder:"),
    true,
    "forced-round runner owner should bind provider protocol recorder selection",
  );
});

test("engine final generated reply assembly routes through final-response owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("buildRuntimeDerivedMissionReport("),
    false,
    "engine final mission report assembly must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("summarizeModelUseTrace("),
    false,
    "engine final model-use summary assembly must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("createEngineFinalResponseBuilder({"),
    true,
    "runViaReActEngine should build final replies through the react-engine owner",
  );
});

test("engine agent event consumption routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("for await (const event of agent.run("),
    false,
    "engine ReAct event consumption must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("createRoleEngineAgentRunner"),
    true,
    "runViaReActEngine should consume ReAct events through the react-engine runner factory",
  );
});

test("engine ReAct agent creation routes through runner owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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
    "engine ReAct agent construction must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("maxRounds: maxRounds + 1"),
    false,
    "engine ReAct agent boundary-round adjustment must live with the runner owner",
  );
  assert.equal(
    engineSource.includes("createRoleEngineAgentRunner"),
    true,
    "runViaReActEngine should create the ReAct runner through the react-engine owner",
  );
  assert.equal(
    runnerSource.includes("createReActAgent"),
    true,
    "engine agent runner owner should bind the agent-core factory",
  );
});

test("engine role toolkit wiring routes through toolkit owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("const toolkit: Toolkit<RoleToolContext>"),
    false,
    "engine role toolkit construction must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("createEngineRoleToolkit({"),
    true,
    "runViaReActEngine should create the ReAct toolkit through the react-engine owner",
  );
});

test("engine onToolCalls hook routes through tool-call normalizer owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const normalizerSource = readFileSync(
    path.join(ENGINE_DIR, "tool-call-normalizer.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("buildToolCallNormalizationContext({"),
    false,
    "engine onToolCalls normalization context construction must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("normalizeEngineToolCalls("),
    false,
    "engine onToolCalls normalizer invocation must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("truncateForRecoveryBudget({"),
    false,
    "engine onToolCalls recovery-budget truncation must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("applyEngineToolCallsHook({"),
    true,
    "runViaReActEngine should delegate onToolCalls to the normalizer owner",
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
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const budgetSource = readFileSync(
    path.join(ENGINE_DIR, "execution-budget-controller.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("limitToolCallsPerRound({"),
    false,
    "engine onBeforeExecute admission must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("runToolBatch<RoleToolContext>({"),
    false,
    "engine runToolBatch hook wiring must not stay inline in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("applyEngineBeforeExecuteHook({"),
    true,
    "runViaReActEngine should delegate onBeforeExecute to the execution-budget owner",
  );
  assert.equal(
    engineSource.includes("runEngineToolBatchHook({"),
    true,
    "runViaReActEngine should delegate runToolBatch to the execution-budget owner",
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
});

test("engine pending-call closeout hook routes through closeout-policy owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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
    "runViaReActEngine should delegate onToolCallsClose to the closeout-policy owner",
  );
  assert.equal(
    registrySource.includes("applyPendingCallsCloseout("),
    true,
    "closeout-policy owner should keep generic pending-closeout application",
  );
});

test("engine lightweight hook entrypoints route through their owners", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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
    "post-execute generic closeout application must not stay inline in runViaReActEngine",
  );
  assert.equal(
    afterExecuteSource.includes("applyPostExecuteCloseoutHook("),
    true,
    "onAfterExecute should delegate hook flow to CloseoutPolicyRegistry",
  );
  assert.equal(
    roundEmptySource.includes("const action = continuation.onRoundEmpty({"),
    false,
    "round-empty action selection must not stay inline in runViaReActEngine",
  );
  assert.equal(
    roundEmptySource.includes("applyRoundEmptyAction(action)"),
    false,
    "round-empty action application must not stay inline in runViaReActEngine",
  );
  assert.equal(
    roundEmptySource.includes("applyRoundEmptyHook({"),
    true,
    "onRoundEmpty should delegate action selection/application to ContinuationController",
  );
});

test("engine natural-finish repair hook routes through repair-policy owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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
    "natural-finish repair application must not stay inline in runViaReActEngine",
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
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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

test("engine terminal synthesis callbacks route through terminal closeout owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
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

test("engine run-state role value typing routes through run-state owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("type RoleEngineRunStateValues"),
    false,
    "role-engine run-state value typing must not stay local to runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("createRoleEngineRunState()"),
    true,
    "runViaReActEngine should create typed role-engine run state through the owner",
  );
});

test("engine run observer wiring routes through observer owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);

  assert.equal(
    engineSource.includes("createEngineRunObserver(toolTrace, {"),
    false,
    "engine run observer dependency wiring must not stay inline in runViaReActEngine",
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
    "runViaReActEngine should create observers through the react-engine owner",
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
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const modelSource = readFileSync(
    path.join(ENGINE_DIR, "engine-model-client.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("createEngineModelClient({"),
    false,
    "engine model client dependency wiring must not stay inline in runViaReActEngine",
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
    "runViaReActEngine should create role-engine model clients through the owner",
  );
  assert.equal(
    modelSource.includes("recordToolResultPruningBoundarySafely({"),
    true,
    "engine model owner should bind role-runtime pruning boundary recording",
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

test("engine request-envelope reduction boundary wiring routes through final response owner", () => {
  const source = readFileSync(LLM_RESPONSE_GENERATOR, "utf8");
  const start = source.indexOf("private async runViaReActEngine");
  const end = source.indexOf("\n}\n\n// ORDER_DEPENDENT_TOOL_NAMES", start);
  assert.notEqual(start, -1, "runViaReActEngine must exist");
  assert.notEqual(end, -1, "runViaReActEngine boundary must be found");
  const engineSource = source.slice(start, end);
  const finalResponseSource = readFileSync(
    path.join(ENGINE_DIR, "engine-final-response.ts"),
    "utf8",
  );

  assert.equal(
    engineSource.includes("recordReductionBoundarySafely({"),
    false,
    "engine reduction boundary recorder wiring must not stay in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("const reductionSnapshot = runState.reductionSnapshot();"),
    false,
    "engine reduction snapshot wiring must not stay in runViaReActEngine",
  );
  assert.equal(
    engineSource.includes("recordEngineReductionBoundary({"),
    true,
    "runViaReActEngine should record reduction boundaries through the final response owner",
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

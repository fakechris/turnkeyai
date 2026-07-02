// Stage 8 engine cleanup (Batch 0.5) — hook orchestration wiring guard.
//
// The per-module registries (normalizer order, closeout order, repair order) are
// not enough on their own: the adapter's CROSS-MODULE call order inside each
// agent-core hook is also behavior (plan "Hook Orchestration Contract"). This test
// pins that order two ways:
//
//   1. A spy-module harness: each module op appends its `Module.method` id into an
//      EnginePolicyTrace. An orchestrator driven from ENGINE_HOOK_ORCHESTRATION
//      records the contract order; a deliberately-wrong-order driver must FAIL.
//      This is the guard the later batches keep green: it fails if a future batch
//      wires real modules in the wrong order even when every registry array is
//      individually correct.
//
//   2. A boundary-wrapper characterization: traceEngineHooks wraps a minimal fake
//      ReActHooks and must record one entry per installed hook, in hook-firing
//      order, with outcomes derived from each hook's real (unchanged) return value.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_HOOK_ORCHESTRATION,
  ENGINE_INSTALLED_HOOK_ORDER,
  engineHookContract,
} from "./hook-orchestration-contract";
import { createEnginePolicyTrace, NOOP_ENGINE_POLICY_TRACE } from "./policy-trace";
import { traceEngineHooks } from "./hook-policy-trace";
import type { EnginePolicyTrace } from "./types";

// ---------------------------------------------------------------------------
// Part 1: spy-module orchestration order guard.
// ---------------------------------------------------------------------------

/**
 * A spy module op: invoking it appends its `Module.method` id into the trace as a
 * "matched" entry. This is the stub the plan asks for — modules that append their
 * policy ids into EnginePolicyTrace so wrong call order is detectable.
 */
function spyOp(trace: EnginePolicyTrace, moduleOp: string): void {
  trace.record({
    phase: "tool_calls",
    policyId: moduleOp,
    outcome: "matched",
    reason: `spy:${moduleOp}`,
  });
}

/**
 * Drive every installed hook's module ops in the given per-hook order, recording
 * each op into the trace. `orderOverride` lets a negative test inject a
 * wrong-order sequence for one hook.
 */
function driveOrchestration(
  trace: EnginePolicyTrace,
  orderOverride?: { hook: string; moduleOps: readonly string[] },
): void {
  for (const entry of ENGINE_HOOK_ORCHESTRATION) {
    if (!entry.installed) continue;
    const ops =
      orderOverride && orderOverride.hook === entry.hook
        ? orderOverride.moduleOps
        : entry.moduleOps;
    for (const op of ops) spyOp(trace, op);
  }
}

/** The flat contract order: every installed hook's module ops, in table order. */
function contractModuleOpOrder(): string[] {
  const ops: string[] = [];
  for (const entry of ENGINE_HOOK_ORCHESTRATION) {
    if (!entry.installed) continue;
    ops.push(...entry.moduleOps);
  }
  return ops;
}

test("wiring guard: spy modules recorded in the contract order pass", () => {
  const trace = createEnginePolicyTrace();
  driveOrchestration(trace);
  const recorded = trace.snapshot().map((e) => e.policyId);
  assert.deepEqual(recorded, contractModuleOpOrder());
});

test("wiring guard: wrong cross-module order inside a hook FAILS", () => {
  // onAfterExecuteContinue's first boundary must be observability before the
  // ordered continuation cascade. Swapping it after the first continuation
  // operation is a behavior change because provider protocol recording belongs
  // before continuation/closeout decisions consume the just-finished round.
  const contract = engineHookContract("onAfterExecuteContinue");
  assert.ok(contract);
  const wrong = [
    "ContinuationController.continueApprovedBrowserTimeout",
    "EngineRunObserver.onProviderToolProtocolRound",
    "ContinuationController.continueSiblingTimeout",
    "ContinuationController.runGeneralSupplementalTimeoutProbe",
    "ContinuationController.runSupplementalCompletedProbe",
    "ContinuationController.continueIncompleteApprovedBrowser",
    "ContinuationController.continueIndependentEvidenceStreams",
    "RepairPolicyRegistry.repairPostExecuteMissingApprovalGate",
    "ContinuationController.runForcedPermissionResultRound",
  ];
  // Sanity: the wrong order is genuinely a reordering of the real contract ops.
  assert.notDeepEqual(wrong, contract!.moduleOps);
  assert.deepEqual([...wrong].sort(), [...contract!.moduleOps].sort());

  const trace = createEnginePolicyTrace();
  driveOrchestration(trace, { hook: "onAfterExecuteContinue", moduleOps: wrong });
  const recorded = trace.snapshot().map((e) => e.policyId);
  assert.notDeepEqual(
    recorded,
    contractModuleOpOrder(),
    "a wrong cross-module order inside a hook must be detectable by the trace",
  );
});

test("wiring guard: onAfterExecuteContinue completed-session branch order is pinned", () => {
  const contract = engineHookContract("onAfterExecuteContinue");
  assert.ok(contract);
  // The observer boundary must be first; the forced permission-result round last.
  assert.equal(
    contract!.moduleOps[0],
    "EngineRunObserver.onProviderToolProtocolRound",
  );
  assert.equal(
    contract!.moduleOps[contract!.moduleOps.length - 1],
    "ContinuationController.runForcedPermissionResultRound",
  );
  // Missing-approval-gate repair must precede the forced permission-result round.
  const repairIdx = contract!.moduleOps.indexOf(
    "RepairPolicyRegistry.repairPostExecuteMissingApprovalGate",
  );
  const forcedIdx = contract!.moduleOps.indexOf(
    "ContinuationController.runForcedPermissionResultRound",
  );
  assert.ok(repairIdx >= 0 && forcedIdx >= 0 && repairIdx < forcedIdx);
});

test("wiring guard: onToolCallsClose delegates to one pending-call closeout entrypoint", () => {
  const contract = engineHookContract("onToolCallsClose");
  assert.ok(contract);
  assert.deepEqual(contract!.moduleOps, [
    "CloseoutPolicyRegistry.applyPendingCallsCloseout",
  ]);
});

// ---------------------------------------------------------------------------
// Part 2: boundary-wrapper characterization (the real adapter mechanism).
// ---------------------------------------------------------------------------

/** A minimal fake ctx/state; the boundary wrapper never inspects their content. */
const fakeState = { round: 0, messages: [], lastText: "" } as never;
const fakeCtx = { repairMarkers: [] } as never;

test("traceEngineHooks records one entry per installed hook, in fire order", async () => {
  const trace = createEnginePolicyTrace();
  // A fake hooks object exercising representative outcomes.
  const hooks = traceEngineHooks(
    {
      onToolCalls: (calls) => calls,
      onSuppressToolCalls: () => null,
      onToolCallsClose: () => "wall_clock_budget",
      onBeforeExecute: (calls) => ({ executable: calls, rejected: [] }),
      runToolBatch: async () => [],
      onAfterExecuteContinue: async () => null,
      onAfterExecute: () => "completed_sub_agent_final",
      onRoundEmpty: () => "terminate",
      onRepairRound: () => null,
      onTerminate: async () => ({ text: "done" }) as never,
      onModelCallError: async () => "rethrow" as const,
      onFinalize: (text) => text,
    },
    trace,
  );

  // Fire the hooks in agent-core loop order.
  hooks.onToolCalls!([], fakeState, fakeCtx);
  hooks.onSuppressToolCalls!([], fakeState, fakeCtx);
  hooks.onToolCallsClose!([], fakeState, fakeCtx);
  hooks.onBeforeExecute!([], fakeCtx);
  await hooks.runToolBatch!([], async () => ({}) as never, fakeCtx);
  await hooks.onAfterExecuteContinue!([], fakeState, fakeCtx);
  hooks.onAfterExecute!([], fakeState, fakeCtx);
  hooks.onRoundEmpty!(fakeState, fakeCtx);
  hooks.onRepairRound!(fakeState, fakeCtx);
  await hooks.onTerminate!("round_limit", fakeState, fakeCtx);
  await hooks.onModelCallError!(new Error("boom"), fakeState, fakeCtx);
  hooks.onFinalize!("text", fakeState, fakeCtx);

  const entries = trace.snapshot();
  // onFinalize is intentionally not traced; every other installed hook records once.
  const tracedHooks = ENGINE_INSTALLED_HOOK_ORDER.filter((h) => h !== "onFinalize");
  assert.equal(entries.length, tracedHooks.length);

  // Phases follow the contract per hook, in the fire order above.
  assert.deepEqual(
    entries.map((e) => e.phase),
    [
      "tool_calls", // onToolCalls
      "tool_calls", // onSuppressToolCalls
      "tool_calls", // onToolCallsClose
      "before_execute", // onBeforeExecute
      "before_execute", // runToolBatch
      "after_execute_continue", // onAfterExecuteContinue
      "after_execute", // onAfterExecute
      "round_empty", // onRoundEmpty
      "repair_round", // onRepairRound
      "terminate", // onTerminate
      "terminate", // onModelCallError
    ],
  );

  // Outcome discriminants derived from the fake return values.
  const byPolicy = new Map(entries.map((e) => [e.policyId, e]));
  assert.equal(byPolicy.get("onToolCallsClose:wall_clock_budget")?.outcome, "matched");
  assert.equal(byPolicy.get("onAfterExecute:completed_sub_agent_final")?.outcome, "matched");
  assert.equal(byPolicy.get("onSuppressToolCalls")?.outcome, "skipped");
  assert.equal(byPolicy.get("onRoundEmpty:terminate")?.outcome, "skipped");
  assert.equal(byPolicy.get("onModelCallError:rethrow")?.outcome, "matched");
});

test("traceEngineHooks returns each hook's real result unchanged (behavior-neutral)", async () => {
  const sentinelCalls = [{ id: "1", name: "x", input: {} }] as never;
  const suppress = { messages: [], forceToolChoice: "none" } as never;
  const hooks = traceEngineHooks(
    {
      onToolCalls: () => sentinelCalls,
      onSuppressToolCalls: () => suppress,
      onToolCallsClose: () => "round_limit",
      onAfterExecute: () => null,
      onRoundEmpty: () => ({ injectedCalls: sentinelCalls }) as never,
      onRepairRound: () => ({ closeout: "tool_evidence_fallback" }) as never,
    },
    createEnginePolicyTrace(),
  );

  assert.equal(hooks.onToolCalls!([], fakeState, fakeCtx), sentinelCalls);
  assert.equal(hooks.onSuppressToolCalls!([], fakeState, fakeCtx), suppress);
  assert.equal(hooks.onToolCallsClose!([], fakeState, fakeCtx), "round_limit");
  assert.equal(hooks.onAfterExecute!([], fakeState, fakeCtx), null);
});

test("traceEngineHooks with NOOP trace does not throw and records nothing", () => {
  const hooks = traceEngineHooks(
    { onToolCalls: (calls) => calls },
    NOOP_ENGINE_POLICY_TRACE,
  );
  assert.deepEqual(hooks.onToolCalls!([], fakeState, fakeCtx), []);
  assert.deepEqual(NOOP_ENGINE_POLICY_TRACE.snapshot(), []);
});

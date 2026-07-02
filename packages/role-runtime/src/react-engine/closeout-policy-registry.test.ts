import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionBudgetCloseoutSnapshot } from "./execution-budget-controller";
import {
  createCloseoutPolicyRegistry,
  ENGINE_CLOSEOUT_POLICY_ORDER,
} from "./closeout-policy-registry";

function recoverySnapshot(): ExecutionBudgetCloseoutSnapshot {
  return {
    reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
    closeout: {
      reason: "recovery_tool_budget",
      maxRounds: 3,
      pendingToolCallCount: 1,
      toolCallCount: 2,
      roundCount: 2,
      evidenceAvailable: false,
    },
  };
}

test("ENGINE_CLOSEOUT_POLICY_ORDER pins terminal closeout precedence", () => {
  assert.deepEqual([...ENGINE_CLOSEOUT_POLICY_ORDER], [
    "recovery_tool_budget",
    "operator_cancelled",
    "pseudo_tool_call",
    "wall_clock_budget",
    "round_limit",
    "repeated_tool_failure",
    "repeated_session_inspection",
    "excessive_session_continuation",
    "sub_agent_timeout",
    "completed_sub_agent_final",
    "tool_evidence_fallback",
    "model_error",
  ]);
  assert.equal(
    new Set(ENGINE_CLOSEOUT_POLICY_ORDER).size,
    ENGINE_CLOSEOUT_POLICY_ORDER.length,
  );
});

test("CloseoutPolicyRegistry returns null before recovery budget is exhausted", () => {
  const registry = createCloseoutPolicyRegistry();
  let builtSnapshot = false;

  const decision = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 3 },
    usedToolCalls: 2,
    pendingToolCallCount: 1,
    messages: [],
    repairMarkers: [],
    resultText: "still running",
    buildCloseoutSnapshot: () => {
      builtSnapshot = true;
      return recoverySnapshot();
    },
  });

  assert.equal(decision, null);
  assert.equal(builtSnapshot, false);
});

test("CloseoutPolicyRegistry defers exhausted recovery budget to repair when needed", () => {
  const registry = createCloseoutPolicyRegistry();
  let builtSnapshot = false;

  const decision = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 2 },
    usedToolCalls: 2,
    pendingToolCallCount: 0,
    messages: [],
    repairMarkers: [],
    resultText: "@{role-explore} continue the recovery",
    buildCloseoutSnapshot: () => {
      builtSnapshot = true;
      return recoverySnapshot();
    },
  });

  assert.deepEqual(decision, {
    kind: "defer",
    policyId: "recovery_tool_budget",
    deferTo: "repair_round",
    reason: "final_recovery_budget_closeout_repair",
  });
  assert.equal(builtSnapshot, false);
});

test("CloseoutPolicyRegistry returns exhausted recovery budget closeout decision", () => {
  const registry = createCloseoutPolicyRegistry();
  let builtSnapshot = 0;

  const decision = registry.evaluateRecoveryToolBudget({
    recoveryToolBudget: { maxToolCalls: 2 },
    usedToolCalls: 2,
    pendingToolCallCount: 1,
    messages: [],
    repairMarkers: [],
    resultText: "blocked: source remains unverified",
    buildCloseoutSnapshot: () => {
      builtSnapshot += 1;
      return recoverySnapshot();
    },
  });

  assert.equal(builtSnapshot, 1);
  assert.deepEqual(decision, {
    kind: "closeout",
    policyId: "recovery_tool_budget",
    reason: "recovery_tool_budget",
    reasonLines: ["Final recovery tool budget reached (2 tool calls)."],
    closeout: recoverySnapshot().closeout,
  });
});

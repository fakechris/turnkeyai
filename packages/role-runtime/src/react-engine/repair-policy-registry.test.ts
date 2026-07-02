import assert from "node:assert/strict";
import test from "node:test";

import {
  createRepairPolicyRegistry,
  ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER,
} from "./repair-policy-registry";

test("ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER pins extracted repair precedence", () => {
  assert.deepEqual([...ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER], [
    "final_recovery_budget_closeout_repair",
  ]);
});

test("RepairPolicyRegistry skips final-recovery repair before budget is exhausted", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      finalRecoveryBudget: { maxToolCalls: 3, usedToolCalls: 2 },
      messages: [],
      repairMarkers: [],
      resultText: "@{role-explore} continue",
    }),
    null,
  );
});

test("RepairPolicyRegistry returns final-recovery budget repair decision", () => {
  const registry = createRepairPolicyRegistry();

  const decision = registry.evaluateNaturalFinish({
    finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
    messages: [],
    repairMarkers: [],
    resultText: "@{role-explore} continue",
  });

  assert.equal(decision?.kind, "resynthesize");
  assert.equal(decision?.policyId, "final_recovery_budget_closeout_repair");
  assert.equal(decision?.evidenceFormula, "candidate_final");
  assert.equal(decision?.forceToolChoice, "none");
  assert.equal(decision?.consumesRound, undefined);
  assert.match(
    decision?.repairPrompt ?? "",
    /final recovery tool budget is exhausted/i,
  );
  assert.match(decision?.repairPrompt ?? "", /2 tool calls/);
});

test("RepairPolicyRegistry does not repeat final-recovery repair after marker", () => {
  const registry = createRepairPolicyRegistry();

  const first = registry.evaluateNaturalFinish({
    finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
    messages: [],
    repairMarkers: [],
    resultText: "@{role-explore} continue",
  });
  assert.ok(first);

  assert.equal(
    registry.evaluateNaturalFinish({
      finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
      messages: [],
      repairMarkers: [{ role: "user", content: first.repairPrompt }],
      resultText: "@{role-explore} continue",
    }),
    null,
  );
});

test("RepairPolicyRegistry skips final-recovery repair for already bounded closeout", () => {
  const registry = createRepairPolicyRegistry();

  assert.equal(
    registry.evaluateNaturalFinish({
      finalRecoveryBudget: { maxToolCalls: 2, usedToolCalls: 2 },
      messages: [],
      repairMarkers: [],
      resultText: "Blocked: remaining provider pricing is 未验证.",
    }),
    null,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { selectRecoveryToolBudgetCloseoutPolicy } from "./closeout-policy-core";

test("closeout core skips recovery budget policy before budget is exceeded", () => {
  const decision = selectRecoveryToolBudgetCloseoutPolicy({
    budgetExceeded: false,
    facts: { deferToRepairRound: true },
  });

  assert.equal(decision.kind, "none");
});

test("closeout core defers recovery budget closeout to repair round when fact says so", () => {
  const decision = selectRecoveryToolBudgetCloseoutPolicy({
    budgetExceeded: true,
    facts: { deferToRepairRound: true },
  });

  assert.equal(decision.kind, "defer");
  assert.equal(decision.reasonCode, "final_recovery_budget_closeout_repair");
});

test("closeout core selects recovery budget closeout when no repair defer applies", () => {
  const decision = selectRecoveryToolBudgetCloseoutPolicy({
    budgetExceeded: true,
    facts: { deferToRepairRound: false },
  });

  assert.equal(decision.kind, "closeout");
  assert.equal(decision.policyId, "recovery_tool_budget");
});

import type { RecoveryToolBudgetCloseoutFacts } from "../runtime-facts/closeout-policy-facts";
import type { RuntimeCloseoutDecision } from "./types";

export interface SelectRecoveryToolBudgetCloseoutInput {
  budgetExceeded: boolean;
  facts: RecoveryToolBudgetCloseoutFacts;
}

export function selectRecoveryToolBudgetCloseoutPolicy(
  input: SelectRecoveryToolBudgetCloseoutInput,
): RuntimeCloseoutDecision {
  if (!input.budgetExceeded) {
    return {
      kind: "none",
      policyId: "none",
      reasonCode: "recovery_budget_not_exceeded",
      render: null,
    };
  }
  if (input.facts.deferToRepairRound) {
    return {
      kind: "defer",
      policyId: "recovery_tool_budget",
      reasonCode: "final_recovery_budget_closeout_repair",
      render: null,
    };
  }
  return {
    kind: "closeout",
    policyId: "recovery_tool_budget",
    reasonCode: "recovery_tool_budget",
    reason: "recovery_tool_budget",
    render: null,
  };
}

// Stage 8 engine cleanup — RepairPolicyRegistry.
//
// Authority: own candidate-answer repair rules, order, evidence formulas, and
// markers. Each extracted repair returns a typed decision; the adapter applies
// that decision to the ReAct hook by appending messages/markers. This module
// does not execute tools, record progress, synthesize answers, or perform final
// visibility appenders.
import {
  buildFinalRecoveryBudgetCloseoutRepairPrompt,
  shouldRepairFinalRecoveryBudgetCloseout,
} from "../tool-loop-shared";
import type { LLMMessage, ReActToolChoice } from "./types";

export const REPAIR_POLICY_REGISTRY_MODULE = "repair-policy-registry" as const;

export const ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER = [
  "final_recovery_budget_closeout_repair",
] as const;

export type EngineNaturalFinishRepairPolicyId =
  (typeof ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER)[number];

export interface FinalRecoveryBudgetRepairSignal {
  maxToolCalls: number;
  usedToolCalls: number;
}

export interface NaturalFinishRepairInput {
  finalRecoveryBudget: FinalRecoveryBudgetRepairSignal | null;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}

export type NaturalFinishRepairDecision =
  | {
      kind: "resynthesize";
      policyId: "final_recovery_budget_closeout_repair";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: ReActToolChoice;
      consumesRound?: false;
    };

export interface RepairPolicyRegistry {
  evaluateNaturalFinish(
    input: NaturalFinishRepairInput,
  ): NaturalFinishRepairDecision | null;
}

class DefaultRepairPolicyRegistry implements RepairPolicyRegistry {
  evaluateNaturalFinish(
    input: NaturalFinishRepairInput,
  ): NaturalFinishRepairDecision | null {
    const budget = input.finalRecoveryBudget;
    if (!budget || budget.usedToolCalls < budget.maxToolCalls) {
      return null;
    }
    if (
      !shouldRepairFinalRecoveryBudgetCloseout({
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.resultText,
      })
    ) {
      return null;
    }
    return {
      kind: "resynthesize",
      policyId: "final_recovery_budget_closeout_repair",
      evidenceFormula: "candidate_final",
      repairPrompt: buildFinalRecoveryBudgetCloseoutRepairPrompt(
        budget.maxToolCalls,
      ),
      forceToolChoice: "none",
    };
  }
}

export function createRepairPolicyRegistry(): RepairPolicyRegistry {
  return new DefaultRepairPolicyRegistry();
}

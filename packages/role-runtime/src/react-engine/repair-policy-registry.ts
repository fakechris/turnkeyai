// Stage 8 engine cleanup — RepairPolicyRegistry.
//
// Authority: own candidate-answer repair rules, order, evidence formulas, and
// markers. Each extracted repair returns a typed decision; the adapter applies
// that decision to the ReAct hook by appending messages/markers. This module
// does not execute tools, record progress, synthesize answers, or perform final
// visibility appenders.
import {
  buildFinalRecoveryBudgetCloseoutRepairPrompt,
  buildMissingApprovalGateRepairPrompt,
  shouldRepairFinalRecoveryBudgetCloseout,
  shouldRepairMissingApprovalGate,
} from "../tool-loop-shared";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { LLMMessage, ReActToolChoice } from "./types";

export const REPAIR_POLICY_REGISTRY_MODULE = "repair-policy-registry" as const;

export const ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER = [
  "final_recovery_budget_closeout_repair",
  "missing_approval_gate",
] as const;

export type EngineNaturalFinishRepairPolicyId =
  (typeof ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER)[number];

export interface FinalRecoveryBudgetRepairSignal {
  maxToolCalls: number;
  usedToolCalls: number;
}

export interface NaturalFinishRepairInput {
  enabledPolicies?: readonly EngineNaturalFinishRepairPolicyId[];
  finalRecoveryBudget: FinalRecoveryBudgetRepairSignal | null;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
  taskPrompt?: string;
  toolTrace?: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}

export type NaturalFinishRepairDecision =
  | {
      kind: "resynthesize";
      policyId: "final_recovery_budget_closeout_repair";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: ReActToolChoice;
      consumesRound?: false;
    }
  | {
      kind: "force_tool_round";
      policyId: "missing_approval_gate";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: { name: "permission_query" };
      consumesRound: true;
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
    for (const policyId of ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER) {
      if (!isPolicyEnabled(input, policyId)) {
        continue;
      }
      switch (policyId) {
        case "final_recovery_budget_closeout_repair": {
          const decision = evaluateFinalRecoveryBudgetCloseoutRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "missing_approval_gate": {
          const decision = evaluateMissingApprovalGateRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
      }
    }
    return null;
  }
}

function isPolicyEnabled(
  input: NaturalFinishRepairInput,
  policyId: EngineNaturalFinishRepairPolicyId,
): boolean {
  return !input.enabledPolicies || input.enabledPolicies.includes(policyId);
}

function evaluateFinalRecoveryBudgetCloseoutRepair(
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

function evaluateMissingApprovalGateRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairMissingApprovalGate({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    })
  ) {
    return null;
  }
  return {
    kind: "force_tool_round",
    policyId: "missing_approval_gate",
    evidenceFormula: "candidate_final",
    repairPrompt: buildMissingApprovalGateRepairPrompt(),
    forceToolChoice: { name: "permission_query" },
    consumesRound: true,
  };
}

export function createRepairPolicyRegistry(): RepairPolicyRegistry {
  return new DefaultRepairPolicyRegistry();
}

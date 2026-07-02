// Stage 8 engine cleanup — RepairPolicyRegistry.
//
// Authority: own candidate-answer repair rules, order, evidence formulas, and
// markers. Each extracted repair returns a typed decision; the adapter applies
// that decision to the ReAct hook by appending messages/markers. This module
// does not execute tools, record progress, synthesize answers, or perform final
// visibility appenders.
import {
  buildApprovalWaitTimeoutCloseoutRepairPrompt,
  buildFinalRecoveryBudgetCloseoutRepairPrompt,
  buildMissingApprovalGateRepairPrompt,
  buildPendingApprovalWaitTimeoutCheckRepairPrompt,
  buildPrematurePendingApprovalRepairPrompt,
  buildStaleDeniedApprovalRepairPrompt,
  buildStalePendingApprovalRepairPrompt,
  shouldRepairFinalRecoveryBudgetCloseout,
  shouldRepairMissingApprovalGate,
  shouldRepairPendingApprovalWaitTimeoutCheck,
  shouldRepairPrematurePendingApprovalFinal,
  shouldRepairStaleDeniedApproval,
  shouldRepairStalePendingApproval,
  shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair,
  shouldRepairApprovalWaitTimeoutCloseout,
} from "../tool-loop-shared";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { LLMMessage, ReActToolChoice } from "./types";

export const REPAIR_POLICY_REGISTRY_MODULE = "repair-policy-registry" as const;

export const ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER = [
  "final_recovery_budget_closeout_repair",
  "missing_approval_gate",
  "pending_approval_wait_timeout_check",
  "premature_pending_approval",
  "stale_pending_approval",
  "stale_denied_approval",
  "approval_wait_timeout_closeout",
  "approval_wait_timeout_local_closeout",
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
    }
  | {
      kind: "force_tool_round";
      policyId: "pending_approval_wait_timeout_check";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: { name: "permission_result" };
      consumesRound: true;
    }
  | {
      kind: "force_tool_round";
      policyId: "premature_pending_approval";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: { name: "permission_result" };
      consumesRound: true;
    }
  | {
      kind: "force_tool_round";
      policyId: "stale_pending_approval";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: { name: "sessions_spawn" };
      consumesRound: true;
    }
  | {
      kind: "resynthesize";
      policyId: "stale_denied_approval";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: "none";
      consumesRound?: false;
    }
  | {
      kind: "resynthesize";
      policyId: "approval_wait_timeout_closeout";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: "none";
      consumesRound?: false;
    }
  | {
      kind: "closeout";
      policyId: "approval_wait_timeout_local_closeout";
      evidenceFormula: "candidate_final";
      closeoutReason: "tool_evidence_fallback";
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
        case "pending_approval_wait_timeout_check": {
          const decision =
            evaluatePendingApprovalWaitTimeoutCheckRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "premature_pending_approval": {
          const decision = evaluatePrematurePendingApprovalRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "stale_pending_approval": {
          const decision = evaluateStalePendingApprovalRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "stale_denied_approval": {
          const decision = evaluateStaleDeniedApprovalRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "approval_wait_timeout_closeout": {
          const decision = evaluateApprovalWaitTimeoutCloseoutRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "approval_wait_timeout_local_closeout": {
          const decision =
            evaluateApprovalWaitTimeoutLocalCloseout(input);
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

function evaluatePendingApprovalWaitTimeoutCheckRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairPendingApprovalWaitTimeoutCheck({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
    })
  ) {
    return null;
  }
  return {
    kind: "force_tool_round",
    policyId: "pending_approval_wait_timeout_check",
    evidenceFormula: "candidate_final",
    repairPrompt: buildPendingApprovalWaitTimeoutCheckRepairPrompt(),
    forceToolChoice: { name: "permission_result" },
    consumesRound: true,
  };
}

function evaluatePrematurePendingApprovalRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairPrematurePendingApprovalFinal({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
    })
  ) {
    return null;
  }
  return {
    kind: "force_tool_round",
    policyId: "premature_pending_approval",
    evidenceFormula: "candidate_final",
    repairPrompt: buildPrematurePendingApprovalRepairPrompt(),
    forceToolChoice: { name: "permission_result" },
    consumesRound: true,
  };
}

function evaluateStalePendingApprovalRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairStalePendingApproval({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
    })
  ) {
    return null;
  }
  return {
    kind: "force_tool_round",
    policyId: "stale_pending_approval",
    evidenceFormula: "candidate_final",
    repairPrompt: buildStalePendingApprovalRepairPrompt(),
    forceToolChoice: { name: "sessions_spawn" },
    consumesRound: true,
  };
}

function evaluateStaleDeniedApprovalRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairStaleDeniedApproval({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "stale_denied_approval",
    evidenceFormula: "candidate_final",
    repairPrompt: buildStaleDeniedApprovalRepairPrompt(),
    forceToolChoice: "none",
  };
}

function evaluateApprovalWaitTimeoutCloseoutRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairApprovalWaitTimeoutCloseout({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "approval_wait_timeout_closeout",
    evidenceFormula: "candidate_final",
    repairPrompt: buildApprovalWaitTimeoutCloseoutRepairPrompt(),
    forceToolChoice: "none",
  };
}

function evaluateApprovalWaitTimeoutLocalCloseout(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
    })
  ) {
    return null;
  }
  return {
    kind: "closeout",
    policyId: "approval_wait_timeout_local_closeout",
    evidenceFormula: "candidate_final",
    closeoutReason: "tool_evidence_fallback",
  };
}

export function createRepairPolicyRegistry(): RepairPolicyRegistry {
  return new DefaultRepairPolicyRegistry();
}

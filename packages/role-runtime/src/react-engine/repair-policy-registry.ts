// Stage 8 engine cleanup — RepairPolicyRegistry.
//
// Authority: own candidate-answer repair rules, order, evidence formulas, and
// markers. Each extracted repair returns a typed decision and owns the
// behavior-neutral ReAct hook application shape. This module does not execute
// tools, record progress, synthesize answers, or perform final visibility
// appenders.
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import {
  buildApprovalWaitTimeoutCloseoutRepairPrompt,
  buildFalseEvidenceBlockedSynthesisRepairPrompt,
  buildFinalRecoveryBudgetCloseoutRepairPrompt,
  buildIncompleteApprovedBrowserActionRepairPrompt,
  buildMissingBrowserEvidenceRepairPrompt,
  buildMissingBrowserEvidenceDimensionsRepairPrompt,
  buildMissingApprovalGateRepairPrompt,
  buildMissingProductSignalBrowserEvidenceRepairPrompt,
  buildMissingRequestedNextActionRepairPrompt,
  buildMissingRequiredFinalDeliverablesRepairPrompt,
  buildPendingApprovalWaitTimeoutCheckRepairPrompt,
  buildPrematurePendingApprovalRepairPrompt,
  buildSourceEvidenceCarryForwardRepairPrompt,
  buildStaleDeniedApprovalRepairPrompt,
  buildStalePendingApprovalRepairPrompt,
  buildTimeoutFollowupFinalGuidanceRepairPrompt,
  buildWeakEvidenceSynthesisRepairPrompt,
  findMissingRequiredFinalDeliverables,
  hasMissingRequiredFinalDeliverablesRepairPrompt,
  shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair,
  shouldRepairApprovalWaitTimeoutCloseout,
  shouldRepairFalseEvidenceBlockedSynthesis,
  shouldRepairFinalRecoveryBudgetCloseout,
  shouldRepairIncompleteApprovedBrowserAction,
  shouldRepairMissingBrowserEvidence,
  shouldRepairMissingBrowserEvidenceDimensions,
  shouldRepairMissingApprovalGate,
  shouldRepairMissingProductSignalBrowserEvidence,
  shouldRepairMissingRequestedNextAction,
  shouldRepairPendingApprovalWaitTimeoutCheck,
  shouldRepairPrematurePendingApprovalFinal,
  shouldRepairSourceEvidenceCarryForward,
  shouldRepairStaleDeniedApproval,
  shouldRepairStalePendingApproval,
  shouldRepairTimeoutFollowupFinalGuidance,
  shouldRepairWeakEvidenceSynthesis,
} from "../tool-loop-shared";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import { buildEvidenceSnapshot } from "./evidence-ledger";
import {
  buildExtraneousProviderTableSchemaRepairPrompt,
  buildMissingRequestedTableColumnsRepairPrompt,
  recordRepairPrompt,
  shouldRepairExtraneousProviderTableSchema,
  shouldRepairMissingRequestedTableColumns,
} from "./task-facts";
import type { LLMMessage, ReActToolChoice } from "./types";

export const REPAIR_POLICY_REGISTRY_MODULE = "repair-policy-registry" as const;

export const ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER = [
  "final_recovery_budget_closeout_repair",
  "missing_browser_evidence",
  "missing_product_signal_browser_evidence",
  "missing_approval_gate",
  "pending_approval_wait_timeout_check",
  "premature_pending_approval",
  "stale_pending_approval",
  "stale_denied_approval",
  "approval_wait_timeout_closeout",
  "approval_wait_timeout_local_closeout",
  "incomplete_approved_browser_action",
  "missing_requested_table_columns",
  "extraneous_provider_table_schema",
  "source_evidence_carry_forward",
  "weak_evidence_synthesis",
] as const;

export type EngineNaturalFinishRepairPolicyId =
  (typeof ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER)[number];

export const ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER = [
  "timeout_followup_final_guidance",
  "missing_requested_next_action",
  "missing_required_final_deliverables",
  "missing_browser_evidence_dimensions",
  "false_evidence_blocked_synthesis",
] as const;

export type EngineCompletedSynthesisRepairPolicyId =
  (typeof ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER)[number];

export interface FinalRecoveryBudgetRepairSignal {
  maxToolCalls: number;
  usedToolCalls: number;
}

export interface NaturalFinishRepairInput {
  activation?: RoleActivationInput;
  enabledPolicies?: readonly EngineNaturalFinishRepairPolicyId[];
  finalRecoveryBudget: FinalRecoveryBudgetRepairSignal | null;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
  taskPrompt?: string;
  toolTrace?: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
  evidenceText?: string;
}

export interface CompletedSynthesisRepairInput {
  completedEvidenceText: string;
  completedSessionEvidenceText: string;
  completedSessionFinalContents: readonly string[];
  enabledPolicies?: readonly EngineCompletedSynthesisRepairPolicyId[];
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
  taskPrompt: string;
}

export interface NaturalFinishRepairApplicationInput {
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}

export type NaturalFinishRepairApplication =
  | {
      messages: LLMMessage[];
      forceToolChoice: ReActToolChoice;
      consumesRound?: true;
    }
  | {
      closeout: "tool_evidence_fallback";
    };

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
      policyId: "missing_browser_evidence";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: { name: "sessions_spawn" };
      consumesRound: true;
    }
  | {
      kind: "force_tool_round";
      policyId: "missing_product_signal_browser_evidence";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: { name: "sessions_spawn" };
      consumesRound: true;
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
    }
  | {
      kind: "force_tool_round";
      policyId: "incomplete_approved_browser_action";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: { name: "sessions_spawn" };
      consumesRound: true;
    }
  | {
      kind: "resynthesize";
      policyId: "missing_requested_table_columns";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: "none";
      consumesRound?: false;
    }
  | {
      kind: "resynthesize";
      policyId: "extraneous_provider_table_schema";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: "none";
      consumesRound?: false;
    }
  | {
      kind: "resynthesize";
      policyId: "source_evidence_carry_forward";
      evidenceFormula: "source_bounded_evidence";
      repairPrompt: string;
      forceToolChoice: "none";
      consumesRound?: false;
    }
  | {
      kind: "resynthesize";
      policyId: "weak_evidence_synthesis";
      evidenceFormula: "source_bounded_evidence";
      repairPrompt: string;
      forceToolChoice: "none";
      consumesRound?: false;
    };

export type CompletedSynthesisRepairDecision =
  | {
      kind: "resynthesize";
      policyId: "timeout_followup_final_guidance";
      evidenceFormula: "completed_product_brief_evidence";
      repairPrompt: string;
      forceToolChoice: "none";
    }
  | {
      kind: "resynthesize";
      policyId: "missing_requested_next_action";
      evidenceFormula: "candidate_final";
      repairPrompt: string;
      forceToolChoice: "none";
    }
  | {
      kind: "resynthesize";
      policyId: "missing_required_final_deliverables";
      evidenceFormula: "completed_session_evidence";
      repairPrompt: string;
      forceToolChoice: "none";
    }
  | {
      kind: "resynthesize";
      policyId: "missing_browser_evidence_dimensions";
      evidenceFormula: "completed_session_evidence";
      repairPrompt: string;
      forceToolChoice: "none";
    }
  | {
      kind: "resynthesize";
      policyId: "false_evidence_blocked_synthesis";
      evidenceFormula: "completed_session_evidence";
      repairPrompt: string;
      forceToolChoice: "none";
    };

export interface RepairPolicyRegistry {
  applyNaturalFinishRepair(
    input: NaturalFinishRepairInput,
  ): NaturalFinishRepairApplication | null;
  evaluateNaturalFinish(
    input: NaturalFinishRepairInput,
  ): NaturalFinishRepairDecision | null;
  applyNaturalFinishRepairDecision(
    decision: NaturalFinishRepairDecision | null,
    input: NaturalFinishRepairApplicationInput,
  ): NaturalFinishRepairApplication | null;
  evaluateCompletedSynthesis(
    input: CompletedSynthesisRepairInput,
  ): CompletedSynthesisRepairDecision | null;
}

class DefaultRepairPolicyRegistry implements RepairPolicyRegistry {
  applyNaturalFinishRepair(
    input: NaturalFinishRepairInput,
  ): NaturalFinishRepairApplication | null {
    return this.applyNaturalFinishRepairDecision(
      this.evaluateNaturalFinish(input),
      input,
    );
  }

  applyNaturalFinishRepairDecision(
    decision: NaturalFinishRepairDecision | null,
    input: NaturalFinishRepairApplicationInput,
  ): NaturalFinishRepairApplication | null {
    if (!decision) {
      return null;
    }
    if (decision.kind === "closeout") {
      return { closeout: decision.closeoutReason };
    }
    return {
      messages: [
        ...input.messages,
        { role: "assistant", content: input.resultText },
        recordRepairPrompt(input.repairMarkers, decision.repairPrompt),
      ],
      forceToolChoice: decision.forceToolChoice,
      ...(decision.consumesRound === true ? { consumesRound: true } : {}),
    };
  }

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
        case "missing_browser_evidence": {
          const decision = evaluateMissingBrowserEvidenceRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "missing_product_signal_browser_evidence": {
          const decision =
            evaluateMissingProductSignalBrowserEvidenceRepair(input);
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
        case "incomplete_approved_browser_action": {
          const decision =
            evaluateIncompleteApprovedBrowserActionRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "missing_requested_table_columns": {
          const decision = evaluateMissingRequestedTableColumnsRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "extraneous_provider_table_schema": {
          const decision = evaluateExtraneousProviderTableSchemaRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "source_evidence_carry_forward": {
          const decision = evaluateSourceEvidenceCarryForwardRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "weak_evidence_synthesis": {
          const decision = evaluateWeakEvidenceSynthesisRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
      }
    }
    return null;
  }

  evaluateCompletedSynthesis(
    input: CompletedSynthesisRepairInput,
  ): CompletedSynthesisRepairDecision | null {
    for (const policyId of ENGINE_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER) {
      if (!isCompletedPolicyEnabled(input, policyId)) {
        continue;
      }
      switch (policyId) {
        case "timeout_followup_final_guidance": {
          const decision = evaluateTimeoutFollowupFinalGuidanceRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "missing_requested_next_action": {
          const decision = evaluateMissingRequestedNextActionRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "missing_required_final_deliverables": {
          const decision = evaluateMissingRequiredFinalDeliverablesRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "missing_browser_evidence_dimensions": {
          const decision =
            evaluateMissingBrowserEvidenceDimensionsRepair(input);
          if (decision) {
            return decision;
          }
          break;
        }
        case "false_evidence_blocked_synthesis": {
          const decision = evaluateFalseEvidenceBlockedSynthesisRepair(input);
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

function isCompletedPolicyEnabled(
  input: CompletedSynthesisRepairInput,
  policyId: EngineCompletedSynthesisRepairPolicyId,
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

function evaluateMissingBrowserEvidenceRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairMissingBrowserEvidence({
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
    policyId: "missing_browser_evidence",
    evidenceFormula: "candidate_final",
    repairPrompt: buildMissingBrowserEvidenceRepairPrompt(input.taskPrompt),
    forceToolChoice: { name: "sessions_spawn" },
    consumesRound: true,
  };
}

function evaluateMissingProductSignalBrowserEvidenceRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairMissingProductSignalBrowserEvidence({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.evidenceText === undefined
        ? {}
        : { evidenceText: input.evidenceText }),
    })
  ) {
    return null;
  }
  return {
    kind: "force_tool_round",
    policyId: "missing_product_signal_browser_evidence",
    evidenceFormula: "candidate_final",
    repairPrompt: buildMissingProductSignalBrowserEvidenceRepairPrompt(
      input.taskPrompt,
    ),
    forceToolChoice: { name: "sessions_spawn" },
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

function evaluateIncompleteApprovedBrowserActionRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    return null;
  }
  if (
    !shouldRepairIncompleteApprovedBrowserAction({
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
    policyId: "incomplete_approved_browser_action",
    evidenceFormula: "candidate_final",
    repairPrompt: buildIncompleteApprovedBrowserActionRepairPrompt(),
    forceToolChoice: { name: "sessions_spawn" },
    consumesRound: true,
  };
}

function evaluateMissingRequestedTableColumnsRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (
    !shouldRepairMissingRequestedTableColumns({
      activation: input.activation,
      taskPrompt: input.taskPrompt ?? "",
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      resultText: input.resultText,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "missing_requested_table_columns",
    evidenceFormula: "candidate_final",
    repairPrompt: buildMissingRequestedTableColumnsRepairPrompt({
      activation: input.activation,
      taskPrompt: input.taskPrompt ?? "",
      messages: input.messages,
      resultText: input.resultText,
    }),
    forceToolChoice: "none",
  };
}

function evaluateExtraneousProviderTableSchemaRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (
    !shouldRepairExtraneousProviderTableSchema({
      activation: input.activation,
      taskPrompt: input.taskPrompt ?? "",
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      resultText: input.resultText,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "extraneous_provider_table_schema",
    evidenceFormula: "candidate_final",
    repairPrompt: buildExtraneousProviderTableSchemaRepairPrompt({
      taskPrompt: input.taskPrompt ?? "",
      resultText: input.resultText,
    }),
    forceToolChoice: "none",
  };
}

function evaluateSourceEvidenceCarryForwardRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  if (!input.taskPrompt || !input.toolTrace) {
    if (!input.taskPrompt || !input.evidenceText) {
      return null;
    }
  }
  const evidenceText =
    input.evidenceText ?? collectNaturalFinishSourceBoundedEvidenceText(input);
  if (!evidenceText) {
    return null;
  }
  if (
    !shouldRepairSourceEvidenceCarryForward({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "source_evidence_carry_forward",
    evidenceFormula: "source_bounded_evidence",
    repairPrompt: buildSourceEvidenceCarryForwardRepairPrompt({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      evidenceText,
    }),
    forceToolChoice: "none",
  };
}

function evaluateWeakEvidenceSynthesisRepair(
  input: NaturalFinishRepairInput,
): NaturalFinishRepairDecision | null {
  const evidenceText =
    input.evidenceText ??
    (input.taskPrompt ? collectNaturalFinishSourceBoundedEvidenceText(input) : "");
  if (
    !shouldRepairWeakEvidenceSynthesis({
      taskPrompt: input.taskPrompt ?? "",
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "weak_evidence_synthesis",
    evidenceFormula: "source_bounded_evidence",
    repairPrompt: buildWeakEvidenceSynthesisRepairPrompt(),
    forceToolChoice: "none",
  };
}

function collectNaturalFinishSourceBoundedEvidenceText(
  input: NaturalFinishRepairInput,
): string {
  if (!input.taskPrompt || !input.toolTrace) {
    return "";
  }
  return buildEvidenceSnapshot({
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
  }).naturalFinishEvidenceText;
}

function evaluateTimeoutFollowupFinalGuidanceRepair(
  input: CompletedSynthesisRepairInput,
): CompletedSynthesisRepairDecision | null {
  if (
    !shouldRepairTimeoutFollowupFinalGuidance({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText: input.completedEvidenceText,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "timeout_followup_final_guidance",
    evidenceFormula: "completed_product_brief_evidence",
    repairPrompt: buildTimeoutFollowupFinalGuidanceRepairPrompt({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      evidenceText: input.completedEvidenceText,
    }),
    forceToolChoice: "none",
  };
}

function evaluateMissingRequestedNextActionRepair(
  input: CompletedSynthesisRepairInput,
): CompletedSynthesisRepairDecision | null {
  if (
    !shouldRepairMissingRequestedNextAction({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "missing_requested_next_action",
    evidenceFormula: "candidate_final",
    repairPrompt: buildMissingRequestedNextActionRepairPrompt(),
    forceToolChoice: "none",
  };
}

function evaluateMissingRequiredFinalDeliverablesRepair(
  input: CompletedSynthesisRepairInput,
): CompletedSynthesisRepairDecision | null {
  const missingRequiredDeliverables = findMissingRequiredFinalDeliverables({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
  });
  if (
    missingRequiredDeliverables.length === 0 ||
    hasMissingRequiredFinalDeliverablesRepairPrompt(input.repairMarkers)
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "missing_required_final_deliverables",
    evidenceFormula: "completed_session_evidence",
    repairPrompt: buildMissingRequiredFinalDeliverablesRepairPrompt({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      missing: missingRequiredDeliverables,
      evidenceText: input.completedSessionEvidenceText,
    }),
    forceToolChoice: "none",
  };
}

function evaluateMissingBrowserEvidenceDimensionsRepair(
  input: CompletedSynthesisRepairInput,
): CompletedSynthesisRepairDecision | null {
  if (input.completedSessionFinalContents.length === 0) {
    return null;
  }
  if (
    !shouldRepairMissingBrowserEvidenceDimensions({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText: input.completedSessionEvidenceText,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "missing_browser_evidence_dimensions",
    evidenceFormula: "completed_session_evidence",
    repairPrompt: buildMissingBrowserEvidenceDimensionsRepairPrompt({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      evidenceText: input.completedSessionEvidenceText,
    }),
    forceToolChoice: "none",
  };
}

function evaluateFalseEvidenceBlockedSynthesisRepair(
  input: CompletedSynthesisRepairInput,
): CompletedSynthesisRepairDecision | null {
  if (input.completedSessionFinalContents.length === 0) {
    return null;
  }
  if (
    !shouldRepairFalseEvidenceBlockedSynthesis({
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText: input.completedSessionEvidenceText,
    })
  ) {
    return null;
  }
  return {
    kind: "resynthesize",
    policyId: "false_evidence_blocked_synthesis",
    evidenceFormula: "completed_session_evidence",
    repairPrompt: buildFalseEvidenceBlockedSynthesisRepairPrompt(
      input.completedSessionFinalContents,
    ),
    forceToolChoice: "none",
  };
}

export function createRepairPolicyRegistry(): RepairPolicyRegistry {
  return new DefaultRepairPolicyRegistry();
}

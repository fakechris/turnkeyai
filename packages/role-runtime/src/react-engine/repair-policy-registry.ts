// Stage 8 engine cleanup — RepairPolicyRegistry.
//
// Authority: own candidate-answer repair rules, order, evidence formulas, and
// markers. Each extracted repair returns a typed decision; the adapter applies
// that decision to the ReAct hook by appending messages/markers. This module
// does not execute tools, record progress, synthesize answers, or perform final
// visibility appenders.
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import {
  buildApprovalWaitTimeoutCloseoutRepairPrompt,
  buildFinalRecoveryBudgetCloseoutRepairPrompt,
  buildIncompleteApprovedBrowserActionRepairPrompt,
  buildMissingApprovalGateRepairPrompt,
  buildPendingApprovalWaitTimeoutCheckRepairPrompt,
  buildPrematurePendingApprovalRepairPrompt,
  buildSourceEvidenceCarryForwardRepairPrompt,
  buildStaleDeniedApprovalRepairPrompt,
  buildStalePendingApprovalRepairPrompt,
  buildWeakEvidenceSynthesisRepairPrompt,
  collectCompletedSessionEvidenceText,
  collectSourceBoundedEvidenceText,
  shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair,
  shouldRepairApprovalWaitTimeoutCloseout,
  shouldRepairFinalRecoveryBudgetCloseout,
  shouldRepairIncompleteApprovedBrowserAction,
  shouldRepairMissingApprovalGate,
  shouldRepairPendingApprovalWaitTimeoutCheck,
  shouldRepairPrematurePendingApprovalFinal,
  shouldRepairSourceEvidenceCarryForward,
  shouldRepairStaleDeniedApproval,
  shouldRepairStalePendingApproval,
  shouldRepairWeakEvidenceSynthesis,
  sliceUtf8,
} from "../tool-loop-shared";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildOriginalRequestTableColumnContext,
  buildRequestedTableColumnActivationContext,
  explicitlyRequestsProviderSupportSchema,
  markdownTableHasExactRequestedColumns,
  normalizeColumnDetectionText,
  requestedTableColumnMessageContext,
  resolveRequestedTableColumns,
  resultIntroducesProviderSupportSchema,
} from "./task-facts";
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
  "incomplete_approved_browser_action",
  "missing_requested_table_columns",
  "extraneous_provider_table_schema",
  "source_evidence_carry_forward",
  "weak_evidence_synthesis",
] as const;

export type EngineNaturalFinishRepairPolicyId =
  (typeof ENGINE_NATURAL_FINISH_REPAIR_POLICY_ORDER)[number];

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
    return null;
  }
  const evidenceText = collectNaturalFinishSourceBoundedEvidenceText(input);
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
  const evidenceText = input.taskPrompt
    ? collectNaturalFinishSourceBoundedEvidenceText(input)
    : "";
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
  return [
    collectSourceBoundedEvidenceText({
      taskPrompt: input.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
    }),
    collectCompletedSessionEvidenceText(input.toolTrace),
  ]
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

function shouldRepairMissingRequestedTableColumns(input: {
  activation: RoleActivationInput | undefined;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasMissingRequestedTableColumnsRepairPrompt(input.repairMarkers)) {
    return false;
  }
  const requestedColumns = resolveRequestedTableColumns([
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ]);
  if (requestedColumns.length === 0) return false;
  const normalizedResult = normalizeColumnDetectionText(input.resultText);
  if (
    !markdownTableHasExactRequestedColumns(input.resultText, requestedColumns)
  ) {
    return true;
  }
  return requestedColumns.some(
    (column) => !normalizedResult.includes(normalizeColumnDetectionText(column)),
  );
}

function hasMissingRequestedTableColumnsRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      messageContentText(message.content).includes(
        "did not preserve the table columns explicitly requested",
      ),
  );
}

function buildMissingRequestedTableColumnsRepairPrompt(input: {
  activation: RoleActivationInput | undefined;
  taskPrompt: string;
  messages: LLMMessage[];
  resultText: string;
}): string {
  const requestedColumns = resolveRequestedTableColumns([
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ]);
  return [
    "The previous final answer did not preserve the table columns explicitly requested by the original user/task.",
    `Required table header columns: ${requestedColumns.join(" | ")}`,
    "Rewrite the final answer now without calling tools.",
    "The main table must include every required column above. Do not rename columns, transpose the table into Slot x Provider form, merge columns, or move any requested column into prose.",
    "For any cell not directly supported by source evidence already present, write 未验证.",
    "If any required goal slot remains unverified, mark the answer as blocked/partial and list the missing slots briefly after the table.",
  ].join("\n");
}

function shouldRepairExtraneousProviderTableSchema(input: {
  activation: RoleActivationInput | undefined;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasExtraneousProviderTableSchemaRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!resultIntroducesProviderSupportSchema(input.resultText)) {
    return false;
  }
  const originalContext = [
    input.taskPrompt,
    ...buildOriginalRequestTableColumnContext(input.activation),
  ].join("\n");
  const originalRequestedColumns = resolveRequestedTableColumns([
    originalContext,
  ]);
  if (
    originalRequestedColumns.length > 0 &&
    explicitlyRequestsProviderSupportSchema(originalContext)
  ) {
    return false;
  }
  return !explicitlyRequestsProviderSupportSchema(originalContext);
}

function hasExtraneousProviderTableSchemaRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      messageContentText(message.content).includes(
        "introduced provider/search/model-support columns that were not requested",
      ),
  );
}

function buildExtraneousProviderTableSchemaRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
}): string {
  return [
    "Runtime correction: final answer introduced provider/search/model-support columns that were not requested by the original task.",
    "Do not call tools. Rewrite the final answer using only the evidence already present.",
    "Remove the provider/search_web_search/target-model/input-price/output-price table schema unless those exact dimensions were requested by the original task.",
    "Use the original task dimensions instead: pricing, strengths, risks, tradeoff, and a clear recommendation for the product lead when those are requested.",
    "Do not mark the whole mission blocked merely because provider support, target-model support, search/web_search support, or token input/output pricing are absent when the original task did not ask for them.",
    "Keep residual risk visible only for source-bounded gaps actually relevant to the original task.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
  ].join("\n");
}

function messageContentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "tool_result") return block.content;
      if (block.type === "text") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createRepairPolicyRegistry(): RepairPolicyRegistry {
  return new DefaultRepairPolicyRegistry();
}

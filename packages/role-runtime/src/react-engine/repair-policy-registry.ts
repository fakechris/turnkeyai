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
} from "../tool-loop-shared";
import {
  buildCompletedSynthesisRepairPolicyFacts,
  buildNaturalFinishRepairPolicyFacts,
  type CompletedSynthesisRepairPolicyFacts,
  type NaturalFinishRepairPolicyFacts,
} from "../runtime-facts/repair-policy-facts";
import {
  selectCompletedSynthesisRepairPolicy,
  selectNaturalFinishRepairPolicy,
} from "../runtime-policy/repair-policy-core";
import type { RuntimeRepairDecision } from "../runtime-policy/types";
import {
  countNativeToolCalls,
  type NativeToolRoundTrace,
} from "../native-tool-messages";
import {
  buildEvidenceSnapshot,
  type PermissionEvidenceFacts,
} from "./evidence-ledger";
import {
  buildTaskFacts,
  buildExtraneousProviderTableSchemaRepairPrompt,
  buildMissingRequestedTableColumnsRepairPrompt,
  recordRepairPrompt,
  shouldRepairExtraneousProviderTableSchema,
  shouldRepairMissingRequestedTableColumns,
  type TaskFactsSnapshot,
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
  permissionFacts?: PermissionEvidenceFacts;
  taskFacts?: TaskFactsSnapshot;
}

export interface NaturalFinishRepairHookContext {
  repairMarkers?: LLMMessage[];
}

export interface NaturalFinishRepairHookInput {
  active: boolean;
  activation?: RoleActivationInput;
  hookContext: NaturalFinishRepairHookContext;
  recoveryToolBudget: { maxToolCalls: number } | null;
  recoveryToolCallsBeforeActivation: number;
  messages: LLMMessage[];
  resultText: string;
  taskPrompt?: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
  taskFacts?: TaskFactsSnapshot;
}

export interface CompletedSynthesisRepairInput {
  completedEvidenceText: string;
  delegatedEvidenceText: string;
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
  applyNaturalFinishRepairHook(
    input: NaturalFinishRepairHookInput,
  ): NaturalFinishRepairApplication | null;
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
  applyNaturalFinishRepairHook(
    input: NaturalFinishRepairHookInput,
  ): NaturalFinishRepairApplication | null {
    if (!input.active) {
      return null;
    }
    const repairMarkers = (input.hookContext.repairMarkers ??= []);
    const evidence = buildEvidenceSnapshot({
      taskPrompt: input.taskPrompt ?? "",
      messages: input.messages,
      toolTrace: input.toolTrace,
    });
    const taskFacts =
      input.taskFacts ??
      buildTaskFacts({
        taskPrompt: input.taskPrompt ?? "",
        ...(input.activation === undefined
          ? {}
          : { activation: input.activation }),
        messages: input.messages,
      });
    return this.applyNaturalFinishRepair({
      ...(input.activation === undefined
        ? {}
        : { activation: input.activation }),
      finalRecoveryBudget: input.recoveryToolBudget
        ? {
            maxToolCalls: input.recoveryToolBudget.maxToolCalls,
            usedToolCalls:
              input.recoveryToolCallsBeforeActivation +
              countNativeToolCalls(input.toolTrace),
          }
        : null,
      messages: input.messages,
      repairMarkers,
      resultText: input.resultText,
      ...(input.taskPrompt === undefined
        ? {}
        : { taskPrompt: input.taskPrompt }),
      toolTrace: input.toolTrace,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      permissionFacts: evidence.permission,
      taskFacts,
    });
  }

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
    const facts = buildNaturalFinishRepairPolicyFacts(input);
    return renderNaturalFinishRepairDecision(
      selectNaturalFinishRepairPolicy({
        facts,
        ...(input.enabledPolicies === undefined
          ? {}
          : { enabledPolicies: input.enabledPolicies }),
      }),
      input,
      facts,
    );
  }

  evaluateCompletedSynthesis(
    input: CompletedSynthesisRepairInput,
  ): CompletedSynthesisRepairDecision | null {
    const facts = buildCompletedSynthesisRepairPolicyFacts(input);
    return renderCompletedSynthesisRepairDecision(
      selectCompletedSynthesisRepairPolicy({
        facts,
        ...(input.enabledPolicies === undefined
          ? {}
          : { enabledPolicies: input.enabledPolicies }),
      }),
      input,
      facts,
    );
  }
}

function renderNaturalFinishRepairDecision(
  decision: RuntimeRepairDecision | null,
  input: NaturalFinishRepairInput,
  facts: NaturalFinishRepairPolicyFacts,
): NaturalFinishRepairDecision | null {
  if (!decision) return null;
  switch (decision.policyId as EngineNaturalFinishRepairPolicyId) {
    case "final_recovery_budget_closeout_repair":
      return {
        kind: "resynthesize",
        policyId: "final_recovery_budget_closeout_repair",
        evidenceFormula: "candidate_final",
        repairPrompt: buildFinalRecoveryBudgetCloseoutRepairPrompt(
          input.finalRecoveryBudget?.maxToolCalls ?? 0,
        ),
        forceToolChoice: "none",
      };
    case "missing_browser_evidence":
      return {
        kind: "force_tool_round",
        policyId: "missing_browser_evidence",
        evidenceFormula: "candidate_final",
        repairPrompt: buildMissingBrowserEvidenceRepairPrompt(
          input.taskPrompt ?? "",
        ),
        forceToolChoice: { name: "sessions_spawn" },
        consumesRound: true,
      };
    case "missing_product_signal_browser_evidence":
      return {
        kind: "force_tool_round",
        policyId: "missing_product_signal_browser_evidence",
        evidenceFormula: "candidate_final",
        repairPrompt: buildMissingProductSignalBrowserEvidenceRepairPrompt(
          input.taskPrompt ?? "",
        ),
        forceToolChoice: { name: "sessions_spawn" },
        consumesRound: true,
      };
    case "missing_approval_gate":
      return {
        kind: "force_tool_round",
        policyId: "missing_approval_gate",
        evidenceFormula: "candidate_final",
        repairPrompt: buildMissingApprovalGateRepairPrompt(),
        forceToolChoice: { name: "permission_query" },
        consumesRound: true,
      };
    case "pending_approval_wait_timeout_check":
      return {
        kind: "force_tool_round",
        policyId: "pending_approval_wait_timeout_check",
        evidenceFormula: "candidate_final",
        repairPrompt: buildPendingApprovalWaitTimeoutCheckRepairPrompt(),
        forceToolChoice: { name: "permission_result" },
        consumesRound: true,
      };
    case "premature_pending_approval":
      return {
        kind: "force_tool_round",
        policyId: "premature_pending_approval",
        evidenceFormula: "candidate_final",
        repairPrompt: buildPrematurePendingApprovalRepairPrompt(),
        forceToolChoice: { name: "permission_result" },
        consumesRound: true,
      };
    case "stale_pending_approval":
      return {
        kind: "force_tool_round",
        policyId: "stale_pending_approval",
        evidenceFormula: "candidate_final",
        repairPrompt: buildStalePendingApprovalRepairPrompt(),
        forceToolChoice: { name: "sessions_spawn" },
        consumesRound: true,
      };
    case "stale_denied_approval":
      return {
        kind: "resynthesize",
        policyId: "stale_denied_approval",
        evidenceFormula: "candidate_final",
        repairPrompt: buildStaleDeniedApprovalRepairPrompt(),
        forceToolChoice: "none",
      };
    case "approval_wait_timeout_closeout":
      return {
        kind: "resynthesize",
        policyId: "approval_wait_timeout_closeout",
        evidenceFormula: "candidate_final",
        repairPrompt: buildApprovalWaitTimeoutCloseoutRepairPrompt(),
        forceToolChoice: "none",
      };
    case "approval_wait_timeout_local_closeout":
      return {
        kind: "closeout",
        policyId: "approval_wait_timeout_local_closeout",
        evidenceFormula: "candidate_final",
        closeoutReason: "tool_evidence_fallback",
      };
    case "incomplete_approved_browser_action":
      return {
        kind: "force_tool_round",
        policyId: "incomplete_approved_browser_action",
        evidenceFormula: "candidate_final",
        repairPrompt: buildIncompleteApprovedBrowserActionRepairPrompt(),
        forceToolChoice: { name: "sessions_spawn" },
        consumesRound: true,
      };
    case "missing_requested_table_columns":
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
    case "extraneous_provider_table_schema":
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
    case "source_evidence_carry_forward":
      return {
        kind: "resynthesize",
        policyId: "source_evidence_carry_forward",
        evidenceFormula: "source_bounded_evidence",
        repairPrompt: buildSourceEvidenceCarryForwardRepairPrompt({
          taskPrompt: input.taskPrompt ?? "",
          resultText: input.resultText,
          evidenceText: facts.sourceEvidenceText,
        }),
        forceToolChoice: "none",
      };
    case "weak_evidence_synthesis":
      return {
        kind: "resynthesize",
        policyId: "weak_evidence_synthesis",
        evidenceFormula: "source_bounded_evidence",
        repairPrompt: buildWeakEvidenceSynthesisRepairPrompt(),
        forceToolChoice: "none",
      };
  }
}

function renderCompletedSynthesisRepairDecision(
  decision: RuntimeRepairDecision | null,
  input: CompletedSynthesisRepairInput,
  facts: CompletedSynthesisRepairPolicyFacts,
): CompletedSynthesisRepairDecision | null {
  if (!decision) return null;
  switch (decision.policyId as EngineCompletedSynthesisRepairPolicyId) {
    case "timeout_followup_final_guidance":
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
    case "missing_requested_next_action":
      return {
        kind: "resynthesize",
        policyId: "missing_requested_next_action",
        evidenceFormula: "candidate_final",
        repairPrompt: buildMissingRequestedNextActionRepairPrompt(),
        forceToolChoice: "none",
      };
    case "missing_required_final_deliverables":
      return {
        kind: "resynthesize",
        policyId: "missing_required_final_deliverables",
        evidenceFormula: "completed_session_evidence",
        repairPrompt: buildMissingRequiredFinalDeliverablesRepairPrompt({
          taskPrompt: input.taskPrompt,
          resultText: input.resultText,
          missing: [...facts.missingRequiredDeliverables],
          evidenceText: input.delegatedEvidenceText,
        }),
        forceToolChoice: "none",
      };
    case "missing_browser_evidence_dimensions":
      return {
        kind: "resynthesize",
        policyId: "missing_browser_evidence_dimensions",
        evidenceFormula: "completed_session_evidence",
        repairPrompt: buildMissingBrowserEvidenceDimensionsRepairPrompt({
          taskPrompt: input.taskPrompt,
          resultText: input.resultText,
          evidenceText: input.delegatedEvidenceText,
        }),
        forceToolChoice: "none",
      };
    case "false_evidence_blocked_synthesis":
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
}

export function createRepairPolicyRegistry(): RepairPolicyRegistry {
  return new DefaultRepairPolicyRegistry();
}

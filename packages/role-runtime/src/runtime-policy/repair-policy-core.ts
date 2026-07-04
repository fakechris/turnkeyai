import type {
  CompletedSynthesisRepairPolicyFacts,
  NaturalFinishRepairPolicyFacts,
} from "../runtime-facts/repair-policy-facts";
import type { RuntimeRepairDecision } from "./types";

export const RUNTIME_NATURAL_FINISH_REPAIR_POLICY_ORDER = [
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

export type RuntimeNaturalFinishRepairPolicyId =
  (typeof RUNTIME_NATURAL_FINISH_REPAIR_POLICY_ORDER)[number];

export const RUNTIME_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER = [
  "timeout_followup_final_guidance",
  "missing_requested_next_action",
  "missing_required_final_deliverables",
  "missing_browser_evidence_dimensions",
  "false_evidence_blocked_synthesis",
] as const;

export type RuntimeCompletedSynthesisRepairPolicyId =
  (typeof RUNTIME_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER)[number];

export interface SelectNaturalFinishRepairInput {
  facts: NaturalFinishRepairPolicyFacts;
  enabledPolicies?: readonly RuntimeNaturalFinishRepairPolicyId[];
}

export interface SelectCompletedSynthesisRepairInput {
  facts: CompletedSynthesisRepairPolicyFacts;
  enabledPolicies?: readonly RuntimeCompletedSynthesisRepairPolicyId[];
}

export function selectNaturalFinishRepairPolicy(
  input: SelectNaturalFinishRepairInput,
): RuntimeRepairDecision | null {
  for (const policyId of RUNTIME_NATURAL_FINISH_REPAIR_POLICY_ORDER) {
    if (!isNaturalPolicyEnabled(input, policyId)) continue;
    if (!naturalPolicyActive(input.facts, policyId)) continue;
    return buildNaturalDecision(policyId);
  }
  return null;
}

export function selectCompletedSynthesisRepairPolicy(
  input: SelectCompletedSynthesisRepairInput,
): RuntimeRepairDecision | null {
  for (const policyId of RUNTIME_COMPLETED_SYNTHESIS_REPAIR_POLICY_ORDER) {
    if (!isCompletedPolicyEnabled(input, policyId)) continue;
    if (!completedPolicyActive(input.facts, policyId)) continue;
    return buildCompletedDecision(policyId);
  }
  return null;
}

function isNaturalPolicyEnabled(
  input: SelectNaturalFinishRepairInput,
  policyId: RuntimeNaturalFinishRepairPolicyId,
): boolean {
  return !input.enabledPolicies || input.enabledPolicies.includes(policyId);
}

function isCompletedPolicyEnabled(
  input: SelectCompletedSynthesisRepairInput,
  policyId: RuntimeCompletedSynthesisRepairPolicyId,
): boolean {
  return !input.enabledPolicies || input.enabledPolicies.includes(policyId);
}

function naturalPolicyActive(
  facts: NaturalFinishRepairPolicyFacts,
  policyId: RuntimeNaturalFinishRepairPolicyId,
): boolean {
  switch (policyId) {
    case "final_recovery_budget_closeout_repair":
      return facts.finalRecoveryBudgetCloseoutRepair;
    case "missing_browser_evidence":
      return facts.missingBrowserEvidence;
    case "missing_product_signal_browser_evidence":
      return facts.missingProductSignalBrowserEvidence;
    case "missing_approval_gate":
      return facts.missingApprovalGate;
    case "pending_approval_wait_timeout_check":
      return facts.pendingApprovalWaitTimeoutCheck;
    case "premature_pending_approval":
      return facts.prematurePendingApproval;
    case "stale_pending_approval":
      return facts.stalePendingApproval;
    case "stale_denied_approval":
      return facts.staleDeniedApproval;
    case "approval_wait_timeout_closeout":
      return facts.approvalWaitTimeoutCloseout;
    case "approval_wait_timeout_local_closeout":
      return facts.approvalWaitTimeoutLocalCloseout;
    case "incomplete_approved_browser_action":
      return facts.incompleteApprovedBrowserAction;
    case "missing_requested_table_columns":
      return facts.missingRequestedTableColumns;
    case "extraneous_provider_table_schema":
      return facts.extraneousProviderTableSchema;
    case "source_evidence_carry_forward":
      return facts.sourceEvidenceCarryForward;
    case "weak_evidence_synthesis":
      return facts.weakEvidenceSynthesis;
  }
}

function completedPolicyActive(
  facts: CompletedSynthesisRepairPolicyFacts,
  policyId: RuntimeCompletedSynthesisRepairPolicyId,
): boolean {
  switch (policyId) {
    case "timeout_followup_final_guidance":
      return facts.timeoutFollowupFinalGuidance;
    case "missing_requested_next_action":
      return facts.missingRequestedNextAction;
    case "missing_required_final_deliverables":
      return facts.missingRequiredFinalDeliverables;
    case "missing_browser_evidence_dimensions":
      return facts.missingBrowserEvidenceDimensions;
    case "false_evidence_blocked_synthesis":
      return facts.falseEvidenceBlockedSynthesis;
  }
}

function buildNaturalDecision(
  policyId: RuntimeNaturalFinishRepairPolicyId,
): RuntimeRepairDecision {
  switch (policyId) {
    case "missing_browser_evidence":
    case "missing_product_signal_browser_evidence":
    case "stale_pending_approval":
    case "incomplete_approved_browser_action":
      return {
        kind: "force_tool_round",
        policyId,
        reasonCode: policyId,
        evidenceFormula: "candidate_final",
        forceToolChoice: { name: "sessions_spawn" },
        consumesRound: true,
        render: { kind: "repair_prompt", payload: { policyId } },
      };
    case "missing_approval_gate":
      return {
        kind: "force_tool_round",
        policyId,
        reasonCode: policyId,
        evidenceFormula: "candidate_final",
        forceToolChoice: { name: "permission_query" },
        consumesRound: true,
        render: { kind: "permission_repair_prompt", payload: { policyId } },
      };
    case "pending_approval_wait_timeout_check":
    case "premature_pending_approval":
      return {
        kind: "force_tool_round",
        policyId,
        reasonCode: policyId,
        evidenceFormula: "candidate_final",
        forceToolChoice: { name: "permission_result" },
        consumesRound: true,
        render: { kind: "permission_repair_prompt", payload: { policyId } },
      };
    case "approval_wait_timeout_local_closeout":
      return {
        kind: "closeout",
        policyId,
        reasonCode: policyId,
        evidenceFormula: "candidate_final",
        closeoutReason: "tool_evidence_fallback",
        render: null,
      };
    case "source_evidence_carry_forward":
    case "weak_evidence_synthesis":
      return {
        kind: "resynthesize",
        policyId,
        reasonCode: policyId,
        evidenceFormula: "source_bounded_evidence",
        forceToolChoice: "none",
        render: { kind: "repair_prompt", payload: { policyId } },
      };
    default:
      return {
        kind: "resynthesize",
        policyId,
        reasonCode: policyId,
        evidenceFormula: "candidate_final",
        forceToolChoice: "none",
        render: { kind: "repair_prompt", payload: { policyId } },
      };
  }
}

function buildCompletedDecision(
  policyId: RuntimeCompletedSynthesisRepairPolicyId,
): RuntimeRepairDecision {
  return {
    kind: "resynthesize",
    policyId,
    reasonCode: policyId,
    evidenceFormula:
      policyId === "timeout_followup_final_guidance"
        ? "completed_product_brief_evidence"
        : policyId === "missing_requested_next_action"
          ? "candidate_final"
          : "completed_session_evidence",
    forceToolChoice: "none",
    render: { kind: "repair_prompt", payload: { policyId } },
  };
}

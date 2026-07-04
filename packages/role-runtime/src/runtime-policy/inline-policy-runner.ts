import type {
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildRecoveryToolBudgetCloseoutFacts,
  type RecoveryToolBudgetCloseoutFactInput,
} from "../runtime-facts/closeout-policy-facts";
import {
  buildIndependentEvidenceStreamsPolicyFacts,
  buildTimeoutContinuationPolicyFacts,
} from "../runtime-facts/continuation-policy-facts";
import {
  readPolicyApprovalWaitTimeoutRuntimeEvidence,
  readPolicyBrowserRecoverySummariesFromToolTrace,
  readPolicyCompletedSessionEvidenceText,
  readPolicySourceBoundedEvidenceText,
  type SubAgentToolTimeoutSignal,
} from "../runtime-facts/policy-text-facts";
import { buildPermissionSuppressionFacts } from "../runtime-facts/permission-policy-facts";
import {
  buildCompletedSynthesisRepairPolicyFacts,
  buildNaturalFinishRepairPolicyFacts,
  type NaturalFinishRepairFactInput,
} from "../runtime-facts/repair-policy-facts";
import { produceTaskIntentEnvelope } from "../runtime-facts/task-intent-producer";
import { selectRecoveryToolBudgetCloseoutPolicy } from "./closeout-policy-core";
import {
  selectIndependentEvidenceStreamsPolicy,
  selectTimeoutContinuationPolicy,
} from "./continuation-policy-core";
import { selectPermissionSuppressionPolicy } from "./permission-policy-core";
import {
  selectCompletedSynthesisRepairPolicy,
  selectNaturalFinishRepairPolicy,
  type RuntimeCompletedSynthesisRepairPolicyId,
  type RuntimeNaturalFinishRepairPolicyId,
} from "./repair-policy-core";

type InlineNaturalRepairInput = Omit<
  NaturalFinishRepairFactInput,
  "finalRecoveryBudget"
> &
  Partial<Pick<NaturalFinishRepairFactInput, "finalRecoveryBudget">>;

interface InlineCompletedRepairInput {
  completedSessionFinalContents?: readonly string[];
  evidenceText?: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
  taskPrompt?: string;
}

export const readApprovalWaitTimeoutRuntimeEvidence =
  readPolicyApprovalWaitTimeoutRuntimeEvidence;
export const readBrowserRecoverySummariesFromTrace =
  readPolicyBrowserRecoverySummariesFromToolTrace;
export const readCompletedSessionEvidenceText =
  readPolicyCompletedSessionEvidenceText;
export const readSourceBoundedEvidenceText = readPolicySourceBoundedEvidenceText;

export function readReadOnlyPermissionQuerySuppression(
  calls: LLMToolCall[],
  input: { taskPrompt: string; sessionContext: string },
): boolean {
  return (
    selectPermissionSuppressionPolicy({
      facts: buildPermissionSuppressionFacts({
        calls,
        taskPrompt: input.taskPrompt,
        sessionContext: input.sessionContext,
      }),
    }).kind === "suppress"
  );
}

export function readFinalRecoveryBudgetCloseoutRepair(
  input: Omit<RecoveryToolBudgetCloseoutFactInput, "pendingToolCallCount">,
): boolean {
  return (
    selectRecoveryToolBudgetCloseoutPolicy({
      budgetExceeded: true,
      facts: buildRecoveryToolBudgetCloseoutFacts({
        ...input,
        pendingToolCallCount: 0,
      }),
    }).kind === "defer"
  );
}

export function readMissingBrowserEvidenceRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "missing_browser_evidence");
}

export function readMissingProductSignalBrowserEvidenceRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(
    input,
    "missing_product_signal_browser_evidence",
  );
}

export function readMissingApprovalGateRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "missing_approval_gate");
}

export function readPendingApprovalWaitTimeoutCheckRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "pending_approval_wait_timeout_check");
}

export function readPrematurePendingApprovalFinalRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "premature_pending_approval");
}

export function readStalePendingApprovalRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "stale_pending_approval");
}

export function readStaleDeniedApprovalRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "stale_denied_approval");
}

export function readApprovalWaitTimeoutCloseoutRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "approval_wait_timeout_closeout");
}

export function readForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(
    input,
    "approval_wait_timeout_local_closeout",
  );
}

export function readIncompleteApprovedBrowserActionRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "incomplete_approved_browser_action");
}

export function readSourceEvidenceCarryForwardRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "source_evidence_carry_forward");
}

export function readWeakEvidenceSynthesisRepair(
  input: InlineNaturalRepairInput,
): boolean {
  return naturalRepairPolicyActive(input, "weak_evidence_synthesis");
}

export function readTimeoutFollowupFinalGuidanceRepair(
  input: InlineCompletedRepairInput,
): boolean {
  return completedRepairPolicyActive(input, "timeout_followup_final_guidance");
}

export function readMissingRequestedNextActionRepair(
  input: InlineCompletedRepairInput,
): boolean {
  return completedRepairPolicyActive(input, "missing_requested_next_action");
}

export function readMissingBrowserEvidenceDimensionsRepair(
  input: InlineCompletedRepairInput,
): boolean {
  return completedRepairPolicyActive(input, "missing_browser_evidence_dimensions");
}

export function readFalseEvidenceBlockedSynthesisRepair(
  input: Omit<InlineCompletedRepairInput, "taskPrompt">,
): boolean {
  return completedRepairPolicyActive(
    { ...input, taskPrompt: "" },
    "false_evidence_blocked_synthesis",
  );
}

export function readTimedOutApprovedBrowserSessionContinuation(input: {
  messages: LLMMessage[];
  taskPrompt: string;
  timeoutSignal: SubAgentToolTimeoutSignal;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}): boolean {
  return (
    selectTimeoutContinuationPolicy({
      facts: buildTimeoutContinuationPolicyFacts(input),
    }).policyId === "approved_browser_timeout_continuation"
  );
}

export function readTimedOutSiblingSessionContinuation(input: {
  messages: LLMMessage[];
  taskPrompt: string;
  timeoutSignal: SubAgentToolTimeoutSignal;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}): boolean {
  return (
    selectTimeoutContinuationPolicy({
      facts: buildTimeoutContinuationPolicyFacts(input),
    }).policyId === "coverage_timeout_continuation"
  );
}

export function readIndependentEvidenceStreamsContinuation(input: {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly { name: string }[];
}): boolean {
  return (
    selectIndependentEvidenceStreamsPolicy({
      facts: buildIndependentEvidenceStreamsPolicyFacts({
        ...input,
        taskFacts: produceTaskIntentEnvelope({
          taskPrompt: input.taskPrompt,
          messages: [],
        }).facts,
      }),
    }).kind === "continue"
  );
}

export function readIndependentEvidenceStreamCount(taskPrompt: string): number {
  return produceTaskIntentEnvelope({
    taskPrompt,
    messages: [],
  }).facts.requiredIndependentEvidenceStreams;
}

function naturalRepairPolicyActive(
  input: InlineNaturalRepairInput,
  policyId: RuntimeNaturalFinishRepairPolicyId,
): boolean {
  return (
    selectNaturalFinishRepairPolicy({
      facts: buildNaturalFinishRepairPolicyFacts({
        ...input,
        finalRecoveryBudget: input.finalRecoveryBudget ?? null,
      }),
      enabledPolicies: [policyId],
    })?.policyId === policyId
  );
}

function completedRepairPolicyActive(
  input: InlineCompletedRepairInput,
  policyId: RuntimeCompletedSynthesisRepairPolicyId,
): boolean {
  const evidenceText = input.evidenceText ?? "";
  return (
    selectCompletedSynthesisRepairPolicy({
      facts: buildCompletedSynthesisRepairPolicyFacts({
        completedEvidenceText: evidenceText,
        delegatedEvidenceText: evidenceText,
        completedSessionFinalContents:
          input.completedSessionFinalContents ??
          (evidenceText ? [evidenceText] : []),
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.resultText,
        taskPrompt: input.taskPrompt ?? "",
      }),
      enabledPolicies: [policyId],
    })?.policyId === policyId
  );
}

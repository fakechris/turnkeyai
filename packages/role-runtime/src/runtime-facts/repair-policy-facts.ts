import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  readLegacySourceBoundedEvidenceText,
  findMissingRequiredFinalDeliverables,
  hasMissingRequiredFinalDeliverablesRepairPrompt,
  readLegacyPendingApprovalMention,
  requestsApprovalGatedBrowserAction,
  readLegacyForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair,
  readLegacyApprovalWaitTimeoutCloseoutRepair,
  readLegacyFalseEvidenceBlockedSynthesisRepair,
  readLegacyFinalRecoveryBudgetCloseoutRepair,
  readLegacyIncompleteApprovedBrowserActionRepair,
  readLegacyMissingApprovalGateRepair,
  readLegacyMissingBrowserEvidenceRepair,
  readLegacyMissingBrowserEvidenceDimensionsRepair,
  readLegacyMissingProductSignalBrowserEvidenceRepair,
  readLegacyMissingRequestedNextActionRepair,
  readLegacyPendingApprovalWaitTimeoutCheckRepair,
  readLegacyPrematurePendingApprovalFinalRepair,
  readLegacySourceEvidenceCarryForwardRepair,
  readLegacyStaleDeniedApprovalRepair,
  readLegacyStalePendingApprovalRepair,
  readLegacyTimeoutFollowupFinalGuidanceRepair,
  readLegacyWeakEvidenceSynthesisRepair,
  taskPromptAllowsStoppingAtPendingApproval,
  taskPromptIsAppliedApprovalBrowserContinuation,
  taskPromptRequestsApprovalWaitTimeoutCloseout,
  taskPromptSaysApprovalAlreadyApplied,
  type RequiredFinalDeliverable,
} from "../tool-loop-shared";
import {
  readExtraneousProviderTableSchemaRepair,
  readMissingRequestedTableColumnsRepair,
} from "../task-facts-shared";
import type { PermissionEvidenceFacts, TaskIntentFacts } from "./types";

export interface FinalRecoveryBudgetRepairFactInput {
  maxToolCalls: number;
  usedToolCalls: number;
}

export interface NaturalFinishRepairFactInput {
  activation?: RoleActivationInput | undefined;
  finalRecoveryBudget: FinalRecoveryBudgetRepairFactInput | null;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
  taskPrompt?: string | undefined;
  toolTrace?: NativeToolRoundTrace[] | undefined;
  tools?: readonly { name: string }[] | undefined;
  evidenceText?: string | undefined;
  permissionFacts?: PermissionEvidenceFacts | undefined;
  taskFacts?: TaskIntentFacts | undefined;
}

export interface NaturalFinishRepairPolicyFacts {
  finalRecoveryBudgetCloseoutRepair: boolean;
  missingBrowserEvidence: boolean;
  missingProductSignalBrowserEvidence: boolean;
  missingApprovalGate: boolean;
  pendingApprovalWaitTimeoutCheck: boolean;
  prematurePendingApproval: boolean;
  stalePendingApproval: boolean;
  staleDeniedApproval: boolean;
  approvalWaitTimeoutCloseout: boolean;
  approvalWaitTimeoutLocalCloseout: boolean;
  incompleteApprovedBrowserAction: boolean;
  missingRequestedTableColumns: boolean;
  extraneousProviderTableSchema: boolean;
  sourceEvidenceCarryForward: boolean;
  weakEvidenceSynthesis: boolean;
  sourceEvidenceText: string;
}

export interface CompletedSynthesisRepairFactInput {
  completedEvidenceText: string;
  delegatedEvidenceText: string;
  completedSessionFinalContents: readonly string[];
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
  taskPrompt: string;
}

export interface CompletedSynthesisRepairPolicyFacts {
  timeoutFollowupFinalGuidance: boolean;
  missingRequestedNextAction: boolean;
  missingRequiredFinalDeliverables: boolean;
  missingBrowserEvidenceDimensions: boolean;
  falseEvidenceBlockedSynthesis: boolean;
  missingRequiredDeliverables: readonly RequiredFinalDeliverable[];
}

export function buildNaturalFinishRepairPolicyFacts(
  input: NaturalFinishRepairFactInput,
): NaturalFinishRepairPolicyFacts {
  const sourceEvidenceText = resolveNaturalFinishEvidenceText(input);
  return {
    finalRecoveryBudgetCloseoutRepair:
      shouldSelectFinalRecoveryBudgetCloseoutRepair(input),
    missingBrowserEvidence: shouldSelectMissingBrowserEvidence(input),
    missingProductSignalBrowserEvidence:
      shouldSelectMissingProductSignalBrowserEvidence(input),
    missingApprovalGate: shouldSelectMissingApprovalGate(input),
    pendingApprovalWaitTimeoutCheck:
      shouldSelectPendingApprovalWaitTimeoutCheck(input),
    prematurePendingApproval: shouldSelectPrematurePendingApproval(input),
    stalePendingApproval: shouldSelectStalePendingApproval(input),
    staleDeniedApproval: shouldSelectStaleDeniedApproval(input),
    approvalWaitTimeoutCloseout:
      shouldSelectApprovalWaitTimeoutCloseout(input),
    approvalWaitTimeoutLocalCloseout:
      shouldSelectApprovalWaitTimeoutLocalCloseout(input),
    incompleteApprovedBrowserAction:
      shouldSelectIncompleteApprovedBrowserAction(input),
    missingRequestedTableColumns:
      readMissingRequestedTableColumnsRepair({
        activation: input.activation,
        taskPrompt: input.taskPrompt ?? "",
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.resultText,
      }),
    extraneousProviderTableSchema:
      readExtraneousProviderTableSchemaRepair({
        activation: input.activation,
        taskPrompt: input.taskPrompt ?? "",
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.resultText,
      }),
    sourceEvidenceCarryForward:
      Boolean(sourceEvidenceText) &&
      readLegacySourceEvidenceCarryForwardRepair({
        taskPrompt: input.taskPrompt ?? "",
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        evidenceText: sourceEvidenceText,
      }),
    weakEvidenceSynthesis: readLegacyWeakEvidenceSynthesisRepair({
      taskPrompt: input.taskPrompt ?? "",
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText: sourceEvidenceText,
    }),
    sourceEvidenceText,
  };
}

export function buildCompletedSynthesisRepairPolicyFacts(
  input: CompletedSynthesisRepairFactInput,
): CompletedSynthesisRepairPolicyFacts {
  const missingRequiredDeliverables = findMissingRequiredFinalDeliverables({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
  });
  return {
    timeoutFollowupFinalGuidance: readLegacyTimeoutFollowupFinalGuidanceRepair({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText: input.completedEvidenceText,
    }),
    missingRequestedNextAction: readLegacyMissingRequestedNextActionRepair({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
    }),
    missingRequiredFinalDeliverables:
      missingRequiredDeliverables.length > 0 &&
      !hasMissingRequiredFinalDeliverablesRepairPrompt(input.repairMarkers),
    missingBrowserEvidenceDimensions:
      input.completedSessionFinalContents.length > 0 &&
      readLegacyMissingBrowserEvidenceDimensionsRepair({
        taskPrompt: input.taskPrompt,
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        evidenceText: input.delegatedEvidenceText,
      }),
    falseEvidenceBlockedSynthesis:
      input.completedSessionFinalContents.length > 0 &&
      readLegacyFalseEvidenceBlockedSynthesisRepair({
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        evidenceText: input.delegatedEvidenceText,
      }),
    missingRequiredDeliverables,
  };
}

function shouldSelectFinalRecoveryBudgetCloseoutRepair(
  input: NaturalFinishRepairFactInput,
): boolean {
  const budget = input.finalRecoveryBudget;
  return (
    Boolean(budget) &&
    budget!.usedToolCalls >= budget!.maxToolCalls &&
    readLegacyFinalRecoveryBudgetCloseoutRepair({
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      resultText: input.resultText,
    })
  );
}

function shouldSelectMissingApprovalGate(
  input: NaturalFinishRepairFactInput,
): boolean {
  return Boolean(
    input.taskPrompt &&
      input.toolTrace &&
      readLegacyMissingApprovalGateRepair({
        taskPrompt: input.taskPrompt,
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        toolTrace: input.toolTrace,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      }),
  );
}

function shouldSelectMissingBrowserEvidence(
  input: NaturalFinishRepairFactInput,
): boolean {
  if (!input.taskPrompt || !input.toolTrace) return false;
  if (input.taskFacts && !input.taskFacts.browserVisibleEvidenceRequired) {
    return false;
  }
  return readLegacyMissingBrowserEvidenceRepair({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
    messages: input.messages,
    repairMarkers: input.repairMarkers,
    toolTrace: input.toolTrace,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
  });
}

function shouldSelectMissingProductSignalBrowserEvidence(
  input: NaturalFinishRepairFactInput,
): boolean {
  if (!input.taskPrompt || !input.toolTrace) return false;
  if (
    input.taskFacts &&
    !input.taskFacts.productSignalDashboardEvidenceRequested
  ) {
    return false;
  }
  return readLegacyMissingProductSignalBrowserEvidenceRepair({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
    messages: input.messages,
    repairMarkers: input.repairMarkers,
    toolTrace: input.toolTrace,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.evidenceText === undefined ? {} : { evidenceText: input.evidenceText }),
  });
}

function shouldSelectPendingApprovalWaitTimeoutCheck(
  input: NaturalFinishRepairFactInput,
): boolean {
  if (!input.taskPrompt || !input.toolTrace) return false;
  if (input.permissionFacts) {
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval decision has not arrived",
      ) &&
      taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt) &&
      input.permissionFacts.latestToolName === "permission_query"
    );
  }
  return readLegacyPendingApprovalWaitTimeoutCheckRepair({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
    messages: input.messages,
    repairMarkers: input.repairMarkers,
    toolTrace: input.toolTrace,
  });
}

function shouldSelectPrematurePendingApproval(
  input: NaturalFinishRepairFactInput,
): boolean {
  if (!input.taskPrompt || !input.toolTrace) return false;
  if (input.permissionFacts) {
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval-gated browser action is still pending",
      ) &&
      readLegacyPendingApprovalMention(input.resultText) &&
      requestsApprovalGatedBrowserAction(input.taskPrompt) &&
      !taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt) &&
      !taskPromptAllowsStoppingAtPendingApproval(input.taskPrompt) &&
      !input.permissionFacts.appliedApproval &&
      !taskPromptSaysApprovalAlreadyApplied(input.taskPrompt) &&
      !hasSessionToolEvidence(input.toolTrace) &&
      (input.permissionFacts.latestToolName === "permission_query" ||
        input.permissionFacts.latestResultStatus === "pending")
    );
  }
  return readLegacyPrematurePendingApprovalFinalRepair({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
    messages: input.messages,
    repairMarkers: input.repairMarkers,
    toolTrace: input.toolTrace,
  });
}

function shouldSelectStalePendingApproval(
  input: NaturalFinishRepairFactInput,
): boolean {
  if (!input.taskPrompt || !input.toolTrace) return false;
  if (input.permissionFacts) {
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval already applied",
      ) &&
      readLegacyPendingApprovalMention(input.resultText) &&
      (requestsApprovalGatedBrowserAction(input.taskPrompt) ||
        taskPromptIsAppliedApprovalBrowserContinuation(input.taskPrompt)) &&
      (input.permissionFacts.appliedApproval ||
        taskPromptSaysApprovalAlreadyApplied(input.taskPrompt) ||
        taskPromptIsAppliedApprovalBrowserContinuation(input.taskPrompt))
    );
  }
  return readLegacyStalePendingApprovalRepair({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
    messages: input.messages,
    repairMarkers: input.repairMarkers,
    toolTrace: input.toolTrace,
  });
}

function shouldSelectStaleDeniedApproval(
  input: NaturalFinishRepairFactInput,
): boolean {
  if (!input.taskPrompt || !input.toolTrace) return false;
  if (input.permissionFacts) {
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval was denied",
      ) &&
      readLegacyPendingApprovalMention(input.resultText) &&
      requestsApprovalGatedBrowserAction(input.taskPrompt) &&
      input.permissionFacts.deniedApproval
    );
  }
  return readLegacyStaleDeniedApprovalRepair({
    taskPrompt: input.taskPrompt,
    resultText: input.resultText,
    messages: input.messages,
    repairMarkers: input.repairMarkers,
    toolTrace: input.toolTrace,
  });
}

function shouldSelectApprovalWaitTimeoutCloseout(
  input: NaturalFinishRepairFactInput,
): boolean {
  return Boolean(
    input.taskPrompt &&
      input.toolTrace &&
      (!input.permissionFacts || input.permissionFacts.waitTimeout) &&
      readLegacyApprovalWaitTimeoutCloseoutRepair({
        taskPrompt: input.taskPrompt,
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        toolTrace: input.toolTrace,
      }),
  );
}

function shouldSelectApprovalWaitTimeoutLocalCloseout(
  input: NaturalFinishRepairFactInput,
): boolean {
  return Boolean(
    input.taskPrompt &&
      input.toolTrace &&
      (!input.permissionFacts || input.permissionFacts.waitTimeout) &&
      readLegacyForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair({
        taskPrompt: input.taskPrompt,
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        toolTrace: input.toolTrace,
      }),
  );
}

function shouldSelectIncompleteApprovedBrowserAction(
  input: NaturalFinishRepairFactInput,
): boolean {
  return Boolean(
    input.taskPrompt &&
      input.toolTrace &&
      readLegacyIncompleteApprovedBrowserActionRepair({
        taskPrompt: input.taskPrompt,
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        toolTrace: input.toolTrace,
      }),
  );
}

function resolveNaturalFinishEvidenceText(
  input: NaturalFinishRepairFactInput,
): string {
  if (input.evidenceText !== undefined) return input.evidenceText;
  if (!input.taskPrompt || !input.toolTrace) return "";
  return readLegacySourceBoundedEvidenceText({
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
  });
}

function hasNaturalFinishRepairMarker(
  messages: readonly LLMMessage[],
  marker: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.includes(marker),
  );
}

function hasSessionToolEvidence(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some(
    (round) =>
      round.calls.some(
        (call) => call.name === "sessions_spawn" || call.name === "sessions_send",
      ) ||
      round.results.some(
        (result) =>
          result.toolName === "sessions_spawn" ||
          result.toolName === "sessions_send",
      ),
  );
}

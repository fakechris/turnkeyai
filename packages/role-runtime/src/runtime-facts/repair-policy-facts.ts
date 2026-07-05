import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  readPolicySourceBoundedEvidenceText,
  findMissingRequiredFinalDeliverables,
  readPolicyPendingApprovalMention,
  readPolicyForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair,
  readPolicyApprovalWaitTimeoutCloseoutRepair,
  readPolicyFalseEvidenceBlockedSynthesisRepair,
  readPolicyFinalRecoveryBudgetCloseoutRepair,
  readPolicyIncompleteApprovedBrowserActionRepair,
  readPolicyMissingApprovalGateRepair,
  readPolicyMissingBrowserEvidenceRepair,
  readPolicyMissingBrowserEvidenceDimensionsRepair,
  readPolicyMissingProductSignalBrowserEvidenceRepair,
  readPolicyMissingRequestedNextActionRepair,
  readPolicyPendingApprovalWaitTimeoutCheckRepair,
  readPolicyPrematurePendingApprovalFinalRepair,
  readPolicySourceEvidenceCarryForwardRepair,
  readPolicyStaleDeniedApprovalRepair,
  readPolicyStalePendingApprovalRepair,
  readPolicyTimeoutFollowupFinalGuidanceRepair,
  readPolicyWeakEvidenceSynthesisRepair,
} from "./text-fallback-readers";
import { hasMissingRequiredFinalDeliverablesRepairPrompt } from "./repair-marker-facts";
import type { RequiredFinalDeliverable } from "./text-fallback-readers";
import { produceTaskIntentEnvelope } from "./task-intent-producer";
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
      readPolicySourceEvidenceCarryForwardRepair({
        taskPrompt: input.taskPrompt ?? "",
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        evidenceText: sourceEvidenceText,
      }),
    weakEvidenceSynthesis: readPolicyWeakEvidenceSynthesisRepair({
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
    timeoutFollowupFinalGuidance: readPolicyTimeoutFollowupFinalGuidanceRepair({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      evidenceText: input.completedEvidenceText,
    }),
    missingRequestedNextAction: readPolicyMissingRequestedNextActionRepair({
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
      readPolicyMissingBrowserEvidenceDimensionsRepair({
        taskPrompt: input.taskPrompt,
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        evidenceText: input.delegatedEvidenceText,
      }),
    falseEvidenceBlockedSynthesis:
      input.completedSessionFinalContents.length > 0 &&
      readPolicyFalseEvidenceBlockedSynthesisRepair({
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
    readPolicyFinalRecoveryBudgetCloseoutRepair({
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      resultText: input.resultText,
    })
  );
}

function resolveRepairTaskFacts(
  input: NaturalFinishRepairFactInput,
): TaskIntentFacts {
  return (
    input.taskFacts ??
    produceTaskIntentEnvelope({
      taskPrompt: input.taskPrompt ?? "",
      activation: input.activation,
      messages: input.messages,
    }).facts
  );
}

function shouldSelectMissingApprovalGate(
  input: NaturalFinishRepairFactInput,
): boolean {
  return Boolean(
    input.taskPrompt &&
      input.toolTrace &&
      readPolicyMissingApprovalGateRepair({
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
  return readPolicyMissingBrowserEvidenceRepair({
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
  return readPolicyMissingProductSignalBrowserEvidenceRepair({
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
    const taskFacts = resolveRepairTaskFacts(input);
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval decision has not arrived",
      ) &&
      taskFacts.approvalWaitTimeoutCloseoutRequested &&
      input.permissionFacts.latestToolName === "permission_query"
    );
  }
  return readPolicyPendingApprovalWaitTimeoutCheckRepair({
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
    const taskFacts = resolveRepairTaskFacts(input);
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval-gated browser action is still pending",
      ) &&
      readPolicyPendingApprovalMention(input.resultText) &&
      taskFacts.approvalGatedBrowserActionRequested &&
      !taskFacts.approvalWaitTimeoutCloseoutRequested &&
      !taskFacts.stopAtPendingApprovalAllowed &&
      !input.permissionFacts.appliedApproval &&
      !taskFacts.approvalAlreadyApplied &&
      !hasSessionToolEvidence(input.toolTrace) &&
      (input.permissionFacts.latestToolName === "permission_query" ||
        input.permissionFacts.latestResultStatus === "pending")
    );
  }
  return readPolicyPrematurePendingApprovalFinalRepair({
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
    const taskFacts = resolveRepairTaskFacts(input);
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval already applied",
      ) &&
      readPolicyPendingApprovalMention(input.resultText) &&
      (taskFacts.approvalGatedBrowserActionRequested ||
        taskFacts.appliedApprovalBrowserContinuation) &&
      (input.permissionFacts.appliedApproval ||
        taskFacts.approvalAlreadyApplied ||
        taskFacts.appliedApprovalBrowserContinuation)
    );
  }
  return readPolicyStalePendingApprovalRepair({
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
    const taskFacts = resolveRepairTaskFacts(input);
    return (
      !hasNaturalFinishRepairMarker(
        input.repairMarkers,
        "Runtime correction: approval was denied",
      ) &&
      readPolicyPendingApprovalMention(input.resultText) &&
      taskFacts.approvalGatedBrowserActionRequested &&
      input.permissionFacts.deniedApproval
    );
  }
  return readPolicyStaleDeniedApprovalRepair({
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
      readPolicyApprovalWaitTimeoutCloseoutRepair({
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
      readPolicyForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair({
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
      readPolicyIncompleteApprovedBrowserActionRepair({
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
  return readPolicySourceBoundedEvidenceText({
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

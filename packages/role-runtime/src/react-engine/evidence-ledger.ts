// Stage 8 engine cleanup — EvidenceLedger (module shell).
//
// Authority: centralize structured facts (source labels, browser evidence
// dimensions, completed session facts, timeout/cancellation facts, permission
// result facts) read from tool results, messages, prompt packet, and
// activation. It starts as a facade over existing helpers, not a producer
// rewrite.
//
// It does NOT own policy order, tool execution, or final synthesis. Policies may
// read the EvidenceSnapshot it produces; they may not invent inline regexes.
//
// Implementation lands in Batch 5 ("Add EvidenceLedger And TaskFacts Facade").
// This first implementation is a behavior-neutral facade over existing shared
// collectors so extracted policies can depend on a stable engine evidence
// contract before the producer rewrite.
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RoleToolExecutionResult } from "../tool-use";
import {
  collectApprovalWaitTimeoutRuntimeEvidence,
  collectCompletedSessionEvidenceText,
  collectSourceBoundedEvidenceText,
  hasPermissionAppliedEvidence,
  latestPermissionResultStatus,
  latestPermissionToolName,
} from "../tool-loop-shared";
import {
  collectCompletedSessionEvidenceFacts,
  collectSubAgentTimeoutFacts,
  collectToolResultContentText,
  collectToolTraceResultContent,
  hasUsableEvidence,
  type CompletedSessionEvidenceSummary,
  type CompletedSessionEvidenceFact,
  type TimeoutEvidenceFact,
} from "../tool-result-evidence";

export const EVIDENCE_LEDGER_MODULE = "evidence-ledger" as const;

export interface EvidenceLedgerInput {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}

export interface EvidenceLedgerRunInput {
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
}

export interface EvidenceSnapshot {
  sourceBoundedEvidenceText: string;
  completedSessionEvidenceText: string;
  naturalFinishEvidenceText: string;
  toolTraceResultContent: string;
  approvalWaitTimeoutRuntimeEvidence: string;
  permission: PermissionEvidenceFacts;
  usableEvidence: boolean;
}

export type PermissionStatus =
  | "none"
  | "pending"
  | "applied"
  | "denied"
  | "wait_timeout";

export interface PermissionEvidenceFacts {
  latestStatus: PermissionStatus;
  latestToolName: string | null;
  latestResultStatus: string | null;
  pendingApproval: boolean;
  appliedApproval: boolean;
  deniedApproval: boolean;
  waitTimeout: boolean;
  runtimeEvidenceText: string;
}

export interface EvidenceRoundSnapshot {
  toolResultContentText: string;
  completedSession: CompletedSessionEvidenceSummary | null;
  completedSessions: readonly CompletedSessionEvidenceFact[];
  completedSessionFinalContents: readonly string[] | null;
  timeoutSignal: TimeoutEvidenceFact | null;
  timeoutSignals: readonly TimeoutEvidenceFact[];
}

export interface EvidenceRunSnapshotter {
  snapshot(messages: LLMMessage[]): EvidenceSnapshot;
}

export class EvidenceLedger {
  snapshot(input: EvidenceLedgerInput): EvidenceSnapshot {
    return buildEvidenceSnapshot(input);
  }

  forRun(input: EvidenceLedgerRunInput): EvidenceRunSnapshotter {
    return buildEvidenceRunSnapshotter(input);
  }

  currentRound(results: RoleToolExecutionResult[]): EvidenceRoundSnapshot {
    return buildEvidenceRoundSnapshot(results);
  }

  toolResultContentText(results: RoleToolExecutionResult[]): string {
    return buildToolResultContentText(results);
  }

  completedSessionEvidence(
    results: RoleToolExecutionResult[],
  ): CompletedSessionEvidenceSummary | null {
    return summarizeCompletedSessionFacts(
      collectCompletedSessionEvidenceFacts(results),
    );
  }

  subAgentToolTimeout(
    results: RoleToolExecutionResult[],
  ): TimeoutEvidenceFact | null {
    return collectSubAgentTimeoutFacts(results)[0] ?? null;
  }
}

export function createEvidenceLedger(): EvidenceLedger {
  return new EvidenceLedger();
}

export function buildEvidenceSnapshot(
  input: EvidenceLedgerInput,
): EvidenceSnapshot {
  const sourceBoundedEvidenceText = collectSourceBoundedEvidenceText({
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
  });
  const completedSessionEvidenceText = collectCompletedSessionEvidenceText(
    input.toolTrace,
  );
  const toolTraceResultContent = collectToolTraceResultContent(input.toolTrace);
  const approvalWaitTimeoutRuntimeEvidence =
    collectApprovalWaitTimeoutRuntimeEvidence(input.toolTrace);
  const permission = buildPermissionEvidenceFacts({
    toolTrace: input.toolTrace,
    runtimeEvidenceText: approvalWaitTimeoutRuntimeEvidence,
  });
  return {
    sourceBoundedEvidenceText,
    completedSessionEvidenceText,
    toolTraceResultContent,
    approvalWaitTimeoutRuntimeEvidence,
    permission,
    usableEvidence: hasUsableEvidence(input.toolTrace),
    naturalFinishEvidenceText: [
      sourceBoundedEvidenceText,
      completedSessionEvidenceText,
    ]
      .filter((text) => text.trim().length > 0)
      .join("\n\n"),
  };
}

export function buildEvidenceRunSnapshotter(
  input: EvidenceLedgerRunInput,
): EvidenceRunSnapshotter {
  return {
    snapshot: (messages) =>
      buildEvidenceSnapshot({
        taskPrompt: input.taskPrompt,
        messages,
        toolTrace: input.toolTrace,
      }),
  };
}

export function buildToolResultContentText(
  results: RoleToolExecutionResult[],
): string {
  return collectToolResultContentText(results);
}

export function buildPermissionEvidenceFacts(input: {
  toolTrace: NativeToolRoundTrace[];
  runtimeEvidenceText: string;
}): PermissionEvidenceFacts {
  const latestToolName = latestPermissionToolName(input.toolTrace);
  const latestResultStatus = latestPermissionResultStatus(input.toolTrace);
  const resultWaitTimeout =
    latestResultStatus === "approval_wait_timeout" ||
    latestResultStatus === "wait_timeout";
  const runtimeWaitTimeout = input.runtimeEvidenceText
    .toLowerCase()
    .includes("approval_wait_timeout");
  const waitTimeout =
    resultWaitTimeout || latestResultStatus === "pending" || runtimeWaitTimeout;
  const deniedApproval = latestResultStatus === "denied";
  const appliedApproval =
    latestResultStatus === "applied" ||
    latestToolName === "permission_applied" ||
    hasPermissionAppliedEvidence(input.toolTrace);
  const pendingApproval =
    waitTimeout ||
    latestResultStatus === "pending" ||
    latestToolName === "permission_query";
  const latestStatus: PermissionStatus =
    resultWaitTimeout || runtimeWaitTimeout
      ? "wait_timeout"
      : deniedApproval
        ? "denied"
        : appliedApproval
          ? "applied"
          : pendingApproval
            ? "pending"
            : "none";
  return {
    latestStatus,
    latestToolName,
    latestResultStatus,
    pendingApproval,
    appliedApproval,
    deniedApproval,
    waitTimeout,
    runtimeEvidenceText: input.runtimeEvidenceText,
  };
}

export function buildEvidenceRoundSnapshot(
  results: RoleToolExecutionResult[],
): EvidenceRoundSnapshot {
  const completedSessions = collectCompletedSessionEvidenceFacts(results);
  const completedSession = summarizeCompletedSessionFacts(completedSessions);
  const timeoutSignals = collectSubAgentTimeoutFacts(results);
  return {
    toolResultContentText: buildToolResultContentText(results),
    completedSession,
    completedSessions,
    completedSessionFinalContents: completedSession?.finalContents ?? null,
    timeoutSignal: timeoutSignals[0] ?? null,
    timeoutSignals,
  };
}

export type { CompletedSessionEvidenceFact, TimeoutEvidenceFact };

function summarizeCompletedSessionFacts(
  facts: readonly CompletedSessionEvidenceFact[],
): CompletedSessionEvidenceSummary | null {
  const finalContents = facts.flatMap((fact) => fact.finalContents);
  if (facts.length === 0 || finalContents.length === 0) {
    return null;
  }
  return {
    toolName: facts[0]?.toolName ?? "sessions_spawn",
    finalContents,
    browserRecoverySummaries: facts.flatMap(
      (fact) => fact.browserRecoverySummaries,
    ),
  };
}

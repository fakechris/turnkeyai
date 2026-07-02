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
} from "../tool-loop-shared";
import {
  collectToolResultContentText,
  collectToolTraceResultContent,
  findCompletedSessionEvidence,
  findSubAgentToolTimeout,
  hasUsableEvidence,
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
  usableEvidence: boolean;
}

export interface EvidenceRoundSnapshot {
  toolResultContentText: string;
  completedSession: ReturnType<typeof findCompletedSessionEvidence>;
  completedSessionFinalContents: readonly string[] | null;
  timeoutSignal: ReturnType<typeof findSubAgentToolTimeout>;
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
  ): ReturnType<typeof findCompletedSessionEvidence> {
    return findCompletedSessionEvidence(results);
  }

  subAgentToolTimeout(
    results: RoleToolExecutionResult[],
  ): ReturnType<typeof findSubAgentToolTimeout> {
    return findSubAgentToolTimeout(results);
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
  return {
    sourceBoundedEvidenceText,
    completedSessionEvidenceText,
    toolTraceResultContent,
    approvalWaitTimeoutRuntimeEvidence,
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

export function buildEvidenceRoundSnapshot(
  results: RoleToolExecutionResult[],
): EvidenceRoundSnapshot {
  const completedSession = findCompletedSessionEvidence(results);
  return {
    toolResultContentText: buildToolResultContentText(results),
    completedSession,
    completedSessionFinalContents: completedSession?.finalContents ?? null,
    timeoutSignal: findSubAgentToolTimeout(results),
  };
}

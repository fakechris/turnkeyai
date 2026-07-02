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
  hasUsableEvidence,
} from "../tool-result-evidence";

export const EVIDENCE_LEDGER_MODULE = "evidence-ledger" as const;

export interface EvidenceLedgerInput {
  taskPrompt: string;
  messages: LLMMessage[];
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

export class EvidenceLedger {
  snapshot(input: EvidenceLedgerInput): EvidenceSnapshot {
    return buildEvidenceSnapshot(input);
  }

  toolResultContentText(results: RoleToolExecutionResult[]): string {
    return buildToolResultContentText(results);
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

export function buildToolResultContentText(
  results: RoleToolExecutionResult[],
): string {
  return collectToolResultContentText(results);
}

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

import {
  buildRuntimeFactBundle,
  buildRuntimeRoundFactBundle,
  type RuntimeFactEnvelope,
} from "../runtime-facts/runtime-fact-bundle";
import type {
  FinalSynthesisTextViews,
  PermissionEvidenceFacts as RuntimePermissionEvidenceFacts,
  PermissionStatus,
  RuntimePolicySnapshot,
  RuntimeRoundFinalTextViews,
  RuntimeRoundPolicySnapshot,
  CompletedSessionFact,
  TimeoutSignalFact,
} from "../runtime-facts/types";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RoleToolExecutionResult } from "../tool-use";
import {
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
  synthesisEvidenceText: string;
  toolTraceResultContent: string;
  approvalWaitTimeoutRuntimeEvidence: string;
  approvalEvidenceText: string;
  permission: PermissionEvidenceFacts;
  usableEvidence: boolean;
  envelopes?: readonly RuntimeFactEnvelope[];
  policy?: RuntimePolicySnapshot;
  finalText?: FinalSynthesisTextViews;
}

export type { PermissionStatus };

export interface PermissionEvidenceFacts extends RuntimePermissionEvidenceFacts {
  runtimeEvidenceText: string;
}

export interface EvidenceRoundSnapshot {
  toolResultContentText: string;
  roundEvidenceText: string;
  completedSession: CompletedSessionEvidenceSummary | null;
  completedSessions: readonly CompletedSessionEvidenceFact[];
  completedSessionFinalContents: readonly string[] | null;
  timeoutSignal: TimeoutEvidenceFact | null;
  timeoutSignals: readonly TimeoutEvidenceFact[];
  envelopes?: readonly RuntimeFactEnvelope[];
  policy?: RuntimeRoundPolicySnapshot;
  finalText?: RuntimeRoundFinalTextViews;
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

  roundEvidenceText(results: RoleToolExecutionResult[]): string {
    return buildToolResultContentText(results);
  }

  completedSessionEvidence(
    results: RoleToolExecutionResult[],
  ): CompletedSessionEvidenceSummary | null {
    return summarizeCompletedSessionFacts(
      buildRuntimeRoundFactBundle({ results }).policy.session.completedSessions.map(
        toCompletedSessionEvidenceFact,
      ),
    );
  }

  subAgentToolTimeout(
    results: RoleToolExecutionResult[],
  ): TimeoutEvidenceFact | null {
    const timeout = buildRuntimeRoundFactBundle({ results }).policy.session
      .timeoutSignal;
    return timeout ? toTimeoutEvidenceFact(timeout) : null;
  }
}

export function createEvidenceLedger(): EvidenceLedger {
  return new EvidenceLedger();
}

export function buildEvidenceSnapshot(
  input: EvidenceLedgerInput,
): EvidenceSnapshot {
  const bundle = buildRuntimeFactBundle(input);
  const { finalText } = bundle;
  const permission = buildPermissionEvidenceFacts(
    bundle.policy.permission,
    finalText.approvalWaitTimeoutRuntimeEvidence,
  );
  return {
    sourceBoundedEvidenceText: finalText.sourceBoundedEvidenceText,
    completedSessionEvidenceText: finalText.completedSessionEvidenceText,
    toolTraceResultContent: finalText.toolTraceResultContent,
    approvalWaitTimeoutRuntimeEvidence:
      finalText.approvalWaitTimeoutRuntimeEvidence,
    approvalEvidenceText: finalText.approvalWaitTimeoutRuntimeEvidence,
    permission,
    usableEvidence: bundle.policy.usable.usableEvidence,
    naturalFinishEvidenceText: finalText.naturalFinishEvidenceText,
    synthesisEvidenceText: finalText.naturalFinishEvidenceText,
    envelopes: bundle.envelopes,
    policy: bundle.policy,
    finalText,
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
  return buildRuntimeRoundFactBundle({ results }).finalText.toolResultContentText;
}

export function buildPermissionEvidenceFacts(
  facts: RuntimePermissionEvidenceFacts,
  runtimeEvidenceText: string,
): PermissionEvidenceFacts {
  return {
    ...facts,
    runtimeEvidenceText,
  };
}

export function buildEvidenceRoundSnapshot(
  results: RoleToolExecutionResult[],
): EvidenceRoundSnapshot {
  const bundle = buildRuntimeRoundFactBundle({ results });
  const completedSessions =
    bundle.policy.session.completedSessions.map(toCompletedSessionEvidenceFact);
  const completedSession = summarizeCompletedSessionFacts(completedSessions);
  const timeoutSignals =
    bundle.policy.session.timeoutSignals.map(toTimeoutEvidenceFact);
  return {
    toolResultContentText: bundle.finalText.toolResultContentText,
    roundEvidenceText: bundle.finalText.toolResultContentText,
    completedSession,
    completedSessions,
    completedSessionFinalContents: completedSession?.finalContents ?? null,
    timeoutSignal: timeoutSignals[0] ?? null,
    timeoutSignals,
    envelopes: bundle.envelopes,
    policy: bundle.policy,
    finalText: bundle.finalText,
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

function toCompletedSessionEvidenceFact(
  fact: CompletedSessionFact,
): CompletedSessionEvidenceFact {
  return {
    toolName: fact.toolName ?? "sessions_spawn",
    ...(fact.sessionKey === null ? {} : { sessionKey: fact.sessionKey }),
    ...(fact.agentId === null ? {} : { agentId: fact.agentId }),
    finalContents: fact.finalContents,
    browserRecoverySummaries: fact.browserRecoverySummaries,
  };
}

function toTimeoutEvidenceFact(fact: TimeoutSignalFact): TimeoutEvidenceFact {
  return {
    toolName: fact.toolName ?? "sessions_send",
    sessionKey: fact.sessionKey ?? "",
    agentId: fact.agentId ?? "",
    timeoutSeconds: fact.seconds,
    evidenceAvailable: fact.evidenceAvailable,
  };
}

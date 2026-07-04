import type { NativeToolRoundTrace } from "../native-tool-messages";
import { parseSessionToolResult } from "../session-tool-result-protocol";
import {
  readBrowserRecoverySummary,
  readCompletedSessionEvidence,
  readInlineBrowserRecoverySummary,
} from "../tool-loop-shared";
import { readSessionHistoryEvidence } from "../tool-result-evidence";
import type { RoleToolExecutionResult } from "../tool-use";
import type {
  CompletedSessionFact,
  EvidenceEnvelope,
  EvidenceProvenance,
  RuntimeFactInput,
  RuntimeRoundFactInput,
  SessionEvidenceFacts,
  TimeoutSignalFact,
} from "./types";

export function produceSessionEvidenceEnvelope(
  input: Pick<RuntimeFactInput, "toolTrace">,
): EvidenceEnvelope<"session_evidence", SessionEvidenceFacts> {
  const results = input.toolTrace.flatMap((round) =>
    round.results.map((result) => ({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      content: result.content ?? "",
      isError: result.isError,
      contentBytes: result.contentBytes,
      ...(result.contentTruncated === undefined
        ? {}
        : { contentTruncated: result.contentTruncated }),
      ...(result.cancelled === undefined ? {} : { cancelled: result.cancelled }),
      ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
    })),
  ) as RoleToolExecutionResult[];
  return buildSessionEvidenceEnvelope(results, input.toolTrace);
}

export function produceSessionEvidenceEnvelopeFromRound(
  input: RuntimeRoundFactInput,
): EvidenceEnvelope<"session_evidence", SessionEvidenceFacts> {
  return buildSessionEvidenceEnvelope(input.results, []);
}

function buildSessionEvidenceEnvelope(
  results: RoleToolExecutionResult[],
  toolTrace: NativeToolRoundTrace[],
): EvidenceEnvelope<"session_evidence", SessionEvidenceFacts> {
  const completedSessions = collectCompletedSessions(results);
  const timeoutSignals = collectTimeoutSignals(results);
  return {
    kind: "session_evidence",
    schemaVersion: 1,
    facts: {
      completedSession: completedSessions[0] ?? null,
      completedSessions,
      completedSessionFinalContents: completedSessions[0]?.finalContents ?? null,
      completedStreamLabels: dedupeStrings(
        completedSessions
          .map((session) => session.streamLabel)
          .filter((label): label is string => Boolean(label)),
      ),
      timeoutSignal: timeoutSignals[0] ?? null,
      timeoutSignals,
      resumableTimeouts: timeoutSignals.filter((signal) => signal.resumable),
    },
    provenance: buildSessionProvenance(results, toolTrace),
  };
}

function collectCompletedSessions(
  results: RoleToolExecutionResult[],
): CompletedSessionFact[] {
  const facts: CompletedSessionFact[] = [];
  for (const result of results) {
    if (result.isError || result.cancelled || result.skipped) {
      continue;
    }
    if (
      result.toolName !== "sessions_spawn" &&
      result.toolName !== "sessions_send" &&
      result.toolName !== "sessions_history"
    ) {
      continue;
    }
    if (result.toolName === "sessions_history") {
      const historyEvidence = readSessionHistoryEvidence(result.content);
      if (!historyEvidence) continue;
      const identity = readSessionHistoryIdentity(result.content);
      facts.push({
        toolName: result.toolName,
        sessionKey: identity.sessionKey,
        agentId: identity.agentId,
        finalContents: [historyEvidence],
        streamLabel: null,
        browserRecoverySummary: null,
        browserRecoverySummaries: [],
      });
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed || parsed.status !== "completed") {
      continue;
    }
    const finalContent = readCompletedSessionEvidence(parsed);
    if (!finalContent) {
      continue;
    }
    const browserRecoverySummaries = readBrowserRecoveryFromParsedSession(parsed);
    facts.push({
      toolName: result.toolName,
      sessionKey: parsed.session_key,
      agentId: parsed.agent_id,
      finalContents: [finalContent],
      streamLabel: parsed.parent_session_key ? null : parsed.label ?? null,
      browserRecoverySummary: browserRecoverySummaries.join("\n\n") || null,
      browserRecoverySummaries,
    });
  }
  return facts;
}

function collectTimeoutSignals(
  results: RoleToolExecutionResult[],
): TimeoutSignalFact[] {
  const facts: TimeoutSignalFact[] = [];
  for (const result of results) {
    if (
      result.toolName !== "sessions_spawn" &&
      result.toolName !== "sessions_send"
    ) {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed || parsed.status !== "timeout") {
      continue;
    }
    facts.push({
      toolName: result.toolName,
      sessionKey: parsed.session_key,
      agentId: parsed.agent_id,
      seconds:
        typeof parsed.timeout_seconds === "number"
          ? parsed.timeout_seconds
          : null,
      resumable: parsed.resumable !== false,
      evidenceAvailable:
        parsed.evidence_available === true ||
        typeof parsed.evidence_summary === "string",
    });
  }
  return facts;
}

function readBrowserRecoveryFromParsedSession(
  parsed: NonNullable<ReturnType<typeof parseSessionToolResult>>,
): string[] {
  const summaries: string[] = [];
  const payload = parsed.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const summary = readBrowserRecoverySummary(
      payload as Record<string, unknown>,
    );
    if (summary) summaries.push(summary);
  }
  const inlineSummary = readInlineBrowserRecoverySummary(
    [parsed.evidence_summary, parsed.result, parsed.final_content].filter(
      (item): item is string => typeof item === "string",
    ),
  );
  if (inlineSummary) summaries.push(inlineSummary);
  return dedupeStrings(summaries);
}

function readSessionHistoryIdentity(content: string): {
  sessionKey: string | null;
  agentId: string | null;
} {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      sessionKey:
        typeof parsed["session_key"] === "string" ? parsed["session_key"] : null,
      agentId:
        typeof parsed["agent_id"] === "string" ? parsed["agent_id"] : null,
    };
  } catch {
    return { sessionKey: null, agentId: null };
  }
}

function buildSessionProvenance(
  results: RoleToolExecutionResult[],
  toolTrace: NativeToolRoundTrace[],
): EvidenceProvenance[] {
  if (toolTrace.length > 0) {
    return toolTrace.flatMap((round, traceIndex) =>
      round.results
        .filter((result) => isSessionToolName(result.toolName))
        .map((result) => ({
          source: "native_tool_trace" as const,
          toolName: result.toolName,
          toolCallId: result.toolCallId,
          roundIndex: round.round,
          traceIndex,
          messageIndex: null,
        })),
    );
  }
  return results
    .filter((result) => isSessionToolName(result.toolName))
    .map((result) => ({
      source: "tool_result",
      toolName: result.toolName,
      toolCallId: result.toolCallId ?? null,
      roundIndex: null,
      traceIndex: null,
      messageIndex: null,
    }));
}

function isSessionToolName(toolName: string): boolean {
  return (
    toolName === "sessions_spawn" ||
    toolName === "sessions_send" ||
    toolName === "sessions_history"
  );
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "./native-tool-messages";
import { parseSessionToolResult } from "./session-tool-result-protocol";
import {
  dedupeStrings,
  hasApprovedBrowserTimeoutContinuationPrompt,
  hasCoverageTimeoutContinuationPrompt,
  hasExecutedSessionsSend,
  isAppliedApprovalBrowserContinuation,
  isCoverageCriticalDelegationTask,
  readBrowserRecoverySummary,
  readCompletedSessionEvidence,
  readInlineBrowserRecoverySummary,
  sliceUtf8,
  type SubAgentToolTimeoutSignal,
} from "./tool-loop-shared";
import type { RoleToolExecutionResult } from "./tool-use";

export interface CompletedSessionEvidenceSummary {
  toolName: string;
  finalContents: string[];
  browserRecoverySummaries: string[];
}

export function findSubAgentToolTimeout(
  results: RoleToolExecutionResult[],
): SubAgentToolTimeoutSignal | null {
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
    const timeoutSeconds = parsed.timeout_seconds;
    const evidenceAvailable =
      parsed.evidence_available === true ||
      typeof parsed.evidence_summary === "string";
    return {
      toolName: result.toolName,
      sessionKey: parsed.session_key,
      agentId: parsed.agent_id,
      timeoutSeconds:
        typeof timeoutSeconds === "number" ? timeoutSeconds : null,
      evidenceAvailable,
    };
  }
  return null;
}

export function findCompletedSessionEvidence(
  results: RoleToolExecutionResult[],
): CompletedSessionEvidenceSummary | null {
  const finalContents: string[] = [];
  const browserRecoverySummaries: string[] = [];
  let toolName: string | null = null;
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
      if (historyEvidence) {
        toolName = toolName ?? result.toolName;
        finalContents.push(historyEvidence);
      }
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
    const payload = parsed.payload;
    toolName = toolName ?? result.toolName;
    finalContents.push(finalContent);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const browserRecoverySummary = readBrowserRecoverySummary(
        payload as Record<string, unknown>,
      );
      if (browserRecoverySummary) {
        browserRecoverySummaries.push(browserRecoverySummary);
      }
    }
    const inlineBrowserRecoverySummary = readInlineBrowserRecoverySummary(
      [parsed.evidence_summary, parsed.result, parsed.final_content].filter(
        (item): item is string => typeof item === "string",
      ),
    );
    if (inlineBrowserRecoverySummary) {
      browserRecoverySummaries.push(inlineBrowserRecoverySummary);
    }
  }
  return toolName && finalContents.length > 0
    ? { toolName, finalContents, browserRecoverySummaries }
    : null;
}

export function readSessionHistoryEvidence(content: string): string | null {
  if (!content.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      typeof parsed["session_key"] !== "string" ||
      !("total_messages" in parsed)
    ) {
      return null;
    }
    const evidenceParts: string[] = [];
    const messages = parsed["messages"];
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          continue;
        }
        const record = message as Record<string, unknown>;
        const text = [
          record["content"],
          record["summary"],
          record["result"],
          record["final_content"],
        ]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
          .join("\n");
        if (text.trim()) {
          evidenceParts.push(text.trim());
        }
      }
    }
    for (const key of [
      "result",
      "final_content",
      "evidence_summary",
      "inspection_guidance",
    ]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        evidenceParts.push(value.trim());
      }
    }
    const evidence = dedupeStrings(evidenceParts).join("\n\n").trim();
    return evidence ? evidence : sliceUtf8(content, 4000);
  } catch {
    return /\b(?:session_key|total_messages|sessions_history)\b/i.test(content)
      ? sliceUtf8(content, 4000)
      : null;
  }
}

export function shouldAllowRequiredTimeoutContinuationPastWallClock(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolCalls: LLMToolCall[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (input.toolCalls.length !== 1) {
    return false;
  }
  const call = input.toolCalls[0];
  if (!call || call.name !== "sessions_send") {
    return false;
  }
  const sessionKey =
    typeof call.input?.session_key === "string"
      ? call.input.session_key.trim()
      : "";
  if (!sessionKey || hasExecutedSessionsSend(input.toolTrace, sessionKey)) {
    return false;
  }
  if (
    hasApprovedBrowserTimeoutContinuationPrompt(input.messages) &&
    isAppliedApprovalBrowserContinuation(input.taskPrompt)
  ) {
    return true;
  }
  return (
    hasCoverageTimeoutContinuationPrompt(input.messages) &&
    isCoverageCriticalDelegationTask(input.taskPrompt)
  );
}

export function isResumablePartialSessionResult(
  parsed: NonNullable<ReturnType<typeof parseSessionToolResult>>,
): boolean {
  const payload = parsed.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const resumableReason = (payload as Record<string, unknown>)[
    "resumableReason"
  ];
  return typeof resumableReason === "string" && resumableReason.trim().length > 0;
}

export function collectToolResultContentText(
  results: RoleToolExecutionResult[],
): string {
  return results
    .map((result) => (typeof result.content === "string" ? result.content : ""))
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

export function collectToolTraceResultContent(
  rounds: NativeToolRoundTrace[],
): string {
  return rounds
    .flatMap((round) => round.results)
    .map((result) => (typeof result.content === "string" ? result.content : ""))
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

export function hasUsableEvidence(rounds: NativeToolRoundTrace[]): boolean {
  return rounds.some((round) =>
    round.results.some((result) => !result.isError && result.skipped !== true),
  );
}

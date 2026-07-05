import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { readMessageContentText } from "../tool-protocol";

export function hasIndependentEvidenceStreamContinuationPrompt(
  messages: LLMMessage[],
): boolean {
  const latestMessage = messages.at(-1);
  if (!latestMessage) {
    return false;
  }
  return readMessageContentText(latestMessage.content).includes(
    "Runtime correction: this task declares multiple independent evidence streams.",
  );
}

export function hasMissingApprovalGateRepairPrompt(messages: readonly LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval-gated browser action",
      ),
  );
}

export function hasMissingRequiredFinalDeliverablesRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer omitted required deliverables",
      ),
  );
}

export function hasLatestSupplementalLocalTimeoutProbePrompt(
  messages: LLMMessage[],
): boolean {
  const latest = messages.at(-1);
  return (
    latest?.role === "user" &&
    readMessageContentText(latest.content).includes(
      "Runtime correction: resumed timeout evidence is still content-poor.",
    )
  );
}

export function hasSupplementalLocalTimeoutProbePrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some((message) =>
    readMessageContentText(message.content).includes(
      "Runtime correction: resumed timeout evidence is still content-poor.",
    ),
  );
}

export function hasApprovedBrowserTimeoutContinuationPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some((message) =>
    readMessageContentText(message.content).includes(
      "Runtime correction: approved browser action timed out before verification.",
    ),
  );
}

export function hasCoverageTimeoutContinuationPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some((message) =>
    readMessageContentText(message.content).includes(
      "Runtime correction: a required delegated evidence stream timed out.",
    ),
  );
}

export function hasIncompleteApprovedBrowserSessionContinuationPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approved browser action is incomplete inside an existing browser session",
      ),
  );
}

export function hasTimeoutContinuationGuidance(text: string): boolean {
  return (
    /\b(?:continue|retry|resume|resumable|bounded retry|timeout-gated)\b/i.test(
      text,
    ) ||
    /\b(?:next step|next action)\b[\s\S]{0,80}\b(?:continue|retry|resume|bounded retry)\b/i.test(
      text,
    ) ||
    /\b(?:configure|increase|extend)\b[\s\S]{0,80}\b(?:tool-call\s+)?timeouts?\b/i.test(
      text,
    ) ||
    /\btimeouts?\b[\s\S]{0,80}\b(?:retry|recover|configure|exclude|timeout-gated|bounded retry)\b/i.test(
      text,
    )
  );
}

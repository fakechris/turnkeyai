import type {
  LLMContentBlock,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import { sliceUtf8 } from "./tool-loop-shared";

export interface ToolResultPruningLimits {
  historyMaxMessages: number;
  recentFullCount: number;
  totalMaxBytes: number;
  softMaxBytes: number;
  hardMaxBytes: number;
}

export interface ToolResultPruningSnapshot {
  prunedToolResults: number;
  reasons: string[];
  compactedHistory: boolean;
  toolResultCountBefore: number;
  toolResultCountAfter: number;
  toolResultBytesBefore: number;
  toolResultBytesAfter: number;
  messageCountBefore: number;
  messageCountAfter: number;
  limits: ToolResultPruningLimits;
}

const ROLE_TOOL_HISTORY_MAX_MESSAGES = 16;
const TOOL_RESULT_RECENT_FULL_COUNT = 2;
const TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES = 32 * 1024;
const TOOL_RESULT_SOFT_PRUNE_MAX_BYTES = 16 * 1024;
const TOOL_RESULT_HARD_PRUNE_MAX_BYTES = 64 * 1024;

export function readToolResultPruningLimits(
  env: NodeJS.ProcessEnv = process.env,
): ToolResultPruningLimits {
  const recentFullCount = readPositiveIntegerEnv(
    env,
    "TURNKEYAI_TOOL_RESULT_RECENT_FULL_COUNT",
    TOOL_RESULT_RECENT_FULL_COUNT,
  );
  return {
    historyMaxMessages: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_HISTORY_MAX_MESSAGES",
      ROLE_TOOL_HISTORY_MAX_MESSAGES,
    ),
    recentFullCount,
    totalMaxBytes: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES",
      TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES,
    ),
    softMaxBytes: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_RESULT_SOFT_PRUNE_MAX_BYTES",
      TOOL_RESULT_SOFT_PRUNE_MAX_BYTES,
    ),
    hardMaxBytes: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_RESULT_HARD_PRUNE_MAX_BYTES",
      TOOL_RESULT_HARD_PRUNE_MAX_BYTES,
    ),
  };
}

export function deriveToolResultEnvelope(messages: LLMMessage[]): {
  toolResultCount: number;
  toolResultBytes: number;
} {
  const toolMessages = messages.filter((message) => message.role === "tool");
  return {
    toolResultCount: toolMessages.length,
    toolResultBytes: Buffer.byteLength(
      JSON.stringify(toolMessages.map((message) => message.content)),
      "utf8",
    ),
  };
}

export function prepareToolHistoryForGateway(
  messages: LLMMessage[],
): LLMMessage[] {
  const limits = readToolResultPruningLimits();
  return compactOlderToolHistoryForGateway(
    pruneToolResultMessagesForGateway(messages, limits),
    limits,
  );
}

export function summarizeToolResultPruning(
  beforeMessages: LLMMessage[],
  afterMessages: LLMMessage[],
  limits: ToolResultPruningLimits = readToolResultPruningLimits(),
): ToolResultPruningSnapshot | undefined {
  const prunedToolContents = afterMessages
    .filter((message) => message.role === "tool")
    .map((message) => readToolResultContentText(message.content))
    .filter(isPrunedToolResultContent);
  const compactedHistory = afterMessages.some((message) =>
    readToolResultContentText(message.content).startsWith(
      "Earlier tool history compacted to fit the request envelope:",
    ),
  );
  if (prunedToolContents.length === 0 && !compactedHistory) {
    return undefined;
  }
  const beforeEnvelope = deriveToolResultEnvelope(beforeMessages);
  const afterEnvelope = deriveToolResultEnvelope(afterMessages);
  return {
    prunedToolResults: prunedToolContents.length,
    reasons: [
      ...new Set(
        prunedToolContents
          .map(readPrunedToolResultReason)
          .filter((reason): reason is string => Boolean(reason)),
      ),
    ],
    compactedHistory,
    toolResultCountBefore: beforeEnvelope.toolResultCount,
    toolResultCountAfter: afterEnvelope.toolResultCount,
    toolResultBytesBefore: beforeEnvelope.toolResultBytes,
    toolResultBytesAfter: afterEnvelope.toolResultBytes,
    messageCountBefore: beforeMessages.length,
    messageCountAfter: afterMessages.length,
    limits,
  };
}

export function pruneToolResultMessagesForGateway(
  messages: LLMMessage[],
  limits: ToolResultPruningLimits,
): LLMMessage[] {
  const toolMessageIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  const recentFullIndexes = new Set(
    toolMessageIndexes.slice(-limits.recentFullCount),
  );

  const prunedMessages = messages.map((message, index) => {
    if (message.role !== "tool") {
      return message;
    }
    const content = readToolResultContentText(message.content);
    const contentBytes = Buffer.byteLength(content, "utf8");
    const shouldHardPrune = contentBytes > limits.hardMaxBytes;
    const shouldSoftPrune =
      !recentFullIndexes.has(index) && contentBytes > limits.softMaxBytes;
    if (!shouldHardPrune && !shouldSoftPrune) {
      return message;
    }
    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: contentBytes,
        reason: shouldHardPrune
          ? "over_hard_limit"
          : "older_than_recent_window",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    return replaceToolResultContent(message, prunedContent);
  });

  return pruneToolResultsToTotalBudget(
    prunedMessages,
    recentFullIndexes,
    limits,
  );
}

export function compactOlderToolHistoryForGateway(
  messages: LLMMessage[],
  limits: ToolResultPruningLimits,
): LLMMessage[] {
  if (messages.length <= limits.historyMaxMessages) {
    return messages;
  }
  const toolMessageIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  if (toolMessageIndexes.length <= limits.recentFullCount) {
    return messages;
  }

  for (
    let keepToolCount = limits.recentFullCount;
    keepToolCount >= 1;
    keepToolCount -= 1
  ) {
    const firstKeptToolIndex = toolMessageIndexes.slice(-keepToolCount)[0];
    if (firstKeptToolIndex === undefined) continue;
    const keepStart = findToolCallAssistantIndex(messages, firstKeptToolIndex);
    if (keepStart <= 2) continue;
    const compactedHistory = messages.slice(2, keepStart);
    const summary = buildCompactedToolHistoryMessage(compactedHistory);
    const compacted: LLMMessage[] = [
      ...messages.slice(0, 2),
      summary,
      ...messages.slice(keepStart),
    ];
    if (compacted.length <= limits.historyMaxMessages) {
      return compacted;
    }
  }

  return messages;
}

export function findLatestAssistantToolUseMessageIndex(
  messages: LLMMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && countToolUseBlocks(message) > 0) {
      return index;
    }
  }
  return -1;
}

export function findFollowingToolMessageIndexes(
  messages: LLMMessage[],
  assistantMessageIndex: number,
): number[] {
  if (assistantMessageIndex < 0) {
    return [];
  }
  const indexes: number[] = [];
  for (
    let index = assistantMessageIndex + 1;
    index < messages.length;
    index += 1
  ) {
    if (messages[index]?.role === "tool") {
      indexes.push(index);
    }
  }
  return indexes;
}

export function countToolUseBlocks(message: LLMMessage | undefined): number {
  if (!message || !Array.isArray(message.content)) {
    return 0;
  }
  return message.content.filter((block) => block.type === "tool_use").length;
}

export function countToolResultBlocks(
  messages: LLMMessage[],
  indexes: number[],
): number {
  return indexes.reduce((count, index) => {
    const message = messages[index];
    if (!message || !Array.isArray(message.content)) {
      return count;
    }
    return (
      count +
      message.content.filter((block) => block.type === "tool_result").length
    );
  }, 0);
}

export function readToolResultContentText(
  content: LLMMessage["content"],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "tool_result") return block.content;
      if (block.type === "text") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function findToolCallAssistantIndex(
  messages: LLMMessage[],
  toolMessageIndex: number,
): number {
  const toolMessage = messages[toolMessageIndex];
  const toolCallId =
    toolMessage?.role === "tool" ? toolMessage.toolCallId : undefined;
  for (let index = toolMessageIndex - 1; index >= 2; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const toolUseIds = extractAssistantToolUseIds(message);
    if (!toolCallId || toolUseIds.includes(toolCallId)) {
      return index;
    }
  }
  return toolMessageIndex;
}

function extractAssistantToolUseIds(message: LLMMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .map((block) => (block.type === "tool_use" ? block.id : ""))
    .filter((id) => id.length > 0);
}

function buildCompactedToolHistoryMessage(messages: LLMMessage[]): LLMMessage {
  const lines = ["Earlier tool history compacted to fit the request envelope:"];
  for (const message of messages) {
    if (message.role === "assistant") {
      const calls = Array.isArray(message.content)
        ? message.content.filter(
            (block): block is Extract<LLMContentBlock, { type: "tool_use" }> =>
              block.type === "tool_use",
          )
        : [];
      for (const call of calls) {
        lines.push(
          `- called ${call.name} (${call.id}): ${summarizeToolArgs(call.input)}`,
        );
      }
      continue;
    }
    if (message.role === "tool") {
      const content = readToolResultContentText(message.content);
      lines.push(
        `- result ${message.name ?? "tool"} (${message.toolCallId ?? "unknown"}): ${summarizeToolResultContent(content)}`,
      );
    }
  }
  return {
    role: "user",
    content: sliceUtf8(lines.join("\n"), 6 * 1024),
  };
}

function summarizeToolArgs(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (!json) return "{}";
  return json.length > 300 ? `${json.slice(0, 300)}...` : json;
}

function pruneToolResultsToTotalBudget(
  messages: LLMMessage[],
  recentFullIndexes: Set<number>,
  limits: ToolResultPruningLimits,
): LLMMessage[] {
  let totalBytes = deriveToolResultEnvelope(messages).toolResultBytes;
  if (totalBytes <= limits.totalMaxBytes) {
    return messages;
  }

  let nextMessages = messages;
  const olderToolIndexes = messages
    .map((message, index) =>
      message.role === "tool" && !recentFullIndexes.has(index) ? index : -1,
    )
    .filter((index) => index >= 0);

  for (const index of olderToolIndexes) {
    const message = nextMessages[index];
    if (!message || message.role !== "tool") continue;
    const content = readToolResultContentText(message.content);
    if (isPrunedToolResultContent(content)) continue;

    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: Buffer.byteLength(content, "utf8"),
        reason: "aggregate_tool_result_budget",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    nextMessages = [...nextMessages];
    nextMessages[index] = replaceToolResultContent(message, prunedContent);
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= limits.totalMaxBytes) {
      return nextMessages;
    }
  }

  // Pathological case: the recent window alone can exceed the aggregate
  // cap. Keep the newest result intact when possible, but compact the
  // rest so final synthesis still gets a valid request envelope.
  const recentExceptNewest = [...recentFullIndexes].slice(0, -1);
  for (const index of recentExceptNewest) {
    const message = nextMessages[index];
    if (!message || message.role !== "tool") continue;
    const content = readToolResultContentText(message.content);
    if (isPrunedToolResultContent(content)) continue;

    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: Buffer.byteLength(content, "utf8"),
        reason: "aggregate_tool_result_budget_recent_window",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    nextMessages = nextMessages.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? replaceToolResultContent(message, prunedContent)
        : candidate,
    );
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= limits.totalMaxBytes) {
      return nextMessages;
    }
  }

  for (const index of [...recentFullIndexes].reverse()) {
    const message = nextMessages[index];
    if (!message || message.role !== "tool") continue;
    const content = readToolResultContentText(message.content);
    if (isPrunedToolResultContent(content)) continue;

    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: Buffer.byteLength(content, "utf8"),
        reason: "single_tool_result_exceeds_aggregate_budget",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    nextMessages = nextMessages.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? replaceToolResultContent(message, prunedContent)
        : candidate,
    );
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= limits.totalMaxBytes) {
      return nextMessages;
    }
  }

  return nextMessages;
}

function replaceToolResultContent(
  message: LLMMessage,
  content: string,
): LLMMessage {
  if (typeof message.content === "string") {
    return { ...message, content };
  }
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "tool_result"
        ? {
            ...block,
            content,
          }
        : block,
    ),
  };
}

function summarizeToolResultContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty tool result)";
  }
  return normalized.length > 512
    ? `${normalized.slice(0, 512)}...`
    : normalized;
}

function isPrunedToolResultContent(content: string): boolean {
  return content.includes('"tool_result_pruned": true');
}

function readPrunedToolResultReason(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    const match = content.match(/"reason"\s*:\s*"([^"]+)"/);
    return match?.[1];
  }
}

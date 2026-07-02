import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import {
  compactOlderToolHistoryForGateway,
  countToolResultBlocks,
  countToolUseBlocks,
  findFollowingToolMessageIndexes,
  findLatestAssistantToolUseMessageIndex,
  pruneToolResultMessagesForGateway,
  readToolResultContentText,
  readToolResultPruningLimits,
  summarizeToolResultPruning,
  type ToolResultPruningLimits,
} from "./tool-history-pruning";

function toolMessage(
  id: string,
  content: string,
  name = "web_fetch",
): LLMMessage {
  return {
    role: "tool",
    toolCallId: id,
    name,
    content,
  };
}

function assistantToolUse(id: string, name = "web_fetch"): LLMMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name,
        input: { url: `https://example.com/${id}` },
      },
    ],
  };
}

const baseLimits: ToolResultPruningLimits = {
  historyMaxMessages: 20,
  recentFullCount: 1,
  totalMaxBytes: 1024 * 1024,
  softMaxBytes: 50,
  hardMaxBytes: 500,
};

test("readToolResultPruningLimits reads positive env overrides and ignores invalid values", () => {
  const limits = readToolResultPruningLimits({
    TURNKEYAI_TOOL_HISTORY_MAX_MESSAGES: "8",
    TURNKEYAI_TOOL_RESULT_RECENT_FULL_COUNT: "3",
    TURNKEYAI_TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES: "not-a-number",
    TURNKEYAI_TOOL_RESULT_SOFT_PRUNE_MAX_BYTES: "-1",
    TURNKEYAI_TOOL_RESULT_HARD_PRUNE_MAX_BYTES: "128",
  });

  assert.equal(limits.historyMaxMessages, 8);
  assert.equal(limits.recentFullCount, 3);
  assert.equal(limits.totalMaxBytes, 32 * 1024);
  assert.equal(limits.softMaxBytes, 16 * 1024);
  assert.equal(limits.hardMaxBytes, 128);
});

test("pruneToolResultMessagesForGateway prunes older oversized tool results only", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    toolMessage("old", "x".repeat(120)),
    toolMessage("recent", "y".repeat(120)),
  ];

  const pruned = pruneToolResultMessagesForGateway(messages, baseLimits);

  const oldContent = readToolResultContentText(pruned[2]!.content);
  const recentContent = readToolResultContentText(pruned[3]!.content);
  assert.match(oldContent, /"tool_result_pruned": true/);
  assert.match(oldContent, /"reason": "older_than_recent_window"/);
  assert.equal(recentContent, "y".repeat(120));

  const snapshot = summarizeToolResultPruning(messages, pruned, baseLimits);
  assert.ok(snapshot);
  assert.equal(snapshot.prunedToolResults, 1);
  assert.deepEqual(snapshot.reasons, ["older_than_recent_window"]);
});

test("compactOlderToolHistoryForGateway replaces old assistant/tool pairs with one summary", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    assistantToolUse("call-old"),
    toolMessage("call-old", "old result"),
    assistantToolUse("call-new"),
    toolMessage("call-new", "new result"),
  ];

  const compacted = compactOlderToolHistoryForGateway(messages, {
    ...baseLimits,
    historyMaxMessages: 5,
  });

  assert.equal(compacted.length, 5);
  assert.equal(compacted[2]!.role, "user");
  assert.match(
    readToolResultContentText(compacted[2]!.content),
    /Earlier tool history compacted/,
  );
  assert.match(readToolResultContentText(compacted[2]!.content), /call-old/);
  assert.equal(compacted[3], messages[4]);
  assert.equal(compacted[4], messages[5]);
});

test("tool history block counters find the latest assistant call and following results", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    assistantToolUse("call-a"),
    toolMessage("call-a", "result a"),
    assistantToolUse("call-b"),
    toolMessage("call-b", "result b"),
  ];

  const assistantIndex = findLatestAssistantToolUseMessageIndex(messages);
  const toolIndexes = findFollowingToolMessageIndexes(messages, assistantIndex);

  assert.equal(assistantIndex, 4);
  assert.deepEqual(toolIndexes, [5]);
  assert.equal(countToolUseBlocks(messages[assistantIndex]), 1);
  assert.equal(countToolResultBlocks(messages, toolIndexes), 0);
});

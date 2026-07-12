import assert from "node:assert/strict";
import test from "node:test";

import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import {
  compactOlderToolHistoryForGateway,
  countToolResultBlocks,
  countToolUseBlocks,
  findFollowingToolMessageIndexes,
  findLatestAssistantToolUseMessageIndex,
  pruneToolResultMessagesForGateway,
  readToolResultContentText,
  readToolResultPruningLimits,
  recordProviderToolProtocolRoundSafely,
  recordRuntimeForcedToolRoundProviderProtocolSafely,
  recordToolResultPruningBoundarySafely,
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
  historyMaxBytes: 1024 * 1024,
  recentFullCount: 1,
  totalMaxBytes: 1024 * 1024,
  softMaxBytes: 50,
  hardMaxBytes: 500,
};

test("readToolResultPruningLimits keeps message and byte caps as high sanity guards", () => {
  const limits = readToolResultPruningLimits({});

  assert.equal(limits.historyMaxMessages, 200);
  assert.equal(limits.historyMaxBytes, 3 * 1024 * 1024);
});

test("readToolResultPruningLimits derives aggregate result budget from model context", () => {
  const limits = readToolResultPruningLimits({}, { inputTokenLimit: 100_000 });
  const overridden = readToolResultPruningLimits(
    { TURNKEYAI_TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES: "45000" },
    { inputTokenLimit: 100_000 },
  );

  assert.equal(limits.totalMaxBytes, 60_000);
  assert.equal(overridden.totalMaxBytes, 45_000);
});

test("readToolResultPruningLimits reads positive env overrides and ignores invalid values", () => {
  const limits = readToolResultPruningLimits({
    TURNKEYAI_TOOL_HISTORY_MAX_MESSAGES: "8",
    TURNKEYAI_TOOL_HISTORY_MAX_BYTES: "4096",
    TURNKEYAI_TOOL_RESULT_RECENT_FULL_COUNT: "3",
    TURNKEYAI_TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES: "not-a-number",
    TURNKEYAI_TOOL_RESULT_SOFT_PRUNE_MAX_BYTES: "-1",
    TURNKEYAI_TOOL_RESULT_HARD_PRUNE_MAX_BYTES: "128",
  });

  assert.equal(limits.historyMaxMessages, 8);
  assert.equal(limits.historyMaxBytes, 4096);
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
    /Earlier loop history compacted/,
  );
  assert.match(readToolResultContentText(compacted[2]!.content), /call-old/);
  assert.equal(compacted[3], messages[4]);
  assert.equal(compacted[4], messages[5]);
});

test("compactOlderToolHistoryForGateway never summarizes an incomplete tool protocol unit", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    assistantToolUse("call-complete"),
    toolMessage("call-complete", "complete result"),
    assistantToolUse("call-open"),
  ];

  const compacted = compactOlderToolHistoryForGateway(messages, {
    ...baseLimits,
    historyMaxMessages: 3,
    historyMaxBytes: 512,
  });

  assert.equal(compacted, messages);
  assert.deepEqual(compacted.at(-1), assistantToolUse("call-open"));
});

test("compactOlderToolHistoryForGateway compacts repair-heavy history without tool pairs", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    ...Array.from({ length: 18 }, (_, index): LLMMessage => ({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `repair round ${index + 1}`,
    })),
  ];

  const compacted = compactOlderToolHistoryForGateway(messages, {
    ...baseLimits,
    historyMaxMessages: 8,
  });

  assert.ok(compacted.length <= 8);
  assert.deepEqual(compacted.slice(0, 2), messages.slice(0, 2));
  assert.match(
    readToolResultContentText(compacted[2]!.content),
    /Earlier loop history compacted/,
  );
  assert.equal(compacted.at(-1)?.content, "repair round 18");
});

test("compactOlderToolHistoryForGateway preserves recent tool protocol pairs atomically", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    ...Array.from({ length: 8 }, (_, index): LLMMessage => ({
      role: "assistant",
      content: `older repair ${index + 1}`,
    })),
    assistantToolUse("call-latest"),
    toolMessage("call-latest", "latest evidence"),
    { role: "user", content: "write the final answer" },
  ];

  const compacted = compactOlderToolHistoryForGateway(messages, {
    ...baseLimits,
    historyMaxMessages: 6,
  });

  assert.equal(compacted.length, 6);
  assert.equal(compacted[3], messages.at(-3));
  assert.equal(compacted[4], messages.at(-2));
  assert.equal(compacted[5], messages.at(-1));
});

test("compactOlderToolHistoryForGateway enforces a loop-history byte budget", () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    { role: "assistant", content: `old analysis ${"x".repeat(4_000)}` },
    { role: "user", content: `old repair ${"y".repeat(4_000)}` },
    { role: "assistant", content: "latest bounded answer" },
  ];

  const compacted = compactOlderToolHistoryForGateway(messages, {
    ...baseLimits,
    historyMaxBytes: 2_048,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(compacted.slice(2)), "utf8") <= 2_048);
  assert.equal(compacted.at(-1)?.content, "latest bounded answer");
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

test("recordProviderToolProtocolRoundSafely records provider tool protocol metadata", async () => {
  const events: Array<{
    progressId: string;
    summary: string;
    recordedAt: number;
    metadata?: Record<string, unknown>;
  }> = [];
  const activation = {
    thread: { threadId: "thread-1" },
    flow: { flowId: "flow-1" },
    handoff: { taskId: "task-1" },
    runState: {
      runKey: "run-1",
      roleId: "role:researcher",
      lastDequeuedTaskId: "dispatch-task-1",
    },
  } as unknown as RoleActivationInput;
  const toolCall: LLMToolCall = {
    id: "call-1",
    name: "sessions_spawn",
    input: { workerType: "browser" },
  };
  const toolResult: ToolResult = {
    toolCallId: "call-1",
    toolName: "sessions_spawn",
    content: "done",
  };
  const messages = [
    { role: "user", content: "run it" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "sessions_spawn",
          input: { workerType: "browser" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      name: "sessions_spawn",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "done",
        },
      ],
    },
  ] as unknown as LLMMessage[];

  await recordProviderToolProtocolRoundSafely({
    activation,
    runtimeProgressRecorder: {
      async record(event) {
        events.push(event as (typeof events)[number]);
      },
    },
    now: () => 1234,
    round: 2,
    toolCalls: [toolCall],
    toolResults: [toolResult],
    messages,
  });

  assert.equal(events.length, 1);
  assert.equal(
    events[0]!.progressId,
    "progress:provider-tool-protocol:task-1:2:1234",
  );
  assert.match(events[0]!.summary, /Provider tool protocol round 2/);
  assert.equal(events[0]!.recordedAt, 1234);
  assert.deepEqual(events[0]!.metadata, {
    boundaryKind: "provider_tool_protocol_round",
    round: 2,
    providerToolCallsReturned: 1,
    assistantToolUseBlockCount: 1,
    roleToolResultMessageCount: 1,
    toolResultBlockCount: 1,
    assistantBeforeToolResults: true,
    allToolResultsMatchAssistantToolCalls: true,
    nextProviderRequestWillIncludeToolResults: true,
    toolCallIds: ["call-1"],
    toolResultIds: ["call-1"],
    matchingToolCallIds: ["call-1"],
    toolNames: ["sessions_spawn"],
  });
});

test("recordProviderToolProtocolRoundSafely is a no-op without recorder", async () => {
  await recordProviderToolProtocolRoundSafely({
    activation: {
      thread: { threadId: "thread-1" },
      flow: { flowId: "flow-1" },
      handoff: { taskId: "task-1" },
      runState: { runKey: "run-1", roleId: "role:researcher" },
    } as unknown as RoleActivationInput,
    now: () => 1,
    round: 1,
    toolCalls: [],
    toolResults: [],
    messages: [],
  });
});

test("recordRuntimeForcedToolRoundProviderProtocolSafely records forced-round provider protocol metadata", async () => {
  const events: Array<{
    progressId: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const activation = {
    thread: { threadId: "thread-1" },
    flow: { flowId: "flow-1" },
    handoff: { taskId: "task-1" },
    runState: {
      runKey: "run-1",
      roleId: "role:researcher",
    },
  } as unknown as RoleActivationInput;
  const toolCall: LLMToolCall = {
    id: "call-1",
    name: "sessions_spawn",
    input: { workerType: "browser" },
  };
  const toolResult: ToolResult = {
    toolCallId: "call-1",
    toolName: "sessions_spawn",
    content: "done",
  };

  await recordRuntimeForcedToolRoundProviderProtocolSafely({
    activation,
    runtimeProgressRecorder: {
      async record(event) {
        events.push(event as (typeof events)[number]);
      },
    },
    now: () => 2345,
    round: 3,
    toolCalls: [toolCall],
    toolResults: [toolResult],
    messages: [
      { role: "user", content: "run it" },
      assistantToolUse("call-1", "sessions_spawn"),
      toolMessage("call-1", "done", "sessions_spawn"),
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(
    events[0]!.progressId,
    "progress:provider-tool-protocol:task-1:3:2345",
  );
  assert.equal(events[0]!.metadata?.boundaryKind, "provider_tool_protocol_round");
  assert.equal(events[0]!.metadata?.round, 3);
});

test("recordToolResultPruningBoundarySafely records pruning metadata", async () => {
  const events: Array<{
    progressId: string;
    summary: string;
    recordedAt: number;
    metadata?: Record<string, unknown>;
  }> = [];
  const activation = {
    thread: { threadId: "thread-1" },
    flow: { flowId: "flow-1" },
    handoff: { taskId: "task-1" },
    runState: {
      runKey: "run-1",
      roleId: "role:researcher",
      lastDequeuedTaskId: "dispatch-task-1",
    },
  } as unknown as RoleActivationInput;
  const snapshot = {
    prunedToolResults: 2,
    reasons: ["older_than_recent_window"],
    compactedHistory: true,
    toolResultCountBefore: 3,
    toolResultCountAfter: 2,
    toolResultBytesBefore: 300,
    toolResultBytesAfter: 120,
    messageCountBefore: 8,
    messageCountAfter: 6,
    limits: baseLimits,
  };

  await recordToolResultPruningBoundarySafely({
    activation,
    runtimeProgressRecorder: {
      async record(event) {
        events.push(event as (typeof events)[number]);
      },
    },
    selection: {
      modelId: "model-a",
      modelChainId: "chain-a",
    },
    snapshot,
  });

  assert.equal(events.length, 1);
  assert.match(
    events[0]!.progressId,
    /^progress:tool-result-pruning:task-1:/,
  );
  assert.match(events[0]!.summary, /Tool result history pruned/);
  assert.equal(typeof events[0]!.recordedAt, "number");
  assert.deepEqual(events[0]!.metadata, {
    boundaryKind: "tool_result_pruning",
    modelId: "model-a",
    modelChainId: "chain-a",
    prunedToolResults: 2,
    pruningReasons: ["older_than_recent_window"],
    compactedHistory: true,
    toolResultCountBefore: 3,
    toolResultCountAfter: 2,
    toolResultBytesBefore: 300,
    toolResultBytesAfter: 120,
    messageCountBefore: 8,
    messageCountAfter: 6,
    pruningLimits: baseLimits,
  });
});

test("recordToolResultPruningBoundarySafely is a no-op without recorder or snapshot", async () => {
  const activation = {
    thread: { threadId: "thread-1" },
    flow: { flowId: "flow-1" },
    handoff: { taskId: "task-1" },
    runState: { runKey: "run-1", roleId: "role:researcher" },
  } as unknown as RoleActivationInput;
  let records = 0;

  await recordToolResultPruningBoundarySafely({
    activation,
    runtimeProgressRecorder: {
      async record() {
        records += 1;
      },
    },
    selection: {},
  });
  await recordToolResultPruningBoundarySafely({
    activation,
    selection: {},
    snapshot: {
      prunedToolResults: 1,
      reasons: [],
      compactedHistory: false,
      toolResultCountBefore: 1,
      toolResultCountAfter: 1,
      toolResultBytesBefore: 10,
      toolResultBytesAfter: 5,
      messageCountBefore: 2,
      messageCountAfter: 2,
      limits: baseLimits,
    },
  });

  assert.equal(records, 0);
});

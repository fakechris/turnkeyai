import assert from "node:assert/strict";
import test from "node:test";

import type { ToolProgressEvent, ToolResult } from "@turnkeyai/agent-core/tool";
import type {
  RoleActivationInput,
  RuntimeProgressEvent,
  RuntimeProgressRecorder,
  TeamMessage,
} from "@turnkeyai/core-types/team";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  createEngineRunObserver,
  createRoleEngineRunObserver,
} from "./engine-run-observer";

function call(overrides: Partial<LLMToolCall> = {}): LLMToolCall {
  return {
    id: "call-1",
    name: "web_fetch",
    input: { url: "https://example.com" },
    ...overrides,
  };
}

function result(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    toolCallId: "call-1",
    toolName: "web_fetch",
    content: "ok",
    ...overrides,
  };
}

function activation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      roles: [
        {
          roleId: "role:researcher",
          name: "Researcher",
          seat: "member",
        },
      ],
    },
    flow: { flowId: "flow-1" },
    handoff: { taskId: "task-1" },
    runState: {
      runKey: "run-1",
      roleId: "role:researcher",
      lastDequeuedTaskId: "dispatch-task-1",
    },
  } as unknown as RoleActivationInput;
}

function recorder(events: RuntimeProgressEvent[]): RuntimeProgressRecorder {
  return {
    async record(event) {
      events.push(event);
    },
  };
}

function createHarness() {
  const toolTrace: NativeToolRoundTrace[] = [];
  const recorded: Array<{ call: LLMToolCall; progress: ToolProgressEvent }> = [];
  const providerRounds: Array<{
    round: number;
    toolCalls: LLMToolCall[];
    toolResults: ToolResult[];
    messages: LLMMessage[];
  }> = [];
  const persists: Array<{ forceBlocking?: boolean } | undefined> = [];
  let now = 100;
  const observer = createEngineRunObserver(toolTrace, {
    now: () => now++,
    recordToolProgress: async (progressCall, progress) => {
      recorded.push({ call: progressCall, progress });
    },
    persistNativeToolTrace: async (options) => {
      persists.push(options);
    },
    recordProviderToolProtocolRound: async (round) => {
      providerRounds.push(round);
    },
  });
  return { observer, toolTrace, recorded, providerRounds, persists };
}

test("createRoleEngineRunObserver selects tool-loop recorder and persists native trace", async () => {
  const toolTrace: NativeToolRoundTrace[] = [];
  const rootEvents: RuntimeProgressEvent[] = [];
  const toolLoopEvents: RuntimeProgressEvent[] = [];
  const persisted: TeamMessage[] = [];
  const toolCall = call();
  const observer = createRoleEngineRunObserver({
    toolTrace,
    toolLoop: { runtimeProgressRecorder: recorder(toolLoopEvents) },
    runtimeProgressRecorder: recorder(rootEvents),
    nativeToolMessageStore: {
      async append(message) {
        persisted.push(message);
      },
    },
    now: () => 1234,
    activation: activation(),
  });

  observer.onModelResponse({ round: 0, toolCalls: [toolCall] });
  await observer.onToolStarted({ round: 0, call: toolCall });

  assert.equal(rootEvents.length, 0);
  assert.equal(toolLoopEvents.length, 1);
  assert.equal(toolLoopEvents[0]?.metadata?.toolCallId, "call-1");
  assert.equal(toolLoopEvents[0]?.metadata?.toolName, "web_fetch");
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0]?.toolCalls, [
    {
      id: "call-1",
      name: "web_fetch",
      arguments: { url: "https://example.com" },
    },
  ]);
});

test("createRoleEngineRunObserver records provider protocol rounds with selected recorder", async () => {
  const toolTrace: NativeToolRoundTrace[] = [];
  const rootEvents: RuntimeProgressEvent[] = [];
  const toolLoopEvents: RuntimeProgressEvent[] = [];
  const toolCall = call({ id: "call-provider" });
  const toolResult = result({
    toolCallId: "call-provider",
    content: "provider boundary result",
  });
  const messages: LLMMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will call a tool." },
        {
          type: "tool_use",
          id: "call-provider",
          name: "web_fetch",
          input: { url: "https://example.com" },
        },
      ],
    } as LLMMessage,
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolUseId: "call-provider",
          content: "provider boundary result",
        },
      ],
    } as LLMMessage,
  ];
  const observer = createRoleEngineRunObserver({
    toolTrace,
    toolLoop: { runtimeProgressRecorder: recorder(toolLoopEvents) },
    runtimeProgressRecorder: recorder(rootEvents),
    now: () => 2000,
    activation: activation(),
  });

  await observer.onProviderToolProtocolRound({
    round: 4,
    toolCalls: [toolCall],
    toolResults: [toolResult],
    messages,
  });

  assert.equal(rootEvents.length, 0);
  assert.equal(toolLoopEvents.length, 1);
  assert.equal(
    toolLoopEvents[0]?.metadata?.boundaryKind,
    "provider_tool_protocol_round",
  );
  assert.equal(toolLoopEvents[0]?.metadata?.round, 4);
  assert.deepEqual(toolLoopEvents[0]?.metadata?.toolCallIds, ["call-provider"]);
});

test("EngineRunObserver opens a model-response round and does not duplicate started calls", async () => {
  const { observer, toolTrace, recorded, persists } = createHarness();
  const toolCall = call();

  observer.onModelResponse({ round: 0, toolCalls: [toolCall] });
  await observer.onToolStarted({ round: 0, call: toolCall });

  assert.equal(toolTrace.length, 1);
  assert.equal(toolTrace[0]?.round, 1);
  assert.deepEqual(toolTrace[0]?.calls, [
    { id: "call-1", name: "web_fetch", input: { url: "https://example.com" } },
  ]);
  assert.deepEqual(
    toolTrace[0]?.progress?.map((progress) => ({
      phase: progress.phase,
      toolCallId: progress.toolCallId,
      ts: progress.ts,
    })),
    [{ phase: "started", toolCallId: "call-1", ts: 100 }],
  );
  assert.deepEqual(
    recorded.map((entry) => entry.progress.phase),
    ["started"],
  );
  assert.deepEqual(persists, [{ forceBlocking: true }]);
});

test("EngineRunObserver opens an injected round from the first tool_started event", async () => {
  const { observer, toolTrace } = createHarness();

  await observer.onToolStarted({ round: 2, call: call({ id: "runtime-1" }) });

  assert.equal(toolTrace.length, 1);
  assert.deepEqual(toolTrace[0]?.calls, [
    {
      id: "runtime-1",
      name: "web_fetch",
      input: { url: "https://example.com" },
    },
  ]);
  assert.equal(toolTrace[0]?.round, 3);
});

test("EngineRunObserver records result, executor progress, terminal progress, and persistence", async () => {
  const { observer, toolTrace, recorded, persists } = createHarness();
  const toolCall = call();
  await observer.onToolStarted({ round: 0, call: toolCall });
  recorded.length = 0;
  persists.length = 0;

  await observer.onToolResult({
    result: result({
      content: "boom",
      isError: true,
      progress: [
        {
          phase: "progress",
          toolName: "web_fetch",
          summary: "Fetched headers",
          detail: { status: 500 },
        },
      ],
    }),
  });

  assert.deepEqual(toolTrace[0]?.results, [
    {
      toolCallId: "call-1",
      toolName: "web_fetch",
      isError: true,
      contentBytes: 4,
      content: "boom",
    },
  ]);
  assert.deepEqual(
    toolTrace[0]?.progress?.map((progress) => progress.phase),
    ["started", "progress", "failed"],
  );
  assert.deepEqual(
    recorded.map((entry) => entry.progress.phase),
    ["progress", "failed"],
  );
  assert.deepEqual(persists, [undefined]);
});

test("EngineRunObserver ignores tool_result when no round is open", async () => {
  const { observer, toolTrace, recorded, persists } = createHarness();

  await observer.onToolResult({ result: result() });

  assert.deepEqual(toolTrace, []);
  assert.deepEqual(recorded, []);
  assert.deepEqual(persists, []);
});

test("EngineRunObserver records provider tool protocol rounds through the injected recorder", async () => {
  const { observer, providerRounds } = createHarness();
  const toolCall = call({ id: "call-provider" });
  const toolResult = result({
    toolCallId: "call-provider",
    content: "provider boundary result",
  });
  const messages: LLMMessage[] = [
    { role: "assistant", content: "I will call a tool." },
    { role: "tool", content: "provider boundary result" },
  ];

  await observer.onProviderToolProtocolRound({
    round: 4,
    toolCalls: [toolCall],
    toolResults: [toolResult],
    messages,
  });

  assert.deepEqual(providerRounds, [
    {
      round: 4,
      toolCalls: [toolCall],
      toolResults: [toolResult],
      messages,
    },
  ]);
});

test("EngineRunObserver observes runtime-forced tool rounds", async () => {
  const { observer, toolTrace, providerRounds, persists } = createHarness();
  const baseMessages: LLMMessage[] = [{ role: "user", content: "continue" }];
  const toolCall = call({ id: "forced-1", name: "permission_result" });
  const toolResult = result({
    toolCallId: "forced-1",
    toolName: "permission_result",
    content: "approved",
    progress: [
      {
        phase: "progress",
        toolName: "permission_result",
        summary: "checking approval",
      },
    ],
  });

  const observed = await observer.observeRuntimeForcedToolRound({
    round: 3,
    messages: baseMessages,
    assistantText: "Checking permission state.",
    toolCalls: [toolCall],
    executeToolCalls: async ({ onProgress, onResult }) => {
      await onProgress(toolCall, {
        phase: "started",
        toolName: toolCall.name,
        summary: `Tool call started: ${toolCall.name}`,
      });
      for (const progress of toolResult.progress ?? []) {
        await onProgress(toolCall, progress);
      }
      await onResult(toolResult);
      return [toolResult];
    },
  });

  assert.equal(toolTrace.length, 1);
  assert.equal(toolTrace[0]?.round, 3);
  assert.deepEqual(toolTrace[0]?.calls, [
    { id: "forced-1", name: "permission_result", input: toolCall.input },
  ]);
  assert.deepEqual(
    toolTrace[0]?.progress?.map((progress) => ({
      phase: progress.phase,
      toolCallId: progress.toolCallId,
      ts: progress.ts,
    })),
    [
      { phase: "started", toolCallId: "forced-1", ts: 100 },
      { phase: "progress", toolCallId: "forced-1", ts: 101 },
    ],
  );
  assert.deepEqual(toolTrace[0]?.results, [
    {
      toolCallId: "forced-1",
      toolName: "permission_result",
      isError: false,
      contentBytes: 8,
      content: "approved",
    },
  ]);
  assert.deepEqual(observed.toolResults, [toolResult]);
  assert.deepEqual(
    observed.messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  assert.deepEqual(persists, [
    { forceBlocking: true },
    { forceBlocking: false },
    undefined,
  ]);
  assert.deepEqual(providerRounds, [
    {
      round: 3,
      toolCalls: [toolCall],
      toolResults: [toolResult],
      messages: observed.messages,
    },
  ]);
});

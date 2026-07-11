import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReplayRecord,
  RoleActivationInput,
  TeamMessage,
} from "@turnkeyai/core-types/team";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { RolePromptPacket } from "./prompt-policy";
import { replayEngineRunRecord } from "./run-trace-replay";
import type { RoleToolExecutor } from "./tool-use";
import {
  TOOL_RESULT_ARTIFACT_PROTOCOL,
  type ToolResultArtifactStore,
} from "./tool-result-artifact-store";

test("recorded engine runs replay twice with identical tools, policy, and final text", async () => {
  const activation = replayActivation();
  const packet = replayPacket();
  const toolDefinitions = [webFetchDefinition()];
  const modelResults: GenerateTextResult[] = [
    {
      text: "I will inspect the source.",
      toolCalls: [
        {
          id: "call-1",
          name: "web_fetch",
          input: { url: "https://example.test/source" },
        },
      ],
      modelId: "model-replay",
      providerId: "provider-replay",
      protocol: "openai-compatible",
      adapterName: "record-test",
      stopReason: "tool_calls",
      raw: {},
    },
    {
      text: "Source evidence says the value is 42.",
      modelId: "model-replay",
      providerId: "provider-replay",
      protocol: "openai-compatible",
      adapterName: "record-test",
      stopReason: "stop",
      raw: {},
    },
  ];
  let modelIndex = 0;
  const fullToolContent = `Source evidence: value=42\n${"x".repeat(70 * 1024)}\nbehavior-critical-tail-marker`;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (_input: GenerateTextInput) => {
    const result = modelResults[modelIndex++];
    if (!result) throw new Error("recording model script exhausted");
    return structuredClone(result);
  };
  const executor: RoleToolExecutor = {
    definitions: () => toolDefinitions,
    async execute(input) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: fullToolContent,
        progress: [
          {
            phase: "progress",
            toolName: input.call.name,
            summary: "Source fetch reached the upstream server",
          },
        ],
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    clock: incrementingClock(),
    toolLoop: { executor, maxRounds: 8 },
    runtimeProgressRecorder: {
      async record() {},
    },
    nativeToolMessageStore: {
      async append() {},
    },
    runJournalStore: inMemoryMessageStore(),
    deferToolObservability: true,
    toolResultArtifactStore: replayTestArtifactStore(),
  });

  const recorded = await generator.generate({ activation, packet });
  const replaySeed = recorded.metadata?.engineRunReplay as Record<string, unknown>;
  const replayToolResults = replaySeed["toolResults"] as
    | Array<{ content?: string }>
    | undefined;
  assert.equal(
    replayToolResults?.[0]?.content,
    fullToolContent,
    "replay seed must retain the exact behavior input even when public toolUse is truncated",
  );
  const record: ReplayRecord = {
    replayId: "replay-1",
    layer: "role",
    status: "completed",
    recordedAt: 100,
    threadId: activation.thread.threadId,
    flowId: activation.flow.flowId,
    roleId: activation.runState.roleId,
    taskId: activation.handoff.taskId,
    summary: recorded.content,
    metadata: {
      runTrace: recorded.metadata?.runTrace,
      engineRunReplay: {
        ...replaySeed,
        activation,
        packet,
        toolUse: recorded.metadata?.toolUse,
      },
    },
  };

  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error("RunTrace replay must not invoke a provider transport");
  }) as typeof fetch;
  const [first, second] = await (async () => {
    try {
      return [
        await replayEngineRunRecord(record),
        await replayEngineRunRecord(record),
      ] as const;
    } finally {
      globalThis.fetch = previousFetch;
    }
  })();

  assert.deepEqual(first, second);
  assert.equal(providerCalls, 0);
  assert.equal(first.finalText, recorded.content);
  assert.deepEqual(first.toolCalls, [
    {
      id: "call-1",
      name: "web_fetch",
      input: { url: "https://example.test/source" },
    },
  ]);
  assert.ok(first.policy.length > 0);
});

test("replay seed freezes the resume boundary before later tool rounds mutate runtime state", async () => {
  const activation = replayActivation();
  const packet = replayPacket();
  const store = inMemoryMessageStore();
  const controller = new AbortController();
  const interruptedGateway = Object.create(LLMGateway.prototype) as LLMGateway;
  interruptedGateway.generate = async () => {
    controller.abort(new Error("simulated process interruption"));
    throw controller.signal.reason;
  };
  const executor: RoleToolExecutor = {
    definitions: () => [webFetchDefinition()],
    async execute({ call }) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        content: "Source evidence: value=42",
      };
    },
  };
  await assert.rejects(
    new LLMRoleResponseGenerator({
      gateway: interruptedGateway,
      toolLoop: { executor, maxRounds: 4 },
      runJournalStore: store,
    }).generate({ activation, packet, signal: controller.signal }),
    /simulated process interruption/,
  );

  const resumedResults: GenerateTextResult[] = [
    {
      text: "I will inspect the source.",
      toolCalls: [
        {
          id: "call-after-resume",
          name: "web_fetch",
          input: { url: "https://example.test/source" },
        },
      ],
      modelId: "model-replay",
      providerId: "provider-replay",
      protocol: "openai-compatible",
      adapterName: "record-test",
      stopReason: "tool_calls",
      raw: {},
    },
    {
      text: "Source evidence says the value is 42.",
      modelId: "model-replay",
      providerId: "provider-replay",
      protocol: "openai-compatible",
      adapterName: "record-test",
      stopReason: "stop",
      raw: {},
    },
  ];
  let modelIndex = 0;
  const resumedGateway = Object.create(LLMGateway.prototype) as LLMGateway;
  resumedGateway.generate = async () => {
    const result = resumedResults[modelIndex++];
    if (!result) throw new Error("resumed model script exhausted");
    return structuredClone(result);
  };
  const recorded = await new LLMRoleResponseGenerator({
    gateway: resumedGateway,
    toolLoop: { executor, maxRounds: 4, maxWallClockMs: 60_000 },
    runJournalStore: store,
  }).generate({ activation, packet });
  const replaySeed = recorded.metadata?.engineRunReplay as {
    resumeState?: { toolTrace?: unknown[] };
  };
  assert.deepEqual(replaySeed.resumeState?.toolTrace, []);

  const replay = await replayEngineRunRecord({
    replayId: "resume-boundary-replay",
    layer: "role",
    status: "completed",
    recordedAt: 100,
    threadId: activation.thread.threadId,
    flowId: activation.flow.flowId,
    roleId: activation.runState.roleId,
    taskId: activation.handoff.taskId,
    summary: recorded.content,
    metadata: {
      runTrace: recorded.metadata?.runTrace,
      engineRunReplay: {
        ...(recorded.metadata?.engineRunReplay as Record<string, unknown>),
        activation,
        packet,
        toolUse: recorded.metadata?.toolUse,
      },
    },
  } satisfies ReplayRecord);
  assert.equal(replay.finalText, recorded.content);
  assert.deepEqual(replay.toolCalls.map((call) => call.id), [
    "call-after-resume",
  ]);
});

function inMemoryMessageStore(): {
  append(message: TeamMessage): Promise<void>;
  get(messageId: string): Promise<TeamMessage | null>;
  list(threadId: string): Promise<TeamMessage[]>;
} {
  const messages = new Map<string, TeamMessage>();
  return {
    async append(message) {
      messages.set(message.id, structuredClone(message));
    },
    async get(messageId) {
      const message = messages.get(messageId);
      return message ? structuredClone(message) : null;
    },
    async list(threadId) {
      return [...messages.values()]
        .filter((message) => message.threadId === threadId)
        .map((message) => structuredClone(message));
    },
  };
}

function replayTestArtifactStore(): ToolResultArtifactStore {
  return {
    async put(input) {
      return {
        protocol: TOOL_RESULT_ARTIFACT_PROTOCOL,
        artifactId: `artifact-${input.toolCallId}`,
        threadId: input.threadId,
        runKey: input.runKey,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        sizeBytes: Buffer.byteLength(input.content, "utf8"),
        sha256: "test-sha256",
        createdAt: input.createdAt,
      };
    },
    async read() {
      return null;
    },
  };
}

function incrementingClock(): { now(): number } {
  let now = 1_000;
  return { now: () => (now += 10) };
}

function webFetchDefinition(): LLMToolDefinition {
  return {
    name: "web_fetch",
    description: "Fetch a public source.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  };
}

function replayPacket(): RolePromptPacket {
  return {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "Use tools when evidence is required.",
    taskPrompt: "Fetch https://example.test/source and report the value.",
    outputContract: "Return the source-backed value.",
    suggestedMentions: [],
  };
}

function replayActivation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-replay",
      teamId: "team-replay",
      teamName: "Replay Team",
      leadRoleId: "role-lead",
      roles: [
        {
          roleId: "role-lead",
          name: "Lead",
          seat: "lead",
          runtime: "local",
          model: { provider: "test", name: "model-replay" },
        },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-replay",
      threadId: "thread-replay",
      rootMessageId: "msg-root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 6,
      edges: [],
      shardGroups: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey: "role:role-lead:thread:thread-replay",
      threadId: "thread-replay",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 0,
      maxIterations: 3,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-replay",
      flowId: "flow-replay",
      sourceMessageId: "msg-root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-replay",
      payload: {
        threadId: "thread-replay",
        intent: { relayBrief: "Fetch the source.", recentMessages: [] },
      },
      createdAt: 1,
    },
  };
}

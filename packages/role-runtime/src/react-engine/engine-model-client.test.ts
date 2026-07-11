import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoleActivationInput,
  RuntimeProgressEvent,
} from "@turnkeyai/core-types/team";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import {
  createEngineModelClient,
  createRoleEngineModelClient,
} from "./engine-model-client";
import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { RolePromptPacket } from "../prompt-policy";

test("createEngineModelClient builds tool-round gateway requests and records model boundaries", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: "engine answer",
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
      toolCalls: [{ id: "call-1", name: "web_search", input: { q: "demo" } }],
    };
  };
  const warningInputs: Array<{
    messages: LLMMessage[];
    active: boolean;
    round: number;
    maxRounds: number;
  }> = [];
  const pruningSnapshots: unknown[] = [];
  const reductions: unknown[] = [];
  const memoryFlushes: unknown[] = [];
  const trace: ModelCallBoundaryTrace[] = [];
  const engineModel = createEngineModelClient({
    gateway,
    now: (() => {
      let now = 30;
      return () => ++now;
    })(),
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    baseGatewayInput: {
      modelId: "model-1",
      tools: [{ name: "web_search", description: "", inputSchema: {} }],
      messages: [{ role: "user", content: "Base prompt." }],
    },
    modelCallTrace: trace,
    maxRounds: 2,
    activeToolLoop: true,
    executionBudget: {
      applyFinalToolRoundWarning(input) {
        warningInputs.push(input);
        return input.messages;
      },
    },
    runState: {
      recordReduction(input) {
        reductions.push(input);
      },
      recordMemoryFlush(input) {
        memoryFlushes.push(input);
      },
    },
    recordPruning(snapshot) {
      pruningSnapshots.push(snapshot);
    },
  });

  const response = await engineModel.model.generate({
    messages: [{ role: "user", content: "Round prompt." }],
    tools: [{ name: "web_search", description: "", inputSchema: {} }],
    toolChoice: { name: "web_search" },
  });

  assert.equal(response.text, "engine answer");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(gatewayInputs.length, 1);
  assert.deepEqual(gatewayInputs[0]?.toolChoice, {
    type: "tool",
    name: "web_search",
  });
  assert.equal(warningInputs.length, 1);
  assert.equal(warningInputs[0]?.active, true);
  assert.equal(warningInputs[0]?.round, 0);
  assert.equal(warningInputs[0]?.maxRounds, 2);
  assert.equal(pruningSnapshots.length, 1);
  assert.equal(reductions.length, 0);
  assert.equal(memoryFlushes.length, 0);
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.phase, "tool_round");
  assert.equal(trace[0]?.round, 0);
  assert.equal(trace[0]?.toolSchemaCount, 1);
  assert.equal(trace[0]?.toolChoice, "tool:web_search");
  assert.equal(engineModel.lastResult()?.text, "engine answer");
});

test("createEngineModelClient calibrates later token estimates from provider usage", async () => {
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "检查状态。" },
  ];
  let initialRawEstimate = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text: "done",
    modelId: "model-1",
    providerId: "provider",
    protocol: "anthropic-compatible",
    adapterName: "test",
    usage: { inputTokens: initialRawEstimate + 20, outputTokens: 2 },
    requestEnvelope: {
      estimatedInputTokens: initialRawEstimate,
      inputTokenLimit: 1_000,
    } as NonNullable<GenerateTextResult["requestEnvelope"]>,
    raw: {},
  });
  const engineModel = createEngineModelClient({
    gateway,
    now: () => 1,
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    baseGatewayInput: { modelId: "model-1", messages },
    modelCallTrace: [],
    maxRounds: 2,
    activeToolLoop: true,
    executionBudget: {
      applyFinalToolRoundWarning(input) {
        return input.messages;
      },
    },
    runState: {
      recordReduction() {},
      recordMemoryFlush() {},
    },
    recordPruning() {},
  });
  initialRawEstimate = engineModel.estimateTokenBudget({ messages })
    .rawInputTokens;

  await engineModel.model.generate({ messages });
  const calibrated = engineModel.estimateTokenBudget({ messages });

  assert.equal(calibrated.source, "provider_calibrated");
  assert.equal(
    calibrated.estimatedInputTokens,
    calibrated.rawInputTokens + 20,
  );
  assert.equal(calibrated.inputTokenLimit, 1_000);
  assert.equal(
    calibrated.utilization,
    calibrated.estimatedInputTokens / 1_000,
  );
});

test("createEngineModelClient applies the observed context limit to later tool-result budgets", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text: "continue",
    modelId: "model-1",
    providerId: "provider",
    protocol: "openai-compatible",
    adapterName: "test",
    requestEnvelope: {
      estimatedInputTokens: 1_000,
      inputTokenLimit: 100_000,
    } as NonNullable<GenerateTextResult["requestEnvelope"]>,
    raw: {},
  });
  const snapshots: Array<unknown> = [];
  const engineModel = createEngineModelClient({
    gateway,
    now: () => 1,
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    baseGatewayInput: { modelId: "model-1", messages: [] },
    modelCallTrace: [],
    maxRounds: 3,
    activeToolLoop: true,
    executionBudget: {
      applyFinalToolRoundWarning(input) {
        return input.messages;
      },
    },
    runState: {
      recordReduction() {},
      recordMemoryFlush() {},
    },
    recordPruning(snapshot) {
      snapshots.push(snapshot);
    },
  });

  await engineModel.model.generate({
    messages: [{ role: "user", content: "start" }],
  });
  await engineModel.model.generate({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "tool" as const,
        toolCallId: `tool-${index}`,
        name: "web_fetch",
        content: String(index).repeat(10_000),
      })),
    ],
  });

  assert.equal(
    (snapshots[1] as { limits?: { totalMaxBytes?: number } } | undefined)
      ?.limits?.totalMaxBytes,
    60_000,
  );
});

test("createRoleEngineModelClient records pruning boundaries through role-runtime recorder", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text: "engine answer",
    modelId: "model-1",
    providerId: "provider",
    protocol: "openai-compatible",
    adapterName: "test",
    raw: {},
  });
  const events: RuntimeProgressEvent[] = [];
  const runTracePruning: Array<{ round: number; prunedToolResults: number }> = [];
  const trace: ModelCallBoundaryTrace[] = [];
  const engineModel = createRoleEngineModelClient({
    gateway,
    now: () => 4000,
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1", modelChainId: "chain-1" },
    baseGatewayInput: {
      modelId: "model-1",
      tools: [{ name: "web_search", description: "", inputSchema: {} }],
      messages: [{ role: "user", content: "Base prompt." }],
    },
    modelCallTrace: trace,
    maxRounds: 2,
    activeToolLoop: true,
    runtimeProgressRecorder: {
      async record(event) {
        events.push(event);
      },
    },
    onPruning(snapshot, round) {
      if (snapshot) {
        runTracePruning.push({ round, prunedToolResults: snapshot.prunedToolResults });
      }
    },
    executionBudget: {
      applyFinalToolRoundWarning(input) {
        return input.messages;
      },
    },
    runState: {
      recordReduction() {},
      recordMemoryFlush() {},
    },
  });

  await engineModel.model.generate({
    messages: buildPruningMessages(),
    tools: [{ name: "web_search", description: "", inputSchema: {} }],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.metadata?.boundaryKind, "tool_result_pruning");
  assert.equal(events[0]?.metadata?.modelId, "model-1");
  assert.equal(events[0]?.metadata?.modelChainId, "chain-1");
  assert.equal(
    typeof events[0]?.metadata?.toolResultCountBefore,
    "number",
  );
  assert.equal(
    typeof events[0]?.metadata?.toolResultCountAfter,
    "number",
  );
  assert.ok(
    Number(events[0]?.metadata?.toolResultBytesBefore) >
      Number(events[0]?.metadata?.toolResultBytesAfter),
  );
  assert.deepEqual(runTracePruning, [{ round: 0, prunedToolResults: 16 }]);
});

test("createEngineModelClient leaves ordinary long history to calibrated checkpoint compaction", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input) => {
    gatewayInputs.push(input);
    return {
      text: "bounded answer",
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const engineModel = createEngineModelClient({
    gateway,
    now: () => 1,
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    baseGatewayInput: {
      modelId: "model-1",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "task" },
      ],
    },
    modelCallTrace: [],
    maxRounds: 20,
    activeToolLoop: true,
    executionBudget: {
      applyFinalToolRoundWarning(input) {
        return input.messages;
      },
    },
    runState: {
      recordReduction() {},
      recordMemoryFlush() {},
    },
    recordPruning() {},
  });
  const roundMessages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    ...Array.from({ length: 23 }, (_, index): LLMMessage => ({
      role: index % 2 === 0 ? "assistant" : "user",
      content: `repair or continuation round ${index + 1}`,
    })),
  ];

  await engineModel.model.generate({ messages: roundMessages });

  assert.equal(gatewayInputs[0]?.messages.length, roundMessages.length);
  assert.doesNotMatch(
    String(gatewayInputs[0]?.messages[2]?.content ?? ""),
    /Earlier loop history compacted/,
  );
  assert.equal(
    gatewayInputs[0]?.messages.at(-1)?.content,
    "repair or continuation round 23",
  );
});

function buildPruningMessages(): LLMMessage[] {
  return [
    { role: "user", content: "summarize the tool evidence" },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: "tool" as const,
      toolCallId: `call-${index}`,
      name: "web_search",
      content: `tool result ${index}\n${"x".repeat(5000)}`,
    })),
  ];
}

function buildActivation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Team",
      leadRoleId: "role-lead",
      roles: [{ roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" }],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "msg-root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 4,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey: "role:role-lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 0,
      maxIterations: 4,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-1",
      flowId: "flow-1",
      sourceMessageId: "msg-root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-1",
      payload: { threadId: "thread-1", intent: { relayBrief: "Handle task.", recentMessages: [] } },
      createdAt: 1,
    },
  };
}

function buildPacket(): RolePromptPacket {
  return {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "Lead role.",
    taskPrompt: "Use the web_search tool, then answer.",
    outputContract: "Return the final answer only.",
    suggestedMentions: [],
  };
}

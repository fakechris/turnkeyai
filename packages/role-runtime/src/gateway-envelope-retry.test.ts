import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { GenerateTextInput } from "@turnkeyai/llm-adapter/index";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { generateWithEnvelopeRetry } from "./gateway-envelope-retry";
import type { ModelCallBoundaryTrace } from "./model-call-trace";
import type { PreCompactionMemoryFlusher } from "./pre-compaction-memory-flusher";
import type { RolePromptPacket } from "./prompt-policy";
import type {
  RunLifecycleEvent,
  RunLifecycleRecorder,
} from "./react-engine/run-lifecycle";

test("generateWithEnvelopeRetry maps physical provider attempts into run lifecycle context", async () => {
  const lifecycleEvents: RunLifecycleEvent[] = [];
  const lifecycle: RunLifecycleRecorder = {
    allocateModelCall(phase, round) {
      return `${phase}:${round ?? "none"}:1`;
    },
    async record(event) {
      lifecycleEvents.push(event);
    },
    snapshot() {
      return {
        events: [...lifecycleEvents],
        totals: {
          startedModelAttempts: 0,
          completedModelAttempts: 0,
          failedModelAttempts: 0,
          retryWaits: 0,
          providerActivityEvents: 0,
        },
        inFlightAttemptIds: [],
      };
    },
  };
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    input.onProviderLifecycle?.({
      kind: "attempt_started",
      at: 100,
      attempt: 1,
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
    });
    input.onProviderLifecycle?.({
      kind: "activity",
      at: 110,
      attempt: 1,
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      activity: "event",
    });
    input.onProviderLifecycle?.({
      kind: "attempt_completed",
      at: 120,
      attempt: 1,
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
    });
    return {
      text: "ok",
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
    };
  };

  await generateWithEnvelopeRetry({
    gateway,
    now: () => 200,
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    gatewayInput: {
      modelId: "model-1",
      messages: [{ role: "user", content: "Run the task." }],
    },
    lifecycle,
    tracePhase: "tool_round",
    traceRound: 2,
  });

  assert.deepEqual(lifecycleEvents, [
    {
      kind: "model_attempt_started",
      at: 100,
      attemptId: "tool_round:2:1:1",
      phase: "tool_round",
      round: 2,
    },
    {
      kind: "provider_activity",
      at: 110,
      attemptId: "tool_round:2:1:1",
      activity: "event",
    },
    {
      kind: "model_attempt_completed",
      at: 120,
      attemptId: "tool_round:2:1:1",
    },
  ]);
});

test("generateWithEnvelopeRetry flushes memory once and retries with a reduced envelope", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      throw makeOverflowError();
    }
    return {
      text: "reduced answer",
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const flushCalls: Array<{ modelId?: string; diagnosticsPromptBytes?: number }> = [];
  const flusher: PreCompactionMemoryFlusher = {
    async flush(input) {
      flushCalls.push({
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.diagnostics?.promptBytes === undefined
          ? {}
          : { diagnosticsPromptBytes: input.diagnostics.promptBytes }),
      });
      return {
        status: "written",
        preferences: [],
        constraints: ["Keep direct APIs first."],
        longTermNotes: [],
      };
    },
  };
  const trace: ModelCallBoundaryTrace[] = [];

  const generated = await generateWithEnvelopeRetry({
    gateway,
    now: (() => {
      let now = 100;
      return () => ++now;
    })(),
    preCompactionMemoryFlusher: flusher,
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    gatewayInput: {
      modelId: "model-1",
      messages: [{ role: "user", content: "Run the task." }],
    },
    modelCallTrace: trace,
    tracePhase: "tool_round",
    traceRound: 2,
  });

  assert.equal(generated.result.text, "reduced answer");
  assert.equal(gatewayInputs.length, 2);
  assert.equal(generated.reduction?.level, "compact");
  assert.deepEqual(generated.memoryFlush, {
    status: "written",
    preferences: [],
    constraints: ["Keep direct APIs first."],
    longTermNotes: [],
  });
  assert.deepEqual(flushCalls, [
    { modelId: "model-1", diagnosticsPromptBytes: 200_000 },
  ]);
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.round, 2);
  assert.equal(trace[0]?.reductionLevel, "compact");
});

test("generateWithEnvelopeRetry tries a forced checkpoint after memory flush and before prompt reduction", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (gatewayInput: GenerateTextInput) => {
    gatewayInputs.push(gatewayInput);
    if (gatewayInputs.length === 1) {
      throw makeOverflowError();
    }
    return {
      text: "checkpoint retry answer",
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const sequence: string[] = [];
  const generated = await generateWithEnvelopeRetry({
    gateway,
    now: () => 100,
    preCompactionMemoryFlusher: {
      async flush() {
        sequence.push("memory_flush");
        return {
          status: "written",
          preferences: [],
          constraints: [],
          longTermNotes: [],
        };
      },
    },
    forceCompact: async ({ messages, diagnostics }) => {
      sequence.push("force_checkpoint");
      assert.equal(diagnostics.promptBytes, 200_000);
      return {
        messages: [
          ...messages.slice(0, 2),
          {
            role: "user",
            content: "TurnkeyAI runtime checkpoint v1\n{\"summary\":\"old history\"}",
          },
        ],
      };
    },
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    gatewayInput: {
      modelId: "model-1",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "task" },
        { role: "assistant", content: "old history" },
      ],
    },
  });

  assert.deepEqual(sequence, ["memory_flush", "force_checkpoint"]);
  assert.equal(gatewayInputs.length, 2);
  assert.match(String(gatewayInputs[1]?.messages[2]?.content), /runtime checkpoint/);
  assert.equal(generated.reduction, undefined);
  assert.deepEqual(generated.forcedCompaction, {
    messageCountBefore: 3,
    messageCountAfter: 3,
  });
});

test("generateWithEnvelopeRetry does not hide non-overflow provider errors after forced compaction", async () => {
  let gatewayCalls = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      throw makeOverflowError();
    }
    throw new Error("provider authentication failed");
  };

  await assert.rejects(
    generateWithEnvelopeRetry({
      gateway,
      now: () => 100,
      forceCompact: async ({ messages }) => ({
        messages: [...messages, { role: "user", content: "checkpoint" }],
      }),
      activation: buildActivation(),
      packet: buildPacket(),
      selection: { modelId: "model-1" },
      gatewayInput: {
        modelId: "model-1",
        messages: [{ role: "user", content: "task" }],
      },
    }),
    /provider authentication failed/,
  );

  assert.equal(gatewayCalls, 2);
});

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
    taskPrompt: "Use direct provider APIs before browser fallback.",
    outputContract: "Return a concise answer.",
    suggestedMentions: [],
  };
}

function makeOverflowError(): RequestEnvelopeOverflowError {
  return new RequestEnvelopeOverflowError({
    diagnostics: {
      messageCount: 4,
      promptChars: 180_000,
      promptBytes: 200_000,
      metadataBytes: 64,
      artifactCount: 18,
      toolCount: 1,
      toolSchemaBytes: 512,
      toolResultCount: 1,
      toolResultBytes: 256,
      inlineAttachmentBytes: 0,
      inlineImageCount: 0,
      inlineImageBytes: 0,
      inlinePdfCount: 0,
      inlinePdfBytes: 0,
      multimodalPartCount: 0,
      totalSerializedBytes: 210_000,
      overLimitKeys: ["promptChars", "promptBytes", "artifactCount"],
    },
  });
}

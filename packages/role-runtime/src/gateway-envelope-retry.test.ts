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

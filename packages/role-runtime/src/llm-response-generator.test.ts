import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { GenerateTextInput } from "@turnkeyai/llm-adapter/index";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { RolePromptPacket } from "./prompt-policy";

test("llm role response generator retries with a smaller request envelope after overflow", async () => {
  const inputs: Array<{ prompt: string; artifactIds: string[] }> = [];
  const progressEvents: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    inputs.push({
      prompt: input.messages[1]?.content ?? "",
      artifactIds: input.envelope?.artifactIds ?? [],
    });
    if (inputs.length <= 3) {
      throw new RequestEnvelopeOverflowError({
        diagnostics: {
          messageCount: 2,
          promptChars: 180_000,
          promptBytes: 200_000,
          metadataBytes: 64,
          artifactCount: 18,
          toolCount: 0,
          toolSchemaBytes: 0,
          toolResultCount: 0,
          toolResultBytes: 0,
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
    return {
      text: "Reduced prompt result.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
      requestEnvelope: {
        messageCount: 2,
        promptChars: 4_000,
        promptBytes: 4_500,
        metadataBytes: 64,
        artifactCount: input.envelope?.artifactIds?.length ?? 0,
        toolCount: input.envelope?.toolCount ?? 0,
        toolSchemaBytes: input.envelope?.toolSchemaBytes ?? 0,
        toolResultCount: input.envelope?.toolResultCount ?? 0,
        toolResultBytes: input.envelope?.toolResultBytes ?? 0,
        inlineAttachmentBytes: input.envelope?.inlineAttachmentBytes ?? 0,
        inlineImageCount: input.envelope?.inlineImageCount ?? 0,
        inlineImageBytes: input.envelope?.inlineImageBytes ?? 0,
        inlinePdfCount: input.envelope?.inlinePdfCount ?? 0,
        inlinePdfBytes: input.envelope?.inlinePdfBytes ?? 0,
        multimodalPartCount: input.envelope?.multimodalPartCount ?? 0,
        totalSerializedBytes: 5_000,
        overLimitKeys: [],
      },
    };
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    runtimeProgressRecorder: {
      async record(event) {
        progressEvents.push({
          summary: event.summary,
          ...(event.metadata ? { metadata: event.metadata } : {}),
        });
      },
    },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Reduced prompt result.");
  assert.equal(inputs.length, 4);
  assert.ok(inputs[1]!.prompt.length < inputs[0]!.prompt.length);
  assert.ok(inputs[3]!.prompt.length < inputs[2]!.prompt.length);
  assert.ok(inputs[1]!.prompt.includes("Request envelope reduction:"));
  assert.ok(inputs[2]!.prompt.includes("Reduction level: minimal"));
  assert.ok(inputs[3]!.prompt.includes("Reduction level: reference-only"));
  assert.deepEqual(inputs[1]!.artifactIds, ["artifact-1", "artifact-2", "artifact-3", "artifact-4", "artifact-5", "artifact-6", "artifact-7", "artifact-8"]);
  assert.deepEqual(inputs[2]!.artifactIds, ["artifact-1", "artifact-2", "artifact-3"]);
  assert.deepEqual(inputs[3]!.artifactIds, []);
  assert.deepEqual(
    result.metadata?.requestEnvelopeReduction,
    {
      level: "reference-only",
      omittedSections: ["recent-turns", "role-scratchpad", "retrieved-memory", "worker-evidence"],
    }
  );
  assert.equal(progressEvents.length, 1);
  assert.match(progressEvents[0]?.summary ?? "", /reduced to reference-only/i);
  assert.equal(progressEvents[0]?.metadata?.["boundaryKind"], "request_envelope_reduction");
  assert.equal(progressEvents[0]?.metadata?.["modelId"], "claude-test");
  assert.deepEqual(progressEvents[0]?.metadata?.["omittedSections"], [
    "recent-turns",
    "role-scratchpad",
    "retrieved-memory",
    "worker-evidence",
  ]);
  assert.equal(progressEvents[0]?.metadata?.["assemblyFingerprint"], "fp");
  assert.deepEqual(progressEvents[0]?.metadata?.["usedArtifacts"], []);
  assert.equal((progressEvents[0]?.metadata?.["envelopeHint"] as { toolResultCount?: number } | undefined)?.toolResultCount, 0);
});

test("llm role response generator forwards model chain and model ref routing", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: "ok",
      modelId: "gpt-5",
      modelChainId: "reasoning_primary",
      attemptedModelIds: ["gpt-5"],
      providerId: "openai",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const generator = new LLMRoleResponseGenerator({ gateway });

  await generator.generate({
    activation: buildActivation({
      modelRef: "gpt-5",
      modelChain: "reasoning_primary",
    }, { omitLegacyModel: true }),
    packet: buildPacket(),
  });

  assert.equal(gatewayInputs.length, 1);
  assert.equal(gatewayInputs[0]?.modelId, "gpt-5");
  assert.equal(gatewayInputs[0]?.modelChainId, "reasoning_primary");
});

test("llm role response generator emits a boundary event when prompt assembly is already compacted", async () => {
  const progressEvents: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text: "ok",
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible",
    adapterName: "test",
    raw: {},
  });
  const generator = new LLMRoleResponseGenerator({
    gateway,
    runtimeProgressRecorder: {
      async record(event) {
        progressEvents.push({
          summary: event.summary,
          ...(event.metadata ? { metadata: event.metadata } : {}),
        });
      },
    },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      promptAssembly: {
        ...buildPacket().promptAssembly!,
        compactedSegments: ["recent-turns", "worker-evidence"],
      },
    },
  });

  assert.equal(progressEvents.length, 1);
  assert.match(progressEvents[0]?.summary ?? "", /compact boundary/i);
  assert.equal(progressEvents[0]?.metadata?.["boundaryKind"], "prompt_compaction");
  assert.equal(progressEvents[0]?.metadata?.["modelId"], "claude-test");
  assert.equal(progressEvents[0]?.metadata?.["assemblyFingerprint"], "fp");
  assert.deepEqual(progressEvents[0]?.metadata?.["compactedSegments"], ["recent-turns", "worker-evidence"]);
});

test("llm role response generator ignores boundary recorder failures", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text: "ok",
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible",
    adapterName: "test",
    raw: {},
  });
  const generator = new LLMRoleResponseGenerator({
    gateway,
    runtimeProgressRecorder: {
      async record() {
        throw new Error("progress recorder unavailable");
      },
    },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      promptAssembly: {
        ...buildPacket().promptAssembly!,
        compactedSegments: ["recent-turns"],
      },
    },
  });

  assert.equal(result.content, "ok");
});

function buildActivation(
  roleOverrides?: Partial<RoleActivationInput["thread"]["roles"][number]>,
  options?: { omitLegacyModel?: boolean }
): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Test Team",
      leadRoleId: "role-lead",
      roles: [
        {
          roleId: "role-lead",
          name: "Lead",
          seat: "lead",
          runtime: "local",
          ...(options?.omitLegacyModel
            ? {}
            : {
                model: {
                  provider: "anthropic",
                  name: "claude-test",
                },
              }),
          ...roleOverrides,
        },
      ],
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
      maxHops: 6,
      edges: [],
      shardGroups: [],
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
      maxIterations: 3,
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
      payload: {
        threadId: "thread-1",
        intent: {
          relayBrief: "Handle the task.",
          recentMessages: [],
        },
        relayBrief: "Handle the task.",
        recentMessages: [],
      },
      createdAt: 1,
    },
  };
}

function buildPacket(): RolePromptPacket {
  const artifactIds = Array.from({ length: 12 }, (_, index) => `artifact-${index + 1}`);
  return {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "You are the lead role.\nFollow instructions carefully.",
    taskPrompt: [
      "Task brief:\nFinish the current answer and report back.",
      "Recent turns:\n[user] Older turn one.\n[user] Older turn two.\n[user] Older turn three.",
      "Role scratchpad:\nCompleted: drafted outline\nPending: answer the final question",
      "Retrieved memory:\nPrior memory hit one.\nPrior memory hit two.",
      "Worker evidence:\nbrowser [api / promotable / full]: captured the page",
      "Execution continuity:\nSource: worker_interrupt\nSummary: keep going from the same browser state",
    ].join("\n\n"),
    outputContract: "Return a concise final answer.",
    suggestedMentions: [],
    promptAssembly: {
      tokenEstimate: {
        inputTokens: 10_000,
        outputTokensReserved: 1_200,
        totalProjectedTokens: 11_200,
        overBudget: false,
      },
      omittedSegments: [],
      includedSegments: ["task-brief", "recent-turns", "role-scratchpad", "retrieved-memory", "worker-evidence"],
      sectionOrder: ["task-brief", "recent-turns", "role-scratchpad", "retrieved-memory", "worker-evidence"],
      compactedSegments: [],
      assemblyFingerprint: "fp",
      usedArtifacts: artifactIds,
      envelopeHint: {
        toolResultCount: 8,
        toolResultBytes: 4_096,
      },
    },
  };
}

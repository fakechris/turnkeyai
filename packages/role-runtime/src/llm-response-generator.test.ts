import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput, TeamMessage } from "@turnkeyai/core-types/team";
import type { GenerateTextInput, GenerateTextResult } from "@turnkeyai/llm-adapter/index";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { PreCompactionMemoryFlusher } from "./pre-compaction-memory-flusher";
import type { RolePromptPacket } from "./prompt-policy";
import type { RoleToolExecutionInput, RoleToolExecutor } from "./tool-use";

test("llm role response generator retries with a smaller request envelope after overflow", async () => {
  const inputs: Array<{ prompt: string; artifactIds: string[] }> = [];
  const progressEvents: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    inputs.push({
      prompt:
        typeof input.messages[1]?.content === "string"
          ? input.messages[1]?.content
          : JSON.stringify(input.messages[1]?.content ?? ""),
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
  assert.equal(
    ((progressEvents[0]?.metadata?.["contextDiagnostics"] as { continuity?: { carriesPendingWork?: boolean } } | undefined)
      ?.continuity?.carriesPendingWork),
    true
  );
  assert.equal((progressEvents[0]?.metadata?.["envelopeHint"] as { toolResultCount?: number } | undefined)?.toolResultCount, 0);
});

test("llm role response generator flushes memory once before request-envelope reduction", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const flushCalls: Array<{ taskPrompt: string; modelId?: string }> = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      throw makeOverflowError();
    }
    return {
      text: "Reduced prompt result.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const preCompactionMemoryFlusher: PreCompactionMemoryFlusher = {
    async flush(input) {
      flushCalls.push({
        taskPrompt: input.packet.taskPrompt,
        ...(input.modelId ? { modelId: input.modelId } : {}),
      });
      return {
        status: "written",
        preferences: [],
        constraints: ["Keep direct provider APIs before browser fallback."],
        longTermNotes: ["Open item: confirm browser fallback only when APIs are blocked."],
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    preCompactionMemoryFlusher,
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Reduced prompt result.");
  assert.equal(flushCalls.length, 1);
  assert.equal(flushCalls[0]?.modelId, "claude-test");
  assert.match(flushCalls[0]?.taskPrompt ?? "", /Recent turns:/);
  assert.ok(
    gatewayInputs[1]?.messages.some((message) =>
      typeof message.content === "string" && message.content.includes("Request envelope reduction:")
    )
  );
  assert.deepEqual(result.metadata?.preCompactionMemoryFlushes, [
    {
      status: "written",
      preferences: [],
      constraints: ["Keep direct provider APIs before browser fallback."],
      longTermNotes: ["Open item: confirm browser fallback only when APIs are blocked."],
    },
  ]);
});

test("llm role response generator passes AbortSignal to gateway requests", async () => {
  const inputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput): Promise<GenerateTextResult> => {
    inputs.push(input);
    return {
      text: "ok",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const controller = new AbortController();
  const generator = new LLMRoleResponseGenerator({ gateway });

  await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
    signal: controller.signal,
  });

  assert.equal(inputs[0]?.signal, controller.signal);
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
  assert.equal(
    ((progressEvents[0]?.metadata?.["contextDiagnostics"] as { retrievedMemory?: { packedCount?: number } } | undefined)
      ?.retrievedMemory?.packedCount),
    2
  );
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

test("llm role response generator runs native tool-use loop and feeds tool results back", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const progressEvents: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I need a browser worker.",
        contentBlocks: [
          { type: "text", text: "I need a browser worker." },
          {
            type: "tool_use",
            id: "toolu-1",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "Open example.com" },
          },
        ],
        toolCalls: [
          {
            id: "toolu-1",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "Open example.com" },
          },
        ],
        stopReason: "tool_use",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "The browser worker reported Example Domain.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      assert.equal(input.call.name, "sessions_spawn");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ task_id: "task-1", status: "completed", result: "Example Domain" }),
        progress: [
          {
            phase: "completed",
            toolName: input.call.name,
            summary: "sessions_spawn completed",
          },
        ],
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4 },
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

  assert.equal(result.content, "The browser worker reported Example Domain.");
  assert.equal(gatewayInputs.length, 2);
  assert.equal(gatewayInputs[0]?.tools?.[0]?.name, "sessions_spawn");
  assert.equal(gatewayInputs[0]?.toolChoice, "auto");
  assert.equal(gatewayInputs[1]?.messages.at(-2)?.role, "assistant");
  assert.equal(gatewayInputs[1]?.messages.at(-1)?.role, "tool");
  assert.equal(gatewayInputs[1]?.messages.at(-1)?.toolCallId, "toolu-1");
  assert.equal((result.metadata?.toolUse as { toolCallCount?: number } | undefined)?.toolCallCount, 1);
  assert.ok(progressEvents.some((event) => event.summary.includes("Tool call started: sessions_spawn")));
  assert.ok(progressEvents.some((event) => event.summary.includes("sessions_spawn completed")));
});

test("llm role response generator serializes order-dependent tool batches", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I need durable memory.",
        toolCalls: [
          {
            id: "toolu-search",
            name: "memory_search",
            input: { query: "Helios-47" },
          },
          {
            id: "toolu-get",
            name: "memory_get",
            input: { memory_id: "thread-1:note:1" },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Memory recalled.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executionOrder: string[] = [];
  let activeTools = 0;
  let maxActiveTools = 0;
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "memory_search",
          description: "Search memory",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "memory_get",
          description: "Read memory",
          inputSchema: { type: "object", properties: { memory_id: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      activeTools += 1;
      maxActiveTools = Math.max(maxActiveTools, activeTools);
      executionOrder.push(input.call.name);
      await Promise.resolve();
      activeTools -= 1;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ ok: true, tool: input.call.name }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4, maxParallelToolCalls: 5 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Memory recalled.");
  assert.deepEqual(executionOrder, ["memory_search", "memory_get"]);
  assert.equal(maxActiveTools, 1);
  const toolResultIds = gatewayInputs[1]?.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.toolCallId);
  assert.deepEqual(toolResultIds, ["toolu-search", "toolu-get"]);
});

test("llm role response generator disables native tools when packet requests no tool use", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executeCalled = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: "I should summarize existing evidence only.",
      toolCalls: [
        {
          id: "toolu-ignored",
          name: "sessions_spawn",
          input: { agent_id: "explore", task: "Search again" },
        },
      ],
      stopReason: "tool_use",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object" },
        },
      ];
    },
    async execute() {
      executeCalled = true;
      return {
        toolCallId: "toolu-ignored",
        toolName: "sessions_spawn",
        content: "should not run",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      toolUseMode: "disabled",
    },
  });

  assert.equal(result.content, "I should summarize existing evidence only.");
  assert.equal(gatewayInputs.length, 1);
  assert.equal(gatewayInputs[0]?.tools, undefined);
  assert.equal(gatewayInputs[0]?.toolChoice, undefined);
  assert.equal(executeCalled, false);
});

test("llm role response generator persists native tool progress while the tool is running", async () => {
  const storedMessages = new Map<string, TeamMessage>();
  const appendedMessages: TeamMessage[] = [];
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will use a specialist.",
        toolCalls: [
          {
            id: "toolu-live",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "Open example.com" },
          },
        ],
        stopReason: "tool_use",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Done.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };

  let resolveTool!: () => void;
  let executeStarted!: () => void;
  const executeStartedPromise = new Promise<void>((resolve) => {
    executeStarted = resolve;
  });
  const toolReleasePromise = new Promise<void>((resolve) => {
    resolveTool = resolve;
  });
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executeStarted();
      await toolReleasePromise;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "Example Domain",
        progress: [
          {
            phase: "progress",
            toolName: input.call.name,
            summary: "Browser snapshot captured",
          },
        ],
      };
    },
  };
  let now = 1_000;
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4 },
    nativeToolMessageStore: {
      async append(message) {
        appendedMessages.push(message);
        storedMessages.set(message.id, message);
      },
    },
    clock: {
      now: () => now++,
    },
  });

  const resultPromise = generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  await executeStartedPromise;
  const pendingAssistant = storedMessages.get("task-1:tool-round:1:assistant");
  assert.equal(pendingAssistant?.role, "assistant");
  assert.equal(pendingAssistant?.toolStatus, "pending");
  assert.equal(pendingAssistant?.toolCalls?.[0]?.name, "sessions_spawn");
  assert.equal(pendingAssistant?.toolProgress?.[0]?.phase, "started");
  assert.equal(storedMessages.has("task-1:tool-round:1:result:toolu-live"), false);

  resolveTool();
  const result = await resultPromise;

  assert.equal(result.content, "Done.");
  const completedAssistant = storedMessages.get("task-1:tool-round:1:assistant");
  const toolMessage = storedMessages.get("task-1:tool-round:1:result:toolu-live");
  assert.equal(completedAssistant?.toolStatus, "completed");
  assert.equal(completedAssistant?.toolProgress?.some((event) => event.summary === "Browser snapshot captured"), true);
  assert.equal(completedAssistant?.toolProgress?.at(-1)?.phase, "completed");
  assert.equal(completedAssistant?.timeCost, 4);
  assert.equal(toolMessage?.role, "tool");
  assert.equal(toolMessage?.toolCallId, "toolu-live");
  assert.equal(toolMessage?.content, "Example Domain");
  assert.equal(toolMessage?.timeCost, 4);
  assert.ok(appendedMessages.length >= 3);
});

test("llm role response generator preserves tool history when envelope retry reduces later rounds", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will ask a specialist.",
        toolCalls: [
          {
            id: "toolu-retry",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "Inspect the page" },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 2) {
      assert.equal(input.messages.at(-1)?.role, "tool");
      throw makeOverflowError();
    }
    return {
      text: "Specialist result preserved.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed", result: "Page inspected" }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Specialist result preserved.");
  assert.equal(gatewayInputs.length, 3);
  assert.equal(gatewayInputs[2]?.messages.at(-2)?.role, "assistant");
  assert.equal(gatewayInputs[2]?.messages.at(-1)?.role, "tool");
  assert.equal(gatewayInputs[2]?.messages.at(-1)?.toolCallId, "toolu-retry");
  assert.equal(gatewayInputs[2]?.envelope?.toolResultCount, 1);
});

test("llm role response generator prunes older oversized tool results before later rounds", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const largeA = "A".repeat(20_000);
  const largeB = "B".repeat(20_000);
  const largeC = "C".repeat(20_000);
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-a", "sessions_spawn", { agent_id: "browser", task: "First large result" });
    }
    if (gatewayInputs.length === 2) {
      return toolCallResult("toolu-b", "sessions_spawn", { agent_id: "browser", task: "Second large result" });
    }
    if (gatewayInputs.length === 3) {
      return toolCallResult("toolu-c", "sessions_spawn", { agent_id: "browser", task: "Third large result" });
    }
    return {
      text: "Done after pruning.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      const content = input.call.id === "toolu-a" ? largeA : input.call.id === "toolu-b" ? largeB : largeC;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content,
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Done after pruning.");
  assert.equal(gatewayInputs.length, 4);
  const fourthToolContents = gatewayInputs[3]?.messages
    .filter((message) => message.role === "tool")
    .map((message) => readToolContent(message.content));
  assert.equal(fourthToolContents?.length, 3);
  assert.match(fourthToolContents?.[0] ?? "", /"tool_result_pruned": true/);
  assert.match(fourthToolContents?.[0] ?? "", /"reason": "older_than_recent_window"/);
  assert.doesNotMatch(fourthToolContents?.[0] ?? "", /^A{20000}$/);
  assert.match(fourthToolContents?.[1] ?? "", /"reason": "aggregate_tool_result_budget_recent_window"/);
  assert.equal(fourthToolContents?.[2], largeC);
  assert.equal(gatewayInputs[3]?.envelope?.toolResultCount, 3);
  assert.ok((gatewayInputs[3]?.envelope?.toolResultBytes ?? 0) <= 32 * 1024);
});

test("llm role response generator prunes aggregate tool result budget before final synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const largeA = "A".repeat(8_000);
  const largeB = "B".repeat(8_000);
  const largeC = "C".repeat(8_000);
  const largeD = "D".repeat(8_000);
  const largeE = "E".repeat(8_000);
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-a", "sessions_spawn", { agent_id: "explore", task: "A" });
    }
    if (gatewayInputs.length === 2) {
      return toolCallResult("toolu-b", "sessions_spawn", { agent_id: "explore", task: "B" });
    }
    if (gatewayInputs.length === 3) {
      return toolCallResult("toolu-c", "sessions_spawn", { agent_id: "explore", task: "C" });
    }
    if (gatewayInputs.length === 4) {
      return toolCallResult("toolu-d", "sessions_spawn", { agent_id: "explore", task: "D" });
    }
    if (gatewayInputs.length === 5) {
      return toolCallResult("toolu-e", "sessions_spawn", { agent_id: "explore", task: "E" });
    }
    return {
      text: "Final synthesis after aggregate pruning.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      const byId: Record<string, string> = {
        "toolu-a": largeA,
        "toolu-b": largeB,
        "toolu-c": largeC,
        "toolu-d": largeD,
        "toolu-e": largeE,
      };
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: byId[input.call.id] ?? "",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 6 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final synthesis after aggregate pruning.");
  assert.equal(gatewayInputs.length, 6);
  assert.ok((gatewayInputs[5]?.envelope?.toolResultBytes ?? 0) <= 32 * 1024);
  const finalToolContents = gatewayInputs[5]?.messages
    .filter((message) => message.role === "tool")
    .map((message) => readToolContent(message.content));
  assert.match(finalToolContents?.[0] ?? "", /"reason": "aggregate_tool_result_budget"/);
  assert.equal(finalToolContents?.at(-2), largeD);
  assert.equal(finalToolContents?.at(-1), largeE);
});

test("llm role response generator prunes a newest tool result that alone exceeds the aggregate budget", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const hugeNewest = "Z".repeat(50_000);
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-huge", "sessions_history", {
        session_key: "worker:explore:huge",
        limit: 50,
      });
    }
    return {
      text: "Final synthesis after huge newest pruning.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_history",
          description: "Read session history",
          inputSchema: { type: "object", properties: { session_key: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: hugeNewest,
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 2 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final synthesis after huge newest pruning.");
  assert.equal(gatewayInputs.length, 2);
  assert.ok((gatewayInputs[1]?.envelope?.toolResultBytes ?? 0) <= 32 * 1024);
  const finalToolContents = gatewayInputs[1]?.messages
    .filter((message) => message.role === "tool")
    .map((message) => readToolContent(message.content));
  assert.match(finalToolContents?.[0] ?? "", /"tool_result_pruned": true/);
  assert.match(finalToolContents?.[0] ?? "", /"reason": "single_tool_result_exceeds_aggregate_budget"/);
  assert.doesNotMatch(finalToolContents?.[0] ?? "", /^Z{50000}$/);
});

test("llm role response generator compacts older tool history before message-count overflow", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length <= 8) {
      return toolCallResult(`toolu-${gatewayInputs.length}`, "sessions_spawn", {
        agent_id: "explore",
        task: `Fetch source ${gatewayInputs.length}`,
      });
    }
    return {
      text: "Final synthesis after message compaction.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed", source: input.call.input.task }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 9 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final synthesis after message compaction.");
  assert.equal(gatewayInputs.length, 9);
  assert.ok(gatewayInputs[8]!.messages.length <= 16);
  assert.equal(gatewayInputs[8]!.messages[2]?.role, "user");
  assert.match(readToolContent(gatewayInputs[8]!.messages[2]!.content), /Earlier tool history compacted/);
  assert.equal(gatewayInputs[8]!.messages.at(-1)?.role, "tool");
  assert.equal(gatewayInputs[8]!.messages.at(-1)?.toolCallId, "toolu-8");
});

test("llm role response generator synthesizes instead of falling back when tool round limit is reached", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executedTools = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length <= 3) {
      return toolCallResult(`toolu-${gatewayInputs.length}`, "sessions_spawn", {
        agent_id: "explore",
        task: `Fetch more evidence ${gatewayInputs.length}`,
      });
    }
    return {
      text: "Final answer after bounded tool use.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedTools += 1;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed", result: input.call.input.task }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 2 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final answer after bounded tool use.");
  assert.equal(executedTools, 2);
  assert.equal(gatewayInputs.length, 4);
  assert.equal(gatewayInputs[3]?.toolChoice, "none");
  assert.equal(gatewayInputs[3]?.tools, undefined);
  assert.ok(
    gatewayInputs[3]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("Tool-use round limit reached (2)")
    )
  );
  assert.ok(finalSynthesisPrompt(gatewayInputs[3])?.includes("Do not collapse requested bullets into a paragraph"));
});

test("llm role response generator synthesizes from evidence when tool wall-clock budget is reached", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executedTools = 0;
  let now = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length <= 2) {
      return toolCallResult(`toolu-${gatewayInputs.length}`, "sessions_spawn", {
        agent_id: "explore",
        task: `Fetch source ${gatewayInputs.length}`,
      });
    }
    return {
      text: "Final answer after wall-clock budget.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedTools += 1;
      now = 200;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed", result: input.call.input.task }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128, maxWallClockMs: 100 },
    clock: { now: () => now },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final answer after wall-clock budget.");
  assert.equal(executedTools, 1);
  assert.equal(gatewayInputs.length, 3);
  assert.equal(gatewayInputs[2]?.toolChoice, "none");
  assert.equal(gatewayInputs[2]?.tools, undefined);
  assert.ok(
    gatewayInputs[2]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("Tool-use wall-clock budget reached")
    )
  );
  assert.ok(finalSynthesisPrompt(gatewayInputs[2])?.includes("Final synthesis format contract"));
});

test("llm role response generator synthesizes immediately after sub-agent timeout", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executedTools = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-timeout", "sessions_spawn", {
        agent_id: "explore",
        task: "Fetch evidence from a slow source.",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    return {
      text: "Verification did not complete within the tool budget.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedTools += 1;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        isError: true,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "timeout",
          timeout_seconds: 120,
          resumable: true,
          evidence_available: false,
          tool_chain: [],
          result: "No usable evidence was gathered before timeout.",
          final_content: null,
          payload: null,
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Verification did not complete within the tool budget.");
  assert.equal(executedTools, 1);
  assert.equal(gatewayInputs.length, 2);
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("No usable evidence was gathered before the timeout")
    )
  );
  assert.ok(finalSynthesisPrompt(gatewayInputs[1])?.includes("If the task specifies a heading, bullet count"));
  assert.ok(finalSynthesisPrompt(gatewayInputs[1])?.includes("bare http:// / https:// URLs"));
  assert.ok(finalSynthesisPrompt(gatewayInputs[1])?.includes("Do not copy internal fetch URLs"));
});

test("llm role response generator synthesizes immediately after completed sub-agent final content", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executedTools = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-done", "sessions_spawn", {
        agent_id: "explore",
        task: "Research the comparison and return evidence.",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    return {
      text: "Final synthesized answer from sub-agent evidence.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_history",
          description: "Read a sub-agent session",
          inputSchema: { type: "object", properties: { session_key: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedTools += 1;
      assert.equal(input.call.name, "sessions_spawn");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-done",
          agent_id: "explore",
          status: "completed",
          result: "Sub-agent completed with evidence.",
          final_content:
            "Evidence ledger: primary source A verifies the core positioning; primary source B verifies the repository. Missing metrics are marked not verified.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Evidence ledger: primary source A verifies the core positioning; primary source B verifies the repository. Missing metrics are marked not verified.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final synthesized answer from sub-agent evidence.");
  assert.equal(executedTools, 1);
  assert.equal(gatewayInputs.length, 2);
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("Do not call sessions_history or sessions_list")
    )
  );
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("Source 1 final_content")
    )
  );
  const synthesisPrompt = finalSynthesisPrompt(gatewayInputs[1]) ?? "";
  assert.ok(synthesisPrompt.includes("Do not add extra sections, summaries, notes"));
  assert.ok(synthesisPrompt.includes("line must start with a literal prefix"));
  assert.ok(synthesisPrompt.includes("Do not write a preamble before a requested final shape"));
});

test("llm role response generator accepts short completed sub-agent final content", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-done-short", "sessions_spawn", {
        agent_id: "explore",
        task: "Return a concise verified answer.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Short final was accepted.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-done-short",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: "Verified: yes.",
          final_content: "Verified: yes.",
          payload: { mode: "llm_sub_agent", workerType: "explore", content: "Verified: yes." },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Short final was accepted.");
  assert.equal(gatewayInputs.length, 2);
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) => message.role === "user" && readToolContent(message.content).includes("Verified: yes.")
    )
  );
});

test("llm role response generator prefers completed sub-agent finals over sibling timeouts", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Calling parallel sub-agents.",
        toolCalls: [
          { id: "toolu-done", name: "sessions_spawn", input: { agent_id: "explore", task: "Return evidence." } },
          { id: "toolu-timeout", name: "sessions_spawn", input: { agent_id: "browser", task: "Slow browser work." } },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Final from completed evidence.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      if (input.call.id === "toolu-timeout") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          isError: true,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-1",
            session_key: "worker:browser:task-1:toolu-timeout",
            agent_id: "browser",
            status: "timeout",
            timeout_seconds: 120,
            evidence_available: false,
            tool_chain: [],
            result: "No usable evidence was gathered.",
            final_content: null,
            payload: null,
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-done",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: "Completed source-backed answer.",
          final_content: "Completed source-backed answer.",
          payload: { mode: "llm_sub_agent", workerType: "explore", content: "Completed source-backed answer." },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final from completed evidence.");
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("completed sub-agent final_content result")
    )
  );
  assert.ok(
    !gatewayInputs[1]?.messages.some(
      (message) => message.role === "user" && readToolContent(message.content).includes("No usable evidence was gathered before the timeout")
    )
  );
});

test("llm role response generator repairs textual tool-call markup during final synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-done", "sessions_spawn", {
        agent_id: "explore",
        task: "Research evidence.",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    if (gatewayInputs.length === 2) {
      return {
        text: '<minimax:tool_call><invoke name="sessions_history"></invoke></minimax:tool_call>',
        modelId: "minimax-test",
        providerId: "minimax",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Final answer without pseudo tool calls.",
      modelId: "minimax-test",
      providerId: "minimax",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-done",
          agent_id: "explore",
          status: "completed",
          result: "Sub-agent completed with evidence.",
          final_content:
            "Evidence ledger: source A verifies the product positioning; source B verifies the repository. Missing metrics are marked not verified.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Evidence ledger: source A verifies the product positioning; source B verifies the repository. Missing metrics are marked not verified.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final answer without pseudo tool calls.");
  assert.equal(gatewayInputs.length, 3);
  assert.ok(
    gatewayInputs[2]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("pseudo tool-call markup")
    )
  );
});

test("llm role response generator repairs textual tool-call markup after a normal tool round", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-search", "sessions_spawn", {
        agent_id: "explore",
        task: "Compare two sources.",
      });
    }
    if (gatewayInputs.length === 2) {
      return {
        text: '<minimax:tool_call><invoke name="sessions_spawn"><parameter name="agent_id">explore</parameter></invoke></minimax:tool_call>',
        modelId: "minimax-test",
        providerId: "minimax",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    return {
      text: "Final answer from existing tool evidence only.",
      modelId: "minimax-test",
      providerId: "minimax",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "tool evidence is complete",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Final answer from existing tool evidence only.");
  assert.equal(gatewayInputs.length, 3);
  assert.ok(
    gatewayInputs[2]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("pseudo tool-call markup without a native tool call")
    )
  );
});

test("llm role response generator caps parallel tool execution fan-out", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const releaseById = new Map<string, () => void>();
  let activeTools = 0;
  let maxActiveTools = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => {
    gatewayInputs.push({ messages: [], modelId: "unused" } as unknown as GenerateTextInput);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will fan out.",
        toolCalls: ["a", "b", "c"].map((id) => ({
          id: `toolu-${id}`,
          name: "sessions_spawn",
          input: { agent_id: "explore", task: `Fetch ${id}` },
        })),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Done with capped fan-out.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      activeTools += 1;
      maxActiveTools = Math.max(maxActiveTools, activeTools);
      await new Promise<void>((resolve) => {
        releaseById.set(input.call.id, resolve);
        if (releaseById.size === 2) {
          for (const release of releaseById.values()) release();
          releaseById.clear();
        }
      });
      activeTools -= 1;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed", result: input.call.input.task }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4, maxParallelToolCalls: 2 },
  });

  const resultPromise = generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });
  await waitUntil(() => releaseById.size === 1 && activeTools === 1);
  for (const release of releaseById.values()) release();
  releaseById.clear();
  const result = await resultPromise;

  assert.equal(result.content, "Done with capped fan-out.");
  assert.equal(maxActiveTools, 2);
});

test("llm role response generator skips per-turn tool calls above the execution cap", async () => {
  const executedCallIds: string[] = [];
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let calls = 0;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    calls += 1;
    if (calls === 1) {
      return {
        text: "I will over-call tools.",
        toolCalls: ["a", "b", "c"].map((id) => ({
          id: `toolu-${id}`,
          name: "sessions_spawn",
          input: { agent_id: "explore", task: `Fetch ${id}` },
        })),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Done after capped execution.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCallIds.push(input.call.id);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed", result: input.call.input.task }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 4, maxParallelToolCalls: 2, maxToolCallsPerRound: 2 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Done after capped execution.");
  assert.deepEqual(executedCallIds, ["toolu-a", "toolu-b"]);
  const secondRoundToolResults = gatewayInputs[1]?.messages
    .filter((message) => message.role === "tool")
    .map((message) => ({ toolCallId: message.toolCallId, content: readToolContent(message.content) }));
  assert.deepEqual(
    secondRoundToolResults?.map((message) => message.toolCallId),
    ["toolu-a", "toolu-b", "toolu-c"]
  );
  assert.match(secondRoundToolResults?.[2]?.content ?? "", /tool_call_limit_exceeded/);
  const trace = result.metadata?.toolUse as
    | { rounds?: Array<{ results?: Array<{ toolCallId?: string; skipped?: boolean }> }> }
    | undefined;
  assert.equal(trace?.rounds?.[0]?.results?.find((item) => item.toolCallId === "toolu-c")?.skipped, true);
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
      },
      createdAt: 1,
    },
  };
}

function toolCallResult(id: string, name: string, input: Record<string, unknown>): GenerateTextResult {
  return {
    text: "Calling a tool.",
    toolCalls: [{ id, name, input }],
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible",
    adapterName: "test",
    raw: {},
  };
}

function readToolContent(content: GenerateTextInput["messages"][number]["content"]): string {
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

function finalSynthesisPrompt(input: GenerateTextInput | undefined): string | undefined {
  const messages = input?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      readToolContent(message.content).includes("Final synthesis format contract")
    ) {
      return readToolContent(message.content);
    }
  }
  return undefined;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
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
      contextDiagnostics: {
        continuity: {
          hasThreadSummary: true,
          hasSessionMemory: true,
          hasRoleScratchpad: true,
          hasContinuationContext: true,
          carriesPendingWork: true,
          carriesWaitingOn: true,
          carriesOpenQuestions: true,
          carriesDecisionOrConstraint: true,
        },
        recentTurns: {
          availableCount: 3,
          selectedCount: 3,
          packedCount: 3,
          salientEarlierCount: 1,
          compacted: false,
        },
        retrievedMemory: {
          availableCount: 4,
          selectedCount: 3,
          packedCount: 2,
          compacted: false,
          userPreferenceCount: 0,
          threadMemoryCount: 2,
          sessionMemoryCount: 1,
          knowledgeNoteCount: 1,
          journalNoteCount: 0,
        },
        workerEvidence: {
          totalCount: 3,
          admittedCount: 2,
          selectedCount: 2,
          packedCount: 1,
          compacted: false,
          promotableCount: 1,
          observationalCount: 1,
          fullCount: 1,
          summaryOnlyCount: 1,
          continuationRelevantCount: 1,
        },
      },
      envelopeHint: {
        toolResultCount: 8,
        toolResultBytes: 4_096,
      },
    },
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoleActivationInput,
  TeamMessage,
  TeamMessageSummary,
} from "@turnkeyai/core-types/team";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { PreCompactionMemoryFlusher } from "./pre-compaction-memory-flusher";
import type { RolePromptPacket } from "./prompt-policy";
import type {
  RoleToolExecutionInput,
  RoleToolExecutionResult,
  RoleToolExecutor,
} from "./tool-use";

test("llm role response generator retries with a smaller request envelope after overflow", async () => {
  const inputs: Array<{ prompt: string; artifactIds: string[] }> = [];
  const progressEvents: Array<{
    summary: string;
    metadata?: Record<string, unknown>;
  }> = [];
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
  assert.deepEqual(inputs[1]!.artifactIds, [
    "artifact-1",
    "artifact-2",
    "artifact-3",
    "artifact-4",
    "artifact-5",
    "artifact-6",
    "artifact-7",
    "artifact-8",
  ]);
  assert.deepEqual(inputs[2]!.artifactIds, [
    "artifact-1",
    "artifact-2",
    "artifact-3",
  ]);
  assert.deepEqual(inputs[3]!.artifactIds, []);
  assert.deepEqual(result.metadata?.requestEnvelopeReduction, {
    level: "reference-only",
    omittedSections: [
      "recent-turns",
      "role-scratchpad",
      "retrieved-memory",
      "worker-evidence",
    ],
  });
  assert.equal(progressEvents.length, 1);
  assert.match(progressEvents[0]?.summary ?? "", /reduced to reference-only/i);
  assert.equal(
    progressEvents[0]?.metadata?.["boundaryKind"],
    "request_envelope_reduction",
  );
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
    (
      progressEvents[0]?.metadata?.["contextDiagnostics"] as
        | { continuity?: { carriesPendingWork?: boolean } }
        | undefined
    )?.continuity?.carriesPendingWork,
    true,
  );
  assert.equal(
    (
      progressEvents[0]?.metadata?.["envelopeHint"] as
        | { toolResultCount?: number }
        | undefined
    )?.toolResultCount,
    0,
  );
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
        longTermNotes: [
          "Open item: confirm browser fallback only when APIs are blocked.",
        ],
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
    gatewayInputs[1]?.messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("Request envelope reduction:"),
    ),
  );
  assert.deepEqual(result.metadata?.preCompactionMemoryFlushes, [
    {
      status: "written",
      preferences: [],
      constraints: ["Keep direct provider APIs before browser fallback."],
      longTermNotes: [
        "Open item: confirm browser fallback only when APIs are blocked.",
      ],
    },
  ]);
});

test("llm role response generator passes AbortSignal to gateway requests", async () => {
  const inputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (
    input: GenerateTextInput,
  ): Promise<GenerateTextResult> => {
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
    activation: buildActivation(
      {
        modelRef: "gpt-5",
        modelChain: "reasoning_primary",
      },
      { omitLegacyModel: true },
    ),
    packet: buildPacket(),
  });

  assert.equal(gatewayInputs.length, 1);
  assert.equal(gatewayInputs[0]?.modelId, "gpt-5");
  assert.equal(gatewayInputs[0]?.modelChainId, "reasoning_primary");
});

test("llm role response generator emits a boundary event when prompt assembly is already compacted", async () => {
  const progressEvents: Array<{
    summary: string;
    metadata?: Record<string, unknown>;
  }> = [];
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
  assert.equal(
    progressEvents[0]?.metadata?.["boundaryKind"],
    "prompt_compaction",
  );
  assert.equal(progressEvents[0]?.metadata?.["modelId"], "claude-test");
  assert.equal(progressEvents[0]?.metadata?.["assemblyFingerprint"], "fp");
  assert.deepEqual(progressEvents[0]?.metadata?.["compactedSegments"], [
    "recent-turns",
    "worker-evidence",
  ]);
  assert.equal(
    (
      progressEvents[0]?.metadata?.["contextDiagnostics"] as
        | { retrievedMemory?: { packedCount?: number } }
        | undefined
    )?.retrievedMemory?.packedCount,
    2,
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
  const progressEvents: Array<{
    summary: string;
    metadata?: Record<string, unknown>;
  }> = [];
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      assert.equal(input.call.name, "sessions_spawn");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          task_id: "task-1",
          status: "completed",
          result: "Example Domain",
        }),
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
  assert.equal(
    (result.metadata?.toolUse as { toolCallCount?: number } | undefined)
      ?.toolCallCount,
    1,
  );
  const modelUse = result.metadata?.modelUse as
    | {
        callCount?: number;
        source?: string;
        calls?: Array<{
          phase?: string;
          round?: number;
          modelId?: string;
          toolCallsReturned?: number;
        }>;
      }
    | undefined;
  assert.equal(modelUse?.source, "turnkeyai-role-runtime");
  assert.equal(modelUse?.callCount, 2);
  assert.equal(modelUse?.calls?.[0]?.phase, "tool_round");
  assert.equal(modelUse?.calls?.[0]?.round, 0);
  assert.equal(modelUse?.calls?.[0]?.toolCallsReturned, 1);
  assert.equal(modelUse?.calls?.[1]?.phase, "tool_round");
  assert.equal(modelUse?.calls?.[1]?.round, 1);
  assert.equal(modelUse?.calls?.[1]?.modelId, "claude-test");
  assert.ok(
    progressEvents.some((event) =>
      event.summary.includes("Tool call started: sessions_spawn"),
    ),
  );
  assert.ok(
    progressEvents.some((event) =>
      event.summary.includes("sessions_spawn completed"),
    ),
  );
  const protocolEvent = progressEvents.find(
    (event) =>
      event.metadata?.["boundaryKind"] === "provider_tool_protocol_round",
  );
  assert.ok(protocolEvent);
  assert.equal(protocolEvent.metadata?.["providerToolCallsReturned"], 1);
  assert.equal(protocolEvent.metadata?.["assistantToolUseBlockCount"], 1);
  assert.equal(protocolEvent.metadata?.["roleToolResultMessageCount"], 1);
  assert.equal(protocolEvent.metadata?.["toolResultBlockCount"], 1);
  assert.equal(protocolEvent.metadata?.["assistantBeforeToolResults"], true);
  assert.equal(
    protocolEvent.metadata?.["allToolResultsMatchAssistantToolCalls"],
    true,
  );
  assert.equal(
    protocolEvent.metadata?.["nextProviderRequestWillIncludeToolResults"],
    true,
  );
  assert.deepEqual(protocolEvent.metadata?.["toolCallIds"], ["toolu-1"]);
  assert.deepEqual(protocolEvent.metadata?.["toolResultIds"], ["toolu-1"]);
});

test("llm role response generator can defer slow tool observability off the model path", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I need a fetch worker.",
        toolCalls: [
          {
            id: "toolu-fast",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "Fetch https://example.com" },
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
    assert.equal(input.messages.at(-1)?.role, "tool");
    return {
      text: "Done from tool evidence.",
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
          description: "Spawn an explore sub-agent",
          inputSchema: { type: "object" },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "Example Domain",
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
      async record() {
        await new Promise(() => undefined);
      },
    },
    deferToolObservability: true,
  });

  const result = await Promise.race([
    generator.generate({ activation: buildActivation(), packet: buildPacket() }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("deferred tool observability blocked generation")), 100),
    ),
  ]);

  assert.equal(result.content, "Done from tool evidence.");
  assert.ok(gatewayInputs.length >= 2);
});

test("llm role response generator repairs approval-gated answers that skipped native tools", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "The approved browser dry-run is complete and verified.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "permission_query",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approval-gated browser action/,
      );
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /without native approval\/tool evidence/,
      );
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /permission_query/,
      );
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /action=browser\.form\.submit/,
      );
      return toolCallResult("toolu-query", "permission_query", {
        action: "browser.form.submit",
        title: "Approve local dry-run form submit",
        risk: "Submit isolated local dry-run form data.",
        level: "approval",
        scope: "mutate",
        rationale:
          "The user asked to carry the dry-run form submission through an approval gate.",
        worker_kind: "browser",
        payload: { url: "http://127.0.0.1/approval-form", submit: "dry-run" },
      });
    }
    if (gatewayInputs.length === 3) {
      return {
        text: "Apply the approved permission.",
        toolCalls: [
          {
            id: "toolu-result",
            name: "permission_result",
            input: { approval_id: "ap-1" },
          },
          {
            id: "toolu-applied",
            name: "permission_applied",
            input: { approval_id: "ap-1" },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 4) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open the approval form, submit the approved dry-run, and verify the post-submit status.",
      });
    }
    return {
      text: "The approved browser dry-run was submitted and verified.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "pending", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_result") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_applied") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "applied", approval_id: "ap-1" }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:browser:task-1:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved dry-run submit completed.",
          final_content:
            "Approved dry-run submit completed. Browser verified the submitted status.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Approved dry-run submit completed. Browser verified the submitted status.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved browser dry-run was submitted and verified.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [
      "permission_query",
      "permission_result",
      "permission_applied",
      "sessions_spawn",
    ],
  );
  assert.equal(executedCalls[0]?.input.action, "browser.form.submit");
  assert.equal(executedCalls[3]?.input.agent_id, "browser");
  assert.match(
    String(executedCalls[3]?.input.task),
    /submit the approved dry-run/i,
  );
  assert.equal(gatewayInputs.length, 5);
});

test("llm role response generator gates premature approval browser spawns with permission_query", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser-too-early", "sessions_spawn", {
        agent_id: "browser",
        label: "Inspect local approval form",
        task: "Open http://127.0.0.1:56633/approval-form and submit the dry-run form.",
      });
    }
    return {
      text: "Permission request is pending operator decision.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_spawn") {
        assert.equal(input.call.input.agent_id, "browser");
        assert.match(String(input.call.input.task), /Pre-approval browser inspection only/);
        assert.doesNotMatch(String(input.call.input.task), /submit the dry-run form/i);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            agent_id: "browser",
            result:
              "Rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. No form submission ran.",
            evidence_summary:
              "Final URL: http://127.0.0.1:56633/approval-form\nPage title: Approval Gate Fixture\nVisible marker: TURNKEYAI_APPROVAL_FIXTURE_OK\nSubmission control: Submit dry-run.",
          }),
        };
      }
      assert.equal(input.call.name, "permission_query");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "pending", approval_id: "ap-1" }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 2 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate; do not stop at a plan.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Permission request is pending operator decision.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "permission_query"],
  );
  assert.equal(executedCalls[1]?.input.action, "browser.form.submit");
  assert.equal(executedCalls[1]?.input.worker_kind, "browser");
  const payload = executedCalls[1]?.input.payload;
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  assert.match(String((payload as Record<string, unknown>)["url"]), /approval-form/);
});

test("llm role response generator does not gate browser report wording that says submit findings", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-browser-report", "sessions_spawn", {
        agent_id: "browser",
        label: "browser report",
        task: [
          "Open the browser-visible local source and submit the findings to the operator as a read-only report.",
          "This is an approval review note, not a form submission or browser mutation.",
          "URL: http://127.0.0.1:53499/vendor-alpha",
        ].join("\n"),
      });
    }
    return {
      text: "Final report from browser evidence.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "permission_query",
          description: "Request permission",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_spawn");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser-report",
          session_key: "worker:browser:task-browser-report:toolu-browser-report",
          agent_id: "browser",
          status: "completed",
          result: "Browser report evidence collected.",
          final_content: "Browser report evidence collected.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Use browser evidence for an approval review note; submit findings in the final report only, do not mutate a page.",
    },
  });

  assert.equal(result.content, "Final report from browser evidence.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn"],
  );
});

test("llm role response generator does not repair read-only tasks that explicitly disclaim approval-gated browser actions", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length > 1) {
      throw new Error(
        "read-only source check should not trigger approval repair",
      );
    }
    return {
      text: "Verified source facts: Release Captain owns the handoff. Residual risk: cancelled evidence lowers confidence.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
      ];
    },
    async execute() {
      throw new Error("read-only source check must not execute approval tools");
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue from the cancelled source-check attempt in this mission.",
        "This is a read-only source check; no browser form, click, navigation action, or approval-gated action is needed.",
        "Separate verified facts from unverified items, describe residual risk, and explain how the earlier cancellation affects confidence.",
      ].join("\n"),
    },
  });

  assert.equal(gatewayInputs.length, 1);
  assert.match(result.content, /Release Captain/);
  assert.doesNotMatch(result.content, /correction does not apply/i);
});

test("llm role response generator suppresses read-only permission queries that disclaim submission", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-query", "permission_query", {
        action: "browser.form.submit",
        level: "approval",
        scope: "mutate",
        worker_kind: "browser",
        rationale:
          "Applies an approval-gated browser form submission in an isolated local dry-run page.",
        payload: {
          url: "http://127.0.0.1:4100/app#/product-signals",
        },
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /read-only browser inspection does not require approval/i,
    );
    return {
      text: "Completed from existing browser evidence: Stuck missions is 6, weak answer rate is 24%, and no form submission or browser mutation ran.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
      ];
    },
    async execute() {
      throw new Error(
        "read-only permission query must not enter native approval flow",
      );
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Use the completed browser evidence from the product signal dashboard.",
        "This is a read-only inspection: open, snapshot, screenshot, and scroll only.",
        "Do not submit any form or mutate browser state.",
      ].join("\n"),
    },
  });

  assert.equal(gatewayInputs.length, 2);
  assert.match(result.content, /Stuck missions is 6/);
  assert.match(result.content, /no form submission or browser mutation ran/i);
});

test("llm role response generator suppresses AsiaWalk read-only planning permission queries", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-asiawalk-query", "permission_query", {
        action: "browser.form.submit",
        title: "Approve local dry-run browser form submission",
        risk:
          "Applies an approval-gated browser form submission in an isolated local dry-run page.",
        level: "approval",
        scope: "mutate",
        worker_kind: "browser",
        payload: {
          task: "approval-gated browser form submission",
        },
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /read-only browser inspection does not require approval/i,
    );
    return {
      text: "AsiaWalk recommendation: proceed conditionally. Seoul, Taipei, and Tokyo evidence is covered; budget is $1,280 with $180 contingency; rain remains a Taipei risk.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
      ];
    },
    async execute() {
      throw new Error(
        "AsiaWalk read-only planning must not enter native approval flow",
      );
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Build an AsiaWalk pilot recommendation from the listed sources.",
        "This is a read-only planning brief.",
        "Do not click forms, submit anything, simulate deposits, or request approval; only inspect the listed sources and synthesize a recommendation.",
      ].join("\n"),
    },
  });

  assert.equal(gatewayInputs.length, 2);
  assert.match(result.content, /AsiaWalk recommendation/i);
  assert.match(result.content, /\$1,280/);
});

test("llm role response generator suppresses provider pricing read-only permission queries", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-provider-query", "permission_query", {
        action: "browser.form.submit",
        title: "Approve local dry-run browser form submission",
        risk:
          "Applies an approval-gated browser form submission in an isolated local dry-run page.",
        level: "approval",
        scope: "mutate",
        worker_kind: "browser",
        rationale:
          "The user asked to carry a browser form submission through the approval gate before applying the action.",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /read-only browser inspection does not require approval/i,
    );
    return textResult(
      [
        "| provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
        "|---|---|---|---|---|---|---|",
        "| OpenRouter | 是 | 是 | $0.28 / 1M tokens | $0.42 / 1M tokens | http://127.0.0.1:63015/deepseek-provider-pricing | OpenRouter lists DeepSeek V4 Flash with search support. |",
        "| Together AI | 是 | 否 | $0.20 / 1M tokens | $0.35 / 1M tokens | http://127.0.0.1:63015/deepseek-provider-pricing | Together AI lists DeepSeek V4 Flash without search support. |",
        "| Fireworks | 是 | 是 | $0.18 / 1M tokens | $0.30 / 1M tokens | http://127.0.0.1:63015/deepseek-provider-pricing | Fireworks lists DeepSeek V4 Flash with web_search support. |",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Start source extraction",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, task: { type: "string" } },
          },
        },
      ];
    },
    async execute() {
      throw new Error(
        "provider pricing read-only extraction must not enter native approval flow",
      );
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Natural provider search pricing research",
        "Provider evidence source: http://127.0.0.1:63015/deepseek-provider-pricing",
        "Identify which providers are listed, whether each provider supports DeepSeek V4 Flash, whether search/web_search is supported, and input/output token pricing.",
        "This is source-backed read-only research; do not submit forms, mutate browser state, or request approval.",
      ].join("\n"),
    },
  });

  assert.equal(gatewayInputs.length, 2);
  assert.match(result.content, /OpenRouter/);
  assert.match(result.content, /是否明确支持 search\/web_search/);
  const firstToolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(!firstToolNames.includes("permission_query"));
});

test("llm role response generator hides permission tools for non-mutating slow-source follow-ups", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return textResult("Slow source release-risk note can continue without approval.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval result",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Start a source worker",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, task: { type: "string" } },
          },
        },
      ];
    },
    async execute() {
      throw new Error("no tools should be executed in this schema-filter test");
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "Separate verified facts from unverified items, describe any residual risk, and explain whether the earlier timeout still limits the conclusion.",
      ].join("\n"),
    },
  });

  const toolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(toolNames.includes("sessions_spawn"));
  assert.ok(!toolNames.includes("permission_query"));
  assert.ok(!toolNames.includes("permission_result"));
});

test("llm role response generator hides task tracking tools for timeout continuation follow-ups", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return textResult("Timeout continuation can proceed without task tracking tools.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a session",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" }, message: { type: "string" } },
          },
        },
        {
          name: "tasks_create",
          description: "Create a task",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
        {
          name: "tasks_update",
          description: "Update a task",
          inputSchema: { type: "object", properties: { work_item_id: { type: "string" } } },
        },
      ];
    },
    async execute() {
      throw new Error("schema-filter test should not execute tools");
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue from the slow-source timeout attempt in this mission.",
        "Resume the existing source-check context if possible and finish with the evidence it can collect.",
        '{"protocol":"turnkeyai.session_tool_result.v1","status":"timeout","session_key":"worker:explore:task:TASK-1:call_timeout","agent_id":"explore","result":"WORKER_TIMEOUT","resumable":true}',
      ].join("\n"),
    },
  });

  const toolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(toolNames.includes("sessions_send"));
  assert.ok(!toolNames.includes("tasks_create"));
  assert.ok(!toolNames.includes("tasks_update"));
});

test("llm role response generator hides task tracking tools for slow-source recovery prompts", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return textResult("Slow-source recovery can continue without task tracking tools.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a session",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" }, message: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Start a source worker",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, task: { type: "string" } },
          },
        },
        {
          name: "tasks_list",
          description: "List task tracking work items",
          inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        },
        {
          name: "tasks_create",
          description: "Create a task",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
        },
        {
          name: "tasks_update",
          description: "Update a task",
          inputSchema: { type: "object", properties: { work_item_id: { type: "string" } } },
        },
      ];
    },
    async execute() {
      throw new Error("schema-filter test should not execute tools");
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Original user goal (verbatim):",
        "Natural timeout follow-up continuation",
        "Evaluate this slow source for a release-risk note.",
        "Slow source: http://127.0.0.1:60153/slow-fixture",
        "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
        "A follow-up may ask you to resume that same source-check context after the initial closeout.",
        "",
        "[user]: System recovery: the previous final answer did not satisfy required goal slots.",
        "Automatic recovery attempt 1 of 2.",
        "This recovery is for a slow-source release-risk note, not a provider comparison.",
        "Resume or retry the same slow source-check context. The required release-risk slots are: verified source/status, owner, risk, mitigation, what remains unverified, residual risk, and how to continue or retry.",
        "If the released source still cannot be read within the remaining budget, close out as blocked/partial with timeout evidence instead of inventing pricing or strengths.",
        "Previous incomplete answer signals: missing release-risk owner and mitigation.",
      ].join("\n"),
    },
  });

  const toolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(toolNames.includes("sessions_list"));
  assert.ok(toolNames.includes("sessions_send"));
  assert.ok(toolNames.includes("sessions_spawn"));
  assert.ok(!toolNames.includes("tasks_list"));
  assert.ok(!toolNames.includes("tasks_create"));
  assert.ok(!toolNames.includes("tasks_update"));
});

test("llm role response generator keeps tools enabled when approval-gated browser inspection needs parent permission", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-inspect", "sessions_spawn", {
        agent_id: "browser",
        label: "Inspect local approval form",
        task: "Open the approval form, take a screenshot, and report the form fields before submission.",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "permission_query",
      });
      assert.ok(input.tools?.some((tool) => tool.name === "permission_query"));
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approval-gated browser action/,
      );
      return toolCallResult("toolu-query", "permission_query", {
        action: "browser.form.submit",
        title: "Approve local dry-run form submit",
        risk: "Submit isolated local dry-run form data.",
        level: "approval",
        scope: "mutate",
        rationale:
          "The browser worker found the form; parent runtime must request approval before submission.",
        worker_kind: "browser",
        payload: { url: "http://127.0.0.1/approval-form", form: { note: "" } },
      });
    }
    if (gatewayInputs.length === 3) {
      return {
        text: "Permission request is pending operator decision (`ap-1`). I will proceed once approved.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    throw new Error(`unexpected gateway call ${gatewayInputs.length}`);
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "pending", approval_id: "ap-1" }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:browser:task-1:toolu-inspect",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "Browser inspected the form and reported that submission requires parent approval.",
          final_content: [
            "Verified local approval form.",
            'Form field: input[name="note"] is empty.',
            "Submit button is visible.",
            "I do not have access to permission_query; the parent agent must request browser.form.submit approval.",
          ].join("\n"),
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Verified form. Parent approval is required before browser.form.submit.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /pending operator decision/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "permission_query"],
  );
  assert.equal(executedCalls[1]?.input.action, "browser.form.submit");
  assert.equal(gatewayInputs.length, 3);
  assert.deepEqual(gatewayInputs[1]?.toolChoice, {
    type: "tool",
    name: "permission_query",
  });
  assert.notEqual(gatewayInputs[1]?.toolChoice, "none");
  assert.equal(result.metadata?.toolLoopCloseout, undefined);
});

test("llm role response generator continues timed-out approved browser action before final", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-submit", "sessions_spawn", {
        agent_id: "browser",
        label: "approved dry-run submit",
        task: [
          "Navigate to http://127.0.0.1:4101/approval-form.",
          "Perform the already-approved dry-run browser.form.submit action.",
          "Verify the post-submit page state.",
        ].join("\n"),
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_send",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approved browser action timed out before verification/,
      );
      return toolCallResult("toolu-continue", "sessions_send", {
        session_key: "worker:browser:approved-submit:toolu-submit",
        message:
          "Continue the approved browser.form.submit action and verify the post-submit page state.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return textResult(
      "Approved browser.form.submit completed. Post-submit evidence: TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally.",
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              task: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_send") {
        assert.equal(
          input.call.input.session_key,
          "worker:browser:approved-submit:toolu-submit",
        );
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-approved-submit",
            session_key: "worker:browser:approved-submit:toolu-submit",
            agent_id: "browser",
            status: "completed",
            tool_chain: ["browser_snapshot", "browser_act", "browser_snapshot"],
            result: "Approved dry-run submit completed.",
            final_content:
              "Approved browser.form.submit completed. TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally.",
            payload: {
              mode: "llm_sub_agent",
              workerType: "browser",
              content:
                "Approved browser.form.submit completed. TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally.",
            },
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        isError: true,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approved-submit",
          session_key: "worker:browser:approved-submit:toolu-submit",
          agent_id: "browser",
          status: "timeout",
          timeout_seconds: 45,
          evidence_available: true,
          evidence_summary:
            "Execution paused before completion. Reason: sessions_spawn timed out after 45s.",
          result:
            "Sub-agent session timed out after 45s before post-submit verification.",
          final_content: null,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Operator decision recorded for approval ap-1.",
        "Action: browser.form.submit.",
        "The operator approved it, and the runtime has already recorded permission.result and permission.applied; the runtime permission cache is already applied.",
        "Do not call permission tools again. Continue from the approved point: perform only the approved scoped action now and verify the result before the final answer.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Approved browser\.form\.submit completed/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_send"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator checks permission_result before approval wait-timeout closeout", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser-too-early", "sessions_spawn", {
        agent_id: "browser",
        label: "Dry-run approval form submission",
        task: [
          "Open http://127.0.0.1:56633/approval-form in the browser.",
          "Inspect the rendered form and capture a screenshot.",
          "Attempt to submit the form as the dry-run action under operator review.",
        ].join("\n"),
      });
    }
    if (gatewayInputs.length === 2) {
      return {
        text:
          "Verified: Source 1 browser_open observed TURNKEYAI_APPROVAL_FIXTURE_OK and the Submit dry-run control. No final submission evidence is available yet.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 3) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "permission_result",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approval decision has not arrived/,
      );
      return toolCallResult("toolu-result", "permission_result", {
        approval_id: "ap-1",
      });
    }
    if (gatewayInputs.length === 4) {
      return {
        text: [
          "Flow closeout: approval wait-timeout reached.",
          "No browser form submission or side effect ran.",
          "The thread remains open pending operator decision.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /approval wait-timeout evidence is available/,
    );
    return {
      text: [
        "Wait-timeout closeout: the operator decision for browser.form.submit is still pending.",
        "No browser form submission or side effect ran.",
        "Residual risk: the unexecuted result is not verified while approval remains pending.",
        "Safe fallback: keep the dry-run unsubmitted. Next action: ask the operator to approve a new request or rerun when ready.",
      ].join("\n"),
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_spawn") {
        assert.equal(input.call.input.agent_id, "browser");
        assert.match(String(input.call.input.task), /Pre-approval browser inspection only/);
        assert.doesNotMatch(String(input.call.input.task), /Attempt to submit/i);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            agent_id: "browser",
            result:
              "Rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. No form submission ran.",
            evidence_summary:
              "Final URL: http://127.0.0.1:56633/approval-form\nPage title: Approval Gate Fixture\nVisible marker: TURNKEYAI_APPROVAL_FIXTURE_OK\nSubmission control: Submit dry-run.",
          }),
        };
      }
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            event_type: "permission.query",
            status: "pending",
            approvalId: "ap-1",
            action: "browser.form.submit",
          }),
          progress: [
            {
              phase: "progress",
              toolName: input.call.name,
              summary: "Permission requested.",
              detail: {
                eventType: "permission.query",
                status: "pending",
                approval_id: "ap-1",
              },
            },
          ],
        };
      }
      if (input.call.name === "permission_result") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            event_type: "permission.result",
            status: "pending",
            approvalId: input.call.input.approval_id,
            action: "browser.form.submit",
            message: "Permission request is still pending.",
          }),
          progress: [
            {
              phase: "progress",
              toolName: input.call.name,
              summary: "Permission request is still pending.",
              detail: {
                eventType: "permission.result",
                status: "pending",
                approval_id: input.call.input.approval_id,
              },
            },
          ],
          isError: true,
        };
      }
      throw new Error(`unexpected tool ${input.call.name}`);
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and start a safe dry-run browser form submission attempt for operator review.",
        "If the operator decision does not arrive during this attempt, stop without submitting the form and close out with what remains pending, what did not run, and the safest next action.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Wait-timeout closeout/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "permission_query", "permission_result"],
  );
  assert.deepEqual(gatewayInputs[2]?.toolChoice, {
    type: "tool",
    name: "permission_result",
  });
  assert.equal(gatewayInputs.length, 5);
});

test("llm role response generator repairs stale pending answers after approval is applied", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-query", "permission_query", {
        action: "browser.form.submit",
        worker_kind: "browser",
        scope: "local dry-run form",
        risk: "low",
      });
    }
    if (gatewayInputs.length === 2) {
      return {
        text: "Apply the approved permission.",
        toolCalls: [
          {
            id: "toolu-result",
            name: "permission_result",
            input: { approval_id: "ap-1" },
          },
          {
            id: "toolu-applied",
            name: "permission_applied",
            input: { approval_id: "ap-1" },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 3) {
      return {
        text: "Permission request is pending operator decision (`ap-1`). I will proceed once approved.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 4) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approval already applied/,
      );
      return toolCallResult("toolu-browser-approved", "sessions_spawn", {
        agent_id: "browser",
        task: "Submit the approved local dry-run form and verify the submitted status.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "The approved browser dry-run was submitted and verified.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "pending", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_result") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_applied") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "applied", approval_id: "ap-1" }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:browser:task-1:toolu-browser-approved",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved dry-run submit completed.",
          final_content:
            "Approved dry-run submit completed. Browser verified the submitted status.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Approved dry-run submit completed. Browser verified the submitted status.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved browser dry-run was submitted and verified.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [
      "permission_query",
      "permission_result",
      "permission_applied",
      "sessions_spawn",
    ],
  );
  assert.equal(gatewayInputs.length, 5);
});

test("llm role response generator repairs incomplete approved browser action when approval is daemon-applied", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "The approved browser action was not completed because browser tools were unavailable.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approved browser action has not executed/i,
      );
      return toolCallResult("toolu-browser-approved", "sessions_spawn", {
        agent_id: "browser",
        task: "Submit the approved local dry-run form and verify completion.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "The approved browser action completed with verified local dry-run evidence.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approved",
          session_key: "worker:browser:task-approved:toolu-browser-approved",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved local dry-run form submission completed.",
          final_content:
            "Approved action: browser.form.submit. Evidence observed: local dry-run fixture reported submitted.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and carry the safe local dry-run through the approval gate.",
        "Runtime permission cache: permission.applied already applied for approval ap-1.",
        "This is an approval-gated browser form submission.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved browser action completed with verified local dry-run evidence.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs stale pending answers after daemon-applied approval continuation", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "**Pending operator approval.** Awaiting decision before executing the dry-run browser form submission.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approval already applied/,
      );
      return toolCallResult("toolu-browser-approved", "sessions_spawn", {
        agent_id: "browser",
        task: "Submit the approved local dry-run form and verify the submitted status.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "The approved browser dry-run was submitted and verified.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:browser:task-1:toolu-browser-approved",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved dry-run submit completed.",
          final_content:
            "Approved dry-run submit completed. Browser verified the submitted status.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Approved dry-run submit completed. Browser verified the submitted status.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Operator decision recorded for approval ap-1.",
        "Action: browser.form.submit.",
        "The operator approved it and the runtime permission cache is already applied.",
        "Continue from the approved point: perform only the approved scoped action now, do not ask for approval again, and verify the result before the final answer.",
      ].join("\n"),
    },
  });

  assert.match(
    result.content,
    /approved browser dry-run was submitted and verified/i,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs pending answer from applied approval continuation text", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return textResult(
        "Permission request `ap-1` is pending operator decision. Once the operator approves, I will spawn the browser sub-agent.",
      );
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approval already applied/i,
      );
      return toolCallResult("toolu-browser-approved", "sessions_spawn", {
        agent_id: "browser",
        task: "Execute the approved browser.form.submit dry-run on the local approval form and verify the resulting page state.",
      });
    }
    return textResult(
      "Approved browser.form.submit completed. Browser evidence verified the local dry-run submitted state. Residual risk: only the local fixture was verified.",
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approval",
          session_key: "worker:browser:task-approval:toolu-browser-approved",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved browser.form.submit completed.",
          final_content:
            "Approved browser.form.submit completed. Browser verified submitted state.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Operator decision recorded for approval ap-1.",
        "Action: browser.form.submit.",
        "The operator approved it, and the runtime has already recorded permission.result and permission.applied; the runtime permission cache is already applied.",
        "Do not call permission tools again.",
        'Continue from the approved point: call sessions_spawn with agent_id="browser" and a self-contained task to perform only the approved scoped action now.',
        "Verify the browser result before the final answer, and do not finalize with a pending-approval summary.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Approved browser\.form\.submit completed/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs stale pending answers after progress-applied approval", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-query", "permission_query", {
        action: "browser.form.submit",
        worker_kind: "browser",
        scope: "local dry-run form",
        risk: "low",
      });
    }
    if (gatewayInputs.length === 2) {
      return {
        text: "Approval is pending. Once the operator responds with permission_result, I will submit the dry-run form.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 3) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approval already applied/,
      );
      return toolCallResult("toolu-browser-approved", "sessions_spawn", {
        agent_id: "browser",
        task: "Submit the approved local dry-run form and verify the submitted status.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "The approved browser dry-run was submitted and verified.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "pending", approval_id: "ap-1" }),
          progress: [
            {
              phase: "progress",
              toolName: input.call.name,
              summary: "Approval required before browser.form.submit.",
              detail: { eventType: "permission.query", status: "pending", approvalId: "ap-1" },
            },
            {
              phase: "progress",
              toolName: input.call.name,
              summary: "Operator approved browser.form.submit.",
              detail: { eventType: "permission.result", status: "approved", approvalId: "ap-1" },
            },
            {
              phase: "progress",
              toolName: input.call.name,
              summary: "Permission request was applied.",
              detail: { eventType: "permission.applied", status: "applied", approvalId: "ap-1" },
            },
          ],
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:browser:task-1:toolu-browser-approved",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved dry-run submit completed.",
          final_content:
            "Approved dry-run submit completed. Browser verified the submitted status.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved browser dry-run was submitted and verified.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["permission_query", "sessions_spawn"],
  );
  assert.equal(gatewayInputs.length, 4);
});

test("llm role response generator repairs approval-applied delegation-only browser finals", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Permission applied. Now delegating the approved dry-run browser form submission to the browser worker. @role-browser",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approved browser action has not executed/i,
      );
      return toolCallResult("toolu-browser-approved", "sessions_spawn", {
        agent_id: "browser",
        task: "Submit the approved local dry-run form and verify the submitted status.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "The approved browser dry-run was submitted and verified.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:browser:task-1:toolu-browser-approved",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved dry-run submit completed.",
          final_content:
            "Approved dry-run submit completed. Browser verified the submitted status.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and carry the safe local dry-run through the approval gate.",
        "Runtime permission cache: permission.applied already applied for approval ap-1.",
        "This is an approval-gated browser form submission.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved browser dry-run was submitted and verified.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs approved browser actions that claim tools are unavailable", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will request and apply approval.",
        toolCalls: [
          {
            id: "toolu-query",
            name: "permission_query",
            input: { action: "browser.form.submit" },
          },
          {
            id: "toolu-result",
            name: "permission_result",
            input: { approval_id: "ap-1" },
          },
          {
            id: "toolu-applied",
            name: "permission_applied",
            input: { approval_id: "ap-1" },
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
      return {
        text: "The permission_query tool is not available in my current function namespace, so I can inspect the form but cannot emit the approval request or complete the dry-run submission.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 3) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /approved browser action has not executed/,
      );
      return toolCallResult("toolu-browser-approved", "sessions_spawn", {
        agent_id: "browser",
        task: "Submit the approved local dry-run form and verify the submitted status.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "The approved browser dry-run was submitted and verified.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_result") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_applied") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "applied", approval_id: "ap-1" }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approval",
          session_key: "worker:browser:task-approval:toolu-browser-approved",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Approved dry-run submit completed.",
          final_content:
            "Approved dry-run submit completed. Browser verified the submitted status.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved browser dry-run was submitted and verified.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [
      "permission_query",
      "permission_result",
      "permission_applied",
      "sessions_spawn",
    ],
  );
  assert.equal(gatewayInputs.length, 4);
});

test("llm role response generator continues the same browser session when an approved action is incomplete", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const browserSessionKey =
    "worker:browser:task-approval:toolu-browser-approved";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will request approval and run the browser session.",
        toolCalls: [
          {
            id: "toolu-query",
            name: "permission_query",
            input: { action: "browser.form.submit" },
          },
          {
            id: "toolu-result",
            name: "permission_result",
            input: { approval_id: "ap-1" },
          },
          {
            id: "toolu-applied",
            name: "permission_applied",
            input: { approval_id: "ap-1" },
          },
          {
            id: "toolu-browser-approved",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Submit the approved local dry-run form and verify the submitted status.",
            },
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
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_send",
      });
      const repairPrompt = readToolContent(
        input.messages.at(-1)?.content ?? "",
      );
      assert.match(
        repairPrompt,
        /approved browser action is incomplete inside an existing browser session/,
      );
      assert.match(
        repairPrompt,
        new RegExp(browserSessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.match(repairPrompt, /submit=true/);
      return {
        text: "I will continue the existing browser session.",
        toolCalls: [
          {
            id: "toolu-browser-continue",
            name: "sessions_send",
            input: {
              session_key: browserSessionKey,
              message:
                "Perform the approved browser.form.submit action now and verify the post-submit state.",
            },
          },
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
      text: "The approved browser dry-run was submitted and verified.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_result") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_applied") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "applied", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "sessions_send") {
        assert.equal(input.call.input.session_key, browserSessionKey);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-approval",
            session_key: browserSessionKey,
            agent_id: "browser",
            status: "completed",
            tool_chain: ["browser"],
            result: "Approved dry-run submit completed.",
            final_content:
              "Approved dry-run submit completed. Browser verified the submitted status.",
            payload: {
              mode: "llm_sub_agent",
              workerType: "browser",
              content: "Approved dry-run submit completed.",
            },
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approval",
          session_key: browserSessionKey,
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "Form inspection completed. Field ref-1 filled. Button ref-2 present, ready.",
          final_content:
            "Form inspection completed. Field ref-1 filled. Button ref-2 present, ready. Next step needed: dry-run form submission can now be completed by re-delegating to the same browser session.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Form inspection completed. Field ref-1 filled. Button ref-2 present, ready. Next step needed: dry-run form submission can now be completed by re-delegating to the same browser session.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved browser dry-run was submitted and verified.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [
      "permission_query",
      "permission_result",
      "permission_applied",
      "sessions_spawn",
      "sessions_send",
    ],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs stale pending answers after approval is denied", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will request approval.",
        toolCalls: [
          {
            id: "toolu-query",
            name: "permission_query",
            input: { action: "browser.form.submit" },
          },
          {
            id: "toolu-result",
            name: "permission_result",
            input: { approval_id: "ap-1" },
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
      return {
        text: "The permission request is pending operator review. Awaiting your decision before proceeding.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /approval was denied/,
    );
    return {
      text: "Approval denied - task closed safely. No form submission was or will be performed. The safe fallback is to keep the local dry-run unsubmitted.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            event_type: "permission.query",
            status: "pending",
            approval_id: "ap-1",
          }),
          progress: [
            {
              phase: "progress",
              toolName: input.call.name,
              summary: "Approval required.",
              detail: { eventType: "permission.query", status: "pending" },
            },
          ],
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        isError: true,
        content: JSON.stringify({
          event_type: "permission.result",
          status: "denied",
          approval_id: "ap-1",
        }),
        progress: [
          {
            phase: "progress",
            toolName: input.call.name,
            summary: "Approval denied.",
            detail: { eventType: "permission.result", status: "denied" },
          },
        ],
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Request approval before applying the browser action.",
        "If the operator denies the request, do not apply the browser action; close out with the safe fallback.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Approval denied/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["permission_query", "permission_result"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator suppresses tools for setup-only awaiting-context turns", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executeCalled = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-memory", "memory_search", {
        query: "Helios-47 launch planning mission context",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /setup-only/,
    );
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /no research or action is needed/i,
    );
    return {
      text: "Helios-47 launch-planning thread is ready. No research is queued; the mission can continue when launch context is provided.",
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
          name: "memory_search",
          description: "Search durable memory",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ];
    },
    async execute() {
      executeCalled = true;
      throw new Error("setup-only turn must not execute tools");
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Start a launch-planning thread for Helios-47.",
        "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
      ].join("\n"),
    },
  });

  assert.equal(executeCalled, false);
  assert.equal(gatewayInputs.length, 2);
  assert.match(result.content, /No research is queued/);
});

test("llm role response generator does not suppress memory tools for follow-up recall turns", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: string[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-memory", "memory_search", {
        query: "Helios-47 launch window owner residual risk",
      });
    }
    return {
      text: "Durable memory recalled: Helios-47 launches Tuesday 09:30 with Release Captain ownership and residual risk around launch readiness.",
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
          name: "memory_search",
          description: "Search durable memory",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call.name);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          memories: [{ memory_id: "mem-1", title: "Helios-47" }],
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Start a launch-planning thread for Helios-47.",
        "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
        "",
        "Continue from the launch-planning context in this mission.",
        "The team previously captured durable launch coordination notes for the Helios-47 codename.",
        "Please check durable memory for Helios-47 specifically, recover the launch window, owner, and residual risk if they are available, and inspect any candidate memory entry before relying on it.",
      ].join("\n"),
    },
  });

  assert.deepEqual(executedCalls, ["memory_search"]);
  assert.equal(gatewayInputs[0]?.toolChoice, "auto");
  assert.match(result.content, /Tuesday 09:30/);
});

test("llm role response generator only exposes memory tools for focused durable memory recall turns", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length > 1) {
      return {
        text: "Aurora-19 memory recall is ready for final synthesis.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "I need durable memory.",
      toolCalls: [
        {
          id: "toolu-memory",
          name: "memory_search",
          input: { query: "Aurora-19 launch window owner hard constraint risk" },
        },
      ],
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
          name: "memory_search",
          description: "Search durable memory",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        {
          name: "memory_get",
          description: "Read durable memory",
          inputSchema: {
            type: "object",
            properties: { memory_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, task: { type: "string" } },
          },
        },
        {
          name: "sessions_history",
          description: "Read sub-agent history",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
        },
        {
          name: "sessions_list",
          description: "List sub-agent sessions",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" } },
          },
        },
        {
          name: "tasks_create",
          description: "Create a work item",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
        {
          name: "tasks_update",
          description: "Update a work item",
          inputSchema: {
            type: "object",
            properties: { work_item_id: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          memories: [{ memory_id: "mem-aurora", title: "Aurora-19" }],
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 1 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue from the long Aurora-19 launch handoff in this mission.",
        "Please use the workbench's durable memory lookup for Aurora-19 rather than relying on the visible thread summary, then recover the launch window, owner, hard constraint, and residual risk if they are available.",
        "Inspect any candidate memory entry before relying on it.",
        "Historical worker evidence: a browser session captured an older unrelated page and should not affect this memory-only follow-up.",
      ].join("\n"),
    },
  });

  const exposedToolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(exposedToolNames, ["memory_search", "memory_get"]);
});

test("llm role response generator recognizes focused durable memory recall from recent user context", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: "Memory recall ready.",
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
          name: "memory_search",
          description: "Search durable memory",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        {
          name: "memory_get",
          description: "Read durable memory",
          inputSchema: {
            type: "object",
            properties: { memory_id: { type: "string" } },
          },
        },
        {
          name: "sessions_list",
          description: "List sub-agent sessions",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" } },
          },
        },
        {
          name: "tasks_create",
          description: "Create a work item",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "{}",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 1 },
  });
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief: "Handle the current follow-up.",
    instructions:
      "Generic runtime guidance may mention browser sessions, task tracking, and delegated workers, but it is not the user's current request.",
    recentMessages: [
      {
        messageId: "msg-memory",
        role: "user",
        name: "User",
        content: [
          "Continue from the launch-planning context in this mission.",
          "Please check durable memory for Helios-47 specifically, recover the launch window, owner, and residual risk if they are available.",
          "Inspect any candidate memory entry before relying on it.",
        ].join("\n"),
        createdAt: 1,
      } satisfies TeamMessageSummary,
    ],
  };

  await generator.generate({
    activation,
    packet: {
      ...buildPacket(),
      taskPrompt: "Handle the current follow-up.",
    },
  });

  const exposedToolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(exposedToolNames, ["memory_search", "memory_get"]);
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
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        {
          name: "memory_get",
          description: "Read memory",
          inputSchema: {
            type: "object",
            properties: { memory_id: { type: "string" } },
          },
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
  assert.equal(
    storedMessages.has("task-1:tool-round:1:result:toolu-live"),
    false,
  );

  resolveTool();
  const result = await resultPromise;

  assert.equal(result.content, "Done.");
  const completedAssistant = storedMessages.get(
    "task-1:tool-round:1:assistant",
  );
  const toolMessage = storedMessages.get(
    "task-1:tool-round:1:result:toolu-live",
  );
  assert.equal(completedAssistant?.toolStatus, "completed");
  assert.equal(
    completedAssistant?.toolProgress?.some(
      (event) => event.summary === "Browser snapshot captured",
    ),
    true,
  );
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          result: "Page inspected",
        }),
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
  const progressEvents: Array<{
    summary: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const largeA = "A".repeat(20_000);
  const largeB = "B".repeat(20_000);
  const largeC = "C".repeat(20_000);
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-a", "sessions_spawn", {
        agent_id: "browser",
        task: "First large result",
      });
    }
    if (gatewayInputs.length === 2) {
      return toolCallResult("toolu-b", "sessions_spawn", {
        agent_id: "browser",
        task: "Second large result",
      });
    }
    if (gatewayInputs.length === 3) {
      return toolCallResult("toolu-c", "sessions_spawn", {
        agent_id: "browser",
        task: "Third large result",
      });
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      const content =
        input.call.id === "toolu-a"
          ? largeA
          : input.call.id === "toolu-b"
            ? largeB
            : largeC;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content,
      };
    },
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
  assert.match(
    fourthToolContents?.[0] ?? "",
    /"reason": "older_than_recent_window"/,
  );
  assert.doesNotMatch(fourthToolContents?.[0] ?? "", /^A{20000}$/);
  assert.match(
    fourthToolContents?.[1] ?? "",
    /"reason": "aggregate_tool_result_budget_recent_window"/,
  );
  assert.equal(fourthToolContents?.[2], largeC);
  assert.equal(gatewayInputs[3]?.envelope?.toolResultCount, 3);
  assert.ok((gatewayInputs[3]?.envelope?.toolResultBytes ?? 0) <= 32 * 1024);
  const pruningEvent = [...progressEvents]
    .reverse()
    .find(
      (event) => event.metadata?.["boundaryKind"] === "tool_result_pruning",
    );
  assert.ok(pruningEvent, "expected a tool-result pruning boundary event");
  assert.match(pruningEvent.summary, /Tool result history pruned/i);
  assert.equal(pruningEvent.metadata?.["prunedToolResults"], 2);
  assert.deepEqual(pruningEvent.metadata?.["pruningReasons"], [
    "older_than_recent_window",
    "aggregate_tool_result_budget_recent_window",
  ]);
  assert.equal(pruningEvent.metadata?.["toolResultCountBefore"], 3);
  assert.equal(pruningEvent.metadata?.["toolResultCountAfter"], 3);
  assert.ok(
    (pruningEvent.metadata?.["toolResultBytesAfter"] as number) <= 32 * 1024,
  );
});

test("llm role response generator does not finalize multi-stream delegation after one session", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-one", "sessions_spawn", {
        agent_id: "browser",
        task: "Collect all three streams in one broad pass.",
        label: "broad product brief",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /multiple independent evidence streams/,
      );
      return {
        text: "Calling remaining focused tools.",
        toolCalls: [
          {
            id: "toolu-two",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              task: "Check orchestration source only.",
              label: "orchestration",
            },
          },
          {
            id: "toolu-three",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Check live dashboard source only.",
              label: "signals",
            },
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
      text: "Final answer from three independent streams.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: `${input.call.input.label} evidence complete.`,
          final_content: `${input.call.input.label} verified evidence. Residual risk: local fixture only.`,
          payload: {
            mode: "llm_sub_agent",
            content: `${input.call.input.label} verified evidence. Residual risk: local fixture only.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief about the next release.",
        "These are three independent evidence streams.",
        "Research source: http://127.0.0.1/orchestration",
        "Capability source: http://127.0.0.1/bridge",
        "Live signal dashboard: http://127.0.0.1/signals",
        "Use browser-visible evidence for the live signal dashboard.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer from three independent streams.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-one", "toolu-two", "toolu-three"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator does not collapse AsiaWalk separate streams into one session", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-one", "sessions_spawn", {
        agent_id: "browser",
        task: "Collect route, budget, and live readiness in one broad browser pass.",
        label: "AsiaWalk all streams",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /multiple independent evidence streams/,
      );
      return {
        text: "Splitting the remaining AsiaWalk streams.",
        toolCalls: [
          {
            id: "toolu-budget",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              task: "Check the AsiaWalk budget source only.",
              label: "AsiaWalk budget",
            },
          },
          {
            id: "toolu-live",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Inspect the AsiaWalk live readiness dashboard as rendered browser evidence only.",
              label: "AsiaWalk live readiness",
            },
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
      text: "AsiaWalk final from three separate streams.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: `${input.call.input.label} evidence complete.`,
          final_content: `${input.call.input.label} verified evidence. Residual risk: local fixture only.`,
          payload: {
            mode: "llm_sub_agent",
            content: `${input.call.input.label} verified evidence. Residual risk: local fixture only.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Route source: http://127.0.0.1:4100/asiawalk-route",
        "Budget source: http://127.0.0.1:4100/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1:4100/asiawalk-live",
        "Treat route, budget, and live readiness as separate evidence streams.",
        "Do not finalize until all three streams have returned.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "AsiaWalk final from three separate streams.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-one", "toolu-budget", "toolu-live"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator does not finalize two-source comparison after one session", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-alpha", "sessions_spawn", {
        agent_id: "explore",
        task: "Check both vendor pages in one broad pass.",
        label: "Vendor Alpha + Beta",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /multiple independent evidence streams/,
      );
      return toolCallResult("toolu-beta", "sessions_spawn", {
        agent_id: "explore",
        task: "Check Vendor Beta only and return pricing, strength, risk, and quote.",
        label: "Vendor Beta",
      });
    }
    return {
      text: "Final answer from Alpha and Beta source evidence.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const label = String(input.call.input.label ?? "source");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: `${label} evidence complete.`,
          final_content: `${label} verified source evidence. Residual risk: local fixture only.`,
          payload: {
            mode: "llm_sub_agent",
            content: `${label} verified source evidence. Residual risk: local fixture only.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "A product lead is deciding between Vendor Alpha and Vendor Beta.",
        "Review these two source pages: http://127.0.0.1/vendor-alpha and http://127.0.0.1/vendor-beta.",
        "Return a concise recommendation that compares pricing, strengths, risks, and the tradeoff.",
        "Use only evidence collected during this mission.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer from Alpha and Beta source evidence.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-alpha", "toolu-beta"],
  );
  assert.equal(gatewayInputs.length >= 3, true);
});

test("llm role response generator keeps correcting multi-stream delegation until enough unique streams complete", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-one", "sessions_spawn", {
        agent_id: "explore",
        task: "Check source one.",
        label: "source-one",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /multiple independent evidence streams/,
      );
      return toolCallResult("toolu-two", "sessions_spawn", {
        agent_id: "explore",
        task: "Check source two.",
        label: "source-two",
      });
    }
    if (gatewayInputs.length === 3) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /multiple independent evidence streams/,
      );
      return toolCallResult("toolu-three", "sessions_spawn", {
        agent_id: "browser",
        task: "Check source three.",
        label: "source-three",
      });
    }
    return {
      text: "Final answer after three unique streams.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: `${input.call.input.label} evidence complete.`,
          final_content: `${input.call.input.label} verified evidence.`,
          payload: {
            mode: "llm_sub_agent",
            content: `${input.call.input.label} verified evidence.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief about the next release.",
        "These are three independent evidence streams.",
        "Research source: http://127.0.0.1/source-one",
        "Capability source: http://127.0.0.1/source-two",
        "Live signal dashboard: http://127.0.0.1/source-three",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer after three unique streams.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-one", "toolu-two", "toolu-three"],
  );
  assert.equal(
    gatewayInputs.filter((input) =>
      readToolContent(input.messages.at(-1)?.content ?? "").includes(
        "multiple independent evidence streams",
      ),
    ).length,
    2,
  );
  assert.equal(gatewayInputs.length, 4);
});

test("llm role response generator does not count a continued session as a new independent stream", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-one", "sessions_spawn", {
        agent_id: "explore",
        task: "Check source one.",
        label: "source-one",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /multiple independent evidence streams/,
      );
      return {
        text: "Continuing one session and starting another.",
        toolCalls: [
          {
            id: "toolu-one-continue",
            name: "sessions_send",
            input: {
              session_key: "worker:explore:task-toolu-one",
              message: "Add one more detail for source one.",
            },
          },
          {
            id: "toolu-two",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              task: "Check source two.",
              label: "source-two",
            },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 3) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      assert.match(
        readToolContent(input.messages.at(-1)?.content ?? ""),
        /multiple independent evidence streams/,
      );
      return toolCallResult("toolu-three", "sessions_spawn", {
        agent_id: "browser",
        task: "Check source three.",
        label: "source-three",
      });
    }
    return {
      text: "Final answer after deduped session evidence.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const sessionKey =
        input.call.name === "sessions_send"
          ? String(input.call.input.session_key)
          : `worker:${input.call.input.agent_id}:task-${input.call.id}`;
      const label =
        input.call.name === "sessions_send"
          ? "source-one continued"
          : input.call.input.label;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: sessionKey,
          agent_id: input.call.input.agent_id ?? "explore",
          status: "completed",
          result: `${label} evidence complete.`,
          final_content: `${label} verified evidence.`,
          payload: {
            mode: "llm_sub_agent",
            content: `${label} verified evidence.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief about the next release.",
        "These are three independent evidence streams.",
        "Research source: http://127.0.0.1/source-one",
        "Capability source: http://127.0.0.1/source-two",
        "Live signal dashboard: http://127.0.0.1/source-three",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer after deduped session evidence.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-one", "toolu-one-continue", "toolu-two", "toolu-three"],
  );
  assert.equal(gatewayInputs.length, 4);
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
      return toolCallResult("toolu-a", "sessions_spawn", {
        agent_id: "explore",
        task: "A",
      });
    }
    if (gatewayInputs.length === 2) {
      return toolCallResult("toolu-b", "sessions_spawn", {
        agent_id: "explore",
        task: "B",
      });
    }
    if (gatewayInputs.length === 3) {
      return toolCallResult("toolu-c", "sessions_spawn", {
        agent_id: "explore",
        task: "C",
      });
    }
    if (gatewayInputs.length === 4) {
      return toolCallResult("toolu-d", "sessions_spawn", {
        agent_id: "explore",
        task: "D",
      });
    }
    if (gatewayInputs.length === 5) {
      return toolCallResult("toolu-e", "sessions_spawn", {
        agent_id: "explore",
        task: "E",
      });
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
  assert.match(
    finalToolContents?.[0] ?? "",
    /"reason": "aggregate_tool_result_budget"/,
  );
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
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
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
  assert.match(
    finalToolContents?.[0] ?? "",
    /"reason": "single_tool_result_exceeds_aggregate_budget"/,
  );
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          source: input.call.input.task,
        }),
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
  assert.match(
    readToolContent(gatewayInputs[8]!.messages[2]!.content),
    /Earlier tool history compacted/,
  );
  assert.equal(gatewayInputs[8]!.messages.at(-1)?.role, "user");
  assert.match(
    readToolContent(gatewayInputs[8]!.messages.at(-1)!.content),
    /final allowed tool-use round \(9\)/,
  );
  assert.equal(gatewayInputs[8]!.messages.at(-2)?.role, "tool");
  assert.equal(gatewayInputs[8]!.messages.at(-2)?.toolCallId, "toolu-8");
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedTools += 1;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          result: input.call.input.task,
        }),
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
  assert.doesNotMatch(
    readToolContent(gatewayInputs[0]!.messages.at(-1)!.content),
    /final allowed tool-use round/,
  );
  assert.match(
    readToolContent(gatewayInputs[1]!.messages.at(-1)!.content),
    /final allowed tool-use round \(2\)/,
  );
  assert.equal(gatewayInputs[3]?.toolChoice, "none");
  assert.equal(gatewayInputs[3]?.tools, undefined);
  assert.ok(
    gatewayInputs[3]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes(
          "Tool-use round limit reached (2)",
        ),
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[3])?.includes(
      "Do not collapse requested bullets into a paragraph",
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[3])?.includes(
      "Evidence synthesis contract",
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[3])?.includes(
      "unverified scope or residual risk",
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "round_limit");
  assert.equal(closeout?.maxRounds, 2);
  assert.equal(closeout?.toolCallCount, 2);
  assert.equal(closeout?.roundCount, 2);
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedTools += 1;
      now = 200;
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          result: input.call.input.task,
        }),
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
        readToolContent(message.content).includes(
          "Tool-use wall-clock budget reached",
        ),
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[2])?.includes(
      "Final synthesis format contract",
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "wall_clock_budget");
  assert.equal(closeout?.maxWallClockMs, 100);
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
  const missionReport = result.metadata?.missionReport as
    | Record<string, unknown>
    | undefined;
  assert.equal(missionReport?.status, "partial");
  assert.equal(missionReport?.reason, "wall_clock_budget");
  assert.equal(missionReport?.source, "runtime_derived");
  // runtime-derived reports must NOT assert task authorization; authorizedPartial
  // is set only by an explicit model report / the evaluator's task-text check.
  assert.equal(missionReport?.authorizedPartial, undefined);
});

test("llm role response generator repairs final synthesis that omits an explicitly requested conclusion", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Dispatching independent researchers.",
        toolCalls: [
          {
            id: "toolu-a",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              task: "研究员 A 只检查 https://example.com/",
            },
          },
          {
            id: "toolu-b",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              task: "研究员 B 只检查 https://www.iana.org/help/example-domains",
            },
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
      assert.equal(input.toolChoice, "none");
      assert.equal(input.tools, undefined);
      assert.equal(input.envelope?.toolCount, 0);
      assert.equal(input.envelope?.toolSchemaBytes, 0);
      const prompt = finalSynthesisPrompt(input) ?? "";
      assert.match(prompt, /Required final deliverables/);
      assert.match(prompt, /final one-sentence conclusion/);
      return textResult([
        "| 研究员 | 检查的 URL | 页面标题 | 关键原文摘录 | 关系 |",
        "| --- | --- | --- | --- | --- |",
        "| A | https://example.com/ | Example Domain | This domain is for use in illustrative examples in documents. | example.com 是示例域名页面。 |",
        "| B | https://www.iana.org/help/example-domains | Example Domains | domains for documentation purposes | IANA 页面解释示例域名用途。 |",
      ].join("\n"));
    }
    const repairPrompt = readToolContent(
      input.messages[input.messages.length - 1]?.content ?? "",
    );
    assert.match(
      repairPrompt,
      /Runtime correction: final answer omitted required deliverables/,
    );
    assert.match(repairPrompt, /final one-sentence conclusion/);
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    assert.equal(input.envelope?.toolCount, 0);
    assert.equal(input.envelope?.toolSchemaBytes, 0);
    return textResult([
      "| 研究员 | 检查的 URL | 页面标题 | 关键原文摘录 | 关系 |",
      "| --- | --- | --- | --- | --- |",
      "| A | https://example.com/ | Example Domain | This domain is for use in illustrative examples in documents. | example.com 是示例域名页面。 |",
      "| B | https://www.iana.org/help/example-domains | Example Domains | domains for documentation purposes | IANA 页面解释示例域名用途。 |",
      "",
      "结论：IANA 页面是权威说明，example.com 是该说明落地的示例域名页面。",
    ].join("\n"));
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      const isResearcherA = /研究员 A/.test(String(input.call.input.task));
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: isResearcherA ? "task-research-a" : "task-research-b",
          status: "completed",
          agent_id: "explore",
          label: isResearcherA ? "研究员A" : "研究员B",
          session_key: isResearcherA ? "worker:explore:a" : "worker:explore:b",
          tool_chain: ["explore"],
          result: isResearcherA
            ? "研究员A completed example.com evidence."
            : "研究员B completed IANA evidence.",
          payload: { mode: "llm_sub_agent" },
          final_content: isResearcherA
            ? "研究员A: URL https://example.com/; title Example Domain; quote: This domain is for use in illustrative examples in documents."
            : "研究员B: URL https://www.iana.org/help/example-domains; title Example Domains; quote: domains for documentation purposes.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 8 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt:
        "请把这个任务交给两个独立研究员并分别取证。最后合并成一个两行表格，列出：研究员、检查的 URL、页面标题、关键原文摘录、这页和另一个页面的关系。最后再给一句话结论。",
    },
  });

  assert.match(result.content, /^结论：|[\s\S]\n结论：/);
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator accepts markdown-bold requested conclusion labels", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-a", "sessions_spawn", {
        agent_id: "explore",
        task: "研究员 A 只检查 https://example.com/",
      });
    }
    return textResult([
      "| 研究员 | 检查的 URL | 页面标题 | 关键原文摘录 | 关系 |",
      "| --- | --- | --- | --- | --- |",
      "| A | https://example.com/ | Example Domain | This domain is for use in illustrative examples in documents. | IANA 示例域名体系的具体页面。 |",
      "| B | https://www.iana.org/help/example-domains | Example Domains | domains for documentation purposes | IANA 页面解释示例域名用途。 |",
      "",
      "**结论：** IANA 页面是权威说明，example.com 是该说明落地的示例域名页面。",
    ].join("\n"));
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
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-research-a",
          status: "completed",
          agent_id: "explore",
          session_key: "worker:explore:a",
          tool_chain: ["explore"],
          result: "completed evidence",
          payload: { mode: "llm_sub_agent" },
          final_content: "研究员A: URL https://example.com/; title Example Domain; quote: This domain is for use in illustrative examples in documents.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 8 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt:
        "请把这个任务交给两个独立研究员并分别取证。最后合并成一个两行表格，最后再给一句话结论。",
    },
  });

  assert.match(result.content, /\*\*结论：\*\*/);
  assert.ok(gatewayInputs.length >= 2);
});

test("llm role response generator repairs required timeout continuation synthesis that omits completed browser evidence dimensions", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executedTools = 0;
  let now = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Gathering required sibling evidence streams.",
        toolCalls: [
          {
            id: "toolu-signals",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Inspect the product signal dashboard.",
            },
          },
          {
            id: "toolu-timeout",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Inspect the orchestration dashboard.",
            },
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
      return toolCallResult("toolu-send-timeout", "sessions_send", {
        session_key: "worker:browser:task-timeout",
        message: "Continue the missing source check.",
      });
    }
    if (gatewayInputs.length === 3) {
      assert.equal(input.toolChoice, "none");
      return {
        text: "The product signal dashboard closeout only has a high-level browser note and residual risk from the local fixture.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Product signal dashboard evidence: Stuck missions: 6 and Weak answer rate: 24%. Mission Control should be the default entry. Residual risk: local fixture only.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedTools += 1;
      now = 200;
      if (input.call.id === "toolu-timeout") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-timeout",
            session_key: "worker:browser:task-timeout",
            agent_id: "browser",
            status: "timeout",
            evidence_summary: "The orchestration dashboard session timed out.",
            tool_chain: ["browser"],
            result: "Timed out before orchestration evidence completed.",
            final_content: null,
            payload: null,
            timeout_seconds: 45,
            evidence_available: true,
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-signals",
          session_key: "worker:browser:task-signals",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK. Product signals dashboard rendered in browser. Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry.",
          evidence_summary:
            "Browser-visible product signal dashboard evidence with Stuck missions: 6 and Weak answer rate: 24%.",
          final_content: null,
          payload: null,
        }),
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        [
          "Do not finalize until all three source checks complete.",
          "Source coverage must include the product signal dashboard, bridge source, and orchestration source.",
          "Open the product signal dashboard and report the rendered Stuck missions, Weak answer rate, recommendation, and residual risk.",
          "Sources: http://127.0.0.1:61930/product-signals http://127.0.0.1:61930/product-bridge http://127.0.0.1:61930/product-orchestration.",
        ].join("\n"),
    },
  });

  assert.match(result.content, /Stuck missions: 6/);
  assert.match(result.content, /Weak answer rate: 24%/);
  assert.equal(executedTools, 3);
  assert.equal(gatewayInputs.length, 4);
  assert.equal(gatewayInputs[3]?.toolChoice, "none");
  const repairPrompt = readToolContent(
    gatewayInputs[3]?.messages.at(-1)?.content ?? "",
  );
  assert.match(
    repairPrompt,
    /final answer omitted requested browser evidence dimensions/,
  );
  assert.match(repairPrompt, /product signal dashboard counters/);
  assert.match(repairPrompt, /Stuck missions: 6/);
  assert.match(repairPrompt, /Weak answer rate: 24%/);
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_send");
  assert.equal(closeout?.toolCallCount, 3);
  const missionReport = result.metadata?.missionReport as
    | Record<string, unknown>
    | undefined;
  assert.equal(missionReport?.status, "completed");
  assert.equal(missionReport?.reason, "completed_sub_agent_final");
  assert.equal(missionReport?.source, "runtime_derived");
  // runtime-derived reports do not carry authorizedPartial (task-authorization
  // is decided by an explicit model report / the evaluator, not the runtime).
  assert.equal(missionReport?.authorizedPartial, undefined);
});

test("llm role response generator aborts active tool execution when the wall-clock budget expires", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length <= 2) {
      return toolCallResult(`toolu-${gatewayInputs.length}`, "sessions_spawn", {
        agent_id: "explore",
        task: "Fetch a slow source.",
      });
    }
    return {
      text: "Final answer from wall-clock closeout.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  let observedAbortReason: string | null = null;
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return new Promise<RoleToolExecutionResult>((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            observedAbortReason =
              typeof input.signal?.reason === "string"
                ? input.signal.reason
                : "aborted";
            resolve({
              toolCallId: input.call.id,
              toolName: input.call.name,
              content: observedAbortReason ?? "aborted",
              isError: true,
            });
          },
          { once: true },
        );
      });
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128, maxWallClockMs: 5 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.match(observedAbortReason ?? "", /Tool-use wall-clock budget reached/);
  assert.ok(
    result.content === "Final answer from wall-clock closeout." ||
      /Tool-use wall-clock budget reached/.test(result.content),
  );
  assert.ok(gatewayInputs.length >= 2);
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.ok(
    closeout?.reason === "wall_clock_budget" ||
      closeout?.reason === "tool_evidence_fallback",
  );
  assert.equal(closeout?.evidenceAvailable, false);
});

test("llm role response generator extends wall-clock for slow loopback browser session tools", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let observedAbort = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-slow-loopback", "sessions_spawn", {
        agent_id: "browser",
        task: "Inspect http://127.0.0.1:61930/slow-fixture as a bounded slow-source browser check.",
        timeout_seconds: 0.001,
      });
    }
    return {
      text: "Final answer after slow loopback browser evidence.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      input.signal?.addEventListener(
        "abort",
        () => {
          observedAbort = true;
        },
        { once: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          result: "slow loopback browser result",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128, maxWallClockMs: 5 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(observedAbort, false);
  assert.equal(
    result.content,
    "Final answer after slow loopback browser evidence.",
  );
  assert.equal(gatewayInputs.length, 2);
  assert.equal(result.metadata?.toolLoopCloseout, undefined);
});

test("llm role response generator does not abort active browser sessions at the parent wall-clock boundary", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let observedAbort = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-dynamic-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open https://the-internet.herokuapp.com/dynamic_loading/1, click Start, wait for Hello World, and take a screenshot.",
      });
    }
    return {
      text: "Final answer after dynamic browser evidence.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      input.signal?.addEventListener(
        "abort",
        () => {
          observedAbort = true;
        },
        { once: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          final_content: "Hello World rendered at https://the-internet.herokuapp.com/dynamic_loading/1",
          evidence_summary: "Final URL: https://the-internet.herokuapp.com/dynamic_loading/1",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128, maxWallClockMs: 5 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(observedAbort, false);
  assert.equal(result.content, "Final answer after dynamic browser evidence.");
  assert.ok(gatewayInputs.length <= 4);
});

test("llm role response generator does not report closeout evidence for failed-only tool rounds", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
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
      text: "Final answer after failed-only bounded tool use.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        isError: true,
        content: "source fetch failed",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 1 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "round_limit");
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.equal(closeout?.evidenceAvailable, false);
});

test("llm role response generator closes out repeated failing tool calls before another retry", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executedTools = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length <= 3) {
      return toolCallResult(`toolu-${gatewayInputs.length}`, "sessions_spawn", {
        agent_id: "explore",
        task: "Fetch the same unstable source.",
        label: "unstable source",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    return {
      text: "Verification did not complete after repeated source failures.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
          status: "failed",
          result: "network failed before collecting evidence",
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

  assert.equal(
    result.content,
    "Verification did not complete after repeated source failures.",
  );
  assert.equal(executedTools, 2);
  assert.equal(gatewayInputs.length, 4);
  assert.ok(
    gatewayInputs[3]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes(
          "Repeated failing tool call detected: sessions_spawn failed 2 times",
        ),
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "repeated_tool_failure");
  assert.equal(closeout?.toolName, "sessions_spawn");
  assert.equal(closeout?.toolCallCount, 2);
  assert.equal(closeout?.roundCount, 2);
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.equal(closeout?.evidenceAvailable, false);
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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

  assert.equal(
    result.content,
    [
      "Verification did not complete within the tool budget.",
      "",
      "Continuation: this source check is resumable; continue the same source check if the missing evidence is still worth waiting for.",
    ].join("\n"),
  );
  assert.equal(executedTools, 1);
  assert.equal(gatewayInputs.length, 2);
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes(
          "No usable evidence was gathered before the timeout",
        ),
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[1])?.includes(
      "If the task specifies a heading, bullet count",
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[1])?.includes(
      "bare http:// / https:// URLs",
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[1])?.includes(
      "Do not copy internal fetch URLs",
    ),
  );
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[1])?.includes(
      "continue the same source check",
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "sub_agent_timeout");
  assert.equal(closeout?.toolName, "sessions_spawn");
  assert.equal(closeout?.timeoutSeconds, 120);
  assert.equal(closeout?.evidenceAvailable, false);
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
});

test("llm role response generator continues provider search pricing timeout before final synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  let now = 0;
  const timeoutSessionKey =
    "worker:explore:task:TASK-deepseek:call_function_timeout_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-deepseek-spawn", "sessions_spawn", {
        agent_id: "explore",
        task: "Research DeepSeek V4 Flash provider search support and pricing.",
        label: "DeepSeek provider research",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_send",
      });
      assert.ok(
        input.messages.some(
          (message) =>
            message.role === "user" &&
            readToolContent(message.content).includes(
              "Runtime correction: a required delegated evidence stream timed out.",
            ),
        ),
      );
      return toolCallResult("toolu-deepseek-send", "sessions_send", {
        session_key: timeoutSessionKey,
        message:
          "Continue DeepSeek V4 Flash provider search support and pricing verification.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Final answer from continued provider evidence.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_spawn") {
        now = 121_000;
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          isError: true,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "TASK-deepseek",
            session_key: timeoutSessionKey,
            agent_id: "explore",
            status: "timeout",
            timeout_seconds: 120,
            resumable: true,
            evidence_available: true,
            evidence_summary:
              "Execution paused before completion. Reason: Tool-use wall-clock budget reached.",
            tool_chain: [],
            result:
              "Sub-agent session timed out after 120s. The session is resumable.",
            final_content: null,
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, timeoutSessionKey);
      assert.match(
        String(input.call.input.message),
        /DeepSeek V4 Flash provider search support and pricing/i,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-deepseek",
          session_key: timeoutSessionKey,
          agent_id: "explore",
          status: "completed",
          result:
            "Provider evidence completed after continuation: OpenRouter search support and pricing verified.",
          final_content:
            "Provider evidence completed after continuation: OpenRouter search support and pricing verified.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128, maxWallClockMs: 120_000 },
    clock: { now: () => now },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt:
        "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。要求列出每个 provider 的 search 支持状态、输入/输出 token 价格、证据 URL；如果价格或 search 支持未验证，不要标 completed，继续查证或标 blocked/partial。",
    },
  });

  assert.equal(
    result.content,
    [
      "Final answer from continued provider evidence.",
      "",
      "Timeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
    ].join("\n"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_send"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_send");
});

test("llm role response generator enforces final recovery total tool budget", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (
      input.messages.some(
        (message) =>
          message.role === "user" &&
          readToolContent(message.content).includes("Final recovery tool budget reached"),
      )
    ) {
      return textResult("Blocked closeout after recovery tool budget.");
    }
    return toolCallResult(`toolu-budget-${gatewayInputs.length}`, "web_fetch", {
      url: `https://example.com/source-${gatewayInputs.length}`,
    });
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch source",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: `Fetched ${String(input.call.input.url)}`,
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.taskPrompt = [
    "Original user request: 调研 DeepSeek V4 Flash API 的可用 provider、是否支持 web search/search 参数、以及价格。",
    "输出表格列出：provider、是否明确支持 DeepSeek V4 Flash、是否明确支持 search/web_search、输入价格、输出价格、证据 URL、关键原文摘录。",
    "System recovery: the previous final answer did not satisfy required goal slots.",
    "Automatic recovery attempt 2 of 2.",
    "This is the last automatic recovery attempt for this mission. Use at most five additional tool calls total.",
  ].join("\n");

  const result = await generator.generate({
    activation: buildActivation(),
    packet,
  });

  assert.equal(result.content, "Blocked closeout after recovery tool budget.");
  assert.equal(executedCalls.length, 5);
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    [
      "toolu-budget-1",
      "toolu-budget-2",
      "toolu-budget-3",
      "toolu-budget-4",
      "toolu-budget-5",
    ],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "recovery_tool_budget");
  assert.equal(closeout?.toolCallCount, 5);
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.ok(
    gatewayInputs.some((input) =>
      input.messages.some(
        (message) =>
          message.role === "user" &&
          readToolContent(message.content).includes("Final recovery tool budget reached (5 tool calls)."),
      ),
    ),
  );
  const finalSynthesisPrompt = gatewayInputs
    .flatMap((input) => input.messages)
    .filter((message) => message.role === "user")
    .map((message) => readToolContent(message.content))
    .find((content) => content.includes("Final recovery tool budget reached"));
  assert.match(finalSynthesisPrompt ?? "", /This is not a success closeout/);
  assert.match(
    finalSynthesisPrompt ?? "",
    /Do not convert absence of evidence into a negative claim/,
  );
  assert.match(
    finalSynthesisPrompt ?? "",
    /Do not recommend a provider, cheapest option, or next business decision/,
  );
  assert.match(
    finalSynthesisPrompt ?? "",
    /For every table row that contains a confirmed value/,
  );
  assert.match(
    finalSynthesisPrompt ?? "",
    /preserve those requested columns in the table/,
  );
  assert.match(
    finalSynthesisPrompt ?? "",
    /Exact requested table columns detected: provider \| 是否明确支持 DeepSeek V4 Flash \| 是否明确支持 search\/web_search \| 输入价格 \| 输出价格 \| 证据 URL \| 关键原文摘录/,
  );
  assert.match(
    finalSynthesisPrompt ?? "",
    /without renaming, merging, or moving that column into prose/,
  );
});

test("llm role response generator reads final recovery budget from activation recent messages", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (
      input.messages.some(
        (message) =>
          message.role === "user" &&
          readToolContent(message.content).includes("Final recovery tool budget reached"),
      )
    ) {
      return textResult("Blocked closeout from activation recovery budget.");
    }
    return toolCallResult(`toolu-recent-budget-${gatewayInputs.length}`, "sessions_history", {
      session_key: `worker:explore:task:TASK-${gatewayInputs.length}:call_function_${gatewayInputs.length}`,
      limit: 5,
    });
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_history",
          description: "Read a session transcript",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              limit: { type: "number" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: `History ${String(input.call.input.session_key)}`,
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.taskPrompt = "Continue the original mission.";
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief: "Continue the original mission.",
    recentMessages: [
      {
        messageId: "msg-recovery",
        role: "user",
        name: "User",
        content: [
          "System recovery: the previous final answer did not satisfy required goal slots.",
          "Automatic recovery attempt 2 of 2.",
          "This is the last automatic recovery attempt for this mission. Use at most five additional tool calls total.",
        ].join("\n"),
        createdAt: 1,
      } satisfies TeamMessageSummary,
    ],
  };

  const result = await generator.generate({
    activation,
    packet,
  });

  assert.equal(result.content, "Blocked closeout from activation recovery budget.");
  assert.equal(executedCalls.length, 5);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_history", "sessions_history", "sessions_history", "sessions_history", "sessions_history"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "recovery_tool_budget");
  assert.equal(closeout?.toolCallCount, 5);
  assert.equal(closeout?.pendingToolCallCount, 1);
});

test("llm role response generator carries final recovery tool budget across activations", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (
      input.messages.some(
        (message) =>
          message.role === "user" &&
          readToolContent(message.content).includes("Final recovery tool budget reached"),
      )
    ) {
      return textResult("Blocked closeout after shared recovery budget.");
    }
    return {
      text: "Need two more source checks.",
      toolCalls: [
        {
          id: "toolu-budget-a",
          name: "web_fetch",
          input: { url: "https://example.com/a" },
        },
        {
          id: "toolu-budget-b",
          name: "web_fetch",
          input: { url: "https://example.com/b" },
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
          name: "web_fetch",
          description: "Fetch source",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: `Fetched ${String(input.call.input.url)}`,
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief: "Continue the original mission.",
    recentMessages: [
      {
        messageId: "msg-recovery",
        role: "user",
        name: "User",
        content: [
          "System recovery: the previous final answer did not satisfy required goal slots.",
          "Automatic recovery attempt 2 of 2.",
          "This is the last automatic recovery attempt for this mission. Use at most five additional tool calls total.",
        ].join("\n"),
        createdAt: 1,
      } satisfies TeamMessageSummary,
      {
        messageId: "msg-call-1",
        role: "assistant",
        name: "Lead",
        content: 'Calling sessions_history(session_key="worker:one")',
        createdAt: 2,
      } satisfies TeamMessageSummary,
      {
        messageId: "msg-call-2",
        role: "assistant",
        name: "Lead",
        content: 'Calling sessions_list(limit=10)',
        createdAt: 3,
      } satisfies TeamMessageSummary,
      {
        messageId: "msg-call-3",
        role: "assistant",
        name: "Explore",
        content: 'Calling sessions_history(session_key="worker:two")',
        createdAt: 4,
      } satisfies TeamMessageSummary,
      {
        messageId: "msg-call-4",
        role: "assistant",
        name: "Explore",
        content: 'Calling sessions_history(session_key="worker:three")',
        createdAt: 5,
      } satisfies TeamMessageSummary,
    ],
  };
  const packet = buildPacket();
  packet.taskPrompt = "Continue the original mission.";

  const result = await generator.generate({
    activation,
    packet,
  });

  assert.equal(result.content, "Blocked closeout after shared recovery budget.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-budget-a"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "recovery_tool_budget");
  assert.equal(closeout?.toolCallCount, 5);
  assert.equal(closeout?.pendingToolCallCount, 2);
});

test("llm role response generator blocks delegation after final recovery budget is exhausted", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (
      input.messages.some(
        (message) =>
          message.role === "user" &&
          readToolContent(message.content).includes(
            "Runtime correction: final recovery tool budget is exhausted",
          ),
      )
    ) {
      assert.equal(input.toolChoice, "none");
      assert.equal(input.tools, undefined);
      return textResult("blocked: final recovery budget exhausted; no further delegation.");
    }
    return textResult([
      "Lead is operating as Lead Coordinator.",
      "Delegate one next role when work remains. Otherwise finalize.",
      "@{role-explore} Please take the next assigned slice and report back briefly.",
    ].join("\n"));
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch source",
          inputSchema: { type: "object" },
        },
      ];
    },
    async execute() {
      throw new Error("should not execute tools after exhausted recovery budget");
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief: "Continue the original mission.",
    recentMessages: [
      {
        messageId: "msg-recovery",
        role: "user",
        name: "User",
        content: [
          "System recovery: the previous final answer did not satisfy required goal slots.",
          "Automatic recovery attempt 2 of 2.",
          "This is the last automatic recovery attempt for this mission. Use at most five additional tool calls total.",
        ].join("\n"),
        createdAt: 1,
      } satisfies TeamMessageSummary,
      ...[1, 2, 3, 4, 5].map((n) => ({
        messageId: `msg-call-${n}`,
        role: "assistant" as const,
        name: "Lead",
        content: `Calling sessions_history(session_key="worker:${n}")`,
        createdAt: 1 + n,
      } satisfies TeamMessageSummary)),
    ],
  };
  const packet = buildPacket();
  packet.taskPrompt = "Continue the original mission.";

  const result = await generator.generate({
    activation,
    packet,
  });

  assert.equal(
    result.content,
    "blocked: final recovery budget exhausted; no further delegation.",
  );
  assert.ok(gatewayInputs.length >= 2);
  assert.ok(
    gatewayInputs.some((input) =>
      input.messages.some(
        (message) =>
          message.role === "user" &&
          readToolContent(message.content).includes(
            "Runtime correction: final recovery tool budget is exhausted",
          ),
      ),
    ),
  );
});

test("llm role response generator repairs final answers that transpose requested table columns", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-fetch", "web_fetch", {
        url: "https://api-docs.deepseek.com/news/news260424",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "| Slot | DeepSeek 官方 | OpenRouter |",
          "|---|---|---|",
          "| 是否明确支持 DeepSeek V4 Flash | 是 | 未验证 |",
        ].join("\n"),
      );
    }
    return textResult(
      [
        "**Mission 状态：blocked / partial**",
        "",
        "| provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
        "|---|---|---|---|---|---|---|",
        "| DeepSeek 官方 | 是 | 未验证 | 未验证 | 未验证 | https://api-docs.deepseek.com/news/news260424 | DeepSeek V4 Preview Release |",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch source",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "ok",
          final_url: input.call.input.url,
          text_excerpt: "DeepSeek V4 Preview Release",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.taskPrompt = [
    "调研 DeepSeek V4 Flash API 的可用 provider、是否支持 web search/search 参数、以及价格。",
    "输出表格列出：provider、是否明确支持 DeepSeek V4 Flash、是否明确支持 search/web_search、输入价格、输出价格、证据 URL、关键原文摘录。",
    "Prior bad repair text: Required table header columns: provider | 是否明确支持 DeepSee… | **Mission 状态：blocked / partial** | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | …",
  ].join("\n");

  const result = await generator.generate({
    activation: buildActivation(),
    packet,
  });

  assert.equal(gatewayInputs.length, 3);
  assert.match(result.content, /provider \| 是否明确支持 DeepSeek V4 Flash/);
  assert.doesNotMatch(result.content, /\| Slot \|/);
  const repairPrompt = gatewayInputs[2]?.messages
    .filter((message) => message.role === "user")
    .map((message) => readToolContent(message.content))
    .filter((content) => content.includes("Required table header columns"))
    .at(-1);
  assert.match(repairPrompt ?? "", /Do not rename columns, transpose the table into Slot x Provider form/);
});

test("llm role response generator expands truncated provider table columns before repair", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-fetch", "web_fetch", {
        url: "https://openrouter.ai/deepseek/deepseek-v4-flash",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "| provider | input_price_per_1M | output_price_per_1M | search_support | source_url |",
          "|---|---|---|---|---|",
          "| openrouter.ai | $0.0983 | $0.1966 | 未验证 | openrouter.ai/deepseek/deepseek-v4-flash |",
        ].join("\n"),
      );
    }
    const repairPrompt = readToolContent(
      input.messages[input.messages.length - 1]?.content ?? "",
    );
    assert.match(
      repairPrompt,
      /Required table header columns: provider \| 是否明确支持 DeepSeek V4 Flash \| 是否明确支持 search\/web_search \| 输入价格 \| 输出价格 \| 证据 URL \| 关键原文摘录/,
    );
    return textResult(
      [
        "**Mission 状态：blocked / partial**",
        "",
        "| provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
        "|---|---|---|---|---|---|---|",
        "| openrouter.ai | 未验证 | 未验证 | $0.0983 | $0.1966 | https://openrouter.ai/deepseek/deepseek-v4-flash | DeepSeek V4 Flash pricing page |",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch source",
          inputSchema: { type: "object" },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "DeepSeek V4 Flash provider pricing evidence.",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 8 },
  });
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief:
      "Research DeepSeek V4 Flash provider support, search/web_search support, and input/output pricing.",
    recentMessages: [
      {
        messageId: "msg-truncated-user",
        role: "user",
        name: "User",
        content:
          "调研 DeepSeek V4 Flash API 的可用 provider、是否支持 web search/search 参数、以及价格。输出表格列出：provider",
        createdAt: 1,
      } satisfies TeamMessageSummary,
    ],
  };
  const packet = buildPacket();
  packet.taskPrompt = "Continue the original mission.";

  const result = await generator.generate({
    activation,
    packet,
  });

  assert.match(
    result.content,
    /\| provider \| 是否明确支持 DeepSeek V4 Flash \| 是否明确支持 search\/web_search \| 输入价格 \| 输出价格 \| 证据 URL \| 关键原文摘录 \|/,
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs decorated requested table headers", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return textResult(
        [
          "| Provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 ($/1M tokens) | 输出价格 ($/1M tokens) | 证据 URL | 关键原文摘录 |",
          "|---|---|---|---|---|---|---|",
          "| Fireworks AI | 是 | 未验证 | $0.14 | $0.28 | https://fireworks.ai/models/deepseek-ai/deepseek-v4-flash | pricing excerpt |",
        ].join("\n"),
      );
    }
    const repairPrompt = readToolContent(
      input.messages[input.messages.length - 1]?.content ?? "",
    );
    assert.match(
      repairPrompt,
      /Required table header columns: provider \| 是否明确支持 DeepSeek V4 Flash \| 是否明确支持 search\/web_search \| 输入价格 \| 输出价格 \| 证据 URL \| 关键原文摘录/,
    );
    return textResult(
      [
        "| provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
        "|---|---|---|---|---|---|---|",
        "| Fireworks AI | 是 | 未验证 | $0.14 | $0.28 | https://fireworks.ai/models/deepseek-ai/deepseek-v4-flash | pricing excerpt |",
      ].join("\n"),
    );
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: {
      executor: {
        definitions() {
          return [];
        },
        async execute() {
          throw new Error("no tools expected");
        },
      },
      maxRounds: 4,
    },
  });
  const packet = buildPacket();
  packet.taskPrompt = [
    "调研 DeepSeek V4 Flash API 的可用 provider、是否支持 web search/search 参数、以及价格。",
    "输出表格列出：provider、是否明确支持 DeepSeek V4 Flash、是否明确支持 search/web_search、输入价格、输出价格、证据 URL、关键原文摘录。",
  ].join("\n");

  const result = await generator.generate({
    activation: buildActivation(),
    packet,
  });

  assert.match(
    result.content,
    /\| provider \| 是否明确支持 DeepSeek V4 Flash \| 是否明确支持 search\/web_search \| 输入价格 \| 输出价格 \| 证据 URL \| 关键原文摘录 \|/,
  );
  assert.ok(gatewayInputs.length <= 4);
});

test("llm role response generator repairs completed session synthesis that renames requested table columns", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-session", "sessions_spawn", {
        agent_id: "explore",
        task: "Verify DeepSeek V4 Flash provider evidence.",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "| provider | DeepSeek V4 Flash 支持 | search/web_search 参数支持 | 输入价格 | 输出价格 | 来源 |",
          "|---|---|---|---|---|---|",
          "| OpenRouter | 是 | 未验证 | $0.0983 | $0.1966 | OpenRouter page |",
        ].join("\n"),
      );
    }
    return textResult(
      [
        "**Mission 状态：blocked / partial**",
        "",
        "| provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
        "|---|---|---|---|---|---|---|",
        "| OpenRouter | 是 | 未验证 | $0.0983 | $0.1966 | https://openrouter.ai/deepseek | DeepSeek V4 Flash price evidence |",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              task: { type: "string" },
            },
          },
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
          session_key: "worker:explore:task:TASK-1:call_function_session_1",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: "Provider evidence completed.",
          final_content:
            "OpenRouter evidence: DeepSeek V4 Flash, price $0.0983 input and $0.1966 output. Search support not verified. URL https://openrouter.ai/deepseek",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.taskPrompt = [
    "调研 DeepSeek V4 Flash API 的可用 provider、是否支持 web search/search 参数、以及价格。",
    "输出表格列出：provider、是否明确支持 DeepSeek V4 Flash、是否明确支持 search/web_search、输入价格、输出价格、证据 URL、关键原文摘录。",
  ].join("\n");

  const result = await generator.generate({
    activation: buildActivation(),
    packet,
  });

  assert.equal(gatewayInputs.length, 3);
  assert.match(result.content, /是否明确支持 DeepSeek V4 Flash/);
  assert.match(result.content, /关键原文摘录/);
  assert.doesNotMatch(result.content, /DeepSeek V4 Flash 支持/);
  const repairPrompt = gatewayInputs[2]?.messages
    .filter((message) => message.role === "user")
    .map((message) => readToolContent(message.content))
    .filter((content) => content.includes("Required table header columns"))
    .at(-1);
  assert.match(repairPrompt ?? "", /Required table header columns: provider/);
});

test("llm role response generator does not infer requested table columns from tool evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-vendor", "sessions_spawn", {
        agent_id: "explore",
        label: "Vendor comparison evidence",
        task: "Extract Vendor Alpha and Vendor Beta facts.",
      });
    }
    return textResult(
      "Recommend Vendor Alpha for the workbench team; use Vendor Beta when workspace packaging matters more.",
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      const pollutedTable = [
        "| provider | 是否明确支持目标模型 | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| Vendor Alpha | 未验证 | 未验证 | $19 per seat | 未验证 | http://127.0.0.1/vendor-alpha | Pricing: $19 per seat. |",
      ].join("\n");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-vendor",
          session_key: "worker:explore:task-vendor:toolu-vendor",
          agent_id: "explore",
          status: "completed",
          result: pollutedTable,
          final_content: pollutedTable,
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: pollutedTable,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "A product lead is deciding between Vendor Alpha and Vendor Beta.",
        "Return a concise recommendation comparing pricing, strengths, risks, and the tradeoff that matters most.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Recommend Vendor Alpha/);
  const finalSynthesisUserText = gatewayInputs[1]?.messages
    .filter((message) => message.role === "user")
    .map((message) => readToolContent(message.content))
    .join("\n");
  assert.doesNotMatch(
    finalSynthesisUserText ?? "",
    /Exact requested table columns detected/i,
  );
  assert.match(
    finalSynthesisUserText ?? "",
    /Do not copy a source table's shape, headers, or unrelated dimensions/i,
  );
});

test("llm role response generator repairs unrequested provider table schema in vendor comparison finals", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-vendor", "sessions_spawn", {
        agent_id: "explore",
        label: "Vendor comparison evidence",
        task: "Extract Vendor Alpha and Vendor Beta facts.",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "| provider | 是否明确支持目标模型 | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
          "|---|---|---|---|---|---|---|",
          "| Vendor Alpha | 未验证 | 未验证 | 未验证 | 未验证 | http://127.0.0.1/vendor-alpha | Pricing: $19 per seat. Strength: browser automation. Risk: limited API catalog. |",
          "| Vendor Beta | 未验证 | 未验证 | 未验证 | 未验证 | http://127.0.0.1/vendor-beta | Pricing: $29 per workspace. Strength: approval workflow. Risk: separate browser connector. |",
          "",
          "**Blocked / Partial** — provider/search/model-support columns are unverified.",
        ].join("\n"),
      );
    }
    const repairPrompt = readToolContent(
      input.messages[input.messages.length - 1]?.content ?? "",
    );
    assert.match(
      repairPrompt,
      /introduced provider\/search\/model-support columns that were not requested/,
    );
    return textResult(
      [
        "**Recommendation: choose Vendor Alpha for next week's agent workbench investment.**",
        "",
        "- Vendor Alpha: $19 per seat; strength is browser automation and traceable screenshots; risk is a limited API integration catalog.",
        "- Vendor Beta: $29 per workspace; strength is approval workflow and team handoff history; risk is that browser control requires a separate connector.",
        "- Tradeoff: Alpha is cheaper and closer to browser-first workbench execution; Beta is preferable when governance/approval workflow matters more than price.",
        "",
        "Residual risk: this is source-bounded to the two collected pages.",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-vendor",
          session_key: "worker:explore:task-vendor:toolu-vendor",
          agent_id: "explore",
          status: "completed",
          result: "Vendor Alpha is $19 per seat. Vendor Beta is $29 per workspace.",
          final_content:
            "Vendor Alpha: Pricing $19 per seat; strength browser automation and traceable screenshots; risk limited API catalog.\nVendor Beta: Pricing $29 per workspace; strength approval workflow and team handoff history; risk separate browser connector.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "A product lead is deciding between Vendor Alpha and Vendor Beta for next week's workbench investment.",
        "Return a concise recommendation that compares pricing, strengths, risks, and the tradeoff that matters most.",
        "Close with a clear recommendation for the product lead, including when the other option would be preferable.",
      ].join("\n"),
    },
  });

  assert.equal(gatewayInputs.length, 3);
  assert.match(result.content, /choose Vendor Alpha/i);
  assert.doesNotMatch(result.content, /是否明确支持目标模型|search\/web_search|输入价格|输出价格/);
});

test("llm role response generator repairs unrequested provider table schema despite polluted recent context", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-product", "sessions_spawn", {
        agent_id: "explore",
        label: "product release evidence",
        task: "Collect product orchestration, browser bridge, and signal dashboard evidence.",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "## Product-Ready Brief: Next Agent Workbench Release",
          "",
          "| provider | 是否明确支持目标模型 | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
          "|---|---|---|---|---|---|---|",
          "| 未验证 | 未验证 | 未验证 | 未验证 | 未验证 | http://127.0.0.1/product-orchestration | Mission Control entry-point gap. |",
          "",
          "**Blocked / Partial** — provider/search/model-support columns are unverified.",
        ].join("\n"),
      );
    }
    const repairPrompt = readToolContent(
      input.messages[input.messages.length - 1]?.content ?? "",
    );
    assert.match(
      repairPrompt,
      /introduced provider\/search\/model-support columns that were not requested/,
    );
    return textResult(
      [
        "## Product-ready brief",
        "",
        "- Build next: make Mission Control the default entry point and gate release on real LLM scenario quality.",
        "- Why it matters: orchestration evidence shows specialist agents can produce a decision-ready brief with durable sub-session history.",
        "- Do not over-emphasize: browser bridge depth alone; first-run setup and provider configuration are still adoption risks.",
        "- Signals: Stuck missions is 6, Weak answer rate is 24%, and the recommended next action is to make Mission Control the default entry.",
        "- Evidence: product-orchestration verified multi-agent decomposition; product-bridge verified browser controls and setup risk; product-signals verified the rendered dashboard metrics.",
        "- Residual risk: source-bounded to the local fixtures and browser transport evidence.",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-product",
          session_key: "worker:explore:task-product:toolu-product",
          agent_id: "explore",
          status: "completed",
          result:
            "Product orchestration: Mission Control entry-point gap. Bridge: browser controls and setup risk. Signals: Stuck missions 6; Weak answer rate 24%; recommended next action make Mission Control the default entry.",
          final_content:
            "Product orchestration verified multi-agent decomposition with durable sub-session history. Product bridge verified browser controls and command-line setup risk. Product signals verified Stuck missions 6, Weak answer rate 24%, and recommended next action make Mission Control the default entry.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief: "Continue the product brief.",
    recentMessages: [
      {
        messageId: "msg-polluted-context",
        role: "user",
        name: "User",
        content:
          "System recovery note from an earlier failed answer mentioned provider | 是否明确支持目标模型 | 是否明确支持 search/web_search | 输入价格 | 输出价格, but the original task is still the product brief.",
        createdAt: 1,
      } satisfies TeamMessageSummary,
    ],
  };

  const result = await generator.generate({
    activation,
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief about the next agent workbench release.",
        "Research source: http://127.0.0.1/product-orchestration",
        "Capability source: http://127.0.0.1/product-bridge",
        "Live signal dashboard: http://127.0.0.1/product-signals",
        "The final brief must explicitly include Mission Control, Stuck missions, Weak answer rate, and the signal-dashboard recommended next action when those values are present.",
        "The final brief should tell a product leader what to build next, why it matters, what not to over-emphasize, and what risk remains.",
      ].join("\n"),
    },
  });

  assert.ok(gatewayInputs.length >= 3);
  assert.match(result.content, /Mission Control/);
  assert.match(result.content, /Stuck missions.*6/i);
  assert.match(result.content, /Weak answer rate.*24%/i);
  assert.doesNotMatch(result.content, /是否明确支持目标模型|search\/web_search|输入价格|输出价格/);
});

test("llm role response generator repairs product briefs that drop multi-agent and rendered signal evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const repairPrompts: string[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-product-brief", "sessions_spawn", {
        agent_id: "browser",
        label: "product-workbench-evidence",
        task: "Collect product orchestration, bridge, and rendered product signal evidence.",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "## Agent Workbench Release Brief",
          "",
          "- Build next: make Mission Control the default entry point.",
          "- Why: agents converge to a brief and the dashboard has release signals.",
          "- Signals: Stuck missions: 6; Weak-answer rate: 24%, but rendered browser evidence remains unverified.",
          "- Risk: source-bounded to local fixtures.",
        ].join("\n"),
      );
    }
    repairPrompts.push(
      input.messages.map((message) => readToolContent(message.content)).join("\n\n"),
    );
    return textResult(
      [
        "## Agent Workbench Release Brief",
        "",
        "- Build next: make Mission Control the default entry point.",
        "- Why it matters: product-orchestration verifies multi-agent decomposition with durable sub-session history, so specialist agents can produce one decision-ready brief.",
        "- Bridge evidence: product-bridge verifies browser bridge controls, DOM inspection, screenshots, artifacts, and setup risk.",
        "- Rendered browser evidence: product-signals was inspected as rendered browser evidence, not raw HTML; Stuck missions: 6; Weak-answer rate: 24%; recommended next action is to make Mission Control the default entry.",
        "- Risk: source-bounded to local fixtures, not production telemetry.",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      const finalContent = [
        "Product orchestration evidence: multi-agent decomposition with durable sub-session history and follow-up.",
        "Product bridge evidence: browser bridge controls, command-line setup, provider configuration, DOM inspection, screenshots, and artifacts.",
        "Product signals rendered browser evidence: Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry.",
      ].join("\n");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-product-workbench-evidence",
          session_key: `worker:browser:task-product-workbench-evidence:${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: finalContent,
          final_content: finalContent,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief about the next agent workbench release.",
        "Research source: http://127.0.0.1/product-orchestration",
        "Capability source: http://127.0.0.1/product-bridge",
        "Live signal dashboard: http://127.0.0.1/product-signals",
        "These are source evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
        "The final brief must explicitly include Mission Control, Stuck missions, Weak answer rate, and the signal-dashboard recommended next action when those values are present.",
      ].join("\n"),
    },
  });

  assert.ok(
    repairPrompts.some((prompt) =>
      /dropped required source-backed workbench evidence/.test(prompt),
    ),
  );
  assert.ok(repairPrompts.some((prompt) => /multi-agent decomposition/.test(prompt)));
  assert.ok(repairPrompts.some((prompt) => /rendered browser evidence/.test(prompt)));
  assert.ok(repairPrompts.some((prompt) => /Stuck missions: 6/.test(prompt)));
  assert.match(result.content, /multi-agent decomposition/);
  assert.match(result.content, /rendered browser evidence, not raw HTML/);
  assert.match(result.content, /Weak-answer rate: 24%/);
});

test("llm role response generator repairs AsiaWalk briefs that drop completed multi-role evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const repairPrompts: string[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-asiawalk", "sessions_spawn", {
        agent_id: "browser",
        label: "AsiaWalk Live Readiness",
        task: "Collect route, budget, and rendered readiness evidence.",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "Based on the delegated session evidence, I can verify page titles only.",
          "",
          "Not verified: route shape, budget line items, readiness status, risk flags, go/no-go recommendation.",
          "Evidence gap: substantive content was not preserved in the aggregated result budget.",
          "How to continue: retrieve the session content in full using the available session keys.",
        ].join("\n"),
      );
    }
    repairPrompts.push(
      input.messages.map((message) => readToolContent(message.content)).join("\n\n"),
    );
    return textResult(
      [
        "## AsiaWalk Pilot Brief",
        "",
        "- Route: Seoul orientation walk, Taipei food-and-transit loop, Tokyo neighborhood finale.",
        "- Budget: $1,280 total with a $180 contingency buffer.",
        "- Rendered browser readiness: yellow, with rain risk in Taipei and metro maintenance in Tokyo.",
        "- Recommendation: conditional go after guide availability, Taipei indoor alternates, and Tokyo transfer buffer are confirmed.",
        "- Residual risk: source-bounded local fixture evidence only.",
      ].join("\n"),
    );
  };
  const evidence = [
    "Route source evidence: Seoul orientation walk, Taipei food-and-transit loop, Tokyo neighborhood finale. Route risk: Tokyo finale depends on evening crowd control.",
    "Budget source evidence: Estimated pilot budget: $1,280 total. Contingency buffer: $180 reserved for rain reroutes or replacement guide coverage.",
    "Rendered browser evidence: Overall readiness: yellow (amber). Live risk: rain risk in Taipei and metro maintenance in Tokyo. Next action: confirm indoor alternates and Tokyo transfer buffer.",
  ].join("\n");
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-asiawalk",
          session_key: `worker:browser:task-asiawalk:${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: evidence,
          final_content: evidence,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Route source: http://127.0.0.1/asiawalk-route",
        "Budget source: http://127.0.0.1/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1/asiawalk-live",
        "Treat route, budget, and live readiness as separate evidence streams. Use specialist work where it helps, and inspect the live readiness dashboard as rendered browser evidence.",
        "The final brief should cover the route shape, budget, readiness risks, go/no-go recommendation, and next action.",
      ].join("\n"),
    },
  });

  assert.ok(
    repairPrompts.some((prompt) =>
      /final answer dropped visible evidence source labels/.test(prompt),
    ),
    `expected generic evidence-label repair prompt; gatewayInputs=${gatewayInputs.length}; final=${result.content}; prompts=${repairPrompts.join("\n---\n")}`,
  );
  assert.ok(repairPrompts.some((prompt) => /AsiaWalk Live Readiness/.test(prompt)));
  assert.match(result.content, /rain risk in Taipei/);
  assert.match(result.content, /metro maintenance in Tokyo/);
  assert.match(result.content, /Seoul orientation walk/);
  assert.match(result.content, /\$1,280/);
  assert.match(result.content, /rain risk in Taipei/);
  assert.match(result.content, /conditional go/i);
});

test("llm role response generator does not replace AsiaWalk model finals with local canned closeouts", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Starting separate AsiaWalk streams.",
        toolCalls: [
          {
            id: "toolu-route",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "AsiaWalk Route Stream",
              task: "Collect route evidence.",
            },
          },
          {
            id: "toolu-budget",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "AsiaWalk Budget Stream",
              task: "Collect budget evidence.",
            },
          },
          {
            id: "toolu-live",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "AsiaWalk Live Readiness Stream",
              task: "Collect rendered readiness evidence.",
            },
          },
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
      text: [
        "MODEL_AUTHORED_ASIAWALK_BRIEF",
        "Route: Seoul orientation walk, Taipei food-and-transit loop, and Tokyo neighborhood finale.",
        "Budget: $1,280 total with a $180 contingency buffer.",
        "Readiness: rain risk in Taipei and metro maintenance in Tokyo.",
        "Recommendation: conditional go after indoor alternates and transfer buffers are confirmed.",
      ].join("\n"),
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const evidence = [
    "Route source evidence: Seoul orientation walk, Taipei food-and-transit loop, Tokyo neighborhood finale. Route risk: Tokyo finale depends on evening crowd control.",
    "Budget source evidence: Estimated pilot budget: $1,280 total. Contingency buffer: $180 reserved for rain reroutes or replacement guide coverage.",
    "Rendered browser evidence: Overall readiness: yellow (amber). Live risk: rain risk in Taipei and metro maintenance in Tokyo. Next action: confirm indoor alternates and Tokyo transfer buffer.",
  ].join("\n");
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" }, message: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-asiawalk",
          session_key: `worker:browser:task-asiawalk:${input.call.id}`,
          agent_id: input.call.input.agent_id ?? "browser",
          status: "completed",
          result: evidence,
          final_content: evidence,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Route source: http://127.0.0.1/asiawalk-route",
        "Budget source: http://127.0.0.1/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1/asiawalk-live",
        "Treat route, budget, and live readiness as separate evidence streams. Use specialist work where it helps, and inspect the live readiness dashboard as rendered browser evidence.",
        "The final brief should cover the route shape, budget, readiness risks, go/no-go recommendation, and next action.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_spawn", "sessions_spawn"],
  );
  assert.match(result.content, /MODEL_AUTHORED_ASIAWALK_BRIEF/);
  assert.match(result.content, /\$1,280/);
  assert.match(result.content, /rain risk in Taipei/);
  assert.match(result.content, /conditional go/i);
  assert.equal(result.metadata?.adapterName, "test");
});

test("llm role response generator routes continuation follow-up to timed-out session", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-continue", "sessions_spawn", {
        agent_id: "explore",
        task: "Resume the slow source check and return the release-risk note.",
        label: "slow source continuation",
        timeout_seconds: 120,
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Final answer from resumed session evidence.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task-1:toolu-timeout",
      );
      assert.match(
        String(input.call.input.message),
        /Resume the slow source check/,
      );
      assert.equal(input.call.input.timeout_seconds, undefined);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Resumed session evidence.",
          final_content:
            "Verified resumed source evidence. Unverified freshness remains.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified resumed source evidence. Unverified freshness remains.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = {
    ...buildPacket(),
    taskPrompt: [
      "Task brief:",
      "Continue from the slow-source attempt in this mission and finish the release-risk note.",
      "",
      "Recent turns:",
      "[user] Continue from the slow-source attempt in this mission and finish the release-risk note.",
      '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"timeout","session_key":"worker:explore:task-1:toolu-timeout","agent_id":"explore","result":"WORKER_TIMEOUT","resumable":true}',
    ].join("\n"),
  };

  const result = await generator.generate({
    activation: buildActivation(),
    packet,
  });

  assert.equal(
    result.content,
    [
      "Final answer from resumed session evidence.",
      "",
      "Timeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
    ].join("\n"),
  );
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.match(
    readToolContent(gatewayInputs[0]!.messages[1]!.content),
    /Runtime session continuation directive/,
  );
  assert.match(
    readToolContent(gatewayInputs[0]!.messages[1]!.content),
    /worker:explore:task-1:toolu-timeout/,
  );
});

test("llm role response generator routes multi-line continuation follow-up when only the first line says continue", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return {
        text: "I can answer from the prior context.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Recovered release-risk note.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Resumed source evidence.",
          final_content:
            "Verified owner: Release Captain. Unverified freshness remains. Residual risk: timeout-gated source.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified owner: Release Captain. Unverified freshness remains. Residual risk: timeout-gated source.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "Separate verified facts from unverified items, describe any residual risk, and explain whether the earlier timeout still limits the conclusion.",
        "",
        "Recent turns:",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"timeout","session_key":"worker:explore:task-1:toolu-timeout","agent_id":"explore","result":"WORKER_TIMEOUT","resumable":true}',
      ].join("\n"),
    },
  });

  assert.match(result.content, /Recovered release-risk note/);
  assert.match(result.content, /Timeout closeout:/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
  assert.equal(
    executedCalls[0]?.input.session_key,
    "worker:explore:task-1:toolu-timeout",
  );
});

test("llm role response generator prefers resumable timeout session over later completed session on follow-up", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-continue-wrong-session", "sessions_send", {
        session_key: "worker:browser:task-dashboard:toolu-browser",
        message: "Continue the dashboard context.",
      });
    }
    return {
      text: "Final answer from the resumed slow-source evidence.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task-1:toolu-timeout",
      );
      assert.match(
        String(input.call.input.message),
        /Continue from the slow-source attempt/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Resumed slow-source evidence.",
          final_content:
            "Verified resumed slow-source evidence. Earlier timeout no longer limits the conclusion.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified resumed slow-source evidence. Earlier timeout no longer limits the conclusion.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission and finish the release-risk note.",
        "",
        "Recent turns:",
        "[user] Continue from the slow-source attempt in this mission and finish the release-risk note.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"timeout","session_key":"worker:explore:task-1:toolu-timeout","agent_id":"explore","result":"WORKER_TIMEOUT","resumable":true}',
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"completed","session_key":"worker:browser:task-dashboard:toolu-browser","agent_id":"browser","result":"Dashboard evidence.","final_content":"Dashboard evidence."}',
      ].join("\n"),
    },
  });

  assert.match(result.content, /resumed slow-source evidence/);
  assert.deepEqual(
    executedCalls.map((call) => call.input.session_key),
    ["worker:explore:task-1:toolu-timeout"],
  );
});

test("llm role response generator prefers timeout source session over later resumable browser sibling", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-continue-browser", "sessions_send", {
        session_key: "worker:browser:task-1:toolu-browser",
        message: "Continue the browser sibling.",
      });
    }
    return {
      text: "Final answer from the resumed source-check evidence.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task-1:toolu-timeout",
      );
      assert.match(String(input.call.input.message), /slow-source attempt/);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Source-check continuation completed.",
          final_content:
            "Verified source-check evidence after continuing the timed-out source.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified source-check evidence after continuing the timed-out source.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission and finish the release-risk note.",
        "",
        "Recent turns:",
        "[user] Continue from the slow-source attempt in this mission and finish the release-risk note.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"timeout","session_key":"worker:explore:task-1:toolu-timeout","agent_id":"explore","result":"WORKER_TIMEOUT","resumable":true}',
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:browser:task-1:toolu-browser","agent_id":"browser","result":"Browser session cancelled.","resumable":true}',
      ].join("\n"),
    },
  });

  assert.match(result.content, /resumed source-check evidence/);
  assert.deepEqual(
    executedCalls.map((call) => call.input.session_key),
    ["worker:explore:task-1:toolu-timeout"],
  );
});

test("llm role response generator does not append recovered timeout closeout without raw timeout evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-continue", "sessions_send", {
        session_key: "worker:explore:task-1:toolu-timeout",
        message:
          "Resume the slow source check and return the release-risk note.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "The resumed source verified the fixture and the earlier timeout no longer limits the release-risk conclusion.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Resumed session evidence.",
          final_content:
            "Verified resumed source evidence. The earlier timeout no longer limits the release-risk conclusion.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified resumed source evidence. The earlier timeout no longer limits the release-risk conclusion.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible and turn the outcome into a release-risk note.",
        "Explain whether the earlier timeout still limits the conclusion.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /The resumed source verified the fixture/);
  assert.match(result.content, /Unverified scope/);
  assert.ok(gatewayInputs.length >= 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator preserves timeout closeout when resumed evidence omits guidance", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-continue", "sessions_send", {
        session_key: "worker:explore:task-1:toolu-timeout",
        message:
          "Resume the slow source check and turn the outcome into a release-risk note.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: [
        "Verified facts: the resumed source returned HTTP 200 with the expected fixture marker.",
        "Unverified items: response headers and performance baseline were not collected.",
        "Residual risk: none from the source itself. The earlier 30-second timeout does not limit the conclusion.",
        "Recommendation: low release risk; no action required.",
      ].join("\n"),
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Resumed slow-source evidence.",
          final_content:
            "Verified resumed source evidence. The earlier timeout no longer limits the release-risk conclusion.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified resumed source evidence. The earlier timeout no longer limits the release-risk conclusion.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Prepare a release-risk note from the source evidence.",
        "",
        "Recent turns:",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "timeout",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          result: "WORKER_TIMEOUT",
          resumable: true,
        }),
      ].join("\n"),
    },
  });

  assert.match(
    result.content,
    /earlier 30-second timeout does not limit the conclusion/,
  );
  assert.match(
    result.content,
    /Timeout closeout: the resumed source produced source-backed evidence/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
  assert.ok(gatewayInputs.length >= 2);
});

test("llm role response generator restores timeout closeout when recovered final omits timeout wording", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-continue", "sessions_send", {
        session_key: "worker:explore:task-1:toolu-timeout",
        message:
          "Resume the slow source check and turn the outcome into a release-risk note.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: [
        "Verified facts: the resumed source returned HTTP 200 with the expected fixture marker.",
        "Risk: runbook gap before launch approval.",
        "Recommendation: complete rollback rehearsal before release gate.",
        "Mission complete. No further delegation needed.",
      ].join("\n"),
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
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
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Resumed slow-source evidence.",
          final_content:
            "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Prepare a release-risk note from the source evidence.",
        "",
        "Recent turns:",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "timeout",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          result: "WORKER_TIMEOUT",
          resumable: true,
        }),
      ].join("\n"),
    },
  });

  assert.match(result.content, /No further delegation needed/);
  assert.match(
    result.content,
    /Timeout closeout: the resumed source produced source-backed evidence/,
  );
  assert.equal(gatewayInputs.length, 2);
});

test("llm role response generator appends timeout closeout from explicit follow-up goal even when prior timeout JSON is absent", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-continue", "sessions_send", {
        session_key: "worker:explore:task-1:toolu-timeout",
        message:
          "Resume the existing source-check context and explain whether the earlier timeout still limits the conclusion.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: [
        "Verified facts: the resumed source returned HTTP 200 with source-backed evidence.",
        "Risk: runbook gap before launch approval.",
        "Recommendation: complete rollback rehearsal before release gate.",
      ].join("\n"),
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
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
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Resumed source evidence returned HTTP 200.",
          final_content:
            "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "Separate verified facts from unverified items, describe any residual risk, and explain whether the earlier timeout still limits the conclusion.",
      ].join("\n"),
    },
  });

  assert.match(
    result.content,
    /Timeout closeout: the resumed source produced source-backed evidence/,
  );
  assert.match(result.content, /\bContinue or retry\b/);
  assert.ok(gatewayInputs.length >= 2);
});

test("llm role response generator forces sessions_send for explicit continuation when the model answers directly", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return {
        text: "I can continue from the prior timeout without another tool.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Final answer after forced session continuation.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task-1:toolu-timeout",
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-timeout",
          agent_id: "explore",
          status: "completed",
          result: "Continuation evidence from the timed-out session.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission and finish the release-risk note.",
        "",
        "Recent turns:",
        "[user] Continue from the slow-source attempt in this mission and finish the release-risk note.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"timeout","session_key":"worker:explore:task-1:toolu-timeout","agent_id":"explore","result":"WORKER_TIMEOUT","resumable":true}',
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    [
      "Final answer after forced session continuation.",
      "",
      "Timeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
    ].join("\n"),
  );
  assert.ok(executedCalls.length <= 2);
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.match(
    String(executedCalls[0]?.input.message),
    /Continuation context from the original task/,
  );
  assert.match(String(executedCalls[0]?.input.message), /release-risk note/);
  assert.match(String(executedCalls[0]?.input.message), /decision criteria/);
});

test("llm role response generator forces session lookup when explicit continuation answers directly without a key", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:explore:task-source:toolu-timeout";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return {
        text: "I can summarize the prior attempt.",
        toolCalls: [],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return {
        text: "I can summarize after listing sessions.",
        toolCalls: [],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Final timeout follow-up from resumed session.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: sessionKey,
                status: "timeout",
                agent_id: "explore",
                label: "slow-source source-check",
                last_active_at: 10,
              },
            ],
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-source",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: "Slow source completed after resume.",
          final_content:
            "Verified slow-source evidence after resume. Risk remains source-bounded.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified slow-source evidence after resume. Risk remains source-bounded.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible and explain whether the earlier timeout still limits the conclusion.",
        "",
        "Recent turns:",
        "[user] Continue from the slow-source attempt in this mission.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    [
      "Final timeout follow-up from resumed session.",
      "",
      "Timeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
      "",
      "Unverified scope: production-equivalent release health and any source facts beyond the recovered result remain unverified.",
    ].join("\n"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator rewrites history lookup to sessions_send for resumable continuation", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:explore:task-source:toolu-timeout";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-list", "sessions_list", {
        agent_id: "explore",
        limit: 5,
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-history", "sessions_history", {
        session_key: sessionKey,
        tail: true,
      });
    }
    return textResult("Final answer after rewritten continuation.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "sessions_history",
          description: "Read session history",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "sessions_send",
          description: "Continue a session",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: sessionKey,
                status: "resumable",
                agent_id: "explore",
                label: "slow-source source-check",
                last_active_at: 10,
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, sessionKey);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-source",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Resumed source evidence.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible and explain whether the earlier timeout still limits the conclusion.",
        "",
        "Recent turns:",
        "[user] Continue from the slow-source attempt in this mission.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator recognizes verbatim latest user direction as session continuation", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:explore:task-alpha:toolu-alpha";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length < 2 && input.toolChoice !== "none") {
      return toolCallResult(`toolu-spawn-${executedCalls.length}`, "sessions_spawn", {
        agent_id: "explore",
        task: "Start a fresh Vendor Alpha research pass.",
      });
    }
    return textResult("Final decision note from the continued Vendor Alpha research thread.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        {
          name: "sessions_spawn",
          description: "Start a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              task: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: sessionKey,
                status: "completed",
                agent_id: "explore",
                label: "Vendor Alpha pricing strength risk research",
                last_active_at: 20,
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, sessionKey);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-alpha",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Vendor Alpha decision note continued from prior evidence.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Original user goal (verbatim):",
        "Start a source-backed review of Vendor Alpha for a product lead.",
        "",
        "Latest user direction (verbatim):",
        "Continue from the previous work on this mission.",
        "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
        "Keep continuity with that earlier research thread rather than starting the same Vendor Alpha work from scratch.",
        "",
        "The goal above is binding: honor every explicit requirement it states.",
        "",
        "Task brief:",
        "Continue the mission.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator prefers latest verbatim direction over original future follow-up text", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:explore:task-slow:toolu-timeout";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-spawn", "sessions_spawn", {
        agent_id: "explore",
        task: "Start a duplicate slow-source check.",
      });
    }
    return textResult("Final release-risk note from continued slow source.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        {
          name: "sessions_spawn",
          description: "Start a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              task: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, sessionKey);
      assert.match(String(input.call.input.message), /Continue from the slow-source attempt/i);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-slow",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Slow source resumed and completed.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Original user goal (verbatim):",
        "Evaluate this slow source for a release-risk note.",
        "A follow-up may ask you to resume that same source-check context after the initial closeout.",
        "",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-slow",
          session_key: sessionKey,
          agent_id: "explore",
          status: "timeout",
          resumable: true,
          result: "WORKER_TIMEOUT",
        }),
        "",
        "Latest user direction (verbatim):",
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "",
        "The goal above is binding: honor every explicit requirement it states.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator rewrites explicit continuation history reads to sessions_send", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:browser:task:TASK-timeout:call_function_slow_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-history-instead-of-send", "sessions_history", {
        session_key: sessionKey,
        tail: true,
        limit: 5,
      });
    }
    return textResult("Final answer from resumed source-check evidence.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_history",
          description: "Read session history",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, sessionKey);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: sessionKey,
          agent_id: "browser",
          status: "completed",
          result: "Resumed slow-source evidence.",
          final_content: "The resumed source-check produced source-backed evidence.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator preserves explicit transcript history reads", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:browser:task:TASK-timeout:call_function_slow_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-history-transcript", "sessions_history", {
        session_key: sessionKey,
        tail: true,
        limit: 5,
      });
    }
    return textResult("Here is the requested session history summary.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_history",
          description: "Read session history",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_history");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          session_key: sessionKey,
          total_messages: 3,
          messages: ["history"],
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Show the full session history for the previous slow-source attempt.",
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_history"],
  );
});

test("llm role response generator repairs recovered slow-source finals that omit timeout follow-up guidance", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const repairPrompts: string[] = [];
  const sessionKey = "worker:explore:task-slow:toolu-timeout";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-send", "sessions_send", {
        session_key: sessionKey,
        message: "Resume the same slow source-check context.",
      });
    }
    if (gatewayInputs.length === 2) {
      return textResult(
        [
          "The explore session recovered with verified content.",
          "Verified owner: Release Captain.",
          "Verified risk: runbook gap before launch approval.",
          "Mitigation: complete rollback rehearsal before release gate.",
          "No additional source checks needed; mission complete.",
        ].join("\n"),
      );
    }
    repairPrompts.push(
      input.messages.map((message) => readToolContent(message.content)).join("\n\n"),
    );
    return textResult(
      [
        "The slow-source check recovered after the earlier timeout.",
        "Verified owner: Release Captain.",
        "Verified risk: runbook gap before launch approval.",
        "Mitigation: complete rollback rehearsal before release gate.",
        "Continuation guidance: continue or retry the same source-check with a bounded timeout, or run a subsequent health check if more release-gated evidence is required.",
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-slow",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result:
            "Timeout recovery completed. Source: slow fixture. Verified owner: Release Captain. Verified risk: runbook gap before launch approval. Mitigation: complete rollback rehearsal before release gate.",
          final_content:
            "Timeout recovery completed. Source: slow fixture. Verified owner: Release Captain. Verified risk: runbook gap before launch approval. Mitigation: complete rollback rehearsal before release gate.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Evaluate this slow source for a release-risk note.",
        "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
        "A follow-up may ask you to resume that same source-check context after the initial closeout.",
      ].join("\n"),
    },
  });

  assert.ok(
    repairPrompts.some((prompt) =>
      /timeout follow-up final omitted recovery guidance/.test(prompt),
    ),
  );
  assert.ok(gatewayInputs.length >= 3);
  assert.match(result.content, /Unverified scope/i);
  assert.match(result.content, /remain unverified/i);
  assert.match(result.content, /Continuation guidance/i);
  assert.match(result.content, /bounded timeout/i);
});

test("llm role response generator deterministically appends timeout follow-up continuation guidance when repair is ignored", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const repairPrompts: string[] = [];
  const sessionKey = "worker:explore:task-slow:toolu-timeout";
  const stubbornFinal = [
    "## Release-Risk Note",
    "Verified facts: HTTP Status 200; Title TurnkeyAI Slow Mission E2E Fixture; Owner Release Captain; Risk runbook gap before launch approval; Mitigation complete rollback rehearsal before release gate.",
    "Unverified items: actual response latency, content freshness, and fixture uptime are not verified.",
    "Residual risk: the earlier timeout does not limit the conclusion now that the source responded.",
    "Next Action: Owner Release Captain should gate release approval pending rollback rehearsal.",
  ].join("\n");
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-send", "sessions_send", {
        session_key: sessionKey,
        message:
          "Resume the existing source-check context if possible and turn the outcome into a release-risk note.",
      });
    }
    if (gatewayInputs.length > 2) {
      repairPrompts.push(
        input.messages
          .map((message) => readToolContent(message.content))
          .join("\n\n"),
      );
    }
    return textResult(stubbornFinal);
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      assert.equal(input.call.name, "sessions_send");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-slow",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result:
            "Timeout recovery completed. Source: http://127.0.0.1:49152/slow-fixture. HTTP Status 200. Title TurnkeyAI Slow Mission E2E Fixture. Owner Release Captain. Risk runbook gap before launch approval. Mitigation complete rollback rehearsal before release gate.",
          final_content:
            "Timeout recovery completed after earlier timeout. Source: http://127.0.0.1:49152/slow-fixture. HTTP Status 200. Title TurnkeyAI Slow Mission E2E Fixture. Owner Release Captain. Risk runbook gap before launch approval. Mitigation complete rollback rehearsal before release gate.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "Separate verified facts from unverified items, describe any residual risk, and explain whether the earlier timeout still limits the conclusion.",
      ].join("\n"),
    },
  });

  assert.ok(
    repairPrompts.some((prompt) =>
      /timeout follow-up final omitted recovery guidance/.test(prompt),
    ),
  );
  assert.equal(gatewayInputs.length, 3);
  assert.match(result.content, /earlier timeout does not limit the conclusion/i);
  assert.match(result.content, /Continuation guidance/i);
  assert.match(result.content, /continue or retry the same source-check/i);
});

test("llm role response generator routes continuation follow-up to cancelled session", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-cancel-continue", "sessions_spawn", {
        agent_id: "explore",
        task: "Resume the cancelled source check and report what can be verified now.",
        timeout_seconds: 120,
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Final answer from cancelled-session continuation.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: input.call.input.session_key,
          agent_id: "explore",
          status: "completed",
          result: "Cancelled session resumed with source evidence.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the cancelled source-check attempt in this mission.",
        "",
        "Recent turns:",
        "[user] Continue from the cancelled source-check attempt in this mission.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:explore:task-1:toolu-cancelled","agent_id":"explore","result":"operator cancelled active source verification"}',
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from cancelled-session continuation.",
  );
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.equal(
    executedCalls[0]?.input.session_key,
    "worker:explore:task-1:toolu-cancelled",
  );
  assert.equal(executedCalls[0]?.input.timeout_seconds, undefined);
  assert.ok(executedCalls.length <= 2);
  assert.equal(gatewayInputs.length, 2);
  assert.match(
    readToolContent(gatewayInputs[1]!.messages.at(-1)!.content),
    /completed delegated session evidence/i,
  );
  assert.match(
    readToolContent(gatewayInputs[1]!.messages.at(-1)!.content),
    /cover every source/i,
  );
  assert.match(
    readToolContent(gatewayInputs[1]!.messages.at(-1)!.content),
    /Cancelled session resumed with source evidence/,
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_send");
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
});

test("llm role response generator routes explicit follow-up to completed session", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-recheck", "sessions_spawn", {
        agent_id: "browser",
        task: "Re-check the dashboard and report the current state.",
        label: "dashboard re-check",
      });
    }
    return {
      text: "Final answer from completed-session continuation.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-dashboard",
          session_key: input.call.input.session_key,
          agent_id: "browser",
          status: "completed",
          result: "Dashboard session continued.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review from before the daemon restart.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review from before the daemon restart.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"completed","session_key":"worker:browser:task-dashboard:toolu-browser","agent_id":"browser","result":"Queue depth: 11; SLA breaches: 3; owner: Incident Commander"}',
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from completed-session continuation.",
  );
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.equal(
    executedCalls[0]?.input.session_key,
    "worker:browser:task-dashboard:toolu-browser",
  );
  assert.match(
    String(executedCalls[0]?.input.message),
    /Continuation context from the original task/,
  );
  assert.match(
    String(executedCalls[0]?.input.message),
    /operations dashboard review/,
  );
  assert.match(String(executedCalls[0]?.input.message), /decision criteria/);
  assert.match(
    readToolContent(gatewayInputs[0]!.messages[1]!.content),
    /Runtime session continuation directive/,
  );
});

test("llm role response generator lists sessions before spawning on explicit follow-up without a session key", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-would-duplicate", "sessions_spawn", {
        agent_id: "browser",
        task: "Re-check the operations dashboard from the same browser context.",
        label: "ops-dashboard-followup",
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-after-list", "sessions_spawn", {
        agent_id: "browser",
        task: "Re-check the operations dashboard from the same browser context.",
        label: "ops-dashboard-followup",
      });
    }
    return {
      text: "Final answer from looked-up browser continuation.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: {
              kinds: { type: "array" },
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        assert.equal(input.call.input.agent_id, "browser");
        assert.deepEqual(input.call.input.kinds, ["browser"]);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: "worker:browser:task-dashboard:toolu-browser",
                agent_id: "browser",
                status: "done",
                label: "ops-dashboard-review",
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(
        input.call.input.session_key,
        "worker:browser:task-dashboard:toolu-browser",
      );
      assert.match(
        String(input.call.input.message),
        /Re-check the operations dashboard/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-dashboard",
          session_key: input.call.input.session_key,
          agent_id: "browser",
          status: "completed",
          result: "Dashboard session continued after forced lookup.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review from the browser context already used in this mission.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review from the browser context already used in this mission.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from looked-up browser continuation.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator continues failed source-check sessions found by session list", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-would-duplicate", "sessions_spawn", {
        agent_id: "explore",
        task: "Re-check the cancelled source-check context.",
        label: "release-risk-source-check",
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-after-list", "sessions_spawn", {
        agent_id: "explore",
        task: "Re-check the cancelled source-check context.",
        label: "release-risk-source-check",
      });
    }
    return {
      text: "Final answer from failed source-check continuation.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: "worker:explore:task-source:toolu-cancelled",
                agent_id: "explore",
                status: "failed",
                label: "release-risk-source-check",
                last_error: "operator cancelled active source verification",
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task-source:toolu-cancelled",
      );
      assert.match(String(input.call.input.message), /cancelled source-check/i);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-source",
          session_key: input.call.input.session_key,
          agent_id: "explore",
          status: "completed",
          result: "Failed source-check session continued after forced lookup.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the cancelled source-check attempt in this mission.",
        "Resume the existing source-check context if possible and finish the release-risk note.",
        "",
        "Recent turns:",
        "[user] Continue from the cancelled source-check attempt in this mission.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from failed source-check continuation.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator drops same-round duplicate spawn when sending continuation", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return {
        text: "",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
        toolCalls: [
          {
            id: "toolu-send",
            name: "sessions_send",
            input: {
              session_key: "worker:browser:task-dashboard:toolu-browser",
              message: "Continue the dashboard review.",
            },
          },
          {
            id: "toolu-duplicate",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Continue the dashboard review.",
            },
          },
        ],
      };
    }
    return {
      text: "Final answer after send only.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          session_key: input.call.input.session_key,
          agent_id: "browser",
          status: "completed",
          result: "Continued.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"completed","session_key":"worker:browser:task-dashboard:toolu-browser","agent_id":"browser","result":"Dashboard evidence."}',
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer after send only.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator allows a new spawn after an empty continuation session lookup", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length < 2 && input.toolChoice !== "none") {
      return toolCallResult(
        `toolu-${executedCalls.length + 1}`,
        "sessions_spawn",
        {
          agent_id: "browser",
          task: "Start a fresh dashboard check because no existing session is available.",
        },
      );
    }
    return {
      text: "Final answer after fresh browser session.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: {
              kinds: { type: "array" },
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ sessions: [] }),
        };
      }
      assert.equal(input.call.name, "sessions_spawn");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-dashboard",
          session_key: "worker:browser:fresh",
          agent_id: "browser",
          status: "completed",
          result: "Fresh dashboard session completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review from the previous browser context if one exists.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review from the previous browser context if one exists.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer after fresh browser session.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_spawn"],
  );
});

test("llm role response generator drops same-round duplicate spawn when listing continuation sessions", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return {
        text: "",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
        toolCalls: [
          {
            id: "toolu-list",
            name: "sessions_list",
            input: { agent_id: "browser" },
          },
          {
            id: "toolu-duplicate",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Continue the dashboard review.",
            },
          },
        ],
      };
    }
    return {
      text: "Final answer after list only.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_list");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ sessions: [] }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review from the previous browser context if one exists.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review from the previous browser context if one exists.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer after list only.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list"],
  );
});

test("llm role response generator routes follow-up through sessions_list result before duplicate spawn", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-list", "sessions_list", {
        kinds: ["browser"],
        limit: 5,
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-duplicate", "sessions_spawn", {
        agent_id: "browser",
        task: "Recover and re-render the operations dashboard. Submit the findings to the operator as a read-only report.",
        label: "ops-dashboard-recovery",
      });
    }
    return {
      text: "Final answer from listed-session continuation.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { kinds: { type: "array" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: "worker:browser:task-dashboard:toolu-browser",
                agent_id: "browser",
                status: "done",
                label: "ops-dashboard-review",
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(
        input.call.input.session_key,
        "worker:browser:task-dashboard:toolu-browser",
      );
      assert.match(String(input.call.input.message), /Recover and re-render/);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-dashboard",
          session_key: input.call.input.session_key,
          agent_id: "browser",
          status: "completed",
          result: "Dashboard session continued after list lookup.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review from the same browser-backed work.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review from the same browser-backed work.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from listed-session continuation.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator routes listed follow-up local fetch through sessions_send", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey =
    "worker:explore:task:TASK-ALPHA:call_function_vendor_alpha";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-list", "sessions_list", {
        limit: 5,
        agent_id: "explore",
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-local-fetch", "web_fetch", {
        url: "http://127.0.0.1:53499/vendor-alpha",
        purpose:
          "Revisit the Vendor Alpha source and turn the evidence into a decision note.",
      });
    }
    return {
      text: "Final decision note from continued Vendor Alpha session.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number" },
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "web_fetch",
          description: "Fetch a URL",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: sessionKey,
                agent_id: "explore",
                status: "done",
                label: "Vendor Alpha review",
                last_active_at: 10,
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, sessionKey);
      assert.match(String(input.call.input.message), /Vendor Alpha|local\/private URL/);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-ALPHA",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Vendor Alpha session continued.",
          final_content: "Vendor Alpha session continued.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the previous work on this mission.",
        "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
        "Keep continuity with that earlier research thread rather than starting the same Vendor Alpha work from scratch.",
        "Source: http://127.0.0.1:53499/vendor-alpha",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final decision note from continued Vendor Alpha session.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator normalizes session update aliases into sessions_send", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:explore:task:TASK-1:call_function_vendor_alpha_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-update", "sessions_update", {
        update:
          "Revisit the Vendor Alpha notes and turn them into a product decision note.",
      });
    }
    return {
      text: "Final answer from normalized session update continuation.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, sessionKey);
      assert.match(String(input.call.input.message), /Vendor Alpha notes/);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Vendor Alpha decision note completed.",
          final_content: "Vendor Alpha decision note completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: sessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Vendor Alpha research completed.",
          final_content: "Pricing, strength, and risk evidence collected.",
        }),
        "[user]: Continue from the previous Vendor Alpha research thread.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from normalized session update continuation.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator prefers the subject-matched completed session for continuation", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const alphaSessionKey =
    "worker:explore:task:TASK-alpha:call_function_vendor_alpha_1";
  const betaSessionKey =
    "worker:explore:task:TASK-beta:call_function_vendor_beta_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-update", "sessions_update", {
        update:
          "Revisit the Vendor Alpha notes and turn the evidence into a decision note for a product lead.",
      });
    }
    return {
      text: "Final answer from subject-matched continuation.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, alphaSessionKey);
      assert.match(String(input.call.input.message), /Vendor Alpha notes/);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-alpha",
          session_key: alphaSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Vendor Alpha decision note completed.",
          final_content: "Vendor Alpha decision note completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-alpha",
          session_key: alphaSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Vendor Alpha research completed.",
          final_content:
            "Vendor Alpha pricing, strength, and risk evidence collected.",
        }),
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-beta",
          session_key: betaSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Vendor Beta research completed.",
          final_content:
            "Vendor Beta pricing, strength, and risk evidence collected.",
        }),
        "[user]: Continue from the previous work on this mission.",
        "[user]: Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
        "[user]: Keep continuity with that earlier research thread rather than starting the same Vendor Alpha work from scratch.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from subject-matched continuation.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator does not continue explore sessions for rendered-browser recovery", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const exploreSessionKey =
    "worker:explore:task:TASK-route:call_function_route_1";
  const browserSessionKey =
    "worker:browser:task:TASK-live:call_function_live_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-update", "sessions_update", {
        update:
          "Continue the original mission and verify the missing rendered browser evidence.",
      });
    }
    return {
      text: "Final answer from rendered browser recovery.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, browserSessionKey);
      assert.match(String(input.call.input.message), /rendered browser evidence/i);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-live",
          session_key: browserSessionKey,
          agent_id: "browser",
          status: "completed",
          result:
            "AsiaWalk live readiness browser evidence completed: TURNKEYAI_ASIAWALK_LIVE_OK, readiness yellow, rain risk in Taipei, metro maintenance in Tokyo.",
          final_content:
            "AsiaWalk live readiness browser evidence completed: TURNKEYAI_ASIAWALK_LIVE_OK, readiness yellow, rain risk in Taipei, metro maintenance in Tokyo.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Original user goal (verbatim):",
        "Natural AsiaWalk multi-agent planning brief",
        "Route source: http://127.0.0.1:54581/asiawalk-route",
        "Budget source: http://127.0.0.1:54581/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1:54581/asiawalk-live",
        "",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-route",
          session_key: exploreSessionKey,
          agent_id: "explore",
          status: "completed",
          result:
            "AsiaWalk route evidence completed, but this is not rendered browser evidence.",
          final_content:
            "AsiaWalk route evidence completed, but this is not rendered browser evidence.",
        }),
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-live",
          session_key: browserSessionKey,
          agent_id: "browser",
          status: "completed",
          result:
            "AsiaWalk live readiness rendered browser evidence completed.",
          final_content:
            "AsiaWalk live readiness rendered browser evidence completed.",
        }),
        "Latest user direction (verbatim):",
        "System recovery: the previous final answer did not satisfy required goal slots.",
        "Continue the original mission instead of closing it. Use available tools to verify only the missing or unverified core slots requested by the original mission: rendered browser evidence (missing).",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer from rendered browser recovery.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator prefers earliest completed session for previous-thread continuation ties", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const firstSessionKey =
    "worker:explore:task:TASK-first:call_function_original_1";
  const laterSessionKey =
    "worker:explore:task:TASK-later:call_function_later_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-update", "sessions_update", {
        update:
          "Revisit the earlier research notes and turn the evidence into a decision note.",
      });
    }
    return {
      text: "Final answer from earliest continuation.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, firstSessionKey);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-first",
          session_key: firstSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Decision note completed.",
          final_content: "Decision note completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-first",
          session_key: firstSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Initial research completed.",
          final_content: "Initial evidence collected.",
        }),
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-later",
          session_key: laterSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Later supplemental research completed.",
          final_content: "Later supplemental evidence collected.",
        }),
        "[user]: Continue from the previous work on this mission.",
        "[user]: Ask the same earlier research thread to revisit its notes and turn the evidence into a decision note.",
        "[user]: Keep continuity with that earlier research thread rather than starting the same work from scratch.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer from earliest continuation.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator lists sessions before trusting model-provided continuation keys without a directive", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-1:call_function_timeout_1";
  const browserSessionKey =
    "worker:browser:task:TASK-1:call_function_browser_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-wrong-send-first", "sessions_send", {
        session_key: browserSessionKey,
        message: "Continue the browser sibling.",
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-wrong-send-second", "sessions_send", {
        session_key: browserSessionKey,
        message: "Continue the browser sibling after listing.",
      });
    }
    return {
      text: "Final answer from corrected timeout continuation.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: timeoutSessionKey,
                agent_id: "explore",
                status: "timeout",
                resumable: true,
                label: "slow-source attempt",
              },
              {
                session_key: browserSessionKey,
                agent_id: "browser",
                status: "completed",
                label: "browser sibling",
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, timeoutSessionKey);
      assert.match(
        String(input.call.input.message),
        /Continue the browser sibling after listing/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: timeoutSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Corrected timeout session completed.",
          final_content: "Corrected timeout session completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission and finish the release-risk note.",
        "",
        "Recent turns:",
        "[user] Continue from the slow-source attempt in this mission and finish the release-risk note.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from corrected timeout continuation.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator does not continue completed sibling when timeout-like follow-up lacks timeout result JSON", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-2:call_function_timeout_1";
  const browserSessionKey =
    "worker:browser:task:TASK-2:call_function_browser_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-wrong-browser-send", "sessions_send", {
        session_key: browserSessionKey,
        message: "Continue the browser sibling.",
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-still-browser-send", "sessions_send", {
        session_key: browserSessionKey,
        message: "Finish the slow-source release-risk note.",
      });
    }
    return {
      text: "Final answer from timeout source continuation.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: timeoutSessionKey,
                agent_id: "explore",
                status: "timeout",
                resumable: true,
                label: "slow-source attempt",
              },
              {
                session_key: browserSessionKey,
                agent_id: "browser",
                status: "completed",
                label: "rendered sibling",
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, timeoutSessionKey);
      assert.match(
        String(input.call.input.message),
        /slow-source release-risk note/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: timeoutSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Timeout source continuation completed.",
          final_content: "Timeout source continuation completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Evaluate a slow source for a release-risk note. The earlier attempt timed out and the mission can continue.",
        "",
        "Recent turns:",
        "[tool] Slow-source attempt timed out after the bounded attempt; continue is available.",
        `[tool] ${JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          session_key: browserSessionKey,
          agent_id: "browser",
          result: "Browser sibling completed.",
        })}`,
        "[user] Continue from the slow-source attempt in this mission and finish the release-risk note.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from timeout source continuation.",
  );
  const sendCalls = executedCalls.filter((call) => call.name === "sessions_send");
  assert.ok(sendCalls.length >= 1);
  assert.ok(
    sendCalls.every((call) => call.input.session_key === timeoutSessionKey),
  );
});

test("llm role response generator prefers explicit timeout closeout session over stale listed sibling", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-3:call_function_timeout_1";
  const browserSessionKey =
    "worker:browser:task:TASK-3:call_function_browser_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-stale-browser-send", "sessions_send", {
        session_key: browserSessionKey,
        message: "Continue the stale browser sibling.",
      });
    }
    return {
      text: "Final answer from explicit timeout source continuation.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, timeoutSessionKey);
      assert.match(String(input.call.input.message), /stale browser sibling/);
      assert.match(
        String(input.call.input.message),
        /Runtime continuity guard/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: timeoutSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Explicit timeout session continued.",
          final_content: "Explicit timeout session continued.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "<relay_brief>",
        "[sessions_list]: {",
        '"sessions": [',
        "{",
        `"session_key": "${browserSessionKey}",`,
        '"agent_id": "browser",',
        '"status": "resumable",',
        '"label": "slow-fixture-release-risk"',
        "}",
        "]",
        "}",
        "[Lead]:",
        "[sessions_spawn]: {",
        '"status": "timeout",',
        '"agent_id": "explore",',
        '"label": "slow-fixture-fetch",',
        '"session_key": "worker:explore:task:TASK-3:call_function_timeout_…"',
        "}",
        `[Lead]: **Release-Risk Note:** Bounded attempt result: Timeout after 15 seconds. Mission can continue: Resume the same source-check session (\`slow-fixture-fetch\`, \`${timeoutSessionKey}\`) if the evidence is still worth waiting for.`,
        "[user]: Continue from the slow-source attempt in this mission.",
        "</relay_brief>",
        "Thread summary:",
        "Goal: Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "Separate verified facts from unverified items, describe residual risk, and explain whether the earlier timeout still limits the conclusion.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    [
      "Final answer from explicit timeout source continuation.",
      "",
      "Timeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
      "",
      "Unverified scope: production-equivalent release health and any source facts beyond the recovered result remain unverified.",
    ].join("\n"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
});

test("llm role response generator adds a browser probe after content-poor resumed loopback timeout evidence", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gatewayInputs: GenerateTextInput[] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-slow:call_function_timeout_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (input.toolChoice !== "none" && executedCalls.length === 0) {
      return toolCallResult("toolu-resume-timeout", "sessions_send", {
        session_key: timeoutSessionKey,
        message:
          "Continue the existing slow-source release-risk check for http://127.0.0.1:49152/slow-fixture.",
      });
    }
    if (input.toolChoice !== "none" && executedCalls.length === 1) {
      assert.match(
        readMessageContentTextForTest(input.messages.at(-1)?.content ?? ""),
        /content-poor/i,
      );
      return toolCallResult("toolu-browser-probe", "sessions_spawn", {
        agent_id: "browser",
        label: "supplemental local slow-source probe",
        task: [
          "Use the browser worker for browser-visible/local runtime evidence.",
          "Open http://127.0.0.1:49152/slow-fixture as an operator would see it and return observed status/title/visible marker evidence.",
        ].join("\n"),
      });
    }
    return {
      text: "Final release-risk note: browser probe verified TURNKEYAI_MISSION_FIXTURE_OK; earlier timeout no longer blocks the source-bounded conclusion.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string", enum: ["browser", "explore"] },
              label: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_send") {
        assert.equal(input.call.input.session_key, timeoutSessionKey);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-timeout",
            session_key: timeoutSessionKey,
            agent_id: "explore",
            status: "completed",
            tool_chain: ["explore"],
            result: "The resumed slow-source attempt timed out again.",
            final_content: [
              "Source: http://127.0.0.1:49152/slow-fixture.",
              "Verified facts: the bounded resumed attempt timed out.",
              "No HTTP status code was obtained.",
              "No response headers were retrieved.",
              "No response body was retrieved.",
              "Unverified items: release-risk content remains unavailable.",
            ].join(" "),
            payload: {
              mode: "llm_sub_agent",
              workerType: "explore",
              content: [
                "Source: http://127.0.0.1:49152/slow-fixture.",
                "Verified facts: the bounded resumed attempt timed out.",
                "No HTTP status code was obtained.",
                "No response headers were retrieved.",
                "No response body was retrieved.",
                "Unverified items: release-risk content remains unavailable.",
              ].join(" "),
            },
          }),
        };
      }
      assert.equal(input.call.name, "sessions_spawn");
      assert.equal(input.call.input.agent_id, "browser");
      assert.equal(input.call.input.timeout_seconds, 45);
      assert.match(
        String(input.call.input.task),
        /browser-visible\/local runtime evidence/i,
      );
      assert.match(
        String(input.call.input.task),
        /browser_open with timeout_ms 10000/i,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser-probe",
          session_key: "worker:browser:task-browser-probe:toolu-browser-probe",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser local probe reached the fixture.",
          evidence_summary:
            "Final URL http://127.0.0.1:49152/slow-fixture; page title TurnkeyAI Slow Mission E2E Fixture; visible marker TURNKEYAI_MISSION_FIXTURE_OK; no console errors observed.",
          final_content:
            "Browser local probe verified page title TurnkeyAI Slow Mission E2E Fixture and visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Browser local probe verified page title TurnkeyAI Slow Mission E2E Fixture and visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "Separate verified facts from unverified items, describe residual risk, and explain whether the earlier timeout still limits the conclusion.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /TURNKEYAI_MISSION_FIXTURE_OK/);
  assert.deepEqual(
    executedCalls.map((call) => [
      call.name,
      call.input.agent_id ?? call.input.session_key,
    ]),
    [
      ["sessions_send", timeoutSessionKey],
      ["sessions_spawn", "browser"],
    ],
  );
  assert.ok(
    gatewayInputs.some((input) =>
      readMessageContentTextForTest(
        input.messages.at(-1)?.content ?? "",
      ).includes(
        "Runtime correction: resumed timeout evidence is still content-poor.",
      ),
    ),
  );
});

test("llm role response generator adds a browser probe when resumed loopback session times out again", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-slow-again:call_function_timeout_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (input.toolChoice !== "none" && executedCalls.length === 0) {
      return toolCallResult("toolu-resume-timeout-again", "sessions_send", {
        session_key: timeoutSessionKey,
        message:
          "Resume the slow-source check on http://127.0.0.1:49152/slow-fixture.",
      });
    }
    if (input.toolChoice !== "none" && executedCalls.length === 1) {
      assert.match(
        readMessageContentTextForTest(input.messages.at(-1)?.content ?? ""),
        /content-poor/i,
      );
      return toolCallResult("toolu-wrong-send-timeout-again", "sessions_send", {
        session_key: timeoutSessionKey,
        message:
          "Navigate to http://127.0.0.1:49152/slow-fixture in a browser and report visible evidence. Do not retry.",
      });
    }
    return {
      text: "Final release-risk note: supplemental browser probe verified visible marker TURNKEYAI_MISSION_FIXTURE_OK after the resumed timeout.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string", enum: ["browser", "explore"] },
              label: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_send") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          isError: true,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-timeout-again",
            session_key: timeoutSessionKey,
            agent_id: "explore",
            status: "timeout",
            resumable: true,
            timeout_seconds: 20,
            evidence_available: true,
            evidence_summary:
              "Execution paused before completion. Reason: sessions_send timed out after 20s.",
            tool_chain: [],
            result:
              "Sub-agent session timed out after 20s. Current evidence summary: Execution paused before completion. Reason: sessions_send timed out after 20s.",
            final_content: null,
            payload: null,
          }),
        };
      }
      assert.equal(input.call.name, "sessions_spawn");
      assert.equal(input.call.input.agent_id, "browser");
      assert.equal(input.call.input.timeout_seconds, 45);
      assert.doesNotMatch(
        String(input.call.input.task),
        /Spawn exactly one focused browser session now/i,
      );
      assert.match(
        String(input.call.input.task),
        /browser_open with timeout_ms 10000/i,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser-probe-timeout-again",
          session_key:
            "worker:browser:task-browser-probe-timeout-again:toolu-browser-probe",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser local probe reached the fixture.",
          evidence_summary:
            "Final URL http://127.0.0.1:49152/slow-fixture; page title TurnkeyAI Slow Mission E2E Fixture; visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
          final_content:
            "Browser local probe verified page title TurnkeyAI Slow Mission E2E Fixture and visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Browser local probe verified page title TurnkeyAI Slow Mission E2E Fixture and visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Slow source: http://127.0.0.1:49152/slow-fixture",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "Separate verified facts from unverified items, describe residual risk, and explain whether the earlier timeout still limits the conclusion.",
        "",
        "Recent tool context:",
        `[tool] ${JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "timeout",
          session_key: timeoutSessionKey,
          agent_id: "explore",
          result: "WORKER_TIMEOUT",
          resumable: true,
          evidence_summary:
            "No usable evidence was gathered before the timeout.",
        })}`,
        "[user]: Continue from the slow-source attempt in this mission.",
      ].join("\n"),
      capabilityInspection: {
        availableWorkers: ["explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.match(result.content, /TURNKEYAI_MISSION_FIXTURE_OK/);
  assert.deepEqual(
    executedCalls.map((call) => [
      call.name,
      call.input.agent_id ?? call.input.session_key,
    ]),
    [
      ["sessions_send", timeoutSessionKey],
      ["sessions_spawn", "browser"],
    ],
  );
});

test("llm role response generator does not browser-probe content-poor timeout when browser evidence is explicitly not requested", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-non-browser-slow:call_function_timeout_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (input.toolChoice !== "none" && executedCalls.length === 0) {
      return toolCallResult("toolu-resume-non-browser-timeout", "sessions_send", {
        session_key: timeoutSessionKey,
        message:
          "Resume the slow-source check on http://127.0.0.1:49152/slow-fixture. Browser-visible/rendered evidence was not requested.",
      });
    }
    return {
      text: "Final release-risk note: the bounded continuation timed out again; no HTTP status, headers, body, or release-risk content were verified. Residual risk remains source-bounded and the same source-check can be retried later if release gating requires it.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string", enum: ["browser", "explore"] },
              label: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        isError: true,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-non-browser-timeout",
          session_key: timeoutSessionKey,
          agent_id: "explore",
          status: "timeout",
          resumable: true,
          timeout_seconds: 45,
          evidence_available: true,
          evidence_summary:
            "Execution paused before completion. Browser-visible/rendered evidence was not requested. No HTTP status, headers, or body were retrieved.",
          result:
            "Sub-agent session timed out after 45s. Current evidence summary: no HTTP status, headers, or body were retrieved.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Slow source: http://127.0.0.1:49152/slow-fixture",
        "Browser-visible/rendered evidence was not requested.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
      ].join("\n"),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.match(result.content, /bounded continuation timed out/i);
  assert.doesNotMatch(
    JSON.stringify(executedCalls.map((call) => call.input)),
    /"agent_id":"browser"/,
  );
  assert.equal(
    executedCalls.some((call) => call.name === "sessions_spawn"),
    false,
  );
});

test("llm role response generator probes browser after runtime-forced continuation times out", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-runtime-forced:call_function_timeout_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (input.toolChoice !== "none" && executedCalls.length === 0) {
      return toolCallResult("toolu-list-runtime-forced", "sessions_list", {
        agent_id: "explore",
      });
    }
    if (input.toolChoice !== "none" && executedCalls.length === 1) {
      return {
        text: "I found a resumable session and will answer from the session list.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (input.toolChoice !== "none" && executedCalls.length === 2) {
      assert.match(
        readMessageContentTextForTest(input.messages.at(-1)?.content ?? ""),
        /content-poor/i,
      );
      return toolCallResult(
        "toolu-wrong-send-after-runtime-forced-timeout",
        "sessions_send",
        {
          session_key: timeoutSessionKey,
          message:
            "Open http://127.0.0.1:49152/slow-fixture in a browser and report visible evidence. Do not retry.",
        },
      );
    }
    return {
      text: "Final release-risk note: supplemental browser probe verified visible marker TURNKEYAI_MISSION_FIXTURE_OK after the runtime-forced continuation timeout.",
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
          name: "sessions_list",
          description: "List sub-agent sessions",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string", enum: ["browser", "explore"] },
              label: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: timeoutSessionKey,
                agent_id: "explore",
                status: "resumable",
                label: "slow-fixture-release-risk",
              },
            ],
          }),
        };
      }
      if (input.call.name === "sessions_send") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          isError: true,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-runtime-forced-timeout",
            session_key: timeoutSessionKey,
            agent_id: "explore",
            status: "timeout",
            resumable: true,
            timeout_seconds: 45,
            evidence_available: true,
            evidence_summary:
              "Execution paused before completion. Reason: sessions_send timed out after 45s.",
            tool_chain: [],
            result:
              "Sub-agent session timed out after 45s. Current evidence summary: Execution paused before completion. Reason: sessions_send timed out after 45s.",
            final_content: null,
            payload: null,
          }),
        };
      }
      assert.equal(input.call.name, "sessions_spawn");
      assert.equal(input.call.input.agent_id, "browser");
      assert.equal(input.call.input.timeout_seconds, 45);
      assert.match(
        String(input.call.input.task),
        /browser-visible\/local runtime evidence/i,
      );
      assert.match(
        String(input.call.input.task),
        /browser_open with timeout_ms 10000/i,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-runtime-forced-browser-probe",
          session_key:
            "worker:browser:task-runtime-forced-browser-probe:toolu-browser-probe",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser local probe reached the fixture.",
          evidence_summary:
            "Final URL http://127.0.0.1:49152/slow-fixture; page title TurnkeyAI Slow Mission E2E Fixture; visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
          final_content:
            "Browser local probe verified page title TurnkeyAI Slow Mission E2E Fixture and visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Browser local probe verified page title TurnkeyAI Slow Mission E2E Fixture and visible marker TURNKEYAI_MISSION_FIXTURE_OK.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "Slow source: http://127.0.0.1:49152/slow-fixture",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
        "[user]: Continue from the slow-source attempt in this mission.",
      ].join("\n"),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.match(result.content, /TURNKEYAI_MISSION_FIXTURE_OK/);
  assert.deepEqual(
    executedCalls.map((call) => [
      call.name,
      call.input.agent_id ?? call.input.session_key,
    ]),
    [
      ["sessions_list", "explore"],
      ["sessions_send", timeoutSessionKey],
      ["sessions_spawn", "browser"],
    ],
  );
});

test("llm role response generator refreshes stale session list when timeout follow-up only has truncated source key", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const timeoutSessionKey =
    "worker:explore:task:TASK-4:call_function_timeout_1";
  const browserSessionKey =
    "worker:browser:task:TASK-4:call_function_browser_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-stale-browser-send-first", "sessions_send", {
        session_key: browserSessionKey,
        message: "Continue the stale browser sibling.",
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult(
        "toolu-stale-browser-send-second",
        "sessions_send",
        {
          session_key: browserSessionKey,
          message: "Continue after refreshing the session list.",
        },
      );
    }
    return {
      text: "Final answer from refreshed timeout source continuation.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number" },
              reason: { type: "string" },
            },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        assert.match(String(input.call.input.reason), /continuation lookup/);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: browserSessionKey,
                agent_id: "browser",
                status: "resumable",
                label: "slow-fixture-release-risk",
                last_active_at: 100,
              },
              {
                session_key: timeoutSessionKey,
                agent_id: "explore",
                status: "resumable",
                label: "slow-fixture-fetch",
                last_active_at: 200,
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, timeoutSessionKey);
      assert.match(
        String(input.call.input.message),
        /refreshing the session list/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: timeoutSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Refreshed timeout source completed.",
          final_content: "Refreshed timeout source completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "<relay_brief>",
        "[sessions_list]: {",
        '"sessions": [',
        "{",
        `"session_key": "${browserSessionKey}",`,
        '"agent_id": "browser",',
        '"status": "resumable",',
        '"label": "slow-fixture-release-risk"',
        "}",
        "]",
        "}",
        "[Lead]:",
        "[sessions_spawn]: {",
        '"status": "timeout",',
        '"agent_id": "explore",',
        '"label": "slow-fixture-fetch",',
        '"session_key": "worker:explore:task:TASK-4:call_function_timeout_…"',
        "}",
        "[Lead]: **Release-Risk Note:** Bounded attempt result: Timeout after 15 seconds. Evidence: the explore worker did not receive a response. Mission can continue by resuming the same source-check session if the evidence is still worth waiting for.",
        "[user]: Continue from the slow-source attempt in this mission.",
        "</relay_brief>",
        "Thread summary:",
        "Goal: Continue from the slow-source attempt in this mission.",
        "Resume the existing source-check context if possible, let it finish with the evidence it can collect, and turn the outcome into a release-risk note.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from refreshed timeout source continuation.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"],
  );
});

test("llm role response generator forces continuation after list resolves a truncated timeout key", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const fullSessionKey =
    "worker:browser:task:TASK-1:call_function_bezmwfxl30as_1";
  const truncatedSessionKey =
    "worker:browser:task:TASK-1:call_function_bezmwfxl";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-history", "sessions_history", {
        session_key: truncatedSessionKey,
        tail: true,
        limit: 20,
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-list", "sessions_list", {
        limit: 10,
      });
    }
    if (executedCalls.length === 2 && input.toolChoice !== "none") {
      return {
        text: "I found the resumable session but can answer directly.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "Final answer from recovered timeout continuation.",
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
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
        },
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_history") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          isError: true,
          content: `session not found: ${input.call.input.session_key}`,
        };
      }
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [
              {
                session_key: fullSessionKey,
                agent_id: "browser",
                status: "resumable",
                label: "slow-fixture-risk-check",
              },
            ],
          }),
        };
      }
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, fullSessionKey);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: fullSessionKey,
          agent_id: "browser",
          status: "completed",
          result: "Recovered slow source evidence.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the slow-source attempt in this mission.",
        "",
        "Recent turns:",
        "[user] Continue from the slow-source attempt in this mission.",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "timeout",
          session_key: truncatedSessionKey,
          agent_id: "browser",
          result: "WORKER_TIMEOUT",
          resumable: true,
        }),
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    [
      "Final answer from recovered timeout continuation.",
      "",
      "Timeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
    ].join("\n"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send", "sessions_list", "sessions_send"],
  );
});

test("llm role response generator ignores nested completed status when session result failed", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length < 2 && input.toolChoice !== "none") {
      return toolCallResult(
        `toolu-new-${executedCalls.length + 1}`,
        "sessions_spawn",
        {
          agent_id: "browser",
          task: "Start a fresh dashboard check.",
        },
      );
    }
    return {
      text: "Final answer after fresh dashboard check.",
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
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: {
              kinds: { type: "array" },
              agent_id: { type: "string" },
            },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ sessions: [] }),
        };
      }
      assert.equal(input.call.name, "sessions_spawn");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed" }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"failed","session_key":"worker:browser:task-dashboard:toolu-browser","agent_id":"browser","payload":{"status":"completed"},"result":"browser unavailable"}',
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_spawn"],
  );
  assert.equal(
    executedCalls.some((call) => call.name === "sessions_send"),
    false,
  );
});

test("llm role response generator routes follow-up when completed session result is wrapped in tool trace content", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-wrapped", "sessions_spawn", {
        agent_id: "browser",
        task: "Re-check the wrapped dashboard session.",
      });
    }
    return {
      text: "Final answer from wrapped completed-session continuation.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({ status: "completed" }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review.",
        "",
        "Recent turns:",
        "[user] Continue the operations dashboard review.",
        JSON.stringify({
          toolName: "sessions_spawn",
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            session_key: "worker:browser:task-dashboard:toolu-wrapped",
            agent_id: "browser",
            result:
              "Queue depth: 11; SLA breaches: 3; owner: Incident Commander",
          }),
        }),
      ].join("\n"),
    },
  });

  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.equal(
    executedCalls[0]?.input.session_key,
    "worker:browser:task-dashboard:toolu-wrapped",
  );
});

test("llm role response generator closes out cancelled sessions without a user follow-up", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-passive-spawn", "sessions_spawn", {
        agent_id: "explore",
        task: "Evaluate the source again.",
      });
    }
    return {
      text: "Final answer after passive cancellation closeout.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:toolu-passive",
          agent_id: "explore",
          status: "completed",
          result: "Passive closeout evidence.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Evaluate this source. If an operator cancels the active source check, close out from the cancellation evidence.",
        "A follow-up may ask you to resume the same source-check context after the initial cancellation.",
        "",
        "Recent turns:",
        "[user] Evaluate this source. If an operator cancels the active source check, close out from the cancellation evidence. A follow-up may ask you to resume the same source-check context after the initial cancellation.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:explore:task-1:toolu-cancelled","agent_id":"explore","result":"operator cancelled active source verification"}',
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer after passive cancellation closeout.",
  );
  assert.deepEqual(executedCalls, []);
});

test("llm role response generator normalizes noisy session_key inputs before execution", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-noisy-send", "sessions_send", {
        session_key:
          "worker:explore:task-1:toolu-cancelled | Natural cancellation follow-up\nOpen questions: {}",
        message: "Continue the cancelled source check.",
      });
    }
    return {
      text: "Final answer from normalized continuation.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task-1:toolu-cancelled",
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: input.call.input.session_key,
          agent_id: "explore",
          status: "completed",
          result: "Noisy key continuation completed.",
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

  assert.equal(result.content, "Final answer from normalized continuation.");
  assert.equal(
    executedCalls[0]?.input.session_key,
    "worker:explore:task-1:toolu-cancelled",
  );
});

test("llm role response generator canonicalizes abbreviated continuation session keys from context", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-abbrev-send", "sessions_send", {
        session_key: "worker:explore:task:TASK-1:call_func_abc123_1",
        message: "Continue the cancelled source check.",
      });
    }
    return {
      text: "Final answer from canonical continuation.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task:TASK-1:call_function_abc123_1",
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: input.call.input.session_key,
          agent_id: "explore",
          status: "completed",
          result: "Canonical key continuation completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the cancelled source-check attempt in this mission.",
        "",
        "Recent turns:",
        "[user] Continue from the cancelled source-check attempt in this mission.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:explore:task:TASK-1:call_function_abc123_1","agent_id":"explore","result":"operator cancelled active source verification"}',
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer from canonical continuation.");
  assert.equal(
    executedCalls[0]?.input.session_key,
    "worker:explore:task:TASK-1:call_function_abc123_1",
  );
});

test("llm role response generator canonicalizes ellipsized continuation session keys from context", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-ellipsized-send", "sessions_send", {
        session_key: "worker:explore:task:TASK-1:call_funct…",
        message: "Continue the cancelled source check.",
      });
    }
    return {
      text: "Final answer from ellipsized-key continuation.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(
        input.call.input.session_key,
        "worker:explore:task:TASK-1:call_function_24fkgmynytqr_1",
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: input.call.input.session_key,
          agent_id: "explore",
          status: "completed",
          result: "Ellipsized key continuation completed.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue from the cancelled source-check attempt in this mission.",
        "",
        "Recent turns:",
        "[user] Continue from the cancelled source-check attempt in this mission.",
        '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:explore:task:TASK-1:call_function_24fkgmynytqr_1","agent_id":"explore","result":"operator cancelled active source verification"}',
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "Final answer from ellipsized-key continuation.",
  );
  assert.equal(
    executedCalls[0]?.input.session_key,
    "worker:explore:task:TASK-1:call_function_24fkgmynytqr_1",
  );
  const trace = result.metadata?.toolUse as
    | { rounds?: Array<{ calls?: Array<{ input?: Record<string, unknown> }> }> }
    | undefined;
  assert.equal(
    trace?.rounds?.[0]?.calls?.[0]?.input?.session_key,
    "worker:explore:task:TASK-1:call_function_24fkgmynytqr_1",
  );
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
        {
          name: "sessions_history",
          description: "Read a sub-agent session",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
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

  assert.equal(
    result.content,
    "Final synthesized answer from sub-agent evidence.",
  );
  assert.equal(executedTools, 1);
  assert.equal(gatewayInputs.length, 2);
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes(
          "Do not call sessions_history or sessions_list",
        ),
    ),
  );
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("Source 1 evidence"),
    ),
  );
  const synthesisPrompt = finalSynthesisPrompt(gatewayInputs[1]) ?? "";
  assert.ok(
    synthesisPrompt.includes("Do not add extra sections, summaries, notes"),
  );
  assert.ok(synthesisPrompt.includes("line must start with a literal prefix"));
  assert.ok(
    synthesisPrompt.includes(
      "Do not write a preamble before a requested final shape",
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_spawn");
  assert.equal(closeout?.finalContentCount, 1);
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
});

test("llm role response generator closes out repeated session history inspection", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:browser:task:TASK-1:call_function_dashboard_1";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-history-1", "sessions_history", {
        session_key: sessionKey,
        tail: true,
        limit: 10,
      });
    }
    if (executedCalls.length === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-history-2", "sessions_history", {
        session_key: sessionKey,
        tail: true,
        limit: 10,
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /Repeated session inspection detected/);
    assert.match(finalPrompt, /Do not call sessions_history/);
    return {
      text: "Final answer from already inspected session history.",
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
          description: "Read a sub-agent session",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              tail: { type: "boolean" },
              limit: { type: "number" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: sessionKey,
          agent_id: "browser",
          status: "completed",
          result:
            "History tail: rendered dashboard evidence captured. Stuck missions: 6. Weak answer rate: 24%.",
          final_content:
            "Rendered dashboard evidence captured. Stuck missions: 6. Weak answer rate: 24%.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Prepare a product-ready brief from the browser-rendered dashboard evidence.",
    },
  });

  assert.equal(
    result.content,
    "Final answer from already inspected session history.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-history-1"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "repeated_session_inspection");
  assert.equal(closeout?.toolName, "sessions_history");
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
});

test("llm role response generator closes out session history already present in recovery context without repeating it", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:browser:task:TASK-1:call_function_dashboard_1";
  let gatewayCalls = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls <= 2 && input.toolChoice !== "none") {
      return toolCallResult("toolu-history-repeat", "sessions_history", {
        session_key: sessionKey,
        tail: true,
        limit: 30,
      });
    }
    assert.equal(input.toolChoice, "none");
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /completed delegated session evidence|Repeated session inspection detected/);
    return textResult("Final answer from prior recovery context.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_history",
          description: "Read a sub-agent session",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              tail: { type: "boolean" },
              limit: { type: "number" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "should not execute repeated history",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief from completed specialist sessions.",
        "[tool] sessions_history returned:",
        JSON.stringify({
          session_key: sessionKey,
          total_messages: 33,
          showing: 30,
          tail: true,
          inspection_guidance:
            "This result contains the available session evidence.",
          result:
            "Rendered dashboard evidence captured. Stuck missions: 6. Weak answer rate: 24%.",
        }),
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer from prior recovery context.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_history"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.ok(closeout?.reason === "completed_sub_agent_final" || closeout?.reason === "repeated_session_inspection");
  assert.equal(closeout?.toolName, "sessions_history");
});

test("llm role response generator synthesizes after completed multi-session history evidence", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  let gatewayCalls = 0;
  const sessionKeys = ["worker:explore:task:TASK-1:call_a", "worker:explore:task:TASK-1:call_b", "worker:browser:task:TASK-1:call_c"];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1 && input.toolChoice !== "none") {
      return {
        text: "Inspect completed specialist sessions.",
        toolCalls: sessionKeys.map((sessionKey, index) => ({
          id: `toolu-history-${index + 1}`,
          name: "sessions_history",
          input: { session_key: sessionKey, tail: true, limit: 30 },
        })),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /completed delegated session evidence/);
    assert.match(finalPrompt, /Mission Control/);
    assert.match(finalPrompt, /Weak answer rate/);
    return textResult("Final product brief from completed session histories.");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_history",
          description: "Read a sub-agent session",
          inputSchema: { type: "object", properties: { session_key: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const sessionKey = String(input.call.input.session_key);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          session_key: sessionKey,
          total_messages: 2,
          showing: 2,
          tail: true,
          messages: [
            {
              role: "assistant",
              content:
                sessionKey.endsWith("call_c")
                  ? "Product signals dashboard: Stuck missions 6, Weak answer rate 24%, recommended next action make Mission Control default."
                  : "Specialist source evidence supports the product brief.",
            },
          ],
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Prepare a product-ready brief from completed orchestration, bridge, and product signal specialist sessions.",
    },
  });

  assert.equal(result.content, "Final product brief from completed session histories.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_history", "sessions_history", "sessions_history"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_history");
});

test("llm role response generator closes out excessive same-session continuation", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:explore:task:TASK-1:call_function_source_1";
  let gatewayCalls = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-send-1", "sessions_send", {
        session_key: sessionKey,
        message: "Continue source check.",
      });
    }
    if (gatewayCalls === 2 && input.toolChoice !== "none") {
      return toolCallResult("toolu-send-2", "sessions_send", {
        session_key: sessionKey,
        message: "Continue source check again.",
      });
    }
    if (gatewayCalls === 3 && input.toolChoice !== "none") {
      return toolCallResult("toolu-send-3", "sessions_send", {
        session_key: sessionKey,
        message: "Continue source check one more time.",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /Repeated session continuation detected/);
    assert.match(finalPrompt, /Do not call sessions_send again/);
    return {
      text: "Final answer from bounded continuation evidence.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: sessionKey,
          agent_id: "explore",
          status: "partial",
          result: `Partial evidence after ${executedCalls.length} continuation(s).`,
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Review source-check progress for the release-risk note and stop once the available worker evidence has been bounded.",
    },
  });

  assert.equal(
    result.content,
    "Final answer from bounded continuation evidence.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-send-1", "toolu-send-2"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "excessive_session_continuation");
  assert.equal(closeout?.toolName, "sessions_send");
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.equal(closeout?.toolCallCount, 2);
});

test("llm role response generator does not synthesize from bounded partial session final content", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:browser:task:TASK-dashboard:call_function_browser_1";
  let gatewayCalls = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-browser-1", "sessions_spawn", {
        agent_id: "browser",
        task: "Check the rendered operations dashboard.",
      });
    }
    assert.notEqual(input.toolChoice, "none");
    assert.ok(input.tools?.some((tool) => tool.name === "sessions_send"));
    return {
      text: "Partial dashboard evidence is not completed evidence; continue the worker before final synthesis.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_spawn");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-dashboard-followup",
          session_key: sessionKey,
          agent_id: "browser",
          status: "partial",
          tool_chain: ["browser"],
          evidence_summary:
            "Browser recovery metadata: Resume mode: hot. Session ID: browser-session-1.",
          result:
            "Verified queue depth 11, SLA breaches 3, escalation threshold queue depth above 5 or SLA breaches above 0, recommended owner Incident Commander.",
          final_content:
            "Verified: Queue depth 11. SLA breaches 3. Escalation threshold: queue depth above 5 or SLA breaches above 0. Recommended owner: Incident Commander. Recommended action: page the on-call. Residual uncertainty: local dynamic dashboard fixture only.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Check the rendered operations dashboard. Include Queue depth: 11, SLA breaches: 3, escalation threshold, Incident Commander, recommended action, and residual uncertainty.",
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-browser-1"],
  );
  assert.match(result.content, /not completed evidence/i);
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.notEqual(closeout?.reason, "partial_sub_agent_final");
});

test("llm role response generator does not treat resumable partial session output as completion evidence", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const sessionKey = "worker:browser:task:TASK-dashboard:call_function_browser_1";
  let gatewayCalls = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1 && input.toolChoice !== "none") {
      return toolCallResult("toolu-send-1", "sessions_send", {
        session_key: sessionKey,
        message: "Continue dashboard check.",
      });
    }
    assert.notEqual(input.toolChoice, "none");
    assert.ok(input.tools?.some((tool) => tool.name === "sessions_send"));
    return {
      text: "The prior worker result is still resumable, so this is not a completed closeout.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-dashboard-followup",
          session_key: sessionKey,
          agent_id: "browser",
          status: "partial",
          tool_chain: ["browser"],
          result: "Round limit reached after observing partial dashboard facts.",
          final_content:
            "Verified so far: queue depth 11. Unverified: the remaining dashboard panels.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            resumableReason: "round_limit",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Continue the operations dashboard review; do not complete from resumable partial evidence.",
    },
  });

  assert.equal(executedCalls[0]?.id, "toolu-send-1");
  assert.ok(executedCalls.length > 1);
  assert.match(result.content, /still resumable/i);
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.notEqual(closeout?.reason, "partial_sub_agent_final");
});

test("llm role response generator caps same-round spawns to required independent evidence streams", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return {
        text: "Starting four evidence collectors.",
        toolCalls: [
          {
            id: "toolu-orchestration",
            name: "sessions_spawn",
            input: { agent_id: "explore", label: "orchestration" },
          },
          {
            id: "toolu-bridge",
            name: "sessions_spawn",
            input: { agent_id: "explore", label: "bridge" },
          },
          {
            id: "toolu-signals",
            name: "sessions_spawn",
            input: { agent_id: "browser", label: "signals" },
          },
          {
            id: "toolu-extra",
            name: "sessions_spawn",
            input: { agent_id: "explore", label: "extra" },
          },
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
      text: "Final answer from three bounded streams.",
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
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              label: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const label = String(input.call.input.label ?? "unknown");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: `worker:${input.call.input.agent_id}:task:TASK-1:${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: `${label} evidence complete.`,
          final_content: `${label} evidence complete.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief from three independent evidence streams.",
        "Research source: http://local/orchestration",
        "Capability source: http://local/bridge",
        "Live signal dashboard: http://local/signals",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final answer from three bounded streams.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-orchestration", "toolu-bridge", "toolu-signals"],
  );
});

test("llm role response generator caps same-round comparison spawns to two source urls", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return {
        text: "Starting three comparison collectors.",
        toolCalls: [
          {
            id: "toolu-left",
            name: "sessions_spawn",
            input: { agent_id: "explore", label: "left source" },
          },
          {
            id: "toolu-right",
            name: "sessions_spawn",
            input: { agent_id: "explore", label: "right source" },
          },
          {
            id: "toolu-extra",
            name: "sessions_spawn",
            input: { agent_id: "explore", label: "extra source" },
          },
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
      text: "Final comparison from two bounded sources.",
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
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              label: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const label = String(input.call.input.label ?? "unknown");
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-1",
          session_key: `worker:explore:task:TASK-1:${input.call.id}`,
          agent_id: "explore",
          status: "completed",
          result: `${label} evidence complete.`,
          final_content: `${label} evidence complete.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Compare http://local/source-a and http://local/source-b, then recommend the lower release risk option.",
    },
  });

  assert.equal(result.content, "Final comparison from two bounded sources.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-left", "toolu-right"],
  );
});

test("llm role response generator synthesizes immediately after completed browser session evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let executedTools = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open the approved local form and verify TURNKEYAI_APPROVAL_FIXTURE_OK.",
      });
    }
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /TURNKEYAI_APPROVAL_FIXTURE_OK/);
    return {
      text: "Final synthesized answer from browser evidence.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
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
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:browser:task-1:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "Browser worker completed session brw-1.\nFinal URL: http://127.0.0.1/approval-form.\nPage title: Local approval fixture.\nExcerpt: TURNKEYAI_APPROVAL_FIXTURE_OK no external mutation was performed.",
          final_content: null,
          payload: {
            sessionId: "brw-1",
            page: {
              finalUrl: "http://127.0.0.1/approval-form",
              title: "Local approval fixture",
              textExcerpt:
                "TURNKEYAI_APPROVAL_FIXTURE_OK no external mutation was performed.",
            },
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

  assert.equal(
    result.content,
    "Final synthesized answer from browser evidence.",
  );
  assert.equal(executedTools, 1);
  assert.equal(gatewayInputs.length, 2);
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_spawn");
  assert.equal(closeout?.finalContentCount, 1);
});

test("llm role response generator preserves browser evidence summary when child final is weak", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser-signals", "sessions_spawn", {
        agent_id: "browser",
        task: "Open the live product signal dashboard and report rendered counters.",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /Source 1 evidence/);
    assert.match(finalPrompt, /Stuck missions: 6/);
    assert.match(finalPrompt, /Weak answer rate: 24%/);
    assert.ok(
      finalPrompt.indexOf("Stuck missions: 6") <
        finalPrompt.indexOf(
          "The dashboard rendered client-side; exact counters were not verified.",
        ),
    );
    return {
      text: "Final brief uses rendered dashboard evidence: Stuck missions: 6 and Weak answer rate: 24%.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-signals",
          session_key: "worker:browser:task-signals:toolu-browser-signals",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser worker completed product signal dashboard review.",
          evidence_summary: [
            "Browser snapshot: Workbench product signals.",
            "Rendered counters: Stuck missions: 6. Weak answer rate: 24%.",
            "Recommended next action: make Mission Control the default entry.",
          ].join("\n"),
          final_content:
            "The dashboard rendered client-side; exact counters were not verified.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "The dashboard rendered client-side; exact counters were not verified.",
            sessionId: "brw-signals",
            page: {
              finalUrl: "http://127.0.0.1/product-signals",
              title: "Workbench product signals",
              textExcerpt:
                "Stuck missions: 6. Weak answer rate: 24%. Mission Control default entry.",
            },
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

  assert.equal(
    result.content,
    "Final brief uses rendered dashboard evidence: Stuck missions: 6 and Weak answer rate: 24%.",
  );
  assert.equal(gatewayInputs.length, 2);
});

test("llm role response generator repairs completed session synthesis that omits requested next action", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Review dashboard timeout state.",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.equal(input.toolChoice, "none");
      return {
        text: "Browser experienced CDP command timeouts. Verified queue depth 11. Unverified: ticket-level detail.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /requested next action is missing/,
    );
    return {
      text: "Browser experienced CDP command timeouts. Verified queue depth 11. Unverified: ticket-level detail. Next action: retry browser capture after CDP recovers and keep escalation active meanwhile.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: "worker:browser:task-timeout:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "Browser experienced CDP command timeouts. Verified queue depth 11. Unverified: ticket-level detail.",
          final_content:
            "Browser experienced CDP command timeouts. Verified queue depth 11. Unverified: ticket-level detail.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Review the operations dashboard. If browser capture times out, close out with what was verified, what remains unverified, and the next action an operator should take.",
    },
  });

  assert.match(result.content, /Next action: retry browser capture/);
  assert.ok(gatewayInputs.length >= 3);
});

test("llm role response generator repairs weak uncertainty in completed session synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-explore", "sessions_spawn", {
        agent_id: "explore",
        task: "Review Vendor Alpha pricing, strength, and risk.",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.equal(input.toolChoice, "none");
      return {
        text: "Vendor Alpha pricing is a lower-bound estimate at $19/seat. It probably fits teams that value browser automation. Risk: integration catalog is limited.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /final answer weakens verified evidence/,
    );
    return {
      text: "Vendor Alpha has an observed $19/seat price point. Verified strength: browser automation with traceable screenshots. Verified risk: the API integration catalog is limited. Not verified: plan tiers, enterprise support, and user scale. Residual risk: do not treat missing tiers as absent; treat them as not verified.",
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
          description: "Spawn an explore sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-alpha",
          session_key: "worker:explore:task-alpha:toolu-explore",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result:
            "Vendor Alpha: $19/seat. Strength: browser automation and traceable screenshots. Risk: API integration catalog is still limited.",
          final_content:
            "Vendor Alpha: $19/seat. Strength: browser automation and traceable screenshots. Risk: API integration catalog is still limited.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Start a source-backed review of Vendor Alpha for a product lead. Focus on pricing, strength, and risk.",
    },
  });

  assert.match(result.content, /observed \$19\/seat price point/);
  assert.doesNotMatch(
    result.content,
    /\b(?:estimate|probably|maybe|TBD|to be confirmed|pending confirmation)\b/i,
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs source-external extrapolation after direct web evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-web-fetch", "web_fetch", {
        url: "https://example.com/",
        max_chars: 2000,
      });
    }
    if (gatewayInputs.length === 2) {
      assert.equal(input.messages.at(-1)?.role, "tool");
      return textResult(
        [
          "Decision Note — https://example.com/",
          "1. 可用于什么：作为代码示例、文档演示、测试环境的占位域名，无需获得授权即可使用。",
          "2. 限制或风险：不得用于任何生产或运营环境、真实服务，否则会被 DNS 污染（实际解析到 93.184.215.14）并带来安全风险。",
          '3. 关键原文证据："This domain is for use in documentation examples without needing permission."',
        ].join("\n"),
      );
    }
    assert.equal(input.toolChoice, "none");
    const repairPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(repairPrompt, /source-external technical or policy extrapolations/);
    assert.match(repairPrompt, /DNS\/IP resolution details/);
    return textResult(
      [
        "Decision Note — https://example.com/",
        "1. 可用于什么：作为文档示例或代码示例中的保留域名使用，无需获取授权。",
        '2. 限制或风险：页面明确写着 "Avoid use in operations"，因此结论只限于文档/示例用途；真实运营用途不在本次证据范围内。',
        '3. 关键原文证据："This domain is for use in documentation examples without needing permission. Avoid use in operations."',
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch a public page",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              max_chars: { type: "number" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "ok",
          requested_url: "https://example.com/",
          final_url: "https://example.com/",
          status_code: 200,
          title: "Example Domain",
          text_excerpt:
            "Example Domain\n\nThis domain is for use in documentation examples without needing permission. Avoid use in operations.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "基于 https://example.com/ 的已验证 evidence，写一个三点 decision note：用途、最重要限制或风险、关键原文证据。",
    },
  });

  assert.match(result.content, /Avoid use in operations/);
  assert.doesNotMatch(result.content, /DNS|93\\.184\\.215\\.14|解析到/);
  assert.doesNotMatch(result.content, /(?:不得|禁止)[^。；;\n]{0,80}(?:生产|运营|真实服务|安全风险)/);
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator keeps session evidence without final_content source-bounded", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-session", "sessions_spawn", {
        agent_id: "explore",
        label: "研究员A-检查example.com",
        task: "检查 https://example.com/ 并返回最终URL、title、关键原文、取证方式。",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.equal(input.messages.at(-1)?.role, "tool");
      return textResult(
        [
          "Decision Note — example.com",
          "1. 页面用途：作为代码、文档、教学材料中的占位域名，无需申请许可即可自由使用。",
          "2. 最重要限制/风险：不得将 example.com 用于任何生产环境或公开可访问的真实服务；其 IP 地址和内容由 IANA 固定分配，不具备真实业务域名的稳定性；第三方可能将其用于恶意测试流量。",
          '3. 关键原文引用："This domain is for use in documentation examples without needing permission."',
        ].join("\n"),
      );
    }
    assert.equal(input.toolChoice, "none");
    const repairPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(repairPrompt, /source-external technical or policy extrapolations/);
    return textResult(
      [
        "Decision Note — example.com",
        "1. 页面用途：作为文档示例或代码示例中的保留域名使用，无需获取授权。",
        '2. 最重要限制/风险：页面明确写着 "Avoid use in operations"；除此之外，生产环境、IANA 分配细节、IP 地址稳定性和恶意流量风险均未在本轮证据中验证。',
        '3. 关键原文引用："This domain is for use in documentation examples without needing permission. Avoid use in operations."',
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn an explore sub-agent",
          inputSchema: { type: "object" },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          agent_id: "explore",
          label: "研究员A-检查example.com",
          session_key: "worker:explore:task-1:toolu-session",
          task_id: "task-1",
          tool_chain: ["explore"],
          evidence_excerpt:
            "This domain is for use in documentation examples without needing permission. Avoid use in operations.",
          evidence_summary:
            "Final URL: https://example.com/\nPage title: Example Domain\nExcerpt: This domain is for use in documentation examples without needing permission. Avoid use in operations.",
          final_content: null,
          result:
            "Explore worker fetched https://example.com/.\nFinal URL: https://example.com/.\nTitle: Example Domain.\nExcerpt: This domain is for use in documentation examples without needing permission. Avoid use in operations.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "继续刚才研究员 A 的同一条研究线索，基于上一轮 evidence 写一个三点 decision note：用途、限制或风险、关键原文。",
    },
  });

  assert.match(result.content, /Avoid use in operations/);
  assert.doesNotMatch(result.content, /IANA 固定分配|恶意测试流量|IP 地址.*稳定性/);
  assert.doesNotMatch(result.content, /(?:不得|禁止)[^。；;\n]{0,80}(?:生产|运营|真实服务)/);
  assert.ok(gatewayInputs.length === 2 || gatewayInputs.length === 3);
});

test("llm role response generator repairs source-external follow-up synthesis from prompt evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return textResult(
        [
          "## Decision Note — https://example.com/",
          "1. 页面用途：IANA 保留的示例域名，用于文档、教程、演示和代码示例。",
          "2. 使用限制 / 风险：该域名不得用于任何实际生产环境或真实网络用途，否则可能导致路由冲突或安全风险。",
          '3. 关键原文："This domain is for use in documentation examples without needing permission."',
        ].join("\n"),
      );
    }
    assert.equal(input.toolChoice, "none");
    const repairPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(repairPrompt, /source-external technical or policy extrapolations/);
    return textResult(
      [
        "## Decision Note — https://example.com/",
        "1. 页面用途：可作为文档、教程、演示和代码示例中的占位域名使用，无需申请授权。",
        '2. 使用限制 / 风险：页面原文写着 "Avoid use in operations"；本轮证据只支持把结论限定在文档示例用途，运营用途在已验证范围之外。',
        '3. 关键原文："This domain is for use in documentation examples without needing permission. Avoid use in operations."',
      ].join("\n"),
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch a public page",
          inputSchema: { type: "object" },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "{}",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "继续刚才研究员 A 的同一条研究线索。请不要重新抓取页面，除非你明确找不到上一轮研究员 A 的证据。",
        "Recent messages:",
        "| URL | title | 关键原文 | 证据方式 |",
        '| https://example.com/ | Example Domain | "This domain is for use in documentation examples without needing permission. Avoid use in operations." | HTTP fetch |',
        "基于上一轮已经验证的 evidence，写一个三点 decision note。",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Avoid use in operations/);
  assert.doesNotMatch(result.content, /(?:不得|禁止)[^。；;\n]{0,100}(?:生产|运营|真实网络)/);
  assert.doesNotMatch(result.content, /路由冲突|安全风险/);
  assert.equal(gatewayInputs.length, 2);
});

test("llm role response generator repairs completed session synthesis that falsely marks evidence blocked", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Calling independent sessions.",
        toolCalls: [
          {
            id: "toolu-orchestration",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "Orchestration research",
              task: "Fetch orchestration evidence.",
            },
          },
          {
            id: "toolu-bridge",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "Bridge capability research",
              task: "Fetch bridge evidence.",
            },
          },
          {
            id: "toolu-signals",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "Product signals dashboard",
              task: "Inspect rendered dashboard evidence.",
            },
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
      assert.equal(input.toolChoice, "none");
      return {
        text: [
          "evidence",
          "- orchestration evidence: Source 1 content was partially truncated and the full roadmap was not accessible via this interface.",
          "- bridge evidence: TURNKEYAI_PRODUCT_BRIDGE_OK; browser bridge controls; browser-only boundary and first-run setup risk.",
          "- browser signal evidence: TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK; Stuck missions: 6; Weak answer rate: 24%; browser-rendered JavaScript.",
          "decision",
          "- recommendation: make Mission Control the default entry.",
          "- next actions: improve onboarding, quality gates, and bridge diagnostics.",
          "- residual risk: source-bounded to local fixtures.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    const repairPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(repairPrompt, /falsely marks completed evidence/);
    assert.match(repairPrompt, /Source 1 completed evidence/);
    assert.match(repairPrompt, /TURNKEYAI_PRODUCT_ORCHESTRATION_OK/);
    return {
      text: [
        "evidence",
        "- orchestration evidence: Orchestration research; TURNKEYAI_PRODUCT_ORCHESTRATION_OK; primary user story verified, with multi-agent decomposition, durable sub-session history, and clearer entry-point gap.",
        "- bridge evidence: Bridge capability research; TURNKEYAI_PRODUCT_BRIDGE_OK; browser bridge controls; browser-only boundary and first-run setup risk.",
        "- browser signal evidence: Product signals dashboard; TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK; Stuck missions: 6; Weak answer rate: 24%; browser-rendered JavaScript.",
        "decision",
        "- recommendation: make Mission Control the default entry and gate release on real LLM scenario quality.",
        "- next actions: improve onboarding, mission completion quality, and bridge/runtime diagnostics.",
        "- residual risk: source-bounded to local fixtures; real-world validation remains.",
      ].join("\n"),
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      const label = String(input.call.input.label ?? "");
      const evidence =
        label === "Orchestration research"
          ? "TURNKEYAI_PRODUCT_ORCHESTRATION_OK. Primary user story: a product lead starts one mission, then specialist agents watch documents, browser state, and work items until a decision-ready brief is produced. Strength: multi-agent decomposition with durable sub-session history and follow-up. Gap: users need clearer entry points than a developer command line."
          : label === "Bridge capability research"
            ? "TURNKEYAI_PRODUCT_BRIDGE_OK. Controls: browser bridge controls open pages, inspect rendered DOM, act after approval, and collect screenshots. Boundary: browser-only; no desktop control outside the browser. Risk: command-line setup blocks first-run adoption."
            : "TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK. Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry and gate release on real LLM scenario quality. Evidence came from browser-rendered JavaScript.";
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id,
          label,
          status: "completed",
          tool_chain: [input.call.input.agent_id],
          result: evidence,
          final_content: evidence,
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: evidence,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief for the next agent workbench release.",
        "Gather evidence from three independent child sessions before finalizing.",
        "Do not include source URLs in the final answer.",
        "Keep residual risk visible.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /TURNKEYAI_PRODUCT_ORCHESTRATION_OK/);
  assert.match(result.content, /durable sub-session history/);
  assert.doesNotMatch(
    result.content,
    /truncated|not accessible|inaccessible|content was partially/i,
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs shell-only product signal dashboard evidence with focused browser spawn", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Gathering product evidence.",
        toolCalls: [
          {
            id: "toolu-orchestration",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "product-orchestration",
              task: "Fetch product orchestration evidence.",
            },
          },
          {
            id: "toolu-bridge",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "product-bridge",
              task: "Fetch browser bridge evidence.",
            },
          },
          {
            id: "toolu-signals-shell",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "product-signals",
              task: "Inspect http://127.0.0.1:61930/product-signals live signal dashboard.",
            },
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
      assert.equal(input.toolChoice, "none");
      return {
        text: [
          "All three sources are SPAs; explore workers returned server HTML shells with partial text.",
          "Browser rendering was not confirmed, so Stuck missions and Weak answer rate remain unverified.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 3) {
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      const repairPrompt = readToolContent(
        input.messages.at(-1)?.content ?? "",
      );
      assert.match(
        repairPrompt,
        /live product signal dashboard evidence is still incomplete/,
      );
      assert.match(
        repairPrompt,
        /http:\/\/127\.0\.0\.1:61930\/product-signals/,
      );
      return toolCallResult("toolu-signals-focused", "sessions_spawn", {
        agent_id: "browser",
        label: "product-signals-focused",
        task: "Open http://127.0.0.1:61930/product-signals and return rendered counters.",
      });
    }
    assert.equal(input.toolChoice, "none");
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /Stuck missions: 6/);
    assert.match(finalPrompt, /Weak answer rate: 24%/);
    return {
      text: "Final brief uses rendered product signals: Stuck missions: 6; Weak answer rate: 24%; Mission Control should be the default entry.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executedCalls: LLMToolCall[] = [];
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const label = String(input.call.input.label ?? "");
      const evidence =
        label === "product-orchestration"
          ? "TURNKEYAI_PRODUCT_ORCHESTRATION_OK. Product orchestration evidence verified."
          : label === "product-bridge"
            ? "TURNKEYAI_PRODUCT_BRIDGE_OK. Browser bridge evidence verified."
            : label === "product-signals-focused"
              ? "TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK. Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry. Evidence came from browser-rendered JavaScript."
              : "Server HTML shell loaded for product-signals. Browser rendering was not confirmed.";
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id,
          label,
          status: "completed",
          tool_chain: [input.call.input.agent_id],
          result: evidence,
          final_content: evidence,
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: evidence,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief about the next agent workbench release.",
        "Research source: http://127.0.0.1:61930/product-orchestration",
        "Capability source: http://127.0.0.1:61930/product-bridge",
        "Live signal dashboard: http://127.0.0.1:61930/product-signals",
        "These are three independent evidence streams. Use browser-visible evidence for the live signal dashboard.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Stuck missions: 6/);
  assert.match(result.content, /Weak answer rate: 24%/);
  assert.deepEqual(
    executedCalls.map(
      (call) => `${call.name}:${String(call.input.label ?? "")}`,
    ),
    [
      "sessions_spawn:product-orchestration",
      "sessions_spawn:product-bridge",
      "sessions_spawn:product-signals",
      "sessions_spawn:product-signals-focused",
    ],
  );
  assert.equal(gatewayInputs.length, 4);
});

test("llm role response generator repairs completed session synthesis that drops requested risk dimension", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-explore", "sessions_spawn", {
        agent_id: "explore",
        task: "Review Vendor Alpha pricing, strength, and risk.",
      });
    }
    if (gatewayInputs.length === 2) {
      assert.equal(input.toolChoice, "none");
      return {
        text: [
          "Vendor Alpha has an observed $19/seat price point.",
          "Strength: browser automation with traceable screenshots.",
          "Weaknesses: API integration catalog is still limited.",
          "Open questions: enterprise support and user scale were not verified.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    const repairPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(repairPrompt, /Preserve requested dimension labels/);
    assert.match(repairPrompt, /requested risk dimension/);
    return {
      text: [
        "Vendor Alpha has an observed $19/seat price point.",
        "Verified strength: browser automation with traceable screenshots.",
        "Verified risk: the API integration catalog is still limited.",
        "Residual risk: enterprise support and user scale were not verified.",
      ].join("\n"),
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
          description: "Spawn an explore sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-alpha",
          session_key: "worker:explore:task-alpha:toolu-explore",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result:
            "Vendor Alpha: $19/seat. Strength: browser automation and traceable screenshots. Risk: API integration catalog is still limited.",
          final_content:
            "Vendor Alpha: $19/seat. Strength: browser automation and traceable screenshots. Risk: API integration catalog is still limited.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Start a source-backed review of Vendor Alpha for a product lead. Focus on pricing, strength, and risk.",
    },
  });

  assert.match(
    result.content,
    /Verified risk: the API integration catalog is still limited/,
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator allows estimates when the user asks for estimation", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-explore", "sessions_spawn", {
        agent_id: "explore",
        task: "Estimate migration effort from the available notes.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Estimated migration effort is 3-5 engineer-days based on the observed package count and two integration points.",
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
          description: "Spawn an explore sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-estimate",
          session_key: "worker:explore:task-estimate:toolu-explore",
          agent_id: "explore",
          status: "completed",
          result:
            "Observed package count: 4. Integration points: auth and browser bridge.",
          final_content:
            "Observed package count: 4. Integration points: auth and browser bridge.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Estimate the migration effort from the available notes and give a practical range.",
    },
  });

  assert.match(
    result.content,
    /Estimated migration effort is 3-5 engineer-days/,
  );
  assert.equal(gatewayInputs.length, 2);
});

test("llm role response generator executes one approval-gated browser spawn from duplicate same-round calls", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will run the approved browser step.",
        toolCalls: [
          {
            id: "toolu-query",
            name: "permission_query",
            input: {
              action: "browser.form.submit",
              scope: "local dry-run form",
            },
          },
          {
            id: "toolu-result",
            name: "permission_result",
            input: { approval_id: "ap-1" },
          },
          {
            id: "toolu-applied",
            name: "permission_applied",
            input: { approval_id: "ap-1" },
          },
          ...["a", "b", "c", "d"].map((id) => ({
            id: `toolu-${id}`,
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Submit the approved local dry-run form and verify TURNKEYAI_APPROVAL_FIXTURE_OK.",
            },
          })),
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /TURNKEYAI_APPROVAL_FIXTURE_OK/,
    );
    return {
      text: "The approved dry-run was submitted once and verified.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_result") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      if (input.call.name === "permission_applied") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "applied", approval_id: "ap-1" }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approval",
          session_key: `worker:browser:task-approval:${input.call.id}`,
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "TURNKEYAI_APPROVAL_FIXTURE_OK submitted once.",
          final_content: null,
          payload: {
            sessionId: "brw-approval",
            page: {
              finalUrl: "http://127.0.0.1/approval-form",
              title: "Local approval fixture",
              textExcerpt: "TURNKEYAI_APPROVAL_FIXTURE_OK submitted once.",
            },
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "Submit the approved local dry-run form and report the evidence.",
      ].join("\n"),
    },
  });

  assert.equal(
    result.content,
    "The approved dry-run was submitted once and verified.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [
      "permission_query",
      "permission_result",
      "permission_applied",
      "sessions_spawn",
    ],
  );
  assert.equal(executedCalls[3]?.id, "toolu-a");
  assert.equal(gatewayInputs.length, 2);
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolCallCount, 4);
});

test("llm role response generator preserves distinct approval-gated browser spawns in the same round", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "I will run two distinct approved browser checks.",
        toolCalls: [
          {
            id: "toolu-query",
            name: "permission_query",
            input: {
              action: "browser.form.submit",
              scope: "local dry-run form",
            },
          },
          {
            id: "toolu-alpha",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Submit the approved local dry-run form and verify alpha evidence.",
            },
          },
          {
            id: "toolu-beta",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Submit the approved local dry-run form and verify beta evidence.",
            },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /alpha evidence/);
    assert.match(finalPrompt, /beta evidence/);
    return {
      text: "Both distinct approved browser checks were preserved.",
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
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ status: "approved", approval_id: "ap-1" }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:browser:task-${input.call.id}:${input.call.id}`,
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: `${input.call.input.task} completed.`,
          final_content: null,
          payload: { sessionId: `brw-${input.call.id}` },
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Run approved browser.form.submit checks for two distinct local dry-run forms.",
    },
  });

  assert.equal(
    result.content,
    "Both distinct approved browser checks were preserved.",
  );
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-query", "toolu-alpha", "toolu-beta"],
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.finalContentCount, 2);
});

test("llm role response generator treats runtime-gated browser permission progress as approval evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open the local approval form after browser.form.submit approval and verify TURNKEYAI_APPROVAL_FIXTURE_OK.",
      });
    }
    assert.equal(input.toolChoice, "none");
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /completed delegated session evidence/);
    assert.doesNotMatch(
      finalPrompt,
      /Runtime correction: approval-gated browser action/,
    );
    return {
      text: "Final approval-gated browser evidence answer.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        progress: [
          {
            phase: "progress",
            toolName: input.call.name,
            summary: "Approval required before browser.form.submit.",
            detail: { eventType: "permission.query", status: "pending" },
          },
          {
            phase: "progress",
            toolName: input.call.name,
            summary: "Permission request was approved.",
            detail: { eventType: "permission.result", status: "approved" },
          },
          {
            phase: "progress",
            toolName: input.call.name,
            summary: "Permission request was applied.",
            detail: { eventType: "permission.applied", status: "applied" },
          },
        ],
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approval",
          session_key: "worker:browser:task-approval:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "TURNKEYAI_APPROVAL_FIXTURE_OK verified after runtime approval gate.",
          final_content: null,
          payload: {
            sessionId: "brw-approval",
            page: {
              finalUrl: "http://127.0.0.1/approval-form",
              title: "Local approval fixture",
              textExcerpt:
                "TURNKEYAI_APPROVAL_FIXTURE_OK verified after runtime approval gate.",
            },
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Run the mission route approval-gated browser E2E.",
        "Call sessions_spawn with agent_id=browser exactly once.",
        "Do not call permission_query, permission_result, or permission_applied directly; the runtime gate must emit those while handling sessions_spawn.",
        "The browser task must include browser.form.submit and submit so the runtime approval gate is exercised.",
      ].join("\n"),
    },
  });

  assert.equal(result.content, "Final approval-gated browser evidence answer.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn"],
  );
  assert.equal(gatewayInputs.length, 2);
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolCallCount, 1);
});

test("llm role response generator keeps completed tool evidence when final synthesis is unavailable", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-done", "sessions_send", {
        session_key: "worker:explore:task:TASK-1:call_function_abc_1",
        message: "Continue the source check.",
      });
    }
    assert.equal(input.toolChoice, "none");
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
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
          session_key: "worker:explore:task:TASK-1:call_function_abc_1",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: "Continuation completed with evidence.",
          final_content:
            "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal. Source: http://127.0.0.1:4321/cancel-resume-fixture.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal. Source: http://127.0.0.1:4321/cancel-resume-fixture.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief:
      activation.handoff.payload.intent?.relayBrief ?? "Handle the task.",
    instructions: activation.handoff.payload.intent?.instructions ?? "",
    recentMessages: [
      {
        messageId: "msg-cancel",
        role: "tool",
        name: "sessions_spawn",
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task:TASK-1:call_function_abc_1",
          agent_id: "explore",
          status: "cancelled",
          resumable: true,
          tool_chain: [],
          result: "Operator cancelled the first check.",
          final_content: null,
          payload: null,
        }),
        createdAt: 1,
      } satisfies TeamMessageSummary,
    ],
  };
  const packet = buildPacket();
  packet.taskPrompt = `${packet.taskPrompt}\n\nContinue from the cancelled source-check attempt.`;
  packet.outputContract = "Return a concise final answer. Do not include URLs.";

  const result = await generator.generate({
    activation,
    packet,
  });

  assert.ok(gatewayCalls >= 2);
  assert.match(result.content, /Release Captain/);
  assert.match(result.content, /runbook gap/);
  assert.match(result.content, /rollback rehearsal/);
  assert.match(result.content, /\bVerified:/);
  assert.match(result.content, /\bUnverified:/);
  assert.match(result.content, /\bRisk:/);
  assert.match(result.content, /cancel/i);
  assert.doesNotMatch(result.content, /127\.0\.0\.1/);
  assert.match(result.content, /local fixture source/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
});

test("llm role response generator uses completed browser evidence when final synthesis is unavailable", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open the local approval form and verify TURNKEYAI_APPROVAL_FIXTURE_OK.",
      });
    }
    assert.equal(input.toolChoice, "none");
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser",
          session_key: "worker:browser:task-browser:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser summary did not include the marker.",
          evidence_summary:
            "Final URL: http://127.0.0.1/approval-form\nPage title: Local approval fixture\nExcerpt: TURNKEYAI_APPROVAL_FIXTURE_OK no external mutation was performed.",
          final_content: null,
          payload: {
            sessionId: "brw-1",
            page: {
              finalUrl: "http://127.0.0.1/approval-form",
              title: "Local approval fixture",
              textExcerpt:
                "TURNKEYAI_APPROVAL_FIXTURE_OK no external mutation was performed.",
            },
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.outputContract = "Return a concise final answer. Do not include URLs.";

  const result = await generator.generate({
    activation: buildActivation(),
    packet,
  });

  assert.ok(gatewayCalls >= 2);
  assert.match(result.content, /TURNKEYAI_APPROVAL_FIXTURE_OK/);
  assert.match(result.content, /Local approval fixture/);
  assert.doesNotMatch(result.content, /127\.0\.0\.1/);
  assert.match(result.content, /local fixture source/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
});

test("llm role response generator repairs approval browser finals that drop completed session labels", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        label: "Inspect local approval form",
        task: "Open http://127.0.0.1:56633/approval-form and inspect the rendered form.",
      });
    }
    if (gatewayInputs.length === 2) {
      return {
        text: [
          "Approval dry-run report.",
          "Form evidence: TURNKEYAI_APPROVAL_FIXTURE_OK, title Approval Gate Fixture, submit button Submit dry-run.",
          "Residual risk: local fixture only.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    assert.match(
      readToolContent(input.messages.at(-1)?.content ?? ""),
      /dropped visible evidence source labels/,
    );
    return {
      text: [
        "Approval dry-run report.",
        "Evidence / Sources: Inspect local approval form verified TURNKEYAI_APPROVAL_FIXTURE_OK, title Approval Gate Fixture, and the Submit dry-run control.",
        "Residual risk: local fixture only.",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser",
          session_key: "worker:browser:task-browser:toolu-browser",
          agent_id: "browser",
          label: "Inspect local approval form",
          status: "completed",
          tool_chain: ["browser"],
          approval_event: { event_type: "permission.applied", status: "applied" },
          result:
            "Rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. No form submission ran.",
          evidence_summary:
            "Final URL: http://127.0.0.1:56633/approval-form\nPage title: Approval Gate Fixture\nSubmission control: Submit dry-run.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
    },
  });

  assert.match(result.content, /Inspect local approval form/);
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator preserves generic tool evidence when follow-up synthesis is unavailable", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-fetch", "explore_run", {
        instruction: "Fetch the orchestration source.",
      });
    }
    assert.equal(input.toolChoice, "none");
    assert.deepEqual(input.tools ?? [], []);
    throw new Error(
      "llm_request_timeout: model did not respond within 120000ms",
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "explore_run",
          description: "Fetch one source",
          inputSchema: {
            type: "object",
            properties: { instruction: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          summary:
            "Product Orchestration Evidence. Primary user story: a product lead starts one mission. Strength: multi-agent decomposition with durable sub-session history and follow-up. Gap: users need clearer entry points than a developer command line.",
          payload: {
            content:
              "TURNKEYAI_PRODUCT_ORCHESTRATION_OK. Primary user story: a product lead starts one mission, then specialist agents watch documents, browser state, and work items until a decision-ready brief is produced.",
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

  assert.ok(gatewayCalls >= 2);
  assert.match(result.content, /Product Orchestration Evidence/);
  assert.match(result.content, /multi-agent decomposition/);
  assert.match(result.content, /durable sub-session history/);
  assert.match(result.content, /\bVerified:/);
  assert.match(result.content, /\bRisk:/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "tool_evidence_fallback");
  assert.equal(closeout?.evidenceAvailable, true);
});

test("llm role response generator forces permission_result before approval wait-timeout local closeout", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-browser-too-early", "sessions_spawn", {
        agent_id: "browser",
        label: "Inspect local approval form",
        task: "Open http://127.0.0.1:56633/approval-form and submit the dry-run form.",
      });
    }
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "permission_query",
          description: "Request approval",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
          },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: {
            type: "object",
            properties: { approval_id: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              task: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            status: "pending",
            approval_id: "ap-timeout-1",
          }),
        };
      }
      if (input.call.name === "permission_result") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            status: "approval_wait_timeout",
            approval_id: "ap-timeout-1",
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-approval-inspect",
          session_key: "worker:browser:task-approval-inspect:toolu-browser",
          agent_id: "browser",
          label: "Inspect local approval form",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "Rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. Submit control present. No form submission ran.",
          final_content:
            "Inspect local approval form: rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. Submit control present. No form submission ran.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Inspect local approval form: rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. Submit control present. No form submission ran.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Request approval before applying the browser action.",
        "If the operator decision remains pending after the bounded wait, close out honestly as an approval wait-timeout and do not perform the form submission.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "permission_query", "permission_result"],
  );
  assert.equal(executedCalls[2]?.input.approval_id, "ap-timeout-1");
  assert.match(result.content, /Approval wait-timeout closeout confirmed/);
  assert.match(result.content, /no form submission, no side effects/i);
  assert.match(result.content, /pending approval remains/i);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "tool_evidence_fallback");
});

test("llm role response generator does not let stale provider table context pollute local evidence fallback", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-vendor", "sessions_send", {
        session_key: "worker:explore:task-vendor:toolu-alpha",
        message: "Continue the Vendor Alpha evidence note.",
      });
    }
    assert.equal(input.toolChoice, "none");
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-vendor",
          session_key: "worker:explore:task-vendor:toolu-alpha",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: "Vendor Alpha evidence resumed.",
          final_content:
            "Vendor Alpha verified evidence: pricing is $19 per seat; strength is browser automation with traceable screenshots; risk is limited API integration catalog.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Vendor Alpha verified evidence: pricing is $19 per seat; strength is browser automation with traceable screenshots; risk is limited API integration catalog.",
          },
        }),
      };
    },
  };
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief: "Handle the task.",
    recentMessages: [
      {
        messageId: "msg-stale-provider",
        role: "user",
        name: "User",
        content:
          "请用表格列 provider / 是否明确支持目标模型 / 是否明确支持 search/web_search / 输入价格 / 输出价格 / 证据 URL / 关键原文摘录 比较供应商。",
        createdAt: 1,
      },
    ],
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  const result = await generator.generate({
    activation,
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
    },
  });

  assert.ok(gatewayCalls >= 2);
  assert.match(result.content, /\bVerified:/);
  assert.match(result.content, /Vendor Alpha/);
  assert.match(result.content, /\$19 per seat/);
  assert.doesNotMatch(result.content, /是否明确支持目标模型/);
  assert.doesNotMatch(result.content, /search\/web_search/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
});

test("llm role response generator preserves requested table columns in local evidence fallback", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-fetch", "web_fetch", {
        url: "https://openrouter.ai/deepseek",
      });
    }
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch one source",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "ok",
          requested_url: input.call.input.url,
          final_url: "https://openrouter.ai/deepseek",
          title: "DeepSeek API and Models | OpenRouter",
          text_excerpt:
            "DeepSeek V4 Flash. $0.0983 /M input tokens $0.1966 /M output tokens.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.taskPrompt = [
    "调研 DeepSeek V4 Flash API 的可用 provider、是否支持 web search/search 参数、以及价格。",
    "输出表格列出：provider、是否明确支持 DeepSeek V4 Flash、是否明确支持 search/web_search、输入价格、输出价格、证据 URL、关键原文摘录。",
  ].join("\n");

  const result = await generator.generate({
    activation: buildActivation(),
    packet,
  });

  assert.equal(gatewayCalls, 2);
  assert.match(result.content, /Mission 状态：blocked \/ partial/);
  assert.match(
    result.content,
    /\| provider \| 是否明确支持 DeepSeek V4 Flash \| 是否明确支持 search\/web_search \| 输入价格 \| 输出价格 \| 证据 URL \| 关键原文摘录 \|/,
  );
  assert.match(result.content, /openrouter\.ai\/deepseek/);
  assert.match(result.content, /DeepSeek V4 Flash/);
  assert.match(result.content, /\$0\.0983\/1M/);
  assert.match(result.content, /\$0\.1966\/1M/);
  assert.match(result.content, /未验证/);
  assert.doesNotMatch(result.content, /Mission 状态：blocked \/ partial \| 是否明确支持/);
  assert.doesNotMatch(result.content, /DeepSee…/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
});

test("llm role response generator infers provider evidence table columns in local fallback", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-fetch", "web_fetch", {
        url: "https://openrouter.ai/deepseek",
      });
    }
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "web_fetch",
          description: "Fetch source",
          inputSchema: { type: "object" },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "ok",
          requested_url: input.call.input.url,
          final_url: "https://openrouter.ai/deepseek",
          title: "DeepSeek V4 Flash - API Pricing & Benchmarks",
          text_excerpt:
            "Provider OpenRouter lists DeepSeek V4 Flash pricing: input $0.0983/M output $0.1966/M; search/web_search is not mentioned.",
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.taskPrompt = "Continue the original mission.";
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief:
      "Research DeepSeek V4 Flash provider support, search/web_search support, and input/output pricing.",
    recentMessages: [],
  };

  const result = await generator.generate({
    activation,
    packet,
  });

  assert.equal(gatewayCalls, 2);
  assert.match(
    result.content,
    /\| provider \| 是否明确支持 DeepSeek V4 Flash \| 是否明确支持 search\/web_search \| 输入价格 \| 输出价格 \| 证据 URL \| 关键原文摘录 \|/,
  );
  assert.match(result.content, /Mission 状态：blocked \/ partial/);
  assert.match(result.content, /是（页面含模型与价格）/);
  assert.match(result.content, /\$0\.0983\/1M/);
  assert.match(result.content, /\$0\.1966\/1M/);
  assert.match(result.content, /未验证/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
});

test("llm role response generator does not use local evidence closeout for exact final shapes", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-done", "sessions_spawn", {
        agent_id: "explore",
        task: "Return exact shaped evidence.",
      });
    }
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
          session_key: "worker:explore:task:TASK-1:call_function_exact_1",
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: "Exact shape source completed.",
          final_content: "Verified exact-shape evidence.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: "Verified exact-shape evidence.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const packet = buildPacket();
  packet.taskPrompt = `${packet.taskPrompt}\n\nUse this exact final answer shape after the tool result returns:\n- evidence: <one sentence>`;

  await assert.rejects(
    () =>
      generator.generate({
        activation: buildActivation(),
        packet,
      }),
    /final synthesis provider unavailable/,
  );
});

test("llm role response generator does not use skipped generic tool output as local evidence", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-fetch", "explore_run", {
        instruction: "Fetch the orchestration source.",
      });
    }
    throw new Error(
      "llm_request_timeout: model did not respond within 120000ms",
    );
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "explore_run",
          description: "Fetch one source",
          inputSchema: {
            type: "object",
            properties: { instruction: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "tool_call_limit_exceeded: skipped extra source fetch",
        skipped: true,
        raw: { skipped: true },
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await assert.rejects(
    () =>
      generator.generate({
        activation: buildActivation(),
        packet: buildPacket(),
      }),
    /llm_request_timeout/,
  );
});

test("llm role response generator does not use sessions_list control output as local evidence", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-list", "sessions_list", {
        agent_id: "browser",
        kinds: ["browser"],
      });
    }
    if (gatewayCalls === 2) {
      return toolCallResult("toolu-send", "sessions_send", {
        session_key: "worker:explore:task:TASK-1:call_function_old_1",
        message: "Continue the slow source check.",
      });
    }
    throw new Error("final synthesis provider unavailable");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a session",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      if (input.call.name === "sessions_list") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            sessions: [],
            inspection_guidance:
              "Use sessions_list only to choose a session key. Do not treat this control-plane lookup as source evidence.",
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "sessions_send timed out after 45s",
        isError: true,
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await assert.rejects(
    () =>
      generator.generate({
        activation: buildActivation(),
        packet: buildPacket(),
      }),
    /final synthesis provider unavailable/,
  );
  assert.equal(gatewayCalls, 3);
});

test("llm role response generator rethrows abort errors instead of local evidence closeout", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async () => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-fetch", "explore_run", {
        instruction: "Fetch the orchestration source.",
      });
    }
    const error = new Error("operation aborted");
    error.name = "AbortError";
    throw error;
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "explore_run",
          description: "Fetch one source",
          inputSchema: {
            type: "object",
            properties: { instruction: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          summary: "Verified source evidence.",
          payload: { content: "Verified source evidence." },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await assert.rejects(
    () =>
      generator.generate({
        activation: buildActivation(),
        packet: buildPacket(),
      }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("llm role response generator stores evidence-first trace content for oversized session results", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalls = 0;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayCalls += 1;
    if (gatewayCalls === 1) {
      return toolCallResult("toolu-done", "sessions_spawn", {
        agent_id: "explore",
        task: "Research release risk and return evidence.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Final release-risk note.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
          session_key: "worker:explore:task-1:toolu-done",
          agent_id: "explore",
          label: "fetch-cancel-resume-fixture",
          status: "completed",
          tool_chain: ["explore"],
          result: "Large raw page snapshot. ".repeat(700),
          final_content: [
            "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal.",
            "Long browser-rendered evidence detail. ".repeat(500),
          ].join(" "),
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: [
              "Verified owner: Release Captain. Verified risk: runbook gap. Mitigation: rollback rehearsal.",
              "Browser screenshot and DOM evidence detail. ".repeat(250),
            ].join(" "),
            artifactIds: [
              "artifact-browser-snapshot",
              "artifact-browser-screenshot",
            ],
            screenshotPaths: ["/tmp/browser-artifacts/final.png"],
            rawHtml: "<html>".repeat(5000),
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

  const trace = result.metadata?.toolUse as
    | {
        rounds?: Array<{
          results?: Array<{
            content?: string;
            contentTruncated?: boolean;
            contentBytes?: number;
          }>;
        }>;
      }
    | undefined;
  const traceResult = trace?.rounds?.[0]?.results?.[0];
  assert.ok(traceResult?.content);
  assert.equal(traceResult.contentTruncated, true);
  assert.ok(
    (traceResult.contentBytes ?? 0) >
      Buffer.byteLength(traceResult.content, "utf8"),
  );
  assert.ok(Buffer.byteLength(traceResult.content, "utf8") <= 8 * 1024);
  assert.match(traceResult.content, /final_content/);
  assert.match(traceResult.content, /Release Captain/);
  assert.match(traceResult.content, /runbook gap/);
  assert.match(traceResult.content, /rollback rehearsal/);
  const compacted = JSON.parse(traceResult.content) as {
    evidence_excerpt?: string;
    payload?: { artifactIds?: string[]; screenshotPaths?: string[] };
  };
  assert.match(compacted.evidence_excerpt ?? "", /Release Captain/);
  assert.match(compacted.evidence_excerpt ?? "", /runbook gap/);
  assert.deepEqual(compacted.payload?.artifactIds, [
    "artifact-browser-snapshot",
    "artifact-browser-screenshot",
  ]);
  assert.deepEqual(compacted.payload?.screenshotPaths, [
    "/tmp/browser-artifacts/final.png",
  ]);
  assert.doesNotMatch(traceResult.content, /<html><html>/);
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: "Verified: yes.",
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

  assert.equal(result.content, "Short final was accepted.");
  assert.equal(gatewayInputs.length, 2);
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("Verified: yes."),
    ),
  );
});

test("llm role response generator redacts forbidden local URLs after completed sub-agent synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-done-url", "sessions_spawn", {
        agent_id: "explore",
        task: "Research local fixtures and return final evidence.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "residual risk: pricing remains source-bounded to http://127.0.0.1:50433/vendor-alpha and localhost.",
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
          session_key: "worker:explore:task-1:toolu-done-url",
          agent_id: "explore",
          status: "completed",
          result: "Verified local fixture evidence.",
          final_content:
            "Vendor Alpha came from http://127.0.0.1:50433/vendor-alpha.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content:
              "Vendor Alpha came from http://127.0.0.1:50433/vendor-alpha.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Return source names only. Do not include source URLs in the final answer.",
      outputContract: "Do not use tables, links, code fences, or bold markup.",
    },
  });

  assert.equal(
    result.content,
    "residual risk: pricing remains source-bounded to local fixture source and localhost.",
  );
  assert.doesNotMatch(result.content, /https?:\/\//i);
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[1])?.includes(
      "Preserve source URLs only when the original user did not forbid links or source URLs",
    ),
  );
});

test("llm role response generator keeps browser recovery visible after completed sub-agent synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_send", {
        session_key: "worker:browser:task-1:toolu-browser",
        message:
          "Continue the dashboard review after the prior browser session was unavailable.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Queue depth is 11, SLA breaches are 3, and the Incident Commander remains the owner.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
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
          session_key: "worker:browser:task-1:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "Browser recovery metadata: Resume mode: warm. Session ID: browser-session-recovered. Queue depth: 11.",
          final_content:
            "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            browserRecovery: {
              resumeMode: "warm",
              sessionId: "browser-session-recovered",
              summary:
                "Browser recovery metadata: Resume mode: warm. Session ID: browser-session-recovered.",
            },
            content:
              "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Task brief:",
        "Continue the operations dashboard review from the same browser-backed work.",
        "The earlier browser session may no longer be available; recover by reopening the same read-only dashboard when needed.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Queue depth is 11/);
  assert.match(
    result.content,
    /Browser continuity: browser context was recovered/i,
  );
  assert.match(result.content, /resume mode: warm/i);
  const synthesisPrompt = finalSynthesisPrompt(gatewayInputs[1]) ?? "";
  assert.match(synthesisPrompt, /browser continuity metadata/i);
  assert.match(synthesisPrompt, /Browser recovery metadata: Resume mode: warm/);
});

test("llm role response generator keeps cold recreation visible from child final content", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_send", {
        session_key: "worker:browser:task-1:toolu-browser",
        message:
          "Reopen the same dashboard after the browser session was unavailable.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Queue depth is 11, SLA breaches are 3, and the Incident Commander remains the owner.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
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
          session_key: "worker:browser:task-1:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Recovered rendered dashboard evidence.",
          final_content:
            "Recovery performed: Cold recreation of browser session. New session `browser-session-new` established after prior session interruption. Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Continue the operations dashboard review from the same browser-backed work.",
        "The earlier browser session may no longer be available; recover by reopening the same read-only dashboard when needed.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Queue depth is 11/);
  assert.match(result.content, /Browser continuity:/);
  assert.match(result.content, /cold|new session/i);
  const synthesisPrompt = finalSynthesisPrompt(gatewayInputs[1]) ?? "";
  assert.match(synthesisPrompt, /cold recreation/i);
  assert.match(synthesisPrompt, /browser-session-new/);
});

test("llm role response generator does not treat generic recovery wording as cold session visibility", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_send", {
        session_key: "worker:browser:task-1:toolu-browser",
        message:
          "Recover and reopen the operations dashboard after the previous browser session was unavailable.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Operations Dashboard recovery verified queue depth 11 and SLA breaches 3.",
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
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
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
          session_key: "worker:browser:task-1:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Recovered rendered dashboard evidence.",
          final_content:
            "Recovery performed: Cold recreation of browser session. New session `browser-session-new` established after prior session interruption. Queue depth: 11. SLA breaches: 3.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content: "Queue depth: 11. SLA breaches: 3.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Recover the previous browser-backed dashboard review and explain browser continuity if a new session was required.",
    },
  });

  assert.match(result.content, /Operations Dashboard recovery verified/);
  assert.match(result.content, /Browser continuity:/);
  assert.match(result.content, /cold|new session/i);
});

test("llm role response generator preserves Chinese exact three-line final shape when browser recovery metadata exists", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open the dynamic page, click Start, and wait for Hello World.",
      });
    }
    return {
      text: "✅ success\nHello World!\nhttps://the-internet.herokuapp.com/dynamic_loading/1",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
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
          session_key: "worker:browser:task:TASK-1:call_function_browser_1",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Hello World rendered.",
          final_content: "Hello World rendered at https://the-internet.herokuapp.com/dynamic_loading/1.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            browserRecovery: {
              resumeMode: "warm",
              sessionId: "browser-session-recovered",
              summary: "Browser recovery metadata: Resume mode: warm. Session ID: browser-session-recovered.",
            },
            content: "Hello World rendered at https://the-internet.herokuapp.com/dynamic_loading/1.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Dynamic browser rendered evidence after browser timeout recovery fix\n\n请用浏览器打开 https://the-internet.herokuapp.com/dynamic_loading/1，点击 Start，等待页面显示 Hello World! 后，只回答三行：状态、最终可见文本、证据 URL。",
    },
  });

  assert.equal(
    result.content,
    "状态: ✅ success\n最终可见文本: Hello World!\n证据 URL: https://the-internet.herokuapp.com/dynamic_loading/1",
  );
  assert.doesNotMatch(result.content, /Browser continuity/i);
});

test("llm role response generator normalizes markdown labels in Chinese exact three-line final shape", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open the dynamic page, click Start, and wait for Hello World.",
      });
    }
    return {
      text: [
        "**状态:** 成功",
        "**最终可见文本:** Hello World!",
        "**证据 URL:** https://the-internet.herokuapp.com/dynamic_loading/1",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
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
          session_key: "worker:browser:task:TASK-1:call_function_browser_1",
          agent_id: "browser",
          status: "completed",
          final_content: "Hello World rendered at https://the-internet.herokuapp.com/dynamic_loading/1.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content: "Hello World rendered at https://the-internet.herokuapp.com/dynamic_loading/1.",
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "请用浏览器打开 https://the-internet.herokuapp.com/dynamic_loading/1，点击 Start，等待页面显示 Hello World! 后，只回答三行：状态、最终可见文本、证据 URL。",
    },
  });

  assert.equal(
    result.content,
    "状态: 成功\n最终可见文本: Hello World!\n证据 URL: https://the-internet.herokuapp.com/dynamic_loading/1",
  );
});

test("llm role response generator keeps browser timeout recovery visible after completed sub-agent synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Review the dashboard and close out if CDP times out.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Dashboard verified queue depth 11. Browser continuity: session closed cleanly; no reconnection needed.",
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: "worker:browser:task-timeout:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result:
            "cdp_command_timeout: browser snapshot CDP command timed out while capturing rendered page evidence. Queue depth: 11.",
          final_content: "Queue depth: 11.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            browserRecovery: {
              summary:
                "cdp_command_timeout: browser snapshot CDP command timed out while capturing rendered page evidence.",
            },
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Review this operations dashboard as a user would see it in the browser. If the browser times out, close out with what was verified and what remains unverified.",
    },
  });

  assert.match(result.content, /cdp_command_timeout/);
  assert.match(result.content, /timed out/);
});

test("llm role response generator appends bounded browser limitation when completed evidence carries a CDP timeout bucket", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Review the dashboard and close out if CDP capture times out.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: [
        "Operations dashboard verified queue depth 11 and SLA breaches 3.",
        "Recommended owner: Incident Commander.",
        "Next action: confirm live production data before treating the fixture as authoritative.",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: "worker:browser:task-timeout:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          evidence_summary:
            "Browser failure buckets: attach_failed=1, cdp_command_timeout=1.",
          result:
            "Browser observed Operations Dashboard Fixture. Browser failure buckets: attach_failed=1, cdp_command_timeout=1.",
          final_content:
            "Operations dashboard verified queue depth 11, SLA breaches 3, and recommended owner Incident Commander.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            failureBuckets: [
              { bucket: "attach_failed", count: 1 },
              { bucket: "cdp_command_timeout", count: 1 },
            ],
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Review this operations dashboard as a user would see it in the browser. If the browser times out while capturing rendered page evidence, close out with what was verified and what remains unverified.",
    },
  });

  assert.match(result.content, /cdp_command_timeout/);
  assert.match(result.content, /attach_failed/);
  assert.match(result.content, /bounded to recovered browser evidence/);
  assert.match(result.content, /longer timeout/);
});

test("llm role response generator surfaces browser bucket visibility from raw session payload metadata", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Review the dashboard and close out if CDP capture times out.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: [
        "Verified queue depth 11 and SLA breaches 3.",
        "Recommended owner: Incident Commander.",
        "Next action: inspect additional panels if those details matter.",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-timeout",
          session_key: "worker:browser:task-timeout:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser observed Operations Dashboard Fixture.",
          final_content:
            "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            metadata: {
              toolUse: {
                rounds: [
                  {
                    round: 1,
                    progress: [
                      {
                        toolName: "browser_snapshot",
                        toolCallId: "browser-tool-1",
                        phase: "failed",
                        summary: "CDP capture timed out.",
                        detail: {
                          failureBuckets: [
                            { bucket: "cdp_command_timeout", count: 1 },
                          ],
                        },
                      },
                    ],
                    results: [],
                  },
                ],
              },
            },
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Review this operations dashboard as a user would see it in the browser. If browser CDP capture times out, keep the limitation visible.",
    },
  });

  assert.match(result.content, /cdp_command_timeout/);
  assert.match(result.content, /bounded to recovered browser evidence/);
});

test("llm role response generator does not treat generic unverified browser wording as detached-target closeout", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Review the dashboard and close out if the browser target detaches.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: [
        "## Ops Dashboard Browser Review — Closeout",
        "Verified queue depth 11 and SLA breaches 3.",
        "Recommended owner: Incident Commander.",
        "What remains unverified: full DOM structure beyond the single metric readout.",
        "Next action: re-run a targeted browser snapshot if structural verification matters.",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-detached",
          session_key: "worker:browser:task-detached:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          evidence_summary: "Browser failure buckets: detached_target=1.",
          result:
            "Browser observed Operations Dashboard Fixture. Browser failure buckets: detached_target=1.",
          final_content:
            "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            failureBuckets: [{ bucket: "detached_target", count: 1 }],
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Review this operations dashboard as a user would see it in the browser. If the browser target detaches while capturing the rendered page, close out with what was verified and what remains unverified.",
    },
  });

  assert.match(result.content, /browser target detached/i);
  assert.match(result.content, /detached_target/);
  assert.match(result.content, /bounded target evidence/i);
});

test("llm role response generator does not mark recovered browser evidence unverified for wait timeouts", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Review the rendered fixture and report browser evidence.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: [
        "Rendered fixture review completed.",
        "Browser fixture evidence: confirmation marker TURNKEYAI_APPROVAL_FIXTURE_OK, final URL http://127.0.0.1:49991/approval-form, screenshot browser-session/01-post-submit-page-state.png, and success text were observed.",
        "Residual risk: local fixture only.",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-rendered",
          session_key: "worker:browser:task-rendered:toolu-browser",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          evidence_summary: "Browser failure buckets: wait_condition_timeout=1.",
          result:
            "Browser observed rendered fixture; marker TURNKEYAI_APPROVAL_FIXTURE_OK and screenshot were observed. Browser failure buckets: wait_condition_timeout=1.",
          final_content:
            "Rendered fixture completed; marker TURNKEYAI_APPROVAL_FIXTURE_OK, final URL, screenshot, and success text were observed.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            failureBuckets: [{ bucket: "wait_condition_timeout", count: 1 }],
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
    packet: {
      ...buildPacket(),
      taskPrompt:
        "Review this rendered fixture as a user would see it in the browser. If browser wait_condition_timeout occurs, keep the limitation visible.",
    },
  });

  assert.match(result.content, /wait_condition_timeout/);
  assert.match(result.content, /bounded to recovered browser evidence/);
  assert.doesNotMatch(result.content, /rendered page content remains unverified/i);
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
          {
            id: "toolu-done",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "Return evidence." },
          },
          {
            id: "toolu-timeout",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "Slow browser work." },
          },
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: "Completed source-backed answer.",
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

  assert.equal(result.content, "Final from completed evidence.");
  assert.ok(
    gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes(
          "completed delegated session evidence",
        ),
    ),
  );
  assert.ok(
    !gatewayInputs[1]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes(
          "No usable evidence was gathered before the timeout",
        ),
    ),
  );
});

test("llm role response generator reroutes private URL research spawns to browser", async () => {
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return {
        text: "Checking the local vendor page.",
        toolCalls: [
          {
            id: "toolu-local-source",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "Vendor Alpha",
              task: "Fetch http://192.168.1.25/vendor-alpha and extract pricing, strengths, and risks.",
            },
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
      text: "Vendor Alpha pricing is $19 per seat. Evidence came from the rendered browser page.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-local-source",
          session_key: "worker:browser:task-local-source:toolu-local-source",
          agent_id: input.call.input.agent_id,
          status: "completed",
          tool_chain: [input.call.input.agent_id],
          result:
            "Browser rendered evidence: Vendor Alpha pricing is $19 per seat.",
          final_content: "Vendor Alpha pricing is $19 per seat.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Vendor Alpha pricing is $19 per seat.",
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
    packet: {
      ...buildPacket(),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.equal(executedCalls[0]?.input.agent_id, "browser");
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /192\.168\.1\.25\/vendor-alpha/,
  );
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /local\/private URL source/i,
  );
  assert.match(result.content, /\$19 per seat/);
});

test("llm role response generator reroutes loopback web_fetch calls to browser sessions", async () => {
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-web-fetch-local", "web_fetch", {
        url: "http://127.0.0.1:50123/vendor-alpha",
      });
    }
    assert.equal(input.toolChoice, "none");
    return {
      text: "Final answer from browser-local source evidence.",
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
          name: "web_fetch",
          description: "Fetch a public URL",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string" } },
          },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              task: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_spawn");
      assert.equal(input.call.input.agent_id, "browser");
      assert.match(
        String(input.call.input.task),
        /http:\/\/127\.0\.0\.1:50123\/vendor-alpha/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-local-source",
          session_key: "worker:browser:task-local-source:toolu-web-fetch-local",
          agent_id: "browser",
          status: "completed",
          tool_chain: ["browser"],
          result: "Browser inspected loopback source safely.",
          final_content: "Browser inspected loopback source safely.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content: "Browser inspected loopback source safely.",
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
    packet: {
      ...buildPacket(),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
      taskPrompt:
        "Compare the local Vendor Alpha source with the local Vendor Beta source using collected evidence.",
    },
  });

  assert.equal(result.content, "Final answer from browser-local source evidence.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn"],
  );
});

test("llm role response generator keeps loopback read-only source extraction on explore", async () => {
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-local-source", "sessions_spawn", {
        agent_id: "explore",
        label: "Local fixture source",
        task: "Fetch http://127.0.0.1:49152/vendor-alpha and extract observed facts.",
      });
    }
    return {
      text: "Local fixture source checked through explore.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-local-source",
          session_key: "worker:explore:task-local-source:toolu-local-source",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "Explore fetched local fixture evidence.",
          final_content: "Explore fetched local fixture evidence.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Explore fetched local fixture evidence.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.equal(executedCalls[0]?.input.agent_id, "explore");
  assert.doesNotMatch(
    String(executedCalls[0]?.input.task ?? ""),
    /local\/private URL source/i,
  );
});

test("llm role response generator collapses duplicate bounded timeout source spawns", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return {
        text: "Starting a bounded slow-source probe.",
        toolCalls: [
          {
            id: "toolu-slow-explore",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "slow source",
              task: "Fetch http://127.0.0.1:49152/slow-fixture for a release-risk note with a bounded attempt.",
            },
          },
          {
            id: "toolu-slow-browser",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "slow source",
              task: "Open http://127.0.0.1:49152/slow-fixture for the same release-risk note with a bounded attempt.",
            },
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
      text: "The slow source timed out; verified facts are bounded and residual risk remains.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-slow-source",
          session_key: "worker:explore:task-slow-source:toolu-slow-explore",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "The slow source timed out; no body was verified.",
          final_content: "The slow source timed out; no body was verified.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "No body was verified.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        taskPrompt: [
          "Evaluate this slow source for a release-risk note.",
          "Slow source: http://127.0.0.1:49152/slow-fixture",
          "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available.",
        ].join("\n"),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }

  assert.ok(executedCalls.length <= 2);
  assert.equal(executedCalls[0]?.input.agent_id, "explore");
  assert.match(String(executedCalls[0]?.input.task ?? ""), /slow-fixture/);
});

test("llm role response generator reroutes non-browser bounded timeout source spawns to explore", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-slow-browser", "sessions_spawn", {
        agent_id: "browser",
        label: "Slow source risk assessment",
        timeout_seconds: 0.001,
        task: "Evaluate http://127.0.0.1:49152/slow-fixture for a release-risk note. Use a bounded attempt.",
      });
    }
    return {
      text: "The slow source timed out; verified facts are bounded and residual risk remains.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-slow-source",
          session_key: "worker:explore:task-slow-source:toolu-slow-browser",
          agent_id: input.call.input.agent_id,
          status: "timeout",
          result: "The slow source timed out.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Timeout.",
          },
        }),
        isError: true,
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        taskPrompt: [
          "Evaluate this slow source for a release-risk note.",
          "Slow source: http://127.0.0.1:49152/slow-fixture",
          "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available.",
        ].join("\n"),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }

  assert.ok(executedCalls.length <= 2);
  assert.equal(executedCalls[0]?.input.agent_id, "explore");
  assert.equal(executedCalls[0]?.input.timeout_seconds, 0.001);
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /bounded source-check/,
  );
});

test("llm role response generator keeps browser duplicate for bounded browser-visible timeout source", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return {
        text: "Starting a bounded browser-visible slow page probe.",
        toolCalls: [
          {
            id: "toolu-slow-explore",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "slow rendered page",
              task: "Fetch http://127.0.0.1:49152/slow-fixture as an operator would see it.",
            },
          },
          {
            id: "toolu-slow-browser",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "slow rendered page",
              task: "Open http://127.0.0.1:49152/slow-fixture as an operator would see it.",
            },
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
      text: "The browser-visible source timed out; rendered evidence remains unverified.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-slow-browser",
          session_key: "worker:browser:task-slow-browser:toolu-slow-browser",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "The browser-visible source timed out.",
          final_content: "The browser-visible source timed out.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Rendered evidence remains unverified.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        taskPrompt: [
          "Evaluate this slow browser-visible source for a release-risk note.",
          "Slow source: http://127.0.0.1:49152/slow-fixture",
          "Use a bounded attempt first and inspect the rendered page as an operator would see it.",
        ].join("\n"),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }

  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0]?.input.agent_id, "browser");
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /browser-visible URL source|operator would see/i,
  );
});

test("llm role response generator keeps browser-visible loopback tasks on the browser path in fixture mode", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-complex-page", "sessions_spawn", {
        agent_id: "explore",
        label: "Complex browser page",
        task: "Review http://127.0.0.1:49152/complex-browser as an operator would see it. Inspect the rendered DOM, embedded frame, shadow component, and details popup.",
      });
    }
    return {
      text: "Browser evidence includes the frame, shadow component, and popup state.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-complex-page",
          session_key: "worker:browser:task-complex-page:toolu-complex-page",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result:
            "Frame panel: backlog 7. Shadow review: risk desk approval required. Popup P-42 manager acknowledgement opened.",
          final_content:
            "Frame panel: backlog 7. Shadow review: risk desk approval required. Popup P-42 manager acknowledgement opened.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content:
              "Frame panel: backlog 7. Shadow review: risk desk approval required. Popup P-42 manager acknowledgement opened.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    const result = await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        taskPrompt: [
          "Review this complex browser page as an operator would see it.",
          "Page: http://127.0.0.1:49152/complex-browser",
          "The page combines an embedded source frame, a shadow-style review component, and a details popup workflow.",
        ].join("\n"),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
    assert.equal(executedCalls[0]?.input.agent_id, "browser");
    assert.match(
      String(executedCalls[0]?.input.task ?? ""),
      /browser-visible URL source/i,
    );
    assert.match(result.content, /frame, shadow component, and popup/i);
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }
});

test("llm role response generator keeps live signal dashboard loopback tasks on the browser path in fixture mode", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-product-signals", "sessions_spawn", {
        agent_id: "browser",
        label: "product-signals dashboard",
        task: "Navigate to http://127.0.0.1:49152/product-signals and extract all visible live signal data, metrics, dashboards, or real-time indicators shown on the page.",
      });
    }
    return {
      text: "Rendered live signal dashboard evidence complete.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-product-signals",
          session_key:
            "worker:browser:task-product-signals:toolu-product-signals",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "Stuck missions: 6. Weak answer rate: 24%.",
          final_content: "Stuck missions: 6. Weak answer rate: 24%.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Stuck missions: 6. Weak answer rate: 24%.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        taskPrompt: [
          "Prepare a brief from three independent evidence streams.",
          "Live signal dashboard: http://127.0.0.1:49152/product-signals",
          "Use browser-visible evidence for the live signal dashboard.",
        ].join("\n"),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }

  assert.equal(executedCalls[0]?.input.agent_id, "browser");
  assert.doesNotMatch(
    String(executedCalls[0]?.input.task ?? ""),
    /Use the explore worker for this bounded source-check/,
  );
});

test("llm role response generator keeps rendered-value recovery loopback tasks on the browser path in fixture mode", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-rendered-values", "sessions_spawn", {
        agent_id: "browser",
        label: "Signal Dashboard - Browser Rendered",
        task: [
          "Navigate to http://127.0.0.1:49152/product-signals and wait for the page to fully render.",
          "Then extract and return exactly:",
          '1. The "Stuck missions" counter value (exact number visible)',
          '2. The "Weak answer rate" value (exact percentage or number visible)',
          '3. The "recommended next action" text (exact label visible)',
          "Do not stop after navigation; this requires rendered values.",
        ].join("\n"),
      });
    }
    return {
      text: "Rendered values: Stuck missions 6; Weak answer rate 24%.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-rendered-values",
          session_key:
            "worker:browser:task-rendered-values:toolu-rendered-values",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "Stuck missions: 6. Weak answer rate: 24%.",
          final_content: "Stuck missions: 6. Weak answer rate: 24%.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Stuck missions: 6. Weak answer rate: 24%.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        taskPrompt: [
          "Continue after a late browser session and recover missing rendered values.",
          "Source: http://127.0.0.1:49152/product-signals",
          "Use a bounded attempt first and inspect rendered values on the page.",
        ].join("\n"),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }

  assert.equal(executedCalls[0]?.input.agent_id, "browser");
  assert.doesNotMatch(
    String(executedCalls[0]?.input.task ?? ""),
    /Use the explore worker for this bounded source-check/,
  );
});

test("llm role response generator does not reroute explicitly static loopback fixtures to browser", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-static-page", "sessions_spawn", {
        agent_id: "explore",
        label: "Static fixture source",
        task: "Fetch http://127.0.0.1:49152/static-fixture. This is static HTML only with no JavaScript-rendered content required.",
      });
    }
    return {
      text: "Static fixture source checked through explore.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-static-page",
          session_key: "worker:explore:task-static-page:toolu-static-page",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "Explore fetched static fixture evidence.",
          final_content: "Explore fetched static fixture evidence.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Explore fetched static fixture evidence.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        taskPrompt: [
          "Review this static source fixture.",
          "Source: http://127.0.0.1:49152/static-fixture",
          "This is static HTML only with no JavaScript-rendered content required.",
        ].join("\n"),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }

  assert.equal(executedCalls[0]?.input.agent_id, "explore");
  assert.doesNotMatch(
    String(executedCalls[0]?.input.task ?? ""),
    /local\/private URL source/i,
  );
});

test("llm role response generator repairs browser-visible final answers that skip browser evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const latestMessageText = readToolContent(
      input.messages.at(-1)?.content ?? "",
    );
    if (
      latestMessageText.includes(
        "Runtime correction: browser-visible evidence is missing",
      )
    ) {
      return toolCallResult("toolu-browser-evidence", "sessions_spawn", {
        agent_id: "browser",
        label: "Complex browser page",
        task: "Open http://127.0.0.1:49152/complex-browser and inspect the rendered frame, shadow component, and popup state.",
      });
    }
    if (input.messages.some((message) => message.role === "tool")) {
      return {
        text: "Frame panel shows backlog 7, the shadow review says risk desk approval required, and popup P-42 is open for manager acknowledgement.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "I used raw HTTP fetch because the browser tools are unavailable, so the rendered DOM, frame, shadow component, and popup were not verified.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser-evidence",
          session_key:
            "worker:browser:task-browser-evidence:toolu-browser-evidence",
          agent_id: input.call.input.agent_id,
          status: "completed",
          evidence_summary:
            "Frame panel: backlog 7. Shadow review: risk desk approval required. Popup P-42 manager acknowledgement opened.",
          result:
            "Frame panel: backlog 7. Shadow review: risk desk approval required. Popup P-42 manager acknowledgement opened.",
          final_content:
            "Frame panel: backlog 7. Shadow review: risk desk approval required. Popup P-42 manager acknowledgement opened.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content:
              "Frame panel: backlog 7. Shadow review: risk desk approval required. Popup P-42 manager acknowledgement opened.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Review this complex browser page as an operator would see it.",
        "Page: http://127.0.0.1:49152/complex-browser",
        "The page combines an embedded source frame, a shadow-style review component, and a details popup workflow.",
        "Open the details popup, then summarize the visible operational state, owner, approval requirement, and residual risk.",
      ].join("\n"),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.equal(executedCalls[0]?.input.agent_id, "browser");
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /rendered frame, shadow component, and popup state/i,
  );
  assert.ok(
    gatewayInputs.some(
      (input) =>
        input.toolChoice &&
        JSON.stringify(input.toolChoice).includes("sessions_spawn"),
    ),
    "browser-evidence repair should force sessions_spawn",
  );
  assert.match(result.content, /Frame panel shows backlog 7/i);
  assert.doesNotMatch(
    result.content,
    /raw HTTP fetch because the browser tools are unavailable/i,
  );
});

test("llm role response generator bounds browser-evidence repair for slow loopback timeout follow-up", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const latestMessageText = readToolContent(
      input.messages.at(-1)?.content ?? "",
    );
    if (
      latestMessageText.includes(
        "Runtime correction: browser-visible evidence is missing",
      )
    ) {
      assert.match(
        latestMessageText,
        /resumed timeout evidence is still content-poor/i,
      );
      assert.match(latestMessageText, /browser_open with timeout_ms 10000/i);
      return toolCallResult("toolu-browser-timeout-repair", "sessions_spawn", {
        agent_id: "browser",
        label: "Browser probe of slow-fixture",
        task: "Open http://127.0.0.1:49152/slow-fixture and report whether rendered evidence appears.",
      });
    }
    if (input.messages.some((message) => message.role === "tool")) {
      return {
        text: "Browser probe returned bounded negative evidence: page.goto timed out before domcontentloaded; status, headers, body, and rendered marker remain unverified.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "The rendered DOM and browser page state were not verified because the browser worker failed at the runtime limit.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string", enum: ["browser", "explore"] },
              label: { type: "string" },
              timeout_seconds: { type: "number" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.input.agent_id, "browser");
      assert.equal(input.call.input.timeout_seconds, 45);
      assert.match(
        String(input.call.input.task),
        /Supplemental local timeout probe mode/i,
      );
      assert.match(
        String(input.call.input.task),
        /browser_open with timeout_ms 10000/i,
      );
      assert.match(
        String(input.call.input.task),
        /http:\/\/127\.0\.0\.1:49152\/slow-fixture/,
      );
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser-timeout-repair",
          session_key:
            "worker:browser:task-browser-timeout-repair:toolu-browser-timeout-repair",
          agent_id: "browser",
          status: "completed",
          evidence_summary:
            "Final URL http://127.0.0.1:49152/slow-fixture; transport_failure page.goto Timeout 10000ms exceeded before domcontentloaded.",
          result: "Browser bounded negative evidence.",
          final_content:
            "Browser bounded negative evidence: page.goto Timeout 10000ms exceeded before domcontentloaded; status, headers, body, and rendered marker remain unverified.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content:
              "Browser bounded negative evidence: page.goto Timeout 10000ms exceeded before domcontentloaded; status, headers, body, and rendered marker remain unverified.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Evaluate this slow browser-visible source for a release-risk note.",
        "Slow source: http://127.0.0.1:49152/slow-fixture",
        "Use a bounded timeout attempt first. If the source does not return in time, close out with evidence that is available.",
        "If a follow-up resumes the same source-check context and evidence remains content-poor, inspect the rendered page as an operator would see it.",
      ].join("\n"),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.ok(executedCalls.length <= 2);
  assert.match(result.content, /bounded negative evidence/i);
  assert.ok(
    gatewayInputs.some(
      (input) =>
        input.toolChoice &&
        JSON.stringify(input.toolChoice).includes("sessions_spawn"),
    ),
    "browser-evidence repair should still force sessions_spawn",
  );
});

test("llm role response generator does not repeat browser-evidence repair after a prior browser attempt", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: [
        "The slow source reached HTTP 200 after continuation and returned release-risk evidence.",
        "Rendered browser evidence remains unverified because the prior browser session timed out before DOM capture.",
        "Residual risk: keep this timeout-gated and rerun with a longer browser timeout only if rendered DOM details become release-blocking.",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "unexpected browser repair",
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });
  const activation = buildActivation();
  activation.handoff.payload.intent = {
    relayBrief:
      activation.handoff.payload.intent?.relayBrief ?? "Handle the task.",
    instructions: activation.handoff.payload.intent?.instructions ?? "",
    recentMessages: [
      {
        messageId: "msg-prior-browser-timeout",
        role: "tool",
        name: "sessions_spawn",
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-browser-timeout",
          session_key:
            "worker:browser:task-browser-timeout:toolu-browser-timeout",
          agent_id: "browser",
          status: "timeout",
          timeout_seconds: 10,
          evidence_available: false,
          tool_chain: ["browser_open"],
          result:
            "Browser session timed out before rendered DOM evidence was captured.",
          final_content: null,
          payload: null,
        }),
        createdAt: 1,
      } satisfies TeamMessageSummary,
    ],
  };

  const priorBrowserAttempt = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-browser-timeout",
    session_key:
      "worker:browser:task-browser-timeout:toolu-browser-timeout",
    agent_id: "browser",
    status: "timeout",
    timeout_seconds: 10,
    evidence_available: false,
    tool_chain: ["browser_open"],
    result:
      "Browser session timed out before rendered DOM evidence was captured.",
    final_content: null,
    payload: null,
  });

  const result = await generator.generate({
    activation,
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Evaluate this slow browser-visible source for a release-risk note.",
        "Slow source: http://127.0.0.1:49152/slow-fixture",
        "Use browser-visible evidence when available, but keep a bounded timeout closeout if the browser attempt already timed out.",
        `Worker evidence:\n${priorBrowserAttempt}`,
      ].join("\n"),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.equal(executedCalls.length, 0);
  assert.equal(gatewayInputs.length, 1);
  assert.match(result.content, /HTTP 200 after continuation/);
  assert.match(result.content, /Rendered browser evidence remains unverified/);
});

test("llm role response generator repairs browser final synthesis that drops requested frame and shadow evidence", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let repairPrompt = "";
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-complex-page", "sessions_spawn", {
        agent_id: "browser",
        task: "Open http://127.0.0.1:49152/complex-browser and inspect the rendered frame, shadow component, and popup state.",
      });
    }
    if (gatewayInputs.length === 2) {
      return {
        text: [
          "Operational state: popup opened; packet P-42 active in drill workflow.",
          "Owner: Frame Captain.",
          "Approval requirement: manager acknowledgement required for packet P-42.",
          "Residual risk: local complex browser fixture only.",
          "Not verified: frame source URL and audit trail.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    repairPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    return {
      text: [
        "Operational state: popup opened; packet P-42 is active in the drill workflow.",
        "Embedded source frame: Frame panel shows backlog 7 and owner Frame Captain.",
        "Shadow review component: risk desk approval required.",
        "Details popup: packet P-42 requires manager acknowledgement.",
        "Residual risk: local complex browser fixture only; audit trail and external exposure remain not verified.",
      ].join("\n"),
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
          description: "Spawn a browser sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-complex-browser",
          session_key: "worker:browser:task-complex-browser:toolu-complex-page",
          agent_id: "browser",
          status: "completed",
          result: [
            "Frame panel: backlog 7, owner Frame Captain.",
            "Shadow review: risk desk approval required.",
            "Popup drill opened: packet P-42 requires manager acknowledgement.",
          ].join("\n"),
          evidence_summary: [
            "Frame panel: backlog 7, owner Frame Captain.",
            "Shadow review: risk desk approval required.",
            "Popup drill opened: packet P-42 requires manager acknowledgement.",
          ].join("\n"),
          final_content: [
            "Frame panel: backlog 7, owner Frame Captain.",
            "Shadow review: risk desk approval required.",
            "Popup drill opened: packet P-42 requires manager acknowledgement.",
          ].join("\n"),
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content: [
              "Frame panel: backlog 7, owner Frame Captain.",
              "Shadow review: risk desk approval required.",
              "Popup drill opened: packet P-42 requires manager acknowledgement.",
            ].join("\n"),
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Review this complex browser page as an operator would see it.",
        "Page: http://127.0.0.1:49152/complex-browser",
        "The page combines an embedded source frame, a shadow-style review component, and a details popup workflow.",
        "Open the details popup, then summarize the visible operational state, owner, approval requirement, and residual risk.",
      ].join("\n"),
    },
  });

  assert.match(repairPrompt, /omitted requested browser evidence dimensions/);
  assert.match(repairPrompt, /embedded frame source state/);
  assert.match(repairPrompt, /shadow review state/);
  assert.match(repairPrompt, /Frame panel: backlog 7, owner Frame Captain/);
  assert.match(repairPrompt, /Shadow review: risk desk approval required/);
  assert.match(
    result.content,
    /Embedded source frame: Frame panel shows backlog 7 and owner Frame Captain/,
  );
  assert.match(
    result.content,
    /Shadow review component: risk desk approval required/,
  );
  assert.ok(gatewayInputs.length >= 3);
});

test("llm role response generator repairs completed static fetch synthesis when browser-visible evidence is still missing", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("toolu-static", "sessions_spawn", {
        agent_id: "explore",
        task: "Fetch http://127.0.0.1:49152/complex-browser.",
      });
    }
    if (gatewayInputs.length === 2) {
      return {
        text: [
          "The page has an embedded source frame, shadow component wrapper, and Open details popup trigger.",
          "The explore worker uses static HTTP fetch and cannot execute JavaScript interactions, access shadow DOM content, or resolve iframe content.",
          "A live browser session is needed to verify the operational state, owner, approval requirement, and residual risk.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    if (gatewayInputs.length === 3) {
      const repairPrompt = readToolContent(
        input.messages.at(-1)?.content ?? "",
      );
      assert.match(repairPrompt, /browser-visible evidence is missing/);
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_spawn",
      });
      return toolCallResult("toolu-browser", "sessions_spawn", {
        agent_id: "browser",
        task: "Open http://127.0.0.1:49152/complex-browser and inspect the rendered frame, shadow component, and popup state.",
      });
    }
    return {
      text: [
        "Embedded source frame: Frame panel shows backlog 7 and owner Frame Captain.",
        "Shadow review component: risk desk approval required.",
        "Details popup: packet P-42 requires manager acknowledgement.",
        "Residual risk: local complex browser fixture only; external exposure remains not verified.",
      ].join("\n"),
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const isBrowser = input.call.input.agent_id === "browser";
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: isBrowser
            ? "Frame panel: backlog 7, owner Frame Captain.\nShadow review: risk desk approval required.\nPopup drill opened: packet P-42 requires manager acknowledgement."
            : "Static HTML shows an embedded source frame, shadow component wrapper, and Open details popup trigger.",
          final_content: isBrowser
            ? "Frame panel: backlog 7, owner Frame Captain.\nShadow review: risk desk approval required.\nPopup drill opened: packet P-42 requires manager acknowledgement."
            : "Static HTML shows an embedded source frame, shadow component wrapper, and Open details popup trigger.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: isBrowser
              ? "Frame panel: backlog 7, owner Frame Captain.\nShadow review: risk desk approval required.\nPopup drill opened: packet P-42 requires manager acknowledgement."
              : "Static HTML shows an embedded source frame, shadow component wrapper, and Open details popup trigger.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Review this complex browser page as an operator would see it.",
        "Page: http://127.0.0.1:49152/complex-browser",
        "The page combines an embedded source frame, a shadow-style review component, and a details popup workflow.",
        "Open the details popup, then summarize the visible operational state, owner, approval requirement, and residual risk.",
      ].join("\n"),
    },
  });

  assert.equal(executedCalls[0]?.input.agent_id, "explore");
  assert.equal(executedCalls[1]?.input.agent_id, "browser");
  assert.match(
    result.content,
    /Shadow review component: risk desk approval required/,
  );
  assert.equal(gatewayInputs.length, 4);
});

test("llm role response generator reroutes browser-visible public URL spawns to browser", async () => {
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-public-browser-page", "sessions_spawn", {
        agent_id: "explore",
        label: "Live external page",
        task: "Review https://news.ycombinator.com/ through a browser-visible pass as a user would see it.",
      });
    }
    return {
      text: "Browser-visible Hacker News evidence captured.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-public-browser-page",
          session_key:
            "worker:browser:task-public-browser-page:toolu-public-browser-page",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "Browser-visible Hacker News evidence captured.",
          final_content: "Browser-visible Hacker News evidence captured.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Browser-visible Hacker News evidence captured.",
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Review this live external page through a browser-visible pass, as a user would see it.",
        "Page: https://news.ycombinator.com/",
        "Do not rely on memory or raw server metadata alone; inspect the browser-rendered page state.",
      ].join("\n"),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.equal(executedCalls[0]?.input.agent_id, "browser");
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /browser-visible URL source/i,
  );
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /news\.ycombinator\.com/,
  );
  assert.match(result.content, /Browser-visible Hacker News evidence/);
});

test("llm role response generator keeps private non-loopback URLs on the browser path in E2E fixture mode", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return toolCallResult("toolu-mixed-source", "sessions_spawn", {
        agent_id: "explore",
        label: "Mixed fixture and private source",
        task: "Compare http://127.0.0.1:49152/vendor-alpha with http://192.168.0.10/admin and report observed facts.",
      });
    }
    return {
      text: "Mixed private source stayed on browser path.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-mixed-source",
          session_key: "worker:browser:task-mixed-source:toolu-mixed-source",
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: "Browser inspected mixed private URL source safely.",
          final_content: "Browser inspected mixed private URL source safely.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Browser inspected mixed private URL source safely.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  try {
    await generator.generate({
      activation: buildActivation(),
      packet: {
        ...buildPacket(),
        capabilityInspection: {
          availableWorkers: ["browser", "explore"],
          connectorStates: [],
          apiStates: [],
          skillStates: [],
          transportPreferences: [],
          unavailableCapabilities: [],
          generatedAt: 1,
        },
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
    } else {
      process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = previous;
    }
  }

  assert.equal(executedCalls[0]?.input.agent_id, "browser");
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /local\/private URL source/i,
  );
});

test("llm role response generator reroutes link-local and wildcard URL research spawns to browser", async () => {
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return {
        text: "Checking internal URL sources.",
        toolCalls: [
          {
            id: "toolu-ipv4-link-local",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "metadata",
              task: "Inspect http://169.254.169.254/latest/meta-data and summarize only observed facts.",
            },
          },
          {
            id: "toolu-wildcard",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "wildcard-local",
              task: "Open http://0.0.0.0:49152/vendor-alpha and extract pricing.",
            },
          },
          {
            id: "toolu-ipv6-link-local",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "ipv6-local",
              task: "Check http://[fe90::1]/vendor-alpha. and report the rendered page facts.",
            },
          },
          {
            id: "toolu-local-domain",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "local-domain",
              task: "Review http://printer.local/status and report only observed status fields.",
            },
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
      text: "Internal source checks completed through browser workers.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:browser:task-${input.call.id}:${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          tool_chain: [input.call.input.agent_id],
          result: "Browser evidence complete.",
          final_content: "Browser evidence complete.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Browser evidence complete.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.input.agent_id),
    ["browser", "browser", "browser", "browser"],
  );
  assert.match(
    String(executedCalls[0]?.input.task ?? ""),
    /169\.254\.169\.254/,
  );
  assert.match(String(executedCalls[1]?.input.task ?? ""), /0\.0\.0\.0:49152/);
  assert.match(String(executedCalls[2]?.input.task ?? ""), /\[fe90::1\]/);
  assert.match(
    String(executedCalls[3]?.input.task ?? ""),
    /printer\.local\/status/,
  );
});

test("llm role response generator keeps public URL research spawns on explore", async () => {
  const executedCalls: LLMToolCall[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (!input.messages.some((message) => message.role === "tool")) {
      return {
        text: "Checking the public source.",
        toolCalls: [
          {
            id: "toolu-public-source",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "Vendor Alpha",
              task: "Fetch https://example.com/vendor-alpha and extract pricing, strengths, and risks.",
            },
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
      text: "Public source evidence complete.",
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
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string" },
              agent_id: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-public-source",
          session_key: "worker:explore:task-public-source:toolu-public-source",
          agent_id: input.call.input.agent_id,
          status: "completed",
          tool_chain: [input.call.input.agent_id],
          result: "Explore evidence complete.",
          final_content: "Explore evidence complete.",
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id,
            content: "Explore evidence complete.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      capabilityInspection: {
        availableWorkers: ["browser", "explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.equal(executedCalls[0]?.input.agent_id, "explore");
});

test("llm role response generator continues timed-out sibling before final synthesis for coverage-critical tasks", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Calling parallel sub-agents.",
        toolCalls: [
          {
            id: "toolu-orchestration",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "orchestration",
              task: "Fetch orchestration evidence.",
            },
          },
          {
            id: "toolu-bridge",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "bridge",
              task: "Fetch bridge evidence.",
            },
          },
          {
            id: "toolu-signals",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "signals",
              task: "Inspect rendered signal dashboard.",
            },
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
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_send",
      });
      assert.ok(
        input.messages.some(
          (message) =>
            message.role === "user" &&
            readToolContent(message.content).includes(
              "required delegated evidence stream timed out",
            ),
        ),
      );
      return {
        text: "Continuing the missing source.",
        toolCalls: [
          {
            id: "toolu-continue-signals",
            name: "sessions_send",
            input: {
              session_key: "worker:browser:task-1:toolu-signals",
              message: "Return the missing rendered product signal evidence.",
            },
          },
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
      text: "Final brief with orchestration, bridge, and Stuck missions: 6; Weak answer rate: 24%.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executedCalls: LLMToolCall[] = [];
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" }, label: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.id === "toolu-signals") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          isError: true,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-1",
            session_key: "worker:browser:task-1:toolu-signals",
            agent_id: "browser",
            status: "timeout",
            timeout_seconds: 120,
            evidence_available: false,
            tool_chain: [],
            result: "No usable rendered dashboard evidence was gathered.",
            final_content: null,
            payload: null,
          }),
        };
      }
      if (input.call.name === "sessions_send") {
        assert.equal(
          input.call.input.session_key,
          "worker:browser:task-1:toolu-signals",
        );
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-1",
            session_key: "worker:browser:task-1:toolu-signals",
            agent_id: "browser",
            status: "completed",
            tool_chain: ["browser"],
            result: "Rendered dashboard verified.",
            final_content:
              "PRODUCT_SIGNAL_OK. Stuck missions: 6. Weak answer rate: 24%.",
            payload: {
              mode: "llm_sub_agent",
              workerType: "browser",
              content: "PRODUCT_SIGNAL_OK",
            },
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: `worker:explore:task-1:${input.call.id}`,
          agent_id: "explore",
          status: "completed",
          tool_chain: ["explore"],
          result: `${input.call.input.label} evidence complete.`,
          final_content: `${input.call.input.label} evidence complete.`,
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: `${input.call.input.label} evidence complete.`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief from three independent evidence streams.",
        "Research source: http://local/orchestration",
        "Capability source: http://local/bridge",
        "Live signal dashboard: http://local/signals",
        "Do not finalize until all three child session tool results have returned and all three markers are present in tool evidence.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Final brief with orchestration, bridge/);
  assert.match(result.content, /Stuck missions: 6/);
  assert.match(result.content, /Weak answer rate: 24%/);
  assert.match(result.content, /Timeout closeout: the resumed source produced source-backed evidence/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_spawn", "sessions_spawn", "sessions_send"],
  );
  assert.ok(gatewayInputs.length >= 3);
});

test("llm role response generator rewrites slow-source recovery spawn to existing timeout session send", async () => {
  const timedOutSessionKey =
    "worker:explore:task:TASK-slow-source:call_function_slow_1";
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      const firstUserMessage = readToolContent(input.messages[1]?.content ?? "");
      assert.match(firstUserMessage, /Runtime session continuation directive:/);
      assert.match(firstUserMessage, new RegExp(timedOutSessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return {
        text: "Trying a local URL fetch.",
        toolCalls: [
          {
            id: "toolu-local-fetch",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "local-url-fetch",
              task: "Open the local/private URL as a browser-visible source instead of using web_fetch.\nURL: http://127.0.0.1:63223/slow-fixture",
            },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return textResult(
      "Recovered release-risk note with source status, owner, risk, mitigation, unverified scope, residual risk, and continuation guidance.",
    );
  };
  const executedCalls: LLMToolCall[] = [];
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, label: { type: "string" }, task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" }, message: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, timedOutSessionKey);
      assert.match(String(input.call.input.message ?? ""), /same slow-source source-check context/i);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "TASK-slow-source",
          session_key: timedOutSessionKey,
          agent_id: "explore",
          status: "completed",
          result: "Slow fixture returned source-backed release-risk evidence after continuation.",
          final_content:
            "Source status: HTTP 200 after release. Owner: release runtime fixture. Risk: delayed source response. Mitigation: bounded retry and partial closeout. Residual risk: production-equivalent timing still unverified.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: "Slow fixture returned source-backed release-risk evidence after continuation.",
          },
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 16 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Original user goal (verbatim):",
        "Natural timeout follow-up continuation",
        "Evaluate this slow source for a release-risk note.",
        "Slow source: http://127.0.0.1:63223/slow-fixture",
        "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
        "",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "timeout",
          agent_id: "explore",
          label: "slow-source-evaluation",
          session_key: timedOutSessionKey,
          task_id: "TASK-slow-source",
          resumable: true,
          timeout_seconds: 60,
          evidence_available: true,
          evidence_summary: "Execution paused before the slow source produced response content.",
        }),
        "",
        "System recovery: the previous final answer did not satisfy required goal slots.",
        "Automatic recovery attempt 1 of 2.",
        "Continue the original mission instead of closing it.",
        "This recovery is for a slow-source release-risk note, not a provider comparison.",
        "Resume or retry the same slow source-check context. The required release-risk slots are: verified source/status, owner, risk, mitigation, what remains unverified, residual risk, and how to continue or retry.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_send"],
  );
  assert.ok(gatewayInputs.length >= 2);
});

test("llm role response generator continues timed-out AsiaWalk stream before final synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Starting separate AsiaWalk evidence streams.",
        toolCalls: [
          {
            id: "toolu-route",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "AsiaWalk route stream",
              task: "Check the AsiaWalk route source.",
            },
          },
          {
            id: "toolu-budget",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "AsiaWalk budget stream",
              task: "Check the AsiaWalk budget source.",
            },
          },
          {
            id: "toolu-live",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "AsiaWalk live readiness",
              task: "Inspect the live readiness dashboard as rendered browser evidence.",
            },
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
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_send",
      });
      return toolCallResult("toolu-continue-budget", "sessions_send", {
        session_key: "worker:explore:task-asiawalk:toolu-budget",
        message: "Continue the missing AsiaWalk budget stream.",
      });
    }
    assert.equal(input.toolChoice, "none");
    return textResult("AsiaWalk final with route, budget, rendered readiness, recommendation, next action, and residual risk.");
  };
  const executedCalls: LLMToolCall[] = [];
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { agent_id: { type: "string" }, label: { type: "string" }, task: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: { session_key: { type: "string" }, message: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.id === "toolu-budget") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          isError: true,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-asiawalk",
            session_key: "worker:explore:task-asiawalk:toolu-budget",
            agent_id: "explore",
            status: "timeout",
            evidence_available: false,
            result: "AsiaWalk budget stream timed out.",
            final_content: null,
          }),
        };
      }
      if (input.call.name === "sessions_send") {
        assert.equal(input.call.input.session_key, "worker:explore:task-asiawalk:toolu-budget");
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-asiawalk",
            session_key: "worker:explore:task-asiawalk:toolu-budget",
            agent_id: "explore",
            status: "completed",
            result: "Budget evidence recovered.",
            final_content: "$1,280 total with $180 contingency buffer.",
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-asiawalk",
          session_key: `worker:${input.call.input.agent_id}:task-asiawalk:${input.call.id}`,
          agent_id: input.call.input.agent_id,
          status: "completed",
          result: `${input.call.input.label} complete.`,
          final_content: `${input.call.input.label} complete.`,
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 128 },
  });

  await generator.generate({
    activation: buildActivation(),
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Route source: http://127.0.0.1:4100/asiawalk-route",
        "Budget source: http://127.0.0.1:4100/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1:4100/asiawalk-live",
        "Treat route, budget, and live readiness as separate evidence streams. Use specialist work where it helps, and inspect the live readiness dashboard as rendered browser evidence.",
        "Do not finalize until all three streams have returned.",
      ].join("\n"),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_spawn", "sessions_spawn", "sessions_send"],
  );
  assert.equal(gatewayInputs.length, 3);
});

test("llm role response generator repairs product signal final that negates completed browser counters", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Calling parallel product evidence sub-agents.",
        toolCalls: [
          {
            id: "toolu-orchestration",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "product-orchestration",
              task: "Read the product orchestration source.",
            },
          },
          {
            id: "toolu-bridge",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "product-bridge",
              task: "Read the browser bridge capability source.",
            },
          },
          {
            id: "toolu-signals",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "product-signals",
              task: "Inspect the rendered live signal dashboard.",
            },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.equal(input.toolChoice, "none");
    if (gatewayInputs.length === 2) {
      assert.ok(
        input.messages.some(
          (message) =>
            message.role === "user" &&
            readToolContent(message.content).includes(
              "Completed browser evidence verifies product signal dashboard counters: Stuck missions: 6; Weak answer rate: 24%",
            ),
        ),
      );
      return {
        text: [
          "Product brief: orchestration and bridge evidence are verified.",
          "Live signal dashboard: rendered browser evidence shows Stuck missions: 6 and Weak answer rate: 24%.",
          "Residual risk: rendered browser evidence remains unverified, so the signals fixture's counter values still need retrieval.",
        ].join("\n"),
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    assert.ok(
      input.messages.some(
        (message) =>
          message.role === "user" &&
          readToolContent(message.content).includes(
            "Missing dimensions: product signal dashboard counters",
          ),
      ),
    );
      return {
        text: [
          "Product brief: orchestration and bridge evidence are verified.",
          "Live signal dashboard: rendered browser evidence shows Stuck missions: 6; Weak answer rate: 24%.",
          "Residual risk: these counters are local fixture evidence and still need production validation.",
        ].join("\n"),
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executedCalls: LLMToolCall[] = [];
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" }, label: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const label = String(input.call.input.label ?? "");
      const isSignals = label === "product-signals";
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: `worker:${isSignals ? "browser" : "explore"}:task-1:${input.call.id}`,
          agent_id: isSignals ? "browser" : "explore",
          status: "completed",
          tool_chain: isSignals ? ["browser_open", "browser_snapshot"] : ["explore"],
          result: isSignals
            ? "Rendered dashboard counters verified."
            : `${label} evidence verified.`,
          final_content: isSignals
            ? "Rendered browser evidence: Live signal dashboard shows Stuck missions: 6 and Weak answer rate: 24%. Recommended next action: inspect stuck mission owners."
            : `${label} evidence verified.`,
          payload: {
            mode: "llm_sub_agent",
            workerType: isSignals ? "browser" : "explore",
            content: isSignals ? "PRODUCT_SIGNAL_OK" : `${label} evidence`,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief from three independent evidence streams.",
        "Research source: http://local/orchestration",
        "Capability source: http://local/bridge",
        "Live signal dashboard: http://local/signals",
        "Use browser-visible evidence for the live signal dashboard.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /Stuck missions: 6/);
  assert.match(result.content, /Weak answer rate: 24%/);
  assert.match(result.content, /rendered browser evidence/i);
  assert.doesNotMatch(result.content, /counters are not verified/i);
  assert.doesNotMatch(result.content, /browser evidence (?:remains )?unverified/i);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_spawn", "sessions_spawn"],
  );
  assert.ok(gatewayInputs.length >= 3);
});

test("llm role response generator does not replace product brief model finals with local canned closeouts", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Gathering product brief evidence.",
        toolCalls: [
          {
            id: "toolu-orchestration",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "product-orchestration",
              task: "Read product orchestration evidence.",
            },
          },
          {
            id: "toolu-bridge",
            name: "sessions_spawn",
            input: {
              agent_id: "explore",
              label: "product-bridge",
              task: "Read browser bridge evidence.",
            },
          },
          {
            id: "toolu-signals",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "product-signals",
              task: "Inspect rendered product signal dashboard.",
            },
          },
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
      text: [
        "MODEL_AUTHORED_PRODUCT_BRIEF",
        "Build next: make Mission Control the default entry.",
        "Why it matters: product orchestration evidence shows multi-agent decomposition with durable sub-session history.",
        "Browser bridge: controls can inspect rendered DOM after approval and collect screenshots.",
        "Rendered signals: Stuck missions: 6 and Weak answer rate: 24%.",
        "Residual risk: production telemetry and customer adoption remain unverified.",
      ].join("\n"),
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executedCalls: LLMToolCall[] = [];
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" }, label: { type: "string" } },
          },
        },
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: {
            type: "object",
            properties: { active_minutes: { type: "number" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const label = String(input.call.input.label ?? "");
      const evidence =
        label === "product-orchestration"
          ? "TURNKEYAI_PRODUCT_ORCHESTRATION_OK. Product Orchestration Evidence. Primary user story: a product lead starts one mission and receives a decision-ready brief. Strength: multi-agent decomposition with durable sub-session history."
          : label === "product-bridge"
            ? "TURNKEYAI_PRODUCT_BRIDGE_OK. Browser bridge capability: browser bridge controls open pages, inspect rendered DOM, act after approval, and collect screenshots. Risk: first-run setup is still too technical."
            : "TURNKEYAI_PRODUCT_WORKBENCH_SIGNAL_OK. Rendered browser evidence from product-signals: Stuck missions: 6. Weak answer rate: 24%. Recommended next action: make Mission Control the default entry and gate release on real LLM scenario quality.";
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: `task-${input.call.id}`,
          session_key: `worker:${input.call.input.agent_id ?? "session"}:task-${input.call.id}`,
          agent_id: input.call.input.agent_id ?? "session",
          label,
          status: "completed",
          tool_chain: [input.call.input.agent_id ?? "session"],
          result: evidence,
          final_content: evidence,
          payload: {
            mode: "llm_sub_agent",
            workerType: input.call.input.agent_id ?? "session",
            content: evidence,
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief for the next agent workbench release.",
        "Use three independent evidence streams with specialist work.",
        "Research source: http://127.0.0.1:61930/product-orchestration",
        "Capability source: http://127.0.0.1:61930/product-bridge",
        "Live signal dashboard: http://127.0.0.1:61930/product-signals",
        "The final must tell the product leader what to build next, why it matters, what not to over-emphasize, and residual risk.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /MODEL_AUTHORED_PRODUCT_BRIEF/);
  assert.match(result.content, /Mission Control/);
  assert.match(result.content, /multi-agent decomposition/);
  assert.match(result.content, /Stuck missions: 6/);
  assert.match(result.content, /Weak answer rate: 24%/);
  assert.match(result.content, /Residual risk/i);
  assert.equal(result.metadata?.adapterName, "test");
  assert.deepEqual(
    executedCalls.map((call) => `${call.name}:${String(call.input.label ?? "")}`),
    [
      "sessions_spawn:product-orchestration",
      "sessions_spawn:product-bridge",
      "sessions_spawn:product-signals",
    ],
  );
  assert.ok(gatewayInputs.length <= 4);
});

test("llm role response generator continues a lone timed-out coverage-critical session before final synthesis", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return {
        text: "Delegating product brief evidence collection.",
        toolCalls: [
          {
            id: "toolu-product-brief",
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              label: "agent-workbench-product-brief",
              task: [
                "Research source: http://127.0.0.1:61930/product-orchestration",
                "Capability source: http://127.0.0.1:61930/product-bridge",
                "Live signal dashboard: http://127.0.0.1:61930/product-signals",
              ].join("\n"),
            },
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
      assert.deepEqual(input.toolChoice, {
        type: "tool",
        name: "sessions_send",
      });
      assert.ok(
        input.messages.some(
          (message) =>
            message.role === "user" &&
            readToolContent(message.content).includes(
              "required delegated evidence stream timed out",
            ),
        ),
      );
      return {
        text: "Continuing the resumable browser session.",
        toolCalls: [
          {
            id: "toolu-continue-product-brief",
            name: "sessions_send",
            input: {
              session_key: "worker:browser:task-product:toolu-product-brief",
              message:
                "Return the missing source evidence for the final product brief.",
            },
          },
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
      text: "Final brief covers orchestration, browser bridge, and product signals.",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const executedCalls: LLMToolCall[] = [];
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" }, label: { type: "string" } },
          },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: {
            type: "object",
            properties: {
              session_key: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "sessions_send") {
        assert.equal(
          input.call.input.session_key,
          "worker:browser:task-product:toolu-product-brief",
        );
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-product",
            session_key: "worker:browser:task-product:toolu-product-brief",
            agent_id: "browser",
            status: "completed",
            tool_chain: ["browser_open", "browser_snapshot"],
            result: "All three product sources verified.",
            final_content: "ORCHESTRATION_OK. BRIDGE_OK. PRODUCT_SIGNAL_OK.",
            payload: {
              mode: "llm_sub_agent",
              workerType: "browser",
              content: "PRODUCT_SIGNAL_OK",
            },
          }),
        };
      }
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        isError: true,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-product",
          session_key: "worker:browser:task-product:toolu-product-brief",
          agent_id: "browser",
          status: "timeout",
          timeout_seconds: 45,
          evidence_available: true,
          tool_chain: ["browser_open", "browser_snapshot"],
          result:
            "Browser worker timed out before returning all source evidence.",
          final_content: null,
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            continuationDigest: { reason: "timeout_summary" },
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
    packet: {
      ...buildPacket(),
      taskPrompt: [
        "Prepare a product-ready brief about the next agent workbench release.",
        "Research source: http://127.0.0.1:61930/product-orchestration",
        "Capability source: http://127.0.0.1:61930/product-bridge",
        "Live signal dashboard: http://127.0.0.1:61930/product-signals",
        "These are three independent evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
        "The final brief should tell a product leader what to build next, why it matters, what not to over-emphasize, and what risk remains.",
      ].join("\n"),
    },
  });

  assert.match(result.content, /ORCHESTRATION_OK/);
  assert.match(result.content, /BRIDGE_OK/);
  assert.match(result.content, /PRODUCT_SIGNAL_OK/);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_send"],
  );
  assert.ok(gatewayInputs.length >= 2);
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
        readToolContent(message.content).includes("pseudo tool-call markup"),
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
});

test("llm role response generator uses local evidence closeout when final repair still emits tool-call markup", async () => {
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
    return {
      text: '<minimax:tool_call><invoke name="sessions_history"></invoke></minimax:tool_call>',
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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

  assert.match(result.content, /Verified:/);
  assert.match(result.content, /source A verifies the product positioning/);
  assert.match(result.content, /source B verifies the repository/);
  assert.match(result.content, /not verified/);
  assert.match(result.content, /requested task/);
  assert.doesNotMatch(result.content, /<minimax:tool_call>/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
  assert.equal(gatewayInputs.length, 3);
  assert.ok(
    gatewayInputs[2]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("pseudo tool-call markup"),
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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

  assert.equal(
    result.content,
    "Final answer from existing tool evidence only.",
  );
  assert.equal(gatewayInputs.length, 3);
  assert.ok(
    gatewayInputs[2]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes(
          "pseudo tool-call markup without a native tool call",
        ),
    ),
  );
  const closeout = result.metadata?.toolLoopCloseout as
    | Record<string, unknown>
    | undefined;
  assert.equal(closeout?.reason, "pseudo_tool_call");
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
});

test("llm role response generator caps parallel tool execution fan-out", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const releaseById = new Map<string, () => void>();
  let activeTools = 0;
  let maxActiveTools = 0;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => {
    gatewayInputs.push({
      messages: [],
      modelId: "unused",
    } as unknown as GenerateTextInput);
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
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
        content: JSON.stringify({
          status: "completed",
          result: input.call.input.task,
        }),
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
          inputSchema: {
            type: "object",
            properties: { task: { type: "string" } },
          },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCallIds.push(input.call.id);
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          status: "completed",
          result: input.call.input.task,
        }),
      };
    },
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: {
      executor,
      maxRounds: 4,
      maxParallelToolCalls: 2,
      maxToolCallsPerRound: 2,
    },
  });

  const result = await generator.generate({
    activation: buildActivation(),
    packet: buildPacket(),
  });

  assert.equal(result.content, "Done after capped execution.");
  assert.deepEqual(executedCallIds, ["toolu-a", "toolu-b"]);
  const secondRoundToolResults = gatewayInputs[1]?.messages
    .filter((message) => message.role === "tool")
    .map((message) => ({
      toolCallId: message.toolCallId,
      content: readToolContent(message.content),
    }));
  assert.deepEqual(
    secondRoundToolResults?.map((message) => message.toolCallId),
    ["toolu-a", "toolu-b", "toolu-c"],
  );
  assert.match(
    secondRoundToolResults?.[2]?.content ?? "",
    /tool_call_limit_exceeded/,
  );
  const trace = result.metadata?.toolUse as
    | {
        rounds?: Array<{
          results?: Array<{ toolCallId?: string; skipped?: boolean }>;
        }>;
      }
    | undefined;
  assert.equal(
    trace?.rounds?.[0]?.results?.find((item) => item.toolCallId === "toolu-c")
      ?.skipped,
    true,
  );
});

function buildActivation(
  roleOverrides?: Partial<RoleActivationInput["thread"]["roles"][number]>,
  options?: { omitLegacyModel?: boolean },
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

function toolCallResult(
  id: string,
  name: string,
  input: Record<string, unknown>,
): GenerateTextResult {
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

function textResult(text: string): GenerateTextResult {
  return {
    text,
    toolCalls: [],
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible",
    adapterName: "test",
    raw: {},
  };
}

function readToolContent(
  content: GenerateTextInput["messages"][number]["content"],
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

function finalSynthesisPrompt(
  input: GenerateTextInput | undefined,
): string | undefined {
  const messages = input?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      readToolContent(message.content).includes(
        "Final synthesis format contract",
      )
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

function readMessageContentTextForTest(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function buildPacket(): RolePromptPacket {
  const artifactIds = Array.from(
    { length: 12 },
    (_, index) => `artifact-${index + 1}`,
  );
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
      includedSegments: [
        "task-brief",
        "recent-turns",
        "role-scratchpad",
        "retrieved-memory",
        "worker-evidence",
      ],
      sectionOrder: [
        "task-brief",
        "recent-turns",
        "role-scratchpad",
        "retrieved-memory",
        "worker-evidence",
      ],
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

// --- Cutover Stage 4: engine-path parity (reactEngine flag) ---------------
// A plain task prompt avoids the continuity/timeout visibility appenders that
// the simple engine path does not apply yet, so the two paths are comparable.
function simplePacket(): RolePromptPacket {
  return { ...buildPacket(), taskPrompt: "Answer the question concisely." };
}

function fixedAnswerGateway(text: string): LLMGateway {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text,
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible",
    adapterName: "test",
    raw: {},
  });
  return gateway;
}

test("cutover parity: no-tool reply is identical between inline and engine paths", async () => {
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({ gateway: fixedAnswerGateway("Final answer."), reactEngine }).generate({
      activation: buildActivation(),
      packet: simplePacket(),
    });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(engine.metadata?.["adapterName"], inline.metadata?.["adapterName"]);
  assert.equal(engine.metadata?.["modelId"], inline.metadata?.["modelId"]);
  assert.equal(engine.metadata?.["protocol"], inline.metadata?.["protocol"]);
});

test("cutover parity: single tool round is identical between inline and engine paths", async () => {
  const lookupExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [
        {
          name: "lookup",
          description: "look up a value",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
      ];
    },
    async execute(input) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: `value for ${JSON.stringify(input.call.input)}`,
      };
    },
  });
  const lookupThenAnswerGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let n = 0;
    gateway.generate = async () => {
      n += 1;
      if (n === 1) {
        return {
          text: "let me look",
          toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      return {
        text: "The lookup returned the value.",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    };
    return gateway;
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: lookupThenAnswerGateway(),
      toolLoop: { executor: lookupExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolUse"] as { toolCallCount?: number } | undefined)?.toolCallCount,
    1,
  );
});

test("cutover: engine path serializes an order-dependent multi-tool round", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        { name: "memory_search", description: "s", inputSchema: { type: "object" } },
        { name: "memory_get", description: "g", inputSchema: { type: "object" } },
      ];
    },
    async execute(input) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { toolCallId: input.call.id, toolName: input.call.name, content: "ok" };
    },
  };
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let n = 0;
  gateway.generate = async () => {
    n += 1;
    if (n === 1) {
      return {
        text: "look",
        toolCalls: [
          { id: "c1", name: "memory_search", input: {} },
          { id: "c2", name: "memory_get", input: {} },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "done",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 8 },
    reactEngine: "engine",
  });
  await generator.generate({ activation: buildActivation(), packet: simplePacket() });
  // memory_search + memory_get are order-dependent → the engine path must run
  // them one-at-a-time (shouldSerializeToolBatch → step 1), not concurrently.
  assert.equal(maxInFlight, 1);
});

test("cutover: engine path isolates a throwing tool as an error result (no failed run)", async () => {
  const executor: RoleToolExecutor = {
    definitions() {
      return [{ name: "boom", description: "b", inputSchema: { type: "object" } }];
    },
    async execute() {
      throw new Error("tool exploded");
    },
  };
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let n = 0;
  gateway.generate = async () => {
    n += 1;
    if (n === 1) {
      return {
        text: "call boom",
        toolCalls: [{ id: "c1", name: "boom", input: {} }],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return {
      text: "recovered",
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const generator = new LLMRoleResponseGenerator({
    gateway,
    toolLoop: { executor, maxRounds: 8 },
    reactEngine: "engine",
  });
  // the run completes (the thrown tool became an isError result the model saw)
  // instead of rejecting the whole response.
  const result = await generator.generate({ activation: buildActivation(), packet: simplePacket() });
  assert.equal(result.content, "recovered");
});

test("cutover parity: round-limit closeout is identical between inline and engine paths", async () => {
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input) => {
      // tools disabled => the closeout synthesis round (withoutToolUse)
      if ((input.tools?.length ?? 0) === 0) {
        return {
          text: "final after the round limit",
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      return {
        text: "looping",
        toolCalls: [{ id: "c", name: "lookup", input: {} }],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: "v" };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 2 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "round_limit",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "round_limit",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: tool_evidence_fallback closeout is identical between inline and engine paths", async () => {
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "The capital of France is Paris.",
      };
    },
  });
  // round 1 → a tool call (usable evidence lands in the trace); the post-tool
  // model call throws → tool_evidence_fallback on both paths.
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let n = 0;
    gateway.generate = async () => {
      n += 1;
      if (n === 1) {
        return {
          text: "let me look",
          toolCalls: [{ id: "c1", name: "lookup", input: { q: "capital of France" } }],
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      throw new Error("gateway exploded on the tool-round model call");
    };
    return gateway;
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "tool_evidence_fallback",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "tool_evidence_fallback",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: an aborting tool propagates (rejects) on inline and engine paths", async () => {
  // A per-chunk wall-clock timeout / operator cancellation surfaces from the
  // executor as an AbortError. Both paths must let it propagate (reject the
  // run), NOT swallow it into an isError result that lets the loop continue
  // making more model/tool rounds past the abort. Before the engine
  // runToolBatch rethrew aborts, the engine path swallowed this into an isError
  // result, called the gateway again, and returned a normal reply.
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute() {
      const err = new Error("tool execution aborted");
      err.name = "AbortError";
      throw err;
    },
  });
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let n = 0;
    gateway.generate = async () => {
      n += 1;
      if (n === 1) {
        return {
          text: "let me look",
          toolCalls: [{ id: "c1", name: "lookup", input: {} }],
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      // Reaching a second model call means the abort was swallowed — the run
      // should have rejected before getting here.
      return {
        text: "abort was swallowed — should never be reached",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    };
    return gateway;
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });

  await assert.rejects(run("inline"), /aborted/);
  await assert.rejects(run("engine"), /aborted/);
});

test("cutover parity: completed_sub_agent_final closeout is identical between inline and engine paths", async () => {
  // Round 1 delegates to a sub-agent; the executor returns a completed session
  // record with usable evidence. findCompletedSessionEvidence fires the terminal
  // completed_sub_agent_final closeout on both paths. agent_id "explore" (not
  // "browser") and the bland simplePacket keep every Stage-7 continuation/repair
  // branch from firing, so both paths reach the closeout in a single tool round.
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input) => {
      // tools disabled => the closeout synthesis round (withoutToolUse)
      if ((input.tools?.length ?? 0) === 0) {
        return {
          text: "The delegated explore session confirms the answer is 42.",
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      return {
        text: "delegating to a sub-agent",
        toolCalls: [
          {
            id: "c1",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "Find the answer." },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:c1",
          agent_id: "explore",
          status: "completed",
          tool_chain: [],
          result: "The delegated explore session confirmed the answer is 42.",
          final_content: null,
          payload: null,
        }),
      };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "completed_sub_agent_final",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "completed_sub_agent_final",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: sub_agent_timeout closeout is identical between inline and engine paths", async () => {
  // Round 1 delegates to a sub-agent that times out with no usable evidence.
  // findSubAgentToolTimeout fires the terminal sub_agent_timeout closeout on both
  // paths; both then pipe the synthesis through maybeAppendTimeoutContinuation
  // Visibility (the plain synthesis text carries no timeout guidance, so the
  // resumable-continuation sentence is appended). evidence_available:false maps
  // missionReport.status to "blocked". agent_id "explore" avoids the supplemental
  // local-timeout probe (which only fires for non-browser agents on richer
  // prompts).
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input) => {
      if ((input.tools?.length ?? 0) === 0) {
        return {
          text: "Verification did not complete within the tool budget.",
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      return {
        text: "delegating to a sub-agent",
        toolCalls: [
          {
            id: "c1",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "Fetch evidence from a slow source." },
          },
        ],
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        isError: true,
        content: JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          task_id: "task-1",
          session_key: "worker:explore:task-1:c1",
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
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "sub_agent_timeout",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "sub_agent_timeout",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
  // sub_agent_timeout always pipes through maybeAppendTimeoutContinuationVisibility.
  assert.ok(
    engine.content.includes("Continuation: this source check is resumable"),
    "engine timeout closeout should carry the resumable-continuation sentence",
  );
});

// --- Cutover Stage 5 PR2d: pending-call closeout parity (onToolCallsClose) ---
// Each test drives the same single-closeout scenario through reactEngine
// "inline" and "engine" and asserts content + mentions + toolLoopCloseout.reason
// + missionReport.status parity. Scenarios use the bland simplePacket (or a
// minimal recovery prompt) and plain tools so no Stage-7 continuation/repair
// branch fires before the terminal closeout.

const closeoutSynthesisGateway = (toolRound: () => GenerateTextResult, synthesisText: string): LLMGateway => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input) => {
    if ((input.tools?.length ?? 0) === 0) {
      return {
        text: synthesisText,
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    }
    return toolRound();
  };
  return gateway;
};

const toolCallTurn = (id: string, name: string, input: Record<string, unknown>): GenerateTextResult => ({
  text: "calling a tool",
  toolCalls: [{ id, name, input }],
  modelId: "claude-test",
  providerId: "anthropic",
  protocol: "anthropic-compatible",
  adapterName: "test",
  raw: {},
});

test("cutover parity: recovery_tool_budget closeout is identical between inline and engine paths", async () => {
  // A final recovery-attempt prompt caps the budget at 1 tool call; after round 0
  // spends it, round 1's pending call closes out as recovery_tool_budget.
  const recoveryPacket = (): RolePromptPacket => ({
    ...buildPacket(),
    taskPrompt:
      "Automatic recovery attempt 2 of 2. Finish the task now. You may make at most 1 additional tool calls total.",
  });
  const makeGateway = (): LLMGateway =>
    closeoutSynthesisGateway(
      () => toolCallTurn("c", "lookup", {}),
      "Blocked closeout from the gathered evidence.",
    );
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: "v" };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: recoveryPacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "recovery_tool_budget",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "recovery_tool_budget",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: operator_cancelled closeout is identical between inline and engine paths", async () => {
  // Round 0 surfaces a cancelled delegated session (returned via a plain tool so
  // no session-call normalization fires); the bland simplePacket does not ask to
  // continue it, so round 1's pending call closes out as operator_cancelled.
  const cancelled = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "cancelled",
    tool_chain: [],
    result: "operator cancelled active source verification",
    final_content: null,
    payload: null,
  });
  const makeGateway = (): LLMGateway =>
    closeoutSynthesisGateway(
      () => toolCallTurn("c", "lookup", {}),
      "Verification was cancelled; bounded closeout from the cancellation evidence.",
    );
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: cancelled };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "operator_cancelled",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "operator_cancelled",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: pseudo_tool_call closeout is identical between inline and engine paths", async () => {
  // The model emits tool-call markup as text with no native tool call; both paths
  // close out as pseudo_tool_call on round 0 without executing anything.
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input) => {
      if ((input.tools?.length ?? 0) === 0) {
        return {
          text: "Final answer without tools.",
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      return {
        text: "<tool_call>lookup</tool_call>",
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: "v" };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "pseudo_tool_call",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "pseudo_tool_call",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: wall_clock_budget closeout is identical between inline and engine paths", async () => {
  // The executor advances the clock past the 100ms budget while running round 0;
  // round 1's pending call hits the graceful wall-clock closeout on both paths.
  const makeGateway = (): LLMGateway =>
    closeoutSynthesisGateway(
      () => toolCallTurn("c", "lookup", {}),
      "Final answer after the wall-clock budget.",
    );
  const run = (reactEngine: "inline" | "engine") => {
    let now = 0;
    const executor: RoleToolExecutor = {
      definitions() {
        return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
      },
      async execute(input) {
        now = 200;
        return { toolCallId: input.call.id, toolName: input.call.name, content: "v" };
      },
    };
    return new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor, maxRounds: 8, maxWallClockMs: 100 },
      clock: { now: () => now },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "wall_clock_budget",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "wall_clock_budget",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: repeated_tool_failure closeout is identical between inline and engine paths", async () => {
  // The same tool call fails twice (same signature); round 2's pending repeat of
  // it trips the anti-loop breaker on both paths.
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let n = 0;
    gateway.generate = async (input) => {
      if ((input.tools?.length ?? 0) === 0) {
        return {
          text: "Final answer after repeated tool failures.",
          modelId: "claude-test",
          providerId: "anthropic",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      }
      n += 1;
      return toolCallTurn(`c${n}`, "lookup", { q: "x" });
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, isError: true, content: "tool failed" };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "repeated_tool_failure",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "repeated_tool_failure",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: repeated_session_inspection closeout is identical between inline and engine paths", async () => {
  // Round 0 inspects a session via sessions_history (non-evidence result, so no
  // completed closeout); round 1 re-inspects the same session and closes out.
  const inspectionResult = JSON.stringify({ session_key: "worker:explore:task-1:s1", ok: true });
  const makeGateway = (): LLMGateway =>
    closeoutSynthesisGateway(
      () => toolCallTurn("c", "sessions_history", { session_key: "worker:explore:task-1:s1" }),
      "Final answer from the already-inspected session evidence.",
    );
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_history", description: "h", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: inspectionResult };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "repeated_session_inspection",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "repeated_session_inspection",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

test("cutover parity: excessive_session_continuation closeout is identical between inline and engine paths", async () => {
  // The same session is continued twice via sessions_send (plain acks, so no
  // completed/timeout closeout); round 2's third continuation closes out.
  const makeGateway = (): LLMGateway =>
    closeoutSynthesisGateway(
      () => toolCallTurn("c", "sessions_send", { session_key: "worker:explore:task-1:s1", message: "go" }),
      "Final answer from the gathered session evidence.",
    );
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_send", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: "ack" };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "excessive_session_continuation",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "excessive_session_continuation",
  );
  assert.equal(
    (engine.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
    (inline.metadata?.["missionReport"] as { status?: string } | undefined)?.status,
  );
});

// --- Cutover Stage 6: post-synthesis repair parity (onRepairRound) ---
test("cutover parity: missing-table-columns repair is identical between inline and engine paths", async () => {
  // The task requests specific table columns; the model's first (tool-free) answer
  // omits one, so shouldRepairMissingRequestedTableColumns fires a repair round on
  // both paths (inline re-loops; engine via onRepairRound) and the repaired answer
  // with all columns is the final result. Neutral columns avoid tripping the other
  // (not-yet-cut-over) cascade repairs.
  const missingTable = ["| 名称 | 价格 |", "|---|---|", "| 甲 | 1 |"].join("\n");
  const fixedTable = ["| 名称 | 价格 | 库存 |", "|---|---|---|", "| 甲 | 1 | 100 |"].join("\n");
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input) => {
      // tools dropped on the forced tool-free repair round -> the fixed table.
      const text = (input.tools?.length ?? 0) === 0 ? fixedTable : missingTable;
      return {
        text,
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible",
        adapterName: "test",
        raw: {},
      };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: "v" };
    },
  });
  const packet = (): RolePromptPacket => ({
    ...buildPacket(),
    taskPrompt: "输出表格列出：名称、价格、库存。",
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: packet() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the final answer carries the omitted column.
  assert.match(inline.content, /库存/);
  assert.match(engine.content, /库存/);
});

test("cutover parity: extraneous-provider-table-schema repair is identical between inline and engine paths", async () => {
  // The task asks for a plain pricing + recommendation answer (no provider /
  // web_search / target-model schema requested). The first (tool-free) candidate
  // wrongly introduces a provider/search/model-support table, so
  // shouldRepairExtraneousProviderTableSchema fires a repair round on both paths.
  const extraneousSchema = ["| provider | web search | 目标模型 |", "|---|---|---|", "| 甲 | 否 | deepseek |"].join("\n");
  const fixedAnswer = ["| 名称 | 价格 |", "|---|---|", "| 甲 | 10 元 |", "", "推荐：选择甲，价格清晰。"].join("\n");
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input) => {
      const text = (input.tools?.length ?? 0) === 0 ? fixedAnswer : extraneousSchema;
      return { text, modelId: "claude-test", providerId: "anthropic", protocol: "anthropic-compatible", adapterName: "test", raw: {} };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: "v" };
    },
  });
  const packet = (): RolePromptPacket => ({ ...buildPacket(), taskPrompt: "比较几款产品的价格，并给出一个清晰的推荐。" });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: packet() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.doesNotMatch(inline.content, /web search/);
  assert.doesNotMatch(engine.content, /web search/);
  assert.match(inline.content, /推荐/);
  assert.match(engine.content, /推荐/);
});

test("cutover parity: weak-evidence-synthesis repair is identical between inline and engine paths", async () => {
  // The first (tool-free) candidate weakens verified evidence with placeholder
  // uncertainty ("probably"/"TBD"), so shouldRepairWeakEvidenceSynthesis fires a
  // repair round on both paths and the confident, verified answer is the result.
  const weakAnswer = "核心要点：该产品 probably 支持离线模式，定价 TBD。";
  const fixedAnswer = "核心要点：观察到该产品支持离线模式，定价已验证为每月 9 元。";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input) => {
      const text = (input.tools?.length ?? 0) === 0 ? fixedAnswer : weakAnswer;
      return { text, modelId: "claude-test", providerId: "anthropic", protocol: "anthropic-compatible", adapterName: "test", raw: {} };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: "该产品支持离线模式，定价每月 9 元。" };
    },
  });
  const packet = (): RolePromptPacket => ({ ...buildPacket(), taskPrompt: "总结这个产品的核心要点。" });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: packet() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  assert.doesNotMatch(inline.content, /probably|TBD/i);
  assert.doesNotMatch(engine.content, /probably|TBD/i);
  assert.match(inline.content, /已验证/);
  assert.match(engine.content, /已验证/);
});

test("cutover parity: source-evidence-carry-forward natural-finish repair is identical between inline and engine paths", async () => {
  // The NATURAL-FINISH path (engine onRepairRound, inline :1202) — distinct from the
  // completed-closeout onTerminate loop. A lookup tool returns a source label; the
  // tool-free candidate answer drops it, so shouldRepairSourceEvidenceCarryForward
  // (label branch) fires on both paths using sourceBoundedEvidenceText (which pulls the
  // label from the tool-trace evidence). Unlike the other natural-finish tests the model
  // must actually call the tool so the label reaches the tool trace.
  const lookupEvidence =
    '{"label":"Helsinki transit feed","evidence":"verified the feed publishes vehicle positions every 15 seconds"}';
  const droppedLabel =
    "The lookup confirmed the feed publishes vehicle positions every 15 seconds.";
  const withLabel =
    "The lookup confirmed the feed publishes vehicle positions every 15 seconds. Evidence / Sources: Helsinki transit feed verified the refresh cadence.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let callCount = 0;
    gateway.generate = async () => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      callCount += 1;
      if (callCount === 1) {
        // round 0: call the lookup tool so its label lands in the tool trace.
        return { ...base, text: "looking up", toolCalls: [{ id: "c1", name: "lookup", input: {} }] };
      }
      // call 2 = candidate dropping the label; call 3+ = the repair restoring it.
      return { ...base, text: callCount === 2 ? droppedLabel : withLabel };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "lookup", description: "l", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: lookupEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Look up the transit feed and list the exact sources you checked, keeping each source label visible in the answer.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the natural-finish source-evidence repair fired on both paths: the dropped label
  // is restored, with wording unique to the repair synthesis.
  assert.match(inline.content, /Helsinki transit feed/);
  assert.match(engine.content, /Helsinki transit feed/);
  assert.match(engine.content, /Evidence \/ Sources/);
});

// --- Cutover Stage 6: completed-closeout repair pass parity (onTerminate loop) ---
test("cutover parity: false-evidence-blocked completed-closeout repair is identical between inline and engine paths", async () => {
  // A completed delegated session returns usable evidence, but the closeout
  // synthesis falsely calls the source inaccessible. shouldRepairFalseEvidence
  // BlockedSynthesis fires a completed-closeout repair round on both paths (inline
  // re-loops via natural-finish; engine via the onTerminate repair loop) and the
  // rewritten answer that no longer marks the evidence blocked is the final result.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result: "The delegated session verified the plan is $10 per month.",
    final_content: null,
    payload: null,
  });
  const falseBlocked = "Verification finished, but the source was not accessible.";
  const fixedAnswer = "Confirmed from the delegated session: the plan is $10 per month.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        // round 0: delegate to a sub-agent.
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check price" } }],
        };
      }
      // tool-free syntheses: 1st = the false-blocked closeout, 2nd = the repair.
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? falseBlocked : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: simplePacket() });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the false "not accessible" wording is gone.
  assert.doesNotMatch(inline.content, /not accessible/i);
  assert.doesNotMatch(engine.content, /not accessible/i);
  assert.match(engine.content, /\$10 per month/);
});

test("cutover parity: missing-requested-next-action completed-closeout repair is identical between inline and engine paths", async () => {
  // The task asks for the next action the operator should take, but the closeout
  // synthesis omits any next-action guidance. shouldRepairMissingRequestedNextAction
  // fires a completed-closeout repair round on both paths (inline re-loops via the
  // "none" round; engine via the onTerminate repair loop). The scenario is isolated
  // to this predicate: the task names no sources / product brief / timeout / table /
  // conclusion, so the earlier cascade predicates (which the engine loop does not yet
  // check) stay quiet and cannot create a false divergence.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result: "The delegated session verified the plan is $10 per month.",
    final_content: null,
    payload: null,
  });
  const missingNextAction = "The delegated session verified the plan is $10 per month.";
  const fixedAnswer =
    "The delegated session verified the plan is $10 per month. Recommended next action: the operator should continue monitoring the pricing page for changes.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        // round 0: delegate to a sub-agent.
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check price" } }],
        };
      }
      // tool-free syntheses: 1st = closeout missing the next action, 2nd = the repair.
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? missingNextAction : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Review the delegated session's pricing finding and tell me the next action the operator should take.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the next-action guidance the first synthesis
  // lacked is present, including the wording unique to the repair synthesis.
  assert.match(inline.content, /next action/i);
  assert.match(engine.content, /next action/i);
  assert.match(engine.content, /monitoring the pricing page/);
});

test("cutover parity: missing-required-deliverables completed-closeout repair is identical between inline and engine paths", async () => {
  // The task requires a final one-sentence conclusion, but the closeout synthesis
  // omits it. findMissingRequiredFinalDeliverables fires a completed-closeout repair
  // round on both paths (inline re-loops via the "none" round; engine via the
  // onTerminate repair loop) and the rewritten answer with the conclusion label is
  // the final result. Isolated to this predicate: the task names no next action /
  // sources / product brief / timeout / table, so the earlier cascade predicates the
  // engine loop does not yet check stay quiet and cannot create a false divergence.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result: "The delegated session verified the plan is $10 per month.",
    final_content: null,
    payload: null,
  });
  const missingConclusion = "The delegated session verified the plan is $10 per month.";
  const fixedAnswer =
    "The delegated session verified the plan is $10 per month.\n\nConclusion: the $10/month plan is confirmed.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        // round 0: delegate to a sub-agent.
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check price" } }],
        };
      }
      // tool-free syntheses: 1st = closeout missing the conclusion, 2nd = the repair.
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? missingConclusion : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Verify the delegated pricing finding and end with a final one-sentence conclusion.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the conclusion label the first synthesis lacked
  // is present.
  assert.match(inline.content, /Conclusion:/);
  assert.match(engine.content, /Conclusion:/);
});

test("cutover parity: source-evidence-carry-forward completed-closeout repair is identical between inline and engine paths", async () => {
  // The task asks to keep each source label visible, and the delegated evidence
  // carries two source labels — but those labels live ONLY in the raw tool-result
  // JSON (not in finalContents), so this exercises the new completedProductBrief
  // EvidenceText plumbing (finalContents + the completing round's raw tool-result
  // text). The first synthesis drops both labels, so shouldRepairSourceEvidence
  // CarryForward (label branch) fires a completed-closeout repair on both paths
  // (inline re-loops via the "none" round; engine via the onTerminate repair loop).
  // Isolated: the evidence carries labels but the task names no product brief /
  // timeout / next action / deliverable / table, so no earlier predicate fires.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result:
      "The delegated explore session checked two open-data feeds and confirmed both publish GTFS-RT vehicle positions updated every 15 seconds.",
    final_content: null,
    payload: null,
    // labels live only here in the raw tool-result JSON, never in finalContents —
    // reachable solely via the collectToolResultContentText half of the evidence.
    sources: [{ label: "Helsinki transit feed" }, { label: "Tampere transit feed" }],
  });
  const missingLabels =
    "The delegated explore session confirmed both open-data feeds publish GTFS-RT vehicle positions updated every 15 seconds.";
  const fixedAnswer =
    "The delegated explore session confirmed both open-data feeds publish GTFS-RT vehicle positions updated every 15 seconds. Evidence / Sources: Helsinki transit feed verified the 15-second GTFS-RT vehicle-position refresh; Tampere transit feed verified the same refresh cadence.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check feeds" } }],
        };
      }
      // tool-free syntheses: 1st = closeout dropping the labels, 2nd = the repair.
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? missingLabels : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Review the delegated explore session's findings on the open-data feeds and list the exact sources you checked, keeping each source label visible in the answer.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: both dropped source labels are restored.
  assert.match(inline.content, /Helsinki transit feed/);
  assert.match(engine.content, /Helsinki transit feed/);
  assert.match(inline.content, /Tampere transit feed/);
  assert.match(engine.content, /Tampere transit feed/);
  // wording unique to the label-repair re-synthesis (proves the repair, not the
  // first synthesis, is the final result).
  assert.match(engine.content, /Evidence \/ Sources/);
});

test("cutover parity: timeout-followup-final-guidance completed-closeout repair is identical between inline and engine paths", async () => {
  // The task is a timeout/continuation follow-up, and the delegated evidence reports
  // a timeout recovery — but the first synthesis omits the unverified-scope and
  // continuation guidance the task requires. shouldRepairTimeoutFollowupFinalGuidance
  // fires a completed-closeout repair on both paths. Isolated: the delegated evidence
  // carries NO source labels (so source-evidence short-circuits on empty labels) and
  // the task names no product brief / next action / deliverable / table, so timeout-
  // followup is the only predicate that fires.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result:
      "Timeout recovery completed. Source: slow fixture. Verified owner: Release Captain. Verified risk: runbook gap before launch approval. Mitigation: complete rollback rehearsal before release gate.",
    final_content: null,
    payload: null,
  });
  const missingGuidance = [
    "The slow source check recovered after the earlier timeout and returned verified content.",
    "Verified owner: Release Captain.",
    "Verified risk: runbook gap before the launch approval gate.",
    "Mitigation: complete the rollback rehearsal before the release gate.",
    "Release-risk assessment: hold the release until the rollback rehearsal is signed off.",
  ].join("\n");
  const fixedAnswer = [
    "Recovered and resumed after the earlier timeout, the slow source check returned verified content.",
    "Verified owner: Release Captain.",
    "Verified risk: runbook gap before the launch approval gate.",
    "Mitigation: complete the rollback rehearsal before the release gate.",
    "Release-risk assessment: hold the release until the rollback rehearsal is signed off.",
    "Unverified scope: response latency and fixture uptime remain not verified and stay source-bounded.",
    "Continuation guidance: continue or retry the same source-check with a bounded timeout if more release-gated evidence is needed.",
  ].join("\n");
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check slow source" } }],
        };
      }
      // tool-free syntheses: 1st = closeout missing the guidance, 2nd = the repair.
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? missingGuidance : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt: [
      "Evaluate this slow source for a release-risk note.",
      "Use a bounded attempt first; if the source does not return in time, close out with the evidence that is available.",
      "A follow-up may ask you to resume that same source-check context after the earlier timeout.",
    ].join("\n"),
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the unverified-scope + continuation guidance the
  // first synthesis lacked are present.
  assert.match(inline.content, /Unverified scope/i);
  assert.match(engine.content, /Unverified scope/i);
  assert.match(inline.content, /Continuation guidance/i);
  assert.match(engine.content, /Continuation guidance/i);
  // wording unique to the repair re-synthesis.
  assert.match(engine.content, /continue or retry the same source-check with a bounded timeout/);
});

test("cutover parity: compound completed-closeout input does not over-repair on the engine path", async () => {
  // Compound input: the task asks for BOTH visible source labels AND a next action.
  // The first synthesis drops the labels, so source-evidence fires (round 0). Its
  // re-synthesis restores the labels but still omits the next action — which WOULD
  // trip missing-next-action. But inline runs the completed cascade only once, then
  // its tool-free natural-finish cascade (table-columns/extraneous/source-evidence/
  // weak-evidence) which does NOT contain missing-next-action, so inline leaves the
  // next-action gap. The engine must match: with the completed-only predicates gated
  // to repairRound 0, it stops at the source-repair too. Without that gating the
  // engine would fire missing-next-action on round 1 and over-repair (third synthesis).
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result:
      "The delegated explore session checked two open-data feeds and confirmed both publish GTFS-RT vehicle positions updated every 15 seconds.",
    final_content: null,
    payload: null,
    sources: [{ label: "Helsinki transit feed" }, { label: "Tampere transit feed" }],
  });
  const missingBoth =
    "The delegated explore session confirmed both open-data feeds publish GTFS-RT vehicle positions updated every 15 seconds.";
  const labelsNoNextAction =
    "The delegated explore session confirmed both open-data feeds publish GTFS-RT vehicle positions updated every 15 seconds. Evidence / Sources: Helsinki transit feed verified the 15-second refresh; Tampere transit feed verified the same cadence.";
  // returned only if the engine wrongly over-repairs (the missing-next-action round
  // the fix suppresses) — its wording must never appear in a parity-correct result.
  const labelsAndNextAction =
    labelsNoNextAction +
    " Recommended next action: the operator should continue monitoring the feeds.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check feeds" } }],
        };
      }
      synthCount += 1;
      return {
        ...base,
        text:
          synthCount === 1
            ? missingBoth
            : synthCount === 2
              ? labelsNoNextAction
              : labelsAndNextAction,
      };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Review the delegated explore session's findings on the open-data feeds, list the exact sources you checked keeping each source label visible, and tell me the next action the operator should take.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the source-evidence repair fired on both paths (labels restored)...
  assert.match(inline.content, /Helsinki transit feed/);
  assert.match(engine.content, /Helsinki transit feed/);
  // ...but neither path over-repaired into the completed-only missing-next-action
  // round that inline's natural-finish cascade never runs.
  assert.doesNotMatch(inline.content, /Recommended next action/i);
  assert.doesNotMatch(engine.content, /Recommended next action/i);
});

test("cutover parity: table-columns completed-closeout repair is identical between inline and engine paths", async () => {
  // table-columns is an every-round member (inline completed :1826 / natural-finish
  // :1139). The task requests a Markdown table with specific columns; the closeout
  // synthesis is plain prose with no table, so shouldRepairMissingRequestedTableColumns
  // fires on both paths and the rewrite adds the requested table. Isolated to this
  // predicate: the task names no sources / timeout / next action / conclusion / two-row
  // table, and the evidence carries no labels, so nothing else fires.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result:
      "The delegated explore session checked two open-data transit feeds and confirmed both Helsinki and Tampere publish GTFS-RT vehicle positions updated every 15 seconds.",
    final_content: null,
    payload: null,
  });
  const noTable =
    "The delegated explore session confirmed both Helsinki and Tampere publish GTFS-RT vehicle positions refreshed every 15 seconds.";
  const fixedAnswer =
    "The delegated explore session confirmed both feeds publish GTFS-RT vehicle positions.\n\n| City | Service | Frequency |\n| --- | --- | --- |\n| Helsinki | GTFS-RT vehicle positions | every 15 seconds |\n| Tampere | GTFS-RT vehicle positions | every 15 seconds |";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check feeds" } }],
        };
      }
      // tool-free syntheses: 1st = prose with no table, 2nd = the repair (with table).
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? noTable : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Present the delegated explore session's transit-feed findings as a Markdown table. table: City | Service | Frequency",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the requested table header the first synthesis
  // lacked is present, with a row unique to the repair synthesis.
  assert.match(inline.content, /\| City \| Service \| Frequency \|/);
  assert.match(engine.content, /\| City \| Service \| Frequency \|/);
  assert.match(engine.content, /Helsinki \| GTFS-RT vehicle positions \| every 15 seconds/);
});

test("cutover parity: extraneous-provider-table-schema completed-closeout repair (re-synthesis) is identical between inline and engine paths", async () => {
  // extraneous-schema is an every-round member (inline completed :1854 / natural-finish
  // :1167). Crucially generateFinalAfterToolRoundLimit ALREADY repairs extraneous schema
  // in the FIRST closeout synthesis, so the only divergence this onTerminate block can
  // fix is a LATER re-synthesis that introduces the schema. So this is a COMPOUND
  // scenario: round 0 fires table-columns (the synthesis is prose with no table); its
  // table-columns repair re-synthesis ALSO invents an unrequested provider/search/price
  // matrix (generateWithEnvelopeRetry has no internal extraneous pass), and round 1's
  // extraneous block must drop it — exactly what inline's natural-finish :1167 does.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result:
      "The delegated explore session checked two open-data transit feeds and confirmed both Helsinki and Tampere publish GTFS-RT vehicle positions updated every 15 seconds.",
    final_content: null,
    payload: null,
  });
  // synth 1: prose, no table (trips table-columns; clean of extraneous so
  // generateFinalAfterToolRoundLimit's internal pass stays quiet).
  const noTable =
    "The delegated explore session confirmed both Helsinki and Tampere publish GTFS-RT vehicle positions refreshed every 15 seconds.";
  // synth 2: the table-columns repair — has the requested City|Service|Frequency table
  // AND an unrequested provider/search/price matrix (the extraneous schema).
  const tableWithExtraneous =
    "| City | Service | Frequency |\n| --- | --- | --- |\n| Helsinki | GTFS-RT vehicle positions | every 15 seconds |\n| Tampere | GTFS-RT vehicle positions | every 15 seconds |\n\nProvider support matrix:\n\n| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |\n| --- | --- | --- | --- |\n| AcmeMaps | 未验证 | 未验证 | 未验证 |";
  // synth 3: the extraneous repair — the requested table only, no provider matrix.
  const cleanTable =
    "The delegated explore session's transit-feed findings:\n\n| City | Service | Frequency |\n| --- | --- | --- |\n| Helsinki | GTFS-RT vehicle positions | every 15 seconds |\n| Tampere | GTFS-RT vehicle positions | every 15 seconds |";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check feeds" } }],
        };
      }
      synthCount += 1;
      return {
        ...base,
        text:
          synthCount === 1
            ? noTable
            : synthCount === 2
              ? tableWithExtraneous
              : cleanTable,
      };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Present the delegated explore session's transit-feed findings as a Markdown table. table: City | Service | Frequency. Keep it to those columns only — do not add a provider or pricing matrix.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the requested table survived (table-columns) and the unrequested provider matrix
  // introduced by the re-synthesis was dropped (extraneous, rounds 1+).
  assert.match(inline.content, /\| City \| Service \| Frequency \|/);
  assert.match(engine.content, /\| City \| Service \| Frequency \|/);
  assert.doesNotMatch(inline.content, /是否明确支持 search\/web_search/);
  assert.doesNotMatch(engine.content, /是否明确支持 search\/web_search/);
  assert.doesNotMatch(engine.content, /Provider support matrix/);
  // substring unique to the final extraneous-repaired synthesis.
  assert.match(engine.content, /transit-feed findings:/);
});

test("cutover parity: weak-evidence-synthesis completed-closeout repair is identical between inline and engine paths", async () => {
  // weak-evidence is the LAST every-round member (inline completed :2154 / natural-finish
  // :1231). The closeout synthesis weakens verified evidence with placeholder uncertainty
  // ("maybe"/"TBD"), so shouldRepairWeakEvidenceSynthesis (WEAK_UNCERTAINTY branch) fires
  // on both paths and the rewrite states the verified facts plainly. Isolated to this
  // predicate: the task names no table / sources / timeout / next action / conclusion /
  // risk, the evidence carries no labels, and the synthesis has no DNS/ban/estimate
  // wording, so nothing earlier fires (it is checked last, after the round-0 block).
  // generateFinalAfterToolRoundLimit does NOT pre-repair weak-evidence (unlike
  // extraneous), so a single-synthesis scenario exercises this block directly.
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result: "The delegated session verified the plan is $10 per month and supports offline mode.",
    final_content: null,
    payload: null,
  });
  const weakSynthesis =
    "The delegated session confirmed the plan; it maybe supports offline mode and pricing is TBD.";
  const fixedAnswer =
    "Verified from the delegated session: the plan is $10 per month and offline mode is observed as supported.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "check pricing" } }],
        };
      }
      // tool-free syntheses: 1st = weakens evidence with maybe/TBD, 2nd = the repair.
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? weakSynthesis : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt: "Review the delegated session's pricing finding and summarize what was verified.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the placeholder uncertainty is gone, replaced by
  // the plainly-stated verified facts (substring unique to the repair).
  assert.doesNotMatch(inline.content, /maybe|TBD/i);
  assert.doesNotMatch(engine.content, /maybe|TBD/i);
  assert.match(inline.content, /Verified from the delegated session/);
  assert.match(engine.content, /Verified from the delegated session/);
  assert.match(engine.content, /\$10 per month/);
});

test("cutover parity: completed-closeout round-1 source-evidence sees an earlier tool round's label", async () => {
  // Exercises the sourceBoundedEvidenceText cleanup: an earlier `lookup` round carries a
  // source label, THEN a sessions_spawn completes. The completing round's evidence
  // (completedProductBriefEvidenceText) does NOT contain that earlier label — only the
  // full-toolTrace sourceBoundedEvidenceText does. round 0 fires table-columns (the
  // closeout synthesis has no table); the table-columns repair still drops the label, so
  // round 1 source-evidence must fire — and it only sees the label via the round->0
  // natural-finish formula. Inline reaches the same label through its tool-free natural-
  // finish cascade. With the old every-round completedProductBriefEvidenceText the engine
  // would never see the earlier label and would diverge (mutation-verified).
  const lookupEvidence =
    '{"label":"Helsinki transit feed","evidence":"verified the feed refresh cadence"}';
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    // NB: no "Helsinki transit feed" label here — it lived only in the earlier lookup.
    result: "The delegated session verified both feeds publish GTFS-RT vehicle positions every 15 seconds.",
    final_content: null,
    payload: null,
  });
  const noTable =
    "The transit feeds publish GTFS-RT vehicle positions every 15 seconds.";
  const tableNoLabel =
    "| City | Service | Frequency |\n| --- | --- | --- |\n| Helsinki | GTFS-RT vehicle positions | every 15 seconds |\n| Tampere | GTFS-RT vehicle positions | every 15 seconds |";
  const tableWithLabel =
    tableNoLabel + "\n\nEvidence / Sources: Helsinki transit feed verified the refresh cadence.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let callCount = 0;
    gateway.generate = async () => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      callCount += 1;
      if (callCount === 1) {
        return { ...base, text: "looking up", toolCalls: [{ id: "c1", name: "lookup", input: {} }] };
      }
      if (callCount === 2) {
        return { ...base, text: "delegating", toolCalls: [{ id: "c2", name: "sessions_spawn", input: { agent_id: "explore", task: "verify feeds" } }] };
      }
      // tool-free syntheses: 3 = no table (trips table-columns), 4 = table w/o label
      // (trips source-evidence in round 1), 5+ = table + restored label.
      return { ...base, text: callCount === 3 ? noTable : callCount === 4 ? tableNoLabel : tableWithLabel };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [
        { name: "lookup", description: "l", inputSchema: { type: "object" } },
        { name: "sessions_spawn", description: "s", inputSchema: { type: "object" } },
      ];
    },
    async execute(input) {
      const content = input.call.name === "lookup" ? lookupEvidence : completedEvidence;
      return { toolCallId: input.call.id, toolName: input.call.name, content };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Look up the transit feeds, then delegate verification. Present the findings as a Markdown table. table: City | Service | Frequency. Also list the exact sources you checked, keeping each source label visible.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // table-columns repaired (round 0) AND the earlier-round source label was carried
  // forward (round 1, via the natural-finish evidence formula).
  assert.match(inline.content, /\| City \| Service \| Frequency \|/);
  assert.match(engine.content, /\| City \| Service \| Frequency \|/);
  assert.match(inline.content, /Helsinki transit feed/);
  assert.match(engine.content, /Helsinki transit feed/);
  assert.match(engine.content, /Evidence \/ Sources/);
});

test("cutover parity: browser-evidence-dimensions completed-closeout repair is identical between inline and engine paths", async () => {
  // browser-evidence-dimensions is the last completed-cascade predicate (inline :2100,
  // between deliverables and false-evidence). It is completed-ONLY (absent from the
  // tool-free natural-finish cascade), so it lives in the repairRound===0 block and uses
  // the bare finalContents evidenceText. The task requests a browser dimension (details
  // popup); the completed evidence shows it; the closeout synthesis omits the "popup"
  // dimension, so shouldRepairMissingBrowserEvidenceDimensions fires on both paths and
  // the rewrite carries the popup/P-42/manager-acknowledgement forward. Isolated to the
  // "details popup state" dimension (the only one with no `negated` field): no table /
  // sources / timeout / next-action / conclusion / risk in the task, no labels in the
  // evidence. generateFinalAfterToolRoundLimit does not pre-repair browser-dims, so a
  // single-synthesis test exercises the block directly (mutation-verified).
  const completedEvidence = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:explore:task-1:c1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result:
      "The delegated session opened the details popup on the release board: the popup opened on row P-42 and recorded the manager acknowledgement for sign-off.",
    final_content: null,
    payload: null,
  });
  const noPopupDimension =
    "The delegated session confirmed row P-42 on the release board is cleared and the sign-off was recorded.";
  const fixedAnswer =
    "The details popup opened for row P-42 and recorded the manager acknowledgement for sign-off; residual risk: external exposure remains not verified.";
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let synthCount = 0;
    gateway.generate = async (input) => {
      const base = {
        modelId: "claude-test",
        providerId: "anthropic",
        protocol: "anthropic-compatible" as const,
        adapterName: "test",
        raw: {},
      };
      if ((input.tools?.length ?? 0) > 0) {
        return {
          ...base,
          text: "delegating",
          toolCalls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", task: "open popup" } }],
        };
      }
      // tool-free syntheses: 1st omits the popup dimension, 2nd = the repair.
      synthCount += 1;
      return { ...base, text: synthCount === 1 ? noPopupDimension : fixedAnswer };
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedEvidence };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Review the delegated browser session and tell me what the details popup on the release board showed.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the repair fired on both paths: the requested popup dimension is carried forward...
  assert.match(inline.content, /details popup opened for row P-42/);
  assert.match(engine.content, /details popup opened for row P-42/);
  assert.match(engine.content, /manager acknowledgement/);
  // ...replacing the dimension-less first synthesis.
  assert.doesNotMatch(engine.content, /is cleared and the sign-off was recorded/);
});

test("cutover parity: setup-only awaiting-context tool suppression is identical between inline and engine paths", async () => {
  // Stage 7 S1 (pre-execute). The model returns a memory_search tool call on a
  // setup-only "awaiting context" turn; both paths SUPPRESS the call (drop it +
  // force a tool-free guidance round) rather than executing — engine via the new
  // onSuppressToolCalls hook, inline via its pre-execute suppress branch (:1010).
  const finalText =
    "Helios-47 launch-planning thread is ready. No research is queued; the mission can continue when launch context is provided.";
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt: [
      "Start a launch-planning thread for Helios-47.",
      "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
    ].join("\n"),
  };
  const run = async (reactEngine: "inline" | "engine") => {
    const inputs: GenerateTextInput[] = [];
    let executeCalled = false;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input: GenerateTextInput) => {
      inputs.push(input);
      if (inputs.length === 1) {
        return toolCallResult("toolu-memory", "memory_search", {
          query: "Helios-47 launch planning mission context",
        });
      }
      return {
        text: finalText,
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
            name: "memory_search",
            description: "Search durable memory",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        ];
      },
      async execute() {
        executeCalled = true;
        throw new Error("setup-only turn must not execute tools");
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
    return { result, inputs, executeCalled };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // both suppressed: tools never executed, exactly 2 gateway calls, and the 2nd
  // round is forced tool-free ("none") with the guidance prompt.
  assert.equal(inline.executeCalled, false);
  assert.equal(engine.executeCalled, false);
  assert.equal(inline.inputs.length, 2);
  assert.equal(engine.inputs.length, 2);
  assert.equal(inline.inputs[1]?.toolChoice, "none");
  assert.equal(engine.inputs[1]?.toolChoice, "none");
  assert.match(engine.result.content, /No research is queued/);
});

test("cutover parity: forced-spawn missing-browser-evidence is identical between inline and engine paths", async () => {
  // Stage 7 S2 (forced-spawn). A tool-free candidate admits it used a raw HTTP fetch
  // instead of the browser; shouldRepairMissingBrowserEvidence re-arms a REAL
  // sessions_spawn round (engine via onRepairRound + consumesRound:true, inline via
  // nextToolChoice={type:tool,name:sessions_spawn}). The spawn returns a completed
  // browser session, so both paths converge on the completed-closeout synthesis.
  const completedBrowserSession = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: "worker:browser:task-1:s1",
    agent_id: "browser",
    status: "completed",
    tool_chain: [],
    result: "Browser session read the rendered dashboard DOM: 12 open, 3 shipped, 1 cancelled.",
    final_content: null,
    payload: null,
  });
  const round0Candidate =
    "I used a raw HTTP fetch of the server HTML instead of a browser, so the rendered DOM state was not verified.";
  const finalSynthesis =
    "Browser-verified order statuses: 12 open, 3 shipped, 1 cancelled (read from the rendered dashboard DOM).";
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let n = 0;
    gateway.generate = async () => {
      n += 1;
      if (n === 1) return { ...base, text: round0Candidate }; // tool-free candidate
      if (n === 2) {
        // the forced sessions_spawn round
        return { ...base, text: "spawning a browser session", toolCalls: [{ id: "s1", name: "sessions_spawn", input: { agent_id: "browser", task: "open the dashboard and read the rendered DOM" } }] };
      }
      return { ...base, text: finalSynthesis }; // completed-closeout synthesis
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      return { toolCallId: input.call.id, toolName: input.call.name, content: completedBrowserSession };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Open the live dashboard at http://127.0.0.1:7000/orders and report the rendered DOM order-status values exactly as a user would see them in the browser. Use the browser-visible page, not raw server HTML.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the forced sessions_spawn round fired on both paths (1 tool call) and both
  // converged on the completed-closeout synthesis, not the deficient candidate.
  assert.equal(
    (engine.metadata?.["toolUse"] as { toolCallCount?: number } | undefined)?.toolCallCount,
    (inline.metadata?.["toolUse"] as { toolCallCount?: number } | undefined)?.toolCallCount,
  );
  assert.equal((engine.metadata?.["toolUse"] as { toolCallCount?: number } | undefined)?.toolCallCount, 1);
  assert.equal(
    (engine.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "completed_sub_agent_final",
  );
  assert.equal(
    (inline.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined)?.reason,
    "completed_sub_agent_final",
  );
  assert.match(engine.content, /12 open, 3 shipped, 1 cancelled/);
  assert.doesNotMatch(engine.content, /raw HTTP fetch/);
});

test("cutover parity: forced-spawn missing-product-signal-evidence is identical between inline and engine paths", async () => {
  // Stage 7 S3 (forced-spawn, product-signal branch). A tool-free candidate reports
  // only the static HTML shell; shouldRepairMissingProductSignalBrowserEvidence
  // re-arms a sessions_spawn round (same consumesRound mechanism). The spawn returns
  // PLAIN evidence (not a completed session), so both paths continue to a round-2
  // natural-finish synthesis. Isolated to product-signal: the task is not browser-
  // evidence-requiring, so browser-evidence (checked first, shared marker) stays quiet.
  const round0Candidate =
    "I fetched the static server HTML shell, but the product-signals counters were not confirmed because the browser rendering could not be verified.";
  const finalSynthesis =
    "Product-signals (browser-rendered): signups 142, activation rate 38%, churn 4 — read from the live counters on the rendered page.";
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const makeGateway = (): LLMGateway => {
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    let n = 0;
    gateway.generate = async () => {
      n += 1;
      if (n === 1) return { ...base, text: round0Candidate }; // tool-free candidate
      if (n === 2) {
        return { ...base, text: "spawning a browser session", toolCalls: [{ id: "s1", name: "sessions_spawn", input: { agent_id: "browser", task: "open the product-signals page and read the live counters" } }] };
      }
      return { ...base, text: finalSynthesis }; // round-2 natural-finish synthesis
    };
    return gateway;
  };
  const makeExecutor = (): RoleToolExecutor => ({
    definitions() {
      return [{ name: "sessions_spawn", description: "s", inputSchema: { type: "object" } }];
    },
    async execute(input) {
      // PLAIN evidence (not a completed session_tool_result) → no completed closeout.
      return { toolCallId: input.call.id, toolName: input.call.name, content: "Browser session observed the live counters on the rendered product-signals page." };
    },
  });
  const packet: RolePromptPacket = {
    ...buildPacket(),
    taskPrompt:
      "Inspect the product-signals page at http://127.0.0.1:7000/product-signals and report the live counter totals shown there. Return the exact visible counter values.",
  };
  const run = (reactEngine: "inline" | "engine") =>
    new LLMRoleResponseGenerator({
      gateway: makeGateway(),
      toolLoop: { executor: makeExecutor(), maxRounds: 8 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet });
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.content, inline.content);
  assert.deepEqual(engine.mentions, inline.mentions);
  // the product-signal forced spawn fired on both paths (1 tool call); plain evidence
  // → no completed closeout, a round-2 natural finish on both.
  assert.equal(
    (engine.metadata?.["toolUse"] as { toolCallCount?: number } | undefined)?.toolCallCount,
    (inline.metadata?.["toolUse"] as { toolCallCount?: number } | undefined)?.toolCallCount,
  );
  assert.equal((engine.metadata?.["toolUse"] as { toolCallCount?: number } | undefined)?.toolCallCount, 1);
  assert.equal(engine.metadata?.["toolLoopCloseout"], undefined);
  assert.equal(inline.metadata?.["toolLoopCloseout"], undefined);
  assert.match(engine.content, /signups 142/);
  assert.doesNotMatch(engine.content, /static server HTML shell/);
});

test("cutover parity: empty-round sessions_send continuation injection is identical between inline and engine paths", async () => {
  // Stage 7 S4 (onRoundEmpty). The task is an explicit continuation of a cancelled
  // session, and the model returns an EMPTY round (no tool calls). Both paths inject
  // a synthetic sessions_send to continue that session — inline at :567, engine via
  // the now-wired onRoundEmpty hook. The injected round's evidence is a completed
  // session, so both converge on the completed-closeout synthesis. The toolCallCount/
  // roundCount assertions also pin the host event-consumer fix that records the
  // injected round in toolTrace (without it, the engine would report 0 tool rounds).
  const taskPrompt = [
    "Task brief:",
    "Continue from the cancelled source-check attempt in this mission.",
    "",
    "Recent turns:",
    "[user] Continue from the cancelled source-check attempt in this mission.",
    '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:explore:task-1:toolu-cancelled","agent_id":"explore","result":"operator cancelled active source verification"}',
  ].join("\n");
  const finalSynthesis = "Final answer from cancelled-session continuation.";
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input: GenerateTextInput) => {
      if ((input.tools?.length ?? 0) === 0) {
        return { ...base, text: finalSynthesis }; // completed-closeout synthesis
      }
      // round 0: an EMPTY round (no tool calls) so onRoundEmpty injects sessions_send.
      return { ...base, text: "Acknowledged; here is my plan." };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          { name: "sessions_spawn", description: "spawn", inputSchema: { type: "object" } },
          {
            name: "sessions_send",
            description: "continue",
            inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
          },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-1",
            session_key: input.call.input.session_key,
            agent_id: "explore",
            status: "completed",
            result: "Cancelled session resumed with source evidence.",
          }),
        };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.equal(engine.result.content, finalSynthesis);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the injection fired on both paths: the only sessions_send is the injected one
  // (the model returned an empty round), targeting the cancelled session_key.
  assert.equal(engine.executed[0]?.name, "sessions_send");
  assert.equal(inline.executed[0]?.name, "sessions_send");
  assert.equal(engine.executed[0]?.input.session_key, "worker:explore:task-1:toolu-cancelled");
  assert.equal(engine.executed.length, 1);
  assert.equal(inline.executed.length, 1);
  // completed-closeout parity + the toolTrace counts (catches the injected-round
  // event-consumer fix: without it the engine reports 0 rounds/calls).
  const engineCloseout = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; toolName?: string; toolCallCount?: number; roundCount?: number } | undefined;
  const inlineCloseout = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; toolName?: string; toolCallCount?: number; roundCount?: number } | undefined;
  assert.equal(engineCloseout?.reason, "completed_sub_agent_final");
  assert.equal(inlineCloseout?.reason, "completed_sub_agent_final");
  assert.equal(engineCloseout?.toolName, "sessions_send");
  assert.equal(engineCloseout?.toolCallCount, 1);
  assert.equal(engineCloseout?.roundCount, 1);
  assert.equal(engineCloseout?.toolCallCount, inlineCloseout?.toolCallCount);
  assert.equal(engineCloseout?.roundCount, inlineCloseout?.roundCount);
});

test("cutover parity: an empty-round continuation injection past the wall-clock budget closes out instead of executing, identically on both paths", async () => {
  // Stage 7 S4 wall-clock guard (codex #515 P2). After a real tool round has run and
  // the wall-clock budget is exhausted, an EMPTY model round with a pending
  // continuation directive must NOT inject + execute another sessions_send — it must
  // close out wall_clock_budget. Inline injects the synthetic call (:577) BEFORE the
  // wall-clock check (:1285), so the budget closeout wins and the continuation never
  // runs. The engine's onRoundEmpty injects AFTER onToolCallsClose, so the wall-clock
  // pre-check in onToolCallsClose (step 4b) must fire on the empty round using the
  // would-be-injected call. Without it the engine would run a tool round past budget.
  const taskPrompt = [
    "Task brief:",
    "Continue from the cancelled source-check attempt in this mission.",
    "",
    "Recent turns:",
    "[user] Continue from the cancelled source-check attempt in this mission.",
    '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:explore:task-1:toolu-cancelled","agent_id":"explore","result":"operator cancelled active source verification"}',
  ].join("\n");
  const finalSynthesis = "Final answer after wall-clock budget.";
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let now = 0;
    let toolRounds = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input: GenerateTextInput) => {
      if ((input.tools?.length ?? 0) === 0) {
        return { ...base, text: finalSynthesis }; // wall-clock final synthesis
      }
      toolRounds += 1;
      if (toolRounds === 1) {
        // round 0: a neutral tool round — establishes a tool round in the trace and
        // burns the budget. Its result has no "session_key"/"sessions" token, so it
        // does NOT enter buildContinuationDirectiveContext: the round-1 continuation
        // directive stays == the taskPrompt directive on BOTH paths (no divergence).
        return toolCallResult("toolu-note-0", "record_note", { note: "checked" });
      }
      // round 1: an EMPTY round; onRoundEmpty WOULD inject a sessions_send, but the
      // budget is now exhausted, so the wall-clock closeout must win.
      return { ...base, text: "Still thinking." };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          {
            name: "record_note",
            description: "record",
            inputSchema: { type: "object", properties: { note: { type: "string" } } },
          },
          {
            name: "sessions_send",
            description: "continue",
            inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
          },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        now = 200; // advance past the 100ms budget so the next round is over budget
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ ok: true }),
        };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128, maxWallClockMs: 100 },
      clock: { now: () => now },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.equal(engine.result.content, finalSynthesis);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // The continuation was NEVER executed on either path: only the round-0 listing ran.
  assert.equal(engine.executed.length, 1);
  assert.equal(inline.executed.length, 1);
  assert.equal(engine.executed[0]?.name, "record_note");
  assert.equal(inline.executed[0]?.name, "record_note");
  assert.ok(!engine.executed.some((call) => call.name === "sessions_send"));
  assert.ok(!inline.executed.some((call) => call.name === "sessions_send"));
  const engineCloseout = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; pendingToolCallCount?: number; toolCallCount?: number; roundCount?: number } | undefined;
  const inlineCloseout = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; pendingToolCallCount?: number; toolCallCount?: number; roundCount?: number } | undefined;
  assert.equal(engineCloseout?.reason, "wall_clock_budget");
  assert.equal(inlineCloseout?.reason, "wall_clock_budget");
  assert.equal(engineCloseout?.pendingToolCallCount, 1);
  assert.equal(inlineCloseout?.pendingToolCallCount, 1);
  assert.equal(engineCloseout?.toolCallCount, inlineCloseout?.toolCallCount);
  assert.equal(engineCloseout?.roundCount, inlineCloseout?.roundCount);
});

test("cutover parity: an empty round with pseudo tool-call markup still injects the continuation instead of closing out pseudo_tool_call, identically on both paths", async () => {
  // Stage 7 S4 pseudo precedence (codex #515 P2). The model returns NO native tool
  // calls but its text carries tool-call markup, AND the task is an explicit
  // continuation of a cancelled session. Inline injects the synthetic sessions_send
  // (:567) BEFORE the pseudo_tool_call closeout (:1035), so the injection wins and
  // the continuation runs. The engine's onToolCallsClose checks pseudo_tool_call
  // (step 3) before onRoundEmpty could inject, so without the pendingContinuation
  // guard it would wrongly close out pseudo_tool_call and SKIP the required
  // continuation — diverging from inline.
  const taskPrompt = [
    "Task brief:",
    "Continue from the cancelled source-check attempt in this mission.",
    "",
    "Recent turns:",
    "[user] Continue from the cancelled source-check attempt in this mission.",
    '[tool] {"protocol":"turnkeyai.session_tool_result.v1","status":"cancelled","session_key":"worker:explore:task-1:toolu-cancelled","agent_id":"explore","result":"operator cancelled active source verification"}',
  ].join("\n");
  const finalSynthesis = "Final answer from resumed cancelled session.";
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input: GenerateTextInput) => {
      if ((input.tools?.length ?? 0) === 0) {
        return { ...base, text: finalSynthesis }; // completed-closeout synthesis
      }
      // round 0: NO native tool calls, but tool-call markup in the text — the
      // pseudo_tool_call trigger that must NOT win over the continuation injection.
      return { ...base, text: "<tool_call>resume</tool_call>" };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          {
            name: "sessions_send",
            description: "continue",
            inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
          },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            task_id: "task-1",
            session_key: input.call.input.session_key,
            agent_id: "explore",
            status: "completed",
            result: "Cancelled session resumed with source evidence.",
          }),
        };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.equal(engine.result.content, finalSynthesis);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the continuation was injected + executed on BOTH paths despite the markup.
  assert.equal(engine.executed.length, 1);
  assert.equal(inline.executed.length, 1);
  assert.equal(engine.executed[0]?.name, "sessions_send");
  assert.equal(inline.executed[0]?.name, "sessions_send");
  assert.equal(engine.executed[0]?.input.session_key, "worker:explore:task-1:toolu-cancelled");
  const engineCloseout = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; toolCallCount?: number } | undefined;
  const inlineCloseout = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; toolCallCount?: number } | undefined;
  // NOT pseudo_tool_call — the continuation completed.
  assert.equal(engineCloseout?.reason, "completed_sub_agent_final");
  assert.equal(inlineCloseout?.reason, "completed_sub_agent_final");
  assert.equal(engineCloseout?.toolCallCount, 1);
  assert.equal(engineCloseout?.toolCallCount, inlineCloseout?.toolCallCount);
});

test("cutover parity: forced permission_result before a completed-session closeout is identical between inline and engine paths", async () => {
  // Stage 7 S5. A round completes a delegated session for an approval-wait-timeout
  // task whose latest permission step is a still-pending permission_query. Both paths
  // run a forced permission_result round (host-authored, no model call) to observe the
  // operator decision BEFORE the completed-session closeout — inline at :1691, engine
  // via the new onAfterExecuteContinue hook. The permission_result reports
  // approval_wait_timeout, so both converge on the same closeout from that evidence.
  const taskPrompt = [
    "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
    "Request approval before applying the browser action.",
    "If the operator decision remains pending after the bounded wait, close out honestly as an approval wait-timeout and do not perform the form submission.",
  ].join("\n");
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const completedSessionContent = JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-approval-inspect",
    session_key: "worker:explore:task-approval-inspect:toolu-spawn",
    agent_id: "explore",
    status: "completed",
    tool_chain: ["explore"],
    result:
      "Rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. Submit control present. No form submission ran.",
    final_content:
      "Inspect local approval form: rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. Submit control present. No form submission ran.",
    payload: {
      mode: "llm_sub_agent",
      workerType: "explore",
      content:
        "Inspect local approval form: rendered approval form observed. Marker TURNKEYAI_APPROVAL_FIXTURE_OK visible. Submit control present. No form submission ran.",
    },
  });
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        // round 0: spawn a completed (non-browser) session AND query a still-pending
        // approval — the model emits both directly (no normalization pipeline needed).
        return {
          ...base,
          text: "Spawning evidence and querying approval.",
          toolCalls: [
            { id: "toolu-spawn", name: "sessions_spawn", input: { agent_id: "explore", task: "inspect approval form" } },
            { id: "toolu-query", name: "permission_query", input: { action: "browser.form.submit" } },
          ],
        };
      }
      // round 1 (after the forced permission_result round): a tool-free closeout that
      // is ALREADY a complete approval-wait-timeout closeout, so the inline-only
      // approval-wait-timeout repair (shouldRepairApprovalWaitTimeoutCloseout, a
      // natural-finish repair not yet cut over) does NOT fire on either path — isolating
      // S5's forced permission_result as the only behavioral difference under test.
      return {
        ...base,
        text: "The approval is still pending after the bounded wait timeout. The form was not submitted and no side effects were performed. Residual risk: the submit step remains unverified because pending approval remains. Next action: ask the operator to approve or deny, then re-run the attempt.",
        toolCalls: [],
      };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          { name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" } } } },
          { name: "permission_query", description: "request approval", inputSchema: { type: "object", properties: { action: { type: "string" } } } },
          { name: "permission_result", description: "read approval", inputSchema: { type: "object", properties: { approval_id: { type: "string" } } } },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        if (input.call.name === "permission_query") {
          return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "pending", approval_id: "ap-1" }) };
        }
        if (input.call.name === "permission_result") {
          return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "approval_wait_timeout", approval_id: "ap-1" }) };
        }
        return { toolCallId: input.call.id, toolName: input.call.name, content: completedSessionContent };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the forced permission_result ran on BOTH paths, with the pending approval_id.
  const engineNames = engine.executed.map((c) => c.name);
  const inlineNames = inline.executed.map((c) => c.name);
  assert.deepEqual(engineNames, inlineNames);
  assert.ok(engineNames.includes("permission_result"));
  const enginePR = engine.executed.find((c) => c.name === "permission_result");
  const inlinePR = inline.executed.find((c) => c.name === "permission_result");
  assert.equal(enginePR?.input.approval_id, "ap-1");
  assert.equal(inlinePR?.input.approval_id, "ap-1");
  // closeout parity (reason + the forced round is counted in BOTH traces).
  const engineCloseout = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout?.reason, inlineCloseout?.reason);
  assert.equal(engineCloseout?.roundCount, inlineCloseout?.roundCount);
});

test("cutover parity: a model-call error with a pending approval forces permission_result before the evidence fallback, identically on both paths", async () => {
  // Stage 7 S6. A tool round queried a still-pending approval; the NEXT model call
  // then throws. Before the tool_evidence_fallback closeout, both paths run a forced
  // permission_result round (host-authored, no model call) to observe the operator
  // decision — inline at :388, engine via the widened onModelCallError { messages }
  // continuation. The decision is approval_wait_timeout; the following model call also
  // throws, so both fall back to the same local-evidence closeout (the forced
  // permission_result is now in the trace, so the check is idempotent — no loop).
  const taskPrompt = [
    "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
    "Request approval before applying the browser action.",
    "If the operator decision remains pending after the bounded wait, close out honestly as an approval wait-timeout and do not perform the form submission.",
  ].join("\n");
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        // round 0: gather real (non-control-plane) evidence AND query a still-pending
        // approval. No completed session — so neither the completed-session closeout
        // nor the S5 post-execute forced check pre-empts the model-error path, and the
        // search evidence lets the fallback synthesize (permission tools alone are
        // control-plane and would force a rethrow).
        return {
          ...base,
          text: "Gathering evidence and querying approval.",
          toolCalls: [
            { id: "toolu-search", name: "search", input: { query: "approval form status" } },
            { id: "toolu-query", name: "permission_query", input: { action: "browser.form.submit" } },
          ],
        };
      }
      // every later model call throws — the forced permission_result round runs once,
      // then the next throw falls back to the local-evidence closeout.
      throw new Error("final synthesis provider unavailable");
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          { name: "search", description: "search", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
          { name: "permission_query", description: "request approval", inputSchema: { type: "object", properties: { action: { type: "string" } } } },
          { name: "permission_result", description: "read approval", inputSchema: { type: "object", properties: { approval_id: { type: "string" } } } },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        if (input.call.name === "search") {
          return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ summary: "The local approval form renders with marker TURNKEYAI_APPROVAL_FIXTURE_OK; submit control present; no submission ran." }) };
        }
        if (input.call.name === "permission_query") {
          return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "pending", approval_id: "ap-1" }) };
        }
        return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "approval_wait_timeout", approval_id: "ap-1" }) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the forced permission_result ran on BOTH paths, with the pending approval_id.
  assert.deepEqual(engine.executed.map((c) => c.name), inline.executed.map((c) => c.name));
  assert.deepEqual(engine.executed.map((c) => c.name), ["search", "permission_query", "permission_result"]);
  const enginePR = engine.executed.find((c) => c.name === "permission_result");
  const inlinePR = inline.executed.find((c) => c.name === "permission_result");
  assert.equal(enginePR?.input.approval_id, "ap-1");
  assert.equal(inlinePR?.input.approval_id, "ap-1");
  // both fall back to the same local-evidence closeout after the second throw.
  const engineCloseout = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout?.reason, "tool_evidence_fallback");
  assert.equal(inlineCloseout?.reason, "tool_evidence_fallback");
  assert.equal(engineCloseout?.roundCount, inlineCloseout?.roundCount);
});

test("cutover parity: a timed-out approved browser session is continued via sessions_send before the timeout closeout, identically on both paths", async () => {
  // Stage 7 S7 branch 1 (shouldContinueTimedOutApprovedBrowserSession, inline :1562).
  // An already-approved browser action times out before verification; both paths
  // append the approved-browser timeout-continuation prompt and force a sessions_send
  // round to resume it — BEFORE the sub_agent_timeout closeout — then close out from
  // the resumed completed evidence.
  const taskPrompt = [
    "Operator decision recorded for approval ap-1.",
    "Action: browser.form.submit.",
    "The operator approved it, and the runtime has already recorded permission.result and permission.applied; the runtime permission cache is already applied.",
    "Do not call permission tools again. Continue from the approved point: perform only the approved scoped action now and verify the result before the final answer.",
  ].join("\n");
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const sessionKey = "worker:browser:approved-submit:toolu-submit";
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        return { ...base, text: "Spawning the approved browser action.", toolCalls: [{ id: "toolu-submit", name: "sessions_spawn", input: { agent_id: "browser", task: "Perform the already-approved dry-run browser.form.submit and verify the post-submit page." } }] };
      }
      if (calls === 2) {
        return { ...base, text: "Continuing the timed-out approved session.", toolCalls: [{ id: "toolu-continue", name: "sessions_send", input: { session_key: sessionKey, message: "Continue the approved browser.form.submit action and verify the post-submit page state." } }] };
      }
      return { ...base, text: "Approved browser.form.submit completed. Post-submit evidence: TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally.", toolCalls: [] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          { name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" } } } },
          { name: "sessions_send", description: "continue", inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } } },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        if (input.call.name === "sessions_send") {
          return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-approved-submit", session_key: sessionKey, agent_id: "browser", status: "completed", tool_chain: ["browser_act"], result: "Approved dry-run submit completed.", final_content: "Approved browser.form.submit completed. TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally.", payload: { mode: "llm_sub_agent", workerType: "browser", content: "Approved browser.form.submit completed. TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally." } }) };
        }
        // sessions_spawn → timeout (isError) so findSubAgentToolTimeout fires.
        return { toolCallId: input.call.id, toolName: input.call.name, isError: true, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-approved-submit", session_key: sessionKey, agent_id: "browser", status: "timeout", timeout_seconds: 45, evidence_available: true, evidence_summary: "Execution paused before completion. Reason: sessions_spawn timed out after 45s.", result: "Sub-agent session timed out after 45s before post-submit verification.", final_content: null }) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // both continued the timed-out session via sessions_send (the forced branch).
  assert.deepEqual(engine.executed.map((c) => c.name), inline.executed.map((c) => c.name));
  assert.deepEqual(engine.executed.map((c) => c.name), ["sessions_spawn", "sessions_send"]);
  assert.equal(engine.executed[1]?.input.session_key, sessionKey);
  const engineCloseout = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout?.reason, inlineCloseout?.reason);
  assert.equal(engineCloseout?.roundCount, inlineCloseout?.roundCount);
});

test("cutover parity: an incomplete approved browser session is continued via sessions_send before the completed closeout, identically on both paths", async () => {
  // Stage 7 S7 branch 4 (findIncompleteApprovedBrowserSession, inline :1626). An
  // already-applied approval delegated a browser action, but the completed session
  // only inspected the form (no submission ran). Both paths append the incomplete-
  // approved-browser continuation prompt and force a sessions_send round to finish the
  // approved action before the completed_sub_agent_final closeout.
  const taskPrompt = [
    "Operator decision recorded for approval ap-1.",
    "Action: browser.form.submit.",
    "The operator approved it, and the runtime has already recorded permission.result and permission.applied; the runtime permission cache is already applied.",
    "Do not call permission tools again. Continue from the approved point: perform only the approved scoped action now and verify the result before the final answer.",
  ].join("\n");
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const sessionKey = "worker:browser:approved-submit:toolu-submit";
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        return { ...base, text: "Spawning the approved browser action.", toolCalls: [{ id: "toolu-submit", name: "sessions_spawn", input: { agent_id: "browser", task: "Perform the already-approved dry-run browser.form.submit and verify the post-submit page." } }] };
      }
      if (calls === 2) {
        return { ...base, text: "Finishing the approved action.", toolCalls: [{ id: "toolu-continue", name: "sessions_send", input: { session_key: sessionKey, message: "Complete the approved browser.form.submit and verify the post-submit page state." } }] };
      }
      return { ...base, text: "Approved browser.form.submit completed. Post-submit evidence: TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally.", toolCalls: [] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          { name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" } } } },
          { name: "sessions_send", description: "continue", inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } } },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        if (input.call.name === "sessions_send") {
          return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-approved-submit", session_key: sessionKey, agent_id: "browser", status: "completed", tool_chain: ["browser_act"], result: "Approved dry-run submit completed.", final_content: "Approved browser.form.submit completed. TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally.", payload: { mode: "llm_sub_agent", workerType: "browser", content: "Approved browser.form.submit completed. TURNKEYAI_APPROVAL_FIXTURE_OK submitted locally." } }) };
        }
        // sessions_spawn → a COMPLETED browser session that only inspected the form:
        // the approved action is incomplete (matches the incomplete-action patterns).
        return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-approved-submit", session_key: sessionKey, agent_id: "browser", status: "completed", tool_chain: ["browser_snapshot"], result: "Pre-approval inspection: the approval form rendered. No form submission ran.", final_content: "Pre-approval inspection: the approval form rendered with TURNKEYAI_APPROVAL_FIXTURE_OK. No form submission ran; the approved action was not executed.", payload: { mode: "llm_sub_agent", workerType: "browser", content: "Pre-approval inspection: the approval form rendered with TURNKEYAI_APPROVAL_FIXTURE_OK. No form submission ran; the approved action was not executed." } }) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  assert.deepEqual(engine.executed.map((c) => c.name), inline.executed.map((c) => c.name));
  assert.deepEqual(engine.executed.map((c) => c.name), ["sessions_spawn", "sessions_send"]);
  assert.equal(engine.executed[1]?.input.session_key, sessionKey);
  const engineCloseout2 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout2 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout2?.reason, inlineCloseout2?.reason);
  assert.equal(engineCloseout2?.roundCount, inlineCloseout2?.roundCount);
});

test("cutover parity: a multi-stream delegation is not finalized after one stream — independent evidence streams continue via sessions_spawn, identically on both paths", async () => {
  // Stage 7 S8 (shouldContinueIndependentEvidenceStreams, inline :1648). A task that
  // requires three independent evidence streams completes only one; both paths append
  // the independent-evidence-stream continuation prompt and force a sessions_spawn round
  // (between branch 4 and the S5 forced permission_result) BEFORE the completed-session
  // closeout, so the remaining streams are gathered. The predicate is idempotent (its
  // continuation prompt's presence stops re-firing), so it forces exactly one round.
  const taskPrompt = [
    "Prepare a product-ready brief about the next release.",
    "These are three independent evidence streams.",
    "Research source: orchestration.",
    "Capability source: bridge.",
    "Live signal dashboard: signals.",
  ].join("\n");
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const completed = (id: string, label: string) =>
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: `task-${id}`,
      session_key: `worker:explore:task-${id}`,
      agent_id: "explore",
      status: "completed",
      tool_chain: ["explore"],
      result: `${label} evidence complete.`,
      final_content: `${label} verified evidence. Residual risk: local fixture only.`,
      payload: { mode: "llm_sub_agent", workerType: "explore", content: `${label} verified evidence. Residual risk: local fixture only.` },
    });
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        return { ...base, text: "Spawning the first stream.", toolCalls: [{ id: "toolu-one", name: "sessions_spawn", input: { agent_id: "explore", task: "Check orchestration source only.", label: "orchestration" } }] };
      }
      if (calls === 2) {
        return { ...base, text: "Spawning the remaining streams.", toolCalls: [
          { id: "toolu-two", name: "sessions_spawn", input: { agent_id: "explore", task: "Check capability bridge source only.", label: "bridge" } },
          { id: "toolu-three", name: "sessions_spawn", input: { agent_id: "explore", task: "Check live signals source only.", label: "signals" } },
        ] };
      }
      return { ...base, text: "Final brief from three independent streams: orchestration, bridge, and signals all verified.", toolCalls: [] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [{ name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" }, label: { type: "string" } } } }];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        return { toolCallId: input.call.id, toolName: input.call.name, content: completed(String(input.call.id), String(input.call.input.label ?? input.call.id)) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // both spawned all three streams (the forced continuation prevented finalizing after one).
  assert.deepEqual(engine.executed.map((c) => c.id), inline.executed.map((c) => c.id));
  assert.deepEqual(engine.executed.map((c) => c.id), ["toolu-one", "toolu-two", "toolu-three"]);
  const engineCloseout3 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout3 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout3?.reason, inlineCloseout3?.reason);
  assert.equal(engineCloseout3?.roundCount, inlineCloseout3?.roundCount);
});

test("cutover parity: the S8 forced continuation round caps over-spawned streams to the remaining count, identically on both paths", async () => {
  // Stage 7 S8 cap (codex #518 P2). After one of three required streams completes, the
  // forced continuation round returns THREE sessions_spawn (the model repeats all
  // labels), but only two streams remain. Inline caps the round to the remaining count
  // (limitIndependentEvidenceSpawnCalls, inline :513); the engine now mirrors it via the
  // onToolCalls hook, so both execute exactly the two remaining streams and drop the
  // extra — without it the engine would over-spawn a child session and break parity.
  const taskPrompt = [
    "Prepare a product-ready brief about the next release.",
    "These are three independent evidence streams.",
    "Research source: orchestration.",
    "Capability source: bridge.",
    "Live signal dashboard: signals.",
  ].join("\n");
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const completed = (id: string, label: string) =>
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: `task-${id}`,
      session_key: `worker:explore:task-${id}`,
      agent_id: "explore",
      status: "completed",
      tool_chain: ["explore"],
      result: `${label} evidence complete.`,
      final_content: `${label} verified evidence. Residual risk: local fixture only.`,
      payload: { mode: "llm_sub_agent", workerType: "explore", content: `${label} verified evidence. Residual risk: local fixture only.` },
    });
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        return { ...base, text: "Spawning the first stream.", toolCalls: [{ id: "toolu-one", name: "sessions_spawn", input: { agent_id: "explore", task: "Check orchestration source only.", label: "orchestration" } }] };
      }
      if (calls === 2) {
        // over-spawn: THREE spawns when only two streams remain — the cap must drop one.
        return { ...base, text: "Spawning the remaining streams (over-spawned).", toolCalls: [
          { id: "toolu-two", name: "sessions_spawn", input: { agent_id: "explore", task: "Check capability bridge source only.", label: "bridge" } },
          { id: "toolu-three", name: "sessions_spawn", input: { agent_id: "explore", task: "Check live signals source only.", label: "signals" } },
          { id: "toolu-four", name: "sessions_spawn", input: { agent_id: "explore", task: "Check a redundant extra source.", label: "extra" } },
        ] };
      }
      return { ...base, text: "Final brief from three independent streams: orchestration, bridge, and signals all verified.", toolCalls: [] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [{ name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" }, label: { type: "string" } } } }];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        return { toolCallId: input.call.id, toolName: input.call.name, content: completed(String(input.call.id), String(input.call.input.label ?? input.call.id)) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the redundant 4th spawn was capped on BOTH paths: exactly the two remaining ran.
  assert.deepEqual(engine.executed.map((c) => c.id), inline.executed.map((c) => c.id));
  assert.deepEqual(engine.executed.map((c) => c.id), ["toolu-one", "toolu-two", "toolu-three"]);
  assert.ok(!engine.executed.some((c) => c.id === "toolu-four"));
  const engineCloseout4 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout4 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout4?.reason, inlineCloseout4?.reason);
  assert.equal(engineCloseout4?.roundCount, inlineCloseout4?.roundCount);
});

test("cutover parity: the S8 cap keeps the inline function's behavior even when the forced round repeats an already-completed label first", async () => {
  // Stage 7 S8 cap, adversarial ordering (codex #518 follow-up). The forced round
  // repeats the already-completed label ("orchestration") FIRST, then two remaining
  // labels. limitIndependentEvidenceSpawnCalls keeps the first `remaining` spawns
  // regardless of label, so it drops the LAST one. This is a property of the SHARED
  // inline function (used by production inline at :513) — the engine onToolCalls hook
  // calls the identical function, so both paths drop the same spawn and finalize
  // identically. The cutover is behavior-preserving: deduping completed labels would
  // be a production-inline behavior change, out of scope for a parity slice (a
  // potential follow-up that must land in the shared function for BOTH paths).
  const taskPrompt = [
    "Prepare a product-ready brief about the next release.",
    "These are three independent evidence streams.",
    "Research source: orchestration.",
    "Capability source: bridge.",
    "Live signal dashboard: signals.",
  ].join("\n");
  const base = {
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible" as const,
    adapterName: "test",
    raw: {},
  };
  const completed = (id: string, label: string) =>
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: `task-${id}`,
      session_key: `worker:explore:task-${id}`,
      agent_id: "explore",
      status: "completed",
      tool_chain: ["explore"],
      result: `${label} evidence complete.`,
      final_content: `${label} verified evidence. Residual risk: local fixture only.`,
      payload: { mode: "llm_sub_agent", workerType: "explore", content: `${label} verified evidence. Residual risk: local fixture only.` },
    });
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        return { ...base, text: "Spawning the first stream.", toolCalls: [{ id: "toolu-one", name: "sessions_spawn", input: { agent_id: "explore", task: "Check orchestration source only.", label: "orchestration" } }] };
      }
      if (calls === 2) {
        // repeats the completed "orchestration" label FIRST, then the two remaining.
        return { ...base, text: "Spawning streams (repeats a completed label first).", toolCalls: [
          { id: "toolu-orch-dup", name: "sessions_spawn", input: { agent_id: "explore", task: "Re-check orchestration source.", label: "orchestration" } },
          { id: "toolu-bridge", name: "sessions_spawn", input: { agent_id: "explore", task: "Check capability bridge source only.", label: "bridge" } },
          { id: "toolu-signals", name: "sessions_spawn", input: { agent_id: "explore", task: "Check live signals source only.", label: "signals" } },
        ] };
      }
      return { ...base, text: "Final brief from the gathered independent streams.", toolCalls: [] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [{ name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" }, label: { type: "string" } } } }];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        return { toolCallId: input.call.id, toolName: input.call.name, content: completed(String(input.call.id), String(input.call.input.label ?? input.call.id)) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  // the engine faithfully mirrors the shared inline function in this adversarial
  // ordering: identical executed spawns, identical content/closeout.
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  assert.deepEqual(engine.executed.map((c) => c.id), inline.executed.map((c) => c.id));
  const engineCloseout5 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout5 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout5?.reason, inlineCloseout5?.reason);
  assert.equal(engineCloseout5?.roundCount, inlineCloseout5?.roundCount);
});

test("cutover parity: an approval-gated answer that skipped the approval gate is repaired via a forced permission_query, identically on both paths", async () => {
  // Stage 7 S9 natural-finish (shouldRepairMissingApprovalGate, inline :804). The model
  // finalizes an approval-gated browser task WITHOUT going through the approval gate
  // (no permission_* in the trace). Both paths re-arm a forced permission_query round
  // (a consumesRound onRepairRound repair), then the model walks the approval flow
  // (permission_query → result → applied → browser spawn) and closes out.
  const taskPrompt = [
    "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
    "Actually carry the safe local dry-run through the approval gate.",
    "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
  ].join("\n");
  const base = { modelId: "claude-test", providerId: "anthropic", protocol: "anthropic-compatible" as const, adapterName: "test", raw: {} };
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        // tool-free finalize that skipped the approval gate → triggers the repair.
        return { ...base, text: "The approved browser dry-run is complete and verified.", toolCalls: [] };
      }
      if (calls === 2) {
        return { ...base, text: "Requesting approval.", toolCalls: [{ id: "toolu-query", name: "permission_query", input: { action: "browser.form.submit", title: "Approve local dry-run form submit", level: "approval", scope: "mutate", worker_kind: "browser" } }] };
      }
      if (calls === 3) {
        return { ...base, text: "Apply the approved permission.", toolCalls: [
          { id: "toolu-result", name: "permission_result", input: { approval_id: "ap-1" } },
          { id: "toolu-applied", name: "permission_applied", input: { approval_id: "ap-1" } },
        ] };
      }
      if (calls === 4) {
        return { ...base, text: "Spawning the approved browser action.", toolCalls: [{ id: "toolu-browser", name: "sessions_spawn", input: { agent_id: "browser", task: "Open the approval form, submit the approved dry-run, and verify the post-submit status." } }] };
      }
      return { ...base, text: "The approved browser dry-run was submitted and verified.", toolCalls: [] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          { name: "permission_query", description: "request approval", inputSchema: { type: "object", properties: { action: { type: "string" } } } },
          { name: "permission_result", description: "read approval", inputSchema: { type: "object", properties: { approval_id: { type: "string" } } } },
          { name: "permission_applied", description: "mark applied", inputSchema: { type: "object", properties: { approval_id: { type: "string" } } } },
          { name: "sessions_spawn", description: "spawn browser", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" } } } },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        if (input.call.name === "permission_query") return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "pending", approval_id: "ap-1" }) };
        if (input.call.name === "permission_result") return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "approved", approval_id: "ap-1" }) };
        if (input.call.name === "permission_applied") return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "applied", approval_id: "ap-1" }) };
        return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-1", session_key: "worker:browser:task-1:toolu-browser", agent_id: "browser", status: "completed", tool_chain: ["browser"], result: "Approved dry-run submit completed.", final_content: "Approved dry-run submit completed. Browser verified the submitted status.", payload: { mode: "llm_sub_agent", workerType: "browser", content: "Approved dry-run submit completed. Browser verified the submitted status." } }) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the forced permission_query repair drove the full approval flow on BOTH paths.
  assert.deepEqual(engine.executed.map((c) => c.name), inline.executed.map((c) => c.name));
  assert.deepEqual(engine.executed.map((c) => c.name), ["permission_query", "permission_result", "permission_applied", "sessions_spawn"]);
  const engineCloseout6 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout6 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout6?.reason, inlineCloseout6?.reason);
  assert.equal(engineCloseout6?.roundCount, inlineCloseout6?.roundCount);
});

test("cutover parity: after the missing-approval-gate repair, a stubborn browser spawn is rewritten to permission_query, identically on both paths", async () => {
  // Stage 7 S9 normalizer (enforceMissingApprovalGateRepairToolCalls, inline :474). After
  // the natural-finish repair records its marker and forces permission_query, the model
  // still returns a browser sessions_spawn (ignoring the forced choice). Both paths
  // rewrite that spawn into a permission_query so the approval gate cannot be bypassed —
  // the engine via the onToolCalls hook, inline via the same normalizer — then walk the
  // approval flow to a completed close-out.
  const taskPrompt = [
    "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
    "Actually carry the safe local dry-run through the approval gate.",
    "Request approval before applying the browser action, then report what was approved and what evidence the page showed.",
  ].join("\n");
  const base = { modelId: "claude-test", providerId: "anthropic", protocol: "anthropic-compatible" as const, adapterName: "test", raw: {} };
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    let calls = 0;
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (_input: GenerateTextInput) => {
      calls += 1;
      if (calls === 1) {
        return { ...base, text: "The approved browser dry-run is complete and verified.", toolCalls: [] };
      }
      if (calls === 2) {
        // stubborn: a browser spawn instead of the forced permission_query — the
        // enforce-gate normalizer must rewrite it to permission_query.
        return { ...base, text: "Spawning the browser action directly.", toolCalls: [{ id: "toolu-spawn-early", name: "sessions_spawn", input: { agent_id: "browser", task: "Submit the dry-run browser.form.submit now." } }] };
      }
      if (calls === 3) {
        return { ...base, text: "Apply the approved permission.", toolCalls: [
          { id: "toolu-result", name: "permission_result", input: { approval_id: "ap-1" } },
          { id: "toolu-applied", name: "permission_applied", input: { approval_id: "ap-1" } },
        ] };
      }
      if (calls === 4) {
        return { ...base, text: "Spawning the approved browser action.", toolCalls: [{ id: "toolu-browser", name: "sessions_spawn", input: { agent_id: "browser", task: "Open the approval form, submit the approved dry-run, and verify the post-submit status." } }] };
      }
      return { ...base, text: "The approved browser dry-run was submitted and verified.", toolCalls: [] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [
          { name: "permission_query", description: "request approval", inputSchema: { type: "object", properties: { action: { type: "string" } } } },
          { name: "permission_result", description: "read approval", inputSchema: { type: "object", properties: { approval_id: { type: "string" } } } },
          { name: "permission_applied", description: "mark applied", inputSchema: { type: "object", properties: { approval_id: { type: "string" } } } },
          { name: "sessions_spawn", description: "spawn browser", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" } } } },
        ];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        if (input.call.name === "permission_query") return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "pending", approval_id: "ap-1" }) };
        if (input.call.name === "permission_result") return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "approved", approval_id: "ap-1" }) };
        if (input.call.name === "permission_applied") return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ status: "applied", approval_id: "ap-1" }) };
        return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-1", session_key: "worker:browser:task-1:toolu-browser", agent_id: "browser", status: "completed", tool_chain: ["browser"], result: "Approved dry-run submit completed.", final_content: "Approved dry-run submit completed. Browser verified the submitted status.", payload: { mode: "llm_sub_agent", workerType: "browser", content: "Approved dry-run submit completed. Browser verified the submitted status." } }) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the stubborn round-1 browser spawn was rewritten to permission_query on BOTH paths:
  // no browser session ran before the approval gate.
  assert.deepEqual(engine.executed.map((c) => c.name), inline.executed.map((c) => c.name));
  assert.equal(engine.executed[0]?.name, "permission_query");
  assert.ok(!engine.executed.slice(0, 1).some((c) => c.name === "sessions_spawn"));
  const engineCloseout7 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout7 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout7?.reason, inlineCloseout7?.reason);
  assert.equal(engineCloseout7?.roundCount, inlineCloseout7?.roundCount);
});

test("cutover parity: a completed-session synthesis that still lacks required browser evidence re-arms a forced sessions_spawn round, identically on both paths", async () => {
  // Stage 7 S10 (the completed-cascade forced sessions_spawn, inline :1880). A
  // browser-evidence task completes a non-browser session; the completed synthesis
  // admits it used a raw fetch (browser evidence missing). Both paths abort the
  // completed closeout and re-arm a forced sessions_spawn round — inline by `continue`,
  // the engine via onTerminate's new reArm directive — gather the browser session, then
  // re-synthesize and finalize. The recorded marker stops it re-firing (it converges).
  const taskPrompt = [
    "Review the operator dashboard and report the visible state.",
    "Use browser-visible evidence for the rendered dashboard, as an operator would see it.",
  ].join("\n");
  const base = { modelId: "claude-test", providerId: "anthropic", protocol: "anthropic-compatible" as const, adapterName: "test", raw: {} };
  const completedSession = (id: string, agentId: string, content: string) =>
    JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: `task-${id}`, session_key: `worker:${agentId}:task-${id}`, agent_id: agentId, status: "completed", tool_chain: [agentId], result: content, final_content: content, payload: { mode: "llm_sub_agent", workerType: agentId, content } });
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input: GenerateTextInput) => {
      const tools = input.tools?.length ?? 0;
      const text = (m: GenerateTextInput["messages"][number] | undefined) => (m ? readToolContent(m.content) : "");
      const hasBrowserCompleted = input.messages.some((m) => { const t = text(m); return t.includes("\"agent_id\":\"browser\"") && t.includes("\"status\":\"completed\""); });
      if (tools === 0) {
        // closeout synthesis: admit missing browser evidence until a browser session ran.
        return { ...base, toolCalls: [], text: hasBrowserCompleted
          ? "Rendered dashboard verified: backlog 7, owner risk desk, popup P-42 acknowledged."
          : "I used raw HTTP fetch because the browser tools are unavailable, so the rendered DOM, frame, shadow component, and popup were not verified." };
      }
      // tool round: after the browser-evidence repair prompt, spawn browser; else explore.
      if (text(input.messages.at(-1)).includes("Runtime correction: browser-visible evidence is missing")) {
        return { ...base, text: "Spawning the browser session.", toolCalls: [{ id: "toolu-browser", name: "sessions_spawn", input: { agent_id: "browser", task: "Inspect the rendered dashboard frame, shadow component, and popup." } }] };
      }
      return { ...base, text: "Spawning the explore session.", toolCalls: [{ id: "toolu-explore", name: "sessions_spawn", input: { agent_id: "explore", task: "Summarize the dashboard backlog from available data." } }] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [{ name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" } } } }];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        const agentId = String(input.call.input.agent_id);
        const content = agentId === "browser"
          ? "Rendered frame: backlog 7. Shadow review: risk desk approval required. Popup P-42 acknowledged."
          : "Backlog summary from available data; rendered page state not captured.";
        return { toolCallId: input.call.id, toolName: input.call.name, content: completedSession(String(input.call.id), agentId, content) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt, capabilityInspection: { availableWorkers: ["browser", "explore"], connectorStates: [], apiStates: [], skillStates: [], transportPreferences: [], unavailableCapabilities: [], generatedAt: 1 } } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.result.mentions, inline.result.mentions);
  // the completed synthesis re-armed a browser sessions_spawn on BOTH paths.
  assert.deepEqual(engine.executed.map((c) => c.input.agent_id), inline.executed.map((c) => c.input.agent_id));
  assert.deepEqual(engine.executed.map((c) => c.input.agent_id), ["explore", "browser"]);
  const engineCloseout8 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  const inlineCloseout8 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string; roundCount?: number } | undefined;
  assert.equal(engineCloseout8?.reason, inlineCloseout8?.reason);
  assert.equal(engineCloseout8?.roundCount, inlineCloseout8?.roundCount);
});

test("cutover parity: when an S10 re-armed browser round times out, the later sub_agent_timeout closeout replaces the completed metadata, identically on both paths", async () => {
  // Stage 7 S10 metadata stickiness boundary (codex #520 P2). The completed-session
  // synthesis re-arms a browser sessions_spawn (missing browser evidence), but that
  // forced round TIMES OUT. The final closeout must be sub_agent_timeout — NOT the
  // earlier completed_sub_agent_final whose metadata was set sticky. Only completed is
  // sticky (`??=`); a later terminal reason overwrites (`=`), matching inline.
  const taskPrompt = [
    "Review the operator dashboard and report the visible state.",
    "Use browser-visible evidence for the rendered dashboard, as an operator would see it.",
  ].join("\n");
  const base = { modelId: "claude-test", providerId: "anthropic", protocol: "anthropic-compatible" as const, adapterName: "test", raw: {} };
  const run = async (reactEngine: "inline" | "engine") => {
    const executed: RoleToolExecutionInput["call"][] = [];
    const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
    gateway.generate = async (input: GenerateTextInput) => {
      const tools = input.tools?.length ?? 0;
      const text = (m: GenerateTextInput["messages"][number] | undefined) => (m ? readToolContent(m.content) : "");
      if (tools === 0) {
        return { ...base, toolCalls: [], text: "I used raw HTTP fetch because the browser tools are unavailable, so the rendered DOM, frame, shadow component, and popup were not verified." };
      }
      if (text(input.messages.at(-1)).includes("Runtime correction: browser-visible evidence is missing")) {
        return { ...base, text: "Spawning the browser session.", toolCalls: [{ id: "toolu-browser", name: "sessions_spawn", input: { agent_id: "browser", task: "Inspect the rendered dashboard frame, shadow component, and popup." } }] };
      }
      return { ...base, text: "Spawning the explore session.", toolCalls: [{ id: "toolu-explore", name: "sessions_spawn", input: { agent_id: "explore", task: "Summarize the dashboard backlog from available data." } }] };
    };
    const executor: RoleToolExecutor = {
      definitions() {
        return [{ name: "sessions_spawn", description: "spawn", inputSchema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string" } } } }];
      },
      async execute(input: RoleToolExecutionInput) {
        executed.push(input.call);
        const agentId = String(input.call.input.agent_id);
        if (agentId === "browser") {
          // the re-armed browser round TIMES OUT.
          return { toolCallId: input.call.id, toolName: input.call.name, isError: true, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-browser", session_key: "worker:browser:task-browser", agent_id: "browser", status: "timeout", timeout_seconds: 45, evidence_available: false, evidence_summary: "Execution paused before completion. Reason: sessions_spawn timed out after 45s.", result: "Sub-agent session timed out after 45s.", final_content: null }) };
        }
        const content = "Backlog summary from available data; rendered page state not captured.";
        return { toolCallId: input.call.id, toolName: input.call.name, content: JSON.stringify({ protocol: "turnkeyai.session_tool_result.v1", task_id: "task-explore", session_key: "worker:explore:task-explore", agent_id: "explore", status: "completed", tool_chain: ["explore"], result: content, final_content: content, payload: { mode: "llm_sub_agent", workerType: "explore", content } }) };
      },
    };
    const result = await new LLMRoleResponseGenerator({
      gateway,
      toolLoop: { executor, maxRounds: 128 },
      reactEngine,
    }).generate({ activation: buildActivation(), packet: { ...buildPacket(), taskPrompt, capabilityInspection: { availableWorkers: ["browser", "explore"], connectorStates: [], apiStates: [], skillStates: [], transportPreferences: [], unavailableCapabilities: [], generatedAt: 1 } } });
    return { result, executed };
  };
  const inline = await run("inline");
  const engine = await run("engine");
  assert.equal(engine.result.content, inline.result.content);
  assert.deepEqual(engine.executed.map((c) => c.input.agent_id), inline.executed.map((c) => c.input.agent_id));
  assert.deepEqual(engine.executed.map((c) => c.input.agent_id), ["explore", "browser"]);
  const engineCloseout9 = engine.result.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined;
  const inlineCloseout9 = inline.result.metadata?.["toolLoopCloseout"] as { reason?: string } | undefined;
  // the later timeout overwrote the sticky completed metadata on BOTH paths.
  assert.equal(engineCloseout9?.reason, inlineCloseout9?.reason);
  assert.equal(engineCloseout9?.reason, "sub_agent_timeout");
});

import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput, TeamMessage, TeamMessageSummary } from "@turnkeyai/core-types/team";
import type { GenerateTextInput, GenerateTextResult, LLMToolCall } from "@turnkeyai/llm-adapter/index";
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "permission_query" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /approval-gated browser action/);
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /without native approval\/tool evidence/);
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /permission_query/);
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /action=browser\.form\.submit/);
      return toolCallResult("toolu-query", "permission_query", {
        action: "browser.form.submit",
        title: "Approve local dry-run form submit",
        risk: "Submit isolated local dry-run form data.",
        level: "approval",
        scope: "mutate",
        rationale: "The user asked to carry the dry-run form submission through an approval gate.",
        worker_kind: "browser",
        payload: { url: "http://127.0.0.1/approval-form", submit: "dry-run" },
      });
    }
    if (gatewayInputs.length === 3) {
      return {
        text: "Apply the approved permission.",
        toolCalls: [
          { id: "toolu-result", name: "permission_result", input: { approval_id: "ap-1" } },
          { id: "toolu-applied", name: "permission_applied", input: { approval_id: "ap-1" } },
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          final_content: "Approved dry-run submit completed. Browser verified the submitted status.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content: "Approved dry-run submit completed. Browser verified the submitted status.",
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

  assert.equal(result.content, "The approved browser dry-run was submitted and verified.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["permission_query", "permission_result", "permission_applied", "sessions_spawn"]
  );
  assert.equal(executedCalls[0]?.input.action, "browser.form.submit");
  assert.equal(executedCalls[3]?.input.agent_id, "browser");
  assert.match(String(executedCalls[3]?.input.task), /submit the approved dry-run/i);
  assert.equal(gatewayInputs.length, 5);
});

test("llm role response generator does not repair read-only tasks that explicitly disclaim approval-gated browser actions", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length > 1) {
      throw new Error("read-only source check should not trigger approval repair");
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
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
      assert.equal(input.toolChoice, "auto");
      assert.ok(input.tools?.some((tool) => tool.name === "permission_query"));
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /approval-gated browser action/);
      return toolCallResult("toolu-query", "permission_query", {
        action: "browser.form.submit",
        title: "Approve local dry-run form submit",
        risk: "Submit isolated local dry-run form data.",
        level: "approval",
        scope: "mutate",
        rationale: "The browser worker found the form; parent runtime must request approval before submission.",
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          result: "Browser inspected the form and reported that submission requires parent approval.",
          final_content: [
            "Verified local approval form.",
            "Form field: input[name=\"note\"] is empty.",
            "Submit button is visible.",
            "I do not have access to permission_query; the parent agent must request browser.form.submit approval.",
          ].join("\n"),
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content: "Verified form. Parent approval is required before browser.form.submit.",
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
    ["sessions_spawn", "permission_query"]
  );
  assert.equal(executedCalls[1]?.input.action, "browser.form.submit");
  assert.equal(gatewayInputs.length, 3);
  assert.equal(gatewayInputs[1]?.toolChoice, "auto");
  assert.notEqual(gatewayInputs[1]?.toolChoice, "none");
  assert.equal(result.metadata?.toolLoopCloseout, undefined);
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
          { id: "toolu-result", name: "permission_result", input: { approval_id: "ap-1" } },
          { id: "toolu-applied", name: "permission_applied", input: { approval_id: "ap-1" } },
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_spawn" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /approval already applied/);
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          final_content: "Approved dry-run submit completed. Browser verified the submitted status.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            content: "Approved dry-run submit completed. Browser verified the submitted status.",
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

  assert.equal(result.content, "The approved browser dry-run was submitted and verified.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["permission_query", "permission_result", "permission_applied", "sessions_spawn"]
  );
  assert.equal(gatewayInputs.length, 5);
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
          { id: "toolu-query", name: "permission_query", input: { action: "browser.form.submit" } },
          { id: "toolu-result", name: "permission_result", input: { approval_id: "ap-1" } },
          { id: "toolu-applied", name: "permission_applied", input: { approval_id: "ap-1" } },
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_spawn" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /approved browser action has not executed/);
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          final_content: "Approved dry-run submit completed. Browser verified the submitted status.",
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

  assert.equal(result.content, "The approved browser dry-run was submitted and verified.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["permission_query", "permission_result", "permission_applied", "sessions_spawn"]
  );
  assert.equal(gatewayInputs.length, 4);
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
          { id: "toolu-query", name: "permission_query", input: { action: "browser.form.submit" } },
          { id: "toolu-result", name: "permission_result", input: { approval_id: "ap-1" } },
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
    assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /approval was denied/);
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      if (input.call.name === "permission_query") {
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content: JSON.stringify({ event_type: "permission.query", status: "pending", approval_id: "ap-1" }),
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
        content: JSON.stringify({ event_type: "permission.result", status: "denied", approval_id: "ap-1" }),
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
    ["permission_query", "permission_result"]
  );
  assert.equal(gatewayInputs.length, 3);
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_spawn" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /multiple independent evidence streams/);
      return {
        text: "Calling remaining focused tools.",
        toolCalls: [
          {
            id: "toolu-two",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "Check orchestration source only.", label: "orchestration" },
          },
          {
            id: "toolu-three",
            name: "sessions_spawn",
            input: { agent_id: "browser", task: "Check live dashboard source only.", label: "signals" },
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
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
    ["toolu-one", "toolu-two", "toolu-three"]
  );
  assert.equal(gatewayInputs.length, 3);
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_spawn" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /multiple independent evidence streams/);
      return toolCallResult("toolu-two", "sessions_spawn", {
        agent_id: "explore",
        task: "Check source two.",
        label: "source-two",
      });
    }
    if (gatewayInputs.length === 3) {
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_spawn" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /multiple independent evidence streams/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
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
          payload: { mode: "llm_sub_agent", content: `${input.call.input.label} verified evidence.` },
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
    ["toolu-one", "toolu-two", "toolu-three"]
  );
  assert.equal(
    gatewayInputs.filter((input) => readToolContent(input.messages.at(-1)?.content ?? "").includes("multiple independent evidence streams"))
      .length,
    2
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_spawn" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /multiple independent evidence streams/);
      return {
        text: "Continuing one session and starting another.",
        toolCalls: [
          {
            id: "toolu-one-continue",
            name: "sessions_send",
            input: { session_key: "worker:explore:task-toolu-one", message: "Add one more detail for source one." },
          },
          {
            id: "toolu-two",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "Check source two.", label: "source-two" },
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_spawn" });
      assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /multiple independent evidence streams/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      const sessionKey =
        input.call.name === "sessions_send"
          ? String(input.call.input.session_key)
          : `worker:${input.call.input.agent_id}:task-${input.call.id}`;
      const label = input.call.name === "sessions_send" ? "source-one continued" : input.call.input.label;
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
          payload: { mode: "llm_sub_agent", content: `${label} verified evidence.` },
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
    ["toolu-one", "toolu-one-continue", "toolu-two", "toolu-three"]
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
  assert.equal(gatewayInputs[8]!.messages.at(-1)?.role, "user");
  assert.match(readToolContent(gatewayInputs[8]!.messages.at(-1)!.content), /final allowed tool-use round \(9\)/);
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
  assert.doesNotMatch(readToolContent(gatewayInputs[0]!.messages.at(-1)!.content), /final allowed tool-use round/);
  assert.match(readToolContent(gatewayInputs[1]!.messages.at(-1)!.content), /final allowed tool-use round \(2\)/);
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
  assert.ok(finalSynthesisPrompt(gatewayInputs[3])?.includes("Evidence synthesis contract"));
  assert.ok(finalSynthesisPrompt(gatewayInputs[3])?.includes("unverified scope or residual risk"));
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
  assert.equal(closeout?.reason, "wall_clock_budget");
  assert.equal(closeout?.maxWallClockMs, 100);
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.pendingToolCallCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
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

  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
        content: JSON.stringify({ status: "failed", result: "network failed before collecting evidence" }),
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

  assert.equal(result.content, "Verification did not complete after repeated source failures.");
  assert.equal(executedTools, 2);
  assert.equal(gatewayInputs.length, 4);
  assert.ok(
    gatewayInputs[3]?.messages.some(
      (message) =>
        message.role === "user" &&
        readToolContent(message.content).includes("Repeated failing tool call detected: sessions_spawn failed 2 times")
    )
  );
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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

  assert.equal(
    result.content,
    [
      "Verification did not complete within the tool budget.",
      "",
      "Continuation: this source check is resumable; continue or retry with a longer timeout before treating missing evidence as verified.",
    ].join("\n")
  );
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
  assert.ok(finalSynthesisPrompt(gatewayInputs[1])?.includes("continue or retry the same source check"));
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
  assert.equal(closeout?.reason, "sub_agent_timeout");
  assert.equal(closeout?.toolName, "sessions_spawn");
  assert.equal(closeout?.timeoutSeconds, 120);
  assert.equal(closeout?.evidenceAvailable, false);
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, "worker:explore:task-1:toolu-timeout");
      assert.match(String(input.call.input.message), /Resume the slow source check/);
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
          final_content: "Verified resumed source evidence. Unverified freshness remains.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: "Verified resumed source evidence. Unverified freshness remains.",
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
      "Continuation: this source check is resumable; continue or retry with a longer timeout before treating missing evidence as verified.",
    ].join("\n")
  );
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.match(readToolContent(gatewayInputs[0]!.messages[1]!.content), /Runtime session continuation directive/);
  assert.match(readToolContent(gatewayInputs[0]!.messages[1]!.content), /worker:explore:task-1:toolu-timeout/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.name, "sessions_send");
      assert.equal(input.call.input.session_key, "worker:explore:task-1:toolu-timeout");
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
      "Continuation: this source check is resumable; continue or retry with a longer timeout before treating missing evidence as verified.",
    ].join("\n")
  );
  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.match(String(executedCalls[0]?.input.message), /Continuation context from the original task/);
  assert.match(String(executedCalls[0]?.input.message), /release-risk note/);
  assert.match(String(executedCalls[0]?.input.message), /decision criteria/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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

  assert.equal(result.content, "Final answer from cancelled-session continuation.");
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.equal(executedCalls[0]?.input.session_key, "worker:explore:task-1:toolu-cancelled");
  assert.equal(executedCalls[0]?.input.timeout_seconds, undefined);
  assert.equal(executedCalls.length, 1);
  assert.equal(gatewayInputs.length, 2);
  assert.match(readToolContent(gatewayInputs[1]!.messages.at(-1)!.content), /completed delegated session evidence/i);
  assert.match(readToolContent(gatewayInputs[1]!.messages.at(-1)!.content), /cover every source/i);
  assert.match(readToolContent(gatewayInputs[1]!.messages.at(-1)!.content), /Cancelled session resumed with source evidence/);
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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

  assert.equal(result.content, "Final answer from completed-session continuation.");
  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.equal(executedCalls[0]?.input.session_key, "worker:browser:task-dashboard:toolu-browser");
  assert.match(String(executedCalls[0]?.input.message), /Continuation context from the original task/);
  assert.match(String(executedCalls[0]?.input.message), /operations dashboard review/);
  assert.match(String(executedCalls[0]?.input.message), /decision criteria/);
  assert.match(readToolContent(gatewayInputs[0]!.messages[1]!.content), /Runtime session continuation directive/);
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
          inputSchema: { type: "object", properties: { kinds: { type: "array" }, agent_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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
      assert.equal(input.call.input.session_key, "worker:browser:task-dashboard:toolu-browser");
      assert.match(String(input.call.input.message), /Re-check the operations dashboard/);
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

  assert.equal(result.content, "Final answer from looked-up browser continuation.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"]
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
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
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
    ["sessions_send"]
  );
});

test("llm role response generator allows a new spawn after an empty continuation session lookup", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length < 2 && input.toolChoice !== "none") {
      return toolCallResult(`toolu-${executedCalls.length + 1}`, "sessions_spawn", {
        agent_id: "browser",
        task: "Start a fresh dashboard check because no existing session is available.",
      });
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
          inputSchema: { type: "object", properties: { kinds: { type: "array" }, agent_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
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
    ["sessions_list", "sessions_spawn"]
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
          { id: "toolu-list", name: "sessions_list", input: { agent_id: "browser" } },
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
          inputSchema: { type: "object", properties: { agent_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
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
    ["sessions_list"]
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
          inputSchema: { type: "object", properties: { kinds: { type: "array" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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
      assert.equal(input.call.input.session_key, "worker:browser:task-dashboard:toolu-browser");
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

  assert.equal(result.content, "Final answer from listed-session continuation.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_list", "sessions_send"]
  );
});

test("llm role response generator forces continuation after list resolves a truncated timeout key", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const fullSessionKey = "worker:browser:task:TASK-1:call_function_bezmwfxl30as_1";
  const truncatedSessionKey = "worker:browser:task:TASK-1:call_function_bezmwfxl";
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
          inputSchema: { type: "object", properties: { session_key: { type: "string" } } },
        },
        {
          name: "sessions_list",
          description: "List sessions",
          inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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
      "Continuation: this source check is resumable; continue or retry with a longer timeout before treating missing evidence as verified.",
    ].join("\n")
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_history", "sessions_list", "sessions_send"]
  );
});

test("llm role response generator ignores nested completed status when session result failed", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length < 2 && input.toolChoice !== "none") {
      return toolCallResult(`toolu-new-${executedCalls.length + 1}`, "sessions_spawn", {
        agent_id: "browser",
        task: "Start a fresh dashboard check.",
      });
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
          inputSchema: { type: "object", properties: { kinds: { type: "array" }, agent_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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
    ["sessions_list", "sessions_spawn"]
  );
  assert.equal(executedCalls.some((call) => call.name === "sessions_send"), false);
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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
            result: "Queue depth: 11; SLA breaches: 3; owner: Incident Commander",
          }),
        }),
      ].join("\n"),
    },
  });

  assert.equal(executedCalls[0]?.name, "sessions_send");
  assert.equal(executedCalls[0]?.input.session_key, "worker:browser:task-dashboard:toolu-wrapped");
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
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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

  assert.equal(result.content, "Final answer after passive cancellation closeout.");
  assert.deepEqual(executedCalls, []);
});

test("llm role response generator normalizes noisy session_key inputs before execution", async () => {
  const executedCalls: RoleToolExecutionInput["call"][] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    if (executedCalls.length === 0 && input.toolChoice !== "none") {
      return toolCallResult("toolu-noisy-send", "sessions_send", {
        session_key: "worker:explore:task-1:toolu-cancelled | Natural cancellation follow-up\nOpen questions: {}",
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
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.input.session_key, "worker:explore:task-1:toolu-cancelled");
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
  assert.equal(executedCalls[0]?.input.session_key, "worker:explore:task-1:toolu-cancelled");
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
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.input.session_key, "worker:explore:task:TASK-1:call_function_abc123_1");
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
  assert.equal(executedCalls[0]?.input.session_key, "worker:explore:task:TASK-1:call_function_abc123_1");
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
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
        },
      ];
    },
    async execute(input: RoleToolExecutionInput) {
      executedCalls.push(input.call);
      assert.equal(input.call.input.session_key, "worker:explore:task:TASK-1:call_function_24fkgmynytqr_1");
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

  assert.equal(result.content, "Final answer from ellipsized-key continuation.");
  assert.equal(executedCalls[0]?.input.session_key, "worker:explore:task:TASK-1:call_function_24fkgmynytqr_1");
  const trace = result.metadata?.toolUse as
    | { rounds?: Array<{ calls?: Array<{ input?: Record<string, unknown> }> }> }
    | undefined;
  assert.equal(
    trace?.rounds?.[0]?.calls?.[0]?.input?.session_key,
    "worker:explore:task:TASK-1:call_function_24fkgmynytqr_1"
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
        readToolContent(message.content).includes("Source 1 evidence")
    )
  );
  const synthesisPrompt = finalSynthesisPrompt(gatewayInputs[1]) ?? "";
  assert.ok(synthesisPrompt.includes("Do not add extra sections, summaries, notes"));
  assert.ok(synthesisPrompt.includes("line must start with a literal prefix"));
  assert.ok(synthesisPrompt.includes("Do not write a preamble before a requested final shape"));
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_spawn");
  assert.equal(closeout?.finalContentCount, 1);
  assert.equal(closeout?.toolCallCount, 1);
  assert.equal(closeout?.roundCount, 1);
  assert.equal(closeout?.evidenceAvailable, true);
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
    assert.equal(input.toolChoice, "none");
    assert.equal(input.tools, undefined);
    const finalPrompt = readToolContent(input.messages.at(-1)?.content ?? "");
    assert.match(finalPrompt, /completed delegated session evidence/);
    assert.match(finalPrompt, /approved action/i);
    assert.match(finalPrompt, /residual risk or no-external-side-effect boundary/i);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
              textExcerpt: "TURNKEYAI_APPROVAL_FIXTURE_OK no external mutation was performed.",
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

  assert.equal(result.content, "Final synthesized answer from browser evidence.");
  assert.equal(executedTools, 1);
  assert.equal(gatewayInputs.length, 2);
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
  assert.equal(closeout?.reason, "completed_sub_agent_final");
  assert.equal(closeout?.toolName, "sessions_spawn");
  assert.equal(closeout?.finalContentCount, 1);
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
    assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /requested next action is missing/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          result: "Browser experienced CDP command timeouts. Verified queue depth 11. Unverified: ticket-level detail.",
          final_content: "Browser experienced CDP command timeouts. Verified queue depth 11. Unverified: ticket-level detail.",
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
  assert.equal(gatewayInputs.length, 3);
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
    assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /final answer weakens verified evidence/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          result: "Vendor Alpha: $19/seat. Strength: browser automation and traceable screenshots. Risk: API integration catalog is still limited.",
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
      taskPrompt: "Start a source-backed review of Vendor Alpha for a product lead. Focus on pricing, strength, and risk.",
    },
  });

  assert.match(result.content, /observed \$19\/seat price point/);
  assert.doesNotMatch(result.content, /\b(?:estimate|probably|maybe|TBD|to be confirmed|pending confirmation)\b/i);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          result: "Observed package count: 4. Integration points: auth and browser bridge.",
          final_content: "Observed package count: 4. Integration points: auth and browser bridge.",
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
      taskPrompt: "Estimate the migration effort from the available notes and give a practical range.",
    },
  });

  assert.match(result.content, /Estimated migration effort is 3-5 engineer-days/);
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
            input: { action: "browser.form.submit", scope: "local dry-run form" },
          },
          { id: "toolu-result", name: "permission_result", input: { approval_id: "ap-1" } },
          { id: "toolu-applied", name: "permission_applied", input: { approval_id: "ap-1" } },
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
    assert.match(readToolContent(input.messages.at(-1)?.content ?? ""), /TURNKEYAI_APPROVAL_FIXTURE_OK/);
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: "permission_result",
          description: "Read approval",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "permission_applied",
          description: "Mark approval applied",
          inputSchema: { type: "object", properties: { approval_id: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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

  assert.equal(result.content, "The approved dry-run was submitted once and verified.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["permission_query", "permission_result", "permission_applied", "sessions_spawn"]
  );
  assert.equal(executedCalls[3]?.id, "toolu-a");
  assert.equal(gatewayInputs.length, 2);
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
          { id: "toolu-query", name: "permission_query", input: { action: "browser.form.submit", scope: "local dry-run form" } },
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
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: "sessions_spawn",
          description: "Spawn a browser sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
      taskPrompt: "Run approved browser.form.submit checks for two distinct local dry-run forms.",
    },
  });

  assert.equal(result.content, "Both distinct approved browser checks were preserved.");
  assert.deepEqual(
    executedCalls.map((call) => call.id),
    ["toolu-query", "toolu-alpha", "toolu-beta"]
  );
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
    assert.doesNotMatch(finalPrompt, /Runtime correction: approval-gated browser action/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          result: "TURNKEYAI_APPROVAL_FIXTURE_OK verified after runtime approval gate.",
          final_content: null,
          payload: {
            sessionId: "brw-approval",
            page: {
              finalUrl: "http://127.0.0.1/approval-form",
              title: "Local approval fixture",
              textExcerpt: "TURNKEYAI_APPROVAL_FIXTURE_OK verified after runtime approval gate.",
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
    ["sessions_spawn"]
  );
  assert.equal(gatewayInputs.length, 2);
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
          inputSchema: { type: "object", properties: { session_key: { type: "string" } } },
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
    relayBrief: activation.handoff.payload.intent?.relayBrief ?? "Handle the task.",
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

  assert.equal(gatewayCalls, 2);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
              textExcerpt: "TURNKEYAI_APPROVAL_FIXTURE_OK no external mutation was performed.",
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

  assert.equal(gatewayCalls, 2);
  assert.match(result.content, /TURNKEYAI_APPROVAL_FIXTURE_OK/);
  assert.match(result.content, /Local approval fixture/);
  assert.doesNotMatch(result.content, /127\.0\.0\.1/);
  assert.match(result.content, /local fixture source/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
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
    throw new Error("llm_request_timeout: model did not respond within 120000ms");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "explore_run",
          description: "Fetch one source",
          inputSchema: { type: "object", properties: { instruction: { type: "string" } } },
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

  assert.equal(gatewayCalls, 2);
  assert.match(result.content, /Product Orchestration Evidence/);
  assert.match(result.content, /multi-agent decomposition/);
  assert.match(result.content, /durable sub-session history/);
  assert.match(result.content, /\bVerified:/);
  assert.match(result.content, /\bRisk:/);
  assert.equal(result.metadata?.adapterName, "local-evidence-closeout");
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
  assert.equal(closeout?.reason, "tool_evidence_fallback");
  assert.equal(closeout?.evidenceAvailable, true);
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
    /final synthesis provider unavailable/
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
    throw new Error("llm_request_timeout: model did not respond within 120000ms");
  };
  const executor: RoleToolExecutor = {
    definitions() {
      return [
        {
          name: "explore_run",
          description: "Fetch one source",
          inputSchema: { type: "object", properties: { instruction: { type: "string" } } },
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
    /llm_request_timeout/
  );
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
          inputSchema: { type: "object", properties: { instruction: { type: "string" } } },
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
    (error: unknown) => error instanceof Error && error.name === "AbortError"
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
            artifactIds: ["artifact-browser-snapshot", "artifact-browser-screenshot"],
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
    | { rounds?: Array<{ results?: Array<{ content?: string; contentTruncated?: boolean; contentBytes?: number }> }> }
    | undefined;
  const traceResult = trace?.rounds?.[0]?.results?.[0];
  assert.ok(traceResult?.content);
  assert.equal(traceResult.contentTruncated, true);
  assert.ok((traceResult.contentBytes ?? 0) > Buffer.byteLength(traceResult.content, "utf8"));
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
  assert.deepEqual(compacted.payload?.artifactIds, ["artifact-browser-snapshot", "artifact-browser-screenshot"]);
  assert.deepEqual(compacted.payload?.screenshotPaths, ["/tmp/browser-artifacts/final.png"]);
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
          session_key: "worker:explore:task-1:toolu-done-url",
          agent_id: "explore",
          status: "completed",
          result: "Verified local fixture evidence.",
          final_content: "Vendor Alpha came from http://127.0.0.1:50433/vendor-alpha.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "explore",
            content: "Vendor Alpha came from http://127.0.0.1:50433/vendor-alpha.",
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
      taskPrompt: "Return source names only. Do not include source URLs in the final answer.",
      outputContract: "Do not use tables, links, code fences, or bold markup.",
    },
  });

  assert.equal(
    result.content,
    "residual risk: pricing remains source-bounded to local fixture source and localhost."
  );
  assert.doesNotMatch(result.content, /https?:\/\//i);
  assert.ok(
    finalSynthesisPrompt(gatewayInputs[1])?.includes(
      "Preserve source URLs only when the original user did not forbid links or source URLs"
    )
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
        message: "Continue the dashboard review after the prior browser session was unavailable.",
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
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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
          final_content: "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            browserRecovery: {
              resumeMode: "warm",
              sessionId: "browser-session-recovered",
              summary: "Browser recovery metadata: Resume mode: warm. Session ID: browser-session-recovered.",
            },
            content: "Queue depth: 11. SLA breaches: 3. Recommended owner: Incident Commander.",
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
  assert.match(result.content, /Browser continuity: browser context was recovered/i);
  assert.match(result.content, /resume mode: warm/i);
  const synthesisPrompt = finalSynthesisPrompt(gatewayInputs[1]) ?? "";
  assert.match(synthesisPrompt, /browser continuity metadata/i);
  assert.match(synthesisPrompt, /Browser recovery metadata: Resume mode: warm/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          result: "cdp_command_timeout: browser snapshot CDP command timed out while capturing rendered page evidence. Queue depth: 11.",
          final_content: "Queue depth: 11.",
          payload: {
            mode: "llm_sub_agent",
            workerType: "browser",
            browserRecovery: {
              summary: "cdp_command_timeout: browser snapshot CDP command timed out while capturing rendered page evidence.",
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
        readToolContent(message.content).includes("completed delegated session evidence")
    )
  );
  assert.ok(
    !gatewayInputs[1]?.messages.some(
      (message) => message.role === "user" && readToolContent(message.content).includes("No usable evidence was gathered before the timeout")
    )
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
              task: "Fetch http://127.0.0.1:49152/vendor-alpha and extract pricing, strengths, and risks.",
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          result: "Browser rendered evidence: Vendor Alpha pricing is $19 per seat.",
          final_content: "Vendor Alpha pricing is $19 per seat.",
          payload: { mode: "llm_sub_agent", workerType: input.call.input.agent_id, content: "Vendor Alpha pricing is $19 per seat." },
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
  assert.match(String(executedCalls[0]?.input.task ?? ""), /127\.0\.0\.1:49152\/vendor-alpha/);
  assert.match(String(executedCalls[0]?.input.task ?? ""), /local\/private URL source/i);
  assert.match(result.content, /\$19 per seat/);
});

test("llm role response generator allows loopback explore only for isolated E2E fixture mode", async () => {
  const previous = process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE;
  process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE = "1";
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          payload: { mode: "llm_sub_agent", workerType: input.call.input.agent_id, content: "Explore fetched local fixture evidence." },
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

  assert.equal(executedCalls[0]?.input.agent_id, "explore");
  assert.doesNotMatch(String(executedCalls[0]?.input.task ?? ""), /local\/private URL source/i);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          payload: { mode: "llm_sub_agent", workerType: input.call.input.agent_id, content: "Browser inspected mixed private URL source safely." },
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
  assert.match(String(executedCalls[0]?.input.task ?? ""), /local\/private URL source/i);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          payload: { mode: "llm_sub_agent", workerType: input.call.input.agent_id, content: "Browser evidence complete." },
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
    ["browser", "browser", "browser", "browser"]
  );
  assert.match(String(executedCalls[0]?.input.task ?? ""), /169\.254\.169\.254/);
  assert.match(String(executedCalls[1]?.input.task ?? ""), /0\.0\.0\.0:49152/);
  assert.match(String(executedCalls[2]?.input.task ?? ""), /\[fe90::1\]/);
  assert.match(String(executedCalls[3]?.input.task ?? ""), /printer\.local\/status/);
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, agent_id: { type: "string" } } },
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
          payload: { mode: "llm_sub_agent", workerType: input.call.input.agent_id, content: "Explore evidence complete." },
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
            input: { agent_id: "explore", label: "orchestration", task: "Fetch orchestration evidence." },
          },
          {
            id: "toolu-bridge",
            name: "sessions_spawn",
            input: { agent_id: "explore", label: "bridge", task: "Fetch bridge evidence." },
          },
          {
            id: "toolu-signals",
            name: "sessions_spawn",
            input: { agent_id: "browser", label: "signals", task: "Inspect rendered signal dashboard." },
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
      assert.deepEqual(input.toolChoice, { type: "tool", name: "sessions_send" });
      assert.ok(
        input.messages.some(
          (message) =>
            message.role === "user" &&
            readToolContent(message.content).includes("required delegated evidence stream timed out")
        )
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
          inputSchema: { type: "object", properties: { task: { type: "string" }, label: { type: "string" } } },
        },
        {
          name: "sessions_send",
          description: "Continue a sub-agent",
          inputSchema: { type: "object", properties: { session_key: { type: "string" }, message: { type: "string" } } },
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
        assert.equal(input.call.input.session_key, "worker:browser:task-1:toolu-signals");
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
            final_content: "PRODUCT_SIGNAL_OK. Stuck missions: 6. Weak answer rate: 24%.",
            payload: { mode: "llm_sub_agent", workerType: "browser", content: "PRODUCT_SIGNAL_OK" },
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
          payload: { mode: "llm_sub_agent", workerType: "explore", content: `${input.call.input.label} evidence complete.` },
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

  assert.equal(result.content, "Final brief with orchestration, bridge, and Stuck missions: 6; Weak answer rate: 24%.");
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["sessions_spawn", "sessions_spawn", "sessions_spawn", "sessions_send"]
  );
  assert.equal(gatewayInputs.length, 3);
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
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
        readToolContent(message.content).includes("pseudo tool-call markup")
    )
  );
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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
  const closeout = result.metadata?.toolLoopCloseout as Record<string, unknown> | undefined;
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

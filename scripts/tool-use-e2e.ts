import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import type {
  RoleActivationInput,
  TeamMessage,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
  WorkerKind,
  WorkerRegistry,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { createBrowserBridge } from "@turnkeyai/browser-bridge/browser-bridge-factory";
import { AnthropicCompatibleClient } from "@turnkeyai/llm-adapter/anthropic-compatible-client";
import { FileModelCatalogSource } from "@turnkeyai/llm-adapter/file-model-catalog";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import { OpenAICompatibleClient } from "@turnkeyai/llm-adapter/openai-compatible-client";
import { ModelRegistry } from "@turnkeyai/llm-adapter/registry";
import type {
  GenerateTextInput,
  GenerateTextResult,
  ModelCatalog,
  ModelCatalogSource,
  ModelProtocol,
  ProtocolClient,
  ResolvedModelConfig,
} from "@turnkeyai/llm-adapter/index";
import { LLMRoleResponseGenerator } from "@turnkeyai/role-runtime/llm-response-generator";
import { createNativeToolCapabilityRegistry } from "@turnkeyai/role-runtime/tool-capability-registry";
import type { ToolPermissionService } from "@turnkeyai/role-runtime/tool-permission-service";
import { createWorkerSessionToolExecutor } from "@turnkeyai/role-runtime/tool-use";
import { LLMSubAgentWorkerHandler } from "@turnkeyai/role-runtime/sub-agent-worker-handler";
import { InMemoryWorkerRuntime } from "@turnkeyai/worker-runtime/in-memory-worker-runtime";

interface ToolUseE2eOptions {
  withBrowser: boolean;
  cdpTimeoutMs: number;
  realLlm: boolean;
  modelCatalogPath?: string;
  modelId?: string;
  modelChainId?: string;
}

function parseOptions(args: string[]): ToolUseE2eOptions {
  const options: ToolUseE2eOptions = {
    withBrowser: false,
    cdpTimeoutMs: 45_000,
    realLlm: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--with-browser") {
      options.withBrowser = true;
      continue;
    }
    if (arg === "--real-llm") {
      options.realLlm = true;
      continue;
    }
    if (arg === "--model-catalog") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-catalog");
      }
      options.modelCatalogPath = value;
      index += 1;
      continue;
    }
    if (arg === "--model-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-id");
      }
      options.modelId = value;
      index += 1;
      continue;
    }
    if (arg === "--model-chain-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-chain-id");
      }
      options.modelChainId = value;
      index += 1;
      continue;
    }
    if (arg === "--cdp-timeout-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --cdp-timeout-ms");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error("--cdp-timeout-ms must be a positive integer");
      }
      options.cdpTimeoutMs = parsed;
      index += 1;
      continue;
    }
  }
  return options;
}

async function main(options: ToolUseE2eOptions): Promise<void> {
  const mock = await runMockNativeToolUseE2e();
  console.log("tool-use mock e2e passed");
  console.log(`llm-rounds: ${mock.llmRounds}`);
  console.log(`tool-call-id: ${mock.toolCallId}`);
  console.log(`native-messages: ${mock.nativeMessageCount}`);
  console.log(`permission-events: ${mock.permissionEvents.join(",")}`);

  const subAgent = await runMockSubAgentToolUseE2e();
  console.log("tool-use sub-agent mock e2e passed");
  console.log(`sub-agent-kind: ${subAgent.kind}`);
  console.log(`sub-agent-llm-rounds: ${subAgent.llmRounds}`);
  console.log(`sub-agent-private-tool: ${subAgent.privateToolName}`);

  if (options.realLlm) {
    const real = await runRealLlmToolUseE2e(options);
    console.log("tool-use real llm e2e passed");
    console.log(`real-mode: ${real.mode}`);
    console.log(`real-model-catalog: ${real.modelCatalogPath}`);
    console.log(`real-tool-call: ${real.toolCallName}`);
    console.log(`real-final: ${real.finalMarker}`);
    if (real.childTranscriptMessages !== undefined) {
      console.log(`real-child-transcript-messages: ${real.childTranscriptMessages}`);
    }
  }

  if (options.withBrowser) {
    await runCommand("npm", ["run", "cdp:smoke", "--", "--timeout-ms", String(options.cdpTimeoutMs)]);
    console.log("tool-use browser e2e passed");
  }
}

async function runRealLlmToolUseE2e(options: ToolUseE2eOptions): Promise<{
  mode: "llm-only" | "llm-browser";
  modelCatalogPath: string;
  toolCallName: string;
  finalMarker: string;
  childTranscriptMessages?: number;
}> {
  const modelCatalogPath = resolveModelCatalogPath(options.modelCatalogPath);
  const modelSelection = resolveRealModelSelection(modelCatalogPath, options);
  const gateway = new LLMGateway({
    registry: new ModelRegistry(new FileModelCatalogSource(modelCatalogPath)),
    clients: [new OpenAICompatibleClient(), new AnthropicCompatibleClient()],
  });
  const toolCapabilityRegistry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: options.withBrowser ? ["browser"] : ["explore"],
    permissionsEnabled: false,
    memoryEnabled: false,
    tasksEnabled: false,
  });
  const nativeMessages: TeamMessage[] = [];
  const fixture = options.withBrowser ? await startBrowserFixture() : null;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-tooluse-real-e2e-"));
  let closeWorkerRuntime: (() => Promise<void>) | null = null;
  try {
    const workerRuntimeBundle = options.withBrowser
      ? buildRealBrowserWorkerRuntime({ gateway, fixtureUrl: fixture!.url, tempDir })
      : { workerRuntime: buildRealExploreWorkerRuntime(), close: async () => {} };
    const workerRuntime = workerRuntimeBundle.workerRuntime;
    closeWorkerRuntime = workerRuntimeBundle.close;
    const generator = new LLMRoleResponseGenerator({
      gateway,
      nativeToolMessageStore: {
        async append(message) {
          nativeMessages.push(message);
        },
      },
      toolLoop: {
        executor: createWorkerSessionToolExecutor({
          workerRuntime,
          toolCapabilityRegistry,
          maxSessionToolTimeoutMs: options.withBrowser ? 180_000 : 60_000,
        }),
        maxRounds: options.withBrowser ? 6 : 4,
        maxParallelToolCalls: 1,
        maxWallClockMs: options.withBrowser ? 240_000 : 90_000,
      },
      clock: { now: () => Date.now() },
    });
    const activation = buildActivation({
      ...(modelSelection.modelId ? { modelId: modelSelection.modelId } : {}),
      ...(modelSelection.modelChainId ? { modelChainId: modelSelection.modelChainId } : {}),
    });
    const mode = options.withBrowser ? "llm-browser" : "llm-only";
    const targetMarker = options.withBrowser ? "TURNKEYAI_BROWSER_E2E_OK" : "TURNKEYAI_LLM_E2E_OK";
    const reply = await generator.generate({
      activation,
      packet: {
        roleId: "role-lead",
        roleName: "Lead",
        seat: "lead",
        systemPrompt: [
          toolCapabilityRegistry.renderPromptHarness({ seat: "lead" }),
          "You are running a release-gate E2E. Use the available session tool instead of answering from memory.",
          options.withBrowser
            ? "You must call sessions_spawn with agent_id=browser exactly once, then base your final answer on browser-observed evidence."
            : "You must call sessions_spawn with agent_id=explore exactly once, then base your final answer on the tool result.",
        ].join("\n\n"),
        taskPrompt: options.withBrowser
          ? `Open ${fixture!.url}, read the fixture marker and page title with the browser sub-agent, then answer with ${targetMarker}.`
          : `Ask the explore sub-agent for the release marker, then answer with ${targetMarker}.`,
        outputContract: `Final answer must include ${targetMarker} and must mention the session tool evidence.`,
        suggestedMentions: [],
      },
    });
    const assistantToolMessage = nativeMessages.find((message) => message.role === "assistant" && message.toolCalls?.length);
    const firstToolCallName = assistantToolMessage?.toolCalls?.[0]?.name ?? "(none)";
    assert.equal(firstToolCallName, "sessions_spawn");
    assert.match(reply.content, new RegExp(targetMarker));
    const childTranscriptMessages = options.withBrowser
      ? (await firstWorkerHistoryLength(workerRuntime))
      : undefined;
    if (options.withBrowser) {
      assert.ok((childTranscriptMessages ?? 0) >= 4, "browser sub-agent should persist child transcript entries");
    }
    return {
      mode,
      modelCatalogPath,
      toolCallName: firstToolCallName,
      finalMarker: targetMarker,
      ...(childTranscriptMessages !== undefined ? { childTranscriptMessages } : {}),
    };
  } finally {
    await closeWorkerRuntime?.();
    await fixture?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildRealExploreWorkerRuntime(): WorkerRuntime {
  const handler: WorkerHandler = {
    kind: "explore",
    canHandle(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      return {
        workerType: "explore",
        status: "completed",
        summary: "Explore sub-agent returned the release marker TURNKEYAI_LLM_E2E_OK.",
        payload: {
          marker: "TURNKEYAI_LLM_E2E_OK",
          source: "deterministic e2e worker",
        },
      };
    },
  };
  const registry: WorkerRegistry = {
    async selectHandler(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") ? handler : null;
    },
    async getHandler(kind) {
      return kind === "explore" ? handler : null;
    },
  };
  return new InMemoryWorkerRuntime({ workerRegistry: registry });
}

function buildRealBrowserWorkerRuntime(input: {
  gateway: LLMGateway;
  fixtureUrl: string;
  tempDir: string;
}): { workerRuntime: WorkerRuntime; close: () => Promise<void> } {
  const browserBridge = createBrowserBridge({
    transportMode: "local",
    artifactRootDir: path.join(input.tempDir, "browser-artifacts"),
    stateRootDir: path.join(input.tempDir, "browser-state"),
    headless: true,
  });
  const innerHandler: WorkerHandler = {
    kind: "browser",
    canHandle(workerInput) {
      return workerInput.packet.preferredWorkerKinds?.includes("browser") === true;
    },
    async run(): Promise<WorkerExecutionResult> {
      return {
        workerType: "browser",
        status: "failed",
        summary: "Browser private tool surface was not used.",
        payload: { fixtureUrl: input.fixtureUrl },
      };
    },
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler,
    gateway: input.gateway,
    browserBridge,
    maxRounds: 6,
    maxWallClockMs: 180_000,
  });
  const registry: WorkerRegistry = {
    async selectHandler(workerInput) {
      return workerInput.packet.preferredWorkerKinds?.includes("browser") ? handler : null;
    },
    async getHandler(kind) {
      return kind === "browser" ? handler : null;
    },
  };
  return {
    workerRuntime: new InMemoryWorkerRuntime({ workerRegistry: registry }),
    close: async () => {
      const sessions = await browserBridge.listSessions().catch(() => []);
      await Promise.all(
        sessions.map((session) => browserBridge.closeSession(session.browserSessionId, "real llm e2e complete").catch(() => {}))
      );
    },
  };
}

async function firstWorkerHistoryLength(workerRuntime: WorkerRuntime): Promise<number> {
  const sessions = workerRuntime.listSessions ? await workerRuntime.listSessions() : [];
  return sessions[0]?.state.history?.length ?? 0;
}

async function startBrowserFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/favicon.ico") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
      <html>
        <head><title>TurnkeyAI Tool Use Browser E2E</title></head>
        <body>
          <main>
            <h1>TURNKEYAI_BROWSER_E2E_OK</h1>
            <p id="evidence">Browser fixture says: private browser tools observed this page.</p>
          </main>
        </body>
      </html>`);
  });
  await listen(server, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind real browser e2e fixture server");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

async function runMockSubAgentToolUseE2e(): Promise<{
  kind: WorkerKind;
  llmRounds: number;
  privateToolName: string;
}> {
  process.env.TOOL_USE_E2E_KEY = process.env.TOOL_USE_E2E_KEY || "mock-tool-use-e2e-key";
  const llmInputs: GenerateTextInput[] = [];
  const innerTaskPrompts: string[] = [];
  const gateway = new LLMGateway({
    registry: new ModelRegistry(new SingleModelCatalogSource()),
    clients: [
      new ScriptedSubAgentClient({
        privateToolName: "explore_run",
        inputs: llmInputs,
      }),
    ],
  });
  const innerHandler: WorkerHandler = {
    kind: "explore",
    canHandle(input) {
      return input.packet.preferredWorkerKinds?.includes("explore") === true;
    },
    async run(input: WorkerInvocationInput): Promise<WorkerExecutionResult> {
      innerTaskPrompts.push(input.packet.taskPrompt);
      return {
        workerType: "explore",
        status: "completed",
        summary: "Fetched and extracted the requested source.",
        payload: {
          source: "https://example.test/source",
          facts: ["source fact"],
        },
      };
    },
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "explore",
    innerHandler,
    gateway,
  });

  const result = await handler.run({
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      systemPrompt: "Parent prompt",
      taskPrompt: "Investigate the source and summarize the verified fact.",
      outputContract: "Return a concise final answer.",
      suggestedMentions: [],
      preferredWorkerKinds: ["explore"],
    },
  });

  assert.equal(result?.status, "completed");
  assert.equal(result?.summary, "The sub-agent verified the requested source fact.");
  assert.deepEqual(innerTaskPrompts, ["Fetch the source and extract the fact."]);
  const toolNames = llmInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(toolNames, ["explore_run"]);
  assert.equal(toolNames.includes("sessions_spawn"), false);
  assert.equal(
    ((result?.payload as { metadata?: { toolUse?: { toolCallCount?: number } } }).metadata?.toolUse?.toolCallCount),
    1
  );

  return {
    kind: "explore",
    llmRounds: llmInputs.length,
    privateToolName: "explore_run",
  };
}

async function runMockNativeToolUseE2e(): Promise<{
  llmRounds: number;
  toolCallId: string;
  nativeMessageCount: number;
  permissionEvents: string[];
}> {
  process.env.TOOL_USE_E2E_KEY = process.env.TOOL_USE_E2E_KEY || "mock-tool-use-e2e-key";
  const activation = buildActivation();
  const toolCallId = "call-browser-submit";
  const llmInputs: GenerateTextInput[] = [];
  const nativeMessages: TeamMessage[] = [];
  const permissionEvents: string[] = [];
  let workerSendToolCallId: string | undefined;

  const registry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: ["browser", "explore"],
    permissionsEnabled: true,
    memoryEnabled: true,
    tasksEnabled: true,
  });
  const gateway = new LLMGateway({
    registry: new ModelRegistry(new SingleModelCatalogSource()),
    clients: [
      new ScriptedToolCallClient({
        toolCallId,
        inputs: llmInputs,
      }),
    ],
  });
  const workerRuntime: WorkerRuntime = {
    async spawn() {
      return { workerType: "browser", workerRunKey: "worker:browser:task-tool-e2e" };
    },
    async send(input) {
      workerSendToolCallId = input.toolCallId;
      return {
        workerType: "browser",
        status: "completed",
        summary: "Browser submit completed under approved permission.",
        payload: {
          sessionId: "browser-session-tool-e2e",
          finalUrl: "https://example.test/done",
        },
      };
    },
    async resume() {
      throw new Error("not used");
    },
    async interrupt() {
      throw new Error("not used");
    },
    async cancel() {
      throw new Error("not used");
    },
    async getState() {
      return null;
    },
    async maybeRunForRole() {
      throw new Error("not used");
    },
  };
  const toolPermissionService: ToolPermissionService = {
    async request(input) {
      permissionEvents.push(`query:${input.toolCallId}`);
      return {
        status: "pending",
        approvalId: "ap.thread-tool-e2e.call-browser-submit",
        action: input.action,
        requirement: {
          level: input.requirement.level,
          scope: input.requirement.scope,
          cacheKey: input.requirement.cacheKey ?? "missing",
          rationale: input.requirement.rationale,
          workerType: input.requirement.workerType ?? "browser",
        },
        message: "Approval pending.",
      };
    },
    async result() {
      throw new Error("not used");
    },
    async waitForDecision(input) {
      permissionEvents.push(`result:${input.approvalId}`);
      return {
        status: "approved",
        approvalId: input.approvalId,
        action: "browser.form.submit",
        message: "Approved.",
      };
    },
    async apply(input) {
      permissionEvents.push(`applied:${input.approvalId}`);
      return {
        status: "applied",
        approvalId: input.approvalId,
        cacheKey: "thread-tool-e2e:browser:mutate:approval:browser.form.submit",
        message: "Applied.",
      };
    },
  };

  const generator = new LLMRoleResponseGenerator({
    gateway,
    nativeToolMessageStore: {
      async append(message) {
        nativeMessages.push(message);
      },
    },
    toolLoop: {
      executor: createWorkerSessionToolExecutor({
        workerRuntime,
        toolCapabilityRegistry: registry,
        toolPermissionService,
      }),
    },
    clock: { now: () => 10_000 + nativeMessages.length },
  });

  const reply = await generator.generate({
    activation,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: registry.renderPromptHarness({ seat: "lead" }),
      taskPrompt: "Use the browser worker to submit the approved form and report the result.",
      outputContract: "Return a concise final answer.",
      suggestedMentions: [],
    },
  });

  const latestById = new Map(nativeMessages.map((message) => [message.id, message]));
  const persistedMessages = [...latestById.values()];
  const assistantToolMessage = persistedMessages.find((message) => message.role === "assistant" && message.toolCalls?.length);
  const toolResultMessage = persistedMessages.find((message) => message.role === "tool" && message.toolCallId === toolCallId);

  assert.equal(reply.content, "The approved browser form submission completed.");
  assert.equal(llmInputs.length, 2, "mock LLM should be called once for tool_use and once after tool_result");
  assert.ok(llmInputs[0]?.tools?.some((tool) => tool.name === "sessions_spawn"));
  assert.ok(llmInputs[0]?.tools?.some((tool) => tool.name === "permission_query"));
  assert.ok(llmInputs[0]?.tools?.some((tool) => tool.name === "tasks_create"));
  assert.equal(llmInputs[1]?.messages.some((message) => message.role === "tool" && message.toolCallId === toolCallId), true);
  assert.equal(workerSendToolCallId, toolCallId);
  assert.ok(assistantToolMessage);
  assert.equal(assistantToolMessage.toolCalls?.[0]?.id, toolCallId);
  assert.equal(
    assistantToolMessage.toolProgress?.some((event) => event.detail?.eventType === "permission.applied"),
    true
  );
  assert.ok(toolResultMessage);
  assert.match(toolResultMessage.content, /Browser submit completed/);

  return {
    llmRounds: llmInputs.length,
    toolCallId,
    nativeMessageCount: persistedMessages.length,
    permissionEvents,
  };
}

class SingleModelCatalogSource implements ModelCatalogSource {
  async load(): Promise<ModelCatalog> {
    return {
      models: {
        "tool-e2e-model": {
          label: "Tool E2E",
          providerId: "mock",
          protocol: "openai-compatible",
          model: "tool-e2e-model",
          baseURL: "https://mock.invalid/v1",
          apiKeyEnv: "TOOL_USE_E2E_KEY",
        },
      },
    };
  }
}

class ScriptedToolCallClient implements ProtocolClient {
  constructor(private readonly input: { toolCallId: string; inputs: GenerateTextInput[] }) {}

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.input.inputs.push(input);
    const sawToolResult = input.messages.some(
      (message) => message.role === "tool" && message.toolCallId === this.input.toolCallId
    );
    if (!sawToolResult) {
      return {
        text: "",
        toolCalls: [
          {
            id: this.input.toolCallId,
            name: "sessions_spawn",
            input: {
              agent_id: "browser",
              task: "Open https://example.test/account and submit the final form.",
            },
          },
        ],
        modelId: input.modelId ?? model.id,
        providerId: model.providerId,
        protocol: model.protocol,
        adapterName: "tool-use-e2e-mock",
        raw: { round: 1 },
      };
    }
    return {
      text: "The approved browser form submission completed.",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "tool-use-e2e-mock",
      raw: { round: 2 },
    };
  }
}

class ScriptedSubAgentClient implements ProtocolClient {
  constructor(private readonly input: { privateToolName: string; inputs: GenerateTextInput[] }) {}

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.input.inputs.push(input);
    const sawToolResult = input.messages.some(
      (message) => message.role === "tool" && message.toolCallId === "call-sub-agent-private-tool"
    );
    if (!sawToolResult) {
      return {
        text: "",
        toolCalls: [
          {
            id: "call-sub-agent-private-tool",
            name: this.input.privateToolName,
            input: {
              instruction: "Fetch the source and extract the fact.",
            },
          },
        ],
        modelId: input.modelId ?? model.id,
        providerId: model.providerId,
        protocol: model.protocol,
        adapterName: "tool-use-sub-agent-e2e-mock",
        raw: { round: 1 },
      };
    }
    return {
      text: "The sub-agent verified the requested source fact.",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "tool-use-sub-agent-e2e-mock",
      raw: { round: 2 },
    };
  }
}

function buildActivation(input: { modelId?: string; modelChainId?: string; useCatalogDefault?: boolean } = {}): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-tool-e2e",
      teamId: "team-tool-e2e",
      teamName: "Tool E2E Team",
      leadRoleId: "role-lead",
      roles: [
        {
          roleId: "role-lead",
          name: "Lead",
          seat: "lead",
          runtime: "local",
          ...(input.modelId ? { modelRef: input.modelId } : input.useCatalogDefault ? {} : { modelRef: "tool-e2e-model" }),
          ...(input.modelChainId ? { modelChain: input.modelChainId } : {}),
        },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-tool-e2e",
      threadId: "thread-tool-e2e",
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
      runKey: "role:role-lead:thread:thread-tool-e2e",
      threadId: "thread-tool-e2e",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 1,
      maxIterations: 4,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-tool-e2e",
      flowId: "flow-tool-e2e",
      sourceMessageId: "msg-root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-tool-e2e",
      payload: {
        threadId: "thread-tool-e2e",
        intent: {
          relayBrief: "Run tool-use e2e.",
          recentMessages: [],
        },
      },
      createdAt: 1,
    },
  };
}

function resolveModelCatalogPath(explicitPath?: string): string {
  const candidates = [
    explicitPath,
    process.env.TURNKEYAI_MODEL_CATALOG,
    path.resolve(process.cwd(), "models.local.json"),
    path.resolve(process.cwd(), "models.json"),
  ].filter((item): item is string => Boolean(item?.trim()));

  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {}
  }
  throw new Error(
    "real LLM E2E requires --model-catalog, TURNKEYAI_MODEL_CATALOG, models.local.json, or models.json"
  );
}

function resolveRealModelSelection(
  modelCatalogPath: string,
  options: ToolUseE2eOptions
): { modelId?: string; modelChainId?: string } {
  if (options.modelId || options.modelChainId) {
    return {
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.modelChainId ? { modelChainId: options.modelChainId } : {}),
    };
  }
  const catalog = JSON.parse(readFileSync(modelCatalogPath, "utf8")) as {
    defaultModelId?: unknown;
    defaultModelChainId?: unknown;
  };
  if (typeof catalog.defaultModelChainId === "string" && catalog.defaultModelChainId.trim()) {
    return { modelChainId: catalog.defaultModelChainId.trim() };
  }
  if (typeof catalog.defaultModelId === "string" && catalog.defaultModelId.trim()) {
    return { modelId: catalog.defaultModelId.trim() };
  }
  throw new Error("real LLM E2E requires --model-id, --model-chain-id, defaultModelChainId, or defaultModelId");
}

async function listen(server: Server, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, host, resolve);
    server.on("error", reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...resolveDaemonTokenEnv(),
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "null"}`));
      }
    });
  });
}

function resolveDaemonTokenEnv(): Record<string, string> {
  if (process.env.TURNKEYAI_DAEMON_TOKEN?.trim()) {
    return {};
  }
  try {
    const config = JSON.parse(readFileSync(path.join(os.homedir(), ".turnkeyai", "config.json"), "utf8")) as {
      token?: unknown;
    };
    return typeof config.token === "string" && config.token.trim()
      ? { TURNKEYAI_DAEMON_TOKEN: config.token.trim() }
      : {};
  } catch {
    return {};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(parseOptions(process.argv.slice(2)));
}

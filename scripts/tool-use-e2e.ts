import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import type {
  RoleActivationInput,
  TeamMessage,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
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

interface ToolUseE2eOptions {
  withBrowser: boolean;
  cdpTimeoutMs: number;
}

function parseOptions(args: string[]): ToolUseE2eOptions {
  const options: ToolUseE2eOptions = {
    withBrowser: false,
    cdpTimeoutMs: 45_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--with-browser") {
      options.withBrowser = true;
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

  if (options.withBrowser) {
    await runCommand("npm", ["run", "cdp:smoke", "--", "--timeout-ms", String(options.cdpTimeoutMs)]);
    console.log("tool-use browser e2e passed");
  }
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

function buildActivation(): RoleActivationInput {
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
          modelRef: "tool-e2e-model",
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

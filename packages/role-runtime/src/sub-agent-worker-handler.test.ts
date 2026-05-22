import assert from "node:assert/strict";
import test from "node:test";

import type {
  BrowserBridge,
  BrowserSession,
  BrowserSessionHistoryEntry,
  BrowserTarget,
  BrowserTaskResult,
  RoleActivationInput,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
} from "@turnkeyai/core-types/team";
import type { GenerateTextInput, GenerateTextResult } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { LLMSubAgentWorkerHandler } from "./sub-agent-worker-handler";

test("LLMSubAgentWorkerHandler runs a private worker tool before returning a final result", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const innerTaskPrompts: string[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("tool-1", "explore_run", { instruction: "Fetch the primary source and extract the answer." });
    }
    return textResult("Verified answer from the source.");
  };
  const innerHandler = buildInnerHandler({
    kind: "explore",
    async run(input) {
      innerTaskPrompts.push(input.packet.taskPrompt);
      return {
        workerType: "explore",
        status: "completed",
        summary: "Fetched primary source.",
        payload: { title: "Primary source", facts: ["fact-a"] },
      };
    },
  });
  const handler = new LLMSubAgentWorkerHandler({
    kind: "explore",
    innerHandler,
    gateway,
  });

  const result = await handler.run(buildInvocationInput("explore"));

  assert.equal(result?.status, "completed");
  assert.equal(result?.summary, "Verified answer from the source.");
  assert.deepEqual(innerTaskPrompts, ["Fetch the primary source and extract the answer."]);
  const toolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(toolNames, ["explore_run"]);
  assert.ok(!toolNames.includes("sessions_spawn"));
  assert.equal(
    ((result?.payload as { metadata?: { toolUse?: { toolCallCount?: number } } }).metadata?.toolUse?.toolCallCount),
    1
  );
});

test("LLMSubAgentWorkerHandler keeps browser work on a browser-specific private tool", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    if (gatewayInputs.length === 1) {
      return toolCallResult("tool-1", "browser_run", { instruction: "Open the page and capture visible state." });
    }
    return textResult("Browser state captured.");
  };
  const innerHandler = buildInnerHandler({
    kind: "browser",
    async run() {
      return {
        workerType: "browser",
        status: "completed",
        summary: "Captured browser state.",
        payload: { url: "https://example.test", title: "Example" },
      };
    },
  });
  const handler = new LLMSubAgentWorkerHandler({ kind: "browser", innerHandler, gateway });

  const result = await handler.run(buildInvocationInput("browser"));

  assert.equal(result?.status, "completed");
  assert.equal(gatewayInputs[0]?.tools?.[0]?.name, "browser_run");
  assert.match(String(gatewayInputs[0]?.messages[0]?.content ?? ""), /same browser operation at most three times/i);
});

test("LLMSubAgentWorkerHandler exposes structured browser private tools when a browser bridge is wired", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const bridgeCalls: Array<{ mode: "spawn" | "send"; input: { actions?: Array<{ kind: string }>; browserSessionId?: string } }> = [];
  let innerCalled = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const toolResultCount = input.messages.filter((message) => message.role === "tool").length;
    if (toolResultCount === 0) {
      return toolCallResult("tool-1", "browser_open", {
        url: "https://example.test",
        screenshot: true,
      });
    }
    if (toolResultCount === 1) {
      return toolCallResult("tool-2", "browser_snapshot", { note: "confirm-page" });
    }
    return textResult("Browser evidence captured.");
  };
  const browserBridge = buildBrowserBridge({
    async spawnSession(input) {
      bridgeCalls.push({ mode: "spawn", input });
      return browserResult({
        title: "Example",
        finalUrl: "https://example.test/",
        traceKinds: input.actions.map((action) => action.kind),
      });
    },
    async sendSession(input) {
      bridgeCalls.push({ mode: "send", input });
      return browserResult({
        title: "Example",
        finalUrl: "https://example.test/",
        traceKinds: input.actions.map((action) => action.kind),
      });
    },
  });
  const handler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler: buildInnerHandler({
      kind: "browser",
      async run() {
        innerCalled = true;
        return null;
      },
    }),
    gateway,
    browserBridge,
  });

  const result = await handler.run(buildInvocationInput("browser"));

  assert.equal(result?.status, "completed");
  assert.equal(innerCalled, false);
  const toolNames = gatewayInputs[0]?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(toolNames, [
    "browser_open",
    "browser_snapshot",
    "browser_act",
    "browser_scroll",
    "browser_console",
    "browser_screenshot",
  ]);
  assert.match(String(gatewayInputs[0]?.messages[0]?.content ?? ""), /browser_open/);
  assert.equal(bridgeCalls.length, 2);
  assert.equal(bridgeCalls[0]?.mode, "spawn");
  assert.deepEqual(bridgeCalls[0]?.input.actions?.map((action) => action.kind), ["open", "snapshot", "screenshot"]);
  assert.equal(bridgeCalls[1]?.mode, "send");
  assert.equal(bridgeCalls[1]?.input.browserSessionId, "browser-session-1");
  assert.deepEqual(bridgeCalls[1]?.input.actions?.map((action) => action.kind), ["snapshot"]);
});

test("LLMSubAgentWorkerHandler refuses private browser submit actions before bridge execution", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let bridgeCalled = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const sawToolResult = input.messages.some((message) => message.role === "tool" && message.toolCallId === "tool-1");
    if (!sawToolResult) {
      return toolCallResult("tool-1", "browser_act", {
        action: "click",
        text: "Submit order",
      });
    }
    return textResult("Reported that approval is required.");
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler: buildInnerHandler({ kind: "browser" }),
    gateway,
    browserBridge: buildBrowserBridge({
      async spawnSession() {
        bridgeCalled = true;
        return browserResult({});
      },
    }),
  });

  const result = await handler.run(buildInvocationInput("browser"));

  assert.equal(result?.status, "completed");
  assert.equal(bridgeCalled, false);
  assert.match(readToolContent(gatewayInputs[1]?.messages.find((message) => message.role === "tool")?.content ?? ""), /refused likely side-effectful click/i);
});

test("LLMSubAgentWorkerHandler reuses parent browser session on the first private browser tool call", async () => {
  const bridgeCalls: Array<{ mode: "spawn" | "send"; browserSessionId?: string }> = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    const sawToolResult = input.messages.some((message) => message.role === "tool" && message.toolCallId === "tool-1");
    if (!sawToolResult) {
      return toolCallResult("tool-1", "browser_snapshot", { note: "resume-parent" });
    }
    return textResult("Resumed existing browser session.");
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler: buildInnerHandler({ kind: "browser" }),
    gateway,
    browserBridge: buildBrowserBridge({
      async spawnSession() {
        bridgeCalls.push({ mode: "spawn" });
        return browserResult({});
      },
      async sendSession(input) {
        bridgeCalls.push({ mode: "send", browserSessionId: input.browserSessionId });
        return browserResult({});
      },
    }),
  });

  const result = await handler.run({
    ...buildInvocationInput("browser"),
    sessionState: {
      workerRunKey: "worker:browser:existing",
      workerType: "browser",
      status: "resumable",
      createdAt: 1,
      updatedAt: 2,
      lastResult: {
        workerType: "browser",
        status: "completed",
        summary: "Existing browser session.",
        payload: { sessionId: "browser-session-existing", targetId: "target-existing" },
      },
    },
  });

  assert.equal(result?.status, "completed");
  assert.deepEqual(bridgeCalls, [{ mode: "send", browserSessionId: "browser-session-existing" }]);
});

test("LLMSubAgentWorkerHandler returns a tool error for malformed private browser input", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let bridgeCalled = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const sawToolResult = input.messages.some((message) => message.role === "tool" && message.toolCallId === "tool-1");
    if (!sawToolResult) {
      return toolCallResult("tool-1", "browser_open", null as unknown as Record<string, unknown>);
    }
    return textResult("Recovered after malformed browser tool input.");
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler: buildInnerHandler({ kind: "browser" }),
    gateway,
    browserBridge: buildBrowserBridge({
      async spawnSession() {
        bridgeCalled = true;
        return browserResult({});
      },
    }),
  });

  const result = await handler.run(buildInvocationInput("browser"));

  assert.equal(result?.status, "completed");
  assert.equal(bridgeCalled, false);
  assert.match(readToolContent(gatewayInputs[1]?.messages.find((message) => message.role === "tool")?.content ?? ""), /requires an object input/);
});

test("LLMSubAgentWorkerHandler requires visible text before private refId clicks", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  let bridgeCalled = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const sawToolResult = input.messages.some((message) => message.role === "tool" && message.toolCallId === "tool-1");
    if (!sawToolResult) {
      return toolCallResult("tool-1", "browser_act", {
        action: "click",
        refId: "ref-submit",
      });
    }
    return textResult("Asked for approval-safe target context.");
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "browser",
    innerHandler: buildInnerHandler({ kind: "browser" }),
    gateway,
    browserBridge: buildBrowserBridge({
      async spawnSession() {
        bridgeCalled = true;
        return browserResult({});
      },
    }),
  });

  const result = await handler.run(buildInvocationInput("browser"));

  assert.equal(result?.status, "completed");
  assert.equal(bridgeCalled, false);
  assert.match(readToolContent(gatewayInputs[1]?.messages.find((message) => message.role === "tool")?.content ?? ""), /requires visible text/i);
});

test("LLMSubAgentWorkerHandler carries inner session state across multiple private tool calls", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const innerInputs: WorkerInvocationInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const toolResultCount = input.messages.filter((message) => message.role === "tool").length;
    if (toolResultCount === 0) {
      return toolCallResult("tool-1", "browser_run", { instruction: "Open https://example.test." });
    }
    if (toolResultCount === 1) {
      return toolCallResult("tool-2", "browser_run", { instruction: "Snapshot the current page." });
    }
    return textResult("Browser multi-step work completed.");
  };
  const innerHandler = buildInnerHandler({
    kind: "browser",
    async run(input) {
      innerInputs.push(input);
      return {
        workerType: "browser",
        status: "completed",
        summary: `browser step ${innerInputs.length}`,
        payload: {
          sessionId: "browser-session-1",
          targetId: "target-1",
          resumeMode: innerInputs.length === 1 ? "cold" : "hot",
        },
      };
    },
  });
  const handler = new LLMSubAgentWorkerHandler({ kind: "browser", innerHandler, gateway });

  const result = await handler.run(buildInvocationInput("browser"));

  assert.equal(result?.status, "completed");
  assert.equal(innerInputs.length, 2);
  assert.equal(innerInputs[0]?.sessionState, undefined);
  assert.equal(innerInputs[1]?.packet.continuityMode, "resume-existing");
  assert.equal(innerInputs[1]?.sessionState?.status, "resumable");
  assert.deepEqual(innerInputs[1]?.sessionState?.lastResult?.payload, {
    sessionId: "browser-session-1",
    targetId: "target-1",
    resumeMode: "cold",
  });
});

test("LLMSubAgentWorkerHandler canHandle only claims its preferred worker kind", async () => {
  const handler = new LLMSubAgentWorkerHandler({
    kind: "explore",
    innerHandler: buildInnerHandler({ kind: "explore" }),
    gateway: Object.create(LLMGateway.prototype) as LLMGateway,
  });

  assert.equal(await handler.canHandle(buildInvocationInput("explore")), true);
  assert.equal(await handler.canHandle(buildInvocationInput("browser")), false);
});

test("LLMSubAgentWorkerHandler returns a partial result when aborted before work", async () => {
  const controller = new AbortController();
  controller.abort();
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  let gatewayCalled = false;
  gateway.generate = async () => {
    gatewayCalled = true;
    return textResult("should not happen");
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "explore",
    innerHandler: buildInnerHandler({ kind: "explore" }),
    gateway,
  });

  const result = await handler.run({
    ...buildInvocationInput("explore"),
    signal: controller.signal,
  });

  assert.equal(result?.status, "partial");
  assert.equal(gatewayCalled, false);
});

test("LLMSubAgentWorkerHandler stops before private tools when aborted after an LLM response", async () => {
  const controller = new AbortController();
  let releaseGateway!: () => void;
  let gatewayCalled = false;
  let innerCalled = false;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => {
    gatewayCalled = true;
    await new Promise<void>((resolve) => {
      releaseGateway = resolve;
    });
    return toolCallResult("tool-1", "explore_run", { instruction: "Fetch the source." });
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "explore",
    innerHandler: buildInnerHandler({
      kind: "explore",
      async run() {
        innerCalled = true;
        return {
          workerType: "explore",
          status: "completed",
          summary: "should not run",
          payload: {},
        };
      },
    }),
    gateway,
  });

  const pending = handler.run({
    ...buildInvocationInput("explore"),
    signal: controller.signal,
  });
  await waitUntil(() => gatewayCalled);
  controller.abort();
  releaseGateway();
  const result = await pending;

  assert.equal(result?.status, "partial");
  assert.equal(innerCalled, false);
});

test("LLMSubAgentWorkerHandler returns a tool error for malformed private tool input", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    const sawToolResult = input.messages.some((message) => message.role === "tool" && message.toolCallId === "tool-1");
    if (!sawToolResult) {
      return toolCallResult("tool-1", "explore_run", null as unknown as Record<string, unknown>);
    }
    return textResult("Recovered after malformed tool input.");
  };
  const handler = new LLMSubAgentWorkerHandler({
    kind: "explore",
    innerHandler: buildInnerHandler({ kind: "explore" }),
    gateway,
  });

  const result = await handler.run(buildInvocationInput("explore"));

  assert.equal(result?.status, "completed");
  assert.equal(result?.summary, "Recovered after malformed tool input.");
  const toolMessage = gatewayInputs[1]?.messages.find((message) => message.role === "tool");
  assert.match(readToolContent(toolMessage?.content ?? ""), /Missing required string field: instruction/);
});

function buildInnerHandler(input: {
  kind: "browser" | "explore";
  run?: (input: WorkerInvocationInput) => Promise<WorkerExecutionResult | null>;
}): WorkerHandler {
  return {
    kind: input.kind,
    canHandle(workerInput) {
      return workerInput.packet.preferredWorkerKinds?.includes(input.kind) === true;
    },
    run:
      input.run ??
      (async () => ({
        workerType: input.kind,
        status: "completed",
        summary: `${input.kind} completed.`,
        payload: {},
      })),
  };
}

function buildBrowserBridge(overrides: Partial<BrowserBridge>): BrowserBridge {
  const base: BrowserBridge = {
    async inspectPublicPage() {
      throw new Error("not implemented");
    },
    async runTask(input) {
      return base.spawnSession(input);
    },
    async spawnSession() {
      return browserResult({});
    },
    async sendSession() {
      return browserResult({});
    },
    async resumeSession() {
      return browserResult({});
    },
    async getSessionHistory(): Promise<BrowserSessionHistoryEntry[]> {
      return [];
    },
    async listSessions(): Promise<BrowserSession[]> {
      return [];
    },
    async listTargets(): Promise<BrowserTarget[]> {
      return [];
    },
    async openTarget() {
      throw new Error("not implemented");
    },
    async activateTarget() {
      throw new Error("not implemented");
    },
    async closeTarget() {
      throw new Error("not implemented");
    },
    async evictIdleSessions(): Promise<BrowserSession[]> {
      return [];
    },
    async closeSession() {},
    ...overrides,
  };
  return base;
}

function browserResult(input: { title?: string; finalUrl?: string; traceKinds?: string[] }): BrowserTaskResult {
  return {
    sessionId: "browser-session-1",
    targetId: "target-1",
    transportMode: "direct-cdp",
    transportLabel: "direct-cdp",
    resumeMode: "hot",
    page: {
      requestedUrl: input.finalUrl ?? "https://example.test/",
      finalUrl: input.finalUrl ?? "https://example.test/",
      title: input.title ?? "Example",
      textExcerpt: "Example page text.",
      statusCode: 200,
      interactives: [{ refId: "ref-1", tagName: "A", role: "link", label: "More" }],
    },
    screenshotPaths: [],
    artifactIds: [],
    trace: (input.traceKinds ?? ["snapshot"]).map((kind, index) => ({
      stepId: `step-${index}`,
      kind: kind as BrowserTaskResult["trace"][number]["kind"],
      startedAt: index,
      completedAt: index + 1,
      status: "ok",
      input: {},
    })),
  };
}

function buildInvocationInput(kind: "browser" | "explore"): WorkerInvocationInput {
  return {
    activation: buildActivation(),
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      systemPrompt: "Parent prompt should be replaced.",
      taskPrompt: `Investigate with ${kind}.`,
      outputContract: "Return result.",
      suggestedMentions: [],
      preferredWorkerKinds: [kind],
    },
  };
}

function buildActivation(): RoleActivationInput {
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
          model: {
            provider: "anthropic",
            name: "claude-test",
          },
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
      maxIterations: 128,
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
    text: "Calling tool.",
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

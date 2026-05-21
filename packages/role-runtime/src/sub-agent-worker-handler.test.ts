import assert from "node:assert/strict";
import test from "node:test";

import type {
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
  assert.deepEqual(gatewayInputs[0]?.tools?.map((tool) => tool.name), ["explore_run"]);
  assert.ok(!JSON.stringify(gatewayInputs[0]?.tools ?? []).includes("sessions_spawn"));
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

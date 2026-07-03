import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { GenerateTextInput, LLMMessage } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { createEngineModelClient } from "./engine-model-client";
import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { RolePromptPacket } from "../prompt-policy";

test("createEngineModelClient builds tool-round gateway requests and records model boundaries", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: "engine answer",
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
      toolCalls: [{ id: "call-1", name: "web_search", input: { q: "demo" } }],
    };
  };
  const warningInputs: Array<{
    messages: LLMMessage[];
    active: boolean;
    round: number;
    maxRounds: number;
  }> = [];
  const pruningSnapshots: unknown[] = [];
  const reductions: unknown[] = [];
  const memoryFlushes: unknown[] = [];
  const trace: ModelCallBoundaryTrace[] = [];
  const engineModel = createEngineModelClient({
    gateway,
    now: (() => {
      let now = 30;
      return () => ++now;
    })(),
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    baseGatewayInput: {
      modelId: "model-1",
      tools: [{ name: "web_search", description: "", inputSchema: {} }],
      messages: [{ role: "user", content: "Base prompt." }],
    },
    modelCallTrace: trace,
    maxRounds: 2,
    activeToolLoop: true,
    executionBudget: {
      applyFinalToolRoundWarning(input) {
        warningInputs.push(input);
        return input.messages;
      },
    },
    runState: {
      recordReduction(input) {
        reductions.push(input);
      },
      recordMemoryFlush(input) {
        memoryFlushes.push(input);
      },
    },
    recordPruning(snapshot) {
      pruningSnapshots.push(snapshot);
    },
  });

  const response = await engineModel.model.generate({
    messages: [{ role: "user", content: "Round prompt." }],
    tools: [{ name: "web_search", description: "", inputSchema: {} }],
    toolChoice: { name: "web_search" },
  });

  assert.equal(response.text, "engine answer");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(gatewayInputs.length, 1);
  assert.deepEqual(gatewayInputs[0]?.toolChoice, {
    type: "tool",
    name: "web_search",
  });
  assert.equal(warningInputs.length, 1);
  assert.equal(warningInputs[0]?.active, true);
  assert.equal(warningInputs[0]?.round, 0);
  assert.equal(warningInputs[0]?.maxRounds, 2);
  assert.equal(pruningSnapshots.length, 1);
  assert.equal(reductions.length, 0);
  assert.equal(memoryFlushes.length, 0);
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.phase, "tool_round");
  assert.equal(trace[0]?.round, 0);
  assert.equal(trace[0]?.toolSchemaCount, 1);
  assert.equal(trace[0]?.toolChoice, "tool:web_search");
  assert.equal(engineModel.lastResult()?.text, "engine answer");
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
    taskPrompt: "Use the web_search tool, then answer.",
    outputContract: "Return the final answer only.",
    suggestedMentions: [],
  };
}

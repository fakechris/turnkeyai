import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { GenerateTextInput } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { generateFinalAfterToolRoundLimit } from "./terminal-final-synthesis";
import type { ModelCallBoundaryTrace } from "./model-call-trace";
import type { RolePromptPacket } from "./prompt-policy";

test("generateFinalAfterToolRoundLimit invokes a tool-free final synthesis through the gateway owner", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: "final answer",
      modelId: "model-1",
      providerId: "provider",
      protocol: "openai-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const trace: ModelCallBoundaryTrace[] = [];

  const generated = await generateFinalAfterToolRoundLimit({
    gateway,
    now: (() => {
      let now = 10;
      return () => ++now;
    })(),
    activation: buildActivation(),
    packet: buildPacket(),
    selection: { modelId: "model-1" },
    baseGatewayInput: {
      modelId: "model-1",
      tools: [{ name: "web_search", description: "", inputSchema: {} }],
      messages: [{ role: "user", content: "Use tools first." }],
    },
    messages: [
      { role: "assistant", content: "Gathered evidence from the tool trace." },
    ],
    maxRounds: 3,
    modelCallTrace: trace,
  });

  assert.equal(generated.result.text, "final answer");
  assert.equal(gatewayInputs.length, 1);
  assert.equal(gatewayInputs[0]?.tools, undefined);
  assert.equal(gatewayInputs[0]?.toolChoice, "none");
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.phase, "final_synthesis");
  assert.equal(trace[0]?.toolSchemaCount, 0);
  assert.equal(trace[0]?.toolChoice, "none");
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
    taskPrompt: "Use tools, then produce a final answer.",
    outputContract: "Return the final answer only.",
    suggestedMentions: [],
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput, TeamMessage } from "@turnkeyai/core-types/team";
import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import { createEngineRuntimeForcedToolRoundRunner } from "./engine-forced-tool-round-runner";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";

test("createEngineRuntimeForcedToolRoundRunner wires forced-round persistence and provider protocol recording", async () => {
  const toolTrace: NativeToolRoundTrace[] = [];
  const persisted: TeamMessage[] = [];
  const providerProgress: unknown[] = [];
  const call: LLMToolCall = {
    id: "call-1",
    name: "permission_result",
    input: { approved: true },
  };
  const runner = createEngineRuntimeForcedToolRoundRunner({
    toolLoop: {
      executor: {
        definitions: () => [],
        async execute() {
          return {
            toolCallId: "call-1",
            toolName: "permission_result",
            content: "approved",
          };
        },
      },
    },
    runtimeProgressRecorder: {
      async record(progress) {
        providerProgress.push(progress);
      },
    },
    nativeToolMessageStore: {
      async append(message) {
        persisted.push(message);
      },
    },
    deferToolObservability: false,
    now: () => 1234,
    activation: buildActivation(),
    packet: buildPacket(),
    toolTrace,
    toolLoopStartedAtMs: 1200,
  });

  const result = await runner({
    messages: [{ role: "user", content: "Force permission result." }],
    toolCalls: [call],
    assistantText: "Recording permission result.",
  });

  assert.equal(result.toolResults.length, 1);
  assert.equal(result.messages.at(-2)?.role, "assistant");
  assert.equal(result.messages.at(-1)?.role, "tool");
  assert.equal(toolTrace.length, 1);
  assert.equal(toolTrace[0]?.round, 1);
  assert.equal(toolTrace[0]?.calls[0]?.name, "permission_result");
  assert.equal(toolTrace[0]?.results[0]?.toolName, "permission_result");
  assert.ok(persisted.length > 0);
  assert.equal(
    providerProgress.some(
      (progress) =>
        typeof progress === "object" &&
        progress !== null &&
        (progress as { metadata?: { boundaryKind?: string } }).metadata
          ?.boundaryKind === "provider_tool_protocol_round",
    ),
    true,
  );
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
    taskPrompt: "Record permission state.",
    outputContract: "Return the result.",
    suggestedMentions: [],
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import { HeuristicModelAdapter } from "./model-adapter";
import { DefaultRoleProfileRegistry } from "./role-profile";

test("heuristic fallback lead synthesis uses latest tool evidence instead of a generic success line", async () => {
  const adapter = new HeuristicModelAdapter();
  const activation = buildActivationWithToolResult();
  const profile = new DefaultRoleProfileRegistry().resolve(activation.thread.roles[0]!);

  const result = await adapter.invoke({
    activation,
    profile,
    packet: {
      roleId: "role-lead",
      roleName: "Lead",
      seat: "lead",
      systemPrompt: "Lead.",
      taskPrompt: "Continue from the slow-source attempt.",
      outputContract: "Return result.",
      suggestedMentions: [],
    },
  });

  assert.match(result.content, /Final synthesis based on the latest tool result/);
  assert.match(result.content, /Verified resumed source evidence/);
  assert.match(result.content, /Unverified/);
  assert.match(result.content, /Residual risk/);
  assert.match(result.content, /Continuation/);
  assert.doesNotMatch(result.content, /daemon, flow ledger, role runs/i);
});

function buildActivationWithToolResult(): RoleActivationInput {
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
          recentMessages: [
            {
              messageId: "tool-1",
              role: "tool",
              name: "sessions_send",
              content: JSON.stringify({
                protocol: "turnkeyai.session_tool_result.v1",
                status: "completed",
                result: "Verified resumed source evidence. Unverified freshness remains.",
              }),
              createdAt: 1,
            },
          ],
        },
      },
      createdAt: 1,
    },
  };
}

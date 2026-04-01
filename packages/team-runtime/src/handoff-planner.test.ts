import test from "node:test";
import assert from "node:assert/strict";

import type { FlowLedger, TeamThread } from "@turnkeyai/core-types/team";

import { DefaultHandoffPlanner } from "./handoff-planner";

test("handoff planner resolves known role mentions", async () => {
  const planner = new DefaultHandoffPlanner();
  const thread: TeamThread = {
    threadId: "thread-1",
    teamId: "team-1",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const flow: FlowLedger = {
    flowId: "flow-1",
    threadId: thread.threadId,
    rootMessageId: "msg-1",
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 0,
    maxHops: 5,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const decision = await planner.validateMentionTargets(thread, {
    flow,
    sourceRoleId: "lead",
    messageId: "msg-2",
    content: "@{operator} Please handle this",
  });

  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.targetRoleIds, ["operator"]);
});

test("handoff planner rejects targets that exceed per-role hop limit", async () => {
  const planner = new DefaultHandoffPlanner({ maxPerRoleHopCount: 1 });
  const thread: TeamThread = {
    threadId: "thread-1",
    teamId: "team-1",
    teamName: "Demo",
    leadRoleId: "lead",
    roles: [
      { roleId: "lead", name: "Lead", seat: "lead", runtime: "local" },
      { roleId: "operator", name: "Operator", seat: "member", runtime: "local" },
    ],
    participantLinks: [],
    metadataVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const flow: FlowLedger = {
    flowId: "flow-1",
    threadId: thread.threadId,
    rootMessageId: "msg-1",
    mode: "serial",
    status: "running",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: "lead",
    hopCount: 1,
    maxHops: 5,
    edges: [
      {
        edgeId: "edge-1",
        flowId: "flow-1",
        toRoleId: "operator",
        sourceMessageId: "msg-1",
        state: "created",
        createdAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };

  const decision = await planner.validateMentionTargets(thread, {
    flow,
    sourceRoleId: "lead",
    messageId: "msg-2",
    content: "@{operator} Please retry",
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "role hop limit exceeded: operator");
});

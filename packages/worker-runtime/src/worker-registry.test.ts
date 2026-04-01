import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerHandler, WorkerInvocationInput } from "@turnkeyai/core-types/team";

import { DefaultWorkerRegistry } from "./worker-registry";

test("worker registry honors preferred worker order from the prompt packet", async () => {
  const callOrder: string[] = [];
  const browserHandler: WorkerHandler = {
    kind: "browser",
    async canHandle() {
      callOrder.push("browser");
      return true;
    },
    async run() {
      return null;
    },
  };
  const exploreHandler: WorkerHandler = {
    kind: "explore",
    async canHandle() {
      callOrder.push("explore");
      return true;
    },
    async run() {
      return null;
    },
  };

  const registry = new DefaultWorkerRegistry([browserHandler, exploreHandler]);
  const selected = await registry.selectHandler({
    ...buildInvocation(),
    packet: {
      ...buildInvocation().packet,
      preferredWorkerKinds: ["explore", "browser"],
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

  assert.equal(selected?.kind, "explore");
  assert.deepEqual(callOrder, ["explore"]);
});

test("worker registry blocks selection when capability inspection allows no workers", async () => {
  const registry = new DefaultWorkerRegistry([
    {
      kind: "browser",
      async canHandle() {
        return true;
      },
      async run() {
        return null;
      },
    },
  ]);

  const selected = await registry.selectHandler({
    ...buildInvocation(),
    packet: {
      ...buildInvocation().packet,
      capabilityInspection: {
        availableWorkers: [],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [],
        unavailableCapabilities: ["browser"],
        generatedAt: 1,
      },
    },
  });

  assert.equal(selected, null);
});

function buildInvocation(): WorkerInvocationInput {
  return {
    activation: {
      runState: {
        runKey: "role:explore:thread:1",
        threadId: "thread-1",
        roleId: "role-explore",
        mode: "group",
        status: "running",
        iterationCount: 0,
        maxIterations: 6,
        inbox: [],
        lastActiveAt: 1,
      },
      thread: {
        threadId: "thread-1",
        teamId: "team-1",
        teamName: "Pricing",
        leadRoleId: "role-lead",
        roles: [
          { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
          { roleId: "role-explore", name: "Explore", seat: "member", runtime: "local", capabilities: ["explore"] },
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
        activeRoleIds: ["role-explore"],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 1,
        maxHops: 8,
        edges: [],
        createdAt: 1,
        updatedAt: 1,
      },
      handoff: {
        taskId: "task-1",
        flowId: "flow-1",
        sourceMessageId: "msg-1",
        targetRoleId: "role-explore",
        activationType: "mention",
        threadId: "thread-1",
        payload: {
          threadId: "thread-1",
          relayBrief: "Check pricing.",
          recentMessages: [],
          dispatchPolicy: {
            allowParallel: false,
            allowReenter: true,
            sourceFlowMode: "serial",
          },
        },
        createdAt: 1,
      },
    },
    packet: {
      roleId: "role-explore",
      roleName: "Explore",
      systemPrompt: "Research official pages.",
      taskPrompt: "Check pricing.",
      outputContract: "Return pricing facts.",
      suggestedMentions: ["role-lead"],
    },
  };
}

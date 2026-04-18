import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelayPayload, type WorkerInvocationInput } from "@turnkeyai/core-types/team";

import { FinanceWorkerHandler } from "./finance-worker-handler";

test("finance worker extracts pricing lines from prompt evidence", async () => {
  const handler = new FinanceWorkerHandler();

  const result = await handler.run({
    ...buildFinanceInvocationInput(),
    packet: {
      ...buildFinanceInvocationInput().packet,
      taskPrompt: [
        "Summarize pricing.",
        "Worker result:",
        "GPT-5 input $1.25 / 1M tokens",
        "GPT-5 output $10.00 / 1M tokens",
      ].join("\n"),
    },
  });

  assert.equal(result?.status, "completed");
  const payload = result?.payload as { priceLines: string[] };
  assert.deepEqual(payload.priceLines, ["GPT-5 input $1.25 / 1M tokens", "GPT-5 output $10.00 / 1M tokens"]);
});

function buildFinanceInvocationInput(): WorkerInvocationInput {
  return {
    activation: {
      runState: {
        runKey: "role:finance:thread:1",
        threadId: "thread-1",
        roleId: "role-finance",
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
          { roleId: "role-finance", name: "Finance", seat: "member", runtime: "local", capabilities: ["finance"] },
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
        activeRoleIds: ["role-finance"],
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
        targetRoleId: "role-finance",
        activationType: "mention",
        threadId: "thread-1",
        payload: normalizeRelayPayload({
          threadId: "thread-1",
          relayBrief: "Summarize pricing.",
          recentMessages: [],
          instructions: "Summarize pricing.",
          dispatchPolicy: {
            allowParallel: false,
            allowReenter: true,
            sourceFlowMode: "serial",
          },
        }),
        createdAt: 1,
      },
    },
    packet: {
      roleId: "role-finance",
      roleName: "Finance",
      systemPrompt: "Focus on pricing.",
      taskPrompt: "Summarize pricing.",
      outputContract: "Return price deltas.",
      suggestedMentions: ["role-lead"],
      preferredWorkerKinds: ["finance"],
    },
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import type { FlowLedger, RuntimeChain, TeamThread } from "@turnkeyai/core-types/team";

import { reconcileRuntimeChainsOnStartup } from "./runtime-chain-startup-reconcile";

test("runtime chain startup reconcile reports orphaned and mismatched chain projections", async () => {
  const threads: TeamThread[] = [
    {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Demo",
      leadRoleId: "lead",
      roles: [],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const flows: FlowLedger[] = [
    {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "msg-1",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: [],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 0,
      maxHops: 4,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const chains: RuntimeChain[] = [
    {
      chainId: "chain:ok",
      threadId: "thread-1",
      rootKind: "flow",
      rootId: "flow-1",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      chainId: "chain:missing-thread",
      threadId: "thread-orphan",
      rootKind: "flow",
      rootId: "flow-1",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      chainId: "chain:missing-flow",
      threadId: "thread-1",
      rootKind: "flow",
      rootId: "flow-missing",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      chainId: "chain:cross-thread-flow",
      threadId: "thread-orphan",
      rootKind: "task",
      rootId: "task-1",
      flowId: "flow-1",
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const result = await reconcileRuntimeChainsOnStartup({
    teamThreadStore: {
      async list() {
        return threads;
      },
    } as any,
    flowLedgerStore: {
      async listAll() {
        return flows;
      },
      async listByThread() {
        return [];
      },
    } as any,
    runtimeChainStore: {
      async listAll() {
        return chains;
      },
      async listByThread() {
        return [];
      },
    } as any,
  });

  assert.deepEqual(result, {
    orphanedThreadChains: 2,
    missingFlowChains: 1,
    crossThreadFlowChains: 2,
    affectedChainIds: ["chain:missing-thread", "chain:missing-flow", "chain:cross-thread-flow"],
  });
});

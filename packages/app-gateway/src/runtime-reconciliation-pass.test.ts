import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeReconciliationPass } from "./runtime-reconciliation-pass";

test("runtime reconciliation pass syncs recovery runtime and reports drift remediation", async () => {
  const syncedThreads: string[] = [];
  const result = await runRuntimeReconciliationPass({
    clock: { now: () => 1_000 },
    teamThreadStore: {
      async list() {
        return [{ threadId: "thread-1" }];
      },
    } as any,
    flowLedgerStore: {
      async get() {
        return null;
      },
      async listByThread(threadId: string) {
        return threadId === "thread-1"
          ? [
              {
                flowId: "flow-1",
                threadId: "thread-1",
                status: "running",
                activeRoleIds: [],
                updatedAt: 100,
                version: 1,
              },
            ]
          : [];
      },
    } as any,
    recoveryRunStore: {
      async listByThread() {
        return [
          {
            recoveryRunId: "recovery:task-1",
            threadId: "thread-1",
            sourceGroupId: "task-1",
            flowId: "missing-flow",
            status: "running",
            nextAction: "retry_same_layer",
            autoDispatchReady: false,
            requiresManualIntervention: true,
            latestSummary: "missing flow",
            attempts: [],
            updatedAt: 100,
            createdAt: 100,
            version: 1,
          },
        ];
      },
      async put() {},
    } as any,
    runtimeChainStore: {
      async listByThread() {
        return [
          {
            chainId: "chain-1",
            threadId: "thread-1",
            rootKind: "flow",
            rootId: "missing-flow",
            createdAt: 100,
            updatedAt: 100,
            version: 1,
          },
        ];
      },
    } as any,
    runtimeChainStatusStore: {
      async listByThread() {
        return [
          {
            chainId: "chain-1",
            threadId: "thread-2",
            phase: "started",
            latestSummary: "drift",
            attention: true,
            updatedAt: 100,
            version: 1,
          },
        ];
      },
    } as any,
    runtimeChainSpanStore: {
      async listByChain() {
        return [];
      },
    } as any,
    runtimeChainEventStore: {
      async listByChain() {
        return [];
      },
    } as any,
    async syncRecoveryRuntime(threadId: string) {
      syncedThreads.push(threadId);
      return {
        runs: [
          {
            recoveryRunId: "recovery:task-1",
            threadId,
            sourceGroupId: "task-1",
            status: "running",
            nextAction: "retry_same_layer",
            autoDispatchReady: false,
            requiresManualIntervention: true,
            latestSummary: "still running",
            attempts: [],
            updatedAt: 100,
            createdAt: 100,
          },
        ],
      } as any;
    },
    recoveryRunStaleAfterMs: 500,
  });

  assert.deepEqual(syncedThreads, ["thread-1"]);
  assert.equal(result.syncedRecoveryThreads, 1);
  assert.equal(result.syncedRecoveryRuns, 1);
  assert.equal(result.staleRecoveryRuns, 1);
  assert.equal(result.flowRecovery.failedRecoveryRuns, 1);
  assert.equal(result.runtimeChains.affectedChainIds[0], "chain-1");
  assert.equal(result.runtimeChainArtifacts.crossThreadStatuses, 1);
  assert.ok(
    result.remediation.includes("Inspect affected recovery runs and retry or supersede any orphaned flow-linked recovery work.")
  );
  assert.ok(result.remediation.includes("Inspect runtime chain projection drift for affected chains before trusting operator state."));
});

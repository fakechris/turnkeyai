import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBatchOutbox } from "@turnkeyai/team-runtime/file-batch-outbox";

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
    result.remediation.some(
      (item) => item.action === "inspect_flow_recovery_drift" && item.scope === "flow_recovery"
    )
  );
  assert.ok(
    result.remediation.some(
      (item) => item.action === "inspect_runtime_chain" && item.scope === "runtime_summary"
    )
  );
});

test("runtime reconciliation pass reports cross-store safety dead letters and expired leases", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-reconcile-cross-store-"));
  const now = 5_000;

  try {
    const flowStartOutbox = new FileBatchOutbox<{ kind: string }>({
      rootDir: path.join(tempDir, "flow-start"),
      now: () => now,
    });
    const flowStartBatch = await flowStartOutbox.enqueue([{ kind: "flow-start" }]);
    const flowStartClaim = await flowStartOutbox.claimDue({ leaseDurationMs: 50, now });
    await flowStartOutbox.deadLetter(flowStartBatch.batchId, {
      attemptCount: 1,
      items: flowStartBatch.items,
      error: new Error("flow start failed"),
      leaseId: flowStartClaim[0]!.leaseId,
    });

    const dispatchOutbox = new FileBatchOutbox<{ kind: string }>({
      rootDir: path.join(tempDir, "dispatch"),
      now: () => now,
    });
    await dispatchOutbox.enqueue([{ kind: "dispatch" }]);
    await dispatchOutbox.claimDue({ leaseDurationMs: 50, now });

    const roleOutcomeOutbox = new FileBatchOutbox<{ kind: string }>({
      rootDir: path.join(tempDir, "role-outcome"),
      now: () => now,
    });
    const roleOutcomeBatch = await roleOutcomeOutbox.enqueue([{ kind: "role-outcome" }]);
    const roleOutcomeClaim = await roleOutcomeOutbox.claimDue({ leaseDurationMs: 50, now });
    await roleOutcomeOutbox.deadLetter(roleOutcomeBatch.batchId, {
      attemptCount: 2,
      items: roleOutcomeBatch.items,
      error: new Error("role outcome failed"),
      leaseId: roleOutcomeClaim[0]!.leaseId,
    });

    const result = await runRuntimeReconciliationPass({
      clock: { now: () => now + 1_000 },
      teamThreadStore: {
        async list() {
          return [];
        },
      } as any,
      flowLedgerStore: {
        async get() {
          return null;
        },
        async listByThread() {
          return [];
        },
      } as any,
      recoveryRunStore: {
        async listByThread() {
          return [];
        },
        async put() {},
      } as any,
      runtimeChainStore: {
        async listByThread() {
          return [];
        },
      } as any,
      runtimeChainStatusStore: {
        async listByThread() {
          return [];
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
      async syncRecoveryRuntime() {
        return { runs: [] };
      },
      recoveryRunStaleAfterMs: 500,
      flowStartOutboxRootDir: path.join(tempDir, "flow-start"),
      dispatchOutboxRootDir: path.join(tempDir, "dispatch"),
      roleOutcomeOutboxRootDir: path.join(tempDir, "role-outcome"),
    });

    assert.equal(result.crossStoreSafety.flowStartOutbox.deadLetterBatches, 1);
    assert.equal(result.crossStoreSafety.dispatchOutbox.inflightBatches, 1);
    assert.equal(result.crossStoreSafety.dispatchOutbox.expiredInflightBatches, 1);
    assert.equal(result.crossStoreSafety.roleOutcomeOutbox.deadLetterBatches, 1);
    assert.ok(
      result.remediation.some(
        (item) => item.action === "inspect_outbox_dead_letter" && item.subjectId === "flow-start-outbox"
      )
    );
    assert.ok(
      result.remediation.some(
        (item) => item.action === "inspect_outbox_dead_letter" && item.subjectId === "role-outcome-outbox"
      )
    );
    assert.ok(
      result.remediation.some((item) => item.action === "inspect_outbox_lease")
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

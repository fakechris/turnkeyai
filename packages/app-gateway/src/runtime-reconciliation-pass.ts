import type {
  Clock,
  FlowLedgerStore,
  FlowRecoveryStartupReconcileResult,
  OrphanedWorkItemReconcileResult,
  RecoveryRun,
  RecoveryRunStore,
  RoleRunStore,
  RuntimeReconciliationSnapshot,
  RuntimeChainArtifactStartupReconcileResult,
  RuntimeChainEventStore,
  RuntimeChainSpanStore,
  RuntimeChainStartupReconcileResult,
  RuntimeChainStatusStore,
  RuntimeChainStore,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";
import type { MissionStore, WorkItemStore } from "@turnkeyai/core-types/mission";
import { FileBatchOutbox, type OutboxInspectionResult } from "@turnkeyai/team-runtime/file-batch-outbox";
import { truthRemediation } from "@turnkeyai/qc-runtime/truth-alignment";

import { reconcileFlowRecoveryOnStartup } from "./flow-recovery-startup-reconcile";
import { reconcileOrphanedWorkItemsOnStartup } from "./mission-work-item-startup-reconcile";
import { reconcileRuntimeChainArtifactsOnStartup } from "./runtime-chain-artifact-startup-reconcile";
import { reconcileRuntimeChainsOnStartup } from "./runtime-chain-startup-reconcile";

const EMPTY_ORPHANED_WORK_ITEM_RESULT: OrphanedWorkItemReconcileResult = {
  scannedMissions: 0,
  scannedWorkItems: 0,
  orphanedWorkItems: 0,
  affectedWorkItemIds: [],
  affectedMissionIds: [],
};

export type RuntimeReconciliationPassResult = RuntimeReconciliationSnapshot;

export async function runRuntimeReconciliationPass(input: {
  clock: Clock;
  teamThreadStore: TeamThreadStore;
  flowLedgerStore: FlowLedgerStore;
  recoveryRunStore: RecoveryRunStore;
  runtimeChainStore: RuntimeChainStore;
  runtimeChainStatusStore: RuntimeChainStatusStore;
  runtimeChainSpanStore: RuntimeChainSpanStore;
  runtimeChainEventStore: RuntimeChainEventStore;
  roleRunStore?: RoleRunStore;
  missionStore?: MissionStore;
  workItemStore?: WorkItemStore;
  syncRecoveryRuntime(threadId: string): Promise<{ runs: RecoveryRun[] }>;
  recoveryRunStaleAfterMs: number;
  flowStartOutboxRootDir?: string;
  dispatchOutboxRootDir?: string;
  roleOutcomeOutboxRootDir?: string;
}): Promise<RuntimeReconciliationPassResult> {
  const threads = await input.teamThreadStore.list();
  const [flowRecovery, runtimeChains, runtimeChainArtifacts, orphanedWorkItems, recoverySnapshots, crossStoreSafety] =
    await Promise.all([
    reconcileFlowRecoveryOnStartup({
      clock: input.clock,
      teamThreadStore: input.teamThreadStore,
      flowLedgerStore: input.flowLedgerStore,
      recoveryRunStore: input.recoveryRunStore,
    }),
    reconcileRuntimeChainsOnStartup({
      teamThreadStore: input.teamThreadStore,
      flowLedgerStore: input.flowLedgerStore,
      runtimeChainStore: input.runtimeChainStore,
    }),
    reconcileRuntimeChainArtifactsOnStartup({
      teamThreadStore: input.teamThreadStore,
      runtimeChainStore: input.runtimeChainStore,
      runtimeChainStatusStore: input.runtimeChainStatusStore,
      runtimeChainSpanStore: input.runtimeChainSpanStore,
      runtimeChainEventStore: input.runtimeChainEventStore,
    }),
    input.missionStore && input.workItemStore && input.roleRunStore
      ? reconcileOrphanedWorkItemsOnStartup({
          clock: input.clock,
          missionStore: input.missionStore,
          workItemStore: input.workItemStore,
          flowLedgerStore: input.flowLedgerStore,
          roleRunStore: input.roleRunStore,
          onError: (error, missionId) => {
            console.error("orphaned work item reconcile failed", {
              missionId,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        })
      : Promise.resolve(EMPTY_ORPHANED_WORK_ITEM_RESULT),
    Promise.all(threads.map((thread) => input.syncRecoveryRuntime(thread.threadId))),
    inspectCrossStoreSafety(input),
  ]);

  const allRecoveryRuns = recoverySnapshots.flatMap((snapshot) => snapshot.runs);
  const now = input.clock.now();
  const staleRecoveryRuns = allRecoveryRuns.filter((run) =>
    ["running", "retrying", "fallback_running", "resumed", "superseded"].includes(run.status) &&
    now - run.updatedAt >= input.recoveryRunStaleAfterMs
  ).length;

  return {
    reconciledAt: now,
    syncedRecoveryThreads: recoverySnapshots.length,
    syncedRecoveryRuns: allRecoveryRuns.length,
    staleRecoveryRuns,
    flowRecovery,
    runtimeChains,
    runtimeChainArtifacts,
    orphanedWorkItems,
    crossStoreSafety,
    remediation: buildRuntimeReconciliationRemediation({
      flowRecovery,
      runtimeChains,
      runtimeChainArtifacts,
      orphanedWorkItems,
      staleRecoveryRuns,
      crossStoreSafety,
    }),
  };
}

function buildRuntimeReconciliationRemediation(input: {
  flowRecovery: FlowRecoveryStartupReconcileResult;
  runtimeChains: RuntimeChainStartupReconcileResult;
  runtimeChainArtifacts: RuntimeChainArtifactStartupReconcileResult;
  orphanedWorkItems: OrphanedWorkItemReconcileResult;
  staleRecoveryRuns: number;
  crossStoreSafety: RuntimeReconciliationPassResult["crossStoreSafety"];
}): RuntimeReconciliationPassResult["remediation"] {
  const remediation: RuntimeReconciliationPassResult["remediation"] = [];

  if (input.orphanedWorkItems.orphanedWorkItems > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_orphaned_work_items",
        scope: "work_item",
        summary:
          "Re-verify work items reconciled to blocked after a daemon restart left their owning flow unrecoverable.",
      })
    );
  }
  if (input.flowRecovery.failedRecoveryRuns > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_flow_recovery_drift",
        scope: "flow_recovery",
        summary: "Inspect affected recovery runs and retry or supersede any orphaned flow-linked recovery work.",
      })
    );
  }
  if (input.runtimeChains.affectedChainIds.length > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_runtime_chain",
        scope: "runtime_summary",
        summary: "Inspect runtime chain projection drift for affected chains before trusting operator state.",
      })
    );
  }
  if (input.runtimeChainArtifacts.affectedChainIds.length > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_runtime_artifacts",
        scope: "runtime_summary",
        summary: "Repair runtime chain status/span/event drift for affected chains.",
      })
    );
  }
  if (input.staleRecoveryRuns > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_recovery_run",
        scope: "recovery",
        summary: "Inspect stale in-flight recovery runs and resume or fallback before re-dispatching work.",
      })
    );
  }
  if (input.crossStoreSafety.flowStartOutbox.deadLetterBatches > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_outbox_dead_letter",
        scope: "cross_store_safety",
        subjectId: "flow-start-outbox",
        summary: "Inspect dead-lettered flow-start intents before trusting message-to-flow convergence.",
      })
    );
  }
  if (input.crossStoreSafety.dispatchOutbox.deadLetterBatches > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_outbox_dead_letter",
        scope: "cross_store_safety",
        subjectId: "dispatch-outbox",
        summary: "Inspect dead-lettered dispatch deliveries before assuming role queues received their handoffs.",
      })
    );
  }
  if (input.crossStoreSafety.roleOutcomeOutbox.deadLetterBatches > 0) {
    remediation.push(
      truthRemediation({
        action: "inspect_outbox_dead_letter",
        scope: "cross_store_safety",
        subjectId: "role-outcome-outbox",
        summary: "Inspect dead-lettered role outcomes before trusting reply/failure-driven flow state transitions.",
      })
    );
  }
  if (
    input.crossStoreSafety.flowStartOutbox.expiredInflightBatches > 0 ||
    input.crossStoreSafety.dispatchOutbox.expiredInflightBatches > 0 ||
    input.crossStoreSafety.roleOutcomeOutbox.expiredInflightBatches > 0
  ) {
    remediation.push(
      truthRemediation({
        action: "inspect_outbox_lease",
        scope: "cross_store_safety",
        summary: "Inspect expired in-flight outbox leases after restart before replaying additional work.",
      })
    );
  }

  return remediation;
}

async function inspectCrossStoreSafety(input: {
  clock: Clock;
  flowStartOutboxRootDir?: string;
  dispatchOutboxRootDir?: string;
  roleOutcomeOutboxRootDir?: string;
}): Promise<RuntimeReconciliationPassResult["crossStoreSafety"]> {
  const now = input.clock.now();
  return {
    flowStartOutbox: await inspectOutbox(input.flowStartOutboxRootDir, now),
    dispatchOutbox: await inspectOutbox(input.dispatchOutboxRootDir, now),
    roleOutcomeOutbox: await inspectOutbox(input.roleOutcomeOutboxRootDir, now),
  };
}

async function inspectOutbox(rootDir: string | undefined, now: number): Promise<OutboxInspectionResult> {
  if (!rootDir) {
    return {
      totalBatches: 0,
      pendingBatches: 0,
      dueBatches: 0,
      inflightBatches: 0,
      expiredInflightBatches: 0,
      deadLetterBatches: 0,
      affectedBatchIds: [],
    };
  }
  const outbox = new FileBatchOutbox<unknown>({
    rootDir,
    now: () => now,
  });
  return outbox.inspect(now);
}

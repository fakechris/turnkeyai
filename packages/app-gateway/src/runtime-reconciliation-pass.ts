import type {
  Clock,
  FlowLedgerStore,
  FlowRecoveryStartupReconcileResult,
  RecoveryRun,
  RecoveryRunStore,
  RuntimeChainArtifactStartupReconcileResult,
  RuntimeChainEventStore,
  RuntimeChainSpanStore,
  RuntimeChainStartupReconcileResult,
  RuntimeChainStatusStore,
  RuntimeChainStore,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";
import { FileBatchOutbox, type OutboxInspectionResult } from "@turnkeyai/team-runtime/file-batch-outbox";

import { reconcileFlowRecoveryOnStartup } from "./flow-recovery-startup-reconcile";
import { reconcileRuntimeChainArtifactsOnStartup } from "./runtime-chain-artifact-startup-reconcile";
import { reconcileRuntimeChainsOnStartup } from "./runtime-chain-startup-reconcile";

export interface RuntimeReconciliationPassResult {
  reconciledAt: number;
  syncedRecoveryThreads: number;
  syncedRecoveryRuns: number;
  staleRecoveryRuns: number;
  flowRecovery: FlowRecoveryStartupReconcileResult;
  runtimeChains: RuntimeChainStartupReconcileResult;
  runtimeChainArtifacts: RuntimeChainArtifactStartupReconcileResult;
  crossStoreSafety: {
    flowStartOutbox: OutboxInspectionResult;
    dispatchOutbox: OutboxInspectionResult;
    roleOutcomeOutbox: OutboxInspectionResult;
  };
  remediation: string[];
}

export async function runRuntimeReconciliationPass(input: {
  clock: Clock;
  teamThreadStore: TeamThreadStore;
  flowLedgerStore: FlowLedgerStore;
  recoveryRunStore: RecoveryRunStore;
  runtimeChainStore: RuntimeChainStore;
  runtimeChainStatusStore: RuntimeChainStatusStore;
  runtimeChainSpanStore: RuntimeChainSpanStore;
  runtimeChainEventStore: RuntimeChainEventStore;
  syncRecoveryRuntime(threadId: string): Promise<{ runs: RecoveryRun[] }>;
  recoveryRunStaleAfterMs: number;
  flowStartOutboxRootDir?: string;
  dispatchOutboxRootDir?: string;
  roleOutcomeOutboxRootDir?: string;
}): Promise<RuntimeReconciliationPassResult> {
  const threads = await input.teamThreadStore.list();
  const [flowRecovery, runtimeChains, runtimeChainArtifacts, recoverySnapshots, crossStoreSafety] = await Promise.all([
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
    crossStoreSafety,
    remediation: buildRuntimeReconciliationRemediation({
      flowRecovery,
      runtimeChains,
      runtimeChainArtifacts,
      staleRecoveryRuns,
      crossStoreSafety,
    }),
  };
}

function buildRuntimeReconciliationRemediation(input: {
  flowRecovery: FlowRecoveryStartupReconcileResult;
  runtimeChains: RuntimeChainStartupReconcileResult;
  runtimeChainArtifacts: RuntimeChainArtifactStartupReconcileResult;
  staleRecoveryRuns: number;
  crossStoreSafety: RuntimeReconciliationPassResult["crossStoreSafety"];
}): string[] {
  const remediation: string[] = [];

  if (input.flowRecovery.failedRecoveryRuns > 0) {
    remediation.push("Inspect affected recovery runs and retry or supersede any orphaned flow-linked recovery work.");
  }
  if (input.runtimeChains.affectedChainIds.length > 0) {
    remediation.push("Inspect runtime chain projection drift for affected chains before trusting operator state.");
  }
  if (input.runtimeChainArtifacts.affectedChainIds.length > 0) {
    remediation.push("Repair runtime chain status/span/event drift for affected chains.");
  }
  if (input.staleRecoveryRuns > 0) {
    remediation.push("Inspect stale in-flight recovery runs and resume or fallback before re-dispatching work.");
  }
  if (input.crossStoreSafety.flowStartOutbox.deadLetterBatches > 0) {
    remediation.push("Inspect dead-lettered flow-start intents before trusting message-to-flow convergence.");
  }
  if (input.crossStoreSafety.dispatchOutbox.deadLetterBatches > 0) {
    remediation.push("Inspect dead-lettered dispatch deliveries before assuming role queues received their handoffs.");
  }
  if (input.crossStoreSafety.roleOutcomeOutbox.deadLetterBatches > 0) {
    remediation.push("Inspect dead-lettered role outcomes before trusting reply/failure-driven flow state transitions.");
  }
  if (
    input.crossStoreSafety.flowStartOutbox.expiredInflightBatches > 0 ||
    input.crossStoreSafety.dispatchOutbox.expiredInflightBatches > 0 ||
    input.crossStoreSafety.roleOutcomeOutbox.expiredInflightBatches > 0
  ) {
    remediation.push("Inspect expired in-flight outbox leases after restart before replaying additional work.");
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

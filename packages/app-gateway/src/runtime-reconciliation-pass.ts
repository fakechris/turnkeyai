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
}): Promise<RuntimeReconciliationPassResult> {
  const threads = await input.teamThreadStore.list();
  const [flowRecovery, runtimeChains, runtimeChainArtifacts, recoverySnapshots] = await Promise.all([
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
    remediation: buildRuntimeReconciliationRemediation({
      flowRecovery,
      runtimeChains,
      runtimeChainArtifacts,
      staleRecoveryRuns,
    }),
  };
}

function buildRuntimeReconciliationRemediation(input: {
  flowRecovery: FlowRecoveryStartupReconcileResult;
  runtimeChains: RuntimeChainStartupReconcileResult;
  runtimeChainArtifacts: RuntimeChainArtifactStartupReconcileResult;
  staleRecoveryRuns: number;
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

  return remediation;
}

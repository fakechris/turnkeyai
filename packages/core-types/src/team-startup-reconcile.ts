import type { RunKey } from "./team-core";

export interface WorkerStartupReconcileResult {
  totalSessions: number;
  downgradedRunningSessions: number;
  unrecoverableSessions: number;
  unrecoverableMissingContextSessions: number;
  unrecoverableUnavailableHandlerSessions: number;
}

export interface WorkerBindingStartupReconcileResult {
  totalRoleRuns: number;
  totalBindings: number;
  clearedMissingBindings: number;
  clearedTerminalBindings: number;
  clearedCrossThreadBindings: number;
  roleRunsNeedingAttention: number;
  roleRunsRequeued: number;
  roleRunsFailed: number;
}

export interface RoleRunStartupRecoveryResult {
  totalRoleRuns: number;
  restartedQueuedRuns: number;
  restartedRunningRuns: number;
  restartedResumingRuns: number;
  restartedRunKeys: RunKey[];
  coldRestartRuns: number;
  coldRestartRunKeys: RunKey[];
  orphanedThreadRuns: number;
  failedOrphanedRuns: number;
  failedRunKeys: RunKey[];
  clearedInvalidHandoffs: number;
  queuedRunsIdled: number;
}

export interface FlowRecoveryStartupReconcileResult {
  orphanedFlows: number;
  abortedOrphanedFlows: number;
  orphanedRecoveryRuns: number;
  missingFlowRecoveryRuns: number;
  crossThreadFlowRecoveryRuns: number;
  failedRecoveryRuns: number;
  affectedFlowIds: RunKey[];
  affectedRecoveryRunIds: RunKey[];
}

export interface RuntimeChainStartupReconcileResult {
  orphanedThreadChains: number;
  missingFlowChains: number;
  crossThreadFlowChains: number;
  affectedChainIds: RunKey[];
}

export interface RuntimeChainArtifactStartupReconcileResult {
  orphanedStatuses: number;
  crossThreadStatuses: number;
  orphanedSpans: number;
  crossThreadSpans: number;
  crossFlowSpans: number;
  orphanedEvents: number;
  missingSpanEvents: number;
  crossThreadEvents: number;
  crossChainEvents: number;
  affectedChainIds: RunKey[];
}

import type {
  FlowRecoveryStartupReconcileResult,
  RuntimeChainArtifactStartupReconcileResult,
  RuntimeChainStartupReconcileResult,
} from "./team-startup-reconcile";

export type TruthState = "confirmed" | "inferred" | "stale";

export type TruthSource =
  | "stored-chain"
  | "stored-chain-fallback-status"
  | "derived-recovery-chain"
  | "runtime-summary-query"
  | "recovery-runtime-query"
  | "recovery-runtime-query+store"
  | "recovery-summary-query"
  | "recovery-timeline-query"
  | "replay-recovery-query"
  | "replay-store"
  | "replay-store+relay-diagnostics"
  | "runtime-reconciliation-pass";

export type TruthRemediationAction =
  | "reconcile_runtime"
  | "inspect_runtime_chain"
  | "inspect_runtime_artifacts"
  | "inspect_runtime_stale"
  | "inspect_recovery_run"
  | "inspect_recovery_failure"
  | "inspect_flow_recovery_drift"
  | "retry_same_layer"
  | "fallback_transport"
  | "resume_from_checkpoint"
  | "review_cold_recreation"
  | "reconnect_session"
  | "review_manual_gate"
  | "inspect_outbox_dead_letter"
  | "inspect_outbox_lease"
  | "inspect_transport";

export type TruthRemediationScope =
  | "runtime"
  | "runtime_chain"
  | "runtime_summary"
  | "recovery"
  | "replay"
  | "transport"
  | "flow_recovery"
  | "cross_store_safety";

export interface TruthRemediation {
  action: TruthRemediationAction;
  scope: TruthRemediationScope;
  summary: string;
  subjectId?: string;
}

export interface TruthAlignment {
  truthState: TruthState;
  confirmed: boolean;
  inferred: boolean;
  stale: boolean;
  truthSource: TruthSource;
  remediation: TruthRemediation[];
}

export type TruthAligned<T> = T & TruthAlignment;

export interface RuntimeReconciliationOutboxSnapshot {
  totalBatches: number;
  pendingBatches: number;
  dueBatches: number;
  inflightBatches: number;
  expiredInflightBatches: number;
  deadLetterBatches: number;
  affectedBatchIds: string[];
}

export interface RuntimeReconciliationSnapshot {
  reconciledAt: number;
  syncedRecoveryThreads: number;
  syncedRecoveryRuns: number;
  staleRecoveryRuns: number;
  flowRecovery: FlowRecoveryStartupReconcileResult;
  runtimeChains: RuntimeChainStartupReconcileResult;
  runtimeChainArtifacts: RuntimeChainArtifactStartupReconcileResult;
  crossStoreSafety: {
    flowStartOutbox: RuntimeReconciliationOutboxSnapshot;
    dispatchOutbox: RuntimeReconciliationOutboxSnapshot;
    roleOutcomeOutbox: RuntimeReconciliationOutboxSnapshot;
  };
  remediation: TruthRemediation[];
}

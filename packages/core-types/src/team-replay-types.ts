import type {
  BrowserContinuationHint,
  ContinuityMode,
  FlowId,
  FlowLedger,
  FlowStatus,
  RoleId,
  RunKey,
  RuntimeSummaryReport,
  ShardGroupRecord,
  TaskId,
  ThreadId,
  WorkerKind,
} from "./team-core";
import type {
  BrowserResumeMode,
  BrowserTargetStatus,
  BrowserTaskResult,
  BrowserTransportDiagnosticBucket,
  BrowserTransportMode,
} from "./browser";
import type { TruthAlignment, TruthRemediation, TruthSource } from "./team-truth";
import type { WorkerContinuationOutcome } from "./team-worker-runtime";
import type {
  RecoveryBrowserOutcome,
  RecoveryRun,
  RecoveryRunAction,
  RecoveryRunProgress,
  RecoveryRunTimelineEntry,
} from "./team-recovery-types";

export type ReplayLayer = "scheduled" | "role" | "worker" | "browser";
export type ReplayStatus = "completed" | "partial" | "failed";
export type FailureCategory =
  | "timeout"
  | "permission_denied"
  | "transport_failed"
  | "stale_session"
  | "invalid_resume"
  | "blocked"
  | "merge_failure"
  | "terminal"
  | "unknown";
export type FailureRecommendedAction =
  | "resume"
  | "retry"
  | "fallback"
  | "request_approval"
  | "abort"
  | "inspect";

export interface FailureSummary {
  category: FailureCategory;
  layer: ReplayLayer;
  retryable: boolean;
  message: string;
  recommendedAction: FailureRecommendedAction;
  details?: Record<string, unknown>;
}

export interface ReplayRecord {
  replayId: string;
  layer: ReplayLayer;
  status: ReplayStatus;
  recordedAt: number;
  threadId: ThreadId;
  summary: string;
  flowId?: FlowId;
  roleId?: RoleId;
  workerType?: WorkerKind;
  workerRunKey?: RunKey;
  taskId?: TaskId;
  parentReplayId?: string;
  failure?: FailureSummary;
  metadata?: Record<string, unknown>;
}

export interface ReplayStore {
  record(record: ReplayRecord): Promise<string>;
  get(replayId: string): Promise<ReplayRecord | null>;
  list(input?: { threadId?: ThreadId; layer?: ReplayLayer; limit?: number }): Promise<ReplayRecord[]>;
}

export interface ReplayLayerSnapshot {
  replayId: string;
  layer: ReplayLayer;
  status: ReplayStatus;
  recordedAt: number;
  summary: string;
  workerType?: WorkerKind;
  failure?: FailureSummary;
}

export interface ReplayTaskSummary {
  groupId: string;
  threadId: ThreadId;
  taskId?: TaskId;
  flowId?: FlowId;
  roleId?: RoleId;
  latestRecordedAt: number;
  latestStatus: ReplayStatus;
  layersSeen: ReplayLayer[];
  replayIds: string[];
  byLayer: Partial<Record<ReplayLayer, ReplayLayerSnapshot>>;
  lastHealthyLayer?: ReplayLayer;
  failedLayer?: ReplayLayer;
  rootFailureCategory?: FailureCategory;
  latestFailure?: FailureSummary;
  recommendedAction?: FailureRecommendedAction;
  recoveryHint: ReplayRecoveryHint;
  requiresFollowUp: boolean;
  browserContinuity?: ReplayBrowserContinuitySummary;
  workerContinuation?: ReplayWorkerContinuitySummary;
}

export interface ReplayInspectionReport {
  totalReplays: number;
  totalGroups: number;
  incidents: ReplayTaskSummary[];
  groups: ReplayTaskSummary[];
  layerCounts: Partial<Record<ReplayLayer, number>>;
  failureCounts: Partial<Record<FailureCategory, number>>;
}

export interface ReplayTruthSummary {
  confirmed: TruthAlignment["confirmed"];
  inferred: TruthAlignment["inferred"];
  stale: TruthAlignment["stale"];
  truthState: TruthAlignment["truthState"];
  truthSource: TruthSource;
  remediation: TruthRemediation[];
}

export interface ReplayRecoveryHint {
  action: FailureRecommendedAction | "none";
  reason: string;
  preferredLayer?: ReplayLayer;
  failedLayer?: ReplayLayer;
  lastHealthyLayer?: ReplayLayer;
}

export interface ReplayRecoveryPlan {
  groupId: string;
  threadId: ThreadId;
  taskId?: TaskId;
  flowId?: FlowId;
  roleId?: RoleId;
  latestStatus: ReplayStatus;
  recoveryHint: ReplayRecoveryHint;
  latestFailure?: FailureSummary;
  layersSeen: ReplayLayer[];
  canAutoResume: boolean;
  requiresManualIntervention: boolean;
  autoDispatchReady: boolean;
  targetWorker?: WorkerKind;
  nextAction:
    | "auto_resume"
    | "retry_same_layer"
    | "fallback_transport"
    | "request_approval"
    | "inspect_then_resume"
    | "stop";
  targetLayer?: ReplayLayer;
  workerContinuation?: ReplayWorkerContinuitySummary;
}

export interface ReplayTimelineEntry {
  replayId: string;
  groupId: string;
  threadId: ThreadId;
  layer: ReplayLayer;
  status: ReplayStatus;
  recordedAt: number;
  summary: string;
  attemptId?: string;
  flowId?: FlowId;
  roleId?: RoleId;
  workerType?: WorkerKind;
  failure?: FailureSummary;
}

export interface ReplayBrowserContinuitySummary {
  latestRecordedAt: number;
  state: "stable" | "recovered" | "attention";
  summary: string;
  sessionId?: string;
  targetId?: string;
  transportMode?: BrowserTransportMode;
  transportLabel?: string;
  transportPeerId?: string;
  transportTargetId?: string;
  browserDiagnosticBucket?: BrowserTransportDiagnosticBucket;
  browserDiagnosticSummary?: string;
  resumeMode?: BrowserResumeMode;
  targetResolution?: BrowserTaskResult["targetResolution"];
  outcome?: RecoveryBrowserOutcome;
  relayPeerStatus?: "online" | "stale" | "missing";
  relayTargetStatus?: BrowserTargetStatus | "missing";
  relayDiagnosticBucket?:
    | "peer_missing"
    | "peer_stale"
    | "target_missing"
    | "target_detached"
    | "target_closed"
    | "action_inflight"
    | "claim_reclaimed"
    | "content_script_unavailable"
    | "action_timeout"
    | "action_failed";
  relayDiagnosticSummary?: string;
}

export interface ReplayWorkerContinuitySummary {
  latestRecordedAt: number;
  state: WorkerContinuationOutcome["state"];
  summary: string;
  requestedMode?: ContinuityMode | null;
  requestedWorkerType?: WorkerKind;
  requestedWorkerRunKey?: RunKey;
  resolvedWorkerType?: WorkerKind;
  resolvedWorkerRunKey?: RunKey;
  reason?: WorkerContinuationOutcome["reason"];
}

export type OperatorCaseState = "open" | "recovering" | "waiting_manual" | "blocked" | "resolved";

export interface ReplayConsoleReport {
  totalReplays: number;
  totalGroups: number;
  openIncidents: number;
  recoveredGroups: number;
  attentionCount: number;
  actionCounts: Partial<Record<ReplayRecoveryPlan["nextAction"], number>>;
  workflowStatusCounts: Partial<Record<NonNullable<ReplayIncidentBundle["recoveryWorkflow"]>["status"], number>>;
  caseStateCounts: Partial<Record<OperatorCaseState, number>>;
  operatorCaseStateCounts: Partial<Record<OperatorCaseState, number>>;
  browserContinuityCounts: Partial<Record<ReplayBrowserContinuitySummary["state"], number>>;
  layerCounts: Partial<Record<ReplayLayer, number>>;
  failureCounts: Partial<Record<FailureCategory, number>>;
  latestIncidents: ReplayRecoveryPlan[];
  latestBundles: Array<{
    groupId: string;
    latestStatus: ReplayTaskSummary["latestStatus"];
    nextAction: ReplayRecoveryPlan["nextAction"] | "none";
    autoDispatchReady: boolean;
    confirmed: TruthAlignment["confirmed"];
    inferred: TruthAlignment["inferred"];
    stale: TruthAlignment["stale"];
    truthState: TruthAlignment["truthState"];
    truthSource: TruthSource;
    remediation: TruthRemediation[];
    caseState?: OperatorCaseState;
    workflowStatus?: NonNullable<ReplayIncidentBundle["recoveryWorkflow"]>["status"];
    workflowSummary?: string;
    caseHeadline?: string;
    browserContinuityState?: ReplayBrowserContinuitySummary["state"];
    browserTransportLabel?: string;
    browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
    relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
    targetLayer?: ReplayRecoveryPlan["targetLayer"];
    targetWorker?: ReplayRecoveryPlan["targetWorker"];
    operatorCaseState?: OperatorCaseState;
    operatorGate?: string;
    operatorAllowedActions?: RecoveryRunAction[];
  }>;
  latestResolvedBundles: Array<{
    groupId: string;
    latestStatus: ReplayTaskSummary["latestStatus"];
    nextAction: ReplayRecoveryPlan["nextAction"] | "none";
    autoDispatchReady: boolean;
    confirmed: TruthAlignment["confirmed"];
    inferred: TruthAlignment["inferred"];
    stale: TruthAlignment["stale"];
    truthState: TruthAlignment["truthState"];
    truthSource: TruthSource;
    remediation: TruthRemediation[];
    caseState?: OperatorCaseState;
    workflowStatus?: NonNullable<ReplayIncidentBundle["recoveryWorkflow"]>["status"];
    workflowSummary?: string;
    caseHeadline?: string;
    browserContinuityState?: ReplayBrowserContinuitySummary["state"];
    browserTransportLabel?: string;
    browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
    relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
    targetLayer?: ReplayRecoveryPlan["targetLayer"];
    targetWorker?: ReplayRecoveryPlan["targetWorker"];
    operatorCaseState?: OperatorCaseState;
    operatorGate?: string;
    operatorAllowedActions?: RecoveryRunAction[];
  }>;
  latestGroups: ReplayTaskSummary[];
}

export interface FlowConsoleReport {
  totalFlows: number;
  statusCounts: Partial<Record<FlowStatus, number>>;
  totalShardGroups: number;
  attentionCount: number;
  attentionStateCounts: Partial<Record<OperatorCaseState, number>>;
  shardStatusCounts: Partial<Record<ShardGroupRecord["status"], number>>;
  groupsWithMissingRoles: number;
  groupsWithRetries: number;
  groupsWithDuplicates: number;
  groupsWithConflicts: number;
  activeRoleCount: number;
  latestFlows: FlowLedger[];
  attentionGroups: Array<{
    flowId: FlowId;
    groupId: string;
    status: ShardGroupRecord["status"];
    caseState: OperatorCaseState;
    reasons: string[];
  }>;
}

export interface ReplayIncidentBundle extends ReplayTruthSummary {
  group: ReplayTaskSummary;
  caseState?: OperatorCaseState;
  caseHeadline?: string;
  browserContinuity?: ReplayBrowserContinuitySummary;
  recovery?: ReplayRecoveryPlan;
  timeline: ReplayTimelineEntry[];
  relatedReplays: ReplayRecord[];
  recoveryDispatches: ReplayRecord[];
  followUpGroups: ReplayTaskSummary[];
  followUpReplays?: ReplayRecord[];
  followUpTimeline: ReplayTimelineEntry[];
  recoveryTimeline?: RecoveryRunTimelineEntry[];
  recoveryProgress?: RecoveryRunProgress;
  recoveryOperator?: {
    caseState: OperatorCaseState;
    currentGate: string;
    allowedActions: RecoveryRunAction[];
    nextAction: RecoveryRun["nextAction"];
    phase: RecoveryRunProgress["phase"];
    phaseSummary: string;
    latestSummary: string;
    latestBrowserOutcome?: RecoveryBrowserOutcome;
  };
  recoveryWorkflow?: {
    status: "not_started" | "running" | "recovered" | "recovery_failed" | "manual_follow_up";
    nextAction: ReplayRecoveryPlan["nextAction"] | "none";
    summary: string;
    latestDispatchReplayId?: string;
    latestFollowUpGroupId?: string;
    latestFailure?: FailureSummary;
  };
  followUpSummary?: {
    totalGroups: number;
    openGroups: number;
    closedGroups: number;
    browserContinuityCounts: Partial<Record<ReplayBrowserContinuitySummary["state"], number>>;
    actionCounts: Partial<Record<ReplayRecoveryHint["action"] | "none", number>>;
  };
  recoveryRun?: RecoveryRun;
}

export interface OperatorSummaryRuntimeHealth {
  workerStartupReconcile?: RuntimeSummaryReport["workerStartupReconcile"];
  workerSessionHealth?: RuntimeSummaryReport["workerSessionHealth"];
  workerBindingReconcile?: RuntimeSummaryReport["workerBindingReconcile"];
  roleRunStartupRecovery?: RuntimeSummaryReport["roleRunStartupRecovery"];
  flowRecoveryStartupReconcile?: RuntimeSummaryReport["flowRecoveryStartupReconcile"];
  runtimeChainStartupReconcile?: RuntimeSummaryReport["runtimeChainStartupReconcile"];
  runtimeChainArtifactStartupReconcile?: RuntimeSummaryReport["runtimeChainArtifactStartupReconcile"];
}

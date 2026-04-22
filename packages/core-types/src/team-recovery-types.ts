import type { BrowserContinuationHint, FlowId, RoleId, TaskId, ThreadId, WorkerKind } from "./team-core";
import type { BrowserResumeMode } from "./browser";
import type {
  FailureSummary,
  OperatorCaseState,
  ReplayBrowserContinuitySummary,
  ReplayLayer,
  ReplayRecoveryPlan,
  ReplayRecoveryHint,
  ReplayStatus,
  ReplayTaskSummary,
} from "./team-replay-types";

export type RecoveryRunStatus =
  | "planned"
  | "running"
  | "waiting_approval"
  | "waiting_external"
  | "retrying"
  | "fallback_running"
  | "resumed"
  | "superseded"
  | "recovered"
  | "failed"
  | "aborted";

export type RecoveryRunAction = "dispatch" | "retry" | "fallback" | "resume" | "approve" | "reject";

export type RecoveryTransitionReason =
  | "manual_dispatch"
  | "manual_retry"
  | "manual_fallback"
  | "manual_resume"
  | "manual_approval"
  | "manual_reject";

export type RecoveryBrowserOutcome =
  | "hot_reuse"
  | "warm_attach"
  | "cold_reopen"
  | "detached_target_recovered"
  | "resume_failed";

export interface RecoveryRunAttempt {
  attemptId: string;
  action: RecoveryRunAction;
  requestedAt: number;
  updatedAt: number;
  status: RecoveryRunStatus;
  nextAction: ReplayRecoveryPlan["nextAction"] | "none";
  summary: string;
  targetLayer?: ReplayLayer;
  targetWorker?: WorkerKind;
  dispatchReplayId?: string;
  dispatchedTaskId?: TaskId;
  resultingGroupId?: string;
  browserSession?: BrowserContinuationHint;
  browserOutcome?: RecoveryBrowserOutcome;
  browserOutcomeSummary?: string;
  failure?: FailureSummary;
  triggeredByAttemptId?: string;
  transitionReason?: RecoveryTransitionReason;
  supersededByAttemptId?: string;
  supersededAt?: number;
  completedAt?: number;
}

export type RecoveryRunEventKind =
  | "action_requested"
  | "action_dispatched"
  | "action_superseded"
  | "action_failed"
  | "waiting_approval"
  | "waiting_external"
  | "follow_up_observed"
  | "recovered"
  | "aborted";

export interface RecoveryRunEvent {
  eventId: string;
  recoveryRunId: string;
  threadId: ThreadId;
  sourceGroupId: string;
  kind: RecoveryRunEventKind;
  status: RecoveryRunStatus;
  recordedAt: number;
  summary: string;
  action?: RecoveryRunAction;
  attemptId?: string;
  triggeredByAttemptId?: string;
  transitionReason?: RecoveryTransitionReason;
  dispatchReplayId?: string;
  taskId?: TaskId;
  resultingGroupId?: string;
  browserSession?: BrowserContinuationHint;
  browserOutcome?: RecoveryBrowserOutcome;
  failure?: FailureSummary;
}

export interface RecoveryRunTimelineEntry {
  entryId: string;
  source: "event" | "replay";
  recordedAt: number;
  kind: string;
  summary: string;
  status?: RecoveryRunStatus | ReplayStatus;
  action?: RecoveryRunAction;
  attemptId?: string;
  triggeredByAttemptId?: string;
  transitionReason?: RecoveryTransitionReason;
  replayId?: string;
  groupId?: string;
  layer?: ReplayLayer;
  browserOutcome?: RecoveryBrowserOutcome;
  failure?: FailureSummary;
}

export interface RecoveryRun {
  recoveryRunId: string;
  threadId: ThreadId;
  sourceGroupId: string;
  taskId?: TaskId;
  flowId?: FlowId;
  roleId?: RoleId;
  targetLayer?: ReplayLayer;
  targetWorker?: WorkerKind;
  latestStatus: ReplayStatus;
  status: RecoveryRunStatus;
  nextAction: ReplayRecoveryPlan["nextAction"] | "none";
  autoDispatchReady: boolean;
  requiresManualIntervention: boolean;
  latestSummary: string;
  waitingReason?: string;
  latestFailure?: FailureSummary;
  currentAttemptId?: string;
  browserSession?: BrowserContinuationHint;
  attempts: RecoveryRunAttempt[];
  version?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecoveryRunProgress {
  phase:
    | "planned"
    | "awaiting_approval"
    | "awaiting_external"
    | "retrying_same_layer"
    | "running_fallback"
    | "resuming_session"
    | "running_dispatch"
    | "recovered"
    | "failed"
    | "aborted";
  phaseSummary: string;
  totalAttempts: number;
  settledAttempts: number;
  supersededAttempts: number;
  recoveredAttempts: number;
  failedAttempts: number;
  waitingAttempts: number;
  activeAttemptId?: string;
  activeAction?: RecoveryRunAction;
  activeStatus?: RecoveryRunStatus;
  lastSettledAttemptId?: string;
  lastSettledStatus?: RecoveryRunStatus;
}

export interface RecoveryConsoleReport {
  totalRuns: number;
  attentionCount: number;
  statusCounts: Partial<Record<RecoveryRunStatus, number>>;
  phaseCounts: Partial<Record<RecoveryRunProgress["phase"], number>>;
  gateCounts: Record<string, number>;
  nextActionCounts: Partial<Record<RecoveryRun["nextAction"], number>>;
  browserResumeCounts: Partial<Record<BrowserResumeMode, number>>;
  browserOutcomeCounts: Partial<Record<RecoveryBrowserOutcome, number>>;
  attentionRuns: Array<{
    recoveryRunId: string;
    sourceGroupId: string;
    status: RecoveryRunStatus;
    caseState: OperatorCaseState;
    phase: RecoveryRunProgress["phase"];
    gate: string;
    nextAction: RecoveryRun["nextAction"];
    allowedActions: RecoveryRunAction[];
    summary: string;
    updatedAt: number;
    waitingReason?: string;
    currentAttemptId?: string;
    browserResumeMode?: BrowserResumeMode;
    browserOutcome?: RecoveryBrowserOutcome;
    browserOutcomeSummary?: string;
    targetLayer?: ReplayLayer;
    targetWorker?: WorkerKind;
  }>;
  latestRuns: RecoveryRun[];
}

export interface RecoveryRunStore {
  get(recoveryRunId: string): Promise<RecoveryRun | null>;
  put(run: RecoveryRun, options?: { expectedVersion?: number | undefined }): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RecoveryRun[]>;
  listAll?(): Promise<RecoveryRun[]>;
}

export interface RecoveryRunEventStore {
  append(event: RecoveryRunEvent): Promise<void>;
  listByRecoveryRun(recoveryRunId: string): Promise<RecoveryRunEvent[]>;
}

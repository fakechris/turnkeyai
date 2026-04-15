import type {
  ContinuityMode,
  FlowId,
  RuntimeError,
  RoleActivationInput,
  RoleId,
  RunKey,
  SpawnedWorker,
  TaskId,
  TeamMessage,
  ThreadId,
  WorkerKind,
} from "./team-core";
import type {
  BrowserPageResult,
  BrowserSession,
  BrowserSessionHistoryEntry,
  BrowserSessionOwnerType,
  BrowserSessionResumeInput,
  BrowserSessionSendInput,
  BrowserSessionSpawnInput,
  BrowserTarget,
  BrowserTaskRequest,
  BrowserTaskResult,
} from "./browser";
import type { RolePromptPacketLike } from "./team-orchestration";
import type {
  ApiDiagnosisReport,
  EvidenceTrustAssessment,
  PermissionCacheRecord,
  PermissionEvaluation,
  PromptAdmissionDecision,
  TransportExecutionAudit,
} from "./team-governance";
import type { WorkerStartupReconcileResult } from "./team-startup-reconcile";

export interface PermissionGovernancePolicy {
  evaluate(input: {
    now?: number;
    threadId: ThreadId;
    workerType: WorkerKind;
    payload: Record<string, unknown>;
    apiDiagnosis: ApiDiagnosisReport[];
    transportAudit?: TransportExecutionAudit | null;
    cachedDecision?: PermissionCacheRecord | null;
  }): PermissionEvaluation;
}

export interface EvidenceTrustPolicy {
  assess(input: {
    workerType: WorkerKind;
    workerStatus: WorkerExecutionResult["status"];
    payload: Record<string, unknown>;
    apiDiagnosis: ApiDiagnosisReport[];
    permission: PermissionEvaluation;
    transportAudit?: TransportExecutionAudit | null;
  }): EvidenceTrustAssessment;
}

export interface PromptAdmissionPolicy {
  decide(input: {
    workerType: WorkerKind;
    workerStatus: WorkerExecutionResult["status"];
    summary: string;
    payload: Record<string, unknown>;
    trust: EvidenceTrustAssessment;
    permission: PermissionEvaluation;
    apiDiagnosis: ApiDiagnosisReport[];
  }): PromptAdmissionDecision;
}

export interface WorkerInvocationInput {
  activation: RoleActivationInput;
  packet: RolePromptPacketLike;
  sessionState?: WorkerSessionState;
}

export interface WorkerHandler {
  kind: WorkerKind;
  canHandle(input: WorkerInvocationInput): boolean | Promise<boolean>;
  run(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null>;
}

export interface WorkerRegistry {
  selectHandler(input: WorkerInvocationInput): Promise<WorkerHandler | null>;
  getHandler?(kind: WorkerKind): WorkerHandler | null | Promise<WorkerHandler | null>;
}

export interface WorkerExecutionResult {
  workerType: WorkerKind;
  status: "completed" | "partial" | "failed";
  summary: string;
  payload: unknown;
}

export interface WorkerSessionState {
  workerRunKey: RunKey;
  workerType: WorkerKind;
  status: "idle" | "running" | "waiting_input" | "waiting_external" | "resumable" | "done" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  currentTaskId?: TaskId;
  lastResult?: WorkerExecutionResult;
  lastError?: RuntimeError;
  continuationDigest?: {
    reason: "follow_up" | "timeout_summary" | "user_resume" | "supervisor_retry";
    summary: string;
    createdAt: number;
  };
}

export interface WorkerContinuationOutcome {
  state: "resumed_existing" | "cold_recreated" | "spawned_fresh";
  requestedMode?: ContinuityMode | null;
  requestedWorkerType?: WorkerKind;
  requestedWorkerRunKey?: RunKey;
  resolvedWorkerType?: WorkerKind;
  resolvedWorkerRunKey?: RunKey;
  reason?:
    | "fresh_requested"
    | "no_bound_session"
    | "session_missing"
    | "session_terminal"
    | "capability_unavailable"
    | "reuse_disallowed";
  summary: string;
}

export const WORKER_CONTINUATION_REASONS = [
  "fresh_requested",
  "no_bound_session",
  "session_missing",
  "session_terminal",
  "capability_unavailable",
  "reuse_disallowed",
] as const;

export interface WorkerSessionContextRecord {
  threadId: ThreadId;
  flowId: FlowId;
  taskId: TaskId;
  roleId: RoleId;
  parentSpanId: string;
}

export interface WorkerSessionRecord {
  workerRunKey: RunKey;
  state: WorkerSessionState;
  executionToken: number;
  context?: WorkerSessionContextRecord;
}

export interface WorkerMessageInput {
  workerRunKey: RunKey;
  activation: RoleActivationInput;
  packet: RolePromptPacketLike;
}

export interface WorkerResumeInput {
  workerRunKey: RunKey;
  activation: RoleActivationInput;
  packet: RolePromptPacketLike;
}

export interface WorkerInterruptInput {
  workerRunKey: RunKey;
  reason?: string;
}

export interface WorkerCancelInput {
  workerRunKey: RunKey;
  reason?: string;
}

export interface RoleRuntimeResult {
  status: "ok" | "failed" | "delegated";
  message?: TeamMessage;
  mentions?: RoleId[];
  spawnedWorkers?: SpawnedWorker[];
  workerBindings?: Array<{ workerType: WorkerKind; workerRunKey: RunKey }>;
  error?: RuntimeError;
}

export interface RoleRuntime {
  runActivation(input: RoleActivationInput): Promise<RoleRuntimeResult>;
}

export interface BrowserSessionRuntime {
  spawnSession(input: BrowserSessionSpawnInput): Promise<BrowserTaskResult>;
  sendSession(input: BrowserSessionSendInput): Promise<BrowserTaskResult>;
  resumeSession(input: BrowserSessionResumeInput): Promise<BrowserTaskResult>;
  getSessionHistory(input: { browserSessionId: string; limit?: number }): Promise<BrowserSessionHistoryEntry[]>;
}

export interface BrowserBridge extends BrowserSessionRuntime {
  inspectPublicPage(url: string): Promise<BrowserPageResult>;
  runTask(input: BrowserTaskRequest): Promise<BrowserTaskResult>;
  listSessions(input?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }): Promise<BrowserSession[]>;
  listTargets(browserSessionId: string): Promise<BrowserTarget[]>;
  openTarget(
    browserSessionId: string,
    url: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<BrowserTarget>;
  activateTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<BrowserTarget>;
  closeTarget(
    browserSessionId: string,
    targetId: string,
    owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
  ): Promise<BrowserTarget>;
  evictIdleSessions(input: { idleBefore: number; reason?: string }): Promise<BrowserSession[]>;
  closeSession(browserSessionId: string, reason?: string): Promise<void>;
}

export interface WorkerRuntime {
  spawn(input: WorkerInvocationInput): Promise<SpawnedWorker | null>;
  send(input: WorkerMessageInput): Promise<WorkerExecutionResult | null>;
  resume(input: WorkerResumeInput): Promise<WorkerExecutionResult | null>;
  interrupt(input: WorkerInterruptInput): Promise<WorkerSessionState | null>;
  cancel(input: WorkerCancelInput): Promise<WorkerSessionState | null>;
  getState(workerRunKey: RunKey): Promise<WorkerSessionState | null>;
  maybeRunForRole(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null>;
  reconcileStartup?(): Promise<WorkerStartupReconcileResult>;
  listSessions?(): Promise<WorkerSessionRecord[]>;
}

export interface WorkerSessionStore {
  get(workerRunKey: RunKey): Promise<WorkerSessionRecord | null>;
  put(record: WorkerSessionRecord): Promise<void>;
  list(limit?: number): Promise<WorkerSessionRecord[]>;
}

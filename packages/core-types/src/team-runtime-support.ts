import type {
  ActivationType,
  ContinuityMode,
  FlowId,
  DispatchMode,
  RuntimeError,
  RoleActivationInput,
  RoleId,
  RoleRunState,
  RunKey,
  RuntimeProgressStore,
  SpawnedWorker,
  TaskId,
  TeamMessage,
  ThreadId,
  WorkerKind,
} from "./team-core";
import type {
  DispatchConstraints,
  DispatchContinuity,
  DispatchContinuationContext,
  DispatchCoordination,
  DispatchPolicy,
} from "./team-dispatch";
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
  ApiExecutionAttempt,
  AuthAndScopeDiagnosisPolicy,
  CapabilityDiscoveryService,
  EvidenceSourceType,
  EvidenceTrustAssessment,
  EvidenceTrustLevel,
  PermissionCacheRecord,
  PermissionCacheStore,
  PermissionEvaluation,
  PromptAdmissionDecision,
  PromptAdmissionMode,
  TransportExecutionAudit,
  TransportKind,
  ApiExecutionVerifier,
} from "./team-governance";
import type { ValidationOpsRunRecord } from "./team-validation-ops";
import type { WorkerStartupReconcileResult } from "./team-startup-reconcile";

export interface ThreadSummaryRecord {
  threadId: string;
  summaryVersion: number;
  updatedAt: number;
  sourceMessageCount: number;
  userGoal: string;
  stableFacts: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface RoleScratchpadRecord {
  threadId: string;
  roleId: string;
  updatedAt: number;
  sourceMessageCount: number;
  completedWork: string[];
  pendingWork: string[];
  waitingOn?: string;
  evidenceRefs: string[];
}

export interface WorkerEvidenceDigest {
  workerRunKey: string;
  threadId: string;
  workerType: string;
  status: "completed" | "partial" | "failed";
  updatedAt: number;
  findings: string[];
  artifactIds: string[];
  findingCharCount?: number;
  artifactCount?: number;
  truncated?: boolean;
  referenceOnly?: boolean;
  microcompactSummary?: string;
  sourceType?: EvidenceSourceType;
  trustLevel?: EvidenceTrustLevel;
  admissionMode?: PromptAdmissionMode;
  admissionReason?: string;
  traceDigest?: {
    totalSteps: number;
    toolChain: string[];
    lastStep?: string;
    prunedStepCount?: number;
  };
}

export interface ThreadMemoryRecord {
  threadId: string;
  updatedAt: number;
  preferences: string[];
  constraints: string[];
  longTermNotes: string[];
}

export interface ThreadSessionMemoryRecord {
  threadId: string;
  memoryVersion?: number;
  sourceMessageCount?: number;
  sectionFingerprint?: string;
  updatedAt: number;
  activeTasks: string[];
  openQuestions: string[];
  recentDecisions: string[];
  constraints: string[];
  continuityNotes: string[];
  latestJournalEntries: string[];
}

export interface SessionMemoryRefreshJobRecord {
  threadId: string;
  enqueuedAt: number;
  notBeforeAt: number;
  attemptCount: number;
  roleScratchpad?: {
    completedWork: string[];
    pendingWork: string[];
    waitingOn?: string;
  } | null;
  lastError?: string;
}

export interface ThreadJournalRecord {
  threadId: string;
  dateKey: string;
  updatedAt: number;
  entries: string[];
}

export interface ThreadSummaryStore {
  get(threadId: string): Promise<ThreadSummaryRecord | null>;
  put(record: ThreadSummaryRecord): Promise<void>;
}

export interface RoleScratchpadStore {
  get(threadId: string, roleId: string): Promise<RoleScratchpadRecord | null>;
  put(record: RoleScratchpadRecord): Promise<void>;
}

export interface WorkerEvidenceDigestStore {
  get(workerRunKey: string): Promise<WorkerEvidenceDigest | null>;
  put(record: WorkerEvidenceDigest): Promise<void>;
  listByThread(threadId: string): Promise<WorkerEvidenceDigest[]>;
}

export interface ThreadMemoryStore {
  get(threadId: string): Promise<ThreadMemoryRecord | null>;
  put(record: ThreadMemoryRecord): Promise<void>;
}

export interface ThreadSessionMemoryStore {
  get(threadId: string): Promise<ThreadSessionMemoryRecord | null>;
  put(record: ThreadSessionMemoryRecord): Promise<void>;
}

export interface SessionMemoryRefreshJobStore {
  get(threadId: string): Promise<SessionMemoryRefreshJobRecord | null>;
  put(record: SessionMemoryRefreshJobRecord): Promise<void>;
  delete(threadId: string): Promise<void>;
  list(limit?: number): Promise<SessionMemoryRefreshJobRecord[]>;
}

export interface ThreadJournalStore {
  get(threadId: string, dateKey: string): Promise<ThreadJournalRecord | null>;
  put(record: ThreadJournalRecord): Promise<void>;
  listByThread(threadId: string, limit?: number): Promise<ThreadJournalRecord[]>;
}

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

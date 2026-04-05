import type {
  ActivationType,
  ContinuityMode,
  DispatchConstraints,
  DispatchContinuity,
  DispatchContinuationContext,
  DispatchCoordination,
  DispatchMode,
  DispatchPolicy,
  DispatchRecoveryContext,
  FlowId,
  FlowLedger,
  MessageId,
  RoleActivationInput,
  RoleId,
  RoleRunState,
  RunKey,
  RuntimeError,
  RuntimeProgressStore,
  SessionTarget,
  SpawnedWorker,
  TaskId,
  TeamId,
  TeamMessage,
  TeamMessageSummary,
  TeamThread,
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
import type { ValidationOpsRunRecord } from "./team-replay-recovery";

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

export interface PermissionCacheRecord {
  cacheKey: string;
  threadId: ThreadId;
  workerType: WorkerKind;
  requirement: PermissionRequirement;
  decision: PermissionDecision;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  denialReason?: string;
}

export interface PermissionCacheStore {
  get(cacheKey: string): Promise<PermissionCacheRecord | null>;
  put(record: PermissionCacheRecord): Promise<void>;
  listByThread(threadId: ThreadId): Promise<PermissionCacheRecord[]>;
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

export type TransportKind = "official_api" | "business_tool" | "browser";
export type EvidenceTrustLevel = "promotable" | "observational";
export type EvidenceSourceType = "browser" | "api" | "tool";
export type PromptAdmissionMode = "full" | "summary_only" | "blocked";
export type PermissionRequirementLevel = "none" | "confirm" | "approval";
export type PermissionScope = "read" | "navigate" | "mutate" | "publish" | "credential";
export type PermissionDecision = "granted" | "denied" | "prompt_required";

export interface PermissionRequirement {
  level: PermissionRequirementLevel;
  scope: PermissionScope;
  rationale: string;
  cacheKey: string;
}

export interface PermissionEvaluation {
  requirement: PermissionRequirement;
  decision: PermissionDecision;
  source: "policy" | "cache";
  denialReason?: string;
  recommendedAction?: "proceed" | "retry_same_transport" | "fallback_browser" | "request_approval" | "abort";
  fallbackTransport?: TransportKind;
}

export interface EvidenceTrustAssessment {
  sourceType: EvidenceSourceType;
  trustLevel: EvidenceTrustLevel;
  rationale: string[];
  verified: boolean;
  downgraded: boolean;
}

export interface PromptAdmissionDecision {
  mode: PromptAdmissionMode;
  trustLevel: EvidenceTrustLevel;
  reason: string;
}

export interface TransportExecutionAudit {
  capability: string;
  preferredOrder: TransportKind[];
  attemptedTransports: TransportKind[];
  finalTransport?: TransportKind;
  downgraded: boolean;
  fallbackReason?: string;
  trustLevel: EvidenceTrustLevel;
}

export interface CapabilityInspectionInput {
  threadId: ThreadId;
  roleId: RoleId;
  requestedCapabilities: string[];
  preferredWorkerKinds?: WorkerKind[];
}

export interface ConnectorCapabilityState {
  provider: string;
  available: boolean;
  authorized: boolean;
  issues?: string[];
  suggestedActions?: string[];
}

export interface ApiCapabilityState {
  name: string;
  configured: boolean;
  ready: boolean;
  issues?: string[];
  suggestedActions?: string[];
}

export interface SkillCapabilityState {
  skillId: string;
  installed: boolean;
}

export interface TransportPreference {
  capability: string;
  orderedTransports: TransportKind[];
}

export interface CapabilityInspectionResult {
  availableWorkers: WorkerKind[];
  connectorStates: ConnectorCapabilityState[];
  apiStates: ApiCapabilityState[];
  skillStates: SkillCapabilityState[];
  transportPreferences: TransportPreference[];
  unavailableCapabilities: string[];
  generatedAt: number;
}

export interface CapabilityDiscoveryService {
  inspect(input: CapabilityInspectionInput): Promise<CapabilityInspectionResult>;
}

export interface ScheduledPromptCapsule {
  title: string;
  instructions: string;
  artifactRefs?: string[];
  dependencyRefs?: string[];
  expectedOutput?: string;
}

export interface ScheduledTaskRecord {
  taskId: TaskId;
  threadId: ThreadId;
  dispatch?: {
    targetRoleId: RoleId;
    targetWorker?: WorkerKind;
    sessionTarget: SessionTarget;
    continuity?: DispatchContinuity;
    constraints?: Pick<DispatchConstraints, "preferredWorkerKinds">;
  };
  targetRoleId?: RoleId;
  targetWorker?: WorkerKind;
  sessionTarget?: SessionTarget;
  recoveryContext?: DispatchRecoveryContext;
  schedule: {
    kind: "cron";
    expr: string;
    tz: string;
    nextRunAt: number;
  };
  capsule: ScheduledPromptCapsule;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskScheduleSpec {
  kind: "cron";
  expr: string;
  tz: string;
}

export interface ScheduleTaskInput {
  threadId: ThreadId;
  targetRoleId: RoleId;
  capsule: ScheduledPromptCapsule;
  schedule: ScheduledTaskScheduleSpec;
  sessionTarget?: SessionTarget;
  targetWorker?: WorkerKind;
  continuity?: DispatchContinuity;
  preferredWorkerKinds?: WorkerKind[];
}

export interface ScheduledTaskStore {
  get(taskId: TaskId): Promise<ScheduledTaskRecord | null>;
  put(task: ScheduledTaskRecord): Promise<void>;
  listByThread(threadId: ThreadId): Promise<ScheduledTaskRecord[]>;
  listDue(now: number): Promise<ScheduledTaskRecord[]>;
  claimDue(taskId: TaskId, expectedUpdatedAt: number, leaseUntil: number): Promise<ScheduledTaskRecord | null>;
}

export interface TriggeredScheduledTask {
  task: ScheduledTaskRecord;
  dispatchedAt: number;
}

export interface ScheduledTaskRuntime {
  schedule(input: ScheduleTaskInput): Promise<ScheduledTaskRecord>;
  listByThread(threadId: ThreadId): Promise<ScheduledTaskRecord[]>;
  triggerDue(now?: number): Promise<TriggeredScheduledTask[]>;
}

export interface ApiExecutionAttempt {
  apiName: string;
  operation: string;
  transport: Exclude<TransportKind, "browser">;
  statusCode?: number;
  errorMessage?: string;
  responseBody?: unknown;
  credentialState?: "missing" | "present" | "invalid";
  requiredScopes?: string[];
  grantedScopes?: string[];
  schemaErrors?: string[];
  businessErrors?: string[];
}

export type ApiDiagnosisCategory =
  | "ok"
  | "credential"
  | "scope"
  | "schema"
  | "business"
  | "network"
  | "unknown";

export interface ApiDiagnosisReport {
  ok: boolean;
  category: ApiDiagnosisCategory;
  retryable: boolean;
  issues: string[];
  suggestedActions: string[];
}

export interface AuthAndScopeDiagnosisPolicy {
  diagnose(input: ApiExecutionAttempt): ApiDiagnosisReport | null;
}

export interface ApiExecutionVerifier {
  verify(input: ApiExecutionAttempt): ApiDiagnosisReport;
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

export interface WorkerStartupReconcileResult {
  totalSessions: number;
  downgradedRunningSessions: number;
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

export interface SupervisorUserMessageInput {
  thread: TeamThread;
  flow: FlowLedger;
  message: TeamMessage;
}

export interface SupervisorRoleReplyInput {
  thread: TeamThread;
  flow: FlowLedger;
  message: TeamMessage;
  mentions: RoleId[];
}

export interface SupervisorRoleFailureInput {
  thread: TeamThread;
  flow: FlowLedger;
  failedRoleId: RoleId;
  error: RuntimeError;
}

export type RetryStrategy = "same_model" | "other_model" | "same_worker" | "other_worker";

export type RecoveryDecision =
  | { action: "dispatch"; targetRoleIds: RoleId[] }
  | { action: "retry"; targetRoleId: RoleId; strategy: RetryStrategy }
  | { action: "fallback_to_lead"; leadRoleId: RoleId }
  | { action: "complete" }
  | { action: "abort"; reason: string };

export interface RecoveryDirector {
  onUserMessage(input: SupervisorUserMessageInput): Promise<RecoveryDecision>;
  onRoleReply(input: SupervisorRoleReplyInput): Promise<RecoveryDecision>;
  onRoleFailure(input: SupervisorRoleFailureInput): Promise<RecoveryDecision>;
}

export interface SummaryBuilder {
  getRecentMessages(threadId: ThreadId, limit?: number): Promise<TeamMessageSummary[]>;
}

export interface RelayBriefBuilder {
  build(input: {
    thread: TeamThread;
    sourceMessage: TeamMessage;
    targetRoleId: RoleId;
    instructions?: string;
    recentMessages?: TeamMessageSummary[];
    flow?: FlowLedger;
  }): string;
}

export interface RolePromptPacketLike {
  roleId: RoleId;
  roleName: string;
  systemPrompt: string;
  taskPrompt: string;
  outputContract: string;
  suggestedMentions: RoleId[];
  preferredWorkerKinds?: WorkerKind[];
  resumeTarget?: SessionTarget;
  continuityMode?: ContinuityMode;
  continuationContext?: DispatchContinuationContext;
  mergeContext?: DispatchCoordination["merge"];
  parallelContext?: DispatchCoordination["parallel"];
  capabilityInspection?: CapabilityInspectionResult;
}

export interface RoleLoopRunner {
  ensureRunning(runKey: RunKey): Promise<void>;
}

export interface RuntimeLimits {
  memberMaxIterations: number;
  flowMaxHops: number;
  maxQueuedHandoffsPerRole: number;
  maxPerRoleHopCount: number;
}

export interface IdGenerator {
  teamId(): TeamId;
  threadId(): ThreadId;
  flowId(): FlowId;
  messageId(): MessageId;
  taskId(): TaskId;
}

export interface Clock {
  now(): number;
}

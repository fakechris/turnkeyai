import type { BrowserOwnerType, BrowserResumeMode } from "./browser";
import type { OperatorCaseState, ReplayRecoveryPlan } from "./team-replay-recovery";

export type ThreadId = string;
export type TeamId = string;
export type RoleId = string;
export type FlowId = string;
export type RunKey = string;
export type MessageId = string;
export type TaskId = string;

export type TeamMessageRole = "user" | "assistant" | "tool" | "system";
export type DispatchMode = "serial" | "parallel" | "mixed";
export type ActivationType = "mention" | "cascade" | "retry" | "fallback";
export type ContinuityMode = "fresh" | "prefer-existing" | "resume-existing";
export type SessionTarget = "main" | "worker";

export interface TeamMessage {
  id: MessageId;
  threadId: ThreadId;
  role: TeamMessageRole;
  roleId?: RoleId;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  source?: MessageSource;
  metadata?: Record<string, unknown>;
}

export interface MessageSource {
  type: "desktop" | "api" | "worker";
  chatType: "group" | "dm";
  route:
    | "user"
    | "lead-role"
    | "external-participant"
    | "member-worker"
    | "worker";
  speakerType?: "User" | "Role" | "Tool";
  speakerName?: string;
}

export interface TeamThread {
  threadId: ThreadId;
  teamId: TeamId;
  teamName: string;
  leadRoleId: RoleId;
  roles: RoleSlot[];
  participantLinks: ParticipantLink[];
  metadataVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoleSlot {
  roleId: RoleId;
  name: string;
  seat: "lead" | "member";
  avatar?: string;
  runtime: "local" | "remote";
  model?: ModelRef;
  modelRef?: string;
  modelChain?: string;
  status?: "online" | "offline" | "busy";
  capabilities?: string[];
}

export interface ModelRef {
  provider: string;
  name: string;
}

export interface ParticipantLink {
  channelId: string;
  userId: string;
  chatId?: string;
  displayName?: string;
  dmThreadId?: string;
  enabled: boolean;
}

export interface FlowLedger {
  flowId: FlowId;
  threadId: ThreadId;
  rootMessageId: MessageId;
  mode: DispatchMode;
  status: FlowStatus;
  currentStageIndex: number;
  activeRoleIds: RoleId[];
  completedRoleIds: RoleId[];
  failedRoleIds: RoleId[];
  nextExpectedRoleId?: RoleId;
  hopCount: number;
  maxHops: number;
  edges: HandoffEdge[];
  shardGroups?: ShardGroupRecord[];
  createdAt: number;
  updatedAt: number;
}

export type RuntimeChainRootKind = "flow" | "task" | "recovery";
export type RuntimeChainSubjectKind =
  | "flow"
  | "dispatch"
  | "role_run"
  | "worker_run"
  | "browser_session"
  | "replay_group"
  | "recovery_run";
export type RuntimeChainPhase =
  | "started"
  | "heartbeat"
  | "waiting"
  | "completed"
  | "failed"
  | "degraded"
  | "cancelled";
export type RuntimeChainCanonicalState =
  | "open"
  | "heartbeat"
  | "waiting"
  | "degraded"
  | "failed"
  | "resolved";
export type RuntimeContinuityState =
  | "alive"
  | "waiting"
  | "reconnecting"
  | "transient_failure"
  | "terminal"
  | "resolved";
export type RuntimeHeartbeatSource =
  | "phase_transition"
  | "activity_echo"
  | "control_path"
  | "reconnect_window"
  | "long_running_tick"
  | "background_refresh";
export type RuntimeCloseKind =
  | "completed"
  | "cancelled"
  | "timeout"
  | "worker_failed"
  | "session_not_found"
  | "detached_target"
  | "lease_conflict"
  | "owner_mismatch"
  | "transport_failure"
  | "unknown";
export type RuntimeProgressKind = "transition" | "heartbeat" | "boundary";

export interface RuntimeChain {
  chainId: string;
  threadId: ThreadId;
  rootKind: RuntimeChainRootKind;
  rootId: string;
  flowId?: FlowId;
  taskId?: TaskId;
  roleId?: RoleId;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeChainSpan {
  spanId: string;
  chainId: string;
  parentSpanId?: string;
  subjectKind: RuntimeChainSubjectKind;
  subjectId: string;
  threadId: ThreadId;
  flowId?: FlowId;
  taskId?: TaskId;
  roleId?: RoleId;
  workerType?: WorkerKind;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeChainEvent {
  eventId: string;
  chainId: string;
  spanId: string;
  parentSpanId?: string;
  threadId: ThreadId;
  subjectKind: RuntimeChainSubjectKind;
  subjectId: string;
  phase: RuntimeChainPhase;
  recordedAt: number;
  summary: string;
  statusReason?: string;
  artifacts?: {
    replayId?: string;
    recoveryRunId?: string;
    browserSessionId?: string;
    browserTargetId?: string;
    dispatchTaskId?: TaskId;
  };
  metadata?: Record<string, unknown>;
}

export interface RuntimeChainStatus {
  chainId: string;
  threadId: ThreadId;
  activeSpanId?: string;
  activeSubjectKind?: RuntimeChainSubjectKind;
  activeSubjectId?: string;
  phase: RuntimeChainPhase | "resolved";
  canonicalState?: RuntimeChainCanonicalState;
  continuityState?: RuntimeContinuityState;
  continuityReason?: string;
  responseTimeoutAt?: number;
  reconnectWindowUntil?: number;
  closeKind?: RuntimeCloseKind;
  waitingReason?: string;
  stale?: boolean;
  staleReason?: string;
  latestSummary: string;
  lastHeartbeatAt?: number;
  lastCompletedSpanId?: string;
  lastFailedSpanId?: string;
  latestChildSpanId?: string;
  currentWaitingSpanId?: string;
  currentWaitingPoint?: string;
  attention: boolean;
  caseKey?: string;
  caseState?: OperatorCaseState;
  severity?: "warning" | "critical";
  headline?: string;
  nextStep?: string;
  updatedAt: number;
}

export interface RuntimeSummaryEntry {
  chainId: string;
  threadId: ThreadId;
  rootKind: RuntimeChainRootKind;
  rootId: string;
  phase: RuntimeChainStatus["phase"];
  canonicalState: RuntimeChainCanonicalState;
  continuityState?: RuntimeContinuityState;
  attention: boolean;
  updatedAt: number;
  stale?: boolean;
  staleReason?: string;
  activeSubjectKind?: RuntimeChainSubjectKind;
  activeSubjectId?: string;
  waitingReason?: string;
  currentWaitingPoint?: string;
  latestChildSpanId?: string;
  lastCompletedSpanId?: string;
  lastFailedSpanId?: string;
  caseKey?: string;
  caseState?: OperatorCaseState;
  headline?: string;
  nextStep?: string;
}

export interface RuntimeSummaryReport {
  totalChains: number;
  activeCount: number;
  waitingCount: number;
  failedCount: number;
  resolvedCount: number;
  staleCount: number;
  attentionCount: number;
  stateCounts: Partial<Record<RuntimeChainCanonicalState, number>>;
  continuityCounts: Partial<Record<RuntimeContinuityState, number>>;
  caseStateCounts: Partial<Record<OperatorCaseState, number>>;
  attentionChains: RuntimeSummaryEntry[];
  activeChains: RuntimeSummaryEntry[];
  waitingChains: RuntimeSummaryEntry[];
  staleChains: RuntimeSummaryEntry[];
  failedChains: RuntimeSummaryEntry[];
  recentlyResolved: RuntimeSummaryEntry[];
  workerStartupReconcile?: {
    totalSessions: number;
    downgradedRunningSessions: number;
  };
  workerSessionHealth?: {
    totalSessions: number;
    activeSessions: number;
    orphanedSessions: number;
    missingContextSessions: number;
  };
  workerBindingReconcile?: {
    totalRoleRuns: number;
    totalBindings: number;
    clearedMissingBindings: number;
    clearedTerminalBindings: number;
    clearedCrossThreadBindings: number;
    roleRunsNeedingAttention: number;
    roleRunsRequeued: number;
    roleRunsFailed: number;
  };
  roleRunStartupRecovery?: {
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
  };
  flowRecoveryStartupReconcile?: {
    orphanedFlows: number;
    abortedOrphanedFlows: number;
    orphanedRecoveryRuns: number;
    missingFlowRecoveryRuns: number;
    crossThreadFlowRecoveryRuns: number;
    failedRecoveryRuns: number;
    affectedFlowIds: RunKey[];
    affectedRecoveryRunIds: RunKey[];
  };
  runtimeChainStartupReconcile?: {
    orphanedThreadChains: number;
    missingFlowChains: number;
    crossThreadFlowChains: number;
    affectedChainIds: RunKey[];
  };
  runtimeChainArtifactStartupReconcile?: {
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
  };
}

export interface RuntimeProgressEvent {
  progressId: string;
  threadId: ThreadId;
  chainId?: string;
  spanId?: string;
  parentSpanId?: string;
  subjectKind: RuntimeChainSubjectKind;
  subjectId: string;
  phase: RuntimeChainPhase;
  progressKind?: RuntimeProgressKind;
  heartbeatSource?: RuntimeHeartbeatSource;
  continuityState?: RuntimeContinuityState;
  responseTimeoutAt?: number;
  reconnectWindowUntil?: number;
  closeKind?: RuntimeCloseKind;
  statusReason?: string;
  summary: string;
  recordedAt: number;
  flowId?: FlowId;
  taskId?: TaskId;
  roleId?: RoleId;
  workerType?: WorkerKind;
  artifacts?: {
    replayId?: string;
    recoveryRunId?: string;
    browserSessionId?: string;
    browserTargetId?: string;
    dispatchTaskId?: TaskId;
  };
  metadata?: Record<string, unknown>;
}

export interface RuntimeProgressStore {
  append(event: RuntimeProgressEvent): Promise<void>;
  listByThread(threadId: ThreadId, limit?: number): Promise<RuntimeProgressEvent[]>;
  listByChain(chainId: string, limit?: number): Promise<RuntimeProgressEvent[]>;
}

export type FlowStatus =
  | "created"
  | "running"
  | "waiting_role"
  | "waiting_worker"
  | "completed"
  | "failed"
  | "aborted";

export interface HandoffEdge {
  edgeId: string;
  flowId: FlowId;
  fromRoleId?: RoleId;
  toRoleId: RoleId;
  sourceMessageId: MessageId;
  fanOutGroupId?: string;
  state: HandoffState;
  createdAt: number;
  respondedAt?: number;
  closedAt?: number;
}

export type HandoffState =
  | "created"
  | "delivered"
  | "acked"
  | "responded"
  | "closed"
  | "timeout"
  | "cancelled";

export interface RoleRunState {
  runKey: RunKey;
  threadId: ThreadId;
  roleId: RoleId;
  mode: "group";
  status: RoleRunStatus;
  iterationCount: number;
  maxIterations: number;
  inbox: HandoffEnvelope[];
  lastDequeuedTaskId?: TaskId;
  lastActiveAt: number;
  lastUserTouchAt?: number;
  workerSessions?: Partial<Record<WorkerKind, RunKey>>;
}

export type RoleRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_worker"
  | "resuming"
  | "done"
  | "failed";

export interface HandoffEnvelope {
  taskId: TaskId;
  flowId: FlowId;
  sourceMessageId: MessageId;
  sourceRoleId?: RoleId;
  targetRoleId: RoleId;
  activationType: ActivationType;
  threadId: ThreadId;
  payload: RelayPayload;
  createdAt: number;
}

export interface DispatchIntent {
  relayBrief: string;
  recentMessages: TeamMessageSummary[];
  instructions?: string;
}

export interface DispatchRecoveryContext {
  parentGroupId: string;
  action: ReplayRecoveryPlan["nextAction"];
  dispatchReplayId?: string;
  recoveryRunId?: string;
  attemptId?: string;
}

export interface BrowserContinuationHint {
  sessionId: string;
  targetId?: string;
  resumeMode?: BrowserResumeMode;
  ownerType?: BrowserOwnerType;
  ownerId?: string;
  leaseHolderRunKey?: RunKey;
}

export interface DispatchContinuationContext {
  source: "scheduled_reentry" | "timeout_summary" | "follow_up" | "recovery_dispatch";
  workerType?: WorkerKind;
  workerRunKey?: RunKey;
  summary?: string;
  recovery?: DispatchRecoveryContext;
  browserSession?: BrowserContinuationHint;
}

export interface DispatchContinuity {
  mode?: ContinuityMode;
  context?: DispatchContinuationContext;
}

export interface DispatchCoordination {
  merge?: FanOutMergeContext;
  parallel?: ParallelOrchestrationContext;
}

export interface DispatchConstraints {
  dispatchPolicy: DispatchPolicy;
  preferredWorkerKinds?: WorkerKind[];
}

export interface RelayPayload {
  threadId: ThreadId;
  intent?: DispatchIntent;
  continuity?: DispatchContinuity;
  coordination?: DispatchCoordination;
  constraints?: DispatchConstraints;
  relayBrief?: string;
  recentMessages?: TeamMessageSummary[];
  instructions?: string;
  preferredWorkerKinds?: WorkerKind[];
  sessionTarget?: SessionTarget;
  continuationContext?: DispatchContinuationContext;
  mergeContext?: FanOutMergeContext;
  parallelContext?: ParallelOrchestrationContext;
  dispatchPolicy?: DispatchPolicy;
}

export function normalizeRelayPayload(payload: RelayPayload): RelayPayload {
  const relayBrief = payload.intent?.relayBrief ?? payload.relayBrief ?? "";
  const recentMessages = payload.intent?.recentMessages ?? payload.recentMessages ?? [];
  const instructions = payload.intent?.instructions ?? payload.instructions;
  const preferredWorkerKinds = payload.constraints?.preferredWorkerKinds ?? payload.preferredWorkerKinds ?? [];
  const dispatchPolicy = payload.constraints?.dispatchPolicy ?? payload.dispatchPolicy;
  const continuity =
    payload.continuity ??
    (payload.continuationContext
      ? {
          context: payload.continuationContext,
        }
      : undefined);
  const coordination =
    payload.coordination ??
    (payload.mergeContext || payload.parallelContext
      ? {
          ...(payload.mergeContext ? { merge: payload.mergeContext } : {}),
          ...(payload.parallelContext ? { parallel: payload.parallelContext } : {}),
        }
      : undefined);

  return {
    threadId: payload.threadId,
    intent: {
      relayBrief,
      recentMessages,
      ...(instructions ? { instructions } : {}),
    },
    ...(continuity ? { continuity } : {}),
    ...(coordination ? { coordination } : {}),
    ...(dispatchPolicy
      ? {
          constraints: {
            dispatchPolicy,
            ...(preferredWorkerKinds.length > 0 ? { preferredWorkerKinds } : {}),
          },
        }
      : preferredWorkerKinds.length > 0
        ? {
            preferredWorkerKinds,
          }
        : {}),
    relayBrief,
    recentMessages,
    ...(instructions ? { instructions } : {}),
    ...(preferredWorkerKinds.length > 0 ? { preferredWorkerKinds } : {}),
    ...(payload.sessionTarget ? { sessionTarget: payload.sessionTarget } : {}),
    ...(continuity?.context ? { continuationContext: continuity.context } : {}),
    ...(coordination?.merge ? { mergeContext: coordination.merge } : {}),
    ...(coordination?.parallel ? { parallelContext: coordination.parallel } : {}),
    ...(dispatchPolicy ? { dispatchPolicy } : {}),
  };
}

export function createRelayPayload(input: {
  threadId: ThreadId;
  relayBrief: string;
  recentMessages: TeamMessageSummary[];
  instructions?: string;
  sessionTarget?: SessionTarget;
  continuity?: DispatchContinuity;
  preferredWorkerKinds?: WorkerKind[];
  dispatchPolicy: DispatchPolicy;
  coordination?: DispatchCoordination;
}): RelayPayload {
  return normalizeRelayPayload({
    threadId: input.threadId,
    intent: {
      relayBrief: input.relayBrief,
      recentMessages: input.recentMessages,
      ...(input.instructions ? { instructions: input.instructions } : {}),
    },
    ...(input.continuity ? { continuity: input.continuity } : {}),
    ...(input.coordination ? { coordination: input.coordination } : {}),
    ...(input.sessionTarget ? { sessionTarget: input.sessionTarget } : {}),
    constraints: {
      dispatchPolicy: input.dispatchPolicy,
      ...(input.preferredWorkerKinds?.length ? { preferredWorkerKinds: input.preferredWorkerKinds } : {}),
    },
  });
}

export interface FanOutMergeContext {
  fanOutGroupId: string;
  expectedRoleIds: RoleId[];
  completedRoleIds: RoleId[];
  failedRoleIds: RoleId[];
  cancelledRoleIds: RoleId[];
  missingRoleIds: RoleId[];
  duplicateRoleIds?: RoleId[];
  conflictRoleIds?: RoleId[];
  shardSummaries?: Array<{
    roleId: RoleId;
    status: ShardResultRecord["status"];
    summary: string;
  }>;
  followUpRequired: boolean;
}

export interface ShardGroupRecord {
  groupId: string;
  parentTaskId: TaskId;
  sourceMessageId: MessageId;
  sourceRoleId?: RoleId;
  mergeBackToRoleId: RoleId;
  kind: "research";
  status: "running" | "waiting_retry" | "ready_to_merge" | "merged";
  expectedRoleIds: RoleId[];
  completedRoleIds: RoleId[];
  failedRoleIds: RoleId[];
  cancelledRoleIds: RoleId[];
  retryCounts: Partial<Record<RoleId, number>>;
  shardResults: ShardResultRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface ShardResultRecord {
  roleId: RoleId;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  summaryDigest: string;
  messageId?: MessageId;
  updatedAt: number;
}

export type ParallelOrchestrationContext =
  | ResearchShardPacket
  | MergeSynthesisPacket;

export interface ResearchShardPacket {
  kind: "research_shard";
  fanOutGroupId: string;
  shardRoleId: RoleId;
  shardIndex: number;
  shardCount: number;
  expectedRoleIds: RoleId[];
  mergeBackToRoleId: RoleId;
  shardGoal: string;
}

export interface MergeSynthesisPacket {
  kind: "merge_synthesis";
  fanOutGroupId: string;
  expectedRoleIds: RoleId[];
  completedRoleIds: RoleId[];
  failedRoleIds: RoleId[];
  cancelledRoleIds: RoleId[];
  missingRoleIds: RoleId[];
  duplicateRoleIds: RoleId[];
  conflictRoleIds: RoleId[];
  followUpRequired: boolean;
  shardSummaries: Array<{
    roleId: RoleId;
    status: ShardResultRecord["status"];
    summary: string;
  }>;
}

export interface TeamMessageSummary {
  messageId: MessageId;
  role: TeamMessageRole;
  roleId?: RoleId;
  name: string;
  content: string;
  createdAt: number;
}

export interface DispatchPolicy {
  allowParallel: boolean;
  allowReenter: boolean;
  expectedNextRoleIds?: RoleId[];
  fanOutGroupId?: string;
  coverageTargetRoleIds?: RoleId[];
  mergeBackToRoleId?: RoleId;
  sourceFlowMode: DispatchMode;
}

export type RuntimeErrorCode =
  | "MODEL_OVERLOADED"
  | "MODEL_5XX"
  | "REQUEST_ENVELOPE_OVERFLOW"
  | "WORKER_TIMEOUT"
  | "WORKER_FAILED"
  | "HANDOFF_LOOP"
  | "RUN_ITERATION_LIMIT"
  | "FLOW_HOP_LIMIT"
  | "INVALID_MENTION"
  | "ROLE_MISSING"
  | "TEAM_POLICY_VIOLATION";

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface CreateTeamThreadInput {
  teamName: string;
  leadRoleId: RoleId;
  roles: RoleSlot[];
  participantLinks?: ParticipantLink[];
}

export interface UpdateTeamThreadInput {
  teamName?: string;
  roles?: RoleSlot[];
  participantLinks?: ParticipantLink[];
}

export interface SendTeamMessageInput {
  threadId: ThreadId;
  content: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface HandoffTarget {
  raw: string;
  roleId: RoleId;
  offsetStart: number;
  offsetEnd: number;
}

export interface ValidateMentionInput {
  flow: FlowLedger;
  sourceRoleId?: RoleId;
  messageId: MessageId;
  content: string;
}

export interface DispatchDecision {
  allowed: boolean;
  reason?: string;
  mode: DispatchMode;
  targetRoleIds: RoleId[];
}

export interface BuildHandoffsInput {
  thread: TeamThread;
  flow: FlowLedger;
  sourceMessage: TeamMessage;
  targetRoleIds: RoleId[];
  recentMessages: TeamMessageSummary[];
  activationType: ActivationType;
  now: number;
  fromRoleId?: RoleId;
  instructions?: string;
}

export interface TeamThreadStore {
  get(threadId: ThreadId): Promise<TeamThread | null>;
  list(): Promise<TeamThread[]>;
  create(input: CreateTeamThreadInput): Promise<TeamThread>;
  update(threadId: ThreadId, patch: UpdateTeamThreadInput): Promise<TeamThread>;
  delete(threadId: ThreadId): Promise<void>;
}

export interface TeamMessageStore {
  append(message: TeamMessage): Promise<void>;
  list(threadId: ThreadId, limit?: number): Promise<TeamMessage[]>;
  get(messageId: MessageId): Promise<TeamMessage | null>;
}

export interface RoleRunStore {
  get(runKey: RunKey): Promise<RoleRunState | null>;
  put(runState: RoleRunState): Promise<void>;
  delete(runKey: RunKey): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RoleRunState[]>;
  listAll?(): Promise<RoleRunState[]>;
}

export interface FlowLedgerStore {
  get(flowId: FlowId): Promise<FlowLedger | null>;
  put(flow: FlowLedger): Promise<void>;
  listByThread(threadId: ThreadId): Promise<FlowLedger[]>;
  listAll?(): Promise<FlowLedger[]>;
}

export interface RuntimeChainStore {
  get(chainId: string): Promise<RuntimeChain | null>;
  put(chain: RuntimeChain): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RuntimeChain[]>;
  listAll?(): Promise<RuntimeChain[]>;
}

export interface RuntimeChainSpanStore {
  get(spanId: string): Promise<RuntimeChainSpan | null>;
  put(span: RuntimeChainSpan): Promise<void>;
  listByChain(chainId: string): Promise<RuntimeChainSpan[]>;
  listAll?(): Promise<RuntimeChainSpan[]>;
}

export interface RuntimeChainEventStore {
  append(event: RuntimeChainEvent): Promise<void>;
  listByChain(chainId: string, limit?: number): Promise<RuntimeChainEvent[]>;
  listAll?(): Promise<RuntimeChainEvent[]>;
}

export interface RuntimeChainStatusStore {
  get(chainId: string): Promise<RuntimeChainStatus | null>;
  put(status: RuntimeChainStatus): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RuntimeChainStatus[]>;
  listActive(limit?: number): Promise<RuntimeChainStatus[]>;
  listAll?(): Promise<RuntimeChainStatus[]>;
}

export interface TeamRouteMap {
  findByExternalActor(channelId: string, userId: string): Promise<TeamThread | null>;
  assertParticipantUniqueness(bindings: ParticipantLink[]): Promise<void>;
  attachParticipants(threadId: ThreadId, bindings: ParticipantLink[]): Promise<void>;
  detachParticipants(threadId: ThreadId, bindings: ParticipantLink[]): Promise<void>;
}

export interface TeamEvent {
  eventId: string;
  threadId: ThreadId;
  kind:
    | "thread.created"
    | "thread.updated"
    | "message.posted"
    | "flow.updated"
    | "worker.updated"
    | "runtime.progress"
    | "runtime.state"
    | "audit.logged";
  createdAt: number;
  payload: Record<string, unknown>;
}

export interface TeamEventBus {
  publish(event: TeamEvent): Promise<void>;
  subscribe(listener: (event: TeamEvent) => void | Promise<void>): () => void;
  listRecent(threadId?: ThreadId, limit?: number): Promise<TeamEvent[]>;
}

export interface RoleRunCoordinator {
  getOrCreate(threadId: ThreadId, roleId: RoleId): Promise<RoleRunState>;
  enqueue(runKey: RunKey, handoff: HandoffEnvelope): Promise<RoleRunState>;
  dequeue(runKey: RunKey): Promise<HandoffEnvelope | null>;
  ack(runKey: RunKey, taskId: TaskId): Promise<void>;
  bindWorkerSession(runKey: RunKey, workerType: WorkerKind, workerRunKey: RunKey): Promise<void>;
  clearWorkerSession(runKey: RunKey, workerType: WorkerKind): Promise<void>;
  setStatus(runKey: RunKey, status: RoleRunStatus): Promise<void>;
  incrementIteration(runKey: RunKey): Promise<number>;
  fail(runKey: RunKey, error: RuntimeError): Promise<void>;
  finish(runKey: RunKey): Promise<void>;
}

export interface RuntimeChainRecorder {
  recordFlowCreated(flow: FlowLedger): Promise<void>;
  syncFlowStatus(flow: FlowLedger): Promise<void>;
  recordDispatchEnqueued(input: { flow: FlowLedger; handoff: HandoffEnvelope }): Promise<void>;
}

export interface RuntimeProgressRecorder {
  record(event: RuntimeProgressEvent): Promise<void>;
}

export interface RuntimeStateRecorder {
  record(input: { chain: RuntimeChain; status: RuntimeChainStatus }): Promise<void>;
}

export interface HandoffPlanner {
  parseMentions(content: string): HandoffTarget[];
  validateMentionTargets(thread: TeamThread, input: ValidateMentionInput): Promise<DispatchDecision>;
  buildHandoffs(input: BuildHandoffsInput): Promise<HandoffEnvelope[]>;
}

export interface RoleActivationInput {
  runState: RoleRunState;
  thread: TeamThread;
  flow: FlowLedger;
  handoff: HandoffEnvelope;
}

export interface SpawnedWorker {
  workerType: "browser" | "coder" | "finance" | "explore" | "harness";
  workerRunKey: RunKey;
}

export type WorkerKind = SpawnedWorker["workerType"];

export function buildRunKey(threadId: ThreadId, roleId: RoleId): RunKey {
  return `role:${roleId}:thread:${threadId}`;
}

export function toMessageSummary(message: TeamMessage): TeamMessageSummary {
  const summary: TeamMessageSummary = {
    messageId: message.id,
    role: message.role,
    name: message.name,
    content: message.content,
    createdAt: message.createdAt,
  };

  if (message.roleId) {
    summary.roleId = message.roleId;
  }

  return summary;
}

export function getDispatchPolicy(payload: RelayPayload): DispatchPolicy {
  return payload.constraints?.dispatchPolicy ?? payload.dispatchPolicy!;
}

export function getRelayBrief(payload: RelayPayload): string {
  return payload.intent?.relayBrief ?? payload.relayBrief ?? "";
}

export function getRecentMessages(payload: RelayPayload): TeamMessageSummary[] {
  return payload.intent?.recentMessages ?? payload.recentMessages ?? [];
}

export function getInstructions(payload: RelayPayload): string | undefined {
  return payload.intent?.instructions ?? payload.instructions;
}

export function getPreferredWorkerKinds(payload: RelayPayload): WorkerKind[] {
  return payload.constraints?.preferredWorkerKinds ?? payload.preferredWorkerKinds ?? [];
}

export function getSessionTarget(payload: RelayPayload): SessionTarget | undefined {
  return payload.sessionTarget ?? (payload.continuity?.context?.workerType ? "worker" : undefined);
}

export function getDispatchContinuityMode(payload: RelayPayload): ContinuityMode | undefined {
  return payload.continuity?.mode;
}

export function getContinuationContext(payload: RelayPayload): DispatchContinuationContext | undefined {
  return payload.continuity?.context ?? payload.continuationContext;
}

export function getMergeContext(payload: RelayPayload): DispatchCoordination["merge"] {
  return payload.coordination?.merge ?? payload.mergeContext;
}

export function getParallelContext(payload: RelayPayload): DispatchCoordination["parallel"] {
  return payload.coordination?.parallel ?? payload.parallelContext;
}

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
}

export interface FlowLedgerStore {
  get(flowId: FlowId): Promise<FlowLedger | null>;
  put(flow: FlowLedger): Promise<void>;
  listByThread(threadId: ThreadId): Promise<FlowLedger[]>;
}

export interface RuntimeChainStore {
  get(chainId: string): Promise<RuntimeChain | null>;
  put(chain: RuntimeChain): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RuntimeChain[]>;
}

export interface RuntimeChainSpanStore {
  get(spanId: string): Promise<RuntimeChainSpan | null>;
  put(span: RuntimeChainSpan): Promise<void>;
  listByChain(chainId: string): Promise<RuntimeChainSpan[]>;
}

export interface RuntimeChainEventStore {
  append(event: RuntimeChainEvent): Promise<void>;
  listByChain(chainId: string, limit?: number): Promise<RuntimeChainEvent[]>;
}

export interface RuntimeChainStatusStore {
  get(chainId: string): Promise<RuntimeChainStatus | null>;
  put(status: RuntimeChainStatus): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RuntimeChainStatus[]>;
  listActive(limit?: number): Promise<RuntimeChainStatus[]>;
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

export interface BrowserPageResult {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  textExcerpt: string;
  statusCode: number;
}

export type BrowserActionKind =
  | "open"
  | "snapshot"
  | "type"
  | "click"
  | "scroll"
  | "console"
  | "wait"
  | "screenshot";

export interface BrowserActionTrace {
  stepId: string;
  kind: BrowserActionKind;
  startedAt: number;
  completedAt: number;
  status: "ok" | "failed";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMessage?: string;
}

export interface BrowserInteractiveElement {
  refId: string;
  tagName: string;
  role: string;
  label: string;
  selectors?: string[];
  textAnchors?: string[];
}

export interface BrowserSnapshotResult extends BrowserPageResult {
  interactives: BrowserInteractiveElement[];
}

export type BrowserConsoleProbe = "page-metadata" | "interactive-summary";

export type BrowserClickAction =
  | { kind: "click"; selectors: string[]; refId?: never; text?: never }
  | { kind: "click"; refId: string; selectors?: never; text?: never }
  | { kind: "click"; text: string; selectors?: never; refId?: never };

export type BrowserTaskAction =
  | { kind: "open"; url: string }
  | { kind: "snapshot"; note?: string }
  | { kind: "type"; selectors?: string[]; refId?: string; text: string; submit?: boolean }
  | BrowserClickAction
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "console"; probe: BrowserConsoleProbe }
  | { kind: "wait"; timeoutMs: number }
  | { kind: "screenshot"; label?: string };

export interface BrowserTaskRequest {
  taskId: string;
  threadId: string;
  instructions: string;
  actions: BrowserTaskAction[];
  browserSessionId?: string;
  targetId?: string;
  ownerType?: BrowserOwnerType;
  ownerId?: string;
  profileOwnerType?: BrowserOwnerType;
  profileOwnerId?: string;
  leaseHolderRunKey?: RunKey;
  leaseTtlMs?: number;
}

export type BrowserSessionDispatchMode = "spawn" | "send" | "resume";

export interface BrowserSessionSpawnInput extends Omit<BrowserTaskRequest, "browserSessionId"> {}

export interface BrowserSessionSendInput extends BrowserTaskRequest {
  browserSessionId: string;
}

export interface BrowserSessionResumeInput extends BrowserTaskRequest {
  browserSessionId: string;
}

export interface BrowserTaskResult {
  sessionId: string;
  targetId?: string;
  transportMode?: BrowserTransportMode;
  transportLabel?: string;
  transportPeerId?: string;
  transportTargetId?: string;
  historyEntryId?: string;
  dispatchMode?: BrowserSessionDispatchMode;
  resumeMode?: BrowserResumeMode;
  targetResolution?: "attach" | "reconnect" | "reopen" | "new_target";
  page: BrowserSnapshotResult;
  screenshotPaths: string[];
  trace: BrowserActionTrace[];
  artifactIds: string[];
}

export type BrowserOwnerType = "user" | "thread" | "role" | "worker";
export type BrowserSessionOwnerType = BrowserOwnerType;
export type BrowserProfileOwnerType = BrowserOwnerType;
export type BrowserTransportMode = "relay" | "direct-cdp" | "local";

export type BrowserTransportDiagnosticBucket =
  | "peer_missing"
  | "peer_stale"
  | "target_missing"
  | "target_detached"
  | "target_closed"
  | "content_script_unavailable"
  | "action_timeout"
  | "action_failed"
  | "endpoint_unreachable"
  | "reconnect_required";
export type BrowserSessionStatus = "starting" | "ready" | "busy" | "disconnected" | "closed";
export type BrowserTargetStatus = "open" | "attached" | "detached" | "closed";
export type BrowserResumeMode = "hot" | "warm" | "cold";

export interface BrowserSession {
  browserSessionId: string;
  ownerType: BrowserSessionOwnerType;
  ownerId: string;
  profileId: string;
  transportMode: BrowserTransportMode;
  status: BrowserSessionStatus;
  leaseHolderRunKey?: RunKey;
  leaseExpiresAt?: number;
  lastResumeMode?: BrowserResumeMode;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  activeTargetId?: string;
  targetIds: string[];
  closeReason?: string;
}

export interface BrowserTarget {
  targetId: string;
  browserSessionId: string;
  ownerType: BrowserOwnerType;
  ownerId: string;
  transportSessionId?: string;
  url: string;
  title?: string;
  status: BrowserTargetStatus;
  leaseHolderRunKey?: RunKey;
  leaseExpiresAt?: number;
  lastResumeMode?: BrowserResumeMode;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserProfile {
  profileId: string;
  ownerType: BrowserProfileOwnerType;
  ownerId: string;
  persistentDir: string;
  loginState: "unknown" | "authenticated" | "anonymous";
  createdAt: number;
  updatedAt: number;
}

export interface SnapshotRefEntry {
  refId: string;
  role: string;
  label: string;
  tagName?: string;
  selectors?: string[];
  textAnchors?: string[];
  ordinal?: number;
}

export interface BrowserSnapshotArtifact {
  artifactId: string;
  snapshotId: string;
  browserSessionId: string;
  targetId: string;
  createdAt: number;
  finalUrl: string;
  title: string;
  refEntries: SnapshotRefEntry[];
}

export interface ResolvedRef {
  refId: string;
  strategy: "live-ref" | "snapshot-cache" | "selector-fallback" | "semantic-fallback";
  selectors?: string[];
  label?: string;
}

export interface BrowserArtifactRecord {
  artifactId: string;
  browserSessionId: string;
  targetId?: string;
  type: "snapshot" | "screenshot" | "console-result" | "downloaded-file" | "trace";
  path: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface BrowserSessionHistoryEntry {
  entryId: string;
  browserSessionId: string;
  dispatchMode: BrowserSessionDispatchMode;
  threadId: ThreadId;
  taskId: TaskId;
  ownerType: BrowserOwnerType;
  ownerId: string;
  targetId?: string;
  transportMode?: BrowserTransportMode;
  transportLabel?: string;
  transportPeerId?: string;
  transportTargetId?: string;
  historyCursor: number;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed";
  actionKinds: BrowserTaskAction["kind"][];
  instructions: string;
  resumeMode?: BrowserResumeMode;
  targetResolution?: BrowserTaskResult["targetResolution"];
  summary: string;
  finalUrl?: string;
  title?: string;
  traceStepCount?: number;
  screenshotCount?: number;
  artifactCount?: number;
  failure?: FailureSummary;
}

export interface BrowserSessionStore {
  get(browserSessionId: string): Promise<BrowserSession | null>;
  put(session: BrowserSession): Promise<void>;
  list(): Promise<BrowserSession[]>;
  listByOwner(ownerType: BrowserSessionOwnerType, ownerId: string): Promise<BrowserSession[]>;
  listActiveByProfile(profileId: string): Promise<BrowserSession[]>;
}

export interface BrowserSessionHistoryStore {
  append(entry: BrowserSessionHistoryEntry): Promise<void>;
  listBySession(browserSessionId: string, limit?: number): Promise<BrowserSessionHistoryEntry[]>;
}

export interface BrowserTargetStore {
  get(targetId: string): Promise<BrowserTarget | null>;
  put(target: BrowserTarget): Promise<void>;
  listBySession(browserSessionId: string): Promise<BrowserTarget[]>;
}

export interface BrowserProfileStore {
  get(profileId: string): Promise<BrowserProfile | null>;
  put(profile: BrowserProfile): Promise<void>;
  findByOwner(ownerType: BrowserProfileOwnerType, ownerId: string): Promise<BrowserProfile | null>;
}

export interface SnapshotRefStore {
  save(snapshot: BrowserSnapshotArtifact): Promise<void>;
  resolve(input: { browserSessionId: string; targetId: string; refId: string }): Promise<ResolvedRef | null>;
  expire(snapshotId: string): Promise<void>;
}

export interface BrowserArtifactStore {
  put(record: BrowserArtifactRecord): Promise<void>;
  get(artifactId: string): Promise<BrowserArtifactRecord | null>;
  listBySession(browserSessionId: string): Promise<BrowserArtifactRecord[]>;
}

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
}

export interface ReplayInspectionReport {
  totalReplays: number;
  totalGroups: number;
  incidents: ReplayTaskSummary[];
  groups: ReplayTaskSummary[];
  layerCounts: Partial<Record<ReplayLayer, number>>;
  failureCounts: Partial<Record<FailureCategory, number>>;
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
    | "content_script_unavailable"
    | "action_timeout"
    | "action_failed";
  relayDiagnosticSummary?: string;
}

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

export interface ReplayIncidentBundle {
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

export type OperatorCaseState = "open" | "recovering" | "waiting_manual" | "blocked" | "resolved";

export interface GovernanceConsoleReport {
  totalPermissionRecords: number;
  attentionCount: number;
  permissionDecisionCounts: Partial<Record<PermissionDecision, number>>;
  permissionScopeCounts: Partial<Record<PermissionScope, number>>;
  requirementLevelCounts: Partial<Record<PermissionRequirementLevel, number>>;
  totalAuditEvents: number;
  transportCounts: Partial<Record<TransportKind | "none", number>>;
  trustCounts: Partial<Record<EvidenceTrustLevel, number>>;
  admissionCounts: Partial<Record<PromptAdmissionMode | "unknown", number>>;
  recommendedActionCounts: Partial<
    Record<NonNullable<PermissionEvaluation["recommendedAction"]> | "unknown", number>
  >;
  latestAudits: TeamEvent[];
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
  latestRuns: RecoveryRun[];
}

export type PromptBoundaryKind = "prompt_compaction" | "request_envelope_reduction";
export type PromptBoundaryReductionLevel = "compact" | "minimal" | "reference-only";

export interface PromptAssemblyContinuityDiagnostics {
  hasThreadSummary: boolean;
  hasSessionMemory: boolean;
  hasRoleScratchpad: boolean;
  hasContinuationContext: boolean;
  carriesPendingWork: boolean;
  carriesWaitingOn: boolean;
  carriesOpenQuestions: boolean;
  carriesDecisionOrConstraint: boolean;
}

export interface PromptAssemblyRecentTurnsDiagnostics {
  availableCount: number;
  selectedCount: number;
  packedCount: number;
  salientEarlierCount: number;
  compacted: boolean;
}

export interface PromptAssemblyRetrievedMemoryDiagnostics {
  availableCount: number;
  selectedCount: number;
  packedCount: number;
  compacted: boolean;
  userPreferenceCount: number;
  threadMemoryCount: number;
  sessionMemoryCount: number;
  knowledgeNoteCount: number;
  journalNoteCount: number;
}

export interface PromptAssemblyWorkerEvidenceDiagnostics {
  totalCount: number;
  admittedCount: number;
  selectedCount: number;
  packedCount: number;
  compacted: boolean;
  promotableCount: number;
  observationalCount: number;
  fullCount: number;
  summaryOnlyCount: number;
  continuationRelevantCount: number;
}

export interface PromptAssemblyContextDiagnostics {
  continuity: PromptAssemblyContinuityDiagnostics;
  recentTurns: PromptAssemblyRecentTurnsDiagnostics;
  retrievedMemory: PromptAssemblyRetrievedMemoryDiagnostics;
  workerEvidence: PromptAssemblyWorkerEvidenceDiagnostics;
}

export interface PromptBoundaryEntry {
  progressId: string;
  recordedAt: number;
  summary: string;
  threadId: ThreadId;
  roleId?: RoleId;
  flowId?: FlowId;
  taskId?: TaskId;
  chainId?: string;
  spanId?: string;
  boundaryKind: PromptBoundaryKind;
  modelId?: string;
  modelChainId?: string;
  assemblyFingerprint?: string;
  sectionOrder?: string[];
  compactedSegments?: string[];
  omittedSections?: string[];
  usedArtifacts?: string[];
  reductionLevel?: PromptBoundaryReductionLevel;
  tokenEstimate?: {
    inputTokens: number;
    outputTokensReserved: number;
    totalProjectedTokens: number;
    overBudget: boolean;
  };
  contextDiagnostics?: PromptAssemblyContextDiagnostics;
  envelopeHint?: {
    toolResultCount?: number;
    toolResultBytes?: number;
    inlineAttachmentBytes?: number;
    inlineImageCount?: number;
    inlineImageBytes?: number;
    inlinePdfCount?: number;
    inlinePdfBytes?: number;
    multimodalPartCount?: number;
  };
}

export interface PromptConsoleReport {
  totalBoundaries: number;
  compactionCount: number;
  reductionCount: number;
  boundaryKindCounts: Partial<Record<PromptBoundaryKind, number>>;
  reductionLevelCounts: Partial<Record<PromptBoundaryReductionLevel, number>>;
  modelCounts: Record<string, number>;
  modelChainCounts: Record<string, number>;
  roleCounts: Record<string, number>;
  compactedSegmentCounts: Record<string, number>;
  uniqueAssemblyFingerprintCount: number;
  totalRecentTurnsSelected: number;
  totalRecentTurnsPacked: number;
  totalRetrievedMemoryCandidates: number;
  totalRetrievedMemoryPacked: number;
  totalWorkerEvidenceCandidates: number;
  totalWorkerEvidencePacked: number;
  continuityCarryForwardCounts: {
    continuationContext: number;
    pendingWork: number;
    waitingOn: number;
    openQuestions: number;
    decisionsOrConstraints: number;
  };
  latestBoundaries: PromptBoundaryEntry[];
}

export type ValidationOpsRunType = "release-readiness" | "validation-profile" | "soak-series" | "transport-soak";
export type ValidationOpsIssueKind = "validation-item" | "release-check" | "soak-suite" | "transport-target";
export type ValidationOpsIssueSeverity = "warning" | "critical";
export type ValidationOpsFailureBucket =
  | "browser"
  | "recovery"
  | "context"
  | "parallel"
  | "governance"
  | "runtime"
  | "operator"
  | "release"
  | "soak"
  | "transport"
  | "validation";
export type ValidationOpsRecommendedAction =
  | "inspect"
  | "rerun-release"
  | "rerun-profile"
  | "rerun-soak"
  | "rerun-transport-soak";

export interface ValidationOpsIssueRecord {
  issueId: string;
  kind: ValidationOpsIssueKind;
  scope: string;
  summary: string;
  bucket: ValidationOpsFailureBucket;
  severity: ValidationOpsIssueSeverity;
  recommendedAction: ValidationOpsRecommendedAction;
  commandHint: string;
}

export interface ValidationOpsRunRecord {
  runId: string;
  runType: ValidationOpsRunType;
  title: string;
  status: "passed" | "failed";
  startedAt: number;
  completedAt: number;
  durationMs: number;
  issueCount: number;
  profileId?: string;
  selectors?: string[];
  cycles?: number;
  targets?: string[];
  artifactPath?: string;
  issues: ValidationOpsIssueRecord[];
}

export interface ValidationOpsReport {
  totalRuns: number;
  failedRuns: number;
  passedRuns: number;
  attentionCount: number;
  runTypeCounts: Partial<Record<ValidationOpsRunType, number>>;
  bucketCounts: Partial<Record<ValidationOpsFailureBucket, number>>;
  severityCounts: Partial<Record<ValidationOpsIssueSeverity, number>>;
  recommendedActionCounts: Partial<Record<ValidationOpsRecommendedAction, number>>;
  latestRuns: ValidationOpsRunRecord[];
  activeIssues: Array<
    ValidationOpsIssueRecord & {
      runId: string;
      runType: ValidationOpsRunType;
      title: string;
      recordedAt: number;
    }
  >;
}

export interface OperatorSummaryReport {
  flow: FlowConsoleReport;
  replay: ReplayConsoleReport;
  governance: GovernanceConsoleReport;
  recovery: RecoveryConsoleReport;
  prompt: PromptConsoleReport;
  promptAttentionCount: number;
  totalAttentionCount: number;
  attentionOverview?: {
    uniqueCaseCount: number;
    caseStateCounts: Partial<Record<OperatorCaseState, number>>;
    severityCounts: Partial<Record<OperatorAttentionItem["severity"], number>>;
    lifecycleCounts: Partial<Record<OperatorAttentionItem["lifecycle"], number>>;
    activeCases?: Array<{
      caseKey: string;
      headline: string;
      caseState: OperatorCaseState;
      severity: OperatorAttentionItem["severity"];
      lifecycle: OperatorAttentionItem["lifecycle"];
      gate?: string;
      action?: string;
      allowedActions?: RecoveryRunAction[];
      browserContinuityState?: ReplayBrowserContinuitySummary["state"];
      browserTransportLabel?: string;
      browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
      relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
      reasonPreview?: string;
      latestUpdate: string;
      nextStep: string;
    }>;
    resolvedRecentCases?: Array<{
      caseKey: string;
      headline: string;
      caseState: "resolved";
      source: "replay";
      gate?: string;
      action?: string;
      browserContinuityState?: ReplayBrowserContinuitySummary["state"];
      browserTransportLabel?: string;
      browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
      relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
      reasonPreview?: string;
      latestUpdate: string;
      nextStep: string;
    }>;
    topCases?: Array<{
      caseKey: string;
      headline: string;
      caseState: OperatorCaseState;
      severity: OperatorAttentionItem["severity"];
      lifecycle: OperatorAttentionItem["lifecycle"];
      gate?: string;
      action?: string;
      browserContinuityState?: ReplayBrowserContinuitySummary["state"];
      browserTransportLabel?: string;
      browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
      relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
      reasonPreview?: string;
      latestUpdate: string;
      nextStep: string;
    }>;
  };
}

export interface OperatorTriageFocusArea {
  area: "case" | "runtime" | "prompt";
  label: string;
  severity: "warning" | "critical";
  headline: string;
  reason: string;
  nextStep: string;
  commandHint: string;
  caseKey?: string;
  source?: OperatorAttentionItem["source"];
  state?: string;
  gate?: string;
  browserContinuityState?: ReplayBrowserContinuitySummary["state"];
  browserTransportLabel?: string;
  browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
  relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
}

export interface OperatorTriageReport {
  totalAttentionCount: number;
  uniqueCaseCount: number;
  blockedCaseCount: number;
  waitingManualCaseCount: number;
  recoveringCaseCount: number;
  runtimeWaitingCount: number;
  runtimeStaleCount: number;
  runtimeFailedCount: number;
  promptReductionCount: number;
  promptAttentionCount: number;
  recommendedEntryPoint?: string;
  focusAreas: OperatorTriageFocusArea[];
}

export interface OperatorAttentionItem {
  source: "flow" | "replay" | "governance" | "recovery" | "prompt";
  key: string;
  caseKey: string;
  headline: string;
  recordedAt: number;
  severity: "warning" | "critical";
  lifecycle: "open" | "recovering" | "waiting_manual" | "blocked";
  status: string;
  summary: string;
  gate?: string;
  reasons?: string[];
  browserContinuityState?: ReplayBrowserContinuitySummary["state"];
  browserTransportLabel?: string;
  browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
  relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
  action?: string;
  allowedActions?: RecoveryRunAction[];
}

export interface OperatorAttentionCaseSummary {
  caseKey: string;
  headline: string;
  caseState: OperatorCaseState;
  severity: OperatorAttentionItem["severity"];
  lifecycle: OperatorAttentionItem["lifecycle"];
  latestUpdate: string;
  nextStep: string;
  latestRecordedAt: number;
  itemCount: number;
  sources: OperatorAttentionItem["source"][];
  gate?: string;
  action?: string;
  allowedActions?: RecoveryRunAction[];
  browserContinuityState?: ReplayBrowserContinuitySummary["state"];
  browserTransportLabel?: string;
  browserDiagnosticBucket?: ReplayBrowserContinuitySummary["browserDiagnosticBucket"];
  relayDiagnosticBucket?: ReplayBrowserContinuitySummary["relayDiagnosticBucket"];
  reasons?: string[];
}

export interface OperatorAttentionReport {
  totalItems: number;
  returnedItems: number;
  uniqueCaseCount: number;
  sourceCounts: Partial<Record<OperatorAttentionItem["source"], number>>;
  caseStateCounts: Partial<Record<OperatorCaseState, number>>;
  severityCounts: Partial<Record<OperatorAttentionItem["severity"], number>>;
  lifecycleCounts: Partial<Record<OperatorAttentionItem["lifecycle"], number>>;
  returnedCases: number;
  cases: OperatorAttentionCaseSummary[];
  items: OperatorAttentionItem[];
}

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

export interface RecoveryRunStore {
  get(recoveryRunId: string): Promise<RecoveryRun | null>;
  put(run: RecoveryRun): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RecoveryRun[]>;
}

export interface RecoveryRunEventStore {
  append(event: RecoveryRunEvent): Promise<void>;
  listByRecoveryRun(recoveryRunId: string): Promise<RecoveryRunEvent[]>;
}

export interface ValidationOpsRunStore {
  put(record: ValidationOpsRunRecord): Promise<void>;
  list(limit?: number): Promise<ValidationOpsRunRecord[]>;
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

export function getScheduledTargetRoleId(task: ScheduledTaskRecord): RoleId {
  return task.dispatch?.targetRoleId ?? task.targetRoleId!;
}

export function getScheduledTargetWorker(task: ScheduledTaskRecord): WorkerKind | undefined {
  return task.dispatch?.targetWorker ?? task.targetWorker;
}

export function getScheduledSessionTarget(task: ScheduledTaskRecord): SessionTarget {
  return task.dispatch?.sessionTarget ?? task.sessionTarget ?? "main";
}

export function getScheduledContinuity(task: ScheduledTaskRecord): DispatchContinuity | undefined {
  return task.dispatch?.continuity ?? (task.recoveryContext
    ? {
        context: {
          source: "recovery_dispatch",
          ...(task.targetWorker ? { workerType: task.targetWorker } : {}),
          recovery: task.recoveryContext,
        },
      }
    : undefined);
}

export function getScheduledPreferredWorkerKinds(task: ScheduledTaskRecord): WorkerKind[] {
  const explicit = task.dispatch?.constraints?.preferredWorkerKinds;
  if (explicit?.length) {
    return explicit;
  }
  return task.dispatch?.targetWorker ? [task.dispatch.targetWorker] : task.targetWorker ? [task.targetWorker] : [];
}

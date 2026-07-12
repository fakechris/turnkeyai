import type { BrowserOwnerType, BrowserResumeMode } from "./browser";
import type { ReplayRecoveryPlan } from "./team-replay-types";
import type {
  ActivationType,
  ContinuityMode,
  DispatchMode,
  FlowLedger,
  HandoffEnvelope,
  MessageId,
  RoleId,
  RunKey,
  SessionTarget,
  TeamMessage,
  TeamMessageRole,
  TeamThread,
  ThreadId,
  ValidateMentionInput,
  WorkerKind,
} from "./team-core";

export interface DispatchIntent {
  relayBrief: string;
  recentMessages: TeamMessageSummary[];
  instructions?: string;
  /** Verbatim user goal carriage (see DispatchGoal). Unlike relayBrief and
   *  recentMessages — which are truncated digests — this is the binding task
   *  statement and must survive continuation/recovery/final synthesis. */
  goal?: DispatchGoal;
}

/** Hard cap for verbatim goal carriage. Generous on purpose: the goal is the
 *  binding contract for the whole mission and the prompt task layer budgets
 *  thousands of tokens. Truncation is recorded explicitly so downstream
 *  prompts can say so instead of silently losing requirements. */
export const MAX_DISPATCH_GOAL_CHARS = 6_000;

export interface DispatchGoalMessage {
  messageId: MessageId;
  /** Verbatim message content, capped at MAX_DISPATCH_GOAL_CHARS. */
  content: string;
  /** True when content was cut at the cap. */
  truncated?: boolean;
}

export interface DispatchGoal {
  /** The originating user request for this flow — the message whose explicit
   *  requirements (output shape, table columns, evidence demands,
   *  blocked/partial reporting) bind every later turn. */
  origin: DispatchGoalMessage;
  /** Latest user message when it differs from origin (follow-up direction). */
  latestDirection?: DispatchGoalMessage;
}

export function toDispatchGoalMessage(message: {
  id: MessageId;
  content: string;
}): DispatchGoalMessage {
  const content = message.content;
  if (content.length <= MAX_DISPATCH_GOAL_CHARS) {
    return { messageId: message.id, content };
  }
  return {
    messageId: message.id,
    content: content.slice(0, MAX_DISPATCH_GOAL_CHARS),
    truncated: true,
  };
}

/**
 * Resolve the verbatim goal for a dispatch from already-loaded messages.
 *
 * Selection rules:
 *  - origin: the EARLIEST user message visible across rootMessage,
 *    threadMessages, and sourceMessage. Every user post starts its own flow,
 *    so the flow root is the LATEST post on follow-ups — the thread's first
 *    user message is the mission anchor (mission threads are created by
 *    posting the mission goal as the first user message).
 *  - latestDirection: the LATEST user message when it differs from origin
 *    (the current follow-up / steering instruction).
 *  - returns undefined when no user message exists anywhere (machine-only
 *    threads).
 *
 * `threadMessages` should be in thread order and as complete a window as the
 * caller can cheaply provide — a truncated window silently turns a mid-thread
 * follow-up into the "origin", so callers should widen beyond the dispatch
 * recents (see CoordinationEngine.resolveDispatchGoalSafely).
 */
export function resolveDispatchGoal(input: {
  rootMessage?: Pick<TeamMessage, "id" | "role" | "content" | "createdAt"> | null;
  sourceMessage?: Pick<TeamMessage, "id" | "role" | "content" | "createdAt"> | null;
  threadMessages: TeamMessageSummary[];
}): DispatchGoal | undefined {
  const userMessages: Array<{ id: MessageId; content: string; createdAt: number }> = [];
  const seen = new Set<MessageId>();
  const push = (message: { id: MessageId; role: string; content: string; createdAt: number } | null | undefined) => {
    if (!message || message.role !== "user" || seen.has(message.id)) return;
    // Store-loaded records can be malformed despite the static type; goal
    // resolution must degrade, not throw, on a non-string content.
    if (typeof message.content !== "string" || !message.content.trim()) return;
    seen.add(message.id);
    userMessages.push({ id: message.id, content: message.content, createdAt: message.createdAt });
  };

  push(input.rootMessage ?? null);
  for (const message of input.threadMessages) {
    push({ id: message.messageId, role: message.role, content: message.content, createdAt: message.createdAt });
  }
  push(input.sourceMessage ?? null);

  if (userMessages.length === 0) {
    return undefined;
  }
  userMessages.sort((left, right) => left.createdAt - right.createdAt);

  const earliest = userMessages[0]!;
  const latest = userMessages[userMessages.length - 1]!;

  const origin = toDispatchGoalMessage(earliest);
  if (latest.id === origin.messageId) {
    return { origin };
  }
  return {
    origin,
    latestDirection: toDispatchGoalMessage(latest),
  };
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
  source:
    | "scheduled_reentry"
    | "timeout_summary"
    | "follow_up"
    | "explicit_user_target"
    | "recovery_dispatch";
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
  sessionTarget?: SessionTarget;
}

type LegacyRelayPayloadInput = RelayPayload & {
  relayBrief?: string;
  recentMessages?: TeamMessageSummary[];
  instructions?: string;
  preferredWorkerKinds?: WorkerKind[];
  continuationContext?: DispatchContinuationContext;
  mergeContext?: FanOutMergeContext;
  parallelContext?: ParallelOrchestrationContext;
  dispatchPolicy?: DispatchPolicy;
};

export function normalizeRelayPayload(payload: LegacyRelayPayloadInput): RelayPayload {
  const relayBrief = payload.intent?.relayBrief ?? payload.relayBrief ?? "";
  const recentMessages = payload.intent?.recentMessages ?? payload.recentMessages ?? [];
  const instructions = payload.intent?.instructions ?? payload.instructions;
  const goal = payload.intent?.goal;
  const preferredWorkerKinds = payload.constraints?.preferredWorkerKinds ?? payload.preferredWorkerKinds ?? [];
  const dispatchPolicy = payload.constraints?.dispatchPolicy ?? payload.dispatchPolicy;
  const continuity =
    payload.continuity || payload.continuationContext
      ? {
          ...(payload.continuity ?? {}),
          ...(payload.continuationContext ? { context: payload.continuationContext } : {}),
        }
      : undefined;
  const coordination =
    payload.coordination || payload.mergeContext || payload.parallelContext
      ? {
          ...(payload.coordination ?? {}),
          ...(payload.mergeContext ? { merge: payload.mergeContext } : {}),
          ...(payload.parallelContext ? { parallel: payload.parallelContext } : {}),
        }
      : undefined;

  return {
    threadId: payload.threadId,
    ...(relayBrief || recentMessages.length > 0 || instructions || goal
      ? {
          intent: {
            relayBrief,
            recentMessages,
            ...(instructions ? { instructions } : {}),
            ...(goal ? { goal } : {}),
          },
        }
      : {}),
    ...(continuity ? { continuity } : {}),
    ...(coordination ? { coordination } : {}),
    ...(dispatchPolicy
      ? {
          constraints: {
            dispatchPolicy,
            ...(preferredWorkerKinds.length > 0 ? { preferredWorkerKinds } : {}),
          },
        }
      : {}),
    ...(payload.sessionTarget ? { sessionTarget: payload.sessionTarget } : {}),
  };
}

export function createRelayPayload(input: {
  threadId: ThreadId;
  relayBrief: string;
  recentMessages: TeamMessageSummary[];
  instructions?: string;
  goal?: DispatchGoal;
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
      ...(input.goal ? { goal: input.goal } : {}),
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

export interface ShardResultRecord {
  roleId: RoleId;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  summaryDigest: string;
  messageId?: MessageId;
  updatedAt: number;
}

export type ParallelOrchestrationContext = ResearchShardPacket | MergeSynthesisPacket;

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

export interface HandoffTarget {
  raw: string;
  roleId: RoleId;
  offsetStart: number;
  offsetEnd: number;
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

export interface HandoffPlanner {
  parseMentions(content: string): HandoffTarget[];
  validateMentionTargets(thread: TeamThread, input: ValidateMentionInput): Promise<DispatchDecision>;
  buildHandoffs(input: BuildHandoffsInput): Promise<HandoffEnvelope[]>;
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
  if (!payload.constraints?.dispatchPolicy) {
    throw new Error(`relay payload is missing canonical constraints.dispatchPolicy for thread ${payload.threadId}`);
  }
  return payload.constraints.dispatchPolicy;
}

export function getRelayBrief(payload: RelayPayload): string {
  return payload.intent?.relayBrief ?? "";
}

export function getRecentMessages(payload: RelayPayload): TeamMessageSummary[] {
  return payload.intent?.recentMessages ?? [];
}

export function getInstructions(payload: RelayPayload): string | undefined {
  return payload.intent?.instructions;
}

export function getDispatchGoal(payload: RelayPayload): DispatchGoal | undefined {
  return payload.intent?.goal;
}

export function getPreferredWorkerKinds(payload: RelayPayload): WorkerKind[] {
  return payload.constraints?.preferredWorkerKinds ?? [];
}

export function getSessionTarget(payload: RelayPayload): SessionTarget | undefined {
  return payload.sessionTarget ?? (payload.continuity?.context?.workerType ? "worker" : undefined);
}

export function getDispatchContinuityMode(payload: RelayPayload): ContinuityMode | undefined {
  return payload.continuity?.mode;
}

export function getContinuationContext(payload: RelayPayload): DispatchContinuationContext | undefined {
  return payload.continuity?.context;
}

export function getMergeContext(payload: RelayPayload): DispatchCoordination["merge"] {
  return payload.coordination?.merge;
}

export function getParallelContext(payload: RelayPayload): DispatchCoordination["parallel"] {
  return payload.coordination?.parallel;
}

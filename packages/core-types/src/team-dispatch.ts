import type { BrowserOwnerType, BrowserResumeMode } from "./browser";
import type { ReplayRecoveryPlan } from "./team-replay-recovery";
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
  /** @deprecated Use `intent.relayBrief`. */
  relayBrief?: string;
  /** @deprecated Use `intent.recentMessages`. */
  recentMessages?: TeamMessageSummary[];
  /** @deprecated Use `intent.instructions`. */
  instructions?: string;
  /** @deprecated Use `constraints.preferredWorkerKinds`. */
  preferredWorkerKinds?: WorkerKind[];
  /** @deprecated Prefer `continuity`; keep `sessionTarget` only for legacy compatibility. */
  sessionTarget?: SessionTarget;
  /** @deprecated Use `continuity.context`. */
  continuationContext?: DispatchContinuationContext;
  /** @deprecated Use `coordination.merge`. */
  mergeContext?: FanOutMergeContext;
  /** @deprecated Use `coordination.parallel`. */
  parallelContext?: ParallelOrchestrationContext;
  /** @deprecated Use `constraints.dispatchPolicy`. */
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

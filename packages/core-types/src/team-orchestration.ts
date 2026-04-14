import type {
  ContinuityMode,
  FlowId,
  FlowLedger,
  MessageId,
  RoleActivationInput,
  RoleId,
  RunKey,
  RuntimeError,
  SessionTarget,
  TaskId,
  TeamId,
  TeamMessage,
  TeamMessageSummary,
  TeamThread,
  ThreadId,
  WorkerKind,
} from "./team-core";
import type {
  DispatchContinuationContext,
  DispatchCoordination,
} from "./team-dispatch";
import type { CapabilityInspectionResult } from "./team-governance";

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

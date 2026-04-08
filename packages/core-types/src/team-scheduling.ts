import type {
  RoleId,
  SessionTarget,
  TaskId,
  ThreadId,
  WorkerKind,
} from "./team-core";
import type {
  DispatchConstraints,
  DispatchContinuity,
  DispatchRecoveryContext,
} from "./team-dispatch";

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
  version?: number;
  dispatch?: {
    targetRoleId: RoleId;
    targetWorker?: WorkerKind;
    sessionTarget: SessionTarget;
    continuity?: DispatchContinuity;
    constraints?: Pick<DispatchConstraints, "preferredWorkerKinds">;
  };
  /** @deprecated Use `dispatch.targetRoleId`. */
  targetRoleId?: RoleId;
  /** @deprecated Use `dispatch.targetWorker`. */
  targetWorker?: WorkerKind;
  /** @deprecated Use `dispatch.sessionTarget`. */
  sessionTarget?: SessionTarget;
  /** @deprecated Use `dispatch.continuity.context.recovery`. */
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
  put(task: ScheduledTaskRecord, options?: { expectedVersion?: number | undefined }): Promise<void>;
  listByThread(threadId: ThreadId): Promise<ScheduledTaskRecord[]>;
  listDue(now: number): Promise<ScheduledTaskRecord[]>;
  claimDue(
    taskId: TaskId,
    expectedUpdatedAt: number,
    leaseUntil: number,
    options?: { expectedVersion?: number | undefined }
  ): Promise<ScheduledTaskRecord | null>;
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

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

import type { DispatchContinuity } from "./team-dispatch";
import type { WorkerKind } from "./team-core";
import type { ScheduledTaskRecord } from "./team-scheduling";

export function createScheduledTaskRecord(input: {
  taskId: string;
  threadId: string;
  version?: number;
  dispatch: NonNullable<ScheduledTaskRecord["dispatch"]>;
  schedule: ScheduledTaskRecord["schedule"];
  capsule: ScheduledTaskRecord["capsule"];
  createdAt: number;
  updatedAt: number;
}): ScheduledTaskRecord {
  const preferredWorkerKinds = input.dispatch.constraints?.preferredWorkerKinds;
  const recoveryContext = input.dispatch.continuity?.context?.recovery;

  return {
    taskId: input.taskId,
    threadId: input.threadId,
    ...(input.version !== undefined ? { version: input.version } : {}),
    dispatch: {
      targetRoleId: input.dispatch.targetRoleId,
      sessionTarget: input.dispatch.sessionTarget,
      ...(input.dispatch.targetWorker ? { targetWorker: input.dispatch.targetWorker } : {}),
      ...(input.dispatch.continuity ? { continuity: input.dispatch.continuity } : {}),
      ...(preferredWorkerKinds?.length ? { constraints: { preferredWorkerKinds } } : {}),
    },
    targetRoleId: input.dispatch.targetRoleId,
    ...(input.dispatch.targetWorker ? { targetWorker: input.dispatch.targetWorker } : {}),
    sessionTarget: input.dispatch.sessionTarget,
    ...(recoveryContext ? { recoveryContext } : {}),
    schedule: input.schedule,
    capsule: input.capsule,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

export function requireScheduledDispatch(task: ScheduledTaskRecord): NonNullable<ScheduledTaskRecord["dispatch"]> {
  if (!task.dispatch) {
    throw new Error(`scheduled task is missing canonical dispatch payload: ${task.taskId}`);
  }
  return task.dispatch;
}

export function getScheduledPreferredWorkerKinds(task: ScheduledTaskRecord): WorkerKind[] {
  const dispatch = requireScheduledDispatch(task);
  const explicit = dispatch.constraints?.preferredWorkerKinds;
  if (explicit?.length) {
    return explicit;
  }
  return dispatch.targetWorker ? [dispatch.targetWorker] : [];
}

export function normalizeScheduledTaskRecord(task: ScheduledTaskRecord): ScheduledTaskRecord {
  const targetRoleId = task.dispatch?.targetRoleId ?? task.targetRoleId!;
  const targetWorker = task.dispatch?.targetWorker ?? task.targetWorker;
  const sessionTarget = task.dispatch?.sessionTarget ?? task.sessionTarget ?? "main";
  const continuity: DispatchContinuity | undefined =
    task.dispatch?.continuity ??
    (task.recoveryContext
      ? {
          context: {
            source: "recovery_dispatch",
            ...(task.targetWorker ? { workerType: task.targetWorker } : {}),
            recovery: task.recoveryContext,
          },
        }
      : undefined);
  const preferredWorkerKinds =
    task.dispatch?.constraints?.preferredWorkerKinds?.length
      ? task.dispatch.constraints.preferredWorkerKinds
      : targetWorker
        ? [targetWorker]
        : [];
  const recoveryContext = continuity?.context?.recovery;
  const version = task.version ?? 1;

  return createScheduledTaskRecord({
    taskId: task.taskId,
    threadId: task.threadId,
    version,
    dispatch: {
      targetRoleId,
      sessionTarget,
      ...(targetWorker ? { targetWorker } : {}),
      ...(continuity ? { continuity } : {}),
      ...(preferredWorkerKinds.length > 0 ? { constraints: { preferredWorkerKinds } } : {}),
    },
    schedule: task.schedule,
    capsule: task.capsule,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

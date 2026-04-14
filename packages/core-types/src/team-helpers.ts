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

import type { DispatchContinuity, DispatchContinuationContext, DispatchCoordination, DispatchPolicy, RoleId, SessionTarget, WorkerKind } from "./team-core";
import type { ScheduledTaskRecord } from "./team-runtime-support";

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

export function normalizeScheduledTaskRecord(task: ScheduledTaskRecord): ScheduledTaskRecord {
  const targetRoleId = getScheduledTargetRoleId(task);
  const targetWorker = getScheduledTargetWorker(task);
  const sessionTarget = getScheduledSessionTarget(task);
  const continuity = getScheduledContinuity(task);
  const preferredWorkerKinds = getScheduledPreferredWorkerKinds(task);
  const recoveryContext = continuity?.context?.recovery;

  return {
    ...task,
    dispatch: {
      targetRoleId,
      sessionTarget,
      ...(targetWorker ? { targetWorker } : {}),
      ...(continuity ? { continuity } : {}),
      ...(preferredWorkerKinds.length > 0 ? { constraints: { preferredWorkerKinds } } : {}),
    },
    targetRoleId,
    ...(targetWorker ? { targetWorker } : {}),
    sessionTarget,
    ...(recoveryContext ? { recoveryContext } : {}),
  };
}

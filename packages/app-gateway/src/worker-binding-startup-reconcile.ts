import type {
  RoleRunState,
  RoleRunStore,
  TeamThreadStore,
  WorkerBindingStartupReconcileResult,
  WorkerRuntime,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

function isTerminalWorkerSession(record: WorkerSessionRecord): boolean {
  return ["done", "failed", "cancelled"].includes(record.state.status);
}

function isWorkerBoundRoleStatus(status: RoleRunState["status"]): boolean {
  return status === "waiting_worker" || status === "resuming";
}

export async function reconcileWorkerBindingsOnStartup(input: {
  teamThreadStore: TeamThreadStore;
  roleRunStore: RoleRunStore;
  workerRuntime: WorkerRuntime;
}): Promise<WorkerBindingStartupReconcileResult | undefined> {
  if (!input.workerRuntime.listSessions) {
    return undefined;
  }

  const [threads, sessions] = await Promise.all([
    input.teamThreadStore.list(),
    input.workerRuntime.listSessions(),
  ]);
  const sessionsByRunKey = new Map(sessions.map((record) => [record.workerRunKey, record]));
  const roleRuns = (await Promise.all(threads.map((thread) => input.roleRunStore.listByThread(thread.threadId)))).flat();

  let totalBindings = 0;
  let clearedMissingBindings = 0;
  let clearedTerminalBindings = 0;
  let clearedCrossThreadBindings = 0;
  let roleRunsNeedingAttention = 0;
  let roleRunsRequeued = 0;
  let roleRunsFailed = 0;

  for (const run of roleRuns) {
    const result = await reconcileRoleRunBindingsWithRetry(input.roleRunStore, sessionsByRunKey, run);
    totalBindings += result.totalBindings;
    clearedMissingBindings += result.clearedMissingBindings;
    clearedTerminalBindings += result.clearedTerminalBindings;
    clearedCrossThreadBindings += result.clearedCrossThreadBindings;
    roleRunsNeedingAttention += result.roleRunsNeedingAttention;
    roleRunsRequeued += result.roleRunsRequeued;
    roleRunsFailed += result.roleRunsFailed;
  }

  return {
    totalRoleRuns: roleRuns.length,
    totalBindings,
    clearedMissingBindings,
    clearedTerminalBindings,
    clearedCrossThreadBindings,
    roleRunsNeedingAttention,
    roleRunsRequeued,
    roleRunsFailed,
  };
}

async function reconcileRoleRunBindingsWithRetry(
  roleRunStore: RoleRunStore,
  sessionsByRunKey: Map<string, WorkerSessionRecord>,
  initialRun: RoleRunState
): Promise<{
  totalBindings: number;
  clearedMissingBindings: number;
  clearedTerminalBindings: number;
  clearedCrossThreadBindings: number;
  roleRunsNeedingAttention: number;
  roleRunsRequeued: number;
  roleRunsFailed: number;
}> {
  let currentRun: RoleRunState | null = initialRun;
  while (currentRun) {
    const workerSessions = currentRun.workerSessions ?? {};
    const entries = Object.entries(workerSessions);
    if (entries.length === 0) {
      return {
        totalBindings: 0,
        clearedMissingBindings: 0,
        clearedTerminalBindings: 0,
        clearedCrossThreadBindings: 0,
        roleRunsNeedingAttention: 0,
        roleRunsRequeued: 0,
        roleRunsFailed: 0,
      };
    }

    const nextWorkerSessions: Record<string, string> = {};
    let changed = false;
    let clearedMissingBindings = 0;
    let clearedTerminalBindings = 0;
    let clearedCrossThreadBindings = 0;

    for (const [workerType, workerRunKey] of entries) {
      if (!workerRunKey) {
        changed = true;
        continue;
      }

      const session = sessionsByRunKey.get(workerRunKey);
      if (!session) {
        clearedMissingBindings += 1;
        changed = true;
        continue;
      }
      if (isTerminalWorkerSession(session)) {
        clearedTerminalBindings += 1;
        changed = true;
        continue;
      }
      if (session.context?.threadId && session.context.threadId !== currentRun.threadId) {
        clearedCrossThreadBindings += 1;
        changed = true;
        continue;
      }

      nextWorkerSessions[workerType] = workerRunKey;
    }

    let roleRunsNeedingAttention = 0;
    let roleRunsRequeued = 0;
    let roleRunsFailed = 0;
    const remainingBindings = Object.keys(nextWorkerSessions).length;
    let nextRun = changed
      ? {
          ...currentRun,
          workerSessions: nextWorkerSessions,
        }
      : currentRun;
    if (isWorkerBoundRoleStatus(currentRun.status) && remainingBindings === 0) {
      roleRunsNeedingAttention += 1;
      if (currentRun.inbox.length > 0) {
        nextRun = {
          ...nextRun,
          status: "queued",
        };
        roleRunsRequeued += 1;
      } else {
        nextRun = {
          ...nextRun,
          status: "failed",
        };
        roleRunsFailed += 1;
      }
      changed = true;
    }

    if (!changed) {
      return {
        totalBindings: entries.length,
        clearedMissingBindings: 0,
        clearedTerminalBindings: 0,
        clearedCrossThreadBindings: 0,
        roleRunsNeedingAttention: 0,
        roleRunsRequeued: 0,
        roleRunsFailed: 0,
      };
    }

    try {
      await roleRunStore.put(nextRun, { expectedVersion: currentRun.version });
      return {
        totalBindings: entries.length,
        clearedMissingBindings,
        clearedTerminalBindings,
        clearedCrossThreadBindings,
        roleRunsNeedingAttention,
        roleRunsRequeued,
        roleRunsFailed,
      };
    } catch (error) {
      if (!isVersionConflictError(error)) {
        throw error;
      }
      currentRun = await roleRunStore.get(currentRun.runKey);
    }
  }

  return {
    totalBindings: 0,
    clearedMissingBindings: 0,
    clearedTerminalBindings: 0,
    clearedCrossThreadBindings: 0,
    roleRunsNeedingAttention: 0,
    roleRunsRequeued: 0,
    roleRunsFailed: 0,
  };
}

function isVersionConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("version conflict");
}

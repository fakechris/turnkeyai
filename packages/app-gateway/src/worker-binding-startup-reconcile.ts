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
    const workerSessions = run.workerSessions ?? {};
    const entries = Object.entries(workerSessions);
    if (entries.length === 0) {
      continue;
    }

    totalBindings += entries.length;
    const nextWorkerSessions: Record<string, string> = {};
    let changed = false;

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
      if (session.context?.threadId && session.context.threadId !== run.threadId) {
        clearedCrossThreadBindings += 1;
        changed = true;
        continue;
      }

      nextWorkerSessions[workerType] = workerRunKey;
    }

    const remainingBindings = Object.keys(nextWorkerSessions).length;
    let nextRun = changed
      ? {
          ...run,
          workerSessions: nextWorkerSessions,
        }
      : run;
    if (isWorkerBoundRoleStatus(run.status) && remainingBindings === 0) {
      roleRunsNeedingAttention += 1;
      if (run.inbox.length > 0) {
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
    if (changed) {
      await input.roleRunStore.put(nextRun);
    }
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

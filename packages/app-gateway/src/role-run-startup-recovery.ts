import type {
  FlowLedgerStore,
  RoleLoopRunner,
  RoleRunState,
  RoleRunStartupRecoveryResult,
  RoleRunStore,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";

export async function recoverRoleRunsOnStartup(input: {
  teamThreadStore: TeamThreadStore;
  flowLedgerStore: FlowLedgerStore;
  roleRunStore: RoleRunStore;
  roleLoopRunner: RoleLoopRunner;
}): Promise<RoleRunStartupRecoveryResult> {
  const threads = await input.teamThreadStore.list();
  const threadIds = new Set(threads.map((thread) => thread.threadId));
  const roleRuns =
    (await input.roleRunStore.listAll?.()) ??
    (await Promise.all(threads.map((thread) => input.roleRunStore.listByThread(thread.threadId)))).flat();

  const orphanedThreadRuns = roleRuns.filter((run) => !threadIds.has(run.threadId));
  const failedRunKeys: string[] = [];
  const flowCache = new Map<string, Awaited<ReturnType<FlowLedgerStore["get"]>>>();
  let clearedInvalidHandoffs = 0;
  let queuedRunsIdled = 0;
  for (const run of orphanedThreadRuns) {
    const failed = await failOrphanedRoleRunWithRetry(input.roleRunStore, threadIds, run);
    if (failed) {
      failedRunKeys.push(run.runKey);
    }
  }

  const reconciledRuns: RoleRunState[] = [];
  for (const run of roleRuns) {
    if (!threadIds.has(run.threadId)) {
      reconciledRuns.push(run);
      continue;
    }
    const result = await reconcileRoleRunWithRetry(input.roleRunStore, input.flowLedgerStore, flowCache, threadIds, run);
    clearedInvalidHandoffs += result.clearedInvalidHandoffs;
    queuedRunsIdled += result.queuedRunsIdled;
    reconciledRuns.push(result.run);
  }

  const restartableRuns = reconciledRuns.filter(
    (run) => threadIds.has(run.threadId) && (run.status === "queued" || run.status === "running" || run.status === "resuming")
  );
  const coldRestartRunKeys = restartableRuns
    .filter((run) => (run.status === "running" || run.status === "resuming") && hasNoActiveWorkerSessions(run))
    .map((run) => run.runKey);

  await Promise.all(restartableRuns.map((run) => input.roleLoopRunner.ensureRunning(run.runKey)));

  return {
    totalRoleRuns: roleRuns.length,
    restartedQueuedRuns: restartableRuns.filter((run) => run.status === "queued").length,
    restartedRunningRuns: restartableRuns.filter((run) => run.status === "running").length,
    restartedResumingRuns: restartableRuns.filter((run) => run.status === "resuming").length,
    restartedRunKeys: restartableRuns.map((run) => run.runKey),
    coldRestartRuns: coldRestartRunKeys.length,
    coldRestartRunKeys,
    orphanedThreadRuns: orphanedThreadRuns.length,
    failedOrphanedRuns: failedRunKeys.length,
    failedRunKeys,
    clearedInvalidHandoffs,
    queuedRunsIdled,
  };
}

function hasNoActiveWorkerSessions(run: RoleRunState): boolean {
  return !Object.values(run.workerSessions ?? {}).some((session) => session != null);
}

function isTerminalRoleRun(run: RoleRunState): boolean {
  return run.status === "done" || run.status === "failed";
}

async function failOrphanedRoleRunWithRetry(
  roleRunStore: RoleRunStore,
  threadIds: Set<string>,
  initialRun: RoleRunState
): Promise<boolean> {
  let currentRun: RoleRunState | null = initialRun;
  while (currentRun) {
    if (threadIds.has(currentRun.threadId) || isTerminalRoleRun(currentRun)) {
      return false;
    }

    try {
      await roleRunStore.put({
        ...currentRun,
        status: "failed",
        workerSessions: {},
      }, { expectedVersion: currentRun.version });
      return true;
    } catch (error) {
      if (!isVersionConflictError(error)) {
        throw error;
      }
      currentRun = await roleRunStore.get(currentRun.runKey);
    }
  }

  return false;
}

async function reconcileRoleRunWithRetry(
  roleRunStore: RoleRunStore,
  flowLedgerStore: FlowLedgerStore,
  flowCache: Map<string, Awaited<ReturnType<FlowLedgerStore["get"]>>>,
  threadIds: Set<string>,
  initialRun: RoleRunState
): Promise<{ run: RoleRunState; clearedInvalidHandoffs: number; queuedRunsIdled: number }> {
  let currentRun: RoleRunState | null = initialRun;
  while (currentRun) {
    if (!threadIds.has(currentRun.threadId)) {
      return {
        run: currentRun,
        clearedInvalidHandoffs: 0,
        queuedRunsIdled: 0,
      };
    }

    const nextInbox = [];
    let mutated = false;
    let clearedInvalidHandoffs = 0;
    for (const handoff of currentRun.inbox) {
      const cachedFlow = flowCache.has(handoff.flowId) ? flowCache.get(handoff.flowId) : undefined;
      const resolvedFlow =
        cachedFlow ??
        (await flowLedgerStore.get(handoff.flowId).then((flow) => {
          if (flow) {
            flowCache.set(handoff.flowId, flow);
          }
          return flow;
        }));
      if (handoff.threadId !== currentRun.threadId || !resolvedFlow || resolvedFlow.threadId !== currentRun.threadId) {
        clearedInvalidHandoffs += 1;
        mutated = true;
        continue;
      }
      nextInbox.push(handoff);
    }
    let queuedRunsIdled = 0;
    let nextRun = mutated ? { ...currentRun, inbox: nextInbox } : currentRun;
    if (nextRun.status === "queued" && nextRun.inbox.length === 0) {
      nextRun = {
        ...nextRun,
        status: "idle",
      };
      queuedRunsIdled += 1;
      mutated = true;
    }

    if (!mutated) {
      return {
        run: currentRun,
        clearedInvalidHandoffs: 0,
        queuedRunsIdled: 0,
      };
    }

    try {
      await roleRunStore.put(nextRun, { expectedVersion: currentRun.version });
      return {
        run: nextRun,
        clearedInvalidHandoffs,
        queuedRunsIdled,
      };
    } catch (error) {
      if (!isVersionConflictError(error)) {
        throw error;
      }
      currentRun = await roleRunStore.get(currentRun.runKey);
    }
  }

  return {
    run: initialRun,
    clearedInvalidHandoffs: 0,
    queuedRunsIdled: 0,
  };
}

function isVersionConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("version conflict");
}

import type {
  FlowLedgerStore,
  RoleLoopRunner,
  RoleRunState,
  RoleRunStartupRecoveryResult,
  RoleRunStore,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";
import { normalizeRelayPayload } from "@turnkeyai/core-types/team";

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
    if (isTerminalRoleRun(run)) {
      continue;
    }
    await input.roleRunStore.put({
      ...run,
      status: "failed",
      workerSessions: {},
    }, { expectedVersion: run.version });
    failedRunKeys.push(run.runKey);
  }

  const reconciledRuns: RoleRunState[] = [];
  for (const run of roleRuns) {
    if (!threadIds.has(run.threadId)) {
      reconciledRuns.push(run);
      continue;
    }
    const nextInbox = [];
    let mutated = false;
    for (const handoff of run.inbox) {
      const normalizedPayload = normalizeRelayPayload(handoff.payload);
      const cachedFlow =
        flowCache.get(handoff.flowId) ??
        (await input.flowLedgerStore.get(handoff.flowId).then((flow) => {
          flowCache.set(handoff.flowId, flow);
          return flow;
        }));
      if (handoff.threadId !== run.threadId || !cachedFlow || cachedFlow.threadId !== run.threadId) {
        clearedInvalidHandoffs += 1;
        mutated = true;
        continue;
      }
      if (JSON.stringify(normalizedPayload) !== JSON.stringify(handoff.payload)) {
        mutated = true;
      }
      nextInbox.push({
        ...handoff,
        payload: normalizedPayload,
      });
    }
    let nextRun = mutated ? { ...run, inbox: nextInbox } : run;
    if (nextRun.status === "queued" && nextRun.inbox.length === 0) {
      nextRun = {
        ...nextRun,
        status: "idle",
      };
      queuedRunsIdled += 1;
      mutated = true;
    }
    if (mutated) {
      await input.roleRunStore.put(nextRun, { expectedVersion: run.version });
    }
    reconciledRuns.push(nextRun);
  }

  const restartableRuns = reconciledRuns.filter(
    (run) => threadIds.has(run.threadId) && (run.status === "queued" || run.status === "running" || run.status === "resuming")
  );

  await Promise.all(restartableRuns.map((run) => input.roleLoopRunner.ensureRunning(run.runKey)));

  return {
    totalRoleRuns: roleRuns.length,
    restartedQueuedRuns: restartableRuns.filter((run) => run.status === "queued").length,
    restartedRunningRuns: restartableRuns.filter((run) => run.status === "running").length,
    restartedResumingRuns: restartableRuns.filter((run) => run.status === "resuming").length,
    restartedRunKeys: restartableRuns.map((run) => run.runKey),
    orphanedThreadRuns: orphanedThreadRuns.length,
    failedOrphanedRuns: failedRunKeys.length,
    failedRunKeys,
    clearedInvalidHandoffs,
    queuedRunsIdled,
  };
}

function isTerminalRoleRun(run: RoleRunState): boolean {
  return run.status === "done" || run.status === "failed";
}

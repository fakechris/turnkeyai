import type {
  FlowLedgerStore,
  FlowRecoveryStartupReconcileResult,
  RecoveryRun,
  RecoveryRunStore,
  TeamThreadStore,
} from "@turnkeyai/core-types/team";

export async function reconcileFlowRecoveryOnStartup(input: {
  clock: { now(): number };
  teamThreadStore: TeamThreadStore;
  flowLedgerStore: FlowLedgerStore;
  recoveryRunStore: RecoveryRunStore;
}): Promise<FlowRecoveryStartupReconcileResult> {
  const threads = await input.teamThreadStore.list();
  const threadIds = new Set(threads.map((thread) => thread.threadId));
  const flows =
    (await input.flowLedgerStore.listAll?.()) ??
    (await Promise.all(threads.map((thread) => input.flowLedgerStore.listByThread(thread.threadId)))).flat();
  const recoveryRuns =
    (await input.recoveryRunStore.listAll?.()) ??
    (await Promise.all(threads.map((thread) => input.recoveryRunStore.listByThread(thread.threadId)))).flat();

  const flowsById = new Map(flows.map((flow) => [flow.flowId, flow]));
  const orphanedFlows = flows.filter((flow) => !threadIds.has(flow.threadId));
  const affectedFlowIds: string[] = [];
  let abortedOrphanedFlows = 0;
  for (const flow of orphanedFlows) {
    if (flow.status === "completed" || flow.status === "failed" || flow.status === "aborted") {
      continue;
    }
    const { nextExpectedRoleId: _nextExpectedRoleId, ...flowWithoutNextExpectedRole } = flow;
    await input.flowLedgerStore.put({
      ...flowWithoutNextExpectedRole,
      status: "aborted",
      activeRoleIds: [],
      updatedAt: input.clock.now(),
    }, { expectedVersion: flow.version });
    affectedFlowIds.push(flow.flowId);
    abortedOrphanedFlows += 1;
  }
  const orphanedRecoveryRuns = recoveryRuns.filter((run) => !threadIds.has(run.threadId));
  const affectedRecoveryRunIds: string[] = [];
  let missingFlowRecoveryRuns = 0;
  let crossThreadFlowRecoveryRuns = 0;
  let failedRecoveryRuns = 0;

  for (const run of recoveryRuns) {
    let reason: string | null = null;
    if (!threadIds.has(run.threadId)) {
      reason = "Recovery run thread is missing after daemon restart.";
    } else if (run.flowId) {
      const flow = flowsById.get(run.flowId);
      if (!flow) {
        missingFlowRecoveryRuns += 1;
        reason = "Recovery run referenced a missing flow.";
      } else if (flow.threadId !== run.threadId) {
        crossThreadFlowRecoveryRuns += 1;
        reason = "Recovery run referenced a flow from a different thread.";
      }
    }

    if (!reason || isTerminalRecoveryRun(run)) {
      continue;
    }

    await input.recoveryRunStore.put(failRecoveryRun(run, input.clock.now(), reason), { expectedVersion: run.version });
    affectedRecoveryRunIds.push(run.recoveryRunId);
    failedRecoveryRuns += 1;
  }

  return {
    orphanedFlows: orphanedFlows.length,
    abortedOrphanedFlows,
    orphanedRecoveryRuns: orphanedRecoveryRuns.length,
    missingFlowRecoveryRuns,
    crossThreadFlowRecoveryRuns,
    failedRecoveryRuns,
    affectedFlowIds,
    affectedRecoveryRunIds,
  };
}

function isTerminalRecoveryRun(run: RecoveryRun): boolean {
  return run.status === "failed" || run.status === "aborted" || run.status === "recovered" || run.status === "superseded";
}

function failRecoveryRun(run: RecoveryRun, now: number, summary: string): RecoveryRun {
  return {
    ...run,
    status: "failed",
    nextAction: "stop",
    autoDispatchReady: false,
    requiresManualIntervention: true,
    latestSummary: summary,
    waitingReason: summary,
    updatedAt: now,
  };
}

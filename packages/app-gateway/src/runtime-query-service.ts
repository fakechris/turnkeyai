import type {
  Clock,
  RoleRunState,
  RuntimeChain,
  RuntimeChainCanonicalState,
  RuntimeChainStatus,
  RuntimeSummaryReport,
  WorkerSessionRecord,
  WorkerRuntime,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";
import type { FileReplayRecorder } from "@turnkeyai/qc-runtime/file-replay-recorder";
import {
  buildAugmentedFlowRuntimeChainDetail,
  buildAugmentedFlowRuntimeChainEntry,
  buildDerivedRecoveryRuntimeChain,
  buildDerivedRecoveryRuntimeChainDetail,
  buildRuntimeSummaryReport,
  decorateRuntimeChainStatus,
  isRecoveryRuntimeChainId,
} from "@turnkeyai/qc-runtime/runtime-chain-inspection";
import type { FileFlowLedgerStore } from "@turnkeyai/team-store/file-flow-ledger-store";
import type { FileRoleRunStore } from "@turnkeyai/team-store/file-role-run-store";
import type { FileRuntimeChainEventStore } from "@turnkeyai/team-store/file-runtime-chain-event-store";
import type { FileRuntimeChainSpanStore } from "@turnkeyai/team-store/file-runtime-chain-span-store";
import type { FileRuntimeChainStatusStore } from "@turnkeyai/team-store/file-runtime-chain-status-store";
import type { FileRuntimeChainStore } from "@turnkeyai/team-store/file-runtime-chain-store";
import type { FileRuntimeProgressStore } from "@turnkeyai/team-store/file-runtime-progress-store";
import type { FileRecoveryRunStore } from "@turnkeyai/team-store/recovery/file-recovery-run-store";
import type { FileRecoveryRunEventStore } from "@turnkeyai/team-store/recovery/file-recovery-run-event-store";
import type { FileTeamThreadStore } from "@turnkeyai/team-store/file-team-thread-store";

type RuntimeChainEntry = { chain: RuntimeChain; status: RuntimeChainStatus };
type RecoveryRuntimeSnapshot = {
  records: Awaited<ReturnType<FileReplayRecorder["list"]>>;
  report: ReturnType<typeof import("@turnkeyai/qc-runtime/replay-inspection").buildReplayInspectionReport>;
  runs: Awaited<ReturnType<FileRecoveryRunStore["listByThread"]>>;
};

function isTerminalWorkerStatus(record: WorkerSessionRecord): boolean {
  return ["done", "failed", "cancelled"].includes(record.state.status);
}

export interface RuntimeQueryService {
  listRuntimeChainEntriesByThread(threadId: string, limit: number): Promise<RuntimeChainEntry[]>;
  listActiveRuntimeChainEntries(limit: number, threadId?: string | null): Promise<RuntimeChainEntry[]>;
  listRuntimeChainsByCanonicalState(
    state: RuntimeChainCanonicalState,
    limit: number,
    threadId?: string | null
  ): Promise<RuntimeChainEntry[]>;
  listWorkerSessions(limit: number, threadId?: string | null): Promise<WorkerSessionRecord[]>;
  loadRuntimeSummary(threadId: string | null, limit: number): Promise<RuntimeSummaryReport>;
  listStaleRuntimeChainEntries(limit: number, threadId?: string | null): Promise<RuntimeChainEntry[]>;
  loadRuntimeChainDetail(
    chainId: string,
    eventLimit?: number
  ): Promise<{
    chain: unknown;
    status: unknown;
    spans: unknown[];
    events: unknown[];
  } | null>;
}

export function createRuntimeQueryService(input: {
  clock: Clock;
  workerRuntime: WorkerRuntime;
  getWorkerStartupReconcileResult?: () => { totalSessions: number; downgradedRunningSessions: number } | undefined;
  getWorkerBindingReconcileResult?: () =>
    | {
        totalRoleRuns: number;
        totalBindings: number;
        clearedMissingBindings: number;
        clearedTerminalBindings: number;
        clearedCrossThreadBindings: number;
        roleRunsNeedingAttention: number;
        roleRunsRequeued: number;
        roleRunsFailed: number;
      }
    | undefined;
  getRoleRunStartupRecoveryResult?: () =>
    | {
        totalRoleRuns: number;
        restartedQueuedRuns: number;
        restartedRunningRuns: number;
        restartedResumingRuns: number;
        restartedRunKeys: string[];
        orphanedThreadRuns: number;
        failedOrphanedRuns: number;
        failedRunKeys: string[];
        clearedInvalidHandoffs: number;
        queuedRunsIdled: number;
      }
    | undefined;
  getFlowRecoveryStartupReconcileResult?: () =>
    | {
        orphanedFlows: number;
        abortedOrphanedFlows: number;
        orphanedRecoveryRuns: number;
        missingFlowRecoveryRuns: number;
        crossThreadFlowRecoveryRuns: number;
        failedRecoveryRuns: number;
        affectedFlowIds: string[];
        affectedRecoveryRunIds: string[];
      }
    | undefined;
  getRuntimeChainStartupReconcileResult?: () =>
    | {
        orphanedThreadChains: number;
        missingFlowChains: number;
        crossThreadFlowChains: number;
        affectedChainIds: string[];
      }
    | undefined;
  getRuntimeChainArtifactStartupReconcileResult?: () =>
    | {
        orphanedStatuses: number;
        crossThreadStatuses: number;
        orphanedSpans: number;
        crossThreadSpans: number;
        crossFlowSpans: number;
        orphanedEvents: number;
        missingSpanEvents: number;
        crossThreadEvents: number;
        crossChainEvents: number;
        affectedChainIds: string[];
      }
    | undefined;
  teamThreadStore: FileTeamThreadStore;
  flowLedgerStore: FileFlowLedgerStore;
  roleRunStore: FileRoleRunStore;
  runtimeChainStore: FileRuntimeChainStore;
  runtimeChainStatusStore: FileRuntimeChainStatusStore;
  runtimeChainSpanStore: FileRuntimeChainSpanStore;
  runtimeChainEventStore: FileRuntimeChainEventStore;
  runtimeProgressStore: FileRuntimeProgressStore;
  recoveryRunStore: FileRecoveryRunStore;
  recoveryRunEventStore: FileRecoveryRunEventStore;
  loadRecoveryRuntime(threadId: string): Promise<RecoveryRuntimeSnapshot>;
}): RuntimeQueryService {
  const {
    clock,
    workerRuntime,
    getWorkerStartupReconcileResult,
    getWorkerBindingReconcileResult,
    getRoleRunStartupRecoveryResult,
    getFlowRecoveryStartupReconcileResult,
    getRuntimeChainStartupReconcileResult,
    getRuntimeChainArtifactStartupReconcileResult,
    teamThreadStore,
    flowLedgerStore,
    roleRunStore,
    runtimeChainStore,
    runtimeChainStatusStore,
    runtimeChainSpanStore,
    runtimeChainEventStore,
    runtimeProgressStore,
    recoveryRunStore,
    recoveryRunEventStore,
    loadRecoveryRuntime,
  } = input;

  async function loadWorkerStatesByRunKey(roleRuns: RoleRunState[]): Promise<Map<string, WorkerSessionState>> {
    const workerRunKeys = [
      ...new Set(
        roleRuns.flatMap((run) =>
          Object.values(run.workerSessions ?? {}).filter((workerRunKey): workerRunKey is string => Boolean(workerRunKey))
        )
      ),
    ];
    const states = await Promise.all(
      workerRunKeys.map(async (workerRunKey) => [workerRunKey, await workerRuntime.getState(workerRunKey)] as const)
    );
    return new Map(states.filter((entry): entry is readonly [string, WorkerSessionState] => Boolean(entry[1])));
  }

  async function buildWorkerSessionHealth(threadId?: string | null): Promise<RuntimeSummaryReport["workerSessionHealth"] | undefined> {
    if (!workerRuntime.listSessions) {
      return undefined;
    }
    const [sessions, scopedRoleRuns] = await Promise.all([
      workerRuntime.listSessions(),
      threadId ? roleRunStore.listByThread(threadId) : listAllRoleRuns(),
    ]);
    const scopedSessions = sessions.filter((record) => {
      if (!threadId) {
        return true;
      }
      return record.context?.threadId === threadId;
    });
    const boundWorkerRunKeys = new Set(
      scopedRoleRuns.flatMap((run) =>
        Object.values(run.workerSessions ?? {}).filter((workerRunKey): workerRunKey is string => Boolean(workerRunKey))
      )
    );
    const activeSessions = scopedSessions.filter((record) => !isTerminalWorkerStatus(record)).length;
    const orphanedSessions = scopedSessions.filter(
      (record) => !isTerminalWorkerStatus(record) && record.context?.threadId && !boundWorkerRunKeys.has(record.workerRunKey)
    ).length;
    const missingContextSessions = scopedSessions.filter(
      (record) => !isTerminalWorkerStatus(record) && !record.context?.threadId
    ).length;
    return {
      totalSessions: scopedSessions.length,
      activeSessions,
      orphanedSessions,
      missingContextSessions,
    };
  }

  async function listWorkerSessions(limit: number, threadId?: string | null): Promise<WorkerSessionRecord[]> {
    if (!workerRuntime.listSessions) {
      return [];
    }
    const sessions = await workerRuntime.listSessions();
    return sessions
      .filter((record) => {
        if (!threadId) {
          return true;
        }
        return record.context?.threadId === threadId;
      })
      .sort((left, right) => right.state.updatedAt - left.state.updatedAt)
      .slice(0, limit);
  }

  async function listAllRoleRuns(): Promise<RoleRunState[]> {
    const threads = await teamThreadStore.list();
    return (await Promise.all(threads.map((thread) => roleRunStore.listByThread(thread.threadId)))).flat();
  }

  function buildFallbackRuntimeChainStatus(chain: {
    chainId: string;
    threadId: string;
    updatedAt: number;
  }): RuntimeChainStatus {
    return {
      chainId: chain.chainId,
      threadId: chain.threadId,
      phase: "started",
      latestSummary: "Runtime chain created.",
      attention: false,
      updatedAt: chain.updatedAt,
    };
  }

  async function loadRuntimeChainEntriesForThread(threadId: string): Promise<RuntimeChainEntry[]> {
    const [storedChains, storedStatuses, progressEvents, flows, roleRuns, recoveryRuntime] = await Promise.all([
      runtimeChainStore.listByThread(threadId),
      runtimeChainStatusStore.listByThread(threadId),
      runtimeProgressStore.listByThread(threadId, 500),
      flowLedgerStore.listByThread(threadId),
      roleRunStore.listByThread(threadId),
      loadRecoveryRuntime(threadId),
    ]);
    const workerStatesByRunKey = await loadWorkerStatesByRunKey(roleRuns);
    const flowsById = new Map(flows.map((flow) => [flow.flowId, flow]));
    const progressByChainId = new Map<string, typeof progressEvents>();
    for (const event of progressEvents) {
      if (!event.chainId) {
        continue;
      }
      const current = progressByChainId.get(event.chainId) ?? [];
      current.push(event);
      progressByChainId.set(event.chainId, current);
    }

    return [
      ...storedChains.map((chain) => {
        const chainProgressEvents = progressByChainId.get(chain.chainId);
        const status =
          storedStatuses.find((entry) => entry.chainId === chain.chainId) ??
          buildFallbackRuntimeChainStatus(chain);
        if (chain.rootKind !== "flow") {
          const decorateInput: Parameters<typeof decorateRuntimeChainStatus>[0] = {
            chain,
            status,
            records: recoveryRuntime.records,
          };
          if (chainProgressEvents) {
            decorateInput.progressEvents = chainProgressEvents;
          }
          return {
            chain,
            status: decorateRuntimeChainStatus(decorateInput),
          };
        }
        const augmented = buildAugmentedFlowRuntimeChainEntry({
          chain,
          status,
          flow: flowsById.get(chain.rootId) ?? null,
          records: recoveryRuntime.records,
          roleRuns,
          workerStatesByRunKey,
        });
        const decorateInput: Parameters<typeof decorateRuntimeChainStatus>[0] = {
          chain: augmented.chain,
          status: augmented.status,
          flow: flowsById.get(chain.rootId) ?? null,
          records: recoveryRuntime.records,
        };
        if (chainProgressEvents) {
          decorateInput.progressEvents = chainProgressEvents;
        }
        return {
          chain: augmented.chain,
          status: decorateRuntimeChainStatus(decorateInput),
        };
      }),
      ...recoveryRuntime.runs.map((run) => {
        const derived = buildDerivedRecoveryRuntimeChain(run);
        const chainProgressEvents = progressByChainId.get(derived.chain.chainId);
        const decorateInput: Parameters<typeof decorateRuntimeChainStatus>[0] = {
          chain: derived.chain,
          status: derived.status,
          recoveryRun: run,
          records: recoveryRuntime.records,
        };
        if (chainProgressEvents) {
          decorateInput.progressEvents = chainProgressEvents;
        }
        return {
          chain: derived.chain,
          status: decorateRuntimeChainStatus(decorateInput),
        };
      }),
    ].sort((left, right) => right.status.updatedAt - left.status.updatedAt);
  }

  async function loadRuntimeChainEntriesForScope(threadId?: string | null): Promise<RuntimeChainEntry[]> {
    if (threadId) {
      return loadRuntimeChainEntriesForThread(threadId);
    }
    const threads = await teamThreadStore.list();
    return (await Promise.all(threads.map((thread) => loadRuntimeChainEntriesForThread(thread.threadId))))
      .flat()
      .sort((left, right) => right.status.updatedAt - left.status.updatedAt);
  }

  return {
    async listRuntimeChainEntriesByThread(threadId: string, limit: number): Promise<RuntimeChainEntry[]> {
      const entries = await loadRuntimeChainEntriesForThread(threadId);
      return entries.slice(0, limit);
    },

    async listActiveRuntimeChainEntries(limit: number, threadId?: string | null): Promise<RuntimeChainEntry[]> {
      return (await loadRuntimeChainEntriesForScope(threadId))
        .filter((entry) => !["resolved", "failed"].includes(entry.status.canonicalState ?? "open"))
        .slice(0, limit);
    },

    async listRuntimeChainsByCanonicalState(
      state: RuntimeChainCanonicalState,
      limit: number,
      threadId?: string | null
    ): Promise<RuntimeChainEntry[]> {
      return (await loadRuntimeChainEntriesForScope(threadId))
        .filter((entry) => entry.status.canonicalState === state)
        .slice(0, limit);
    },

    listWorkerSessions,

    async loadRuntimeSummary(threadId: string | null, limit: number): Promise<RuntimeSummaryReport> {
      const [entries, workerSessionHealth] = await Promise.all([
        loadRuntimeChainEntriesForScope(threadId),
        buildWorkerSessionHealth(threadId),
      ]);
      const report = buildRuntimeSummaryReport({
        entries,
        limit,
        now: clock.now(),
      });
      const workerStartupReconcile = getWorkerStartupReconcileResult?.();
      const workerBindingReconcile = getWorkerBindingReconcileResult?.();
      const roleRunStartupRecovery = getRoleRunStartupRecoveryResult?.();
      const flowRecoveryStartupReconcile = getFlowRecoveryStartupReconcileResult?.();
      const runtimeChainStartupReconcile = getRuntimeChainStartupReconcileResult?.();
      const runtimeChainArtifactStartupReconcile = getRuntimeChainArtifactStartupReconcileResult?.();
      return workerStartupReconcile
        ? {
            ...report,
            workerStartupReconcile,
            ...(workerSessionHealth ? { workerSessionHealth } : {}),
            ...(workerBindingReconcile ? { workerBindingReconcile } : {}),
            ...(roleRunStartupRecovery ? { roleRunStartupRecovery } : {}),
            ...(flowRecoveryStartupReconcile ? { flowRecoveryStartupReconcile } : {}),
            ...(runtimeChainStartupReconcile ? { runtimeChainStartupReconcile } : {}),
            ...(runtimeChainArtifactStartupReconcile ? { runtimeChainArtifactStartupReconcile } : {}),
          }
        : workerSessionHealth
          ? {
              ...report,
              workerSessionHealth,
              ...(workerBindingReconcile ? { workerBindingReconcile } : {}),
              ...(roleRunStartupRecovery ? { roleRunStartupRecovery } : {}),
              ...(flowRecoveryStartupReconcile ? { flowRecoveryStartupReconcile } : {}),
              ...(runtimeChainStartupReconcile ? { runtimeChainStartupReconcile } : {}),
              ...(runtimeChainArtifactStartupReconcile ? { runtimeChainArtifactStartupReconcile } : {}),
            }
          : workerBindingReconcile
            ? {
                ...report,
                workerBindingReconcile,
                ...(roleRunStartupRecovery ? { roleRunStartupRecovery } : {}),
                ...(flowRecoveryStartupReconcile ? { flowRecoveryStartupReconcile } : {}),
                ...(runtimeChainStartupReconcile ? { runtimeChainStartupReconcile } : {}),
                ...(runtimeChainArtifactStartupReconcile ? { runtimeChainArtifactStartupReconcile } : {}),
              }
            : roleRunStartupRecovery
              ? {
                  ...report,
                  roleRunStartupRecovery,
                  ...(flowRecoveryStartupReconcile ? { flowRecoveryStartupReconcile } : {}),
                  ...(runtimeChainStartupReconcile ? { runtimeChainStartupReconcile } : {}),
                  ...(runtimeChainArtifactStartupReconcile ? { runtimeChainArtifactStartupReconcile } : {}),
                }
              : flowRecoveryStartupReconcile
                ? {
                    ...report,
                    flowRecoveryStartupReconcile,
                    ...(runtimeChainStartupReconcile ? { runtimeChainStartupReconcile } : {}),
                    ...(runtimeChainArtifactStartupReconcile ? { runtimeChainArtifactStartupReconcile } : {}),
                  }
                : runtimeChainStartupReconcile
                  ? {
                      ...report,
                      runtimeChainStartupReconcile,
                      ...(runtimeChainArtifactStartupReconcile ? { runtimeChainArtifactStartupReconcile } : {}),
                    }
                  : runtimeChainArtifactStartupReconcile
                    ? {
                        ...report,
                        runtimeChainArtifactStartupReconcile,
                      }
                : report;
    },

    async listStaleRuntimeChainEntries(limit: number, threadId?: string | null): Promise<RuntimeChainEntry[]> {
      return (await loadRuntimeChainEntriesForScope(threadId))
        .filter((entry) => Boolean(entry.status.stale))
        .slice(0, limit);
    },

    async loadRuntimeChainDetail(
      chainId: string,
      eventLimit = 50
    ): Promise<{
      chain: unknown;
      status: unknown;
      spans: unknown[];
      events: unknown[];
    } | null> {
      if (isRecoveryRuntimeChainId(chainId)) {
        const run = await recoveryRunStore.get(chainId);
        if (!run) {
          return null;
        }
        const [records, events, progressEvents] = await Promise.all([
          input.loadRecoveryRuntime(run.threadId).then((snapshot) => snapshot.records),
          recoveryRunEventStore.listByRecoveryRun(run.recoveryRunId),
          runtimeProgressStore.listByChain(chainId, 100),
        ]);
        const detail = buildDerivedRecoveryRuntimeChainDetail({
          run,
          records,
          events,
        });
        return {
          ...detail,
          status: decorateRuntimeChainStatus({
            chain: detail.chain,
            status: detail.status,
            recoveryRun: run,
            records,
            progressEvents,
          }),
        };
      }

      const [chain, status] = await Promise.all([
        runtimeChainStore.get(chainId),
        runtimeChainStatusStore.get(chainId),
      ]);
      if (!chain) {
        return null;
      }
      const [spans, events, progressEvents] = await Promise.all([
        runtimeChainSpanStore.listByChain(chainId),
        runtimeChainEventStore.listByChain(chainId, eventLimit),
        runtimeProgressStore.listByChain(chainId, 100),
      ]);
      if (chain.rootKind !== "flow") {
        return {
          chain,
          status:
            status == null
              ? null
              : decorateRuntimeChainStatus({
                  chain,
                  status,
                  progressEvents,
                }),
          spans,
          events,
        };
      }

      const [flow, roleRuns, records] = await Promise.all([
        flowLedgerStore.get(chain.rootId),
        roleRunStore.listByThread(chain.threadId),
        input.loadRecoveryRuntime(chain.threadId).then((snapshot) => snapshot.records),
      ]);
      const workerStatesByRunKey = await loadWorkerStatesByRunKey(roleRuns);
      return buildAugmentedFlowRuntimeChainDetail({
        chain,
        status: status ?? {
          chainId: chain.chainId,
          threadId: chain.threadId,
          phase: "started",
          latestSummary: "Flow chain created.",
          attention: false,
          updatedAt: chain.updatedAt,
        },
        spans,
        events,
        flow,
        records,
        roleRuns,
        workerStatesByRunKey,
        now: clock.now(),
        progressEvents,
      });
    },
  };
}

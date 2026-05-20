// PR C — composition aftercare.
//
// `handleInspectionRoutes` requires a 28-method `InspectionRouteDeps` object.
// Previously daemon.ts built that object inline at the route-dispatch site —
// ~250 lines of arrow functions wired to stores, services, and report
// builders, deeply embedded in the HTTP request handler. That inlining made
// daemon.ts hard to navigate and obscured what the inspection surface
// actually depends on.
//
// This module owns the wiring. The single export `createInspectionRouteDeps`
// takes the composed `foundations` + `runtimeServices` objects (plus a few
// startup-time scalars) and returns the InspectionRouteDeps record. daemon.ts
// constructs it once at startup and passes the result into the
// handleInspectionRoutes call.
//
// Why not put this in runtime-query-service? Because runtimeQueryService is
// concerned with runtime-chain / worker-session / startup-reconcile queries —
// it's a leaf provider. The inspection-deps record is a *composition* layer
// that mixes runtimeQueryService with replay/recovery/governance/relay
// concerns specifically for the inspection-routes consumer. Different layer,
// different home.

import type {
  InspectionRouteDeps,
} from "../routes/inspection-routes";
import {
  buildFlowConsoleReport,
  buildGovernanceConsoleReport,
  buildOperatorAttentionReport,
  buildOperatorSummaryReport,
  buildOperatorTriageReport,
  buildRecoveryConsoleReport,
} from "@turnkeyai/qc-runtime/operator-inspection";
import { buildPromptConsoleReport } from "@turnkeyai/qc-runtime/prompt-inspection";
import {
  buildReplayConsoleReport,
  buildReplayInspectionReport,
} from "@turnkeyai/qc-runtime/replay-inspection";
import { createNativeToolCapabilityRegistry } from "@turnkeyai/role-runtime/tool-capability-registry";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import type { RelayControlPlane } from "@turnkeyai/browser-bridge/transport/transport-adapter";

import type { DaemonFoundations } from "./foundations";
import type { DaemonRuntimeServices } from "./runtime-services";

/**
 * Snapshot of the relay gateway's current peer/target/action state. Consumed
 * by the operator and replay report builders (both inspection-deps and
 * recovery-deps need it). Returns `undefined` when no relay gateway is
 * configured — the report builders are designed to handle that branch.
 *
 * Exported so sibling composition modules (recovery-deps) can use the same
 * helper instead of duplicating the shape.
 */
export function getRelayDiagnosticsSnapshot(relayGateway: RelayControlPlane | null) {
  if (!relayGateway) return undefined;
  return {
    peers: relayGateway.listPeers(),
    targets: relayGateway.listTargets(),
    actions: relayGateway.listActionRequests().map((action) => ({
      actionRequestId: action.actionRequestId,
      browserSessionId: action.browserSessionId,
      taskId: action.taskId,
      ...(action.relayTargetId ? { relayTargetId: action.relayTargetId } : {}),
      ...(action.targetId ? { targetId: action.targetId } : {}),
      actionKinds: [...action.actionKinds],
      createdAt: action.createdAt,
      expiresAt: action.expiresAt,
      state: action.state,
      ...(action.preferredPeerId ? { preferredPeerId: action.preferredPeerId } : {}),
      ...(action.lockedPeerId ? { lockedPeerId: action.lockedPeerId } : {}),
      ...(action.assignedPeerId ? { assignedPeerId: action.assignedPeerId } : {}),
      ...(action.claimExpiresAt !== undefined ? { claimExpiresAt: action.claimExpiresAt } : {}),
      attemptCount: action.attemptCount,
      reclaimCount: action.reclaimCount,
      ...(action.lastClaimExpiredAt !== undefined ? { lastClaimExpiredAt: action.lastClaimExpiredAt } : {}),
    })),
  };
}

export interface InspectionDepsInputs {
  foundations: DaemonFoundations;
  runtimeServices: DaemonRuntimeServices;
  /**
   * Resolved at startup. When null, the daemon is in heuristic-only mode and
   * listModels returns the corresponding shape.
   */
  modelCatalogPath: string | null;
}

export function createInspectionRouteDeps(
  inputs: InspectionDepsInputs
): InspectionRouteDeps {
  const {
    foundations: {
      teamThreadStore,
      teamMessageStore,
      teamRouteMap,
      teamEventBus,
      flowLedgerStore,
      roleRunStore,
      runtimeProgressStore,
      threadSessionMemoryStore,
      permissionCacheStore,
      replayRecorder,
      capabilityDiscoveryService,
      workerHandlers,
      relayGateway,
    },
    runtimeServices: {
      runtimeQueryService,
      recoveryActionService,
      llmGateway,
    },
    modelCatalogPath,
  } = inputs;

  return {
    listThreads: () => teamThreadStore.list(),
    listRecentEvents: (threadId, limit) => teamEventBus.listRecent(threadId, limit),
    resolveExternalRoute: (channelId, userId) => teamRouteMap.findByExternalActor(channelId, userId),
    listMessages: (threadId) => teamMessageStore.list(threadId),
    listFlows: async (threadId, limit) => (await flowLedgerStore.listByThread(threadId)).slice(0, limit),
    buildFlowSummary: async (threadId) => buildFlowConsoleReport(await flowLedgerStore.listByThread(threadId)),
    listRuntimeChainsByThread: (threadId, limit) =>
      runtimeQueryService.listRuntimeChainEntriesByThread(threadId, limit),
    listActiveRuntimeChains: (limit, threadId) =>
      runtimeQueryService.listActiveRuntimeChainEntries(limit, threadId),
    loadRuntimeSummary: (threadId, limit) => runtimeQueryService.loadRuntimeSummary(threadId, limit),
    listWorkerSessions: (limit, threadId) => runtimeQueryService.listWorkerSessions(limit, threadId),
    listRuntimeChainsByCanonicalState: (state, limit, threadId) =>
      runtimeQueryService.listRuntimeChainsByCanonicalState(state, limit, threadId),
    listStaleRuntimeChains: (limit, threadId) => runtimeQueryService.listStaleRuntimeChainEntries(limit, threadId),
    listRuntimeProgressByThread: (threadId, limit) => runtimeProgressStore.listByThread(threadId, limit),
    loadRuntimeChainDetail: (chainId, limit) => runtimeQueryService.loadRuntimeChainDetail(chainId, limit),
    listRuntimeProgressByChain: (chainId, limit) => runtimeProgressStore.listByChain(chainId, limit),
    listRoleRuns: (threadId) => roleRunStore.listByThread(threadId),
    getSessionMemory: (threadId) => threadSessionMemoryStore.get(threadId),
    listModels: () => buildModelsReport(llmGateway, modelCatalogPath),
    inspectCapabilities: async (threadId, roleId, requestedCapabilities) => {
      const inspection = await capabilityDiscoveryService.inspect({
        threadId,
        roleId,
        requestedCapabilities,
      });
      const registry = createNativeToolCapabilityRegistry({
        availableWorkerKinds: workerHandlers.map((handler) => handler.kind),
      });
      return {
        ...inspection,
        toolCapabilities: registry.summaries(),
      };
    },
    listGovernancePermissions: (threadId) => permissionCacheStore.listByThread(threadId),
    buildGovernanceSummary: async (threadId, limit) => {
      const [permissionRecords, events] = await Promise.all([
        permissionCacheStore.listByThread(threadId),
        teamEventBus.listRecent(threadId, Math.max(limit, 200)),
      ]);
      return buildGovernanceConsoleReport(permissionRecords, events, limit);
    },
    buildRecoverySummary: async (threadId, limit) => {
      const synced = await recoveryActionService.loadRecoveryRuntime(threadId);
      return buildRecoveryConsoleReport(synced.runs, limit);
    },
    buildPromptConsole: async (threadId, limit) => {
      const progressEvents = await runtimeProgressStore.listByThread(threadId);
      return buildPromptConsoleReport(progressEvents, limit);
    },
    buildOperatorSummary: async (threadId, limit) => {
      const snapshot = await loadOperatorInspectionSnapshot(
        {
          flowLedgerStore,
          permissionCacheStore,
          teamEventBus,
          recoveryActionService,
          runtimeProgressStore,
          runtimeQueryService,
          relayGateway,
        },
        threadId,
        limit,
      );
      return summaryReportFromSnapshot(snapshot, limit);
    },
    buildOperatorAttention: async (threadId, limit) => {
      const snapshot = await loadOperatorInspectionSnapshot(
        {
          flowLedgerStore,
          permissionCacheStore,
          teamEventBus,
          recoveryActionService,
          runtimeProgressStore,
          runtimeQueryService,
          relayGateway,
        },
        threadId,
        limit,
      );
      return attentionReportFromSnapshot(snapshot, limit);
    },
    buildOperatorTriage: async (threadId, limit) => {
      // Load every store/runtime read ONCE per triage request. The previous
      // implementation fanned out two IIFEs (for summary + attention) each
      // doing its own Promise.all of 5–6 reads, plus a third runtimeSummary
      // call in the outer Promise.all — totaling 12 store/runtime hits per
      // triage. With the shared snapshot we do 6, and summary + attention
      // both derive from the same in-memory data so they're inherently
      // consistent with each other (no more "what if a flow appeared between
      // the two reads" interleaving).
      //
      // limit semantics preserved: summary uses `limit`; attention's
      // sub-call (inside triage) widens to `Math.max(limit, 10)` because
      // operators want a slightly broader attention list when on the triage
      // overview page even when the caller asked for a tight summary.
      const snapshot = await loadOperatorInspectionSnapshot(
        {
          flowLedgerStore,
          permissionCacheStore,
          teamEventBus,
          recoveryActionService,
          runtimeProgressStore,
          runtimeQueryService,
          relayGateway,
        },
        threadId,
        limit,
      );
      const summary = summaryReportFromSnapshot(snapshot, limit);
      const attention = attentionReportFromSnapshot(snapshot, Math.max(limit, 10));
      return buildOperatorTriageReport({
        summary,
        attention,
        runtime: snapshot.runtimeSummary,
        limit,
      });
    },
    listGovernanceAudits: async (threadId, limit) => {
      const events = await teamEventBus.listRecent(threadId, limit);
      return events.filter((event) => event.kind === "audit.logged");
    },
    listGovernanceWorkerAudits: async (threadId, limit) => {
      const events = await teamEventBus.listRecent(threadId, limit);
      return events.filter(
        (event) =>
          event.kind === "audit.logged" &&
          typeof event.payload.scope === "string" &&
          event.payload.scope === "worker_execution"
      );
    },
    listReplays: ({ threadId, layer, limit }) =>
      replayRecorder.list({
        ...(threadId ? { threadId } : {}),
        ...(layer && ["scheduled", "role", "worker", "browser"].includes(layer)
          ? { layer: layer as "scheduled" | "role" | "worker" | "browser" }
          : {}),
        limit,
      }),
    buildReplaySummary: async (threadId, limit) =>
      buildReplayInspectionReport(
        await replayRecorder.list({
          ...(threadId ? { threadId } : {}),
          limit,
        })
      ),
    buildReplayConsole: async (threadId, limit) => {
      if (threadId) {
        const synced = await recoveryActionService.loadRecoveryRuntime(threadId);
        return buildReplayConsoleReport(synced.records, limit, synced.runs, getRelayDiagnosticsSnapshot(relayGateway));
      }
      return buildReplayConsoleReport(
        await replayRecorder.list({
          limit: Math.max(limit, 200),
        }),
        limit,
        [],
        getRelayDiagnosticsSnapshot(relayGateway)
      );
    },
  };
}

/**
 * One-shot read of every store + service the operator inspection surface
 * needs (summary, attention, triage). Exported only for the type — the
 * function is private to this module.
 *
 * Why a single helper instead of per-method reads: `buildOperatorTriage`
 * previously did 12 store/runtime reads per request (6 inside the summary
 * IIFE, 5 inside the attention IIFE, 1 extra outer loadRuntimeSummary). The
 * snapshot collapses that to 6 (one Promise.all batch) and as a bonus makes
 * summary + attention internally consistent — both observe the same point-in-
 * time data instead of potentially interleaving with concurrent writes.
 *
 * Standalone buildOperatorAttention now pays one extra read it didn't before
 * (runtimeSummary, which the attention report doesn't actually consume). The
 * cost is one parallel store call — irrelevant under Promise.all — and the
 * code-clarity win from a single shared snapshot is worth it. If profiling
 * ever shows runtimeSummary as a hot loader, this is the place to fork into
 * a slim attention snapshot.
 */
type OperatorInspectionSnapshotDeps = {
  flowLedgerStore: DaemonFoundations["flowLedgerStore"];
  permissionCacheStore: DaemonFoundations["permissionCacheStore"];
  teamEventBus: DaemonFoundations["teamEventBus"];
  recoveryActionService: DaemonRuntimeServices["recoveryActionService"];
  runtimeProgressStore: DaemonFoundations["runtimeProgressStore"];
  runtimeQueryService: DaemonRuntimeServices["runtimeQueryService"];
  relayGateway: DaemonFoundations["relayGateway"];
};

interface OperatorInspectionSnapshot {
  flows: Awaited<ReturnType<OperatorInspectionSnapshotDeps["flowLedgerStore"]["listByThread"]>>;
  permissionRecords: Awaited<
    ReturnType<OperatorInspectionSnapshotDeps["permissionCacheStore"]["listByThread"]>
  >;
  events: Awaited<ReturnType<OperatorInspectionSnapshotDeps["teamEventBus"]["listRecent"]>>;
  synced: Awaited<
    ReturnType<OperatorInspectionSnapshotDeps["recoveryActionService"]["loadRecoveryRuntime"]>
  >;
  progressEvents: Awaited<
    ReturnType<OperatorInspectionSnapshotDeps["runtimeProgressStore"]["listByThread"]>
  >;
  runtimeSummary: Awaited<
    ReturnType<OperatorInspectionSnapshotDeps["runtimeQueryService"]["loadRuntimeSummary"]>
  >;
  relayDiagnostics: ReturnType<typeof getRelayDiagnosticsSnapshot>;
}

async function loadOperatorInspectionSnapshot(
  deps: OperatorInspectionSnapshotDeps,
  threadId: string,
  limit: number,
): Promise<OperatorInspectionSnapshot> {
  const eventsLimit = Math.max(limit, 200);
  const runtimeSummaryLimit = Math.max(limit, 10);
  const [flows, permissionRecords, events, synced, progressEvents, runtimeSummary] = await Promise.all([
    deps.flowLedgerStore.listByThread(threadId),
    deps.permissionCacheStore.listByThread(threadId),
    deps.teamEventBus.listRecent(threadId, eventsLimit),
    deps.recoveryActionService.loadRecoveryRuntime(threadId),
    deps.runtimeProgressStore.listByThread(threadId),
    deps.runtimeQueryService.loadRuntimeSummary(threadId, runtimeSummaryLimit),
  ]);
  return {
    flows,
    permissionRecords,
    events,
    synced,
    progressEvents,
    runtimeSummary,
    relayDiagnostics: getRelayDiagnosticsSnapshot(deps.relayGateway),
  };
}

function summaryReportFromSnapshot(snapshot: OperatorInspectionSnapshot, limit: number) {
  const baseInput = {
    flows: snapshot.flows,
    permissionRecords: snapshot.permissionRecords,
    events: snapshot.events,
    replays: snapshot.synced.records,
    recoveryRuns: snapshot.synced.runs,
    progressEvents: snapshot.progressEvents,
    runtimeSummary: snapshot.runtimeSummary,
    limit,
  };
  return snapshot.relayDiagnostics
    ? buildOperatorSummaryReport({ ...baseInput, relayDiagnostics: snapshot.relayDiagnostics })
    : buildOperatorSummaryReport(baseInput);
}

function attentionReportFromSnapshot(snapshot: OperatorInspectionSnapshot, limit: number) {
  const baseInput = {
    flows: snapshot.flows,
    permissionRecords: snapshot.permissionRecords,
    events: snapshot.events,
    replays: snapshot.synced.records,
    recoveryRuns: snapshot.synced.runs,
    progressEvents: snapshot.progressEvents,
    limit,
  };
  return snapshot.relayDiagnostics
    ? buildOperatorAttentionReport({ ...baseInput, relayDiagnostics: snapshot.relayDiagnostics })
    : buildOperatorAttentionReport(baseInput);
}

async function buildModelsReport(llmGateway: LLMGateway | null, modelCatalogPath: string | null) {
  if (!llmGateway) {
    return {
      modelCatalogPath: null,
      models: [],
      adapterMode: "heuristic-only",
    };
  }
  const models = await llmGateway.listModels();
  return {
    modelCatalogPath,
    adapterMode: "llm+heuristic-fallback",
    models: models.map((model) => ({
      ...model,
      configured: Boolean(process.env[model.apiKeyEnv]),
    })),
  };
}

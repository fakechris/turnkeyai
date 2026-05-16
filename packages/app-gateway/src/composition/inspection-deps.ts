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
    inspectCapabilities: (threadId, roleId, requestedCapabilities) =>
      capabilityDiscoveryService.inspect({
        threadId,
        roleId,
        requestedCapabilities,
      }),
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
      const [flows, permissionRecords, events, synced, progressEvents, runtimeSummary] = await Promise.all([
        flowLedgerStore.listByThread(threadId),
        permissionCacheStore.listByThread(threadId),
        teamEventBus.listRecent(threadId, Math.max(limit, 200)),
        recoveryActionService.loadRecoveryRuntime(threadId),
        runtimeProgressStore.listByThread(threadId),
        runtimeQueryService.loadRuntimeSummary(threadId, Math.max(limit, 10)),
      ]);
      const relayDiagnostics = getRelayDiagnosticsSnapshot(relayGateway);
      return relayDiagnostics
        ? buildOperatorSummaryReport({
            flows,
            permissionRecords,
            events,
            replays: synced.records,
            recoveryRuns: synced.runs,
            progressEvents,
            runtimeSummary,
            relayDiagnostics,
            limit,
          })
        : buildOperatorSummaryReport({
            flows,
            permissionRecords,
            events,
            replays: synced.records,
            recoveryRuns: synced.runs,
            progressEvents,
            runtimeSummary,
            limit,
          });
    },
    buildOperatorAttention: async (threadId, limit) => {
      const [flows, permissionRecords, events, synced, progressEvents] = await Promise.all([
        flowLedgerStore.listByThread(threadId),
        permissionCacheStore.listByThread(threadId),
        teamEventBus.listRecent(threadId, Math.max(limit, 200)),
        recoveryActionService.loadRecoveryRuntime(threadId),
        runtimeProgressStore.listByThread(threadId),
      ]);
      const relayDiagnostics = getRelayDiagnosticsSnapshot(relayGateway);
      return relayDiagnostics
        ? buildOperatorAttentionReport({
            flows,
            permissionRecords,
            events,
            replays: synced.records,
            recoveryRuns: synced.runs,
            progressEvents,
            relayDiagnostics,
            limit,
          })
        : buildOperatorAttentionReport({
            flows,
            permissionRecords,
            events,
            replays: synced.records,
            recoveryRuns: synced.runs,
            progressEvents,
            limit,
          });
    },
    buildOperatorTriage: async (threadId, limit) => {
      const [summary, attention, runtime] = await Promise.all([
        (async () => {
          const [flows, permissionRecords, events, synced, progressEvents, runtimeSummary] = await Promise.all([
            flowLedgerStore.listByThread(threadId),
            permissionCacheStore.listByThread(threadId),
            teamEventBus.listRecent(threadId, Math.max(limit, 200)),
            recoveryActionService.loadRecoveryRuntime(threadId),
            runtimeProgressStore.listByThread(threadId),
            runtimeQueryService.loadRuntimeSummary(threadId, Math.max(limit, 10)),
          ]);
          const relayDiagnostics = getRelayDiagnosticsSnapshot(relayGateway);
          return relayDiagnostics
            ? buildOperatorSummaryReport({
                flows,
                permissionRecords,
                events,
                replays: synced.records,
                recoveryRuns: synced.runs,
                progressEvents,
                runtimeSummary,
                relayDiagnostics,
                limit,
              })
            : buildOperatorSummaryReport({
                flows,
                permissionRecords,
                events,
                replays: synced.records,
                recoveryRuns: synced.runs,
                progressEvents,
                runtimeSummary,
                limit,
              });
        })(),
        (async () => {
          const [flows, permissionRecords, events, synced, progressEvents] = await Promise.all([
            flowLedgerStore.listByThread(threadId),
            permissionCacheStore.listByThread(threadId),
            teamEventBus.listRecent(threadId, Math.max(limit, 200)),
            recoveryActionService.loadRecoveryRuntime(threadId),
            runtimeProgressStore.listByThread(threadId),
          ]);
          const relayDiagnostics = getRelayDiagnosticsSnapshot(relayGateway);
          return relayDiagnostics
            ? buildOperatorAttentionReport({
                flows,
                permissionRecords,
                events,
                replays: synced.records,
                recoveryRuns: synced.runs,
                progressEvents,
                relayDiagnostics,
                limit: Math.max(limit, 10),
              })
            : buildOperatorAttentionReport({
                flows,
                permissionRecords,
                events,
                replays: synced.records,
                recoveryRuns: synced.runs,
                progressEvents,
                limit: Math.max(limit, 10),
              });
        })(),
        runtimeQueryService.loadRuntimeSummary(threadId, Math.max(limit, 10)),
      ]);
      return buildOperatorTriageReport({
        summary,
        attention,
        runtime,
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

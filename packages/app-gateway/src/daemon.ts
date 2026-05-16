import http from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  BrowserContinuationHint,
  BrowserSessionOwnerType,
  BrowserTaskAction,
  BrowserTaskResult,
  BrowserTaskRequest,
  WorkerRuntime,
  Clock,
  DispatchContinuity,
  IdGenerator,
  RecoveryRun,
  RecoveryRunAction,
  RecoveryRunEvent,
  ReplayRecord,
  ReplayRecoveryPlan,
  RelayBriefBuilder,
  RoleRunState,
  RuntimeChain,
  RuntimeChainCanonicalState,
  RuntimeChainStatus,
  RuntimeSummaryReport,
  ScheduledTaskRecord,
  SummaryBuilder,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import {
  listBoundedRegressionCases,
  runBoundedRegressionSuite,
} from "@turnkeyai/qc-runtime/bounded-regression-harness";
import type {
  BrowserTransportSoakOptions,
  BrowserTransportSoakResult,
} from "@turnkeyai/qc-runtime/browser-transport-soak";
import { runBrowserTransportSoak } from "@turnkeyai/qc-runtime/browser-transport-soak";
import {
  listFailureInjectionScenarios,
  runFailureInjectionSuite,
} from "@turnkeyai/qc-runtime/failure-injection-suite";
import { classifyRuntimeError } from "@turnkeyai/qc-runtime/failure-taxonomy";
import {
  buildOperatorAttentionReport,
  buildFlowConsoleReport,
  buildGovernanceConsoleReport,
  buildOperatorSummaryReport,
  buildOperatorTriageReport,
  buildRecoveryConsoleReport,
} from "@turnkeyai/qc-runtime/operator-inspection";
import { buildPromptConsoleReport } from "@turnkeyai/qc-runtime/prompt-inspection";
import {
  attachRecoveryRunToReplayIncidentBundle,
  buildReplayConsoleReport,
  buildReplayIncidentBundle,
  buildReplayInspectionReport,
  buildReplayRecoveryPlans,
  buildRecoveryRunProgress,
  buildRecoveryRuns,
  buildRecoveryRunId,
  buildRecoveryRunTimeline,
  findReplayRecoveryPlan,
  findRecoveryRun,
  findReplayTaskSummary,
} from "@turnkeyai/qc-runtime/replay-inspection";
import {
  buildAugmentedFlowRuntimeChainDetail,
  buildAugmentedFlowRuntimeChainEntry,
  buildDerivedRecoveryRuntimeChain,
  buildDerivedRecoveryRuntimeChainDetail,
  buildRuntimeSummaryReport,
  decorateRuntimeChainStatus,
  isRecoveryRuntimeChainId,
} from "@turnkeyai/qc-runtime/runtime-chain-inspection";
import {
  listSoakScenarios,
  runSoakSuite,
} from "@turnkeyai/qc-runtime/soak-suite";
import {
  listRealWorldScenarios,
  runRealWorldSuite,
} from "@turnkeyai/qc-runtime/real-world-suite";
import {
  listScenarioParityAcceptanceScenarios,
  runScenarioParityAcceptanceSuite,
} from "@turnkeyai/qc-runtime/scenario-parity-acceptance";
import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { composeDaemonFoundations } from "./composition/foundations";
import { composeDaemonRuntimeServices } from "./composition/runtime-services";

import {
  parsePositiveInteger,
  parsePositiveLimit,
  readJsonBody,
  readOptionalJsonBody,
  sendJson,
} from "./http-helpers";
import {
  authorizeDaemonRequest,
  createRelayPeerIdentityBindingStore,
  resolveDaemonAuthConfig,
} from "./daemon-auth";
import {
  ensureDaemonAuthToken,
  ensureDaemonRuntimeDirs,
  getDaemonRuntimePaths,
  removePidFile,
  resolveDaemonDataDir,
  resolveDaemonPort,
  writePidFile,
} from "./daemon-runtime-paths";
import { createFileRouteIdempotencyStore } from "./idempotency-store";
import { createRecoveryActionService } from "./recovery-action-service";
import { buildRecoveryRunActionConflict } from "./recovery-run-guards";
import { createRuntimeQueryService } from "./runtime-query-service";
import { recoverRoleRunsOnStartup } from "./role-run-startup-recovery";
import {
  runRuntimeReconciliationPass,
  type RuntimeReconciliationPassResult,
} from "./runtime-reconciliation-pass";
import { reconcileWorkerBindingsOnStartup } from "./worker-binding-startup-reconcile";
import { handleBrowserRoutes, type BrowserTaskRouteBody } from "./routes/browser-routes";
import {
  buildBridgeStatus,
  handleBridgeRoutes,
  type BridgeStatusInfo,
} from "./routes/bridge-routes";
import { handleInspectionRoutes } from "./routes/inspection-routes";
import { handleRecoveryRoutes } from "./routes/recovery-routes";
import { handleRelayRoutes } from "./routes/relay-routes";
import { handleValidationRoutes } from "./routes/validation-routes";
import { handleWorkflowRoutes } from "./routes/workflow-routes";

if (wantsProcessHelp(process.argv.slice(2))) {
  printDaemonHelp(0);
}

const RUNTIME_PATHS = getDaemonRuntimePaths();
ensureDaemonRuntimeDirs(RUNTIME_PATHS);
const TOKEN_BOOTSTRAP = ensureDaemonAuthToken(RUNTIME_PATHS);
if (TOKEN_BOOTSTRAP.token && !process.env.TURNKEYAI_DAEMON_TOKEN) {
  process.env.TURNKEYAI_DAEMON_TOKEN = TOKEN_BOOTSTRAP.token;
}
const PORT = resolveDaemonPort(RUNTIME_PATHS);
const DATA_DIR = resolveDaemonDataDir(RUNTIME_PATHS);
const VALIDATION_ARTIFACT_DIR = path.join(DATA_DIR, "validation-artifacts");
const execFile = promisify(execFileCallback);
const DAEMON_AUTH = resolveDaemonAuthConfig(process.env);
const RECOVERY_RUN_STALE_AFTER_MS = 5 * 60 * 1000;
const RUNTIME_RECONCILIATION_INTERVAL_MS = 60_000;

const clock: Clock = {
  now: () => Date.now(),
};
const relayPeerBindingStore = createRelayPeerIdentityBindingStore({
  now: clock.now,
});

const idGenerator = createIdGenerator();
const recoveryRunActionMutex = new KeyedAsyncMutex<string>();
const routeIdempotencyStore = createFileRouteIdempotencyStore({
  rootDir: path.join(DATA_DIR, "route-idempotency"),
  now: clock.now,
});
type RuntimeChainEntry = { chain: RuntimeChain; status: RuntimeChainStatus };
const runtimeLimits = {
  memberMaxIterations: 6,
  flowMaxHops: 20,
  maxQueuedHandoffsPerRole: 4,
  maxPerRoleHopCount: 3,
};
const modelCatalogPath = await resolveModelCatalogPath();

const foundations = composeDaemonFoundations({
  dataDir: DATA_DIR,
  clock,
  idGenerator,
});
const {
  teamThreadStore,
  teamMessageStore,
  teamRouteMap,
  teamEventBus,
  flowLedgerStore,
  roleRunStore,
  runtimeChainStore,
  runtimeChainSpanStore,
  runtimeChainEventStore,
  runtimeChainStatusStore,
  runtimeProgressStore,
  threadSummaryStore,
  threadMemoryStore,
  threadSessionMemoryStore,
  sessionMemoryRefreshJobStore,
  threadJournalStore,
  roleScratchpadStore,
  workerEvidenceDigestStore,
  permissionCacheStore,
  recoveryRunStore,
  recoveryRunEventStore,
  scheduledTaskStore,
  validationOpsRunStore,
  workerSessionStore,
  summaryBuilder,
  relayBriefBuilder,
  recoveryDirector,
  apiExecutionVerifier,
  permissionGovernancePolicy,
  evidenceTrustPolicy,
  promptAdmissionPolicy,
  roleProfileRegistry,
  contextBudgeter,
  runtimeProgressRecorder,
  roleMemoryResolver,
  promptAssembler,
  contextCompressor,
  contextStateMaintainer,
  browserBridge,
  relayGateway,
  browserExpertLane,
  relayEndpointConfigured: RELAY_ENDPOINT_CONFIGURED,
  directCdpEndpoint: DIRECT_CDP_ENDPOINT,
  daemonPackageVersion: DAEMON_PACKAGE_VERSION,
  bridgeAmbientSessions,
  bridgeCommandDispatcher,
  bridgeAdvancedDispatcher,
  bridgeBatchDispatcher,
  bridgeExpertDispatcher,
  replayRecorder,
  workerHandlers,
  capabilityDiscoveryService,
  workerRegistry,
} = foundations;

function extractBridgeRequestToken(req: http.IncomingMessage): string | null {
  const headerToken = req.headers["x-turnkeyai-token"];
  if (typeof headerToken === "string" && headerToken.trim().length > 0) {
    return headerToken.trim();
  }
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

async function buildBridgeStatusSnapshot(): Promise<BridgeStatusInfo> {
  const sessions = await browserBridge.listSessions().catch(() => []);
  const relaySnapshot = relayGateway
    ? {
        configured: true,
        peers: relayGateway.listPeers(),
        targets: relayGateway.listTargets(),
        actions: relayGateway.listActionRequests(),
      }
    : {
        configured: RELAY_ENDPOINT_CONFIGURED,
        peers: [],
        targets: [],
        actions: [],
      };
  return buildBridgeStatus({
    port: PORT,
    version: DAEMON_PACKAGE_VERSION,
    dataDir: DATA_DIR,
    logsPath: RUNTIME_PATHS.logFile,
    configFile: RUNTIME_PATHS.configFile,
    transportMode: browserBridge.transportMode,
    transportLabel: browserBridge.transportLabel,
    relay: relaySnapshot,
    directCdp: {
      configured: Boolean(DIRECT_CDP_ENDPOINT) || browserBridge.transportMode === "direct-cdp",
      endpoint: DIRECT_CDP_ENDPOINT,
    },
    expertLane: browserExpertLane,
    sessionCount: sessions.length,
    now: clock.now(),
  });
}

function getRelayDiagnosticsSnapshot() {
  return relayGateway
    ? {
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
      }
    : undefined;
}
const runtimeServices = await composeDaemonRuntimeServices({
  foundations,
  dataDir: DATA_DIR,
  clock,
  idGenerator,
  modelCatalogPath,
  runtimeLimits,
  recoveryRunActionMutex,
  recoveryRunStaleAfterMs: RECOVERY_RUN_STALE_AFTER_MS,
  runtimeReconciliationIntervalMs: RUNTIME_RECONCILIATION_INTERVAL_MS,
});
const {
  workerRuntime,
  llmGateway,
  coordinationEngine,
  recoveryActionService,
  scheduledTaskRuntime,
  runtimeQueryService,
} = runtimeServices;

await mkdir(DATA_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        dataDir: DATA_DIR,
        modelCatalogPath,
      });
    }

    const authorization = authorizeDaemonRequest(req, url, DAEMON_AUTH);
    if (!authorization.authorized) {
      return sendJson(res, 401, {
        error: "unauthorized",
        authMode: DAEMON_AUTH.authMode,
        requiredAccess: authorization.requiredAccess,
      });
    }

    if (req.method === "POST" && url.pathname === "/threads/bootstrap-demo") {
      const body = await readJsonBody<{ variant?: string }>(req).catch(() => null);
      const variant = body?.variant ?? url.searchParams.get("variant") ?? "analyst";
      const roles = buildDemoRoles(variant);
      const thread = await teamThreadStore.create({
        teamName: `Demo Team (${variant})`,
        leadRoleId: "role-lead",
        roles,
      });
      await teamEventBus.publish({
        eventId: idGenerator.messageId(),
        threadId: thread.threadId,
        kind: "thread.created",
        createdAt: clock.now(),
        payload: {
          teamId: thread.teamId,
          teamName: thread.teamName,
        },
      });
      return sendJson(res, 201, thread);
    }

    if (
      await handleInspectionRoutes({
        req,
        res,
        url,
        deps: {
          listThreads: () => teamThreadStore.list(),
          listRecentEvents: (threadId, limit) => teamEventBus.listRecent(threadId, limit),
          resolveExternalRoute: (channelId, userId) => teamRouteMap.findByExternalActor(channelId, userId),
          listMessages: (threadId) => teamMessageStore.list(threadId),
          listFlows: async (threadId, limit) => (await flowLedgerStore.listByThread(threadId)).slice(0, limit),
          buildFlowSummary: async (threadId) => buildFlowConsoleReport(await flowLedgerStore.listByThread(threadId)),
          listRuntimeChainsByThread: (threadId, limit) => runtimeQueryService.listRuntimeChainEntriesByThread(threadId, limit),
          listActiveRuntimeChains: (limit, threadId) => runtimeQueryService.listActiveRuntimeChainEntries(limit, threadId),
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
          listModels: async () => {
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
          },
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
            const relayDiagnostics = getRelayDiagnosticsSnapshot();
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
            const relayDiagnostics = getRelayDiagnosticsSnapshot();
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
                const relayDiagnostics = getRelayDiagnosticsSnapshot();
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
                const relayDiagnostics = getRelayDiagnosticsSnapshot();
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
              return buildReplayConsoleReport(synced.records, limit, synced.runs, getRelayDiagnosticsSnapshot());
            }
            return buildReplayConsoleReport(
              await replayRecorder.list({
                limit: Math.max(limit, 200),
              }),
              limit,
              [],
              getRelayDiagnosticsSnapshot()
            );
          },
        },
      })
    ) {
      return;
    }

    if (
      await handleValidationRoutes({
        req,
        res,
        url,
        deps: {
          validationOpsRunStore,
          createValidationOpsRunId,
          writeValidationArtifact,
          runBrowserTransportSoakViaCli,
        },
      })
    ) {
      return;
    }

    if (
      await handleRecoveryRoutes({
        req,
        res,
        url,
        deps: {
          buildReplayIncidents: async ({ threadId, limit, action, category }) => {
            const report = buildReplayInspectionReport(
              await replayRecorder.list({
                ...(threadId ? { threadId } : {}),
                limit,
              })
            );
            return {
              totalReplays: report.totalReplays,
              totalGroups: report.totalGroups,
              incidents: report.incidents.filter(
                (incident) =>
                  (action ? incident.recoveryHint.action === action : true) &&
                  (category ? incident.rootFailureCategory === category : true)
              ),
            };
          },
          buildReplayRecoveries: async ({ threadId, limit, action }) => {
            const plans = buildReplayRecoveryPlans(
              await replayRecorder.list({
                ...(threadId ? { threadId } : {}),
                limit,
              })
            );
            return {
              totalRecoveries: plans.length,
              recoveries: plans.filter((plan) =>
                action ? plan.recoveryHint.action === action || plan.nextAction === action : true
              ),
            };
          },
          getReplayGroup: async (threadId, groupId) => {
            const records = await replayRecorder.list({ threadId });
            const report = buildReplayInspectionReport(records);
            const group = findReplayTaskSummary(records, groupId, report);
            if (!group) {
              return null;
            }
            const replays = records
              .filter((record) => (record.taskId ?? record.replayId) === group.groupId)
              .sort((left, right) => left.recordedAt - right.recordedAt);
            return { group, replays };
          },
          getReplayBundle: async (threadId, groupId) => {
            const synced = await recoveryActionService.loadRecoveryRuntime(threadId);
            const bundle = buildReplayIncidentBundle(
              synced.records,
              groupId,
              getRelayDiagnosticsSnapshot()
            );
            if (!bundle) {
              return null;
            }
            const recoveryRun = synced.runs.find((run) => run.sourceGroupId === bundle.group.groupId);
            if (recoveryRun) {
              attachRecoveryRunToReplayIncidentBundle({
                bundle,
                run: recoveryRun,
                records: synced.records,
                events: await recoveryRunEventStore.listByRecoveryRun(recoveryRun.recoveryRunId),
              });
            }
            return bundle;
          },
          getReplayRecovery: (threadId, groupId) => recoveryActionService.getReplayRecovery(threadId, groupId),
          listRecoveryRuns: (threadId) => recoveryActionService.listRecoveryRuns(threadId),
          getRecoveryRun: (threadId, recoveryRunId) => recoveryActionService.getRecoveryRun(threadId, recoveryRunId),
          getRecoveryTimeline: (threadId, recoveryRunId) =>
            recoveryActionService.getRecoveryTimeline(threadId, recoveryRunId),
          executeRecoveryRunAction: ({ threadId, recoveryRunId, action }) =>
            recoveryActionService.executeRecoveryRunActionById({ threadId, recoveryRunId, action }),
          dispatchReplayRecovery: ({ threadId, groupId }) =>
            recoveryActionService.dispatchReplayRecovery({ threadId, groupId }),
          getReplay: (replayId) => replayRecorder.get(replayId),
          idempotencyStore: routeIdempotencyStore,
        },
      })
    ) {
      return;
    }

    if (
      await handleBrowserRoutes({
        req,
        res,
        url,
        deps: {
          browserBridge,
          browserExpert: {
            expertLane: browserExpertLane,
          },
          idGenerator,
          clock,
          resolveBrowserThreadOwner,
          requireBrowserSessionAccess,
          buildBrowserTaskRequest,
        },
      })
    ) {
      return;
    }

    if (
      await handleBridgeRoutes({
        req,
        res,
        url,
        deps: {
          getStatusInfo: buildBridgeStatusSnapshot,
          commandDispatcher: bridgeCommandDispatcher,
          advancedDispatcher: bridgeAdvancedDispatcher,
          batchDispatcher: bridgeBatchDispatcher,
          expertDispatcher: bridgeExpertDispatcher,
          resolveToken: (request) => extractBridgeRequestToken(request),
        },
      })
    ) {
      return;
    }

    if (
      await handleRelayRoutes({
        req,
        res,
        url,
        relayGateway,
        authorization,
        relayPeerBindingStore,
      })
    ) {
      return;
    }

    if (
      await handleWorkflowRoutes({
        req,
        res,
        url,
        deps: {
          coordinationEngine,
          teamEventBus,
          scheduledTaskRuntime,
          idGenerator,
          clock,
          idempotencyStore: routeIdempotencyStore,
        },
      })
    ) {
      return;
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  try {
    writePidFile(RUNTIME_PATHS, process.pid);
  } catch {
    // best-effort; foreground/dev runs may not have write access
  }
  console.log(`daemon listening on http://127.0.0.1:${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log(`runtime dir: ${RUNTIME_PATHS.rootDir}`);
  console.log(`model catalog: ${modelCatalogPath ?? "(none)"}`);
  if (DAEMON_AUTH.authMode !== "disabled") {
    console.log("auth: token required via x-turnkeyai-token or Authorization: Bearer <token>");
    if (TOKEN_BOOTSTRAP.generated) {
      console.log(`auth: generated token written to ${RUNTIME_PATHS.configFile}`);
    }
    if (DAEMON_AUTH.authMode === "token-layered") {
      console.log("auth access levels: read / operator / admin");
      console.log("  TURNKEYAI_DAEMON_READ_TOKEN       Read-only inspection and replay routes");
      console.log("  TURNKEYAI_DAEMON_OPERATOR_TOKEN   Operator and browser action routes");
      console.log("  TURNKEYAI_BROWSER_RELAY_TOKEN     Relay peer mutation routes");
      console.log("  TURNKEYAI_DAEMON_ADMIN_TOKEN      Validation, relay query, and admin-only routes");
    }
  } else {
    console.log("auth: disabled (set TURNKEYAI_DAEMON_TOKEN to enable)");
  }
  console.log("quick start:");
  console.log(`  curl -X POST http://127.0.0.1:${PORT}/threads/bootstrap-demo`);
  console.log(
    `  curl -X POST http://127.0.0.1:${PORT}/messages -H 'content-type: application/json' -d '{"threadId":"<THREAD_ID>","content":"Please start the demo flow"}'`
  );
});

let shuttingDown = false;
function shutdownDaemon(signal: NodeJS.Signals | "exit"): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`daemon shutting down (${signal})`);
  // Stop the background reconciliation timer first so no new pass is
  // scheduled while the HTTP server is draining.
  runtimeServices.stop();
  const closeTimeout = setTimeout(() => {
    console.error("daemon shutdown timed out, exiting");
    removePidFile(RUNTIME_PATHS);
    process.exit(1);
  }, 10_000);
  closeTimeout.unref();
  server.close((closeError) => {
    clearTimeout(closeTimeout);
    if (closeError) {
      console.error(`daemon shutdown error: ${closeError.message}`);
    }
    removePidFile(RUNTIME_PATHS);
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdownDaemon("SIGTERM"));
process.on("SIGINT", () => shutdownDaemon("SIGINT"));
process.on("SIGHUP", () => shutdownDaemon("SIGHUP"));

function createIdGenerator(): IdGenerator {
  let seq = 0;
  const next = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;

  return {
    teamId: () => next("TEAM"),
    threadId: () => next("THREAD"),
    flowId: () => next("FLOW"),
    messageId: () => next("MSG"),
    taskId: () => next("TASK"),
  };
}

function createValidationOpsRunId(
  kind: "release-readiness" | "validation-profile" | "soak-series" | "transport-soak" | "phase1-baseline"
): string {
  return `validation-ops:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

async function writeValidationArtifact(kind: string, runId: string, payload: unknown): Promise<string> {
  const artifactPath = path.join(VALIDATION_ARTIFACT_DIR, kind, `${encodeURIComponent(runId)}.json`);
  await writeJsonFileAtomic(artifactPath, payload);
  return path.relative(process.cwd(), artifactPath);
}

async function runBrowserTransportSoakViaCli(
  options: BrowserTransportSoakOptions = {}
): Promise<BrowserTransportSoakResult> {
  return runBrowserTransportSoak(options, {
    runner: runBrowserTransportSoakSmokeCommand,
  });
}

async function runBrowserTransportSoakSmokeCommand(input: {
  target: "relay" | "direct-cdp";
  timeoutMs: number;
  relayPeerCount: number;
  verifyReconnect: boolean;
  verifyWorkflowLog: boolean;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr?: string;
  durationMs?: number;
}> {
  const commandArgs =
    input.target === "relay"
      ? buildRelayTransportSoakArgs(
          input.timeoutMs,
          input.relayPeerCount,
          input.verifyReconnect,
          input.verifyWorkflowLog
        )
      : buildDirectCdpTransportSoakArgs(input.timeoutMs, input.verifyReconnect, input.verifyWorkflowLog);
  const runStartedAt = Date.now();
  try {
    const { stdout, stderr } = await execFile("npm", commandArgs, {
      cwd: process.cwd(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - runStartedAt,
    };
  } catch (error) {
    const failure = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
      durationMs: Date.now() - runStartedAt,
    };
  }
}

function buildRelayTransportSoakArgs(
  timeoutMs: number,
  relayPeerCount: number,
  verifyReconnect: boolean,
  verifyWorkflowLog: boolean
): string[] {
  const args = ["run", "relay:smoke", "--", "--timeout-ms", String(timeoutMs), "--peer-count", String(relayPeerCount)];
  if (verifyReconnect) {
    args.push("--verify-reconnect");
  }
  if (verifyWorkflowLog) {
    args.push("--verify-workflow-log");
  }
  return args;
}

function buildDirectCdpTransportSoakArgs(
  timeoutMs: number,
  verifyReconnect: boolean,
  verifyWorkflowLog: boolean
): string[] {
  const args = ["run", "cdp:smoke", "--", "--timeout-ms", String(timeoutMs)];
  if (verifyReconnect) {
    args.push("--verify-reconnect");
  }
  if (verifyWorkflowLog) {
    args.push("--verify-workflow-log");
  }
  return args;
}

function buildDemoRoles(variant: string) {
  const lead = {
    roleId: "role-lead",
    name: "Lead",
    seat: "lead" as const,
    runtime: "local" as const,
    modelRef: "claude-opus",
    modelChain: "lead_reasoning",
  };

  if (variant === "coder") {
    return [
      lead,
      {
        roleId: "role-coder",
        name: "Coder",
        seat: "member" as const,
        runtime: "local" as const,
        modelRef: "gpt-5",
        modelChain: "builder_primary",
      },
    ];
  }

  if (variant === "finance") {
    return [
      lead,
      {
        roleId: "role-finance",
        name: "Finance",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["finance"],
        modelRef: "minimax",
        modelChain: "finance_primary",
      },
    ];
  }

  if (variant === "operator") {
    return [
      lead,
      {
        roleId: "role-operator",
        name: "Operator",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["browser"],
        modelRef: "gemini",
        modelChain: "browser_primary",
      },
    ];
  }

  if (variant === "pricing") {
    return [
      lead,
      {
        roleId: "role-explore",
        name: "Explore",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["explore"],
        modelRef: "gpt-5",
        modelChain: "explore_primary",
      },
      {
        roleId: "role-finance",
        name: "Finance",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["finance"],
        modelRef: "minimax",
        modelChain: "finance_primary",
      },
    ];
  }

  return [
    lead,
    {
      roleId: "role-analyst",
      name: "Analyst",
      seat: "member" as const,
      runtime: "local" as const,
      capabilities: ["explore"],
      modelRef: "kimi",
      modelChain: "analyst_primary",
    },
  ];
}

async function resolveModelCatalogPath(): Promise<string | null> {
  const candidates = [
    path.resolve(process.cwd(), "models.local.json"),
    path.resolve(process.cwd(), "models.json"),
    path.resolve(process.cwd(), "models.example.json"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  return null;
}

async function resolveBrowserThreadOwner(input: {
  threadId: string | null | undefined;
  ownerType?: string | null;
  ownerId?: string | null;
}):
  Promise<
    | { ownerType: BrowserSessionOwnerType; ownerId: string; threadId: string }
    | { statusCode: number; error: string }
  > {
  const threadId = input.threadId?.trim();
  if (!threadId) {
    return { statusCode: 400, error: "threadId is required" };
  }

  const thread = await teamThreadStore.get(threadId);
  if (!thread) {
    return { statusCode: 404, error: "thread not found" };
  }

  if (!input.ownerType && !input.ownerId) {
    return {
      threadId,
      ownerType: "thread",
      ownerId: threadId,
    };
  }

  if (!input.ownerType || !input.ownerId) {
    return { statusCode: 400, error: "ownerType and ownerId must be provided together" };
  }

  if (input.ownerType === "thread") {
    if (input.ownerId !== threadId) {
      return { statusCode: 403, error: "thread ownerId must match threadId" };
    }
    return {
      threadId,
      ownerType: "thread",
      ownerId: threadId,
    };
  }

  if (input.ownerType === "role") {
    if (!thread.roles.some((role) => role.roleId === input.ownerId)) {
      return { statusCode: 403, error: "role ownerId must belong to thread" };
    }
    return {
      threadId,
      ownerType: "role",
      ownerId: input.ownerId,
    };
  }

  return { statusCode: 403, error: `unsupported browser ownerType: ${input.ownerType}` };
}

async function requireBrowserSessionAccess(input: {
  browserSessionId: string;
  threadId: string | null | undefined;
}):
  Promise<
    | {
        sessionId: string;
        threadId: string;
        ownerType: BrowserSessionOwnerType;
        ownerId: string;
      }
    | { statusCode: number; error: string }
  > {
  const owner = await resolveBrowserThreadOwner({
    threadId: input.threadId,
  });
  if ("error" in owner) {
    return owner;
  }

  const session = (await browserBridge.listSessions()).find((item) => item.browserSessionId === input.browserSessionId) ?? null;
  if (!session) {
    return { statusCode: 404, error: "browser session not found" };
  }

  if (session.ownerType === "thread") {
    if (session.ownerId !== owner.threadId) {
      return { statusCode: 403, error: "browser session does not belong to thread" };
    }
  } else if (session.ownerType === "role") {
    if (!session.ownerId || !session.ownerId.length) {
      return { statusCode: 403, error: "browser session role owner is invalid" };
    }
    const thread = await teamThreadStore.get(owner.threadId);
    if (!thread?.roles.some((role) => role.roleId === session.ownerId)) {
      return { statusCode: 403, error: "browser session role owner does not belong to thread" };
    }
  } else {
    return { statusCode: 403, error: "browser session owner type is not externally addressable" };
  }

  return {
    sessionId: session.browserSessionId,
    threadId: owner.threadId,
    ownerType: session.ownerType,
    ownerId: session.ownerId,
  };
}

function buildBrowserTaskRequest(input: {
  body: BrowserTaskRouteBody;
  idGenerator: IdGenerator;
  owner: { ownerType?: BrowserSessionOwnerType; ownerId?: string };
  browserSessionId?: string;
}): BrowserTaskRequest {
  const threadId = input.body.threadId ?? input.owner.ownerId ?? `browser-thread:${clock.now()}`;
  const actions = buildBrowserTaskActions(input.body);
  return {
    taskId: input.body.taskId ?? input.idGenerator.taskId(),
    threadId,
    instructions:
      input.body.instructions ??
      (input.body.url ? `Open ${input.body.url}` : input.browserSessionId ? "Resume browser session" : "Open browser session"),
    actions,
    ...(input.browserSessionId ? { browserSessionId: input.browserSessionId } : {}),
    ...(input.body.targetId ? { targetId: input.body.targetId } : {}),
    ...(input.owner.ownerType ? { ownerType: input.owner.ownerType } : {}),
    ...(input.owner.ownerId ? { ownerId: input.owner.ownerId } : {}),
    ...(input.body.profileOwnerType ? { profileOwnerType: input.body.profileOwnerType } : {}),
    ...(input.body.profileOwnerId ? { profileOwnerId: input.body.profileOwnerId } : {}),
    ...(input.body.leaseHolderRunKey ? { leaseHolderRunKey: input.body.leaseHolderRunKey } : {}),
    ...(input.body.leaseTtlMs !== undefined ? { leaseTtlMs: input.body.leaseTtlMs } : {}),
  };
}

function buildBrowserTaskActions(body: BrowserTaskRouteBody): BrowserTaskAction[] {
  if (Array.isArray(body.actions) && body.actions.length > 0) {
    return body.actions;
  }

  if (body.url) {
    return [
      { kind: "open", url: body.url },
      { kind: "snapshot", note: "browser-session-runtime" },
    ];
  }

  return [{ kind: "snapshot", note: "resume-current-target" }];
}

function wantsProcessHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args.includes("help");
}

function printDaemonHelp(exitCode: number): never {
  const lines = [
    "TurnkeyAI Daemon",
    "",
    "Usage:",
    "  turnkeyai daemon",
    "  turnkeyai daemon --help",
    "",
    "Environment:",
    "  TURNKEYAI_DAEMON_PORT       Override the daemon listen port",
    "  TURNKEYAI_DATA_DIR          Override the daemon local data directory",
    "  TURNKEYAI_DAEMON_TOKEN      Require bearer auth for daemon requests",
    "  TURNKEYAI_DAEMON_READ_TOKEN Optional read-only daemon token",
    "  TURNKEYAI_DAEMON_OPERATOR_TOKEN Optional operator-scoped daemon token",
    "  TURNKEYAI_BROWSER_RELAY_TOKEN Optional relay-peer-scoped daemon token",
    "  TURNKEYAI_DAEMON_ADMIN_TOKEN Optional admin-scoped daemon token",
    "  TURNKEYAI_BROWSER_TRANSPORT Select browser transport: local | relay | direct-cdp",
    "  TURNKEYAI_BROWSER_CDP_ENDPOINT  CDP endpoint for direct-cdp transport",
    "  TURNKEYAI_BROWSER_CHROME_EXECUTABLE Optional browser executable override",
  ];
  const output = exitCode === 0 ? console.log : console.error;
  output(lines.join("\n"));
  process.exit(exitCode);
}

import http from "node:http";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  BrowserContinuationHint,
  BrowserSession,
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
  TeamEvent,
  TeamEventBus,
  ValidationOpsRunType,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import {
  createDesktopDaemonProof,
  isDesktopDaemonChallenge,
  isDesktopDaemonProofScope,
  type DesktopDaemonProofScope,
} from "@turnkeyai/shared-utils/desktop-daemon-proof";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import { FileBrowserArtifactStore } from "@turnkeyai/browser-bridge/artifacts/file-browser-artifact-store";
import {
  listBoundedRegressionCases,
  runBoundedRegressionSuite,
} from "@turnkeyai/qc-runtime/bounded-regression-harness";
import {
  listFailureInjectionScenarios,
  runFailureInjectionSuite,
} from "@turnkeyai/qc-runtime/failure-injection-suite";
import { classifyRuntimeError } from "@turnkeyai/qc-runtime/failure-taxonomy";
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
import {
  DEFAULT_DAEMON_RUNTIME_LIMITS,
  composeDaemonRuntimeServices,
} from "./composition/runtime-services";
import { createBrowserRouteHelpers } from "./composition/browser-route-helpers";
import { resolveControlCenterAssetDir } from "./composition/control-center-assets";
import { buildDemoRoles } from "./composition/demo-roles";
import { createInspectionRouteDeps } from "./composition/inspection-deps";
import { composeMissionDeps } from "./composition/mission-deps";
import { createRecoveryRouteDeps } from "./composition/recovery-deps";
import { runBrowserTransportSoakViaCli } from "./composition/transport-soak-cli";
import { createBridgeMissionActivityRecorder } from "./bridge-mission-activity-recorder";
import { createBrowserContextSourceProvider } from "./browser-context-source-provider";
import { createMissionThreadBridge, type MissionThreadBridge } from "./mission-thread-bridge";
import { createMissionTaskToolService } from "./mission-task-tool-service";
import { createMissionToolPermissionService } from "./tool-permission-service";
import { buildBrowserRuntimeHealthSnapshot } from "./browser-runtime-health";
import { buildDiagnosticsMissionHealthSnapshot } from "./mission-health-diagnostics";

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
import { buildControlCenterStartupBanner } from "./daemon-startup-banner";
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
import { handleControlCenterRoutes } from "./routes/control-center-routes";
import {
  handleDiagnosticsRoutes,
  type DiagnosticsBrowserHealthSnapshot,
} from "./routes/diagnostics-routes";
import { handleDaemonConfigRoutes } from "./routes/daemon-config-routes";
import { handleInspectionRoutes } from "./routes/inspection-routes";
import { handleMissionRoutes } from "./routes/mission-routes";
import { handleOnboardingRoutes } from "./routes/onboarding-routes";
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
const CONTROL_CENTER_ASSET_DIR = resolveControlCenterAssetDir({
  override: process.env.TURNKEYAI_CONTROL_CENTER_DIR ?? null,
});
const DAEMON_AUTH = resolveDaemonAuthConfig(process.env);
// Captured once at startup so /diagnostics can report "started at" without
// relying on PID file timestamps. process.uptime() gives the relative delta;
// this gives the wall-clock origin.
const PROCESS_STARTED_AT_MS = Date.now();
const RECOVERY_RUN_STALE_AFTER_MS = 5 * 60 * 1000;
const RUNTIME_RECONCILIATION_INTERVAL_MS = 60_000;

function resolveDesktopHealthProofToken(scope: DesktopDaemonProofScope): string | null {
  if (scope === "operator") return DAEMON_AUTH.operatorToken;
  if (scope === "admin") return DAEMON_AUTH.adminToken;
  if (scope === "read") return DAEMON_AUTH.readToken;
  if (scope === "unknown") return TOKEN_BOOTSTRAP.token;
  return null;
}

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
const runtimeLimits = DEFAULT_DAEMON_RUNTIME_LIMITS;
const modelCatalogPath = await resolveModelCatalogPath();
const editableModelCatalogPath = resolveEditableModelCatalogPath();

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
  const transportHealth = await browserBridge.getTransportHealth().catch(() => undefined);
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
    ...(transportHealth ? { transportHealth } : {}),
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

async function buildBrowserHealthSnapshot(
  sessions: BrowserSession[]
): Promise<DiagnosticsBrowserHealthSnapshot> {
  return buildBrowserRuntimeHealthSnapshot({
    sessions,
    loadHistory: (input) => browserBridge.getSessionHistory(input),
  });
}

// PR K2 — Mission Control stores (mission/work-item/activity/approval/
// artifact + agent + context-source registries). Composed before the
// role runtime so native permission tools can file approval requests
// into the same operator queue the dashboard renders.
//
// gemini K3.5: missionShortIdSeq must NOT restart at 0 across daemon
// process lifetimes — every new daemon would mint MSN-0001 and
// collide with existing on-disk records. Hydrate the seed counter
// from the largest existing MSN-#### we find in the missions
// directory before installing the id generator. (missionIdSeq is
// fine: it's already prefixed with Date.now() in base-36.)
let missionIdSeq = 0;
let missionShortIdSeq = await hydrateMissionShortIdSeed(DATA_DIR);
const missionDeps = composeMissionDeps({
  dataDir: DATA_DIR,
  clock,
  idGenerator: {
    missionId: () => `msn.${Date.now().toString(36)}.${++missionIdSeq}`,
    shortId: () => `MSN-${(++missionShortIdSeq).toString().padStart(4, "0")}`,
  },
});

const toolPermissionService = createMissionToolPermissionService({
  missionStore: missionDeps.missionStore,
  approvalStore: missionDeps.approvalStore,
  activityStore: missionDeps.activityStore,
  permissionCacheStore,
  clock,
  newEventId: () => idGenerator.messageId(),
});
const taskToolService = createMissionTaskToolService({
  missionStore: missionDeps.missionStore,
  workItemStore: missionDeps.workItemStore,
  activityStore: missionDeps.activityStore,
  clock,
  idGenerator,
});

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
  toolPermissionService,
  taskToolService,
});
const {
  workerRuntime,
  modelRegistry,
  llmGateway,
  coordinationEngine,
  recoveryActionService,
  scheduledTaskRuntime,
  runtimeQueryService,
  toolCancellationRegistry,
  roleLoopRunner,
} = runtimeServices;

const browserRouteHelpers = createBrowserRouteHelpers({
  teamThreadStore,
  browserBridge,
  clock,
});
const {
  resolveBrowserThreadOwner,
  requireBrowserSessionAccess,
  buildBrowserTaskRequest,
  buildBrowserTaskActions,
} = browserRouteHelpers;

const inspectionDeps = createInspectionRouteDeps({
  foundations,
  runtimeServices,
  modelCatalogPath,
});

const recoveryDeps = createRecoveryRouteDeps({
  foundations,
  runtimeServices,
  idempotencyStore: routeIdempotencyStore,
});

// PR K3 — bridge ↔ mission wiring. The recorder writes ActivityEvents
// into the mission timeline; the provider exposes live browser sessions
// as ContextSources so the Mission Detail right pane reflects what the
// bridge currently has open instead of just the registry snapshot.
const bridgeMissionRecorder = createBridgeMissionActivityRecorder({
  activityStore: missionDeps.activityStore,
  // Reuse the daemon idGenerator's messageId sequence so event IDs
  // share the same monotonic ordering as other daemon-emitted IDs.
  newEventId: () => idGenerator.messageId(),
  clock,
});
const browserContextSourceProvider = createBrowserContextSourceProvider({
  browserBridge,
});

// PR K3.5 — Mission ↔ team-runtime orchestrator. Spawns a team thread
// per mission, posts user messages onto it, and mirrors assistant /
// tool replies onto the mission timeline via the thread bridge.
const missionThreadBridge = createMissionThreadBridge({
  missionStore: missionDeps.missionStore,
  roleRunStore,
  workerSessionStore,
  teamMessageStore,
  activityStore: missionDeps.activityStore,
  artifactStore: missionDeps.artifactStore,
  browserArtifactStore: new FileBrowserArtifactStore({
    rootDir: path.join(DATA_DIR, "browser-state", "artifacts"),
    artifactRootDir: path.join(DATA_DIR, "browser-artifacts"),
  }),
  newEventId: () => idGenerator.messageId(),
  clock,
  async postLateWorkerCompletionFollowUp(input) {
    void coordinationEngine
      .handleUserPost({
        threadId: input.threadId,
        content: input.content,
      })
      .catch((error) => {
        console.error("late worker completion follow-up failed", {
          missionId: input.mission.id,
          workerRunKey: input.workerSession.workerRunKey,
          error,
        });
      });
  },
  async postIncompleteFinalFollowUp(input) {
    void coordinationEngine
      .handleUserPost({
        threadId: input.threadId,
        content: input.content,
      })
      .catch((error) => {
        console.error("incomplete final follow-up failed", {
          missionId: input.mission.id,
          messageId: input.recovery.message.id,
          reason: input.recovery.reason,
          error,
        });
      });
  },
});
const stopMissionThreadBridge = missionThreadBridge.start(2000);
const stopMissionThreadEventMirror = installMissionThreadEventMirror({
  teamEventBus,
  missionThreadBridge,
});
const missionOrchestrator = {
  async spawnThread(input: {
    title: string;
    desc: string;
    owner: string;
    mode: import("@turnkeyai/core-types/mission").MissionMode;
  }) {
    const roles = buildMissionRuntimeRoles(input.mode);
    const thread = await teamThreadStore.create({
      teamName: `Mission: ${input.title}`,
      leadRoleId: roles[0]!.roleId,
      roles,
    });
    await teamEventBus.publish({
      eventId: idGenerator.messageId(),
      threadId: thread.threadId,
      kind: "thread.created",
      createdAt: clock.now(),
      payload: { teamId: thread.teamId, teamName: thread.teamName },
    });
    return {
      threadId: thread.threadId,
      leadRoleId: thread.leadRoleId,
      roleIds: roles.map((r) => r.roleId),
    };
  },
  async postUserMessage(input: { threadId: string; content: string }) {
    await coordinationEngine.handleUserPost({
      threadId: input.threadId,
      content: input.content,
    });
  },
  threadBridge: missionThreadBridge,
};

function installMissionThreadEventMirror(input: {
  teamEventBus: TeamEventBus;
  missionThreadBridge: MissionThreadBridge;
}): () => void {
  const pending = new Map<string, NodeJS.Timeout>();
  const schedule = (threadId: string) => {
    const existing = pending.get(threadId);
    if (existing) {
      clearTimeout(existing);
    }
    const timeout = setTimeout(() => {
      pending.delete(threadId);
      const tickThread = input.missionThreadBridge.tickThread;
      if (!tickThread) {
        return;
      }
      void tickThread(threadId).catch((error) => {
        console.warn("mission thread event mirror failed", {
          threadId,
          error,
        });
      });
    }, 100);
    timeout.unref?.();
    pending.set(threadId, timeout);
  };
  const unsubscribe = input.teamEventBus.subscribe((event) => {
    if (!shouldMirrorMissionThreadEvent(event)) {
      return;
    }
    schedule(event.threadId);
  });
  return () => {
    unsubscribe();
    for (const timeout of pending.values()) {
      clearTimeout(timeout);
    }
    pending.clear();
  };
}

function shouldMirrorMissionThreadEvent(event: TeamEvent): boolean {
  if (event.kind === "message.posted" || event.kind === "worker.updated") {
    return true;
  }
  if (event.kind !== "runtime.progress") {
    return false;
  }
  const phase = event.payload.phase;
  if (phase === "completed" || phase === "failed" || phase === "cancelled") {
    return true;
  }
  const subjectKind = event.payload.subjectKind;
  const statusReason = event.payload.statusReason;
  return subjectKind === "dispatch" || statusReason === "role_loop_dequeued" || statusReason === "role_loop_hydrated";
}

function buildMissionRuntimeRoles(mode: import("@turnkeyai/core-types/mission").MissionMode) {
  const lead = {
    roleId: "role-lead",
    name: "Lead",
    seat: "lead" as const,
    runtime: "local" as const,
    modelRef: "claude-opus",
    modelChain: "lead_reasoning",
  };

  if (mode === "research" || mode === "investigation") {
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
        roleId: "role-browser",
        name: "Browser",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["browser"],
        modelRef: "gemini",
        modelChain: "browser_primary",
      },
    ];
  }

  if (mode === "browser") {
    return [
      lead,
      {
        roleId: "role-browser",
        name: "Browser",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["browser"],
        modelRef: "gemini",
        modelChain: "browser_primary",
      },
    ];
  }

  return [lead];
}

await mkdir(DATA_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const desktopChallenge = url.searchParams.get("desktopChallenge");
      const desktopScope = url.searchParams.get("desktopScope");
      const proofToken =
        desktopScope && isDesktopDaemonProofScope(desktopScope)
          ? resolveDesktopHealthProofToken(desktopScope)
          : null;
      const desktopProof =
        desktopChallenge &&
        isDesktopDaemonChallenge(desktopChallenge) &&
        desktopScope &&
        isDesktopDaemonProofScope(desktopScope) &&
        proofToken
          ? createDesktopDaemonProof(proofToken, desktopChallenge, desktopScope, PORT)
          : null;
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        dataDir: DATA_DIR,
        modelCatalogPath,
        ...(desktopProof ? { desktopProof } : {}),
      });
    }

    // Control Center static bundle. Served before auth because the assets
    // themselves do not leak any state — the dashboard's API calls still
    // carry the daemon token and go through authorizeDaemonRequest below.
    if (
      await handleControlCenterRoutes({
        req,
        res,
        url,
        deps: { assetDir: CONTROL_CENTER_ASSET_DIR },
      })
    ) {
      return;
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
      // Intentionally NOT wrapped in runIdempotently. This is a developer-
      // facing demo route — every POST is meant to create a fresh demo
      // thread (you can call it repeatedly to spin up parallel demos).
      // Adding idempotency would defeat that purpose. The route is not
      // exposed to external agents; it is documented in the daemon's
      // startup help banner as a curl-from-localhost smoke command.
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

    let browserSessionsForDiagnostics: Promise<BrowserSession[]> | null = null;
    const listBrowserSessionsForDiagnostics = () => {
      browserSessionsForDiagnostics ??= browserBridge.listSessions();
      return browserSessionsForDiagnostics;
    };

    if (
      await handleDiagnosticsRoutes({
        req,
        res,
        url,
        deps: {
          daemonVersion: DAEMON_PACKAGE_VERSION,
          port: PORT,
          dataDir: DATA_DIR,
          runtimeRoot: RUNTIME_PATHS.rootDir,
          logFile: RUNTIME_PATHS.logFile,
          configFile: RUNTIME_PATHS.configFile,
          modelCatalogPath,
          processStartedAtMs: PROCESS_STARTED_AT_MS,
          transport: {
            mode: browserBridge.transportMode,
            label: browserBridge.transportLabel,
          },
          directCdpEndpoint: DIRECT_CDP_ENDPOINT,
          relayEndpointConfigured: RELAY_ENDPOINT_CONFIGURED,
          authMode: DAEMON_AUTH.authMode,
          // Tokens the daemon was configured with — passed in so the log
          // redactor can strip literal occurrences before serving log
          // lines to the dashboard. De-duplicated and filtered for empty
          // strings; the redactor itself also requires length >= 8 to
          // avoid pathological short-token false positives.
          redactionTokens: Array.from(
            new Set(
              [
                DAEMON_AUTH.readToken,
                DAEMON_AUTH.operatorToken,
                DAEMON_AUTH.relayPeerToken,
                DAEMON_AUTH.adminToken,
                TOKEN_BOOTSTRAP.token,
              ].filter((value): value is string => typeof value === "string" && value.length > 0)
            )
          ),
          snapshotCounters: async () => {
            // Per-source fallback (codex nit). The outer route catches
            // exceptions and zeros ALL counters; without per-source
            // try/catch a single misbehaving source (e.g. relayGateway
            // hitting an internal error) would zero the others too,
            // losing real signal. Each source defaults to 0 on failure.
            let sessionCount = 0;
            try {
              const sessions = await listBrowserSessionsForDiagnostics();
              sessionCount = sessions.length;
            } catch {}
            let relayPeerCount = 0;
            try {
              relayPeerCount = relayGateway?.listPeers().length ?? 0;
            } catch {}
            let relayTargetCount = 0;
            try {
              relayTargetCount = relayGateway?.listTargets().length ?? 0;
            } catch {}
            return {
              sessionCount,
              relayPeerCount,
              relayTargetCount,
            };
          },
          browserHealthSnapshot: async () => buildBrowserHealthSnapshot(await listBrowserSessionsForDiagnostics()),
          missionHealthSnapshot: async () =>
            buildDiagnosticsMissionHealthSnapshot({
              missionStore: missionDeps.missionStore,
              activityStore: missionDeps.activityStore,
              runtimeProgressStore,
              nowMs: clock.now(),
            }),
        },
      })
    ) {
      return;
    }

    if (
      await handleDaemonConfigRoutes({
        req,
        res,
        url,
        deps: {
          currentModelCatalogPath: modelCatalogPath,
          editableModelCatalogPath,
          ...(modelRegistry && modelCatalogPath === editableModelCatalogPath
            ? {
                reloadActiveModelCatalog: async () => {
                  modelRegistry.clearCache();
                  await modelRegistry.describeSelection({});
                },
              }
            : {}),
        },
      })
    ) {
      return;
    }

    if (
      await handleOnboardingRoutes({
        req,
        res,
        url,
        deps: {
          stateFile: path.join(RUNTIME_PATHS.rootDir, "onboarding.json"),
          clock,
        },
      })
    ) {
      return;
    }

    if (
      await handleInspectionRoutes({
        req,
        res,
        url,
        deps: inspectionDeps,
      })
    ) {
      return;
    }

    if (
      await handleMissionRoutes({
        req,
        res,
        url,
        deps: {
          ...missionDeps,
          browserContextSourceProvider,
          orchestrator: missionOrchestrator,
          idempotencyStore: routeIdempotencyStore,
          toolPermissionService,
          runtimeProgressStore,
          teamMessageStore,
          roleRunStore,
          roleLoopRunner,
          workerRuntime,
          toolCancellationRegistry,
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
          idempotencyStore: routeIdempotencyStore,
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
        deps: recoveryDeps,
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
            missionContext: {
              validator: {
                missionStore: missionDeps.missionStore,
                workItemStore: missionDeps.workItemStore,
              },
              recorder: bridgeMissionRecorder,
            },
          },
          missionContext: {
            validator: {
              missionStore: missionDeps.missionStore,
              workItemStore: missionDeps.workItemStore,
            },
            recorder: bridgeMissionRecorder,
          },
          idGenerator,
          clock,
          idempotencyStore: routeIdempotencyStore,
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
          transportControl: {
            getHealth: () => browserBridge.getTransportHealth(),
            reconnect: (request) => browserBridge.reconnect(request),
          },
          commandDispatcher: bridgeCommandDispatcher,
          advancedDispatcher: bridgeAdvancedDispatcher,
          batchDispatcher: bridgeBatchDispatcher,
          expertDispatcher: bridgeExpertDispatcher,
          resolveToken: (request) => extractBridgeRequestToken(request),
          idempotencyStore: routeIdempotencyStore,
          missionContext: {
            validator: {
              missionStore: missionDeps.missionStore,
              workItemStore: missionDeps.workItemStore,
            },
            recorder: bridgeMissionRecorder,
          },
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
          teamMessageStore,
          scheduledTaskRuntime,
          idGenerator,
          clock,
          roleLoopRunner,
          workerRuntime,
          browserBridge,
          toolCancellationRegistry,
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
  for (const line of buildControlCenterStartupBanner({
    port: PORT,
    assetAvailable: Boolean(CONTROL_CENTER_ASSET_DIR),
    authMode: DAEMON_AUTH.authMode,
    tokenGenerated: TOKEN_BOOTSTRAP.generated,
    configFile: RUNTIME_PATHS.configFile,
  })) {
    console.log(line);
  }
  if (DAEMON_AUTH.authMode !== "disabled") {
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
  stopMissionThreadBridge();
  stopMissionThreadEventMirror();
  const closeTimeout = setTimeout(() => {
    console.error("daemon shutdown timed out, exiting");
    removePidFile(RUNTIME_PATHS, process.pid);
    process.exit(1);
  }, 10_000);
  closeTimeout.unref();
  server.close((closeError) => {
    clearTimeout(closeTimeout);
    if (closeError) {
      console.error(`daemon shutdown error: ${closeError.message}`);
    }
    removePidFile(RUNTIME_PATHS, process.pid);
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

function createValidationOpsRunId(kind: ValidationOpsRunType): string {
  return `validation-ops:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

async function writeValidationArtifact(kind: string, runId: string, payload: unknown): Promise<string> {
  const artifactPath = path.join(VALIDATION_ARTIFACT_DIR, kind, `${encodeURIComponent(runId)}.json`);
  await writeJsonFileAtomic(artifactPath, payload);
  return path.relative(process.cwd(), artifactPath);
}

/**
 * Hydrate the missionShortId sequence seed from existing on-disk
 * missions so a daemon restart doesn't reuse MSN-#### values.
 *
 * Scans `<dataDir>/mission/missions/` for `*.json` files, reads each,
 * parses the trailing decimal in `shortId` (formats like "MSN-0007",
 * "MSN-FX" — the K2 fixture shape — are ignored). Returns the
 * highest decimal found, or 0 when the directory is empty / absent.
 *
 * Best-effort: any IO error falls back to 0 with a console warning.
 * A duplicate short id is annoying but not catastrophic for K3.5; the
 * authoritative mission id (`msn.<timestamp>.<seq>`) stays unique.
 */
async function hydrateMissionShortIdSeed(dataDir: string): Promise<number> {
  const missionsDir = path.join(dataDir, "mission", "missions");
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(missionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let maxSeq = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(missionsDir, entry.name), "utf8");
        const parsed = JSON.parse(raw) as { shortId?: unknown };
        if (typeof parsed.shortId !== "string") continue;
        const match = parsed.shortId.match(/^MSN-(\d+)$/);
        if (!match) continue;
        const n = Number(match[1]);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      } catch {
        // Skip unreadable / malformed mission files.
      }
    }
    return maxSeq;
  } catch (error) {
    console.warn("mission short-id seed hydration failed", {
      dataDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function resolveModelCatalogPath(): Promise<string | null> {
  const explicit = process.env.TURNKEYAI_MODEL_CATALOG?.trim();
  if (explicit) {
    const candidate = path.resolve(explicit);
    await access(candidate);
    return candidate;
  }

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

function resolveEditableModelCatalogPath(): string {
  const explicit = process.env.TURNKEYAI_MODEL_CATALOG?.trim();
  return explicit ? path.resolve(explicit) : path.resolve(process.cwd(), "models.local.json");
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
    "  TURNKEYAI_MODEL_CATALOG      Override model catalog path",
    "  TURNKEYAI_BROWSER_TRANSPORT Select browser transport: local | relay | direct-cdp",
    "  TURNKEYAI_BROWSER_CDP_ENDPOINT  CDP endpoint for direct-cdp transport",
    "  TURNKEYAI_BROWSER_CHROME_EXECUTABLE Optional browser executable override",
  ];
  const output = exitCode === 0 ? console.log : console.error;
  output(lines.join("\n"));
  process.exit(exitCode);
}

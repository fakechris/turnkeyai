import http from "node:http";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

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
import { composeDaemonRuntimeServices } from "./composition/runtime-services";
import { createBrowserRouteHelpers } from "./composition/browser-route-helpers";
import { resolveControlCenterAssetDir } from "./composition/control-center-assets";
import { buildDemoRoles } from "./composition/demo-roles";
import { createInspectionRouteDeps } from "./composition/inspection-deps";
import { composeMissionDeps } from "./composition/mission-deps";
import { createRecoveryRouteDeps } from "./composition/recovery-deps";
import { runBrowserTransportSoakViaCli } from "./composition/transport-soak-cli";
import { createBridgeMissionActivityRecorder } from "./bridge-mission-activity-recorder";
import { createBrowserContextSourceProvider } from "./browser-context-source-provider";

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
import { handleControlCenterRoutes } from "./routes/control-center-routes";
import { handleDiagnosticsRoutes } from "./routes/diagnostics-routes";
import { handleInspectionRoutes } from "./routes/inspection-routes";
import { handleMissionRoutes } from "./routes/mission-routes";
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

// PR K2 — Mission Control stores (mission/work-item/activity/approval/
// artifact + agent + context-source registries). Composed separately
// from foundations.ts because the mission model is a self-contained
// addition with no cyclic deps on the rest of the daemon.
const missionDeps = composeMissionDeps({ dataDir: DATA_DIR, clock });

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
  clock,
});

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
              const sessions = await browserBridge.listSessions();
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
        deps: { ...missionDeps, browserContextSourceProvider },
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
  console.log(
    `control center: ${
      CONTROL_CENTER_ASSET_DIR
        ? `http://127.0.0.1:${PORT}/app`
        : "(bundle not found — rebuild @turnkeyai/cli)"
    }`
  );
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

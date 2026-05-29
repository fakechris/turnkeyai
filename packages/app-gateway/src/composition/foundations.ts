// P1.5a — Daemon composition root, foundations layer.
//
// This module owns the wiring of all daemon dependencies that have NO cyclic
// references and NO mutable reconcile state: file-backed stores, the in-memory
// event bus, the recovery/permission/evidence/admission policies, the
// prompt/memory/context resolvers, the browser bridge and its tier dispatchers,
// the replay recorder, the worker handlers, the capability discovery service,
// and the worker registry.
//
// What is intentionally NOT here (P1.5b will cover them): workerRuntime (and
// its startup reconcile), modelRegistry / llmGateway / roleRuntime,
// roleRunCoordinator, runtimeStateRecorder, runtimeChainRecorder, the cyclic
// CoordinationEngine / InlineRoleLoopRunner pair, recoveryActionService,
// the runtime reconciliation interval, scheduledTaskRuntime, and the
// runtimeQueryService. Each of those needs either mutable state or
// startup-await semantics that don't fit a pure foundations factory.

import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  BrowserSessionOwnerType,
  BrowserTaskRequest,
  Clock,
  IdGenerator,
  RelayBriefBuilder,
  SummaryBuilder,
  WorkerHandler,
} from "@turnkeyai/core-types/team";
import {
  createBrowserBridge,
  resolveBrowserTransportMode,
} from "@turnkeyai/browser-bridge/browser-bridge-factory";
import {
  maybeGetRawCdpExpertLane,
  maybeGetRelayControlPlane,
  type BrowserTransportAdapter,
  type RelayControlPlane,
} from "@turnkeyai/browser-bridge/transport/transport-adapter";
import type { BrowserRawCdpExpertLane } from "@turnkeyai/core-types/team";
import { DefaultApiExecutionVerifier } from "@turnkeyai/qc-runtime/api-execution-verifier";
import { DefaultAuthAndScopeDiagnosisPolicy } from "@turnkeyai/qc-runtime/auth-and-scope-diagnosis-policy";
import { BrowserResultVerifier } from "@turnkeyai/qc-runtime/browser-result-verifier";
import { BrowserStepVerifier } from "@turnkeyai/qc-runtime/browser-step-verifier";
import { DefaultEvidenceTrustPolicy } from "@turnkeyai/qc-runtime/evidence-trust-policy";
import { FileReplayRecorder } from "@turnkeyai/qc-runtime/file-replay-recorder";
import { DefaultPermissionGovernancePolicy } from "@turnkeyai/qc-runtime/permission-governance-policy";
import { DefaultPromptAdmissionPolicy } from "@turnkeyai/qc-runtime/prompt-admission-policy";
import { DefaultContextCompressor } from "@turnkeyai/role-runtime/compression/context-compressor";
import { DefaultContextBudgeter } from "@turnkeyai/role-runtime/context/context-budgeter";
import { DefaultRoleMemoryResolver } from "@turnkeyai/role-runtime/context/role-memory-resolver";
import { DefaultPromptAssembler } from "@turnkeyai/role-runtime/prompt/prompt-assembler";
import { DefaultRoleProfileRegistry } from "@turnkeyai/role-runtime/role-profile";
import { DefaultContextStateMaintainer } from "@turnkeyai/team-runtime/context-state-maintainer";
import { FileBackedTeamRouteMap } from "@turnkeyai/team-runtime/file-backed-team-route-map";
import { InMemoryTeamEventBus } from "@turnkeyai/team-runtime/in-memory-team-event-bus";
import { DefaultRecoveryDirector } from "@turnkeyai/team-runtime/recovery-director";
import { DefaultRuntimeProgressRecorder } from "@turnkeyai/team-runtime/runtime-progress-recorder";
import { FileRoleScratchpadStore } from "@turnkeyai/team-store/context/file-role-scratchpad-store";
import { FileSessionMemoryRefreshJobStore } from "@turnkeyai/team-store/context/file-session-memory-refresh-job-store";
import { FileThreadJournalStore } from "@turnkeyai/team-store/context/file-thread-journal-store";
import { FileThreadMemoryStore } from "@turnkeyai/team-store/context/file-thread-memory-store";
import { FileThreadSessionMemoryStore } from "@turnkeyai/team-store/context/file-thread-session-memory-store";
import { FileThreadSummaryStore } from "@turnkeyai/team-store/context/file-thread-summary-store";
import { FileWorkerEvidenceDigestStore } from "@turnkeyai/team-store/context/file-worker-evidence-digest-store";
import { FileFlowLedgerStore } from "@turnkeyai/team-store/file-flow-ledger-store";
import { FileRoleRunStore } from "@turnkeyai/team-store/file-role-run-store";
import { FileRuntimeChainEventStore } from "@turnkeyai/team-store/file-runtime-chain-event-store";
import { FileRuntimeChainSpanStore } from "@turnkeyai/team-store/file-runtime-chain-span-store";
import { FileRuntimeChainStatusStore } from "@turnkeyai/team-store/file-runtime-chain-status-store";
import { FileRuntimeChainStore } from "@turnkeyai/team-store/file-runtime-chain-store";
import { FileRuntimeProgressStore } from "@turnkeyai/team-store/file-runtime-progress-store";
import { FileTeamMessageStore } from "@turnkeyai/team-store/file-team-message-store";
import { FileTeamThreadStore } from "@turnkeyai/team-store/file-team-thread-store";
import { FilePermissionCacheStore } from "@turnkeyai/team-store/governance/file-permission-cache-store";
import { FileValidationOpsRunStore } from "@turnkeyai/team-store/ops/file-validation-ops-run-store";
import { FileRecoveryRunEventStore } from "@turnkeyai/team-store/recovery/file-recovery-run-event-store";
import { FileRecoveryRunStore } from "@turnkeyai/team-store/recovery/file-recovery-run-store";
import { FileScheduledTaskStore } from "@turnkeyai/team-store/scheduled/file-scheduled-task-store";
import { FileWorkerSessionStore } from "@turnkeyai/team-store/worker/file-worker-session-store";
import { BrowserWorkerHandler } from "@turnkeyai/worker-runtime/browser-worker-handler";
import { DefaultCapabilityDiscoveryService } from "@turnkeyai/worker-runtime/capability-discovery-service";
import { ExploreWorkerHandler } from "@turnkeyai/worker-runtime/explore-worker-handler";
import { FinanceWorkerHandler } from "@turnkeyai/worker-runtime/finance-worker-handler";
import { DefaultWorkerRegistry } from "@turnkeyai/worker-runtime/worker-registry";

import {
  TIER1_TOOLS,
  TIER2_TOOLS,
  buildTier1Action,
  buildTier2Action,
  createBridgeBatchDispatcher,
  createBridgeCommandDispatcher,
  createBridgeExpertDispatcher,
  createInMemoryAmbientSessionStore,
  type BridgeAmbientSessionStore,
  type BridgeCommandDispatcher,
} from "../bridge-command-dispatcher";

type BridgeBatchDispatcher = ReturnType<typeof createBridgeBatchDispatcher>;
type BridgeExpertDispatcher = ReturnType<typeof createBridgeExpertDispatcher>;

export interface DaemonFoundationsInputs {
  /**
   * Absolute path of the daemon data directory. All file-backed stores
   * mount their own subdirectory under this root.
   */
  dataDir: string;
  /**
   * Time source for all foundation components. Tests inject a fake clock here.
   */
  clock: Clock;
  /**
   * ID generator passed through to stores/components that mint identifiers.
   */
  idGenerator: IdGenerator;
}

export interface DaemonFoundations {
  // Stores
  teamThreadStore: FileTeamThreadStore;
  teamMessageStore: FileTeamMessageStore;
  teamRouteMap: FileBackedTeamRouteMap;
  teamEventBus: InMemoryTeamEventBus;
  flowLedgerStore: FileFlowLedgerStore;
  roleRunStore: FileRoleRunStore;
  runtimeChainStore: FileRuntimeChainStore;
  runtimeChainSpanStore: FileRuntimeChainSpanStore;
  runtimeChainEventStore: FileRuntimeChainEventStore;
  runtimeChainStatusStore: FileRuntimeChainStatusStore;
  runtimeProgressStore: FileRuntimeProgressStore;
  threadSummaryStore: FileThreadSummaryStore;
  threadMemoryStore: FileThreadMemoryStore;
  threadSessionMemoryStore: FileThreadSessionMemoryStore;
  sessionMemoryRefreshJobStore: FileSessionMemoryRefreshJobStore;
  threadJournalStore: FileThreadJournalStore;
  roleScratchpadStore: FileRoleScratchpadStore;
  workerEvidenceDigestStore: FileWorkerEvidenceDigestStore;
  permissionCacheStore: FilePermissionCacheStore;
  recoveryRunStore: FileRecoveryRunStore;
  recoveryRunEventStore: FileRecoveryRunEventStore;
  scheduledTaskStore: FileScheduledTaskStore;
  validationOpsRunStore: FileValidationOpsRunStore;
  workerSessionStore: FileWorkerSessionStore;

  // Builders and policies
  summaryBuilder: SummaryBuilder;
  relayBriefBuilder: RelayBriefBuilder;
  recoveryDirector: DefaultRecoveryDirector;
  authAndScopeDiagnosisPolicy: DefaultAuthAndScopeDiagnosisPolicy;
  apiExecutionVerifier: DefaultApiExecutionVerifier;
  permissionGovernancePolicy: DefaultPermissionGovernancePolicy;
  evidenceTrustPolicy: DefaultEvidenceTrustPolicy;
  promptAdmissionPolicy: DefaultPromptAdmissionPolicy;

  // Registries and prompt/context machinery
  roleProfileRegistry: DefaultRoleProfileRegistry;
  contextBudgeter: DefaultContextBudgeter;
  runtimeProgressRecorder: DefaultRuntimeProgressRecorder;
  roleMemoryResolver: DefaultRoleMemoryResolver;
  promptAssembler: DefaultPromptAssembler;
  contextCompressor: DefaultContextCompressor;
  contextStateMaintainer: DefaultContextStateMaintainer;

  // Browser bridge (and the env-derived constants that describe it)
  browserBridge: BrowserTransportAdapter;
  relayGateway: RelayControlPlane | null;
  browserExpertLane: BrowserRawCdpExpertLane | null;
  relayEndpointConfigured: boolean;
  directCdpEndpoint: string | null;
  daemonPackageVersion: string;

  // Bridge dispatchers
  bridgeAmbientSessions: BridgeAmbientSessionStore;
  bridgeCommandDispatcher: BridgeCommandDispatcher;
  bridgeAdvancedDispatcher: BridgeCommandDispatcher;
  bridgeBatchDispatcher: BridgeBatchDispatcher;
  bridgeExpertDispatcher: BridgeExpertDispatcher;

  // Replay + worker registry (without runtime)
  replayRecorder: FileReplayRecorder;
  workerHandlers: WorkerHandler[];
  capabilityDiscoveryService: DefaultCapabilityDiscoveryService;
  workerRegistry: DefaultWorkerRegistry;
}

export function composeDaemonFoundations(inputs: DaemonFoundationsInputs): DaemonFoundations {
  const { dataDir, clock, idGenerator } = inputs;

  // --- Stores ------------------------------------------------------------
  const teamThreadStore = new FileTeamThreadStore({
    rootDir: path.join(dataDir, "threads"),
    idGenerator,
    clock,
  });
  const teamEventBus = new InMemoryTeamEventBus();
  const teamRouteMap = new FileBackedTeamRouteMap({
    teamThreadStore,
  });
  const teamMessageStore = new FileTeamMessageStore({
    rootDir: path.join(dataDir, "messages"),
  });
  const flowLedgerStore = new FileFlowLedgerStore({
    rootDir: path.join(dataDir, "flows"),
  });
  const roleRunStore = new FileRoleRunStore({
    rootDir: path.join(dataDir, "runs"),
  });
  const runtimeChainStore = new FileRuntimeChainStore({
    rootDir: path.join(dataDir, "runtime-chains"),
  });
  const runtimeChainSpanStore = new FileRuntimeChainSpanStore({
    rootDir: path.join(dataDir, "runtime-chain-spans"),
  });
  const runtimeChainEventStore = new FileRuntimeChainEventStore({
    rootDir: path.join(dataDir, "runtime-chain-events"),
  });
  const runtimeChainStatusStore = new FileRuntimeChainStatusStore({
    rootDir: path.join(dataDir, "runtime-chain-status"),
  });
  const runtimeProgressStore = new FileRuntimeProgressStore({
    rootDir: path.join(dataDir, "runtime-progress"),
  });
  const threadSummaryStore = new FileThreadSummaryStore({
    rootDir: path.join(dataDir, "context", "thread-summaries"),
  });
  const threadMemoryStore = new FileThreadMemoryStore({
    rootDir: path.join(dataDir, "context", "thread-memory"),
  });
  const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
    rootDir: path.join(dataDir, "context", "thread-session-memory"),
  });
  const sessionMemoryRefreshJobStore = new FileSessionMemoryRefreshJobStore({
    rootDir: path.join(dataDir, "context", "session-memory-refresh-jobs"),
  });
  const threadJournalStore = new FileThreadJournalStore({
    rootDir: path.join(dataDir, "context", "thread-journal"),
  });
  const roleScratchpadStore = new FileRoleScratchpadStore({
    rootDir: path.join(dataDir, "context", "role-scratchpads"),
  });
  const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
    rootDir: path.join(dataDir, "context", "worker-evidence"),
  });
  const permissionCacheStore = new FilePermissionCacheStore({
    rootDir: path.join(dataDir, "governance", "permission-cache"),
  });
  const recoveryRunStore = new FileRecoveryRunStore({
    rootDir: path.join(dataDir, "recovery-runs"),
  });
  const recoveryRunEventStore = new FileRecoveryRunEventStore({
    rootDir: path.join(dataDir, "recovery-run-events"),
  });
  const scheduledTaskStore = new FileScheduledTaskStore({
    rootDir: path.join(dataDir, "scheduled-tasks"),
  });
  const validationOpsRunStore = new FileValidationOpsRunStore({
    rootDir: path.join(dataDir, "validation-ops-runs"),
  });
  const workerSessionStore = new FileWorkerSessionStore({
    rootDir: path.join(dataDir, "worker-sessions"),
  });

  // --- Builders ----------------------------------------------------------
  const summaryBuilder: SummaryBuilder = {
    async getRecentMessages(threadId, limit = 10) {
      const messages = await teamMessageStore.list(threadId, limit);
      return messages.map((message) => {
        const summary = {
          messageId: message.id,
          role: message.role,
          name: message.name,
          content: message.content,
          createdAt: message.createdAt,
        };

        return message.roleId ? { ...summary, roleId: message.roleId } : summary;
      });
    },
  };

  const relayBriefBuilder: RelayBriefBuilder = {
    build(input) {
      const closingTag = "</relay_brief>";
      const header = [
        "<relay_brief>",
        `Flow: ${input.flow?.flowId ?? "unknown"}`,
        `Thread: ${input.thread.threadId}`,
        `Target Role: ${input.targetRoleId}`,
      ];
      const recent = (input.recentMessages ?? [])
        .slice(-5)
        .map((item) => `[${item.name}]: ${truncateBrief(item.content, RELAY_BRIEF_LINE_MAX_CHARS)}`);
      const body = [...header, ...recent].join("\n");
      return `${truncateBrief(body, RELAY_BRIEF_MAX_CHARS - closingTag.length - 1)}\n${closingTag}`;
    },
  };

  // --- Policies ----------------------------------------------------------
  const recoveryDirector = new DefaultRecoveryDirector();
  const authAndScopeDiagnosisPolicy = new DefaultAuthAndScopeDiagnosisPolicy();
  const apiExecutionVerifier = new DefaultApiExecutionVerifier({
    authPolicy: authAndScopeDiagnosisPolicy,
  });
  const permissionGovernancePolicy = new DefaultPermissionGovernancePolicy();
  const evidenceTrustPolicy = new DefaultEvidenceTrustPolicy();
  const promptAdmissionPolicy = new DefaultPromptAdmissionPolicy();

  // --- Prompt / memory / context ----------------------------------------
  const roleProfileRegistry = new DefaultRoleProfileRegistry();
  const contextBudgeter = new DefaultContextBudgeter();
  const runtimeProgressRecorder = new DefaultRuntimeProgressRecorder({
    progressStore: runtimeProgressStore,
    teamEventBus,
  });
  const roleMemoryResolver = new DefaultRoleMemoryResolver({
    threadSummaryStore,
    threadMemoryStore,
    threadSessionMemoryStore,
    threadJournalStore,
    roleScratchpadStore,
    workerEvidenceDigestStore,
  });
  const promptAssembler = new DefaultPromptAssembler({
    estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
      contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
  });
  const contextCompressor = new DefaultContextCompressor();
  const contextStateMaintainer = new DefaultContextStateMaintainer({
    teamMessageStore,
    threadSummaryStore,
    threadMemoryStore,
    threadSessionMemoryStore,
    sessionMemoryRefreshJobStore,
    threadJournalStore,
    roleScratchpadStore,
    contextCompressor,
    runtimeProgressRecorder,
    sessionMemoryRefreshDelayMs: 10,
  });

  // --- Browser bridge ----------------------------------------------------
  const browserBridge = createBrowserBridge({
    artifactRootDir: path.join(dataDir, "browser-artifacts"),
    stateRootDir: path.join(dataDir, "browser-state"),
    ...(process.env.TURNKEYAI_BROWSER_TRANSPORT?.trim()
      ? { transportMode: resolveBrowserTransportMode(process.env.TURNKEYAI_BROWSER_TRANSPORT.trim()) }
      : {}),
    relay: {
      ...(process.env.TURNKEYAI_BROWSER_RELAY_ENDPOINT?.trim()
        ? { endpoint: process.env.TURNKEYAI_BROWSER_RELAY_ENDPOINT.trim() }
        : {}),
      ...(process.env.TURNKEYAI_BROWSER_RELAY_PEER_ID?.trim()
        ? { relayPeerId: process.env.TURNKEYAI_BROWSER_RELAY_PEER_ID.trim() }
        : {}),
    },
    directCdp: {
      ...(process.env.TURNKEYAI_BROWSER_CDP_ENDPOINT?.trim()
        ? { endpoint: process.env.TURNKEYAI_BROWSER_CDP_ENDPOINT.trim() }
        : {}),
    },
  });
  const relayGateway = maybeGetRelayControlPlane(browserBridge);
  const browserExpertLane = maybeGetRawCdpExpertLane(browserBridge);
  const relayEndpointConfigured = Boolean(process.env.TURNKEYAI_BROWSER_RELAY_ENDPOINT?.trim());
  const directCdpEndpoint = process.env.TURNKEYAI_BROWSER_CDP_ENDPOINT?.trim() || null;
  const daemonPackageVersion = resolveDaemonPackageVersion();

  // --- Bridge dispatchers ------------------------------------------------
  const bridgeAmbientSessions = createInMemoryAmbientSessionStore();
  const bridgeAdapterDeps = {
    spawnSession: (request: BrowserTaskRequest) => browserBridge.spawnSession(request),
    sendSession: (request: BrowserTaskRequest & { browserSessionId: string }) =>
      browserBridge.sendSession(request),
    listTargets: (sessionId: string) => browserBridge.listTargets(sessionId),
    activateTarget: (
      sessionId: string,
      targetId: string,
      owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
    ) => browserBridge.activateTarget(sessionId, targetId, owner),
    closeTarget: (
      sessionId: string,
      targetId: string,
      owner?: { ownerType?: BrowserSessionOwnerType; ownerId?: string }
    ) => browserBridge.closeTarget(sessionId, targetId, owner),
  };
  const bridgeCommandDispatcher = createBridgeCommandDispatcher({
    bridge: bridgeAdapterDeps,
    ambient: bridgeAmbientSessions,
    idGenerator,
    clock,
    allowedTools: TIER1_TOOLS,
    buildAction: buildTier1Action,
    expertLaneAvailable: () => browserExpertLane !== null,
  });
  const bridgeAdvancedDispatcher = createBridgeCommandDispatcher({
    bridge: bridgeAdapterDeps,
    ambient: bridgeAmbientSessions,
    idGenerator,
    clock,
    allowedTools: new Set([...TIER1_TOOLS, ...TIER2_TOOLS]),
    buildAction: (tool, args) => {
      const tier1 = TIER1_TOOLS.has(tool) ? buildTier1Action(tool, args) : null;
      if (tier1 && !("error" in tier1)) return tier1;
      return buildTier2Action(tool, args);
    },
    expertLaneAvailable: () => browserExpertLane !== null,
  });
  const bridgeBatchDispatcher = createBridgeBatchDispatcher({
    bridge: bridgeAdapterDeps,
    ambient: bridgeAmbientSessions,
    idGenerator,
    clock,
    buildAction: (tool, args) => {
      if (TIER1_TOOLS.has(tool)) return buildTier1Action(tool, args);
      if (TIER2_TOOLS.has(tool)) return buildTier2Action(tool, args);
      return { error: `tool not allowed in batch: ${tool}` };
    },
  });
  const bridgeExpertDispatcher = createBridgeExpertDispatcher({
    expertLane: browserExpertLane,
    ambient: bridgeAmbientSessions,
    bridge: bridgeAdapterDeps,
    idGenerator,
  });

  // --- Replay + worker registry -----------------------------------------
  const replayRecorder = new FileReplayRecorder({
    rootDir: path.join(dataDir, "replays"),
  });
  const workerHandlers: WorkerHandler[] = [
    new BrowserWorkerHandler({
      browserBridge,
      stepVerifier: new BrowserStepVerifier(),
      resultVerifier: new BrowserResultVerifier(),
      replayRecorder,
      runtimeProgressRecorder,
    }),
    new ExploreWorkerHandler({
      browserBridge,
      allowLoopbackHosts: process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE === "1",
    }),
    new FinanceWorkerHandler(),
  ];
  const capabilityDiscoveryService = new DefaultCapabilityDiscoveryService({
    availableWorkers: () => [...new Set(workerHandlers.map((handler) => handler.kind))],
    skills: [
      { skillId: "browser", installed: true, capability: "browser" },
      { skillId: "explore", installed: true, capability: "explore" },
      { skillId: "finance", installed: true, capability: "finance" },
    ],
  });
  const workerRegistry = new DefaultWorkerRegistry(workerHandlers);

  return {
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
    authAndScopeDiagnosisPolicy,
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
    relayEndpointConfigured,
    directCdpEndpoint,
    daemonPackageVersion,
    bridgeAmbientSessions,
    bridgeCommandDispatcher,
    bridgeAdvancedDispatcher,
    bridgeBatchDispatcher,
    bridgeExpertDispatcher,
    replayRecorder,
    workerHandlers,
    capabilityDiscoveryService,
    workerRegistry,
  };
}

const RELAY_BRIEF_LINE_MAX_CHARS = 220;
const RELAY_BRIEF_MAX_CHARS = 2_400;

function truncateBrief(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, Math.max(maxChars - 1, 1))}…` : content;
}

function resolveDaemonPackageVersion(): string {
  // Look for the @turnkeyai/cli package.json. Bundling collapses this whole
  // module into packages/cli/dist/daemon.js, so the candidate set must cover
  // BOTH layouts. Each candidate is checked against `name === "@turnkeyai/cli"`,
  // so siblings that happen to resolve (e.g. app-gateway/package.json in the
  // source loop) are safely skipped.
  const candidates = [
    // Bundled dist: packages/cli/dist/daemon.js
    //   ..               -> packages/cli
    //   ../package.json  -> packages/cli/package.json
    path.join(import.meta.dirname, "..", "package.json"),
    // Source loop: packages/app-gateway/src/composition/foundations.ts
    //   ..                            -> packages/app-gateway/src
    //   ../..                         -> packages/app-gateway
    //   ../../..                      -> packages
    //   ../../../cli/package.json     -> packages/cli/package.json
    path.join(import.meta.dirname, "..", "..", "..", "cli", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === "@turnkeyai/cli" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}

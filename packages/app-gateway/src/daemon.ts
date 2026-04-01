import http from "node:http";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  BrowserContinuationHint,
  BrowserSessionOwnerType,
  BrowserTaskAction,
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
import {
  getScheduledContinuity,
  getScheduledSessionTarget,
  getScheduledTargetRoleId,
  getScheduledTargetWorker,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/core-types/async-mutex";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import { LocalChromeBrowserBridge } from "@turnkeyai/browser-bridge/local-chrome-browser-bridge";
import { AnthropicCompatibleClient } from "@turnkeyai/llm-adapter/anthropic-compatible-client";
import { FileModelCatalogSource } from "@turnkeyai/llm-adapter/file-model-catalog";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import { OpenAICompatibleClient } from "@turnkeyai/llm-adapter/openai-compatible-client";
import { ModelRegistry } from "@turnkeyai/llm-adapter/registry";
import { DefaultApiExecutionVerifier } from "@turnkeyai/qc-runtime/api-execution-verifier";
import { DefaultAuthAndScopeDiagnosisPolicy } from "@turnkeyai/qc-runtime/auth-and-scope-diagnosis-policy";
import {
  listBoundedRegressionCases,
  runBoundedRegressionSuite,
} from "@turnkeyai/qc-runtime/bounded-regression-harness";
import { BrowserResultVerifier } from "@turnkeyai/qc-runtime/browser-result-verifier";
import { BrowserStepVerifier } from "@turnkeyai/qc-runtime/browser-step-verifier";
import { DefaultEvidenceTrustPolicy } from "@turnkeyai/qc-runtime/evidence-trust-policy";
import {
  listFailureInjectionScenarios,
  runFailureInjectionSuite,
} from "@turnkeyai/qc-runtime/failure-injection-suite";
import { classifyRuntimeError } from "@turnkeyai/qc-runtime/failure-taxonomy";
import { FileReplayRecorder } from "@turnkeyai/qc-runtime/file-replay-recorder";
import {
  buildOperatorAttentionReport,
  buildFlowConsoleReport,
  buildGovernanceConsoleReport,
  buildOperatorSummaryReport,
  buildRecoveryConsoleReport,
} from "@turnkeyai/qc-runtime/operator-inspection";
import { buildPromptConsoleReport } from "@turnkeyai/qc-runtime/prompt-inspection";
import {
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
import { DefaultPermissionGovernancePolicy } from "@turnkeyai/qc-runtime/permission-governance-policy";
import { DefaultPromptAdmissionPolicy } from "@turnkeyai/qc-runtime/prompt-admission-policy";
import {
  listSoakScenarios,
  runSoakSuite,
} from "@turnkeyai/qc-runtime/soak-suite";
import {
  listScenarioParityAcceptanceScenarios,
  runScenarioParityAcceptanceSuite,
} from "@turnkeyai/qc-runtime/scenario-parity-acceptance";
import {
  listValidationSuites,
  runValidationSuites,
  ValidationSelectorError,
} from "@turnkeyai/qc-runtime/validation-suite";
import { CoordinationEngine } from "@turnkeyai/team-runtime/coordination-engine";
import { DefaultContextStateMaintainer } from "@turnkeyai/team-runtime/context-state-maintainer";
import { FileBackedTeamRouteMap } from "@turnkeyai/team-runtime/file-backed-team-route-map";
import { DefaultHandoffPlanner } from "@turnkeyai/team-runtime/handoff-planner";
import { InMemoryTeamEventBus } from "@turnkeyai/team-runtime/in-memory-team-event-bus";
import { InlineRoleLoopRunner } from "@turnkeyai/team-runtime/inline-role-loop-runner";
import { DefaultRecoveryDirector } from "@turnkeyai/team-runtime/recovery-director";
import { DefaultRoleRunCoordinator } from "@turnkeyai/team-runtime/role-run-coordinator";
import { DefaultRuntimeChainRecorder } from "@turnkeyai/team-runtime/runtime-chain-recorder";
import { DefaultRuntimeProgressRecorder } from "@turnkeyai/team-runtime/runtime-progress-recorder";
import { DefaultRuntimeStateRecorder } from "@turnkeyai/team-runtime/runtime-state-recorder";
import { DefaultScheduledTaskRuntime } from "@turnkeyai/team-runtime/scheduled-task-runtime";
import { DefaultContextCompressor } from "@turnkeyai/role-runtime/compression/context-compressor";
import { DefaultContextBudgeter } from "@turnkeyai/role-runtime/context/context-budgeter";
import { DefaultRoleMemoryResolver } from "@turnkeyai/role-runtime/context/role-memory-resolver";
import { DeterministicRoleResponseGenerator } from "@turnkeyai/role-runtime/deterministic-response-generator";
import { HeuristicModelAdapter } from "@turnkeyai/role-runtime/model-adapter";
import { HybridRoleResponseGenerator } from "@turnkeyai/role-runtime/hybrid-response-generator";
import { LLMRoleResponseGenerator } from "@turnkeyai/role-runtime/llm-response-generator";
import { PolicyRoleRuntime } from "@turnkeyai/role-runtime/policy-role-runtime";
import { DefaultPromptAssembler } from "@turnkeyai/role-runtime/prompt/prompt-assembler";
import { DefaultRolePromptPolicy } from "@turnkeyai/role-runtime/prompt-policy";
import { DefaultRoleProfileRegistry } from "@turnkeyai/role-runtime/role-profile";
import { FileRoleScratchpadStore } from "@turnkeyai/team-store/context/file-role-scratchpad-store";
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
import { FileSessionMemoryRefreshJobStore } from "@turnkeyai/team-store/context/file-session-memory-refresh-job-store";
import { FileTeamMessageStore } from "@turnkeyai/team-store/file-team-message-store";
import { FileTeamThreadStore } from "@turnkeyai/team-store/file-team-thread-store";
import { FilePermissionCacheStore } from "@turnkeyai/team-store/governance/file-permission-cache-store";
import { FileRecoveryRunStore } from "@turnkeyai/team-store/recovery/file-recovery-run-store";
import { FileRecoveryRunEventStore } from "@turnkeyai/team-store/recovery/file-recovery-run-event-store";
import { FileScheduledTaskStore } from "@turnkeyai/team-store/scheduled/file-scheduled-task-store";
import { BrowserWorkerHandler } from "@turnkeyai/worker-runtime/browser-worker-handler";
import { DefaultCapabilityDiscoveryService } from "@turnkeyai/worker-runtime/capability-discovery-service";
import { ExploreWorkerHandler } from "@turnkeyai/worker-runtime/explore-worker-handler";
import { FinanceWorkerHandler } from "@turnkeyai/worker-runtime/finance-worker-handler";
import { LocalWorkerRuntime } from "@turnkeyai/worker-runtime/local-worker-runtime";
import { DefaultWorkerRegistry } from "@turnkeyai/worker-runtime/worker-registry";

import { buildRecoveryRunActionConflict } from "./recovery-run-guards";

const PORT = Number(process.env.TURNKEYAI_DAEMON_PORT ?? 4100);
const DATA_DIR = path.resolve(process.cwd(), ".daemon-data");
const DAEMON_TOKEN = process.env.TURNKEYAI_DAEMON_TOKEN?.trim() || null;
const RECOVERY_RUN_STALE_AFTER_MS = 5 * 60 * 1000;

const clock: Clock = {
  now: () => Date.now(),
};

const idGenerator = createIdGenerator();
const recoveryRunActionMutex = new KeyedAsyncMutex<string>();
type RuntimeChainEntry = { chain: RuntimeChain; status: RuntimeChainStatus };
const runtimeLimits = {
  memberMaxIterations: 6,
  flowMaxHops: 20,
  maxQueuedHandoffsPerRole: 4,
  maxPerRoleHopCount: 3,
};
const modelCatalogPath = await resolveModelCatalogPath();

const teamThreadStore = new FileTeamThreadStore({
  rootDir: path.join(DATA_DIR, "threads"),
  idGenerator,
  clock,
});
const teamEventBus = new InMemoryTeamEventBus();
const teamRouteMap = new FileBackedTeamRouteMap({
  teamThreadStore,
});
const teamMessageStore = new FileTeamMessageStore({
  rootDir: path.join(DATA_DIR, "messages"),
});
const flowLedgerStore = new FileFlowLedgerStore({
  rootDir: path.join(DATA_DIR, "flows"),
});
const roleRunStore = new FileRoleRunStore({
  rootDir: path.join(DATA_DIR, "runs"),
});
const runtimeChainStore = new FileRuntimeChainStore({
  rootDir: path.join(DATA_DIR, "runtime-chains"),
});
const runtimeChainSpanStore = new FileRuntimeChainSpanStore({
  rootDir: path.join(DATA_DIR, "runtime-chain-spans"),
});
const runtimeChainEventStore = new FileRuntimeChainEventStore({
  rootDir: path.join(DATA_DIR, "runtime-chain-events"),
});
const runtimeChainStatusStore = new FileRuntimeChainStatusStore({
  rootDir: path.join(DATA_DIR, "runtime-chain-status"),
});
const runtimeProgressStore = new FileRuntimeProgressStore({
  rootDir: path.join(DATA_DIR, "runtime-progress"),
});
const threadSummaryStore = new FileThreadSummaryStore({
  rootDir: path.join(DATA_DIR, "context", "thread-summaries"),
});
const threadMemoryStore = new FileThreadMemoryStore({
  rootDir: path.join(DATA_DIR, "context", "thread-memory"),
});
const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
  rootDir: path.join(DATA_DIR, "context", "thread-session-memory"),
});
const sessionMemoryRefreshJobStore = new FileSessionMemoryRefreshJobStore({
  rootDir: path.join(DATA_DIR, "context", "session-memory-refresh-jobs"),
});
const threadJournalStore = new FileThreadJournalStore({
  rootDir: path.join(DATA_DIR, "context", "thread-journal"),
});
const roleScratchpadStore = new FileRoleScratchpadStore({
  rootDir: path.join(DATA_DIR, "context", "role-scratchpads"),
});
const workerEvidenceDigestStore = new FileWorkerEvidenceDigestStore({
  rootDir: path.join(DATA_DIR, "context", "worker-evidence"),
});
const permissionCacheStore = new FilePermissionCacheStore({
  rootDir: path.join(DATA_DIR, "governance", "permission-cache"),
});
const recoveryRunStore = new FileRecoveryRunStore({
  rootDir: path.join(DATA_DIR, "recovery-runs"),
});
const recoveryRunEventStore = new FileRecoveryRunEventStore({
  rootDir: path.join(DATA_DIR, "recovery-run-events"),
});
const scheduledTaskStore = new FileScheduledTaskStore({
  rootDir: path.join(DATA_DIR, "scheduled-tasks"),
});

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
      .map((item) => `[${item.name}]: ${truncateRelayBriefLine(item.content, 220)}`);
    const body = [...header, ...recent].join("\n");
    return `${truncateRelayBrief(body, 2_400 - closingTag.length - 1)}\n${closingTag}`;
  },
};

function truncateRelayBriefLine(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, Math.max(maxChars - 1, 1))}…` : content;
}

function truncateRelayBrief(content: string, maxChars: number): string {
  return content.length > maxChars ? `${content.slice(0, Math.max(maxChars - 1, 1))}…` : content;
}

const recoveryDirector = new DefaultRecoveryDirector();
const authAndScopeDiagnosisPolicy = new DefaultAuthAndScopeDiagnosisPolicy();
const apiExecutionVerifier = new DefaultApiExecutionVerifier({
  authPolicy: authAndScopeDiagnosisPolicy,
});
const permissionGovernancePolicy = new DefaultPermissionGovernancePolicy();
const evidenceTrustPolicy = new DefaultEvidenceTrustPolicy();
const promptAdmissionPolicy = new DefaultPromptAdmissionPolicy();

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
const browserBridge = new LocalChromeBrowserBridge({
  artifactRootDir: path.join(DATA_DIR, "browser-artifacts"),
  stateRootDir: path.join(DATA_DIR, "browser-state"),
});
const replayRecorder = new FileReplayRecorder({
  rootDir: path.join(DATA_DIR, "replays"),
});
const workerHandlers = [
  new BrowserWorkerHandler({
    browserBridge,
    stepVerifier: new BrowserStepVerifier(),
    resultVerifier: new BrowserResultVerifier(),
    replayRecorder,
    runtimeProgressRecorder,
  }),
  new ExploreWorkerHandler({
    browserBridge,
  }),
  new FinanceWorkerHandler(),
];
const capabilityDiscoveryService = new DefaultCapabilityDiscoveryService({
  availableWorkers: () => workerHandlers.map((handler) => handler.kind),
  skills: [
    { skillId: "browser", installed: true, capability: "browser" },
    { skillId: "explore", installed: true, capability: "explore" },
    { skillId: "finance", installed: true, capability: "finance" },
  ],
});
const workerRegistry = new DefaultWorkerRegistry(workerHandlers);
const workerRuntime: WorkerRuntime = new LocalWorkerRuntime({
  workerRegistry,
  runtimeProgressRecorder,
});
const heuristicResponseGenerator = new DeterministicRoleResponseGenerator({
  modelAdapter: new HeuristicModelAdapter(),
  roleProfileRegistry,
});
const modelRegistry = modelCatalogPath
  ? new ModelRegistry(new FileModelCatalogSource(modelCatalogPath))
  : null;
const llmGateway = modelRegistry
  ? new LLMGateway({
      registry: modelRegistry,
      clients: [new OpenAICompatibleClient(), new AnthropicCompatibleClient()],
    })
  : null;

const roleRuntime = new PolicyRoleRuntime({
  idGenerator,
  clock,
  promptPolicy: new DefaultRolePromptPolicy({
    roleProfileRegistry,
    contextBudgeter,
    roleMemoryResolver,
    promptAssembler,
    capabilityDiscoveryService,
    ...(modelRegistry ? { modelSelectionDescriber: modelRegistry } : {}),
  }),
  responseGenerator: llmGateway
    ? new HybridRoleResponseGenerator({
        primary: new LLMRoleResponseGenerator({
          gateway: llmGateway,
          runtimeProgressRecorder,
        }),
        fallback: heuristicResponseGenerator,
      })
    : heuristicResponseGenerator,
  workerRuntime,
  contextCompressor,
  workerEvidenceDigestStore,
  apiExecutionVerifier,
  teamEventBus,
  permissionGovernancePolicy,
  evidenceTrustPolicy,
  promptAdmissionPolicy,
  permissionCacheStore,
  replayRecorder,
});

const roleRunCoordinator = new DefaultRoleRunCoordinator({
  roleRunStore,
  runtimeLimits,
  now: () => clock.now(),
});
const runtimeStateRecorder = new DefaultRuntimeStateRecorder({
  teamEventBus,
});
const runtimeChainRecorder = new DefaultRuntimeChainRecorder({
  chainStore: runtimeChainStore,
  spanStore: runtimeChainSpanStore,
  eventStore: runtimeChainEventStore,
  statusStore: runtimeChainStatusStore,
  clock,
  runtimeStateRecorder,
});

let coordinationEngine: CoordinationEngine;

const roleLoopRunner = new InlineRoleLoopRunner({
  roleRunStore,
  flowLedgerStore,
  teamThreadStore,
  teamMessageStore,
  roleRunCoordinator,
  roleRuntime,
  onHandoffAck: async (input) => {
    await coordinationEngine.onHandoffAck(input);
  },
  onRoleReply: async (input) => {
    await coordinationEngine.handleRoleReply(input);
  },
  onRoleFailure: async (input) => {
    await coordinationEngine.onRoleFailure(input);
  },
  runtimeProgressRecorder,
});

coordinationEngine = new CoordinationEngine({
  teamThreadStore,
  teamMessageStore,
  flowLedgerStore,
  roleRunCoordinator,
  handoffPlanner: new DefaultHandoffPlanner({
    maxPerRoleHopCount: runtimeLimits.maxPerRoleHopCount,
  }),
  recoveryDirector,
  roleLoopRunner,
  summaryBuilder,
  relayBriefBuilder,
  idGenerator,
  runtimeLimits,
  clock,
  contextStateMaintainer,
  workerRuntime,
  runtimeChainRecorder,
});
const scheduledTaskRuntime = new DefaultScheduledTaskRuntime({
  scheduledTaskStore,
  coordinationEngine,
  clock,
  idGenerator,
  replayRecorder,
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

    if (!isAuthorizedRequest(req)) {
      return sendJson(res, 401, {
        error: "unauthorized",
        authMode: DAEMON_TOKEN ? "token" : "disabled",
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

    if (req.method === "GET" && url.pathname === "/threads") {
      return sendJson(res, 200, await teamThreadStore.list());
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return sendJson(res, 200, await teamEventBus.listRecent(threadId, limit));
    }

    if (req.method === "GET" && url.pathname === "/routes/resolve") {
      const channelId = url.searchParams.get("channelId");
      const userId = url.searchParams.get("userId");
      if (!channelId || !userId) {
        return sendJson(res, 400, { error: "channelId and userId are required" });
      }
      return sendJson(res, 200, await teamRouteMap.findByExternalActor(channelId, userId));
    }

    if (req.method === "GET" && url.pathname === "/messages") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      return sendJson(res, 200, await teamMessageStore.list(threadId));
    }

    if (req.method === "GET" && url.pathname === "/flows") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const flows = await flowLedgerStore.listByThread(threadId);
      return sendJson(res, 200, flows.slice(0, limit));
    }

    if (req.method === "GET" && url.pathname === "/flows-summary") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      return sendJson(res, 200, buildFlowConsoleReport(await flowLedgerStore.listByThread(threadId)));
    }

    if (req.method === "GET" && url.pathname === "/runtime-chains") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const entries = await listRuntimeChainEntriesByThread(threadId, limit);
      return sendJson(
        res,
        200,
        entries
      );
    }

    if (req.method === "GET" && url.pathname === "/runtime-active") {
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(res, 200, await listActiveRuntimeChainEntries(limit, url.searchParams.get("threadId")));
    }

    if (req.method === "GET" && url.pathname === "/runtime-summary") {
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(res, 200, await loadRuntimeSummary(url.searchParams.get("threadId"), limit));
    }

    if (req.method === "GET" && url.pathname === "/runtime-waiting") {
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(res, 200, await listRuntimeChainsByCanonicalState("waiting", limit, url.searchParams.get("threadId")));
    }

    if (req.method === "GET" && url.pathname === "/runtime-failed") {
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(res, 200, await listRuntimeChainsByCanonicalState("failed", limit, url.searchParams.get("threadId")));
    }

    if (req.method === "GET" && url.pathname === "/runtime-stale") {
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(res, 200, await listStaleRuntimeChainEntries(limit, url.searchParams.get("threadId")));
    }

    if (req.method === "GET" && url.pathname === "/runtime-attention") {
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const summary = await loadRuntimeSummary(url.searchParams.get("threadId"), limit);
      return sendJson(res, 200, summary.attentionChains);
    }

    if (req.method === "GET" && url.pathname === "/runtime-progress") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(res, 200, await runtimeProgressStore.listByThread(threadId, limit));
    }

    const runtimeChainEventsMatch = req.method === "GET" ? url.pathname.match(/^\/runtime-chains\/([^/]+)\/events$/) : null;
    if (runtimeChainEventsMatch) {
      const chainId = decodeURIComponent(runtimeChainEventsMatch[1] ?? "");
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const detail = await loadRuntimeChainDetail(chainId, limit);
      if (!detail) {
        return sendJson(res, 404, { error: "runtime chain not found" });
      }
      return sendJson(res, 200, detail.events.slice(-limit));
    }

    const runtimeChainProgressMatch = req.method === "GET" ? url.pathname.match(/^\/runtime-chains\/([^/]+)\/progress$/) : null;
    if (runtimeChainProgressMatch) {
      const chainId = decodeURIComponent(runtimeChainProgressMatch[1] ?? "");
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(res, 200, await runtimeProgressStore.listByChain(chainId, limit));
    }

    const runtimeChainMatch = req.method === "GET" ? url.pathname.match(/^\/runtime-chains\/([^/]+)$/) : null;
    if (runtimeChainMatch) {
      const chainId = decodeURIComponent(runtimeChainMatch[1] ?? "");
      const detail = await loadRuntimeChainDetail(chainId);
      if (!detail) {
        return sendJson(res, 404, { error: "runtime chain not found" });
      }
      return sendJson(res, 200, detail);
    }

    if (req.method === "GET" && url.pathname === "/runs") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      return sendJson(res, 200, await roleRunStore.listByThread(threadId));
    }

    if (req.method === "GET" && url.pathname === "/context/session-memory") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const record = await threadSessionMemoryStore.get(threadId);
      if (!record) {
        return sendJson(res, 404, { error: "session memory not found" });
      }
      return sendJson(res, 200, record);
    }

    if (req.method === "GET" && url.pathname === "/models") {
      if (!llmGateway) {
        return sendJson(res, 200, {
          modelCatalogPath: null,
          models: [],
          adapterMode: "heuristic-only",
        });
      }

      const models = await llmGateway.listModels();
      return sendJson(res, 200, {
        modelCatalogPath,
        adapterMode: "llm+heuristic-fallback",
        models: models.map((model) => ({
          ...model,
          configured: Boolean(process.env[model.apiKeyEnv]),
        })),
      });
    }

    if (req.method === "GET" && url.pathname === "/capabilities") {
      const threadId = url.searchParams.get("threadId");
      const roleId = url.searchParams.get("roleId");
      if (!threadId || !roleId) {
        return sendJson(res, 400, { error: "threadId and roleId are required" });
      }

      const requestedCapabilities = (url.searchParams.get("requestedCapabilities") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      return sendJson(
        res,
        200,
        await capabilityDiscoveryService.inspect({
          threadId,
          roleId,
          requestedCapabilities,
        })
      );
    }

    if (req.method === "GET" && url.pathname === "/governance/permissions") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      return sendJson(res, 200, await permissionCacheStore.listByThread(threadId));
    }

    if (req.method === "GET" && url.pathname === "/governance/summary") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const [permissionRecords, events] = await Promise.all([
        permissionCacheStore.listByThread(threadId),
        teamEventBus.listRecent(threadId, Math.max(limit, 200)),
      ]);
      return sendJson(res, 200, buildGovernanceConsoleReport(permissionRecords, events, limit));
    }

    if (req.method === "GET" && url.pathname === "/recovery-summary") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const synced = await loadRecoveryRuntime(threadId);
      return sendJson(res, 200, buildRecoveryConsoleReport(synced.runs, limit));
    }

    if (req.method === "GET" && url.pathname === "/prompt-console") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const progressEvents = await runtimeProgressStore.listByThread(threadId);
      return sendJson(res, 200, buildPromptConsoleReport(progressEvents, limit));
    }

    if (req.method === "GET" && url.pathname === "/operator-summary") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const [flows, permissionRecords, events, synced] = await Promise.all([
        flowLedgerStore.listByThread(threadId),
        permissionCacheStore.listByThread(threadId),
        teamEventBus.listRecent(threadId, Math.max(limit, 200)),
        loadRecoveryRuntime(threadId),
      ]);
      return sendJson(
        res,
        200,
        buildOperatorSummaryReport({
          flows,
          permissionRecords,
          events,
          replays: synced.records,
          recoveryRuns: synced.runs,
          limit,
        })
      );
    }

    if (req.method === "GET" && url.pathname === "/operator-attention") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const [flows, permissionRecords, events, synced] = await Promise.all([
        flowLedgerStore.listByThread(threadId),
        permissionCacheStore.listByThread(threadId),
        teamEventBus.listRecent(threadId, Math.max(limit, 200)),
        loadRecoveryRuntime(threadId),
      ]);
      return sendJson(
        res,
        200,
        buildOperatorAttentionReport({
          flows,
          permissionRecords,
          events,
          replays: synced.records,
          recoveryRuns: synced.runs,
          limit,
        })
      );
    }

    if (req.method === "GET" && url.pathname === "/governance/audits") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const events = await teamEventBus.listRecent(threadId, limit);
      return sendJson(
        res,
        200,
        events.filter((event) => event.kind === "audit.logged")
      );
    }

    if (req.method === "GET" && url.pathname === "/governance/workers") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const events = await teamEventBus.listRecent(threadId, limit);
      return sendJson(
        res,
        200,
        events.filter(
          (event) =>
            event.kind === "audit.logged" &&
            typeof event.payload.scope === "string" &&
            event.payload.scope === "worker_execution"
        )
      );
    }

    if (req.method === "GET" && url.pathname === "/replays") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const layer = url.searchParams.get("layer") ?? undefined;
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(
        res,
        200,
        await replayRecorder.list({
          ...(threadId ? { threadId } : {}),
          ...(layer &&
          ["scheduled", "role", "worker", "browser"].includes(layer)
            ? { layer: layer as "scheduled" | "role" | "worker" | "browser" }
            : {}),
          limit,
        })
      );
    }

    if (req.method === "GET" && url.pathname === "/replay-summary") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(
        res,
        200,
        buildReplayInspectionReport(
          await replayRecorder.list({
            ...(threadId ? { threadId } : {}),
            limit,
          })
        )
      );
    }

    if (req.method === "GET" && url.pathname === "/replay-console") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(
        res,
        200,
        buildReplayConsoleReport(
          await replayRecorder.list({
            ...(threadId ? { threadId } : {}),
            limit: Math.max(limit, 200),
          }),
          limit
        )
      );
    }

    if (req.method === "GET" && url.pathname === "/regression-cases") {
      const cases = listBoundedRegressionCases();
      return sendJson(res, 200, {
        totalCases: cases.length,
        cases,
      });
    }

    if (req.method === "POST" && url.pathname === "/regression-cases/run") {
      const body = await readJsonBody<{ caseIds?: string[] }>(req);
      const caseIds = Array.isArray(body.caseIds)
        ? body.caseIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;
      return sendJson(res, 200, runBoundedRegressionSuite(caseIds));
    }

    if (req.method === "GET" && url.pathname === "/failure-cases") {
      const scenarios = listFailureInjectionScenarios();
      return sendJson(res, 200, {
        totalScenarios: scenarios.length,
        scenarios,
      });
    }

    if (req.method === "POST" && url.pathname === "/failure-cases/run") {
      const body = await readJsonBody<{ scenarioIds?: string[] }>(req);
      const scenarioIds = Array.isArray(body.scenarioIds)
        ? body.scenarioIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;
      return sendJson(res, 200, runFailureInjectionSuite(scenarioIds));
    }

    if (req.method === "GET" && url.pathname === "/soak-cases") {
      const scenarios = listSoakScenarios();
      return sendJson(res, 200, {
        totalScenarios: scenarios.length,
        scenarios,
      });
    }

    if (req.method === "POST" && url.pathname === "/soak-cases/run") {
      const body = await readJsonBody<{ scenarioIds?: string[] }>(req);
      const scenarioIds = Array.isArray(body.scenarioIds)
        ? body.scenarioIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;
      if (scenarioIds && scenarioIds.length > 0) {
        const validScenarioIds = new Set(listSoakScenarios().map((scenario) => scenario.scenarioId));
        const invalidScenarioIds = scenarioIds.filter((scenarioId) => !validScenarioIds.has(scenarioId));
        if (invalidScenarioIds.length > 0) {
          return sendJson(res, 400, {
            error: "unknown scenario ids",
            invalidScenarioIds,
          });
        }
      }
      return sendJson(res, 200, runSoakSuite(scenarioIds));
    }

    if (req.method === "GET" && url.pathname === "/acceptance-cases") {
      const scenarios = listScenarioParityAcceptanceScenarios();
      return sendJson(res, 200, {
        totalScenarios: scenarios.length,
        scenarios,
      });
    }

    if (req.method === "POST" && url.pathname === "/acceptance-cases/run") {
      const body = await readJsonBody<{ scenarioIds?: string[] }>(req);
      const scenarioIds = Array.isArray(body.scenarioIds)
        ? body.scenarioIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;
      if (scenarioIds && scenarioIds.length > 0) {
        const validScenarioIds = new Set(listScenarioParityAcceptanceScenarios().map((scenario) => scenario.scenarioId));
        const invalidScenarioIds = scenarioIds.filter((scenarioId) => !validScenarioIds.has(scenarioId));
        if (invalidScenarioIds.length > 0) {
          return sendJson(res, 400, {
            error: "unknown scenario ids",
            invalidScenarioIds,
          });
        }
      }
      return sendJson(res, 200, runScenarioParityAcceptanceSuite(scenarioIds));
    }

    if (req.method === "GET" && url.pathname === "/validation-cases") {
      const suites = listValidationSuites();
      return sendJson(res, 200, {
        totalSuites: suites.length,
        totalItems: suites.reduce((sum: number, suite) => sum + suite.totalItems, 0),
        suites,
      });
    }

    if (req.method === "POST" && url.pathname === "/validation-cases/run") {
      const body = await readJsonBody<{ selectors?: string[] }>(req);
      const selectors = Array.isArray(body.selectors)
        ? body.selectors.filter((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;
      try {
        return sendJson(res, 200, runValidationSuites(selectors));
      } catch (error) {
        if (error instanceof ValidationSelectorError) {
          return sendJson(res, 400, { error: error.message });
        }
        throw error;
      }
    }

    if (req.method === "GET" && url.pathname === "/replay-incidents") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const action = url.searchParams.get("action") ?? undefined;
      const category = url.searchParams.get("category") ?? undefined;
      const report = buildReplayInspectionReport(
        await replayRecorder.list({
          ...(threadId ? { threadId } : {}),
          limit,
        })
      );
      return sendJson(res, 200, {
        totalReplays: report.totalReplays,
        totalGroups: report.totalGroups,
        incidents: report.incidents.filter(
          (incident) =>
            (action ? incident.recoveryHint.action === action : true) &&
            (category ? incident.rootFailureCategory === category : true)
        ),
      });
    }

    if (req.method === "GET" && url.pathname === "/replay-recoveries") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const action = url.searchParams.get("action") ?? undefined;
      const plans = buildReplayRecoveryPlans(
        await replayRecorder.list({
          ...(threadId ? { threadId } : {}),
          limit,
        })
      );
      return sendJson(res, 200, {
        totalRecoveries: plans.length,
        recoveries: plans.filter((plan) =>
          action ? plan.recoveryHint.action === action || plan.nextAction === action : true
        ),
      });
    }

    const replayGroupMatch = url.pathname.match(/^\/replay-groups\/([^/]+)$/);
    if (req.method === "GET" && replayGroupMatch) {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const records = await replayRecorder.list({ threadId });
      const report = buildReplayInspectionReport(records);
      const group = findReplayTaskSummary(records, decodeURIComponent(replayGroupMatch[1]!), report);
      if (!group) {
        return sendJson(res, 404, { error: "replay group not found" });
      }
      const relatedReplays = records
        .filter((record) => (record.taskId ?? record.replayId) === group.groupId)
        .sort((left, right) => left.recordedAt - right.recordedAt);
      return sendJson(res, 200, {
        group,
        replays: relatedReplays,
      });
    }

    const replayBundleMatch = url.pathname.match(/^\/replay-bundles\/([^/]+)$/);
    if (req.method === "GET" && replayBundleMatch) {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const synced = await loadRecoveryRuntime(threadId);
      const bundle = buildReplayIncidentBundle(synced.records, decodeURIComponent(replayBundleMatch[1]!));
      if (!bundle) {
        return sendJson(res, 404, { error: "replay bundle not found" });
      }
      const recoveryRun = synced.runs.find((run) => run.sourceGroupId === bundle.group.groupId);
      if (recoveryRun) {
        bundle.recoveryRun = recoveryRun;
        bundle.recoveryProgress = buildRecoveryRunProgress(recoveryRun);
        bundle.recoveryTimeline = buildRecoveryRunTimeline(
          recoveryRun,
          synced.records,
          await recoveryRunEventStore.listByRecoveryRun(recoveryRun.recoveryRunId)
        );
      }
      return sendJson(res, 200, bundle);
    }

    const replayRecoveryMatch = url.pathname.match(/^\/replay-recoveries\/([^/]+)$/);
    if (req.method === "GET" && replayRecoveryMatch) {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const synced = await loadRecoveryRuntime(threadId);
      const recovery = findReplayRecoveryPlan(
        synced.records,
        decodeURIComponent(replayRecoveryMatch[1]!),
        synced.report
      );
      if (!recovery) {
        return sendJson(res, 404, { error: "replay recovery not found" });
      }
      return sendJson(res, 200, recovery);
    }

    if (req.method === "GET" && url.pathname === "/recovery-runs") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const limit = parsePositiveInteger(url.searchParams.get("limit"));
      if (url.searchParams.get("limit") && limit == null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      const synced = await loadRecoveryRuntime(threadId);
      const runs = limit == null ? synced.runs : synced.runs.slice(0, limit);
      return sendJson(res, 200, {
        totalRuns: synced.runs.length,
        runs,
      });
    }

    const recoveryRunMatch = url.pathname.match(/^\/recovery-runs\/([^/]+)$/);
    if (req.method === "GET" && recoveryRunMatch) {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const synced = await loadRecoveryRuntime(threadId);
      const run = synced.runs.find((item) => item.recoveryRunId === decodeURIComponent(recoveryRunMatch[1]!)) ?? null;
      if (!run) {
        return sendJson(res, 404, { error: "recovery run not found" });
      }
      return sendJson(res, 200, run);
    }

    const recoveryTimelineMatch = url.pathname.match(/^\/recovery-runs\/([^/]+)\/timeline$/);
    if (req.method === "GET" && recoveryTimelineMatch) {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const synced = await loadRecoveryRuntime(threadId);
      const run = synced.runs.find((item) => item.recoveryRunId === decodeURIComponent(recoveryTimelineMatch[1]!)) ?? null;
      if (!run) {
        return sendJson(res, 404, { error: "recovery run not found" });
      }
      const events = await recoveryRunEventStore.listByRecoveryRun(run.recoveryRunId);
      const timeline = buildRecoveryRunTimeline(run, synced.records, events);
      return sendJson(res, 200, {
        recoveryRun: run,
        progress: buildRecoveryRunProgress(run),
        totalEntries: timeline.length,
        timeline,
      });
    }

    const recoveryRunActionMatch = url.pathname.match(
      /^\/recovery-runs\/([^/]+)\/(approve|reject|retry|fallback|resume)$/
    );
    if (req.method === "POST" && recoveryRunActionMatch) {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const action = recoveryRunActionMatch[2] as "approve" | "reject" | "retry" | "fallback" | "resume";
      const synced = await syncRecoveryRuntime(threadId);
      const run = synced.runs.find((item) => item.recoveryRunId === decodeURIComponent(recoveryRunActionMatch[1]!)) ?? null;
      if (!run) {
        return sendJson(res, 404, { error: "recovery run not found" });
      }
      const result = await executeRecoveryRunAction({
        run,
        action,
        report: synced.report,
        records: synced.records,
      });
      return sendJson(res, result.statusCode, result.body);
    }

    const replayRecoveryDispatchMatch = url.pathname.match(/^\/replay-recoveries\/([^/]+)\/dispatch$/);
    if (req.method === "POST" && replayRecoveryDispatchMatch) {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      const synced = await syncRecoveryRuntime(threadId);
      const recovery = findReplayRecoveryPlan(
        synced.records,
        decodeURIComponent(replayRecoveryDispatchMatch[1]!),
        synced.report
      );
      if (!recovery) {
        return sendJson(res, 404, { error: "replay recovery not found" });
      }
      if (!recovery.autoDispatchReady) {
        return sendJson(res, 409, {
          error: "recovery requires manual intervention",
          recovery,
        });
      }

      const run =
        synced.runs.find((item) => item.sourceGroupId === recovery.groupId) ??
        createRecoveryRunSkeleton(recovery, clock.now());
      if (!(await recoveryRunStore.get(run.recoveryRunId))) {
        await recoveryRunStore.put(run);
      }
      const result = await executeRecoveryRunAction({
        run,
        action: "dispatch",
        report: synced.report,
        records: synced.records,
      });
      return sendJson(res, result.statusCode, result.body);
    }

    const replayMatch = url.pathname.match(/^\/replays\/([^/]+)$/);
    if (req.method === "GET" && replayMatch) {
      const replay = await replayRecorder.get(decodeURIComponent(replayMatch[1]!));
      if (!replay) {
        return sendJson(res, 404, { error: "replay not found" });
      }
      return sendJson(res, 200, replay);
    }

    if (req.method === "POST" && url.pathname === "/browser-sessions/spawn") {
      const body = await readJsonBody<BrowserTaskRouteBody>(req);
      const owner = await resolveBrowserThreadOwner({
        threadId: body.threadId,
        ...(body.ownerType ? { ownerType: body.ownerType } : {}),
        ...(body.ownerId ? { ownerId: body.ownerId } : {}),
      });
      if ("error" in owner) {
        return sendJson(res, owner.statusCode, { error: owner.error });
      }
      const request = buildBrowserTaskRequest({
        body,
        idGenerator,
        owner,
      });
      return sendJson(res, 201, await browserBridge.spawnSession(request));
    }

    if (req.method === "GET" && url.pathname === "/browser-sessions") {
      const ownerType = url.searchParams.get("ownerType");
      const ownerId = url.searchParams.get("ownerId");
      const owner = await resolveBrowserThreadOwner({
        threadId: url.searchParams.get("threadId"),
        ...(ownerType ? { ownerType } : {}),
        ...(ownerId ? { ownerId } : {}),
      });
      if ("error" in owner) {
        return sendJson(res, owner.statusCode, { error: owner.error });
      }
      return sendJson(
        res,
        200,
        await browserBridge.listSessions({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
        })
      );
    }

    const browserSessionHistoryMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/history$/);
    if (req.method === "GET" && browserSessionHistoryMatch) {
      const access = await requireBrowserSessionAccess({
        browserSessionId: decodeURIComponent(browserSessionHistoryMatch[1]!),
        threadId: url.searchParams.get("threadId"),
      });
      if ("error" in access) {
        return sendJson(res, access.statusCode, { error: access.error });
      }
      const limit = parsePositiveLimit(url.searchParams.get("limit"));
      if (limit === null) {
        return sendJson(res, 400, { error: "limit must be a positive integer" });
      }
      return sendJson(
        res,
        200,
        await browserBridge.getSessionHistory({
          browserSessionId: access.sessionId,
          limit,
        })
      );
    }

    const browserSessionTargetsMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/targets$/);
    if (req.method === "GET" && browserSessionTargetsMatch) {
      const access = await requireBrowserSessionAccess({
        browserSessionId: decodeURIComponent(browserSessionTargetsMatch[1]!),
        threadId: url.searchParams.get("threadId"),
      });
      if ("error" in access) {
        return sendJson(res, access.statusCode, { error: access.error });
      }
      return sendJson(res, 200, await browserBridge.listTargets(access.sessionId));
    }

    if (req.method === "POST" && browserSessionTargetsMatch) {
      const body = await readJsonBody<{
        url: string;
        threadId?: string;
      }>(req);
      const access = await requireBrowserSessionAccess({
        browserSessionId: decodeURIComponent(browserSessionTargetsMatch[1]!),
        threadId: body.threadId,
      });
      if ("error" in access) {
        return sendJson(res, access.statusCode, { error: access.error });
      }
      return sendJson(
        res,
        201,
        await browserBridge.openTarget(access.sessionId, body.url, {
          ownerType: access.ownerType,
          ownerId: access.ownerId,
        })
      );
    }

    const browserSessionSendMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/send$/);
    if (req.method === "POST" && browserSessionSendMatch) {
      const body = await readJsonBody<BrowserTaskRouteBody>(req);
      const access = await requireBrowserSessionAccess({
        browserSessionId: decodeURIComponent(browserSessionSendMatch[1]!),
        threadId: body.threadId,
      });
      if ("error" in access) {
        return sendJson(res, access.statusCode, { error: access.error });
      }
      const request = buildBrowserTaskRequest({
        body,
        idGenerator,
        browserSessionId: access.sessionId,
        owner: {
          ownerType: access.ownerType,
          ownerId: access.ownerId,
        },
      });
      return sendJson(res, 200, await browserBridge.sendSession({ ...request, browserSessionId: request.browserSessionId! }));
    }

    const browserSessionResumeMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/resume$/);
    if (req.method === "POST" && browserSessionResumeMatch) {
      const body = await readJsonBody<BrowserTaskRouteBody>(req);
      const access = await requireBrowserSessionAccess({
        browserSessionId: decodeURIComponent(browserSessionResumeMatch[1]!),
        threadId: body.threadId,
      });
      if ("error" in access) {
        return sendJson(res, access.statusCode, { error: access.error });
      }
      const request = buildBrowserTaskRequest({
        body,
        idGenerator,
        browserSessionId: access.sessionId,
        owner: {
          ownerType: access.ownerType,
          ownerId: access.ownerId,
        },
      });
      return sendJson(
        res,
        200,
        await browserBridge.resumeSession({ ...request, browserSessionId: request.browserSessionId! })
      );
    }

    const browserSessionActivateMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/activate-target$/);
    if (req.method === "POST" && browserSessionActivateMatch) {
      const body = await readJsonBody<{
        targetId: string;
        threadId?: string;
      }>(req);
      const access = await requireBrowserSessionAccess({
        browserSessionId: decodeURIComponent(browserSessionActivateMatch[1]!),
        threadId: body.threadId,
      });
      if ("error" in access) {
        return sendJson(res, access.statusCode, { error: access.error });
      }
      return sendJson(
        res,
        200,
        await browserBridge.activateTarget(access.sessionId, body.targetId, {
          ownerType: access.ownerType,
          ownerId: access.ownerId,
        })
      );
    }

    const browserSessionCloseTargetMatch = url.pathname.match(/^\/browser-sessions\/([^/]+)\/close-target$/);
    if (req.method === "POST" && browserSessionCloseTargetMatch) {
      const body = await readJsonBody<{
        targetId: string;
        threadId?: string;
      }>(req);
      const access = await requireBrowserSessionAccess({
        browserSessionId: decodeURIComponent(browserSessionCloseTargetMatch[1]!),
        threadId: body.threadId,
      });
      if ("error" in access) {
        return sendJson(res, access.statusCode, { error: access.error });
      }
      return sendJson(
        res,
        200,
        await browserBridge.closeTarget(access.sessionId, body.targetId, {
          ownerType: access.ownerType,
          ownerId: access.ownerId,
        })
      );
    }

    if (req.method === "POST" && url.pathname === "/browser-sessions/evict-idle") {
      const body = await readOptionalJsonBody<{ idleMs?: number; idleBefore?: number; reason?: string }>(req);
      const idleBefore = body.idleBefore ?? clock.now() - (body.idleMs ?? 30 * 60 * 1000);
      return sendJson(
        res,
        200,
        await browserBridge.evictIdleSessions({
          idleBefore,
          ...(body.reason ? { reason: body.reason } : {}),
        })
      );
    }

    if (req.method === "GET" && url.pathname === "/scheduled-tasks") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) {
        return sendJson(res, 400, { error: "threadId is required" });
      }
      return sendJson(res, 200, await scheduledTaskRuntime.listByThread(threadId));
    }

    if (req.method === "POST" && url.pathname === "/messages") {
      const body = await readJsonBody<{ threadId: string; content: string }>(req);
      await coordinationEngine.handleUserPost(body);
      await teamEventBus.publish({
        eventId: idGenerator.messageId(),
        threadId: body.threadId,
        kind: "message.posted",
        createdAt: clock.now(),
        payload: {
          route: "user",
          contentLength: body.content.length,
        },
      });
      return sendJson(res, 202, { accepted: true, threadId: body.threadId });
    }

    if (req.method === "POST" && url.pathname === "/scheduled-tasks") {
      const body = await readJsonBody<{
        threadId: string;
        targetRoleId: string;
        capsule: {
          title: string;
          instructions: string;
          artifactRefs?: string[];
          dependencyRefs?: string[];
          expectedOutput?: string;
        };
        schedule: {
          kind: "cron";
          expr: string;
          tz: string;
        };
        sessionTarget?: "main" | "worker";
        targetWorker?: "browser" | "coder" | "finance" | "explore" | "harness";
      }>(req);
      return sendJson(res, 201, await scheduledTaskRuntime.schedule(body));
    }

    if (req.method === "POST" && url.pathname === "/scheduled-tasks/trigger-due") {
      let body: { now?: number };
      try {
        body = await readOptionalJsonBody<{ now?: number }>(req);
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }
      return sendJson(res, 200, await scheduledTaskRuntime.triggerDue(body.now));
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`daemon listening on http://127.0.0.1:${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log(`model catalog: ${modelCatalogPath ?? "(none)"}`);
  if (DAEMON_TOKEN) {
    console.log("auth: token required via x-turnkeyai-token or Authorization: Bearer <token>");
  } else {
    console.log("auth: disabled (set TURNKEYAI_DAEMON_TOKEN to enable)");
  }
  console.log("quick start:");
  console.log(`  curl -X POST http://127.0.0.1:${PORT}/threads/bootstrap-demo`);
  console.log(
    `  curl -X POST http://127.0.0.1:${PORT}/messages -H 'content-type: application/json' -d '{"threadId":"<THREAD_ID>","content":"Please start the demo flow"}'`
  );
});

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

function isAuthorizedRequest(req: http.IncomingMessage): boolean {
  if (!DAEMON_TOKEN) {
    return true;
  }

  const headerToken = req.headers["x-turnkeyai-token"];
  if (typeof headerToken === "string" && headerToken === DAEMON_TOKEN) {
    return true;
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim() === DAEMON_TOKEN;
  }

  return false;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  return JSON.parse(raw) as T;
}

async function readOptionalJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  if (raw.trim().length === 0) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}

async function readRawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parsePositiveLimit(value: string | null): number | null {
  if (value == null) {
    return 100;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return null;
  }

  return limit;
}

function parsePositiveInteger(value: string | null): number | null {
  if (value == null) {
    return null;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface BrowserTaskRouteBody {
  threadId?: string;
  taskId?: string;
  instructions?: string;
  url?: string;
  targetId?: string;
  actions?: BrowserTaskAction[];
  ownerType?: BrowserSessionOwnerType;
  ownerId?: string;
  profileOwnerType?: BrowserSessionOwnerType;
  profileOwnerId?: string;
  leaseHolderRunKey?: string;
  leaseTtlMs?: number;
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

async function loadRecoveryRuntime(threadId: string): Promise<{
  records: Awaited<ReturnType<typeof replayRecorder.list>>;
  report: ReturnType<typeof buildReplayInspectionReport>;
  runs: RecoveryRun[];
}> {
  const records = await replayRecorder.list({ threadId });
  const existingRuns = await recoveryRunStore.listByThread(threadId);
  const stabilizedRuns = await reapStaleRecoveryRuns(records, existingRuns, clock.now());
  const report = buildReplayInspectionReport(records);
  const runs = buildRecoveryRuns(records, stabilizedRuns, clock.now());
  return { records, report, runs };
}

async function listRuntimeChainEntriesByThread(
  threadId: string,
  limit: number
): Promise<RuntimeChainEntry[]> {
  const entries = await loadRuntimeChainEntriesForThread(threadId);
  return entries.slice(0, limit);
}

async function loadRuntimeChainEntriesForThread(
  threadId: string
): Promise<RuntimeChainEntry[]> {
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

  const entries = [
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

  return entries;
}

async function listActiveRuntimeChainEntries(
  limit: number,
  threadId?: string | null
): Promise<Array<{ chain: unknown; status: unknown }>> {
  return (await loadRuntimeChainEntriesForScope(threadId))
    .filter((entry) => !["resolved", "failed"].includes(entry.status.canonicalState ?? "open"))
    .slice(0, limit);
}

async function listRuntimeChainsByCanonicalState(
  state: RuntimeChainCanonicalState,
  limit: number,
  threadId?: string | null
): Promise<Array<{ chain: unknown; status: unknown }>> {
  return (await loadRuntimeChainEntriesForScope(threadId))
    .filter((entry) => entry.status.canonicalState === state)
    .slice(0, limit);
}

async function loadRuntimeSummary(threadId: string | null, limit: number): Promise<RuntimeSummaryReport> {
  return buildRuntimeSummaryReport({
    entries: await loadRuntimeChainEntriesForScope(threadId),
    limit,
    now: clock.now(),
  });
}

async function listStaleRuntimeChainEntries(
  limit: number,
  threadId?: string | null
): Promise<Array<{ chain: unknown; status: unknown }>> {
  return (await loadRuntimeChainEntriesForScope(threadId))
    .filter((entry) => Boolean(entry.status.stale))
    .slice(0, limit);
}

async function loadRuntimeChainEntriesForScope(
  threadId?: string | null
): Promise<RuntimeChainEntry[]> {
  if (threadId) {
    return loadRuntimeChainEntriesForThread(threadId);
  }
  const threads = await teamThreadStore.list();
  return (await Promise.all(threads.map((thread) => loadRuntimeChainEntriesForThread(thread.threadId))))
    .flat()
    .sort((left, right) => right.status.updatedAt - left.status.updatedAt);
}

async function loadRuntimeChainDetail(chainId: string, eventLimit = 50): Promise<{
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
      replayRecorder.list({ threadId: run.threadId }),
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
    replayRecorder.list({ threadId: chain.threadId }),
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

async function loadWorkerStatesByRunKey(roleRuns: RoleRunState[]): Promise<Map<string, WorkerSessionState>> {
  const workerRunKeys = [
    ...new Set(
      roleRuns.flatMap((run) =>
        Object.values(run.workerSessions ?? {}).filter((workerRunKey): workerRunKey is string => Boolean(workerRunKey))
      )
    ),
  ];
  const states = await Promise.all(workerRunKeys.map(async (workerRunKey) => [workerRunKey, await workerRuntime.getState(workerRunKey)] as const));
  return new Map(states.filter((entry): entry is readonly [string, WorkerSessionState] => Boolean(entry[1])));
}

async function syncRecoveryRuntime(threadId: string): Promise<{
  records: Awaited<ReturnType<typeof replayRecorder.list>>;
  report: ReturnType<typeof buildReplayInspectionReport>;
  runs: RecoveryRun[];
}> {
  const { records, report, runs } = await loadRecoveryRuntime(threadId);
  const existingRuns = await recoveryRunStore.listByThread(threadId);
  const existingByRunId = new Map(existingRuns.map((run) => [run.recoveryRunId, JSON.stringify(run)]));
  const previousByRunId = new Map(existingRuns.map((run) => [run.recoveryRunId, run]));
  const changedRuns = runs.filter((run) => existingByRunId.get(run.recoveryRunId) !== JSON.stringify(run));
  await Promise.all(changedRuns.map((run) => recoveryRunStore.put(run)));
  await Promise.all(
    changedRuns.map((run) =>
      appendDerivedRecoveryRunEvents({
        previous: previousByRunId.get(run.recoveryRunId) ?? null,
        next: run,
      })
    )
  );
  return { records, report, runs };
}

async function reapStaleRecoveryRuns(
  records: ReplayRecord[],
  existingRuns: RecoveryRun[],
  now: number
): Promise<RecoveryRun[]> {
  const nextRuns = [...existingRuns];
  for (let index = 0; index < nextRuns.length; index += 1) {
    const run = nextRuns[index]!;
    if (!isStaleInFlightRecoveryRun(run, records, now)) {
      continue;
    }
    const failed = buildStaleRecoveryRunFailure(run, now);
    nextRuns[index] = failed;
    await recoveryRunStore.put(failed);
    await recoveryRunEventStore.append({
      eventId: idGenerator.messageId(),
      recoveryRunId: failed.recoveryRunId,
      threadId: failed.threadId,
      sourceGroupId: failed.sourceGroupId,
      kind: "action_failed",
      status: "failed",
      recordedAt: now,
      summary: failed.latestSummary,
      ...(failed.currentAttemptId ? { attemptId: failed.currentAttemptId } : {}),
      ...(failed.latestFailure ? { failure: failed.latestFailure } : {}),
      transitionReason: "manual_dispatch",
    });
  }
  return nextRuns;
}

function isStaleInFlightRecoveryRun(run: RecoveryRun, records: ReplayRecord[], now: number): boolean {
  if (!["running", "retrying", "fallback_running", "resumed", "superseded"].includes(run.status)) {
    return false;
  }
  if (now - run.updatedAt < RECOVERY_RUN_STALE_AFTER_MS) {
    return false;
  }
  return !records.some((record) => {
    const groupId = record.taskId ?? record.replayId;
    const parentGroupId = extractRecoveryParentGroupIdFromReplay(record);
    return (groupId === run.sourceGroupId || parentGroupId === run.sourceGroupId) && record.recordedAt > run.updatedAt;
  });
}

function buildStaleRecoveryRunFailure(run: RecoveryRun, now: number): RecoveryRun {
  const failure = {
    category: "timeout" as const,
    layer: "scheduled" as const,
    retryable: false,
    message: "Recovery dispatch timed out before follow-up completed.",
    recommendedAction: "inspect" as const,
  };
  const { waitingReason: _waitingReason, ...rest } = run;
  return {
    ...rest,
    status: "failed",
    nextAction: "inspect_then_resume",
    autoDispatchReady: false,
    requiresManualIntervention: true,
    latestSummary: failure.message,
    latestFailure: failure,
    updatedAt: now,
    attempts: run.attempts.map((attempt) =>
      attempt.attemptId === run.currentAttemptId && attempt.completedAt == null
        ? {
            ...attempt,
            status: "failed",
            summary: failure.message,
            failure,
            updatedAt: now,
            completedAt: now,
          }
        : attempt
    ),
  };
}

function extractRecoveryParentGroupIdFromReplay(record: ReplayRecord): string | undefined {
  const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : null;
  const recoveryContext =
    metadata?.recoveryContext && typeof metadata.recoveryContext === "object"
      ? (metadata.recoveryContext as Record<string, unknown>)
      : null;
  return typeof recoveryContext?.parentGroupId === "string" ? recoveryContext.parentGroupId : undefined;
}

async function appendDerivedRecoveryRunEvents(input: {
  previous: RecoveryRun | null;
  next: RecoveryRun;
}): Promise<void> {
  const previous = input.previous;
  const next = input.next;
  const currentAttempt =
    next.currentAttemptId ? next.attempts.find((attempt) => attempt.attemptId === next.currentAttemptId) ?? null : null;

  if (previous && previous.status === next.status && previous.updatedAt === next.updatedAt) {
    return;
  }

  if (previous?.currentAttemptId && previous.currentAttemptId !== next.currentAttemptId) {
    await recoveryRunEventStore.append({
      eventId: idGenerator.messageId(),
      recoveryRunId: next.recoveryRunId,
      threadId: next.threadId,
      sourceGroupId: next.sourceGroupId,
      kind: "follow_up_observed",
      status: next.status,
      recordedAt: next.updatedAt,
      summary: `Recovery follow-up observed for ${next.sourceGroupId}.`,
      ...(next.currentAttemptId ? { attemptId: next.currentAttemptId } : {}),
      ...(currentAttempt?.triggeredByAttemptId ? { triggeredByAttemptId: currentAttempt.triggeredByAttemptId } : {}),
      ...(currentAttempt?.transitionReason ? { transitionReason: currentAttempt.transitionReason } : {}),
      ...(next.browserSession ? { browserSession: next.browserSession } : {}),
      ...(currentAttempt?.browserOutcome ? { browserOutcome: currentAttempt.browserOutcome } : {}),
      ...(next.latestFailure ? { failure: next.latestFailure } : {}),
    });
    return;
  }

  if (previous?.status === next.status) {
    return;
  }

  const derivedKind = mapRecoveryStatusToEventKind(next.status);
  if (!derivedKind) {
    return;
  }

  await recoveryRunEventStore.append({
    eventId: idGenerator.messageId(),
    recoveryRunId: next.recoveryRunId,
    threadId: next.threadId,
    sourceGroupId: next.sourceGroupId,
    kind: derivedKind,
    status: next.status,
    recordedAt: next.updatedAt,
    summary: next.latestSummary,
    ...(next.currentAttemptId ? { attemptId: next.currentAttemptId } : {}),
    ...(currentAttempt?.triggeredByAttemptId ? { triggeredByAttemptId: currentAttempt.triggeredByAttemptId } : {}),
    ...(currentAttempt?.transitionReason ? { transitionReason: currentAttempt.transitionReason } : {}),
    ...(next.browserSession ? { browserSession: next.browserSession } : {}),
    ...(currentAttempt?.browserOutcome ? { browserOutcome: currentAttempt.browserOutcome } : {}),
    ...(next.latestFailure ? { failure: next.latestFailure } : {}),
  });
}

function mapRecoveryStatusToEventKind(status: RecoveryRun["status"]): RecoveryRunEvent["kind"] | null {
  switch (status) {
    case "waiting_approval":
      return "waiting_approval";
    case "waiting_external":
      return "waiting_external";
    case "recovered":
      return "recovered";
    case "aborted":
      return "aborted";
    default:
      return null;
  }
}

function createRecoveryRunSkeleton(recovery: ReplayRecoveryPlan, now: number): RecoveryRun {
  return {
    recoveryRunId: buildRecoveryRunId(recovery.groupId),
    threadId: recovery.threadId,
    sourceGroupId: recovery.groupId,
    ...(recovery.taskId ? { taskId: recovery.taskId } : {}),
    ...(recovery.flowId ? { flowId: recovery.flowId } : {}),
    ...(recovery.roleId ? { roleId: recovery.roleId } : {}),
    ...(recovery.targetLayer ? { targetLayer: recovery.targetLayer } : {}),
    ...(recovery.targetWorker ? { targetWorker: recovery.targetWorker } : {}),
    latestStatus: recovery.latestStatus,
    status: recovery.requiresManualIntervention
      ? recovery.nextAction === "request_approval"
        ? "waiting_approval"
        : "waiting_external"
      : "planned",
    nextAction: recovery.nextAction,
    autoDispatchReady: recovery.autoDispatchReady,
    requiresManualIntervention: recovery.requiresManualIntervention,
    latestSummary: recovery.recoveryHint.reason,
    ...(recovery.requiresManualIntervention ? { waitingReason: recovery.recoveryHint.reason } : {}),
    ...(recovery.latestFailure ? { latestFailure: recovery.latestFailure } : {}),
    attempts: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function executeRecoveryRunAction(input: {
  run: RecoveryRun;
  action: RecoveryRunAction;
  records: Awaited<ReturnType<typeof replayRecorder.list>>;
  report: ReturnType<typeof buildReplayInspectionReport>;
}): Promise<{ statusCode: number; body: unknown }> {
  return recoveryRunActionMutex.run(input.run.threadId, async () => {
    const now = clock.now();
    const synced = await syncRecoveryRuntime(input.run.threadId);
    const run = synced.runs.find((item) => item.recoveryRunId === input.run.recoveryRunId) ?? input.run;
    const recoveryPlan = findReplayRecoveryPlan(synced.records, run.sourceGroupId, synced.report);
    const syncedRun = findRecoveryRun(synced.records, run.recoveryRunId, [run], now) ?? run;

    const actionGuardConflict = buildRecoveryRunActionConflict(syncedRun, input.action);
    if (actionGuardConflict) {
      return {
        statusCode: 409,
        body: actionGuardConflict,
      };
    }

    if (input.action === "reject") {
      const attemptId = `${run.recoveryRunId}:attempt:${run.attempts.length + 1}`;
      const triggeredByAttemptId = syncedRun.currentAttemptId;
      const rejectedRun: RecoveryRun = {
        ...syncedRun,
        status: "aborted",
        nextAction: "stop",
        latestSummary: "Recovery was rejected and aborted.",
        currentAttemptId: attemptId,
        updatedAt: now,
        attempts: [
          ...syncedRun.attempts,
          {
            attemptId,
            action: "reject",
            requestedAt: now,
            updatedAt: now,
            status: "aborted",
            nextAction: "stop",
            summary: "Recovery was rejected and aborted.",
            ...(triggeredByAttemptId ? { triggeredByAttemptId } : {}),
            transitionReason: "manual_reject",
            completedAt: now,
          },
        ],
      };
      await recoveryRunStore.put(rejectedRun);
      await publishRecoveryRuntimeState(rejectedRun);
      await recoveryRunEventStore.append({
        eventId: idGenerator.messageId(),
        recoveryRunId: rejectedRun.recoveryRunId,
        threadId: rejectedRun.threadId,
        sourceGroupId: rejectedRun.sourceGroupId,
        kind: "aborted",
        status: "aborted",
        recordedAt: now,
        summary: "Recovery was rejected and aborted.",
        action: "reject",
        attemptId,
        ...(triggeredByAttemptId ? { triggeredByAttemptId } : {}),
        transitionReason: "manual_reject",
      });
      await recordRecoveryProgress(rejectedRun, {
        phase: "cancelled",
        summary: "Recovery was rejected and aborted.",
        statusReason: "manual_reject",
        heartbeatSource: "control_path",
      });
      return {
        statusCode: 200,
        body: {
          accepted: true,
          recoveryRun: rejectedRun,
        },
      };
    }

    if (!recoveryPlan && (input.action === "dispatch" || input.action === "retry" || input.action === "fallback" || input.action === "resume")) {
      return {
        statusCode: 409,
        body: buildRecoveryRunActionConflict(
          syncedRun,
          input.action,
          "recovery can no longer be resumed automatically"
        )!,
      };
    }

    if (!syncedRun.roleId) {
      return {
        statusCode: 409,
        body: buildRecoveryRunActionConflict(syncedRun, input.action, "recovery run is missing target role")!,
      };
    }

    const dispatchNextAction = mapRecoveryRunActionToNextAction(input.action, recoveryPlan, syncedRun);
    if (!dispatchNextAction) {
      return {
        statusCode: 409,
        body: buildRecoveryRunActionConflict(syncedRun, input.action, "recovery action is not dispatchable")!,
      };
    }

    if ((dispatchNextAction === "retry_same_layer" || dispatchNextAction === "fallback_transport" || dispatchNextAction === "auto_resume") && syncedRun.targetLayer === "worker" && !syncedRun.targetWorker) {
      return {
        statusCode: 409,
        body: buildRecoveryRunActionConflict(syncedRun, input.action, "recovery run is missing target worker")!,
      };
    }

    const browserSession = deriveRecoveryBrowserSessionHint(synced.records, syncedRun);
    const attemptId = `${syncedRun.recoveryRunId}:attempt:${syncedRun.attempts.length + 1}`;
    const taskId = idGenerator.taskId();
    const dispatchReplayId = `${taskId}:scheduled`;
    const supersededAttemptId = syncedRun.currentAttemptId;
    const transitionReason = transitionReasonForAction(input.action);
    await recoveryRunEventStore.append({
    eventId: idGenerator.messageId(),
    recoveryRunId: syncedRun.recoveryRunId,
    threadId: syncedRun.threadId,
    sourceGroupId: syncedRun.sourceGroupId,
    kind: "action_requested",
    status: statusForRecoveryRunAction(input.action),
    recordedAt: now,
    summary: `Recovery ${input.action} requested.`,
    action: input.action,
    attemptId,
    taskId,
    ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
    transitionReason,
    ...(browserSession ? { browserSession } : {}),
  });
    const scheduledTask = buildRecoveryDispatchTask({
    run: syncedRun,
    ...(browserSession ? { browserSession } : {}),
    nextAction: dispatchNextAction,
    now,
    taskId,
    attemptId,
    dispatchReplayId,
  });
    const supersededAttempts: RecoveryRun["attempts"] = syncedRun.attempts.map((attempt) =>
    attempt.attemptId === supersededAttemptId &&
    attempt.status !== "recovered" &&
    attempt.status !== "aborted" &&
    attempt.status !== "superseded"
      ? {
          ...attempt,
          status: "superseded",
          summary: `Superseded by recovery ${input.action}.`,
          updatedAt: now,
          completedAt: attempt.completedAt ?? now,
          supersededAt: now,
          supersededByAttemptId: attemptId,
        }
      : attempt
  );
    const inFlightRun: RecoveryRun = {
    ...syncedRun,
    status: statusForRecoveryRunAction(input.action),
    nextAction: dispatchNextAction,
    latestSummary: `Recovery ${input.action} dispatched.`,
    currentAttemptId: attemptId,
    updatedAt: now,
    ...(browserSession ? { browserSession } : {}),
    attempts: [
      ...supersededAttempts,
      {
        attemptId,
        action: input.action,
        requestedAt: now,
        updatedAt: now,
        status: statusForRecoveryRunAction(input.action),
        nextAction: dispatchNextAction,
        summary: `Recovery ${input.action} dispatched.`,
        ...(syncedRun.targetLayer ? { targetLayer: syncedRun.targetLayer } : {}),
        ...(syncedRun.targetWorker ? { targetWorker: syncedRun.targetWorker } : {}),
        dispatchReplayId,
        dispatchedTaskId: taskId,
        ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
        transitionReason,
        ...(browserSession ? { browserSession } : {}),
      },
    ],
  };
    await recoveryRunStore.put(inFlightRun);
    await publishRecoveryRuntimeState(inFlightRun);
    if (supersededAttemptId) {
      await recoveryRunEventStore.append({
      eventId: idGenerator.messageId(),
      recoveryRunId: inFlightRun.recoveryRunId,
      threadId: inFlightRun.threadId,
      sourceGroupId: inFlightRun.sourceGroupId,
      kind: "action_superseded",
      status: "superseded",
      recordedAt: now,
      summary: `Recovery attempt ${supersededAttemptId} was superseded by ${attemptId}.`,
      action: input.action,
      attemptId: supersededAttemptId,
      triggeredByAttemptId: attemptId,
      transitionReason,
      taskId,
      ...(browserSession ? { browserSession } : {}),
    });
    }
    await recordRecoveryProgress(inFlightRun, {
      phase: buildDerivedRecoveryRuntimeChain(inFlightRun).status.phase,
      summary: `Recovery ${input.action} dispatched for ${inFlightRun.sourceGroupId}.`,
      statusReason: transitionReason,
      heartbeatSource: "control_path",
    });

    const stopRecoveryHeartbeat = startRecoveryHeartbeat(inFlightRun, input.action);
    try {
      await coordinationEngine.handleScheduledTask(scheduledTask);
    } catch (error) {
    stopRecoveryHeartbeat();
    const failure = classifyRuntimeError({
      layer: "scheduled",
      error,
      fallbackMessage: "recovery dispatch failed",
    });
    const targetWorker = getScheduledTargetWorker(scheduledTask);
    await replayRecorder.record({
      replayId: dispatchReplayId,
      layer: "scheduled",
      status: "failed",
      recordedAt: now,
      threadId: scheduledTask.threadId,
      taskId: scheduledTask.taskId,
      roleId: getScheduledTargetRoleId(scheduledTask),
      ...(targetWorker ? { workerType: targetWorker } : {}),
      summary: failure.message,
      failure,
      metadata: {
        sessionTarget: getScheduledSessionTarget(scheduledTask),
        schedule: scheduledTask.schedule,
        capsule: scheduledTask.capsule,
        recoveryContext: getScheduledContinuity(scheduledTask)?.context?.recovery,
      },
    });
    const failedRun: RecoveryRun = {
      ...inFlightRun,
      status: "failed",
      latestSummary: failure.message,
      latestFailure: failure,
      updatedAt: now,
      attempts: inFlightRun.attempts.map((attempt) =>
        attempt.attemptId === attemptId
          ? {
              ...attempt,
              status: "failed",
              summary: failure.message,
              failure,
              updatedAt: now,
              completedAt: now,
            }
          : attempt
      ),
    };
    await recoveryRunStore.put(failedRun);
    await publishRecoveryRuntimeState(failedRun);
    await recoveryRunEventStore.append({
      eventId: idGenerator.messageId(),
      recoveryRunId: failedRun.recoveryRunId,
      threadId: failedRun.threadId,
      sourceGroupId: failedRun.sourceGroupId,
      kind: "action_failed",
      status: "failed",
      recordedAt: now,
      summary: failure.message,
      action: input.action,
      attemptId,
      ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
      transitionReason,
      dispatchReplayId,
      taskId,
      ...(browserSession ? { browserSession } : {}),
      failure,
    });
      await recordRecoveryProgress(failedRun, {
        phase: "failed",
        summary: failure.message,
        statusReason: failure.message,
        heartbeatSource: "control_path",
      });
      return {
      statusCode: 500,
      body: {
        error: failure.message,
        dispatchedTaskId: taskId,
        dispatchReplayId,
        failure,
        recoveryRun: failedRun,
      },
    };
    }
    stopRecoveryHeartbeat();

    const targetWorker = getScheduledTargetWorker(scheduledTask);
    await replayRecorder.record({
    replayId: dispatchReplayId,
    layer: "scheduled",
    status: "completed",
    recordedAt: now,
    threadId: scheduledTask.threadId,
    taskId: scheduledTask.taskId,
    roleId: getScheduledTargetRoleId(scheduledTask),
    ...(targetWorker ? { workerType: targetWorker } : {}),
    summary: `Recovery ${input.action} dispatched for ${syncedRun.sourceGroupId}.`,
    metadata: {
      sessionTarget: getScheduledSessionTarget(scheduledTask),
      schedule: scheduledTask.schedule,
      capsule: scheduledTask.capsule,
      recoveryContext: getScheduledContinuity(scheduledTask)?.context?.recovery,
    },
  });
    await recoveryRunEventStore.append({
    eventId: idGenerator.messageId(),
    recoveryRunId: inFlightRun.recoveryRunId,
    threadId: inFlightRun.threadId,
    sourceGroupId: inFlightRun.sourceGroupId,
    kind: "action_dispatched",
    status: inFlightRun.status,
    recordedAt: now,
    summary: `Recovery ${input.action} dispatched for ${inFlightRun.sourceGroupId}.`,
    action: input.action,
    attemptId,
    ...(supersededAttemptId ? { triggeredByAttemptId: supersededAttemptId } : {}),
    transitionReason,
    dispatchReplayId,
    taskId,
    ...(browserSession ? { browserSession } : {}),
  });

    const refreshed = await syncRecoveryRuntime(syncedRun.threadId);
    const latestRun = refreshed.runs.find((item) => item.recoveryRunId === syncedRun.recoveryRunId) ?? inFlightRun;
    await publishRecoveryRuntimeState(latestRun);
    return {
      statusCode: 202,
      body: {
        accepted: true,
        dispatchedTaskId: taskId,
        dispatchReplayId,
        recoveryRun: latestRun,
      },
    };
  });
}

async function publishRecoveryRuntimeState(run: RecoveryRun): Promise<void> {
  const derived = buildDerivedRecoveryRuntimeChain(run);
  await runtimeStateRecorder.record(derived);
}

async function recordRecoveryProgress(
  run: RecoveryRun,
  input: {
    phase: RuntimeChainStatus["phase"];
    summary: string;
    statusReason?: string;
    heartbeatSource?: "phase_transition" | "activity_echo" | "control_path" | "reconnect_window" | "long_running_tick";
  }
): Promise<void> {
  const derived = buildDerivedRecoveryRuntimeChain(run);
  await runtimeProgressRecorder.record({
    progressId: `progress:recovery:${run.recoveryRunId}:${input.phase}:${clock.now()}`,
    threadId: run.threadId,
    chainId: derived.chain.chainId,
    spanId: `recovery:${run.recoveryRunId}`,
    subjectKind: "recovery_run",
    subjectId: run.recoveryRunId,
    phase: input.phase === "resolved" ? "completed" : input.phase,
    progressKind: input.phase === "waiting" || input.phase === "heartbeat" || run.status === "resumed" ? "heartbeat" : "transition",
    heartbeatSource: input.heartbeatSource ?? (run.status === "resumed" ? "reconnect_window" : "phase_transition"),
    ...(derived.status.continuityState ? { continuityState: derived.status.continuityState } : {}),
    ...(derived.status.responseTimeoutAt ? { responseTimeoutAt: derived.status.responseTimeoutAt } : {}),
    ...(derived.status.reconnectWindowUntil ? { reconnectWindowUntil: derived.status.reconnectWindowUntil } : {}),
    ...(derived.status.closeKind ? { closeKind: derived.status.closeKind } : {}),
    ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    summary: input.summary,
    recordedAt: clock.now(),
    ...(run.flowId ? { flowId: run.flowId } : {}),
    ...(run.taskId ? { taskId: run.taskId } : {}),
    ...(run.roleId ? { roleId: run.roleId } : {}),
    artifacts: {
      recoveryRunId: run.recoveryRunId,
      ...(run.browserSession?.sessionId ? { browserSessionId: run.browserSession.sessionId } : {}),
      ...(run.browserSession?.targetId ? { browserTargetId: run.browserSession.targetId } : {}),
    },
    metadata: {
      sourceGroupId: run.sourceGroupId,
      status: run.status,
      nextAction: run.nextAction,
    },
  });
}

function startRecoveryHeartbeat(run: RecoveryRun, action: RecoveryRunAction): () => void {
  const intervalMs = 15_000;
  let stopped = false;
  const timer = setInterval(() => {
    void recordRecoveryProgress(run, {
      phase: "heartbeat",
      summary: `Recovery ${action} is still running for ${run.sourceGroupId}.`,
      heartbeatSource: "long_running_tick",
    }).catch(() => {});
  }, intervalMs);
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

function buildRecoveryDispatchTask(input: {
  run: RecoveryRun;
  browserSession?: BrowserContinuationHint;
  nextAction: ReplayRecoveryPlan["nextAction"];
  now: number;
  taskId: string;
  attemptId: string;
  dispatchReplayId: string;
}): ScheduledTaskRecord {
  if (!input.run.roleId) {
    throw new Error(`recovery run is missing target role: ${input.run.recoveryRunId}`);
  }

  const rawTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  const tz = rawTz.trim() ? rawTz : "UTC";

  return {
    taskId: input.taskId,
    threadId: input.run.threadId,
    targetRoleId: input.run.roleId,
    ...(input.run.targetLayer === "worker" && input.run.targetWorker
      ? { targetWorker: input.run.targetWorker }
      : {}),
    sessionTarget: input.run.targetLayer === "worker" ? "worker" : "main",
    recoveryContext: {
      parentGroupId: input.run.sourceGroupId,
      action: input.nextAction,
      dispatchReplayId: input.dispatchReplayId,
      recoveryRunId: input.run.recoveryRunId,
      attemptId: input.attemptId,
    },
    dispatch: {
      targetRoleId: input.run.roleId,
      ...(input.run.targetLayer === "worker" && input.run.targetWorker
        ? { targetWorker: input.run.targetWorker }
        : {}),
      sessionTarget: input.run.targetLayer === "worker" ? "worker" : "main",
      continuity: {
        mode: input.run.targetLayer === "worker" ? "resume-existing" : "prefer-existing",
        context: {
          source: "recovery_dispatch",
          ...(input.run.targetWorker ? { workerType: input.run.targetWorker } : {}),
          recovery: {
            parentGroupId: input.run.sourceGroupId,
            action: input.nextAction,
            dispatchReplayId: input.dispatchReplayId,
            recoveryRunId: input.run.recoveryRunId,
            attemptId: input.attemptId,
          },
          ...(input.run.targetWorker === "browser" && input.browserSession
            ? { browserSession: input.browserSession }
            : {}),
        },
      },
      ...(input.run.targetLayer === "worker" && input.run.targetWorker
        ? { constraints: { preferredWorkerKinds: [input.run.targetWorker] } }
        : {}),
    },
    capsule: {
      title: `Recovery dispatch for ${input.run.sourceGroupId}`,
      instructions: buildRecoveryInstructions(input.run, input.nextAction),
      expectedOutput:
        "Continue from the latest safe checkpoint. If recovery is not possible, return a concise explanation and the next safest action.",
    },
    schedule: {
      kind: "cron",
      expr: "manual-recovery",
      tz,
      nextRunAt: input.now,
    },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function buildRecoveryInstructions(run: RecoveryRun, nextAction: ReplayRecoveryPlan["nextAction"]): string {
  const header = `Recovery plan for ${run.sourceGroupId}. Latest status: ${run.latestStatus}.`;
  const reason = `Reason: ${run.latestFailure?.message ?? run.waitingReason ?? run.latestSummary}`;
  const target =
    run.targetLayer === "worker"
      ? `Resume target: worker${run.targetWorker ? ` (${run.targetWorker})` : ""}.`
      : run.targetLayer
        ? `Resume target: ${run.targetLayer}.`
        : "Resume target: main role context.";

  switch (nextAction) {
    case "auto_resume":
      return `${header} ${reason} ${target} Continue from the latest live continuation context and finish the interrupted work.`;
    case "retry_same_layer":
      return `${header} ${reason} ${target} Retry the previous execution on the same layer without resetting unrelated context.`;
    case "fallback_transport":
      return `${header} ${reason} ${target} Retry using the safest fallback transport or tool path that preserves task intent.`;
    case "request_approval":
      return `${header} ${reason} ${target} Wait for approval before resuming any side-effectful action.`;
    default:
      return `${header} ${reason} ${target} Inspect the latest failure and continue only if the context is still valid.`;
  }
}

function mapRecoveryRunActionToNextAction(
  action: RecoveryRunAction,
  recovery: ReplayRecoveryPlan | null,
  run: RecoveryRun
): ReplayRecoveryPlan["nextAction"] | null {
  const currentAttempt = run.currentAttemptId
    ? run.attempts.find((attempt) => attempt.attemptId === run.currentAttemptId) ?? null
    : null;

  switch (action) {
    case "dispatch":
      return recovery?.nextAction ?? (run.nextAction === "none" ? null : run.nextAction);
    case "retry":
      return "retry_same_layer";
    case "fallback":
      return "fallback_transport";
    case "resume":
      return "auto_resume";
    case "approve":
      return isDispatchableRecoveryNextAction(currentAttempt?.nextAction)
        ? currentAttempt!.nextAction
        : run.targetLayer === "worker"
          ? "retry_same_layer"
          : "auto_resume";
    case "reject":
      return null;
    default:
      return null;
  }
}

function isDispatchableRecoveryNextAction(
  nextAction: RecoveryRun["nextAction"] | ReplayRecoveryPlan["nextAction"] | undefined
): nextAction is "auto_resume" | "retry_same_layer" | "fallback_transport" {
  return nextAction === "auto_resume" || nextAction === "retry_same_layer" || nextAction === "fallback_transport";
}

function transitionReasonForAction(action: RecoveryRunAction) {
  switch (action) {
    case "retry":
      return "manual_retry" as const;
    case "fallback":
      return "manual_fallback" as const;
    case "resume":
      return "manual_resume" as const;
    case "approve":
      return "manual_approval" as const;
    case "reject":
      return "manual_reject" as const;
    case "dispatch":
    default:
      return "manual_dispatch" as const;
  }
}

function statusForRecoveryRunAction(action: RecoveryRunAction): RecoveryRun["status"] {
  switch (action) {
    case "retry":
      return "retrying";
    case "fallback":
      return "fallback_running";
    case "resume":
    case "approve":
      return "resumed";
    case "reject":
      return "aborted";
    case "dispatch":
    default:
      return "running";
  }
}

function deriveRecoveryBrowserSessionHint(
  records: Awaited<ReturnType<typeof replayRecorder.list>>,
  run: RecoveryRun
): BrowserContinuationHint | undefined {
  const candidateTaskIds = new Set<string>([
    run.sourceGroupId,
    ...run.attempts.flatMap((attempt) => [attempt.dispatchedTaskId, attempt.resultingGroupId]).filter((value): value is string => Boolean(value)),
  ]);
  const relatedRecords = records
    .filter((record) => {
      const groupId = record.taskId ?? record.replayId;
      return candidateTaskIds.has(groupId);
    })
    .sort((left, right) => right.recordedAt - left.recordedAt);

  for (const record of relatedRecords) {
    const hint = extractBrowserSessionHintFromReplay(record);
    if (hint) {
      return hint;
    }
  }

  const latestAttemptHint = [...run.attempts].reverse().find((attempt) => attempt.browserSession)?.browserSession;
  return latestAttemptHint ?? run.browserSession;
}

function extractBrowserSessionHintFromReplay(
  record: Awaited<ReturnType<typeof replayRecorder.list>>[number]
): BrowserContinuationHint | undefined {
  const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : null;
  if (!metadata) {
    return undefined;
  }

  if (record.layer === "browser") {
    const request = metadata.request && typeof metadata.request === "object" ? (metadata.request as Record<string, unknown>) : null;
    const result = metadata.result && typeof metadata.result === "object" ? metadata.result : null;
    const decoded = decodeBrowserSessionPayload(result);
    if (!decoded) {
      return undefined;
    }
    const ownerType = normalizeBrowserOwnerType(request?.ownerType);
    const ownerId = typeof request?.ownerId === "string" ? request.ownerId : record.threadId;
    return {
      sessionId: decoded.sessionId,
      ...(decoded.targetId ? { targetId: decoded.targetId } : {}),
      ...(decoded.resumeMode ? { resumeMode: decoded.resumeMode } : {}),
      ...(ownerType ? { ownerType } : {}),
      ...(ownerId ? { ownerId } : {}),
    };
  }

  if (record.layer === "worker") {
    const payload = metadata.payload;
    const decoded = decodeBrowserSessionPayload(payload);
    if (!decoded) {
      return undefined;
    }
    return {
      sessionId: decoded.sessionId,
      ...(decoded.targetId ? { targetId: decoded.targetId } : {}),
      ...(decoded.resumeMode ? { resumeMode: decoded.resumeMode } : {}),
      ownerType: "thread",
      ownerId: record.threadId,
      ...(record.workerRunKey ? { leaseHolderRunKey: record.workerRunKey } : {}),
    };
  }

  return undefined;
}

function normalizeBrowserOwnerType(value: unknown): BrowserContinuationHint["ownerType"] | undefined {
  return value === "user" || value === "thread" || value === "role" || value === "worker" ? value : undefined;
}

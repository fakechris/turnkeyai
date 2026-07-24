// P1.5b — Daemon composition root, runtime services layer.
//
// This module owns the wiring of the daemon's stateful/cyclic runtime layer:
// the worker runtime + its startup reconcile, the LLM gateway, the role
// runtime, the role-run coordinator, the runtime/state/chain recorders, the
// cyclic CoordinationEngine ↔ InlineRoleLoopRunner pair, the recovery action
// service, the runtime reconciliation timer with its mutable result state, the
// scheduled task runtime, and the runtime query service.
//
// The mutable reconciliation state (runtimeReconciliationPassResult and the
// startup-reconcile result fields it derives) is hidden inside the function's
// closure scope. The setInterval timer is created here and given `.unref()`
// so the process can exit naturally; daemon.ts never needs to clear it.

import path from "node:path";

import type {
  Clock,
  IdGenerator,
  RuntimeSummaryReport,
  WorkerKind,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { AnthropicCompatibleClient } from "@turnkeyai/llm-adapter/anthropic-compatible-client";
import { FileModelCatalogSource } from "@turnkeyai/llm-adapter/file-model-catalog";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import type { RequestEnvelopeLimits } from "@turnkeyai/llm-adapter/index";
import { OpenAICompatibleClient } from "@turnkeyai/llm-adapter/openai-compatible-client";
import { ModelRegistry } from "@turnkeyai/llm-adapter/registry";
import { CoordinationEngine } from "@turnkeyai/team-runtime/coordination-engine";
import { DefaultHandoffPlanner } from "@turnkeyai/team-runtime/handoff-planner";
import { InlineRoleLoopRunner } from "@turnkeyai/team-runtime/inline-role-loop-runner";
import { DefaultRoleRunCoordinator } from "@turnkeyai/team-runtime/role-run-coordinator";
import { DefaultRuntimeChainRecorder } from "@turnkeyai/team-runtime/runtime-chain-recorder";
import { DefaultRuntimeStateRecorder } from "@turnkeyai/team-runtime/runtime-state-recorder";
import { DefaultScheduledTaskRuntime } from "@turnkeyai/team-runtime/scheduled-task-runtime";
import { DeterministicRoleResponseGenerator } from "@turnkeyai/role-runtime/deterministic-response-generator";
import { HeuristicModelAdapter } from "@turnkeyai/role-runtime/model-adapter";
import { HybridRoleResponseGenerator } from "@turnkeyai/role-runtime/hybrid-response-generator";
import { LLMRoleResponseGenerator } from "@turnkeyai/role-runtime/llm-response-generator";
import { PolicyRoleRuntime } from "@turnkeyai/role-runtime/policy-role-runtime";
import { DefaultPreCompactionMemoryFlusher } from "@turnkeyai/role-runtime/pre-compaction-memory-flusher";
import type { PreCompactionMemoryFlusher } from "@turnkeyai/role-runtime/pre-compaction-memory-flusher";
import { DefaultRolePromptPolicy } from "@turnkeyai/role-runtime/prompt-policy";
import { LLMSubAgentWorkerHandler } from "@turnkeyai/role-runtime/sub-agent-worker-handler";
import {
  createNativeToolCapabilityRegistry,
  type ToolCapabilityRegistry,
} from "@turnkeyai/role-runtime/tool-capability-registry";
import {
  InMemoryToolCancellationRegistry,
  type ToolCancellationRegistry,
} from "@turnkeyai/role-runtime/tool-cancellation-registry";
import type { TaskToolService } from "@turnkeyai/role-runtime/task-tool-service";
import type { ToolPermissionService } from "@turnkeyai/role-runtime/tool-permission-service";
import { FileToolResultArtifactStore } from "@turnkeyai/role-runtime/tool-result-artifact-store";
import { createWorkerSessionToolExecutor } from "@turnkeyai/role-runtime/tool-use";
import { sweepOrphanWorkerSessions } from "@turnkeyai/role-runtime/worker-session-hygiene";
import { LocalWorkerRuntime } from "@turnkeyai/worker-runtime/local-worker-runtime";

import { createRecoveryActionService } from "../recovery-action-service";
import { createRuntimeQueryService } from "../runtime-query-service";
import { recoverRoleRunsOnStartup } from "../role-run-startup-recovery";
import {
  runRuntimeReconciliationPass,
  type RuntimeReconciliationPassResult,
} from "../runtime-reconciliation-pass";
import { reconcileWorkerBindingsOnStartup } from "../worker-binding-startup-reconcile";

import type { DaemonFoundations } from "./foundations";

const DEFAULT_AGENT_TOOL_MAX_ROUNDS = 128;
const DEFAULT_AGENT_TOOL_TIMEOUT_MS = readPositiveIntegerEnv("TURNKEYAI_AGENT_TOOL_TIMEOUT_MS", 120_000);
const DEFAULT_AGENT_TOOL_WALL_CLOCK_MS = readPositiveIntegerEnv("TURNKEYAI_AGENT_TOOL_WALL_CLOCK_MS", 120_000);
const DEFAULT_AGENT_TOOL_HARD_TIMEOUT_GRACE_MS = readPositiveIntegerEnv(
  "TURNKEYAI_AGENT_TOOL_HARD_TIMEOUT_GRACE_MS",
  10_000
);
const DEFAULT_AGENT_TOOL_MAX_PARALLEL_CALLS = 5;
const DEFAULT_AGENT_TOOL_MAX_CALLS_PER_ROUND = 5;
const DEFAULT_AGENT_TOOL_MAX_PARENT_SESSIONS = 5;
const DEFAULT_AGENT_TOOL_MAX_GLOBAL_SESSIONS = 12;
const DEFAULT_WORKER_SESSION_ORPHAN_TTL_MS = readPositiveIntegerEnv(
  "TURNKEYAI_WORKER_SESSION_ORPHAN_TTL_MS",
  24 * 60 * 60 * 1_000,
);
const AGENT_TOOL_MAX_ROUNDS = readPositiveIntegerEnv(
  "TURNKEYAI_AGENT_TOOL_MAX_ROUNDS",
  DEFAULT_AGENT_TOOL_MAX_ROUNDS
);
export const LLM_SUB_AGENT_WORKER_KINDS = ["browser", "explore"] as const satisfies readonly WorkerKind[];
const STARTUP_TRACE_ENABLED = process.env.TURNKEYAI_STARTUP_TRACE === "1";

async function startupStep<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!STARTUP_TRACE_ENABLED) {
    return run();
  }
  const startedAt = Date.now();
  console.info(`daemon startup step started: ${name}`);
  try {
    const result = await run();
    console.info(`daemon startup step completed: ${name}`, { durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    console.error(`daemon startup step failed: ${name}`, {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const REQUEST_ENVELOPE_LIMIT_ENV_KEYS = {
  maxMessages: "TURNKEYAI_REQUEST_ENVELOPE_MAX_MESSAGES",
  maxPromptChars: "TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_CHARS",
  maxPromptBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_BYTES",
  maxMetadataBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_METADATA_BYTES",
  maxArtifactCount: "TURNKEYAI_REQUEST_ENVELOPE_MAX_ARTIFACT_COUNT",
  maxToolCount: "TURNKEYAI_REQUEST_ENVELOPE_MAX_TOOL_COUNT",
  maxToolSchemaBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_TOOL_SCHEMA_BYTES",
  maxToolResultCount: "TURNKEYAI_REQUEST_ENVELOPE_MAX_TOOL_RESULT_COUNT",
  maxToolResultBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_TOOL_RESULT_BYTES",
  maxInlineAttachmentBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_INLINE_ATTACHMENT_BYTES",
  maxInlineImageCount: "TURNKEYAI_REQUEST_ENVELOPE_MAX_INLINE_IMAGE_COUNT",
  maxInlineImageBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_INLINE_IMAGE_BYTES",
  maxInlinePdfCount: "TURNKEYAI_REQUEST_ENVELOPE_MAX_INLINE_PDF_COUNT",
  maxInlinePdfBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_INLINE_PDF_BYTES",
  maxMultimodalPartCount: "TURNKEYAI_REQUEST_ENVELOPE_MAX_MULTIMODAL_PART_COUNT",
  maxSerializedBytes: "TURNKEYAI_REQUEST_ENVELOPE_MAX_SERIALIZED_BYTES",
} satisfies Record<keyof RequestEnvelopeLimits, string>;

export function resolveRequestEnvelopeLimitOverridesFromEnv(
  env: Record<string, string | undefined> = process.env
): Partial<RequestEnvelopeLimits> | undefined {
  const overrides: Partial<RequestEnvelopeLimits> = {};
  for (const [key, envName] of Object.entries(REQUEST_ENVELOPE_LIMIT_ENV_KEYS) as Array<
    [keyof RequestEnvelopeLimits, string]
  >) {
    const raw = env[envName]?.trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      overrides[key] = parsed;
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export interface DaemonRuntimeLimits {
  memberMaxIterations: number;
  flowMaxHops: number;
  maxQueuedHandoffsPerRole: number;
  maxPerRoleHopCount: number;
}

export const DEFAULT_DAEMON_RUNTIME_LIMITS: DaemonRuntimeLimits = {
  memberMaxIterations: 128,
  flowMaxHops: 20,
  maxQueuedHandoffsPerRole: 4,
  maxPerRoleHopCount: 3,
};

export interface DaemonRuntimeServicesInputs {
  foundations: DaemonFoundations;
  dataDir: string;
  clock: Clock;
  idGenerator: IdGenerator;
  modelCatalogPath: string | null;
  runtimeLimits: DaemonRuntimeLimits;
  recoveryRunActionMutex: KeyedAsyncMutex<string>;
  recoveryRunStaleAfterMs: number;
  runtimeReconciliationIntervalMs: number;
  toolPermissionService?: ToolPermissionService;
  taskToolService?: TaskToolService;
}

export interface DaemonRuntimeServices {
  workerRuntime: WorkerRuntime;
  modelRegistry: ModelRegistry | null;
  llmGateway: LLMGateway | null;
  roleRuntime: PolicyRoleRuntime;
  roleRunCoordinator: DefaultRoleRunCoordinator;
  runtimeStateRecorder: DefaultRuntimeStateRecorder;
  runtimeChainRecorder: DefaultRuntimeChainRecorder;
  coordinationEngine: CoordinationEngine;
  roleLoopRunner: InlineRoleLoopRunner;
  recoveryActionService: ReturnType<typeof createRecoveryActionService>;
  scheduledTaskRuntime: DefaultScheduledTaskRuntime;
  runtimeQueryService: ReturnType<typeof createRuntimeQueryService>;
  toolCancellationRegistry: ToolCancellationRegistry;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  /**
   * Stop the background reconciliation timer. Idempotent — safe to call
   * multiple times. The timer is `.unref()`ed so it does not keep the
   * process alive on its own, but explicit cleanup is preferred during
   * shutdown so any in-flight refresh promise is allowed to settle without
   * a new pass being scheduled on top of it.
   */
  stop(): void;
}

export async function composeDaemonRuntimeServices(
  inputs: DaemonRuntimeServicesInputs
): Promise<DaemonRuntimeServices> {
  const {
    foundations,
    dataDir,
    clock,
    idGenerator,
    modelCatalogPath,
    runtimeLimits,
    recoveryRunActionMutex,
    recoveryRunStaleAfterMs,
    runtimeReconciliationIntervalMs,
  } = inputs;

  const {
    teamThreadStore,
    teamMessageStore,
    flowLedgerStore,
    roleRunStore,
    runtimeChainStore,
    runtimeChainSpanStore,
    runtimeChainEventStore,
    runtimeChainStatusStore,
    runtimeProgressStore,
    contextCheckpointStore,
    dynamicContextBaselineStore,
    threadMemoryStore,
    permissionCacheStore,
    recoveryRunStore,
    recoveryRunEventStore,
    workerSessionStore,
    teamEventBus,
    workerEvidenceDigestStore,
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
    replayRecorder,
    workerRegistry,
    capabilityDiscoveryService,
  } = foundations;

  // --- Worker runtime + startup reconciles -------------------------------
  const workerRuntime: WorkerRuntime = new LocalWorkerRuntime({
    workerRegistry,
    runtimeProgressRecorder,
    sessionStore: workerSessionStore,
  });
  const workerStartupReconcileResult = await startupStep("worker-runtime-reconcile", async () => workerRuntime.reconcileStartup?.());
  if (workerStartupReconcileResult && workerStartupReconcileResult.totalSessions > 0) {
    console.info("worker runtime startup reconcile completed", workerStartupReconcileResult);
  }
  const workerSessionHygieneResult = await startupStep("worker-session-hygiene", () =>
    sweepOrphanWorkerSessions({
      workerRuntime,
      runJournalStore: teamMessageStore,
      now: () => clock.now(),
      staleAfterMs: DEFAULT_WORKER_SESSION_ORPHAN_TTL_MS,
      onError: (error, workerRunKey) => {
        console.error("worker session hygiene cancellation failed", {
          workerRunKey,
          error,
        });
      },
    }),
  );
  if (workerSessionHygieneResult.cancelled > 0) {
    console.info("worker session hygiene completed", workerSessionHygieneResult);
  }
  const workerBindingReconcileResult = await startupStep("worker-binding-reconcile", async () =>
    reconcileWorkerBindingsOnStartup({
      teamThreadStore,
      roleRunStore,
      workerRuntime,
    })
  );
  if (workerBindingReconcileResult && workerBindingReconcileResult.totalBindings > 0) {
    console.info("worker binding startup reconcile completed", workerBindingReconcileResult);
  }

  // --- LLM gateway + role runtime ---------------------------------------
  const heuristicResponseGenerator = new DeterministicRoleResponseGenerator({
    modelAdapter: new HeuristicModelAdapter(),
    roleProfileRegistry,
  });
  const modelRegistry = modelCatalogPath
    ? new ModelRegistry(new FileModelCatalogSource(modelCatalogPath))
    : null;
  const requestEnvelopeLimits = resolveRequestEnvelopeLimitOverridesFromEnv();
  const llmGateway = modelRegistry
    ? new LLMGateway({
        registry: modelRegistry,
        clients: [new OpenAICompatibleClient(), new AnthropicCompatibleClient()],
        ...(requestEnvelopeLimits ? { requestEnvelopeLimits } : {}),
      })
    : null;
  const toolResultArtifactStore = new FileToolResultArtifactStore({
    rootDir: path.join(dataDir, "tool-result-artifacts"),
  });
  if (llmGateway) {
    installLLMSubAgentWorkerHandlers({
      foundations,
      llmGateway,
      runtimeProgressRecorder,
      clock,
      toolResultArtifactStore,
    });
  }
  const toolCapabilityRegistry = createNativeToolCapabilityRegistry({
    availableWorkerKinds: uniqueWorkerKinds(foundations.workerHandlers.map((handler) => handler.kind)),
    maxSessionToolTimeoutSeconds: DEFAULT_AGENT_TOOL_TIMEOUT_MS / 1_000,
    permissionsEnabled: Boolean(inputs.toolPermissionService),
    memoryEnabled: true,
    tasksEnabled: Boolean(inputs.taskToolService),
    webFetchEnabled: true,
    artifactsEnabled: true,
  });
  const toolCancellationRegistry = new InMemoryToolCancellationRegistry();

  const roleRuntime = new PolicyRoleRuntime({
    idGenerator,
    clock,
    promptPolicy: new DefaultRolePromptPolicy({
      roleProfileRegistry,
      contextBudgeter,
      roleMemoryResolver,
      promptAssembler,
      capabilityDiscoveryService,
      toolCapabilityRegistry,
      ...(modelRegistry ? { modelSelectionDescriber: modelRegistry } : {}),
    }),
    responseGenerator: llmGateway
      ? new HybridRoleResponseGenerator({
          primary: new LLMRoleResponseGenerator({
            gateway: llmGateway,
            runtimeProgressRecorder,
            nativeToolMessageStore: teamMessageStore,
            runJournalStore: teamMessageStore,
            contextCheckpointStore,
            dynamicContextBaselineStore,
            ...(inputs.taskToolService?.snapshot
              ? {
                  taskPlanStateProvider: ({ threadId, roleId }) =>
                    inputs.taskToolService!.snapshot!({
                      threadId,
                      roleId,
                      limit: 50,
                    }),
                }
              : {}),
            preCompactionMemoryFlusher:
              createWorkspaceAwarePreCompactionMemoryFlusher({
                primary: new DefaultPreCompactionMemoryFlusher({
                  gateway: llmGateway,
                  threadMemoryStore,
                  now: () => clock.now(),
                }),
                workspaceMemoryWriter:
                  foundations.workspaceMemoryWriter,
              }),
            toolResultArtifactStore,
            clock,
            deferToolObservability: true,
            toolLoop: {
              executor: createWorkerSessionToolExecutor({
                workerRuntime,
                maxSessionToolTimeoutMs: DEFAULT_AGENT_TOOL_TIMEOUT_MS,
                hardTimeoutGraceMs: DEFAULT_AGENT_TOOL_HARD_TIMEOUT_GRACE_MS,
                sessionConcurrency: {
                  maxPerParentConcurrent: DEFAULT_AGENT_TOOL_MAX_PARENT_SESSIONS,
                  maxGlobalActive: DEFAULT_AGENT_TOOL_MAX_GLOBAL_SESSIONS,
                },
                toolCapabilityRegistry,
                toolCancellationRegistry,
                toolResultArtifactStore,
                memoryResolver: roleMemoryResolver,
                ...(inputs.toolPermissionService ? { toolPermissionService: inputs.toolPermissionService } : {}),
                ...(inputs.taskToolService ? { taskToolService: inputs.taskToolService } : {}),
              }),
              maxRounds: AGENT_TOOL_MAX_ROUNDS,
              maxWallClockMs: DEFAULT_AGENT_TOOL_WALL_CLOCK_MS,
              maxParallelToolCalls: DEFAULT_AGENT_TOOL_MAX_PARALLEL_CALLS,
              maxToolCallsPerRound: DEFAULT_AGENT_TOOL_MAX_CALLS_PER_ROUND,
              runtimeProgressRecorder,
            },
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

  // --- Coordination + cyclic role loop runner ----------------------------
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

  // The CoordinationEngine ↔ InlineRoleLoopRunner pair is cyclic: the role
  // loop needs to call back into coordination on ack/reply/failure, and
  // coordination needs to drive the role loop. Both reference each other via
  // closures bound at construction time, so coordinationEngine is declared
  // with a deferred binding (the closures capture the variable, not its
  // value at the moment of construction).
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
    replayRecorder,
    runtimeChainRecorder,
    runtimeProgressRecorder,
    teamEventBus,
    ingressOutboxRootDir: path.join(dataDir, "flow-start-outbox"),
    dispatchOutboxRootDir: path.join(dataDir, "dispatch-outbox"),
    roleOutcomeOutboxRootDir: path.join(dataDir, "role-outcome-outbox"),
  });

  // --- Startup recovery + recovery action service -----------------------
  const roleRunStartupRecoveryResult = await startupStep("role-run-startup-recovery", async () =>
    recoverRoleRunsOnStartup({
      teamThreadStore,
      flowLedgerStore,
      roleRunStore,
      roleLoopRunner,
    })
  );

  // Mutable reconciliation state lives in this closure scope. The getters
  // below are passed to recoveryActionService and runtimeQueryService and
  // always observe the latest result without those services needing to know
  // anything about the refresh cycle.
  let runtimeReconciliationPassResult: RuntimeReconciliationPassResult | undefined;
  let flowRecoveryStartupReconcileResult: RuntimeSummaryReport["flowRecoveryStartupReconcile"] | undefined;
  let runtimeChainStartupReconcileResult: RuntimeSummaryReport["runtimeChainStartupReconcile"] | undefined;
  let runtimeChainArtifactStartupReconcileResult: RuntimeSummaryReport["runtimeChainArtifactStartupReconcile"] | undefined;
  let runtimeReconciliationPassInFlight = false;

  const recoveryActionService = createRecoveryActionService({
    clock,
    idGenerator,
    recoveryRunActionMutex,
    recoveryRunStaleAfterMs,
    coordinationEngine,
    runtimeStateRecorder,
    runtimeProgressRecorder,
    replayRecorder,
    recoveryRunStore,
    recoveryRunEventStore,
    getRuntimeReconciliationResult: () => runtimeReconciliationPassResult,
  });

  async function refreshRuntimeReconciliationPass(): Promise<void> {
    if (runtimeReconciliationPassInFlight) {
      return;
    }
    runtimeReconciliationPassInFlight = true;
    try {
      runtimeReconciliationPassResult = await runRuntimeReconciliationPass({
        clock,
        teamThreadStore,
        flowLedgerStore,
        recoveryRunStore,
        runtimeChainStore,
        runtimeChainStatusStore,
        runtimeChainSpanStore,
        runtimeChainEventStore,
        syncRecoveryRuntime: (threadId) => recoveryActionService.syncRecoveryRuntime(threadId),
        recoveryRunStaleAfterMs,
        flowStartOutboxRootDir: path.join(dataDir, "flow-start-outbox"),
        dispatchOutboxRootDir: path.join(dataDir, "dispatch-outbox"),
        roleOutcomeOutboxRootDir: path.join(dataDir, "role-outcome-outbox"),
      });
      flowRecoveryStartupReconcileResult = runtimeReconciliationPassResult.flowRecovery;
      runtimeChainStartupReconcileResult = runtimeReconciliationPassResult.runtimeChains;
      runtimeChainArtifactStartupReconcileResult = runtimeReconciliationPassResult.runtimeChainArtifacts;
    } finally {
      runtimeReconciliationPassInFlight = false;
    }
  }

  await startupStep("runtime-reconciliation-pass", refreshRuntimeReconciliationPass);
  if (
    roleRunStartupRecoveryResult.restartedQueuedRuns > 0 ||
    roleRunStartupRecoveryResult.restartedRunningRuns > 0 ||
    roleRunStartupRecoveryResult.restartedResumingRuns > 0
  ) {
    console.info("role run startup recovery completed", roleRunStartupRecoveryResult);
  }
  if (
    flowRecoveryStartupReconcileResult &&
    (flowRecoveryStartupReconcileResult.orphanedFlows > 0 ||
      flowRecoveryStartupReconcileResult.orphanedRecoveryRuns > 0 ||
      flowRecoveryStartupReconcileResult.failedRecoveryRuns > 0)
  ) {
    console.info("flow/recovery startup reconcile completed", flowRecoveryStartupReconcileResult);
  }
  if (runtimeChainStartupReconcileResult && runtimeChainStartupReconcileResult.affectedChainIds.length > 0) {
    console.info("runtime chain startup reconcile completed", runtimeChainStartupReconcileResult);
  }
  if (
    runtimeChainArtifactStartupReconcileResult &&
    runtimeChainArtifactStartupReconcileResult.affectedChainIds.length > 0
  ) {
    console.info(
      "runtime chain artifact startup reconcile completed",
      runtimeChainArtifactStartupReconcileResult
    );
  }

  // Background reconciliation. `.unref()` lets the process exit if this timer
  // is the only thing keeping the event loop alive, so daemon.ts does not
  // need to keep a reference for shutdown.
  const runtimeReconciliationTimer = setInterval(() => {
    void refreshRuntimeReconciliationPass().catch((error) => {
      console.error(
        "runtime reconciliation pass failed",
        error instanceof Error ? error.message : error
      );
    });
  }, runtimeReconciliationIntervalMs);
  runtimeReconciliationTimer.unref?.();

  // --- Scheduled task runtime + query service ---------------------------
  const scheduledTaskRuntime = new DefaultScheduledTaskRuntime({
    scheduledTaskStore: foundations.scheduledTaskStore,
    coordinationEngine,
    clock,
    idGenerator,
    replayRecorder,
  });
  const runtimeQueryService = createRuntimeQueryService({
    clock,
    workerRuntime,
    getWorkerStartupReconcileResult: () => workerStartupReconcileResult,
    getWorkerBindingReconcileResult: () => workerBindingReconcileResult,
    getRoleRunStartupRecoveryResult: () => roleRunStartupRecoveryResult,
    getFlowRecoveryStartupReconcileResult: () => flowRecoveryStartupReconcileResult,
    getRuntimeChainStartupReconcileResult: () => runtimeChainStartupReconcileResult,
    getRuntimeChainArtifactStartupReconcileResult: () => runtimeChainArtifactStartupReconcileResult,
    getRuntimeReconciliationResult: () => runtimeReconciliationPassResult,
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
    loadRecoveryRuntime: (threadId) => recoveryActionService.loadRecoveryRuntime(threadId),
  });

  let stopped = false;
  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(runtimeReconciliationTimer);
  }

  return {
    workerRuntime,
    modelRegistry,
    llmGateway,
    roleRuntime,
    roleRunCoordinator,
    runtimeStateRecorder,
    runtimeChainRecorder,
    coordinationEngine,
    roleLoopRunner,
    recoveryActionService,
    scheduledTaskRuntime,
    runtimeQueryService,
    toolCancellationRegistry,
    toolCapabilityRegistry,
    stop,
  };
}

function installLLMSubAgentWorkerHandlers(input: {
  foundations: DaemonFoundations;
  llmGateway: LLMGateway;
  runtimeProgressRecorder: DaemonFoundations["runtimeProgressRecorder"];
  clock: Clock;
  toolResultArtifactStore: FileToolResultArtifactStore;
}): void {
  for (const kind of LLM_SUB_AGENT_WORKER_KINDS) {
    if (
      input.foundations.workerHandlers.some(
        (handler) => handler instanceof LLMSubAgentWorkerHandler && handler.kind === kind
      )
    ) {
      continue;
    }
    const innerHandler = input.foundations.workerHandlers.find((handler) => handler.kind === kind);
    if (!innerHandler) {
      continue;
    }
    input.foundations.workerHandlers.unshift(
      new LLMSubAgentWorkerHandler({
        kind,
        innerHandler,
        gateway: input.llmGateway,
        ...(kind === "browser" ? { browserBridge: input.foundations.browserBridge } : {}),
        runtimeProgressRecorder: input.runtimeProgressRecorder,
        toolResultArtifactStore: input.toolResultArtifactStore,
        clock: input.clock,
      })
    );
  }
}

function uniqueWorkerKinds(kinds: WorkerKind[]): WorkerKind[] {
  return [...new Set(kinds)];
}

function createWorkspaceAwarePreCompactionMemoryFlusher(input: {
  primary: PreCompactionMemoryFlusher;
  workspaceMemoryWriter: DaemonFoundations["workspaceMemoryWriter"];
}): PreCompactionMemoryFlusher {
  return {
    async flush(flushInput) {
      try {
        await input.workspaceMemoryWriter.enqueue({
          workspaceId: flushInput.activation.thread.threadId,
          trigger: "pre-compaction",
          force: true,
        });
        await input.workspaceMemoryWriter.flush();
      } catch (error) {
        console.error("workspace memory pre-compaction trigger failed", {
          threadId: flushInput.activation.thread.threadId,
          error,
        });
      }
      return input.primary.flush(flushInput);
    },
  };
}

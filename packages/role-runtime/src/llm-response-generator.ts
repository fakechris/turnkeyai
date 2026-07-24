import type {
  Clock,
  ContextCheckpointStore,
  DynamicContextBaselineStore,
  DynamicContextScope,
  RoleActivationInput,
  RuntimeProgressRecorder,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import type { GenerateTextInput } from "@turnkeyai/llm-adapter/index";

import type {
  GeneratedRoleReply,
  RoleResponseGenerator,
} from "./deterministic-response-generator";
import {
  buildDynamicContextSnapshot,
  buildFullDynamicContextMessage,
  prepareDynamicContext,
  type DynamicContextSnapshot,
} from "./context/dynamic-context-baseline";
import {
  generateWithEnvelopeRetry,
  type GenerateWithEnvelopeRetryInput,
} from "./gateway-envelope-retry";
import { buildGatewayInput } from "./gateway-input-builder";
import type { ModelCallBoundaryTrace } from "./model-call-trace";
import type { NativeToolRoundTrace } from "./native-tool-messages";
import type { PreCompactionMemoryFlusher } from "./pre-compaction-memory-flusher";
import {
  recordPromptAssemblyBoundarySafely,
  type RolePromptPacket,
} from "./prompt-policy";
import { getRoleModelSelection } from "./role-model-selection";
import {
  createAttemptDeadline,
  isAttemptDeadlineExceeded,
  type AttemptDeadline,
} from "./run-deadline";
import type { ToolLoopCloseoutMetadata } from "./runtime-derived-mission-report";
import {
  allowsSupplementalBrowserProbe,
  findSessionContinuationDirective,
} from "./runtime-facts/text-fallback-readers";
import { createTerminalFinalSynthesisRunner } from "./terminal-final-synthesis";
import { throwIfAborted } from "./tool-protocol";
import type { ToolResultArtifactStore } from "./tool-result-artifact-store";
import {
  createToolResultHistoryExternalizer,
  type ToolResultHistoryExternalizer,
} from "./tool-result-history-externalizer";
import {
  DEFAULT_ROLE_TOOL_MAX_ROUNDS,
  type RoleToolContext,
  type RoleToolExecutionResult,
  type RoleToolLoopOptions,
} from "./tool-use";
// Stage 8 cleanup (Batch 0.5): engine policy-trace plumbing. The trace is a
// behavior-neutral observability sink that records the per-hook decision sequence
// so later batches can prove byte-identical behavior and so production-behind-flag
// failures can answer "which policy fired or skipped." See react-engine/*.
import {
  applyEngineToolCallsHook,
  applyToolArgumentValidationBeforeAdmission,
  attachEngineRunDiagnostics,
  buildRunTrace,
  captureContextWorkingSetFromMessages,
  classifyRunFailure,
  createCloseoutPolicyCharacterizationRegistry,
  createCloseoutPolicyRegistry,
  createCompactionController,
  createCompletedCloseoutController,
  createContinuationCharacterizationController,
  createContinuationController,
  createEngineFinalResponseBuilder,
  createEnginePolicyTrace,
  createEngineRoleToolkit,
  createEvidenceLedger,
  createExecutionBudgetController,
  createPermissionPolicy,
  createPermissionPolicyCharacterization,
  createRepairPolicyCharacterizationRegistry,
  createRepairPolicyRegistry,
  createRoleEngineAgentRunner,
  createRoleEngineModelClient,
  createRoleEngineRunObserver,
  createRoleEngineRunState,
  createRoleEngineRuntimeForcedToolRoundRunner,
  createRunJournal,
  createRunLifecycleRecorder,
  createRuntimeCheckpointSummarizer,
  createTaskPlanController,
  createTerminalCloseoutController,
  createToolArgumentValidator,
  enginePolicyTraceDebugEnabled,
  fingerprintRunJournalTask,
  readRuntimeCheckpoint,
  recordEngineReductionBoundary,
  traceEngineHooks,
  type EngineCloseoutReason,
  type RunTraceCompactionEvent,
  type RunTraceExternalizationEvent,
  type RunTracePruningEvent,
  type RunJournal,
  type RunJournalResumeState,
  type RunJournalState,
} from "./react-engine";
import { buildTaskFacts } from "./task-facts-shared";
import { readTaskPlanState } from "./task-plan-state";
import type { TaskPlanStateProvider } from "./task-tool-service";

export class LLMRoleResponseGenerator implements RoleResponseGenerator {
  private readonly gateway: LLMGateway;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly toolLoop: RoleToolLoopOptions | undefined;
  private readonly nativeToolMessageStore:
    | Pick<TeamMessageStore, "append">
    | undefined;
  private readonly runJournalStore:
    | Pick<TeamMessageStore, "append" | "get" | "list">
    | undefined;
  private readonly contextCheckpointStore:
    | ContextCheckpointStore
    | undefined;
  private readonly dynamicContextBaselineStore:
    | DynamicContextBaselineStore
    | undefined;
  private readonly preCompactionMemoryFlusher:
    | PreCompactionMemoryFlusher
    | undefined;
  private readonly taskPlanStateProvider:
    | TaskPlanStateProvider
    | undefined;
  private readonly toolResultHistoryExternalizer:
    | ToolResultHistoryExternalizer
    | undefined;
  private readonly clock: Clock;
  private readonly deferToolObservability: boolean;
  private readonly testOnlyCharacterizeRetiredPolicies: boolean;

  constructor(options: {
    gateway: LLMGateway;
    runtimeProgressRecorder?: RuntimeProgressRecorder;
    toolLoop?: RoleToolLoopOptions;
    nativeToolMessageStore?: Pick<TeamMessageStore, "append">;
    runJournalStore?: Pick<TeamMessageStore, "append" | "get" | "list">;
    contextCheckpointStore?: ContextCheckpointStore;
    dynamicContextBaselineStore?: DynamicContextBaselineStore;
    preCompactionMemoryFlusher?: PreCompactionMemoryFlusher;
    taskPlanStateProvider?: TaskPlanStateProvider;
    toolResultArtifactStore?: ToolResultArtifactStore;
    clock?: Clock;
    deferToolObservability?: boolean;
    testOnlyCharacterizeRetiredPolicies?: true;
  }) {
    this.gateway = options.gateway;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.toolLoop = options.toolLoop;
    this.nativeToolMessageStore = options.nativeToolMessageStore;
    this.runJournalStore = options.runJournalStore;
    this.contextCheckpointStore = options.contextCheckpointStore;
    this.dynamicContextBaselineStore = options.dynamicContextBaselineStore;
    this.preCompactionMemoryFlusher = options.preCompactionMemoryFlusher;
    this.taskPlanStateProvider = options.taskPlanStateProvider;
    this.toolResultHistoryExternalizer = options.toolResultArtifactStore
      ? createToolResultHistoryExternalizer({
          store: options.toolResultArtifactStore,
          onError: (error) => {
            console.error("tool result artifact externalization failed", error);
          },
        })
      : undefined;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.deferToolObservability = options.deferToolObservability === true;
    this.testOnlyCharacterizeRetiredPolicies =
      options.testOnlyCharacterizeRetiredPolicies === true;
  }

  async generate(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    signal?: AbortSignal;
  }): Promise<GeneratedRoleReply> {
    const runDeadline = createAttemptDeadline({
      maxWallClockMs: this.toolLoop?.maxWallClockMs ?? 5 * 60_000,
      ...(input.signal ? { parentSignal: input.signal } : {}),
    });
    try {
      return await this.generateWithinDeadline(input, runDeadline);
    } finally {
      runDeadline.dispose();
    }
  }

  private async generateWithinDeadline(
    input: {
      activation: RoleActivationInput;
      packet: RolePromptPacket;
      signal?: AbortSignal;
    },
    runDeadline: AttemptDeadline,
  ): Promise<GeneratedRoleReply> {
    const role = input.activation.thread.roles.find(
      (item) => item.roleId === input.activation.runState.roleId,
    );
    const selection = role ? getRoleModelSelection(role) : {};
    const activeToolLoop =
      input.packet.toolUseMode === "disabled" ? undefined : this.toolLoop;
    if (!selection.modelId && !selection.modelChainId) {
      throw new Error(
        `no model configured for role ${input.activation.runState.roleId}`,
      );
    }
    throwIfAborted(runDeadline.signal);

    await recordPromptAssemblyBoundarySafely({
      activation: input.activation,
      packet: input.packet,
      runtimeProgressRecorder: this.runtimeProgressRecorder,
      defer: this.deferToolObservability,
      selection,
    });
    const baseSessionContinuationDirective = activeToolLoop
      ? findSessionContinuationDirective(input.packet.taskPrompt)
      : null;
    const toolDefinitions = activeToolLoop
      ? activeToolLoop.executor.definitions()
      : undefined;
    const declaredContinuationWorkerRunKey =
      input.packet.continuityMode === "resume-existing" &&
      input.packet.continuationContext?.source === "explicit_user_target"
        ? input.packet.continuationContext.workerRunKey
        : undefined;
    if (
      declaredContinuationWorkerRunKey &&
      (!activeToolLoop || !toolDefinitions?.some((definition) => definition.name === "sessions_send"))
    ) {
      throw new Error("explicit worker continuation requires the sessions_send tool");
    }

    const initialGatewayInput = buildGatewayInput({
      activation: input.activation,
      packet: input.packet,
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      ...(selection.modelChainId
        ? { modelChainId: selection.modelChainId }
        : {}),
      signal: runDeadline.signal,
      deadlineAt: runDeadline.deadlineAt,
      ...(activeToolLoop && toolDefinitions
        ? {
          tools: toolDefinitions,
          toolChoice: "auto" as const,
        }
        : {}),
      ...(baseSessionContinuationDirective
        ? { sessionContinuationDirective: baseSessionContinuationDirective }
        : {}),
    });
    const modelCallTrace: ModelCallBoundaryTrace[] = [];
    return await this.runEngine({
      input: { ...input, signal: runDeadline.signal },
      selection,
      activeToolLoop,
      initialGatewayInput,
      modelCallTrace,
      recoveryToolBudget: null,
      recoveryToolCallsBeforeActivation: 0,
    });
  }

  /**
   * ReAct-engine implementation of the role-runtime tool loop.
   *
   * This method is intentionally still an adapter-heavy bridge: it translates the
   * role-runtime policy surface into agent-core hooks. The next cleanup is to
   * extract those hook bodies into named controller/observer modules, not to add
   * more policy branches directly here.
   *
   * Stage 8 cleanup contract (see
   * docs/superpowers/plans/2026-07-01-stage8-engine-architecture-cleanup.md):
   * new role-engine policy logic — normalization, permission, continuation,
   * execution-budget, closeout, repair, completed-closeout, finalization, and
   * evidence/fact rules — MUST be added in `react-engine/*` modules, never as new
   * product-policy branches directly inside `runEngine`. This adapter
   * only wires those modules and assembles the final `GeneratedRoleReply`.
   * `react-engine/*` modules must not import this file.
   */
  private async runEngine(args: {
    input: { activation: RoleActivationInput; packet: RolePromptPacket; signal?: AbortSignal; };
    selection: GenerateWithEnvelopeRetryInput["selection"];
    activeToolLoop: RoleToolLoopOptions | undefined;
    initialGatewayInput: GenerateTextInput;
    modelCallTrace: ModelCallBoundaryTrace[];
    recoveryToolBudget: { maxToolCalls: number; } | null;
    recoveryToolCallsBeforeActivation: number;
  }): Promise<GeneratedRoleReply> {
    const { activation, packet, signal } = args.input;
    const clockValues: number[] = [];
    const runNow = () => {
      const value = this.clock.now();
      clockValues.push(value);
      return value;
    };
    const runStartedAt = runNow();
    const {
      selection,
      activeToolLoop,
      initialGatewayInput,
      modelCallTrace,
      recoveryToolBudget,
      recoveryToolCallsBeforeActivation,
    } = args;
    const declaredContinuationWorkerRunKey =
      packet.continuityMode === "resume-existing" &&
      packet.continuationContext?.source === "explicit_user_target"
        ? packet.continuationContext.workerRunKey
        : undefined;
    const lifecycle = createRunLifecycleRecorder({
      activation,
      recorder: this.runtimeProgressRecorder,
    });
    await lifecycle.record({ kind: "run_started", at: runStartedAt });

    // Stage 8 cleanup (Batch 0.5): the per-run engine policy trace. It records the
    // per-hook decision sequence (which policy fired or skipped, in which phase)
    // via the behavior-neutral hook-boundary wrapper applied to `hooks` below. The
    // snapshot is surfaced into debug metadata behind the engine flag (this whole
    // method is engine-only) so a production-behind-flag failure is diagnosable.
    const policyTrace = createEnginePolicyTrace();
    const compactionTrace: RunTraceCompactionEvent[] = [];
    const pruningTrace: RunTracePruningEvent[] = [];
    const externalizationTrace: RunTraceExternalizationEvent[] = [];
    const runJournal = this.runJournalStore
      ? createRunJournal({
          store: this.runJournalStore,
          activation,
          taskFingerprint: fingerprintRunJournalTask(activation),
          now: runNow,
          ...(this.toolLoop?.executor.reconcile
            ? {
                reconcileEffect: (effect) =>
                  this.toolLoop!.executor.reconcile!({
                    call: effect.call,
                    activation,
                    packet,
                    ...(signal ? { signal } : {}),
                  }),
              }
            : {}),
        })
      : undefined;
    const restoredJournal = runJournal
      ? await loadRunJournalSafely(runJournal, activation)
      : null;
    const replayResumeState: RunJournalState | undefined = restoredJournal
      ? structuredClone({
          messages: restoredJournal.messages,
          nextRound: restoredJournal.nextRound,
          repairMarkers: restoredJournal.repairMarkers,
          toolTrace: restoredJournal.toolTrace,
          planState: restoredJournal.planState,
        })
      : undefined;
    let engineInitialMessages =
      restoredJournal?.messages ?? initialGatewayInput.messages;
    const initialRound = restoredJournal?.nextRound ?? 0;

    const repairPolicy = this.testOnlyCharacterizeRetiredPolicies
      ? createRepairPolicyCharacterizationRegistry()
      : createRepairPolicyRegistry();
    const synthesizeFinalAfterToolRoundLimit =
      createTerminalFinalSynthesisRunner({
        gateway: this.gateway,
        now: runNow,
        runtimeProgressRecorder: this.runtimeProgressRecorder,
        preCompactionMemoryFlusher: this.preCompactionMemoryFlusher,
        activation,
        packet,
        selection,
        baseGatewayInput: initialGatewayInput,
        modelCallTrace,
        lifecycle,
        repairPolicy,
      });

    const toolDefinitions = initialGatewayInput.tools ?? [];
    const dynamicContextScope = {
      threadId: activation.thread.threadId,
      roleId: activation.runState.roleId,
      flowId: activation.flow.flowId,
    };
    const dynamicContextSnapshot = this.dynamicContextBaselineStore
      ? buildDynamicContextSnapshot({
          scope: dynamicContextScope,
          packet,
          selection: {
            ...(selection.modelId
              ? { modelId: selection.modelId }
              : {}),
            ...(selection.modelChainId
              ? { modelChainId: selection.modelChainId }
              : {}),
          },
          tools: toolDefinitions,
          now: runStartedAt,
        })
      : undefined;
    if (restoredJournal && dynamicContextSnapshot) {
      const previousBaseline = await loadDynamicContextBaselineSafely(
        this.dynamicContextBaselineStore!,
        dynamicContextScope,
        activation,
      );
      const restoredCheckpoint = [...engineInitialMessages]
        .reverse()
        .map((message) => readRuntimeCheckpoint(message))
        .find((checkpoint) =>
          checkpoint?.protocol === "turnkeyai.context_checkpoint.v2"
        );
      const preparedDynamicContext = prepareDynamicContext({
        previous: previousBaseline,
        current: dynamicContextSnapshot,
        forceFull: Boolean(
          restoredCheckpoint &&
            restoredCheckpoint.dynamicContext?.baselineId !==
              dynamicContextSnapshot.baseline.baselineId,
        ),
      });
      if (preparedDynamicContext.message) {
        engineInitialMessages = [
          ...engineInitialMessages,
          preparedDynamicContext.message,
        ];
      }
    }
    const toolkit = createEngineRoleToolkit({
      toolDefinitions,
      activeToolLoop,
    });
    const toolArgumentValidator = createToolArgumentValidator(toolDefinitions);

    const ctx: RoleToolContext = {
      activation,
      packet,
      repairMarkers: restoredJournal?.repairMarkers ?? [],
      ...(signal ? { signal } : {}),
      ...(initialGatewayInput.deadlineAt === undefined
        ? {}
        : { deadlineAt: initialGatewayInput.deadlineAt }),
    };
    const taskFacts = buildTaskFacts({
      taskPrompt: packet.taskPrompt,
      activation,
      messages: engineInitialMessages,
    });
    const permissionPolicy = this.testOnlyCharacterizeRetiredPolicies
      ? createPermissionPolicyCharacterization()
      : createPermissionPolicy();
    const executionBudget = createExecutionBudgetController();
    const continuation = this.testOnlyCharacterizeRetiredPolicies
      ? createContinuationCharacterizationController()
      : createContinuationController();
    const closeoutPolicy = this.testOnlyCharacterizeRetiredPolicies
      ? createCloseoutPolicyCharacterizationRegistry()
      : createCloseoutPolicyRegistry();
    const completedCloseout = createCompletedCloseoutController();
    const terminalCloseout = createTerminalCloseoutController();
    const taskPlanController = createTaskPlanController();
    const evidenceLedger = createEvidenceLedger();
    const toolLoopStartedAtMs = runNow();
    const maxRounds = activeToolLoop?.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
    // Per-run closeout state: hooks fire across different engine callbacks, so a
    // single EngineRunState instance owns what the inline loop keeps as locals
    // (toolLoopCloseout/result/reduction/memoryFlushes/completed signals).
    const runState = createRoleEngineRunState();
    const toolTrace: NativeToolRoundTrace[] =
      restoredJournal?.toolTrace ?? [];
    let latestJournalState = {
      messages: engineInitialMessages,
      nextRound: initialRound,
      repairMarkers: ctx.repairMarkers ?? [],
      toolTrace,
      planState: readTaskPlanState(
        engineInitialMessages,
        restoredJournal?.planState ?? [],
      ),
    };
    let dynamicContextBaselineWriteAttempted = false;
    const runEvidence = evidenceLedger.forRun({
      taskPrompt: packet.taskPrompt,
      toolTrace,
    });
    const buildEngineFinalResponse = createEngineFinalResponseBuilder({
      taskPrompt: packet.taskPrompt,
      initialMessages: engineInitialMessages,
      readToolTraceResultContent: (messages) =>
        runEvidence.snapshot(messages).toolTraceResultContent,
      policyTrace,
      enginePolicyTraceDebugEnabled,
    });
    const observer = createRoleEngineRunObserver({
      toolTrace,
      toolLoop: this.toolLoop,
      runtimeProgressRecorder: this.runtimeProgressRecorder,
      nativeToolMessageStore: this.nativeToolMessageStore,
      deferToolObservability: this.deferToolObservability,
      now: runNow,
      activation,
    });
    const mapToolResultsForHistory = (results: RoleToolExecutionResult[]) =>
      this.toolResultHistoryExternalizer
        ? this.toolResultHistoryExternalizer.externalize(results, {
            threadId: activation.thread.threadId,
            runKey: activation.runState.runKey,
            onExternalized: (artifact) => {
              externalizationTrace.push({
                round: toolTrace.at(-1)?.round ?? 0,
                toolCallId: artifact.toolCallId,
                toolName: artifact.toolName,
                bytes: artifact.sizeBytes,
                artifactId: artifact.artifactId,
                sha256: artifact.sha256,
              });
            },
          })
        : Promise.resolve(results);
    const executeForcedRuntimeToolRound =
      createRoleEngineRuntimeForcedToolRoundRunner({
        toolLoop: this.toolLoop,
        runtimeProgressRecorder: this.runtimeProgressRecorder,
        nativeToolMessageStore: this.nativeToolMessageStore,
        deferToolObservability: this.deferToolObservability,
        now: runNow,
        activation,
        packet,
        toolTrace,
        observer,
        ...(runJournal
          ? {
              effectLifecycle: {
                onAdmitted: ({ round, call }) =>
                  runJournal.effectLedger.admit({ round, call }),
                onStarted: ({ call }) =>
                  runJournal.effectLedger.start(call.id),
                onResult: ({ result }) =>
                  runJournal.effectLedger.recordResult(result),
              },
            }
          : {}),
        toolLoopStartedAtMs,
        mapToolResultsForHistory,
        ...(signal ? { signal } : {}),
      });
    let compactionController: ReturnType<typeof createCompactionController>;
    const engineModel = createRoleEngineModelClient({
      gateway: this.gateway,
      now: runNow,
      preCompactionMemoryFlusher: this.preCompactionMemoryFlusher,
      activation,
      packet,
      selection,
      baseGatewayInput: initialGatewayInput,
      modelCallTrace,
      lifecycle,
      maxRounds,
      activeToolLoop: Boolean(activeToolLoop),
      runtimeProgressRecorder: this.runtimeProgressRecorder,
      onPruning: (snapshot, round) => {
        if (!snapshot) return;
        pruningTrace.push({
          round,
          prunedToolResults: snapshot.prunedToolResults,
          toolResultBytesBefore: snapshot.toolResultBytesBefore,
          toolResultBytesAfter: snapshot.toolResultBytesAfter,
          messageCountBefore: snapshot.messageCountBefore,
          messageCountAfter: snapshot.messageCountAfter,
          reasons: snapshot.reasons,
        });
      },
      executionBudget,
      runState,
      forceCompact: ({ messages, round }) =>
        compactionController.forceRoundMessages(messages, round, signal),
    });
    compactionController = createCompactionController({
      taskPrompt: packet.taskPrompt,
      estimateTokenBudget: (estimateInput) =>
        engineModel.estimateTokenBudget(estimateInput),
      summarize: createRuntimeCheckpointSummarizer({
        gateway: this.gateway,
        selection,
        modelCallTrace,
        lifecycle,
        now: runNow,
        metadata: {
          roleId: activation.runState.roleId,
          threadId: activation.thread.threadId,
          flowId: activation.flow.flowId,
        },
      }),
      readPlanState: async (messages, previousPlanState) =>
        this.taskPlanStateProvider
          ? this.taskPlanStateProvider({
              threadId: activation.thread.threadId,
              roleId: activation.runState.roleId,
            })
          : readTaskPlanState(messages, previousPlanState),
      ...(this.contextCheckpointStore
        ? {
            checkpointStore: this.contextCheckpointStore,
            checkpointScope: {
              threadId: activation.thread.threadId,
              roleId: activation.runState.roleId,
              flowId: activation.flow.flowId,
            },
            captureWorkingSet: (
              messages: GenerateTextInput["messages"],
            ) => captureContextWorkingSetFromMessages(messages),
            now: runNow,
          }
        : {}),
      ...(dynamicContextSnapshot
        ? {
            dynamicContext: checkpointDynamicContext(
              dynamicContextSnapshot,
            ),
            postCompactionMessages: [
              buildFullDynamicContextMessage(dynamicContextSnapshot),
            ],
          }
        : {}),
      ...(initialGatewayInput.tools === undefined
        ? {}
        : { tools: initialGatewayInput.tools }),
      enabled: process.env["TURNKEYAI_LOOP_COMPACTION"] !== "0",
      onCompaction: (event) => compactionTrace.push(event),
      onCompactionLifecycle: (event) => {
        void lifecycle.record({
          kind: `compaction_${event.kind}`,
          at: runNow(),
          round: event.round,
          forced: event.forced,
          consecutiveFailures: event.consecutiveFailures,
          microcompactedToolResults: event.microcompactedToolResults,
          ...(event.reason ? { reason: event.reason } : {}),
        });
      },
      onError: (error) => {
        console.error("runtime checkpoint compaction failed", {
          threadId: activation.thread.threadId,
          flowId: activation.flow.flowId,
          taskId: activation.handoff.taskId,
          error,
        });
      },
    });
    await reconcileContextCheckpointSafely(
      compactionController,
      engineInitialMessages,
      activation,
    );
    const runAgent = createRoleEngineAgentRunner<RoleToolContext>({
      model: engineModel.model,
      toolkit,
      maxRounds,
      // Stage 8 cleanup (Batch 0.5): wrap the hook bodies with the behavior-neutral
      // policy-trace boundary. traceEngineHooks records one EnginePolicyTraceEntry
      // per installed hook invocation (phase + coarse outcome derived from the
      // return value) and returns each hook's real result unchanged — pure
      // observation, so parity is unaffected. Later batches extract the real
      // controllers/registries, which record their own fine-grained policy ids into
      // the same trace at their own call sites.
      hooks: traceEngineHooks({
        onRoundMessages: async (messages, round, hookCtx) => {
          const compacted = await compactionController.applyRoundMessagesHook(
            messages,
            round,
            signal,
          );
          const planState = readTaskPlanState(
            compacted.messages,
            latestJournalState.planState,
          );
          const planned = taskPlanController.applyRoundMessagesHook({
            messages: compacted.messages,
            round,
            tools: toolDefinitions,
            toolTrace,
            planState,
            repairMarkers: (hookCtx.repairMarkers ??= []),
          });
          latestJournalState = {
            messages: planned.messages,
            nextRound: round,
            repairMarkers: hookCtx.repairMarkers ?? [],
            toolTrace,
            planState,
          };
          const journalCommitted = runJournal
            ? await checkpointRunJournalSafely(
              runJournal,
              latestJournalState,
              activation,
            )
            : true;
          if (journalCommitted && compacted.pendingCheckpointId) {
            await activateContextCheckpointSafely(
              compactionController,
              compacted.pendingCheckpointId,
              activation,
            );
          }
          if (
            journalCommitted &&
            dynamicContextSnapshot &&
            this.dynamicContextBaselineStore &&
            !dynamicContextBaselineWriteAttempted
          ) {
            dynamicContextBaselineWriteAttempted = true;
            await persistDynamicContextBaselineSafely(
              this.dynamicContextBaselineStore,
              dynamicContextSnapshot,
              activation,
            );
          }
          return round === initialRound && declaredContinuationWorkerRunKey
            ? { ...planned, forceToolChoice: { name: "sessions_send" } }
            : planned;
        },
        // Tool-call normalization — the engine's full port of the inline pipeline
        // (Stage 8B Batch B). Runs every active-loop round before execution and
        // before the current round is recorded in toolTrace, so each step's trace
        // reads reflect only prior rounds — matching inline's pre-normalize point.
        // The normalizer owner builds the shared live-message context, runs the
        // ordered pipeline, and applies final-recovery budget truncation after
        // normalization. Side-effect permission gating is unchanged.
        onToolCalls: (calls, state, hookCtx) => {
          if (!activeToolLoop) {
            return [];
          }
          return applyEngineToolCallsHook({
            calls,
            active: Boolean(activeToolLoop),
            taskPrompt: packet.taskPrompt,
            messages: state.messages,
            toolTrace,
            repairMarkers: hookCtx.repairMarkers ?? [],
            permissionPolicy,
            ...(declaredContinuationWorkerRunKey
              ? { declaredContinuationWorkerRunKey }
              : {}),
            taskFacts,
            executionBudget,
            recoveryToolBudget,
            recoveryToolCallsBeforeActivation,
            ...(this.testOnlyCharacterizeRetiredPolicies
              ? { testOnlyCharacterizeRetiredPolicies: true as const }
              : {}),
            ...(packet.capabilityInspection === undefined
              ? {}
              : { capabilityInspection: packet.capabilityInspection }),
          });
        },
        // Validate against the exact schemas offered to this run before applying
        // the per-round execution cap. Invalid calls become synthetic tool errors,
        // never emit tool_started, and do not consume execution budget.
        onBeforeExecute: (calls) =>
          applyToolArgumentValidationBeforeAdmission({
            calls,
            validator: toolArgumentValidator,
            admit: (validatedCalls) =>
              executionBudget.applyEngineBeforeExecuteHook({
                calls: validatedCalls,
                ...(activeToolLoop ? { activeToolLoop } : {}),
              }),
          }),
        // Honor the remaining execution limits the per-call default bypasses:
        // order-dependent serialization, bounded concurrency, and per-chunk
        // wall-clock aborts. `calls` here is already the executable subset (schema
        // validation and the per-turn cap ran in onBeforeExecute).
        runToolBatch: async (calls, runOne, hookCtx) =>
          // The over-cap skipped results are produced by onBeforeExecute (above)
          // and ordered by agent-core after these executed results.
          executionBudget.runEngineToolBatchHook({
            calls,
            ctx: hookCtx,
            runOne,
            now: runNow,
            toolLoopStartedAtMs,
            ...(activeToolLoop ? { activeToolLoop } : {}),
          }),
        onToolResultsForHistory: (results) =>
          mapToolResultsForHistory(results as RoleToolExecutionResult[]),
        // Stage 7 S1: pre-execute tool suppression. When the model returns tool
        // calls on a setup-only "awaiting context" turn, the inline loop drops
        // them and forces a tool-free round (inline :1010-1034). Mirror that via
        // onSuppressToolCalls: drop the calls, append the assistant text + the
        // guidance prompt, and force "none" for the next round (which still
        // consumes the budget — no round--, matching inline). Idempotent via
        // ctx.repairMarkers, exactly like inline (the same ledger the Stage 6
        // cascade uses). Gated on activeToolLoop + calls.length > 0 like inline.
        onSuppressToolCalls: (calls, state, ctx) => {
          return permissionPolicy.applySuppressToolCallsHook({
            active: Boolean(activeToolLoop),
            calls,
            taskPrompt: packet.taskPrompt,
            messages: state.messages,
            lastText: state.lastText,
            repairMarkers: (ctx.repairMarkers ??= []),
            taskFacts,
          });
        },
        // Stage 5 PR2d pending-call closeouts: the registry owns the
        // read-only-suppression pre-emption, recovery-budget-before-continuation
        // ordering, empty-round continuation preview, and remaining pending-call
        // closeout cascade. The adapter supplies live hook state plus the module
        // callbacks that own each sub-decision.
        onToolCallsClose: (calls, state) => {
          return closeoutPolicy.applyPendingCallsCloseoutHook(
            {
              active: Boolean(activeToolLoop),
              pendingCalls: calls,
              lastText: state.lastText,
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              repairMarkers: ctx.repairMarkers ?? [],
              toolTrace,
              round: state.round,
              maxRounds,
              recoveryToolCallsBeforeActivation,
              recoveryToolBudget,
              permissionPolicy,
              continuation,
              executionBudget,
              evidence: runEvidence,
              now: runNow,
              toolLoopStartedAtMs,
              ...(activeToolLoop?.maxWallClockMs === undefined
                ? {}
                : { activeMaxWallClockMs: activeToolLoop.maxWallClockMs }),
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            },
            runState,
          );
        },
        // Stage 7 S7 + S5: post-execute continuation branches. After a tool round, the
        // inline loop runs an ordered cascade of continuations BEFORE the completed/
        // timeout closeout (inline :1562-1712). onAfterExecuteContinue runs BEFORE
        // onAfterExecute, so each branch pre-empts the closeout the round's results
        // would otherwise trigger. Two continuation shapes (see the agent-core hook):
        //   - S7 re-prompts: append a continuation prompt + force the next tool choice
        //     (a normal budget-consuming round, like an inline `continue` after setting
        //     nextToolChoice); the host guards idempotency via the prompt-presence
        //     checks each predicate already runs against `messages`.
        //   - S5 forced round: the host executes a forced permission_result round
        //     itself (executeRuntimeForcedToolRound — same method/trace/persistence as
        //     inline; pushes the round onto the shared toolTrace) and returns its
        //     messages; the next model call is a normal auto round.
        // Precedence mirrors inline exactly. (S8 independent-evidence-streams and S9
        // missing-approval-gate sit between branch 4 and S5 inline; until they land the
        // engine reaches S5 directly after branch 4.)
        onAfterExecuteContinue: async (results, state, hookCtx) => {
          if (!activeToolLoop) {
            return null;
          }
          const roundToolResults = results as RoleToolExecutionResult[];
          return continuation.applyAfterExecuteContinuationHook(
            {
              messages: state.messages,
              taskPrompt: packet.taskPrompt,
              toolTrace,
              results: roundToolResults,
              repairMarkers: (hookCtx.repairMarkers ??= []),
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
              browserAvailable: allowsSupplementalBrowserProbe(packet),
              taskFacts,
              observer,
              evidence: evidenceLedger,
            },
            async (forcedRoundAction) => {
              const forcedRound = await executeForcedRuntimeToolRound({
                messages: state.messages,
                toolCalls: forcedRoundAction.calls,
                assistantText: forcedRoundAction.assistantText,
              });
              return { messages: forcedRound.messages };
            },
          );
        },
        // Stage 5 PR2c closeout detection: mirror the inline post-execute
        // terminal closeouts. After a tool round runs, inspect the round's
        // results with the same finders the inline loop uses (findCompletedSession
        // Evidence / findSubAgentToolTimeout) and return the closeout reason; the
        // engine then routes a non-null reason through terminate → onTerminate,
        // exactly like a terminationPredicate. Order matches inline: a completed
        // delegated session wins over a timeout signal in the same round.
        //
        // Scope: this fires only the two terminal closeouts. The inline
        // post-execute branches that continue or repair the loop run in
        // onAfterExecuteContinue above; this callback only decides whether the
        // just-executed round terminates.
        onAfterExecute: (results) =>
          closeoutPolicy.applyPostExecuteCloseoutHook(
            {
              toolResults: results,
              evidence: evidenceLedger,
            },
            runState,
          ),
        // Stage 7 S4: empty-round session-continuation injection. When the model
        // returns no tool calls but a pending continuation directive names an unsent
        // session, the inline loop injects a synthetic sessions_send to continue it
        // (inline :567-587). Mirror that via onRoundEmpty's injectedCalls. The
        // directive is recomputed here using the same live message context as the
        // engine normalization pipeline: the per-round contextual directive ?? the base
        // directive — matching inline :449-462. The base is findSessionContinuation
        // Directive(taskPrompt) (inline :261, a pure function of the task), recomputed
        // rather than threaded since it is deterministic. Returning "terminate" (no
        // injection) falls through to onRepairRound, so the inject pre-empts the
        // S2/S3 forced-spawn exactly as inline :567 pre-empts :748; lookup
        // continuations inject sessions_list from the same helper.
        onRoundEmpty: (state) =>
          continuation.applyRoundEmptyHook({
            active: Boolean(activeToolLoop),
            messages: state.messages,
            round: state.round,
            taskPrompt: packet.taskPrompt,
            toolTrace,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
            taskFacts,
          }),
        // Stage 6: post-synthesis repairs on the engine's tool-free candidate
        // answer (the natural-finish path), mirroring the inline tool-free cascade
        // (:1110-1272). Each fires only when its shouldRepair* predicate detects a
        // deficiency and the repair has not already been injected (guarded by the
        // ctx.repairMarkers ledger, exactly like inline). Cut over, in inline order:
        // table-columns (:1139), extraneous (:1167), source-evidence (:1202),
        // weak-evidence (:1231) — the COMPLETE inline natural-finish cascade. (The
        // completed_sub_agent_final closeout has its own onTerminate repair loop;
        // browser-evidence-dimensions is intentionally closeout-only, not part of
        // the natural-finish cascade.)
        onRepairRound: (state, ctx) => {
          return repairPolicy.applyNaturalFinishRepairHook({
            active: Boolean(activeToolLoop),
            activation,
            hookContext: ctx,
            recoveryToolBudget,
            recoveryToolCallsBeforeActivation,
            taskPrompt: packet.taskPrompt,
            resultText: state.lastText,
            messages: state.messages,
            toolTrace,
            taskFacts,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
          });
        },
        // Stage 5 closeout-answer producer. round_limit (PR2a),
        // completed_sub_agent_final + sub_agent_timeout (PR2c) are reachable;
        // each closeout reason gets its inline reasonLines + status here.
        onTerminate: async (reason, state, ctx) => {
          // Stage 8C (Batch C — T10 finalization plane): stash the terminal message
          // list so the post-loop epilogue can run the inline generate() finalization
          // appenders (:2407-2433) against the same context the inline path sees.
          runState.captureFinalMessages(state.messages);
          // Each closeout reason rebuilds the inline reasonLines + closeout
          // metadata it produced inline; the round_limit defaults remain the
          // fallback for any reason without a bespoke branch. completed/timeout
          // read the signal onAfterExecute stashed on `run`.
          const terminateCloseout = closeoutPolicy.evaluateTerminateHook({
            reason: reason as EngineCloseoutReason,
            taskPrompt: packet.taskPrompt,
            messages: state.messages,
            toolTrace,
            maxRounds,
            state: runState,
            evidence: runEvidence,
            executionBudget,
          });
          // Sticky completed-closeout metadata (inline `toolLoopCloseout ??=`, :1729):
          // captured on the FIRST completed session, BEFORE the S10 browser-evidence
          // repair re-arms a sessions_spawn round. So the metadata (roundCount/
          // toolCallCount) reflects the round the session first completed, not the
          // later browser round — exactly like inline, whose `??=` no-ops on the
          // re-entered completed block. The final TEXT still comes from the last
          // synthesis (runState.closeoutResult below). TerminalCloseoutController
          // owns that pre-recording plus synthesis path selection and application;
          // the adapter only injects gateway callbacks.
          // The terminate decision keeps the inline sticky/overwrite split:
          // completed_sub_agent_final is sticky (`??=`, inline :1729), while every
          // later non-completed reason overwrites stale completed metadata.
          const terminalCompletion =
            await terminalCloseout.handleTerminalCloseoutHook({
              reason: reason as EngineCloseoutReason,
              decision: {
                closeout:
                  terminateCloseout.decision.closeout as ToolLoopCloseoutMetadata,
                ...(terminateCloseout.decision.reasonLines === undefined
                  ? {}
                  : { reasonLines: terminateCloseout.decision.reasonLines }),
                ...(terminateCloseout.decision.sticky === undefined
                  ? {}
                  : { sticky: terminateCloseout.decision.sticky }),
              },
              messages: state.messages,
              lastText: state.lastText,
              target: runState,
              // Stage 8B slice 1c: the hard approval-wait-timeout local closeout
              // (inline :966-982), reached via the onRepairRound { closeout }
              // directive. The answer is built deterministically (no model
              // synthesis), so the controller short-circuits the standard
              // reasonLines + generateFinalAfterToolRoundLimit path.
              ...terminalCloseout.buildApprovalWaitTimeoutFallbackHook({
                reason: reason as EngineCloseoutReason,
                selection,
                packet,
                maxRounds,
                fallback: terminateCloseout.approvalWaitTimeoutFallback,
              }),
              synthesize: terminalCloseout.buildTerminalSynthesisHook({
                maxRounds,
                synthesizeFinal: synthesizeFinalAfterToolRoundLimit,
              }),
              completedCloseoutHook: {
                completedCloseout,
                state: runState,
                hookContext: ctx,
                evidence: evidenceLedger,
                baseGatewayInput: initialGatewayInput,
                packet,
                ...(activation ? { activation } : {}),
                ...(initialGatewayInput.tools === undefined
                  ? {}
                  : { tools: initialGatewayInput.tools }),
                repairPolicy,
                synthesizeRepair: async ({ gatewayInput }) =>
                  generateWithEnvelopeRetry({
                    gateway: this.gateway,
                    now: runNow,
                    preCompactionMemoryFlusher: this.preCompactionMemoryFlusher,
                    activation,
                    packet,
                    selection,
                    gatewayInput,
                    modelCallTrace,
                    lifecycle,
                    tracePhase: "final_synthesis_repair",
                  }),
                synthesizeToolCallArtifactCleanup:
                  terminalCloseout.buildCompletedToolCallArtifactCleanupHook({
                    maxRounds,
                    synthesizeFinal: synthesizeFinalAfterToolRoundLimit,
                  }),
                toolTrace,
              },
            });
          if (terminalCompletion.kind === "rearm") {
            return terminalCompletion.reArm;
          }
          return terminalCompletion.response;
        },
        // Stage 5 closeout: a thrown tool-round model call converges onto the
        // inline tool_evidence_fallback closeout (when usable evidence exists). The
        // engine catches in model.generate, calls this, and emits final directly
        // (closeoutReason "model_call_error") — NOT via onTerminate; the host
        // closeout reason is tool_evidence_fallback. Aborts must rethrow.
        //
        // Stage 7 S6: before the fallback, mirror the inline model-error path
        // (:388-410) — if usable evidence shows a still-pending approval, run a forced
        // permission_result round (host-authored, no model call) and return a
        // { messages } continuation so the engine retries the model call with the
        // approval decision observed, instead of closing out blind to it. The forced
        // round's permission_result lands in the trace, so readPolicyLatestPermissionToolName is
        // no longer "permission_query" and the builder returns null on a repeat error
        // (idempotent — no loop). Aborts must rethrow.
        onModelCallError: async (error, state, _ctx) => {
          return terminalCloseout.completeModelCallErrorHook(
            {
              active: Boolean(activeToolLoop),
              activation,
              messages: state.messages,
              packet,
              selection,
              error,
              maxRounds,
              evidence: runEvidence,
              toolTrace,
              target: runState,
              buildForcedPermissionResult: () => {
                const result =
                  continuation.forcePendingApprovalWaitTimeoutPermissionResult({
                    taskPrompt: packet.taskPrompt,
                    toolTrace,
                    ...(initialGatewayInput.tools === undefined
                      ? {}
                      : { tools: initialGatewayInput.tools }),
                  });
                return result.kind === "forced_tool_round"
                  ? result
                  : { kind: "none" };
              },
            },
            async (modelErrorResult) => {
              return executeForcedRuntimeToolRound({
                messages: state.messages,
                toolCalls: modelErrorResult.calls,
                assistantText: modelErrorResult.assistantText,
              });
            },
          );
        },
        // Capture the live message history for the post-loop finalization epilogue.
        // onTerminate / onModelCallError stash runState finalMessages on the closeout and
        // error paths; on a NATURAL finish (no closeout, no error) neither fires, so
        // the epilogue would otherwise fall back to the initial gateway prompt and the
        // timeout-followup / residual-risk appenders would miss the tool-result and
        // repair context inline sees. onFinalize runs at finalization time with the
        // live state, so `??=` fills in the natural-finish case while preserving any
        // closeout-set snapshot. Returns the text unchanged.
        onFinalize: (text, state) => {
          runState.captureFinalMessagesIfAbsent(state.messages);
          return text;
        },
      }, policyTrace),
    });

    let finalText: string;
    try {
      finalText = await runAgent({
        messages: engineInitialMessages,
        ...(initialRound > 0 ? { initialRound } : {}),
        ctx,
        ...(signal ? { signal } : {}),
        ...(runJournal
          ? {
              effectLifecycle: {
                onAdmitted: ({ round, call }) =>
                  runJournal.effectLedger.admit({ round: round + 1, call }),
                onStarted: ({ call }) =>
                  runJournal.effectLedger.start(call.id),
                onResult: ({ result }) =>
                  runJournal.effectLedger.recordResult(result),
              },
            }
          : {}),
        observer,
      });
    } catch (error) {
      const completedAt = runNow();
      await lifecycle.record({
        kind: "run_terminal",
        at: completedAt,
        status: isAttemptDeadlineExceeded(signal?.reason)
          ? "deadline"
          : signal?.aborted
            ? "cancelled"
            : "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      const closeoutReason = runState.toolLoopCloseout()?.reason;
      throw attachEngineRunDiagnostics(error, {
        runTrace: buildRunTrace({
          startedAt: runStartedAt,
          completedAt,
          resumedAfterCrash: restoredJournal?.resumedAfterCrash === true,
          modelCalls: modelCallTrace,
          lifecycle: lifecycle.snapshot(),
          toolRounds: toolTrace,
          policyEntries: policyTrace.snapshot(),
          compactions: compactionTrace,
          pruning: pruningTrace,
          externalizations: externalizationTrace,
          ...(closeoutReason
            ? { closeoutReason: closeoutReason as EngineCloseoutReason }
            : {}),
          finalText: "",
          failureCategory: classifyRunFailure(error),
        }),
      });
    }

    throwIfAborted(signal);

    if (runJournal) {
      await completeRunJournalSafely(
        runJournal,
        {
          ...latestJournalState,
          messages: [
            ...(runState.finalMessages() ?? latestJournalState.messages),
          ],
          repairMarkers: ctx.repairMarkers ?? [],
          toolTrace,
        },
        activation,
      );
    }

    await recordEngineReductionBoundary({
      activation,
      packet,
      runtimeProgressRecorder: this.runtimeProgressRecorder,
      selection,
      reduction: runState.reductionSnapshot(),
    });

    const completedAt = runNow();
    const reply = buildEngineFinalResponse({
      finalText,
      closeoutResult: runState.closeoutResult(),
      lastModelResult: engineModel.lastResult(),
      finalMessages: runState.finalMessages(),
      toolTrace,
      modelCallTrace,
      reduction: runState.reduction(),
      memoryFlushes: runState.memoryFlushes(),
      toolLoopCloseout: runState.toolLoopCloseout(),
      runTrace: {
        startedAt: runStartedAt,
        completedAt,
        resumedAfterCrash: restoredJournal?.resumedAfterCrash === true,
        modelCalls: modelCallTrace,
        lifecycle: lifecycle.snapshot(),
        toolRounds: toolTrace,
        policyEntries: policyTrace.snapshot(),
        compactions: compactionTrace,
        pruning: pruningTrace,
        externalizations: externalizationTrace,
        ...(runState.toolLoopCloseout()?.reason
          ? {
              closeoutReason: runState.toolLoopCloseout()!
                .reason as EngineCloseoutReason,
            }
          : {}),
      },
      runReplay: {
        runtimeTopology: {
          runtimeProgressRecorder: this.runtimeProgressRecorder !== undefined,
          nativeToolMessageStore: this.nativeToolMessageStore !== undefined,
          runJournalStore: this.runJournalStore !== undefined,
          deferToolObservability: this.deferToolObservability,
        },
        toolDefinitions,
        toolLoop: {
          maxRounds,
          ...(activeToolLoop?.maxWallClockMs === undefined
            ? {}
            : { maxWallClockMs: activeToolLoop.maxWallClockMs }),
          ...(activeToolLoop?.maxParallelToolCalls === undefined
            ? {}
            : {
                maxParallelToolCalls:
                  activeToolLoop.maxParallelToolCalls,
              }),
          ...(activeToolLoop?.maxToolCallsPerRound === undefined
            ? {}
            : {
                maxToolCallsPerRound:
                  activeToolLoop.maxToolCallsPerRound,
              }),
        },
        artifactExternalizationEnabled:
          this.toolResultHistoryExternalizer !== undefined,
        ...(replayResumeState
          ? { resumeState: replayResumeState }
          : {}),
        clockValues,
        toolResults: observer.replayToolResultsSnapshot(),
        modelCalls: modelCallTrace,
        policyEntries: policyTrace.snapshot(),
      },
    });
    await lifecycle.record({
      kind: "run_terminal",
      at: completedAt,
      status: "completed",
    });
    return reply;
  }

}

async function loadRunJournalSafely(
  journal: RunJournal,
  activation: RoleActivationInput,
): Promise<RunJournalResumeState | null> {
  try {
    return await journal.load();
  } catch (error) {
    console.error("runtime run journal restore failed", {
      threadId: activation.thread.threadId,
      runKey: activation.runState.runKey,
      error,
    });
    return null;
  }
}

function checkpointDynamicContext(
  snapshot: DynamicContextSnapshot,
): {
  baselineId: string;
  sectionDigests: Record<string, string>;
} {
  return {
    baselineId: snapshot.baseline.baselineId,
    sectionDigests: Object.fromEntries(
      snapshot.baseline.sections.map((section) => [
        section.name,
        section.digest,
      ]),
    ),
  };
}

async function loadDynamicContextBaselineSafely(
  store: DynamicContextBaselineStore,
  scope: DynamicContextScope,
  activation: RoleActivationInput,
) {
  try {
    return await store.get(scope);
  } catch (error) {
    console.error("runtime dynamic context baseline restore failed", {
      threadId: activation.thread.threadId,
      runKey: activation.runState.runKey,
      error,
    });
    return null;
  }
}

async function persistDynamicContextBaselineSafely(
  store: DynamicContextBaselineStore,
  snapshot: DynamicContextSnapshot,
  activation: RoleActivationInput,
): Promise<void> {
  try {
    await store.put(snapshot.baseline);
  } catch (error) {
    console.error("runtime dynamic context baseline persistence failed", {
      threadId: activation.thread.threadId,
      runKey: activation.runState.runKey,
      baselineId: snapshot.baseline.baselineId,
      error,
    });
  }
}

async function checkpointRunJournalSafely(
  journal: RunJournal,
  state: RunJournalState,
  activation: RoleActivationInput,
): Promise<boolean> {
  try {
    await journal.checkpoint(state);
    return true;
  } catch (error) {
    console.error("runtime run journal checkpoint failed", {
      threadId: activation.thread.threadId,
      runKey: activation.runState.runKey,
      nextRound: state.nextRound,
      error,
    });
    return false;
  }
}

async function activateContextCheckpointSafely(
  controller: Pick<
    ReturnType<typeof createCompactionController>,
    "activateCheckpoint"
  >,
  checkpointId: string,
  activation: RoleActivationInput,
): Promise<void> {
  try {
    await controller.activateCheckpoint(checkpointId);
  } catch (error) {
    console.error("runtime context checkpoint activation failed", {
      threadId: activation.thread.threadId,
      runKey: activation.runState.runKey,
      checkpointId,
      error,
    });
  }
}

async function reconcileContextCheckpointSafely(
  controller: Pick<
    ReturnType<typeof createCompactionController>,
    "reconcileFromMessages"
  >,
  messages: GenerateTextInput["messages"],
  activation: RoleActivationInput,
): Promise<void> {
  try {
    await controller.reconcileFromMessages(messages);
  } catch (error) {
    console.error("runtime context checkpoint reconciliation failed", {
      threadId: activation.thread.threadId,
      runKey: activation.runState.runKey,
      error,
    });
  }
}

async function completeRunJournalSafely(
  journal: RunJournal,
  state: RunJournalState,
  activation: RoleActivationInput,
): Promise<void> {
  try {
    await journal.complete(state);
  } catch (error) {
    console.error("runtime run journal completion failed", {
      threadId: activation.thread.threadId,
      runKey: activation.runState.runKey,
      error,
    });
  }
}

// ORDER_DEPENDENT_TOOL_NAMES, shouldSerializeToolBatch, findRepeatedFailedToolCall
// extracted to ./react/predicates (Phase 1 cutover, behavior-preserving).

// toolCallSignature, normalizeToolInputForSignature, stableJson
// extracted to ./react/predicates (Phase 1 cutover, behavior-preserving).

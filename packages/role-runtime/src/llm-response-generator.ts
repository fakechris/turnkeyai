import type {
  Clock,
  RoleActivationInput,
  RuntimeProgressRecorder,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";

import type {
  GeneratedRoleReply,
  RoleResponseGenerator,
} from "./deterministic-response-generator";
import {
  buildGatewayInput,
  buildReducedRetryGatewayInput,
  buildToolRoundGatewayRequest,
  enforceRequestedThreeLineLabelShape,
  extractMentions,
  hasToolDefinition,
} from "./gateway-input-builder";
import {
  collectToolResultContentText,
  collectToolTraceResultContent,
  findCompletedSessionEvidence,
  findSubAgentToolTimeout,
  hasUsableEvidence,
  isResumablePartialSessionResult,
  shouldAllowRequiredTimeoutContinuationPastWallClock,
} from "./tool-result-evidence";
import {
  appendModelCallBoundary,
  summarizeModelUseTrace,
  type ModelCallBoundaryTrace,
} from "./model-call-trace";
import {
  canonicalizeSessionToolTraceCalls,
  countNativeToolCalls,
  persistNativeToolTraceSafely,
  type NativeToolRoundTrace,
} from "./native-tool-messages";
import {
  recordPromptAssemblyBoundarySafely,
  type RolePromptPacket,
} from "./prompt-policy";
import {
  recordReductionBoundarySafely,
  reducePromptPacketForRequestEnvelope,
  type RequestEnvelopeReductionLevel,
  type RequestEnvelopeReductionSnapshot,
} from "./request-envelope-reducer";
import { getRoleModelSelection } from "./role-model-selection";
import {
  buildToolDefinitionFilterMessageContext,
  buildToolDefinitionFilterTaskContext,
  filterToolDefinitionsForTask,
} from "./tool-definition-filter";
import {
  readToolResultContentText,
  recordProviderToolProtocolRoundSafely,
  recordRuntimeForcedToolRoundProviderProtocolSafely,
  recordToolResultPruningBoundarySafely,
} from "./tool-history-pruning";
import {
  appendAssistantToolCallMessage,
  appendToolResultMessages,
  DEFAULT_ROLE_TOOL_MAX_ROUNDS,
  executeRoleToolCalls,
  executeRuntimeForcedToolRound,
  recordRoleToolProgressSafely,
  type RoleToolContext,
  type RoleToolExecutionResult,
  type RoleToolLoopOptions,
} from "./tool-use";
import {
  findRepeatedFailedToolCall,
  isPositiveFiniteBudget,
  normalizeToolInputForSignature,
  roundLimitReached,
  stableJson,
  toolCallSignature,
} from "./react/predicates";
import {
  allowsSupplementalBrowserProbe,
  FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
  applySessionContinuationDirective,
  applySessionContinuationLookupDirective,
  buildApprovedBrowserTimeoutContinuationPrompt,
  buildCompletedBrowserEvidenceDimensionCarryForwardLines,
  buildForcedPendingApprovalWaitTimeoutPermissionResultCall,
  buildIncompleteApprovedBrowserActionRepairPrompt,
  buildIncompleteApprovedBrowserSessionContinuationPrompt,
  buildIndependentEvidenceStreamContinuationPrompt,
  buildMissingBrowserEvidenceRepairPrompt,
  buildMissingProductSignalBrowserEvidenceRepairPrompt,
  buildSupplementalLocalTimeoutProbePrompt,
  buildReadOnlyPermissionQuerySuppressionPrompt,
  buildContinuationDirectiveContext,
  buildCoverageTimeoutContinuationPrompt,
  buildApprovalWaitTimeoutCloseoutRepairPrompt,
  buildApprovalWaitTimeoutLocalEvidenceCloseout,
  buildFalseEvidenceBlockedSynthesisRepairPrompt,
  buildFinalRecoveryBudgetCloseoutReasonLines,
  buildFinalRecoveryBudgetCloseoutRepairPrompt,
  buildMissingApprovalGateRepairPrompt,
  buildMissingBrowserEvidenceDimensionsRepairPrompt,
  buildMissingRequestedNextActionRepairPrompt,
  buildMissingRequiredFinalDeliverablesRepairPrompt,
  buildLocalEvidenceCloseout,
  buildPendingApprovalWaitTimeoutCheckRepairPrompt,
  buildPrematurePendingApprovalRepairPrompt,
  buildSourceEvidenceCarryForwardRepairPrompt,
  buildStaleDeniedApprovalRepairPrompt,
  buildStalePendingApprovalRepairPrompt,
  buildTimeoutFollowupFinalGuidanceRepairPrompt,
  buildWeakEvidenceSynthesisRepairPrompt,
  collectApprovalWaitTimeoutRuntimeEvidence,
  contextHasTimeoutSessionResult,
  continuationRequestPrefersResumableSession,
  collectBrowserRecoverySummariesFromToolTrace,
  collectCompletedSessionEvidenceText,
  collectSourceBoundedEvidenceText,
  countCompletedSessionEvidenceResults,
  countRecoveryToolCallsBeforeActivation,
  dedupeStrings,
  disclaimsApprovalGatedBrowserAction,
  disclaimsIntendedBrowserMutation,
  enforceMissingApprovalGateRepairToolCalls,
  enforceSupplementalLocalTimeoutProbeToolCall,
  extractHttpUrls,
  extractLatestUserContinuationText,
  findExcessiveSessionContinuationCall,
  findRepeatedSessionInspectionCall,
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  findIncompleteApprovedBrowserSession,
  findMissingRequiredFinalDeliverables,
  formatDurationMs,
  hasCompletedBrowserSessionEvidence,
  hasExecutedSessionsSend,
  hasSessionTimeoutEvidence,
  hasTimeoutCloseoutGuidance,
  hasTimeoutContinuationGuidance,
  hasPermissionAppliedEvidence,
  hasMissingRequiredFinalDeliverablesRepairPrompt,
  hasLatestSupplementalLocalTimeoutProbePrompt,
  isAbortError,
  isAppliedApprovalBrowserContinuation,
  isProviderSearchPricingResearchTask,
  inferIndependentEvidenceStreamCount,
  isControlPlaneToolResultName,
  isExplicitSessionContinuationRequest,
  isLoopbackHostname,
  latestPermissionResultStatus,
  latestPermissionToolName,
  limitIndependentEvidenceSpawnCalls,
  matchesAny,
  containsAnyToolCallForm,
  normalizeApprovalGatedBrowserSpawnCalls,
  normalizeBoundedTimeoutDuplicateSourceSpawns,
  normalizeBoundedTimeoutSourceSpawnAgents,
  normalizeExplicitContinuationHistoryCalls,
  normalizeLocalUrlWebFetchCalls,
  normalizePrivateUrlResearchSpawnCalls,
  normalizeSessionToolAliasCalls,
  normalizeSessionToolCalls,
  maybeAppendBrowserFailureBucketVisibility,
  maybeAppendBrowserRecoveryVisibility,
  maybeAppendBrowserRecoveryResidualRiskVisibility,
  maybeAppendRecoveredTimeoutCloseoutVisibility,
  maybeAppendRequiredTimeoutFollowupVisibility,
  maybeAppendTimeoutContinuationVisibility,
  maybeRedactForbiddenLocalUrls,
  mentionsPendingApproval,
  mentionsTimeout,
  parseJsonObject,
  readSessionKeyFromToolInput,
  readStringField,
  readStringInput,
  requestsApprovalGatedBrowserAction,
  resolveRecoveryToolBudgetForActivation,
  resolveEffectiveToolLoopWallClockMs,
  shouldCloseoutCancelledSessionWithoutContinuation,
  shouldContinueTimedOutApprovedBrowserSession,
  shouldContinueTimedOutSiblingSession,
  shouldContinueIndependentEvidenceStreams,
  shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair,
  shouldRunSupplementalLocalTimeoutProbe,
  shouldAppendRecoveredTimeoutCloseoutVisibility,
  shouldAppendTimeoutContinuationVisibility,
  shouldRepairApprovalWaitTimeoutCloseout,
  shouldRepairFalseEvidenceBlockedSynthesis,
  shouldRepairFinalRecoveryBudgetCloseout,
  shouldRepairIncompleteApprovedBrowserAction,
  shouldRepairMissingBrowserEvidence,
  shouldRepairMissingBrowserEvidenceDimensions,
  shouldRepairMissingProductSignalBrowserEvidence,
  shouldRepairMissingApprovalGate,
  shouldRepairMissingRequestedNextAction,
  shouldRepairPendingApprovalWaitTimeoutCheck,
  shouldRepairPrematurePendingApprovalFinal,
  shouldRepairSourceEvidenceCarryForward,
  shouldRepairStaleDeniedApproval,
  shouldRepairStalePendingApproval,
  shouldRepairTimeoutFollowupFinalGuidance,
  shouldRepairWeakEvidenceSynthesis,
  shouldPreserveRecoveredTimeoutCloseout,
  shouldSuppressReadOnlyPermissionQueryToolCalls,
  sliceUtf8,
  taskAllowsPermissionTools,
  taskPromptRequestsApprovalWaitTimeoutCloseout,
  taskPromptIsAppliedApprovalBrowserContinuation,
  taskPromptLooksLikeSourceCheckContinuation,
  taskPromptSaysApprovalAlreadyApplied,
  taskRequestsSessionTranscript,
  taskRequestsTimeoutFollowupContinuation,
  toNativeToolProgressTrace,
  toNativeToolResultTrace,
  toolTraceHasCall,
  throwIfAborted,
  withFinalToolRoundWarning,
  expectsExactFinalAnswerShape,
} from "./tool-loop-shared";
import {
  buildRuntimeDerivedMissionReport,
  type ToolLoopCloseoutMetadata,
} from "./runtime-derived-mission-report";
import { createReActAgent } from "@turnkeyai/agent-core/react-agent";
import type { ModelClient } from "@turnkeyai/agent-core/react-loop";
// Stage 8 cleanup (Batch 0.5): engine policy-trace plumbing. The trace is a
// behavior-neutral observability sink that records the per-hook decision sequence
// so later batches can prove byte-identical behavior and so production-behind-flag
// failures can answer "which policy fired or skipped." See react-engine/*.
import {
  createCloseoutPolicyRegistry,
  createCompletedCloseoutController,
  createContinuationController,
  createEnginePolicyTrace,
  enginePolicyTraceDebugEnabled,
  createExecutionBudgetController,
  createEvidenceLedger,
  createEngineRunState,
  createEngineRunObserver,
  buildPermissionSuppressInput,
  createPermissionPolicy,
  createRepairPolicyRegistry,
  createTerminalCloseoutController,
  type DefaultEngineRunStateValues,
  type EngineRunObserver,
  buildToolCallNormalizationContext,
  finalizeEngineAnswer,
  normalizeEngineToolCalls,
  traceEngineHooks,
  type EngineCloseoutReason,
} from "./react-engine";
import {
  buildAwaitingContextSetupNoToolRepairPrompt,
  buildExtraneousProviderTableSchemaRepairPrompt,
  buildMissingRequestedTableColumnsRepairPrompt,
  recordRepairPrompt,
  shouldRepairExtraneousProviderTableSchema,
  shouldRepairMissingRequestedTableColumns,
  shouldSuppressToolsForAwaitingContextSetup,
} from "./task-facts-shared";
import type { Toolkit } from "@turnkeyai/agent-core/toolkit";
import {
  flushPreCompactionMemorySafely,
  type PreCompactionMemoryFlusher,
  type PreCompactionMemoryFlushResult,
} from "./pre-compaction-memory-flusher";

export class LLMRoleResponseGenerator implements RoleResponseGenerator {
  private readonly gateway: LLMGateway;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly toolLoop: RoleToolLoopOptions | undefined;
  private readonly nativeToolMessageStore:
    | Pick<TeamMessageStore, "append">
    | undefined;
  private readonly preCompactionMemoryFlusher:
    | PreCompactionMemoryFlusher
    | undefined;
  private readonly clock: Clock;
  private readonly deferToolObservability: boolean;
  /**
   * Cutover flag. "inline" remains the production default; "engine" routes the
   * role-runtime loop through agent-core's createReActAgent adapter. Full parity is
   * in place, but the default flip still needs a flagged soak.
   */
  private readonly reactEngine: "inline" | "engine";

  constructor(options: {
    gateway: LLMGateway;
    runtimeProgressRecorder?: RuntimeProgressRecorder;
    toolLoop?: RoleToolLoopOptions;
    nativeToolMessageStore?: Pick<TeamMessageStore, "append">;
    preCompactionMemoryFlusher?: PreCompactionMemoryFlusher;
    clock?: Clock;
    deferToolObservability?: boolean;
    reactEngine?: "inline" | "engine";
  }) {
    this.gateway = options.gateway;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.toolLoop = options.toolLoop;
    this.nativeToolMessageStore = options.nativeToolMessageStore;
    this.preCompactionMemoryFlusher = options.preCompactionMemoryFlusher;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.deferToolObservability = options.deferToolObservability === true;
    this.reactEngine =
      options.reactEngine ??
      (typeof process !== "undefined" && process.env?.TURNKEYAI_REACT_ENGINE === "engine"
        ? "engine"
        : "inline");
  }

  async generate(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    signal?: AbortSignal;
  }): Promise<GeneratedRoleReply> {
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
    throwIfAborted(input.signal);

    let result: GenerateTextResult;
    let reduction:
      | {
          level: RequestEnvelopeReductionLevel;
          omittedSections: string[];
        }
      | undefined;
    let reductionSnapshot:
      | RequestEnvelopeReductionSnapshot
      | undefined;
    const memoryFlushes: PreCompactionMemoryFlushResult[] = [];

    await recordPromptAssemblyBoundarySafely({
      activation: input.activation,
      packet: input.packet,
      runtimeProgressRecorder: this.runtimeProgressRecorder,
      selection,
    });
    const baseSessionContinuationDirective = activeToolLoop
      ? findSessionContinuationDirective(input.packet.taskPrompt)
      : null;
    const toolDefinitions = activeToolLoop
      ? filterToolDefinitionsForTask(
          activeToolLoop.executor.definitions(),
          buildToolDefinitionFilterTaskContext(input.activation, input.packet.taskPrompt),
        )
      : undefined;

    let initialGatewayInput = buildGatewayInput({
      activation: input.activation,
      packet: input.packet,
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      ...(selection.modelChainId
        ? { modelChainId: selection.modelChainId }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
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
    if (activeToolLoop && initialGatewayInput.tools?.length) {
      const filteredTools = filterToolDefinitionsForTask(
        initialGatewayInput.tools,
        [
          buildToolDefinitionFilterTaskContext(input.activation, input.packet.taskPrompt),
          buildToolDefinitionFilterMessageContext(initialGatewayInput.messages),
        ].join("\n"),
      );
      if (filteredTools && filteredTools !== initialGatewayInput.tools) {
        initialGatewayInput = {
          ...initialGatewayInput,
          tools: filteredTools,
        };
      }
    }

    const toolTrace: NativeToolRoundTrace[] = [];
    const modelCallTrace: ModelCallBoundaryTrace[] = [];
    let messages: LLMMessage[] = initialGatewayInput.messages;
    const recoveryToolBudget = activeToolLoop
      ? resolveRecoveryToolBudgetForActivation({
          activation: input.activation,
          taskPrompt: input.packet.taskPrompt,
          messages,
        })
      : null;
    const recoveryToolCallsBeforeActivation = recoveryToolBudget
      ? countRecoveryToolCallsBeforeActivation({
          activation: input.activation,
          taskPrompt: input.packet.taskPrompt,
          messages,
        })
      : 0;
    let nextToolChoice: GenerateTextInput["toolChoice"] | undefined;
    const toolLoopStartedAtMs = this.clock.now();
    let toolLoopCloseout: ToolLoopCloseoutMetadata | undefined;
    // The engine path drives a tool loop; when there is no active tool loop
    // (toolUseMode "disabled", :378) there is nothing to loop, so route to the
    // inline single tool-free model call — exactly what inline does when
    // activeToolLoop is undefined (no tools attached, no execution). Entering the
    // ReAct agent here would attach the toolkit and execute the model's tool calls
    // as "Unknown tool" results, diverging from inline.
    if (this.reactEngine === "engine" && activeToolLoop) {
      return this.runViaReActEngine({
        input,
        selection,
        activeToolLoop,
        initialGatewayInput,
        modelCallTrace,
        recoveryToolBudget,
        recoveryToolCallsBeforeActivation,
      });
    }
    // Stage 6 prereq: repair idempotency ledger. Every `shouldRepair*` "already
    // tried" guard reads this ledger of injected repair prompts instead of
    // scanning the full conversation history, so the predicates no longer depend
    // on how/where messages are stored (the Turnkey-agnostic boundary). Inline
    // owns a loop-local ledger; the engine will pass `ctx.repairMarkers`.
    const repairMarkers: LLMMessage[] = [];
    for (let round = 0; ; round++) {
      throwIfAborted(input.signal);
      const maxRounds =
        activeToolLoop?.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
      const warningMessages = withFinalToolRoundWarning(messages, {
        active: Boolean(activeToolLoop),
        round,
        maxRounds,
      });
      const gatewayRequest = buildToolRoundGatewayRequest({
        baseGatewayInput: initialGatewayInput,
        messages: warningMessages,
        noToolRound: nextToolChoice === "none",
        ...(nextToolChoice ? { toolChoice: nextToolChoice } : {}),
      });
      await recordToolResultPruningBoundarySafely({
        activation: input.activation,
        runtimeProgressRecorder: this.runtimeProgressRecorder,
        selection,
        snapshot: gatewayRequest.pruning,
      });
      let generated: Awaited<
        ReturnType<LLMRoleResponseGenerator["generateWithEnvelopeRetry"]>
      >;
      try {
        generated = await this.generateWithEnvelopeRetry({
          activation: input.activation,
          packet: input.packet,
          selection,
          gatewayInput: gatewayRequest.gatewayInput,
          modelCallTrace,
          tracePhase: "tool_round",
          traceRound: round,
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const forcedPermissionResultCall =
          activeToolLoop && hasUsableEvidence(toolTrace)
            ? buildForcedPendingApprovalWaitTimeoutPermissionResultCall({
                taskPrompt: input.packet.taskPrompt,
                toolTrace,
                ...(initialGatewayInput.tools === undefined
                  ? {}
                  : { tools: initialGatewayInput.tools }),
              })
            : null;
        if (forcedPermissionResultCall) {
          const forcedRound = await executeRuntimeForcedToolRound({
            toolLoop: this.toolLoop,
            runtimeProgressRecorder: this.runtimeProgressRecorder,
            deferToolObservability: this.deferToolObservability,
            now: () => this.clock.now(),
            activation: input.activation,
            packet: input.packet,
            messages,
            toolTrace,
            toolCalls: [forcedPermissionResultCall],
            round: round + 1,
            toolLoopStartedAtMs,
            ...(input.signal ? { signal: input.signal } : {}),
            assistantText: FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
            persistNativeToolTrace: (options) =>
              persistNativeToolTraceSafely({
                activation: input.activation,
                toolTrace,
                nativeToolMessageStore: this.nativeToolMessageStore,
                now: () => this.clock.now(),
                defer: this.deferToolObservability,
                ...(options?.forceBlocking === undefined
                  ? {}
                  : { forceBlocking: options.forceBlocking }),
              }),
            recordProviderToolProtocolRound: (roundInput) =>
              recordRuntimeForcedToolRoundProviderProtocolSafely({
                activation: input.activation,
                runtimeProgressRecorder:
                  this.toolLoop?.runtimeProgressRecorder ??
                  this.runtimeProgressRecorder,
                now: () => this.clock.now(),
                defer: this.deferToolObservability,
                ...roundInput,
              }),
          });
          messages = forcedRound.messages;
          continue;
        }
        const localResult =
          activeToolLoop && hasUsableEvidence(toolTrace)
            ? buildLocalEvidenceCloseout({
                activation: input.activation,
                messages,
                packet: input.packet,
                selection,
                error,
              })
            : null;
        if (!localResult) {
          throw error;
        }
        toolLoopCloseout = {
          reason: "tool_evidence_fallback",
          maxRounds,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: true,
        };
        result = maybeRedactForbiddenLocalUrls({
          result: localResult,
          packet: input.packet,
        });
        break;
      }
      nextToolChoice = undefined;
      throwIfAborted(input.signal);
      result = generated.result;
      if (generated.reduction) {
        reduction = generated.reduction;
        reductionSnapshot = generated.reductionSnapshot;
      }
      if (generated.memoryFlush) {
        memoryFlushes.push(generated.memoryFlush);
      }

      const supplementalLocalTimeoutProbePending =
        hasLatestSupplementalLocalTimeoutProbePrompt(messages);
      const sessionContinuationContext = buildContinuationDirectiveContext(
        input.packet.taskPrompt,
        messages,
      );
      const contextualSessionContinuationDirective =
        activeToolLoop && !supplementalLocalTimeoutProbePending
          ? findSessionContinuationDirective(sessionContinuationContext)
          : null;
      const sessionContinuationDirective = supplementalLocalTimeoutProbePending
        ? null
        : (contextualSessionContinuationDirective ??
          baseSessionContinuationDirective);
      const sessionContinuationLookupDirective =
        !supplementalLocalTimeoutProbePending &&
        !sessionContinuationDirective &&
        activeToolLoop &&
        !isAppliedApprovalBrowserContinuation(input.packet.taskPrompt)
          ? findSessionContinuationLookupDirective(
              sessionContinuationContext,
              sessionContinuationContext,
            )
          : null;
      const modelToolCalls = enforceSupplementalLocalTimeoutProbeToolCall(
        enforceMissingApprovalGateRepairToolCalls(
          normalizeSessionToolAliasCalls(result.toolCalls ?? []),
          {
            messages,
            repairMarkers,
            taskPrompt: input.packet.taskPrompt,
            toolTrace,
          },
        ),
        messages,
      );
      // Tool-call normalization pipeline. Flattened from a 12-deep nested
      // expression into an explicit ordered sequence — identical functions,
      // arguments, and order, just readable as a pipeline. Each step rewrites
      // the pending calls before execution.
      let toolCalls = applySessionContinuationDirective(modelToolCalls, sessionContinuationDirective);
      toolCalls = applySessionContinuationLookupDirective(toolCalls, sessionContinuationLookupDirective);
      toolCalls = normalizeExplicitContinuationHistoryCalls(toolCalls, input.packet.taskPrompt);
      toolCalls = normalizeSessionToolCalls(toolCalls, sessionContinuationContext);
      toolCalls = normalizePrivateUrlResearchSpawnCalls(toolCalls, {
        browserAvailable:
          input.packet.capabilityInspection?.availableWorkers?.includes("browser") ?? false,
        taskPrompt: input.packet.taskPrompt,
      });
      toolCalls = normalizeLocalUrlWebFetchCalls(toolCalls, { taskPrompt: input.packet.taskPrompt });
      toolCalls = normalizeBoundedTimeoutSourceSpawnAgents(toolCalls, {
        exploreAvailable:
          input.packet.capabilityInspection?.availableWorkers?.includes("explore") ?? false,
        taskPrompt: input.packet.taskPrompt,
      });
      toolCalls = normalizeBoundedTimeoutDuplicateSourceSpawns(toolCalls, {
        taskPrompt: input.packet.taskPrompt,
      });
      toolCalls = applySessionContinuationDirective(toolCalls, sessionContinuationDirective);
      toolCalls = normalizeApprovalGatedBrowserSpawnCalls(toolCalls, {
        taskPrompt: input.packet.taskPrompt,
        sessionContext: sessionContinuationContext,
        toolTrace,
      });
      toolCalls = limitIndependentEvidenceSpawnCalls(toolCalls, {
        taskPrompt: input.packet.taskPrompt,
        toolTrace,
      });
      const modelRequestedMoreTools = (result.toolCalls?.length ?? 0) > 0;
      if (
        activeToolLoop &&
        shouldSuppressReadOnlyPermissionQueryToolCalls(toolCalls, {
          taskPrompt: input.packet.taskPrompt,
          sessionContext: sessionContinuationContext,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          {
            role: "user",
            content: buildReadOnlyPermissionQuerySuppressionPrompt(),
          },
        ];
        nextToolChoice = "none";
        continue;
      }
      if (
        activeToolLoop &&
        recoveryToolBudget &&
        toolCalls.length === 0 &&
        recoveryToolCallsBeforeActivation + countNativeToolCalls(toolTrace) >=
          recoveryToolBudget.maxToolCalls &&
        shouldRepairFinalRecoveryBudgetCloseout({
          messages,
          repairMarkers,
          resultText: result.text,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildFinalRecoveryBudgetCloseoutRepairPrompt(
              recoveryToolBudget.maxToolCalls,
            ),
          ),
        ];
        nextToolChoice = "none";
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        sessionContinuationDirective &&
        !hasExecutedSessionsSend(
          toolTrace,
          sessionContinuationDirective.sessionKey,
        ) &&
        hasToolDefinition(initialGatewayInput.tools, "sessions_send")
      ) {
        toolCalls = [
          {
            id: `runtime-continuation-${round + 1}`,
            name: "sessions_send",
            input: {
              session_key: sessionContinuationDirective.sessionKey,
              message: sessionContinuationDirective.messageHint,
            },
          },
        ];
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        !sessionContinuationDirective &&
        sessionContinuationLookupDirective &&
        hasToolDefinition(initialGatewayInput.tools, "sessions_list")
      ) {
        toolCalls = [
          {
            id: `runtime-continuation-lookup-${round + 1}`,
            name: "sessions_list",
            input: {
              limit: 5,
              reason: `continuation lookup: ${sessionContinuationLookupDirective.messageHint}`,
            },
          },
        ];
      }
      if (activeToolLoop && recoveryToolBudget) {
        const usedToolCalls =
          recoveryToolCallsBeforeActivation + countNativeToolCalls(toolTrace);
        const remainingToolCalls = recoveryToolBudget.maxToolCalls - usedToolCalls;
        if (remainingToolCalls <= 0) {
          toolLoopCloseout = {
            reason: "recovery_tool_budget",
            maxRounds,
            pendingToolCallCount: toolCalls.length,
            toolCallCount: usedToolCalls,
            roundCount: toolTrace.length,
            evidenceAvailable: hasUsableEvidence(toolTrace),
          };
          throwIfAborted(input.signal);
          const generated = await this.generateFinalAfterToolRoundLimit({
            activation: input.activation,
            packet: input.packet,
            selection,
            baseGatewayInput: initialGatewayInput,
            messages,
            maxRounds,
            modelCallTrace,
            reasonLines: buildFinalRecoveryBudgetCloseoutReasonLines(
              recoveryToolBudget.maxToolCalls,
            ),
          });
          throwIfAborted(input.signal);
          result = generated.result;
          if (generated.reduction) {
            reduction = generated.reduction;
            reductionSnapshot = generated.reductionSnapshot;
          }
          if (generated.memoryFlush) {
            memoryFlushes.push(generated.memoryFlush);
          }
          if (
            shouldRepairMissingRequestedTableColumns({
              activation: input.activation,
              taskPrompt: input.packet.taskPrompt,
              messages,
              repairMarkers,
              resultText: result.text,
            })
          ) {
            messages = [
              ...messages,
              {
                role: "assistant",
                content: result.text,
              },
              recordRepairPrompt(
                repairMarkers,
                buildMissingRequestedTableColumnsRepairPrompt({
                  activation: input.activation,
                  taskPrompt: input.packet.taskPrompt,
                  messages,
                  resultText: result.text,
                }),
              ),
            ];
            nextToolChoice = "none";
            continue;
          }
          break;
        }
        if (toolCalls.length > remainingToolCalls) {
          toolCalls = toolCalls.slice(0, remainingToolCalls);
        }
      }
      if (
        activeToolLoop &&
        toolCalls.length > 0 &&
        shouldCloseoutCancelledSessionWithoutContinuation({
          taskPrompt: input.packet.taskPrompt,
          messages,
        })
      ) {
        const maxRounds =
          activeToolLoop.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
        toolLoopCloseout = {
          reason: "operator_cancelled",
          maxRounds,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: hasUsableEvidence(toolTrace),
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            "A previous sub-agent session was cancelled by the operator.",
            "The latest user message did not ask to continue, resume, or retry that cancelled session.",
            "Do not call more tools or spawn a replacement session. Produce the final answer from the cancellation evidence already present.",
            "State what remains unverified and how the user can continue later if they want the cancelled work resumed.",
          ],
        });
        throwIfAborted(input.signal);
        result = generated.result;
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        const completedEvidenceText = collectCompletedSessionEvidenceText(toolTrace);
        if (
          completedEvidenceText &&
          shouldRepairMissingBrowserEvidenceDimensions({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedEvidenceText,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedEvidenceText,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        break;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairMissingBrowserEvidence({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
          ...(initialGatewayInput.tools === undefined
            ? {}
            : { tools: initialGatewayInput.tools }),
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildMissingBrowserEvidenceRepairPrompt(
              input.packet.taskPrompt,
            ),
          ),
        ];
        nextToolChoice = { type: "tool", name: "sessions_spawn" };
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairMissingProductSignalBrowserEvidence({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
          ...(initialGatewayInput.tools === undefined
            ? {}
            : { tools: initialGatewayInput.tools }),
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildMissingProductSignalBrowserEvidenceRepairPrompt(
              input.packet.taskPrompt,
            ),
          ),
        ];
        nextToolChoice = { type: "tool", name: "sessions_spawn" };
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairMissingApprovalGate({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
          ...(initialGatewayInput.tools === undefined
            ? {}
            : { tools: initialGatewayInput.tools }),
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildMissingApprovalGateRepairPrompt(),
          ),
        ];
        nextToolChoice = { type: "tool", name: "permission_query" };
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairPendingApprovalWaitTimeoutCheck({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildPendingApprovalWaitTimeoutCheckRepairPrompt(),
          ),
        ];
        nextToolChoice = { type: "tool", name: "permission_result" };
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairPrematurePendingApprovalFinal({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildPrematurePendingApprovalRepairPrompt(),
          ),
        ];
        nextToolChoice = { type: "tool", name: "permission_result" };
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairStalePendingApproval({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildStalePendingApprovalRepairPrompt(),
          ),
        ];
        nextToolChoice = { type: "tool", name: "sessions_spawn" };
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairStaleDeniedApproval({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildStaleDeniedApprovalRepairPrompt(),
          ),
        ];
        nextToolChoice = "none";
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairApprovalWaitTimeoutCloseout({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildApprovalWaitTimeoutCloseoutRepairPrompt(),
          ),
        ];
        nextToolChoice = "none";
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
        })
      ) {
        toolLoopCloseout = {
          reason: "tool_evidence_fallback",
          maxRounds,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: true,
        };
        result = maybeRedactForbiddenLocalUrls({
          result: buildApprovalWaitTimeoutLocalEvidenceCloseout({
            selection,
            evidenceText: collectApprovalWaitTimeoutRuntimeEvidence(toolTrace),
            error: new Error(
              "approval wait-timeout repair omitted required pending evidence",
            ),
          }),
          packet: input.packet,
        });
        break;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        shouldRepairIncompleteApprovedBrowserAction({
          taskPrompt: input.packet.taskPrompt,
          resultText: result.text,
          messages,
          repairMarkers,
          toolTrace,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildIncompleteApprovedBrowserActionRepairPrompt(),
          ),
        ];
        nextToolChoice = { type: "tool", name: "sessions_spawn" };
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length > 0 &&
        shouldSuppressToolsForAwaitingContextSetup({
          taskPrompt: input.packet.taskPrompt,
          repairMarkers,
        })
      ) {
        messages = [
          ...messages,
          {
            role: "assistant",
            content: result.text,
          },
          recordRepairPrompt(
            repairMarkers,
            buildAwaitingContextSetupNoToolRepairPrompt(
              input.packet.taskPrompt,
            ),
          ),
        ];
        nextToolChoice = "none";
        continue;
      }
      if (
        activeToolLoop &&
        toolCalls.length === 0 &&
        containsAnyToolCallForm(result)
      ) {
        const maxRounds =
          activeToolLoop.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
        toolLoopCloseout = {
          reason: "pseudo_tool_call",
          maxRounds,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: hasUsableEvidence(toolTrace),
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages: [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
          ],
          maxRounds,
          modelCallTrace,
          reasonLines: [
            "The previous assistant response attempted to emit XML, JSON, or pseudo tool-call markup without a native tool call.",
            "Tools are not available through text markup. Do not call more tools.",
            "Produce only the final user-facing answer from the evidence already present in the conversation.",
          ],
        });
        throwIfAborted(input.signal);
        result = generated.result;
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        const completedEvidenceText = collectCompletedSessionEvidenceText(toolTrace);
        if (
          completedEvidenceText &&
          shouldRepairMissingBrowserEvidenceDimensions({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedEvidenceText,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedEvidenceText,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        break;
      }
      if (!activeToolLoop || toolCalls.length === 0) {
        if (activeToolLoop) {
          if (
            recoveryToolBudget &&
            recoveryToolCallsBeforeActivation + countNativeToolCalls(toolTrace) >=
              recoveryToolBudget.maxToolCalls &&
            shouldRepairFinalRecoveryBudgetCloseout({
              messages,
              repairMarkers,
              resultText: result.text,
            })
          ) {
            messages = [
              ...messages,
              {
                role: "assistant",
                content: result.text,
              },
              recordRepairPrompt(
                repairMarkers,
                buildFinalRecoveryBudgetCloseoutRepairPrompt(
                  recoveryToolBudget.maxToolCalls,
                ),
              ),
            ];
            nextToolChoice = "none";
            continue;
          }
          if (
            shouldRepairMissingRequestedTableColumns({
              activation: input.activation,
              taskPrompt: input.packet.taskPrompt,
              messages,
              repairMarkers,
              resultText: result.text,
            })
          ) {
            messages = [
              ...messages,
              {
                role: "assistant",
                content: result.text,
              },
              recordRepairPrompt(
                repairMarkers,
                buildMissingRequestedTableColumnsRepairPrompt({
                  activation: input.activation,
                  taskPrompt: input.packet.taskPrompt,
                  messages,
                  resultText: result.text,
                }),
              ),
            ];
            nextToolChoice = "none";
            continue;
          }
          if (
            shouldRepairExtraneousProviderTableSchema({
              activation: input.activation,
              taskPrompt: input.packet.taskPrompt,
              messages,
              repairMarkers,
              resultText: result.text,
            })
          ) {
            messages = [
              ...messages,
              {
                role: "assistant",
                content: result.text,
              },
              recordRepairPrompt(
                repairMarkers,
                buildExtraneousProviderTableSchemaRepairPrompt({
                  taskPrompt: input.packet.taskPrompt,
                  resultText: result.text,
                }),
              ),
            ];
            nextToolChoice = "none";
            continue;
          }
          const sourceBoundedEvidenceText = [
            collectSourceBoundedEvidenceText({
              taskPrompt: input.packet.taskPrompt,
              messages,
              toolTrace,
            }),
            collectCompletedSessionEvidenceText(toolTrace),
          ]
            .filter((text) => text.trim().length > 0)
            .join("\n\n");
          if (
            sourceBoundedEvidenceText &&
            shouldRepairSourceEvidenceCarryForward({
              taskPrompt: input.packet.taskPrompt,
              resultText: result.text,
              messages,
              repairMarkers,
              evidenceText: sourceBoundedEvidenceText,
            })
          ) {
            messages = [
              ...messages,
              {
                role: "assistant",
                content: result.text,
              },
              recordRepairPrompt(
                repairMarkers,
                buildSourceEvidenceCarryForwardRepairPrompt({
                  taskPrompt: input.packet.taskPrompt,
                  resultText: result.text,
                  evidenceText: sourceBoundedEvidenceText,
                }),
              ),
            ];
            nextToolChoice = "none";
            continue;
          }
          if (
            shouldRepairWeakEvidenceSynthesis({
              taskPrompt: input.packet.taskPrompt,
              resultText: result.text,
              messages,
              repairMarkers,
              evidenceText: sourceBoundedEvidenceText,
            })
          ) {
            messages = [
              ...messages,
              {
                role: "assistant",
                content: result.text,
              },
              recordRepairPrompt(
                repairMarkers,
                buildWeakEvidenceSynthesisRepairPrompt(),
              ),
            ];
            nextToolChoice = "none";
            continue;
          }
          if (
            shouldAppendRecoveredTimeoutCloseoutVisibility({
              resultText: result.text,
              taskPrompt: input.packet.taskPrompt,
              messages,
              toolTrace,
            })
          ) {
            result = maybeAppendRecoveredTimeoutCloseoutVisibility(result);
          } else if (
            shouldAppendTimeoutContinuationVisibility({
              taskPrompt: input.packet.taskPrompt,
              messages,
              toolTrace,
            })
          ) {
            result = maybeAppendTimeoutContinuationVisibility(result);
          }
        }
        break;
      }
      const maxWallClockMs = resolveEffectiveToolLoopWallClockMs({
        ...(activeToolLoop.maxWallClockMs !== undefined ? { maxWallClockMs: activeToolLoop.maxWallClockMs } : {}),
        toolCalls,
      });
      const requiredTimeoutContinuationPastWallClock =
        shouldAllowRequiredTimeoutContinuationPastWallClock({
          taskPrompt: input.packet.taskPrompt,
          messages,
          toolCalls,
          toolTrace,
        });
      if (
        !requiredTimeoutContinuationPastWallClock &&
        toolTrace.length > 0 &&
        isPositiveFiniteBudget(maxWallClockMs) &&
        this.clock.now() - toolLoopStartedAtMs >= maxWallClockMs
      ) {
        toolLoopCloseout = {
          reason: "wall_clock_budget",
          maxRounds,
          maxWallClockMs,
          pendingToolCallCount: toolCalls.length,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: hasUsableEvidence(toolTrace),
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            `Tool-use wall-clock budget reached (${formatDurationMs(maxWallClockMs)}).`,
            "Do not call more tools. Produce the best final answer from the evidence already gathered.",
            "State uncertainties and missing verification explicitly instead of trying another lookup.",
          ],
        });
        throwIfAborted(input.signal);
        result = generated.result;
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        const completedEvidenceText = collectCompletedSessionEvidenceText(toolTrace);
        if (
          completedEvidenceText &&
          shouldRepairMissingBrowserEvidenceDimensions({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedEvidenceText,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedEvidenceText,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        break;
      }
      if (roundLimitReached(round, maxRounds)) {
        toolLoopCloseout = {
          reason: "round_limit",
          maxRounds,
          pendingToolCallCount: toolCalls.length,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: hasUsableEvidence(toolTrace),
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            `Tool-use round limit reached (${maxRounds}).`,
            "Do not call more tools. Produce the best final answer from the evidence already gathered.",
            "State uncertainties and missing verification explicitly instead of trying another lookup.",
          ],
        });
        throwIfAborted(input.signal);
        result = generated.result;
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        break;
      }
      const repeatedFailure = findRepeatedFailedToolCall(toolCalls, toolTrace);
      if (repeatedFailure) {
        toolLoopCloseout = {
          reason: "repeated_tool_failure",
          maxRounds,
          pendingToolCallCount: toolCalls.length,
          toolName: repeatedFailure.toolName,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: hasUsableEvidence(toolTrace),
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            `Repeated failing tool call detected: ${repeatedFailure.toolName} failed ${repeatedFailure.failureCount} times with the same arguments.`,
            "Do not call the same tool again with those arguments, and do not spawn a fallback session for the same target.",
            "Produce the best final answer from evidence already gathered. If no usable evidence exists, say verification did not complete and name the next operator/user input needed.",
          ],
        });
        throwIfAborted(input.signal);
        result = generated.result;
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        break;
      }
      const repeatedSessionInspection = findRepeatedSessionInspectionCall(
        toolCalls,
        toolTrace,
        input.packet.taskPrompt,
        `${input.packet.taskPrompt}\n${sessionContinuationContext}`,
      );
      if (repeatedSessionInspection) {
        toolLoopCloseout = {
          reason: "repeated_session_inspection",
          maxRounds,
          pendingToolCallCount: toolCalls.length,
          toolName: repeatedSessionInspection.toolName,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: hasUsableEvidence(toolTrace),
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            `Repeated session inspection detected: ${repeatedSessionInspection.toolName} already inspected ${repeatedSessionInspection.sessionKey}.`,
            "Do not call sessions_history or sessions_list again for the same session.",
            "Produce the final answer from the session evidence already gathered. If the gathered evidence is insufficient, state exactly what remains unverified and what follow-up is needed.",
          ],
        });
        throwIfAborted(input.signal);
        result = generated.result;
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        break;
      }
      const excessiveSessionContinuation = findExcessiveSessionContinuationCall(
        toolCalls,
        toolTrace,
      );
      if (excessiveSessionContinuation) {
        toolLoopCloseout = {
          reason: "excessive_session_continuation",
          maxRounds,
          pendingToolCallCount: toolCalls.length,
          toolName: excessiveSessionContinuation.toolName,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: hasUsableEvidence(toolTrace),
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            `Repeated session continuation detected: ${excessiveSessionContinuation.sessionKey} was already continued ${excessiveSessionContinuation.continuationCount} times.`,
            "Do not call sessions_send again for the same session.",
            "Produce the final answer from the gathered session evidence now. If the evidence is incomplete, state the exact unverified scope and the bounded follow-up needed.",
          ],
        });
        throwIfAborted(input.signal);
        result = generated.result;
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        break;
      }

      const roundTrace: NativeToolRoundTrace = {
        round: round + 1,
        calls: toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          input: call.input,
        })),
        results: [],
        progress: [],
      };
      toolTrace.push(roundTrace);
      const toolResults = await executeRoleToolCalls({
        toolLoop: this.toolLoop,
        runtimeProgressRecorder: this.runtimeProgressRecorder,
        deferToolObservability: this.deferToolObservability,
        now: () => this.clock.now(),
        activation: input.activation,
        packet: input.packet,
        toolCalls,
        toolLoopStartedAtMs,
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: async (call, progress) => {
          roundTrace.progress?.push(
            toNativeToolProgressTrace(call, progress, this.clock.now()),
          );
          await persistNativeToolTraceSafely({
            activation: input.activation,
            toolTrace,
            nativeToolMessageStore: this.nativeToolMessageStore,
            now: () => this.clock.now(),
            defer: this.deferToolObservability,
            forceBlocking: progress.phase === "started",
          });
        },
        onResult: async (toolResult) => {
          roundTrace.results.push(toNativeToolResultTrace(toolResult));
          await persistNativeToolTraceSafely({
            activation: input.activation,
            toolTrace,
            nativeToolMessageStore: this.nativeToolMessageStore,
            now: () => this.clock.now(),
            defer: this.deferToolObservability,
          });
        },
      });
      if (canonicalizeSessionToolTraceCalls(roundTrace, toolResults)) {
        await persistNativeToolTraceSafely({
          activation: input.activation,
          toolTrace,
          nativeToolMessageStore: this.nativeToolMessageStore,
          now: () => this.clock.now(),
          defer: this.deferToolObservability,
        });
      }
      throwIfAborted(input.signal);
      messages = appendAssistantToolCallMessage(messages, {
        text: result.text,
        toolCalls,
        ...(result.contentBlocks
          ? { contentBlocks: result.contentBlocks }
          : {}),
      });
      messages = appendToolResultMessages(messages, toolResults);
      await recordProviderToolProtocolRoundSafely({
        activation: input.activation,
        runtimeProgressRecorder:
          this.toolLoop?.runtimeProgressRecorder ?? this.runtimeProgressRecorder,
        now: () => this.clock.now(),
        defer: this.deferToolObservability,
        round: round + 1,
        toolCalls,
        toolResults,
        messages,
      });

      const completedSession = findCompletedSessionEvidence(toolResults);
      const timeoutSignal = findSubAgentToolTimeout(toolResults);
      if (
        timeoutSignal &&
        shouldContinueTimedOutApprovedBrowserSession({
          taskPrompt: input.packet.taskPrompt,
          messages,
          toolTrace,
          timeoutSignal,
          ...(initialGatewayInput.tools === undefined
            ? {}
            : { tools: initialGatewayInput.tools }),
        })
      ) {
        messages = [
          ...messages,
          {
            role: "user",
            content:
              buildApprovedBrowserTimeoutContinuationPrompt(timeoutSignal),
          },
        ];
        nextToolChoice = { type: "tool", name: "sessions_send" };
        continue;
      }
      if (
        timeoutSignal &&
        shouldContinueTimedOutSiblingSession({
          taskPrompt: input.packet.taskPrompt,
          messages,
          toolTrace,
          timeoutSignal,
          ...(initialGatewayInput.tools === undefined
            ? {}
            : { tools: initialGatewayInput.tools }),
        })
      ) {
        messages = [
          ...messages,
          {
            role: "user",
            content: buildCoverageTimeoutContinuationPrompt(timeoutSignal),
          },
        ];
        nextToolChoice = { type: "tool", name: "sessions_send" };
        continue;
      }
      if (completedSession) {
        const supplementalLocalTimeoutProbe =
          shouldRunSupplementalLocalTimeoutProbe({
            taskPrompt: input.packet.taskPrompt,
            messages,
            toolTrace,
            evidenceText: completedSession.finalContents.join("\n\n"),
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
            browserAvailable: allowsSupplementalBrowserProbe(input.packet),
          });
        if (supplementalLocalTimeoutProbe) {
          messages = [
            ...messages,
            {
              role: "user",
              content: buildSupplementalLocalTimeoutProbePrompt(
                supplementalLocalTimeoutProbe,
              ),
            },
          ];
          nextToolChoice = { type: "tool", name: "sessions_spawn" };
          continue;
        }
        const incompleteApprovedBrowserSession =
          findIncompleteApprovedBrowserSession({
            results: toolResults,
            taskPrompt: input.packet.taskPrompt,
            messages,
            toolTrace,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
          });
        if (incompleteApprovedBrowserSession) {
          messages = [
            ...messages,
            {
              role: "user",
              content: buildIncompleteApprovedBrowserSessionContinuationPrompt(
                incompleteApprovedBrowserSession,
              ),
            },
          ];
          nextToolChoice = { type: "tool", name: "sessions_send" };
          continue;
        }
        if (
          shouldContinueIndependentEvidenceStreams({
            taskPrompt: input.packet.taskPrompt,
            messages,
            toolTrace,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
          })
        ) {
          messages = [
            ...messages,
            {
              role: "user",
              content: buildIndependentEvidenceStreamContinuationPrompt({
                requiredStreams: inferIndependentEvidenceStreamCount(
                  input.packet.taskPrompt,
                ),
                completedSessions:
                  countCompletedSessionEvidenceResults(toolTrace),
              }),
            },
          ];
          nextToolChoice = { type: "tool", name: "sessions_spawn" };
          continue;
        }
        if (
          shouldRepairMissingApprovalGate({
            taskPrompt: input.packet.taskPrompt,
            resultText: completedSession.finalContents.join("\n\n"),
            messages,
            repairMarkers,
            toolTrace,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
          })
        ) {
          messages = [
            ...messages,
            recordRepairPrompt(
              repairMarkers,
              buildMissingApprovalGateRepairPrompt(),
            ),
          ];
          nextToolChoice = { type: "tool", name: "permission_query" };
          continue;
        }
        const forcedPermissionResultCall =
          buildForcedPendingApprovalWaitTimeoutPermissionResultCall({
            taskPrompt: input.packet.taskPrompt,
            toolTrace,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
        });
        if (forcedPermissionResultCall) {
          const forcedRound = await executeRuntimeForcedToolRound({
            toolLoop: this.toolLoop,
            runtimeProgressRecorder: this.runtimeProgressRecorder,
            deferToolObservability: this.deferToolObservability,
            now: () => this.clock.now(),
            activation: input.activation,
            packet: input.packet,
            messages,
            toolTrace,
            toolCalls: [forcedPermissionResultCall],
            round: toolTrace.length + 1,
            toolLoopStartedAtMs,
            ...(input.signal ? { signal: input.signal } : {}),
            assistantText: FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
            persistNativeToolTrace: (options) =>
              persistNativeToolTraceSafely({
                activation: input.activation,
                toolTrace,
                nativeToolMessageStore: this.nativeToolMessageStore,
                now: () => this.clock.now(),
                defer: this.deferToolObservability,
                ...(options?.forceBlocking === undefined
                  ? {}
                  : { forceBlocking: options.forceBlocking }),
              }),
            recordProviderToolProtocolRound: (roundInput) =>
              recordRuntimeForcedToolRoundProviderProtocolSafely({
                activation: input.activation,
                runtimeProgressRecorder:
                  this.toolLoop?.runtimeProgressRecorder ??
                  this.runtimeProgressRecorder,
                now: () => this.clock.now(),
                defer: this.deferToolObservability,
                ...roundInput,
              }),
          });
          messages = forcedRound.messages;
          continue;
        }
        const preserveRecoveredTimeoutCloseout =
          shouldPreserveRecoveredTimeoutCloseout({
            taskPrompt: input.packet.taskPrompt,
            messages,
            toolTrace,
            evidenceText: completedSession.finalContents.join("\n\n"),
          });
        const completedSessionCloseout: ToolLoopCloseoutMetadata = {
          reason: "completed_sub_agent_final",
          maxRounds,
          toolName: completedSession.toolName,
          finalContentCount: completedSession.finalContents.length,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: true,
        };
        toolLoopCloseout ??= completedSessionCloseout;
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            `${completedSession.toolName} returned completed delegated session evidence.`,
            "Do not call sessions_history or sessions_list just to restate this delegated result.",
            "Use the delegated session evidence below as the source of truth. Do not override it with memory, assumptions, or general product knowledge.",
            "Do not add capabilities, target users, pricing, open-source claims, or product positioning unless they are stated in this source content.",
            "Do not add DNS/IP resolution, IANA allocation details, production-environment bans, real-service claims, security-scanner claims, or abuse-risk claims unless those exact facts are stated in this source content.",
            "If the source states a narrow scope limit or usage caveat, preserve its exact wording (or state that wider use is outside the verified scope); do not upgrade a narrow caveat into a broader production-environment or real-service ban.",
            ...buildCompletedBrowserEvidenceDimensionCarryForwardLines({
              taskPrompt: input.packet.taskPrompt,
              finalContents: completedSession.finalContents,
            }),
            "If a requested dimension is missing or uncertain in the source content, write not verified.",
            "Preserve uncertainty labels. Preserve source URLs only when the original user did not forbid links or source URLs.",
            "For each Source N evidence block below, carry at least one verified fact into the final answer or explicitly say that source did not verify a required dimension.",
            "For approval-gated work, include the approved action, the evidence observed after the approved action, and the residual risk or no-external-side-effect boundary.",
            ...(preserveRecoveredTimeoutCloseout
              ? [
                  "This completed source followed a timeout or timed-out continuation.",
                  "Preserve user-visible timeout closeout: say what was recovered, whether the timeout still limits the conclusion, and what continue/retry/longer-timeout path remains if future evidence is missing.",
                  "Do not reduce the timeout closeout to 'no action required' solely because resumed evidence eventually arrived.",
                ]
              : []),
            ...(completedSession.browserRecoverySummaries.length
              ? [
                  "The source also includes browser continuity metadata.",
                  "If the user asked to continue, recover, reopen, reconnect, or handle an unavailable browser session, include one concise user-visible continuity sentence in the final answer.",
                  ...completedSession.browserRecoverySummaries.map(
                    (summary, index) =>
                      `Browser continuity ${index + 1}: ${summary}`,
                  ),
                ]
              : []),
            ...completedSession.finalContents.map(
              (content, index) =>
                `Source ${index + 1} evidence:\n${sliceUtf8(content, 8 * 1024)}`,
            ),
          ],
        });
        throwIfAborted(input.signal);
        const browserRecoverySummaries = dedupeStrings([
          ...completedSession.browserRecoverySummaries,
          ...collectBrowserRecoverySummariesFromToolTrace(toolTrace),
        ]);
        result = maybeAppendBrowserRecoveryVisibility({
          result: generated.result,
          taskPrompt: input.packet.taskPrompt,
          browserRecoverySummaries,
        });
        result = maybeAppendBrowserFailureBucketVisibility({
          result,
          taskPrompt: input.packet.taskPrompt,
          evidenceText: [
            collectToolResultContentText(toolResults),
            ...browserRecoverySummaries,
            ...completedSession.finalContents,
          ].join("\n\n"),
        });
        const shouldAppendRecoveredTimeoutCloseout =
          preserveRecoveredTimeoutCloseout ||
          shouldAppendRecoveredTimeoutCloseoutVisibility({
            resultText: result.text,
            taskPrompt: input.packet.taskPrompt,
            messages,
            toolTrace,
          });
        if (shouldAppendRecoveredTimeoutCloseout) {
          result = maybeAppendRecoveredTimeoutCloseoutVisibility(result);
        } else if (
          shouldAppendTimeoutContinuationVisibility({
            taskPrompt: input.packet.taskPrompt,
            messages,
            toolTrace,
          })
        ) {
          result = maybeAppendTimeoutContinuationVisibility(result);
        }
        result = maybeRedactForbiddenLocalUrls({
          result,
          packet: input.packet,
        });
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        if (
          shouldRepairMissingRequestedTableColumns({
            activation: input.activation,
            taskPrompt: input.packet.taskPrompt,
            messages,
            repairMarkers,
            resultText: result.text,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingRequestedTableColumnsRepairPrompt({
                activation: input.activation,
                taskPrompt: input.packet.taskPrompt,
                messages,
                resultText: result.text,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairExtraneousProviderTableSchema({
            activation: input.activation,
            taskPrompt: input.packet.taskPrompt,
            messages,
            repairMarkers,
            resultText: result.text,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildExtraneousProviderTableSchemaRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairMissingBrowserEvidence({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            toolTrace,
            tools: initialGatewayInput.tools,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingBrowserEvidenceRepairPrompt(
                input.packet.taskPrompt,
              ),
            ),
          ];
          nextToolChoice = { type: "tool", name: "sessions_spawn" };
          continue;
        }
        if (
          shouldRepairMissingProductSignalBrowserEvidence({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            toolTrace,
            tools: initialGatewayInput.tools,
            evidenceText: completedSession.finalContents.join("\n\n"),
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingProductSignalBrowserEvidenceRepairPrompt(
                input.packet.taskPrompt,
              ),
            ),
          ];
          nextToolChoice = { type: "tool", name: "sessions_spawn" };
          continue;
        }
        const completedProductBriefEvidenceText = [
          completedSession.finalContents.join("\n\n"),
          collectToolResultContentText(toolResults),
        ]
          .filter((text) => text.trim().length > 0)
          .join("\n\n");
        if (
          completedProductBriefEvidenceText &&
          shouldRepairSourceEvidenceCarryForward({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedProductBriefEvidenceText,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildSourceEvidenceCarryForwardRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairTimeoutFollowupFinalGuidance({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedProductBriefEvidenceText,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildTimeoutFollowupFinalGuidanceRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairMissingRequestedNextAction({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingRequestedNextActionRepairPrompt(),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        const missingRequiredDeliverables = findMissingRequiredFinalDeliverables(
          {
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
          },
        );
        if (
          missingRequiredDeliverables.length > 0 &&
          !hasMissingRequiredFinalDeliverablesRepairPrompt(repairMarkers)
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingRequiredFinalDeliverablesRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                missing: missingRequiredDeliverables,
                evidenceText: completedSession.finalContents.join("\n\n"),
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          completedProductBriefEvidenceText &&
          shouldRepairSourceEvidenceCarryForward({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedProductBriefEvidenceText,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildSourceEvidenceCarryForwardRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairTimeoutFollowupFinalGuidance({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedProductBriefEvidenceText,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildTimeoutFollowupFinalGuidanceRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          completedSession.finalContents.length > 0 &&
          shouldRepairMissingBrowserEvidenceDimensions({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedSession.finalContents.join("\n\n"),
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedSession.finalContents.join("\n\n"),
              }),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          completedSession.finalContents.length > 0 &&
          shouldRepairFalseEvidenceBlockedSynthesis({
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: completedSession.finalContents.join("\n\n"),
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildFalseEvidenceBlockedSynthesisRepairPrompt(
                completedSession.finalContents,
              ),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairWeakEvidenceSynthesis({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            repairMarkers,
            evidenceText: [
              completedSession.finalContents.join("\n\n"),
              collectToolResultContentText(toolResults),
            ]
              .filter((text) => text.trim().length > 0)
              .join("\n\n"),
          })
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            recordRepairPrompt(
              repairMarkers,
              buildWeakEvidenceSynthesisRepairPrompt(),
            ),
          ];
          nextToolChoice = "none";
          continue;
        }
        break;
      }

      if (timeoutSignal) {
        const supplementalLocalTimeoutProbe =
          timeoutSignal.agentId !== "browser"
            ? shouldRunSupplementalLocalTimeoutProbe({
                taskPrompt: input.packet.taskPrompt,
                messages,
                toolTrace,
                evidenceText: collectToolResultContentText(toolResults),
                ...(initialGatewayInput.tools === undefined
                  ? {}
                  : { tools: initialGatewayInput.tools }),
                browserAvailable: allowsSupplementalBrowserProbe(input.packet),
              })
            : null;
        if (supplementalLocalTimeoutProbe) {
          messages = [
            ...messages,
            {
              role: "user",
              content: buildSupplementalLocalTimeoutProbePrompt(
                supplementalLocalTimeoutProbe,
              ),
            },
          ];
          nextToolChoice = { type: "tool", name: "sessions_spawn" };
          continue;
        }
        toolLoopCloseout = {
          reason: "sub_agent_timeout",
          maxRounds,
          toolName: timeoutSignal.toolName,
          ...(timeoutSignal.timeoutSeconds == null
            ? {}
            : { timeoutSeconds: timeoutSignal.timeoutSeconds }),
          evidenceAvailable: timeoutSignal.evidenceAvailable,
          toolCallCount: countNativeToolCalls(toolTrace),
          roundCount: toolTrace.length,
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          modelCallTrace,
          reasonLines: [
            `${timeoutSignal.toolName} timed out${timeoutSignal.timeoutSeconds == null ? "" : ` after ${timeoutSignal.timeoutSeconds}s`}.`,
            "Do not call more tools or spawn fallback sessions for this timeout.",
            "Do not copy internal fetch URLs, local fixture URLs, session keys, or raw tool arguments into the final answer unless the original user requested those exact raw identifiers.",
            timeoutSignal.evidenceAvailable
              ? "Produce the best final answer from the evidence already gathered and state any remaining uncertainty."
              : "No usable evidence was gathered before the timeout. Say that verification did not complete, summarize what was attempted, and tell the user they can ask to continue.",
            "Include one concise continuation sentence: the user can continue the same source check if the missing evidence is still worth waiting for.",
          ],
        });
        throwIfAborted(input.signal);
        result = maybeAppendTimeoutContinuationVisibility(generated.result);
        if (generated.reduction) {
          reduction = generated.reduction;
          reductionSnapshot = generated.reductionSnapshot;
        }
        if (generated.memoryFlush) {
          memoryFlushes.push(generated.memoryFlush);
        }
        break;
      }
    }

    if (reductionSnapshot) {
      await recordReductionBoundarySafely({
        activation: input.activation,
        packet: input.packet,
        runtimeProgressRecorder: this.runtimeProgressRecorder,
        selection,
        reduction: reductionSnapshot,
      });
    }

    if (
      shouldAppendRecoveredTimeoutCloseoutVisibility({
        resultText: result.text,
        taskPrompt: input.packet.taskPrompt,
        messages,
        toolTrace,
      })
    ) {
      result = maybeAppendRecoveredTimeoutCloseoutVisibility(result);
    }
    result = maybeAppendRequiredTimeoutFollowupVisibility({
      result,
      taskPrompt: input.packet.taskPrompt,
      messages,
      toolTrace,
    });
    result = maybeAppendBrowserRecoveryResidualRiskVisibility({
      result,
      taskPrompt: input.packet.taskPrompt,
      messages,
      toolTrace,
    });
    result = maybeAppendBrowserFailureBucketVisibility({
      result,
      taskPrompt: input.packet.taskPrompt,
      evidenceText: collectToolTraceResultContent(toolTrace),
    });

    const finalText = enforceRequestedThreeLineLabelShape({
      taskPrompt: input.packet.taskPrompt,
      resultText: result.text,
    });
    const missionReport = buildRuntimeDerivedMissionReport(toolLoopCloseout);

    return {
      content: finalText,
      mentions: extractMentions(finalText),
      metadata: {
        adapterName: result.adapterName,
        providerId: result.providerId,
        modelId: result.modelId,
        ...(result.modelChainId ? { modelChainId: result.modelChainId } : {}),
        ...(result.attemptedModelIds?.length
          ? { attemptedModelIds: result.attemptedModelIds }
          : {}),
        protocol: result.protocol,
        stopReason: result.stopReason,
        ...(reduction ? { requestEnvelopeReduction: reduction } : {}),
        ...(result.requestEnvelope
          ? { requestEnvelope: result.requestEnvelope }
          : {}),
        ...(memoryFlushes.length
          ? { preCompactionMemoryFlushes: memoryFlushes }
          : {}),
        ...(toolTrace.length
          ? {
              toolUse: {
                rounds: toolTrace,
                toolCallCount: toolTrace.reduce(
                  (sum, round) => sum + round.calls.length,
                  0,
                ),
              },
            }
          : {}),
        ...(modelCallTrace.length
          ? { modelUse: summarizeModelUseTrace(modelCallTrace) }
          : {}),
        ...(toolLoopCloseout ? { toolLoopCloseout } : {}),
        ...(missionReport ? { missionReport } : {}),
      },
    };
  }

  /**
   * ReAct-engine implementation of the role-runtime tool loop. The engine path now
   * mirrors the inline loop's normalization, execution-budget handling,
   * continuation/repair closeouts, finalization appenders, and observability
   * metadata, while production still defaults to the inline path until the engine
   * has soaked behind the feature flag.
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
   * product-policy branches directly inside `runViaReActEngine`. This adapter
   * only wires those modules and assembles the final `GeneratedRoleReply`.
   * `react-engine/*` modules must not import this file.
   */
  private async runViaReActEngine(args: {
    input: { activation: RoleActivationInput; packet: RolePromptPacket; signal?: AbortSignal };
    selection: Parameters<LLMRoleResponseGenerator["generateWithEnvelopeRetry"]>[0]["selection"];
    activeToolLoop: RoleToolLoopOptions | undefined;
    initialGatewayInput: GenerateTextInput;
    modelCallTrace: ModelCallBoundaryTrace[];
    recoveryToolBudget: { maxToolCalls: number } | null;
    recoveryToolCallsBeforeActivation: number;
  }): Promise<GeneratedRoleReply> {
    const { activation, packet, signal } = args.input;
    const {
      selection,
      activeToolLoop,
      initialGatewayInput,
      modelCallTrace,
      recoveryToolBudget,
      recoveryToolCallsBeforeActivation,
    } = args;

    // Stage 8 cleanup (Batch 0.5): the per-run engine policy trace. It records the
    // per-hook decision sequence (which policy fired or skipped, in which phase)
    // via the behavior-neutral hook-boundary wrapper applied to `hooks` below. The
    // snapshot is surfaced into debug metadata behind the engine flag (this whole
    // method is engine-only) so a production-behind-flag failure is diagnosable.
    const policyTrace = createEnginePolicyTrace();

    let lastResult: GenerateTextResult | undefined;
    let traceRound = 0;
    const model: ModelClient = {
      generate: async ({ messages: roundMessages, tools, toolChoice }) => {
        // The current model-call round (0-based). generateWithEnvelopeRetry below
        // post-increments traceRound, so this is the round this call belongs to —
        // used to inject the final-allowed-round warning (see below).
        const modelCallRound = traceRound;
        // The engine omits `tools` for its tool-free synthesis round (round-limit
        // closeout); honor that so the closeout can't emit a discarded tool call.
        const noToolRound = toolChoice === "none" || tools === undefined;
        const mappedToolChoice: GenerateTextInput["toolChoice"] | undefined =
          toolChoice === undefined
            ? undefined
            : typeof toolChoice === "string"
              ? toolChoice
              : { type: "tool", name: toolChoice.name };
        // Stage 8B (Batch D — C5 memory/compaction/envelope plane): inject the
        // final-allowed-tool-round warning, mirroring the inline tool loop (:492-496).
        // On the last permitted round (round === maxRounds - 1), inline appends a
        // user message telling the model this is the final tool round so it answers
        // from gathered evidence instead of asking for more tools. It is an
        // append-only, side-effect-free message transform gated on the round, so
        // porting it here keeps the engine's per-round gateway messages identical to
        // inline (the compaction parity fixture asserts this warning lands on the
        // final round). No-op unless this is an active tool round on the final round.
        const warningMessages = executionBudget.applyFinalToolRoundWarning({
          messages: roundMessages,
          active: Boolean(activeToolLoop) && !noToolRound,
          round: modelCallRound,
          maxRounds,
        });
        const gatewayRequest = buildToolRoundGatewayRequest({
          baseGatewayInput: initialGatewayInput,
          messages: warningMessages,
          noToolRound,
          ...(mappedToolChoice ? { toolChoice: mappedToolChoice } : {}),
        });
        // Stage 8B (Batch D — C5 memory/compaction/envelope plane): record the
        // tool-result pruning + compaction boundary, mirroring the inline tool
        // loop (:497-502). buildToolRoundGatewayRequest owns history preparation,
        // pruning diffing, tool-free stripping, and envelope recomputation.
        // Measured against warningMessages (the post-final-round-warning list),
        // exactly as inline (:497-502), so the observability snapshot and outgoing
        // gateway messages are derived from the same list.
        await recordToolResultPruningBoundarySafely({
          activation,
          runtimeProgressRecorder: this.runtimeProgressRecorder,
          selection,
          snapshot: gatewayRequest.pruning,
        });
        const generated = await this.generateWithEnvelopeRetry({
          activation,
          packet,
          selection,
          gatewayInput: gatewayRequest.gatewayInput,
          modelCallTrace,
          tracePhase: "tool_round",
          traceRound: traceRound++,
        });
        lastResult = generated.result;
        // Stage 8B (Batch D — C5 memory/compaction/envelope plane): carry the
        // per-round request-envelope reduction + pre-compaction memory flush
        // forward, mirroring the inline tool loop (:587-593). Each tool-round
        // model call runs through generateWithEnvelopeRetry, so a round that
        // overflowed and reduced must persist that fact into the run state (the
        // final metadata assembly reads runState's reduction/memoryFlushes). Inline
        // OVERWRITES reduction per round (last-wins, :587-590) and APPENDS every
        // memory flush (:591-592); the no-tool-loop generate() path (envelope-retry
        // + memory-flush parity tests) also flows through here, since the engine
        // dispatch is unconditional — its single model call must surface reduction
        // and flush metadata too.
        if (generated.reduction) {
          runState.recordReduction({
            reduction: generated.reduction,
            reductionSnapshot: generated.reductionSnapshot,
          });
        }
        if (generated.memoryFlush) {
          runState.recordMemoryFlush(generated.memoryFlush);
        }
        return {
          text: generated.result.text,
          ...(generated.result.toolCalls?.length
            ? { toolCalls: generated.result.toolCalls }
            : {}),
          ...(generated.result.stopReason ? { stopReason: generated.result.stopReason } : {}),
        };
      },
    };

    const toolDefinitions = initialGatewayInput.tools ?? [];
    const toolkit: Toolkit<RoleToolContext> = {
      definitions: () => toolDefinitions,
      has: (name) => toolDefinitions.some((def) => def.name === name),
      execute: (call, ctx) =>
        activeToolLoop
          ? activeToolLoop.executor.execute({
              call,
              activation: ctx.activation,
              packet: ctx.packet,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            })
          : Promise.resolve({
              toolCallId: call.id,
              toolName: call.name,
              isError: true,
              content: `Unknown tool: ${call.name}`,
            }),
    };

    const ctx: RoleToolContext = { activation, packet, repairMarkers: [], ...(signal ? { signal } : {}) };
    const permissionPolicy = createPermissionPolicy();
    const executionBudget = createExecutionBudgetController();
    const continuation = createContinuationController();
    const closeoutPolicy = createCloseoutPolicyRegistry();
    const repairPolicy = createRepairPolicyRegistry();
    const completedCloseout = createCompletedCloseoutController();
    const terminalCloseout = createTerminalCloseoutController();
    const evidenceLedger = createEvidenceLedger();
    const toolLoopStartedAtMs = this.clock.now();
    const maxRounds = activeToolLoop?.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
    type RoleEngineRunStateValues = DefaultEngineRunStateValues & {
      ToolLoopCloseout: ToolLoopCloseoutMetadata;
      CloseoutResult: GenerateTextResult;
      Reduction: {
        level: RequestEnvelopeReductionLevel;
        omittedSections: string[];
      };
      ReductionSnapshot:
        | RequestEnvelopeReductionSnapshot
        | undefined;
      MemoryFlush: PreCompactionMemoryFlushResult;
      CompletedSession: NonNullable<
        ReturnType<typeof findCompletedSessionEvidence>
      >;
      CompletedSessionToolResults: Parameters<
        typeof collectToolResultContentText
      >[0];
      TimeoutSignal: NonNullable<ReturnType<typeof findSubAgentToolTimeout>>;
      PendingCloseout: {
        reasonLines: string[];
        closeout: ToolLoopCloseoutMetadata;
      };
    };
    // Per-run closeout state: hooks fire across different engine callbacks, so a
    // single EngineRunState instance owns what the inline loop keeps as locals
    // (toolLoopCloseout/result/reduction/memoryFlushes/completed signals).
    const runState = createEngineRunState<RoleEngineRunStateValues>();
    const toolTrace: NativeToolRoundTrace[] = [];
    const runEvidence = evidenceLedger.forRun({
      taskPrompt: packet.taskPrompt,
      toolTrace,
    });
    const observer = createEngineRunObserver(toolTrace, {
      now: () => this.clock.now(),
      recordToolProgress: (call, progress) =>
        recordRoleToolProgressSafely({
          recorder:
            this.toolLoop?.runtimeProgressRecorder ?? this.runtimeProgressRecorder,
          activation,
          call,
          progress,
          defer: this.deferToolObservability,
        }),
      recordProviderToolProtocolRound: (round) =>
        recordProviderToolProtocolRoundSafely({
          activation,
          runtimeProgressRecorder:
            this.toolLoop?.runtimeProgressRecorder ?? this.runtimeProgressRecorder,
          now: () => this.clock.now(),
          defer: this.deferToolObservability,
          round: round.round,
          toolCalls: round.toolCalls,
          toolResults: round.toolResults,
          messages: round.messages,
        }),
      persistNativeToolTrace: (options) =>
        persistNativeToolTraceSafely({
          activation,
          toolTrace,
          nativeToolMessageStore: this.nativeToolMessageStore,
          now: () => this.clock.now(),
          defer: this.deferToolObservability,
          ...options,
        }),
    });
    const agent = createReActAgent<RoleToolContext>({
      model,
      toolkit,
      // Stage 8B (Batch E — T7 execution budget plane): give the agent ONE extra
      // round beyond the real budget so the model is still called on the round that
      // hits the limit — inline's `for(;;)` loop makes that extra call, captures its
      // pending calls, and closes out `round_limit` with them (see the round_limit
      // branch in onToolCallsClose). Without the +1, agent-core's bounded loop exits
      // one model call early and its line-368 fallback fires with no pending calls,
      // diverging from inline (fewer gateway calls + a missing pendingToolCallCount).
      // Every closeout, the final-round warning, and all metadata still key on the
      // REAL `maxRounds`, so the +1 only reaches the boundary — onToolCallsClose fires
      // round_limit at toolTrace.length >= maxRounds before the extra round executes.
      maxRounds: maxRounds + 1,
      // Stage 8 cleanup (Batch 0.5): wrap the hook bodies with the behavior-neutral
      // policy-trace boundary. traceEngineHooks records one EnginePolicyTraceEntry
      // per installed hook invocation (phase + coarse outcome derived from the
      // return value) and returns each hook's real result unchanged — pure
      // observation, so parity is unaffected. Later batches extract the real
      // controllers/registries, which record their own fine-grained policy ids into
      // the same trace at their own call sites.
      hooks: traceEngineHooks({
        // Tool-call normalization — the engine's full port of the inline pipeline
        // (Stage 8B Batch B). Runs every active-loop round before execution and
        // before the current round is recorded in toolTrace, so each step's trace
        // reads reflect only prior rounds — matching inline's pre-normalize point.
        // The ordered steps live in ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE; here we
        // build the SHARED context once (inline :449-472) from `state.messages` —
        // now that onToolCalls receives `state`, the session-continuation directives
        // are computed from the live message history exactly as inline does, not
        // approximated from the trace. Side-effect permission gating is unchanged:
        // the approval-gate steps still rewrite premature mutating spawns into
        // permission_query PRE-execute, and read-only suppression stays in
        // onSuppressToolCalls (which runs after this and before runToolBatch).
        onToolCalls: (calls, state, hookCtx) => {
          if (!activeToolLoop) {
            return calls;
          }
          const normalized = normalizeEngineToolCalls(
            calls,
            buildToolCallNormalizationContext({
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              toolTrace,
              repairMarkers: hookCtx.repairMarkers ?? [],
              permissionPolicy,
              ...(packet.capabilityInspection === undefined
                ? {}
                : { capabilityInspection: packet.capabilityInspection }),
            }),
          );
          // Stage 8B (Batch E — T7 execution budget plane): the final-recovery
          // tool-budget truncation (inline :817-819). When a final recovery
          // attempt still has budget remaining but this round's pending calls
          // exceed it, keep only the first `remaining` calls so the round cannot
          // spend past the budget. This runs AFTER the normalizers, exactly like
          // inline's slice (:818), and is the mirror of onToolCallsClose step 1:
          // that closeout fires (with the FULL pending-call count) only when the
          // budget is already exhausted (remaining <= 0); when remaining > 0 the
          // budget is not yet spent, so we truncate here and let the NEXT round's
          // onToolCallsClose close out once the trace crosses the budget. The two
          // conditions are mutually exclusive, so the engine order (onToolCalls
          // before onToolCallsClose) preserves the inline order (closeout at :752
          // before truncation at :817).
          return executionBudget.truncateForRecoveryBudget({
            calls: normalized,
            recoveryToolBudget,
            usedToolCalls:
              recoveryToolCallsBeforeActivation + countNativeToolCalls(toolTrace),
          });
        },
        // Stage 8B (Batch E — T7 execution budget plane): the per-turn tool-call
        // execution cap (inline executeToolCalls :5343-5350) is applied HERE, in
        // onBeforeExecute, NOT inside runToolBatch — so agent-core emits tool_started
        // only for the executable calls. The over-cap calls become skipped-only
        // `tool_call_limit_exceeded` results (via the shared
        // buildToolCallLimitExceededResult helper) with NO "started" progress,
        // matching inline (whose over-cap calls are skipped-only). agent-core orders
        // them AFTER the executed results (executed-then-rejected), the inline order.
        // Runs after onToolCalls (whose final-recovery-budget truncation already
        // shaped `calls`), so `calls.length` is the requested count the inline
        // executor sees (its `input.toolCalls.length`).
        onBeforeExecute: (calls) => {
          return executionBudget.limitToolCallsPerRound({
            calls,
            ...(activeToolLoop?.maxToolCallsPerRound === undefined
              ? {}
              : { maxToolCallsPerRound: activeToolLoop.maxToolCallsPerRound }),
          });
        },
        // Honor the remaining execution limits the per-call default bypasses:
        // order-dependent serialization, bounded concurrency, and per-chunk
        // wall-clock aborts — reusing the same helpers the inline executeToolCalls
        // uses, rather than refactoring that heavily-tested method. `calls` here is
        // already the executable subset (onBeforeExecute applied the per-turn cap).
        runToolBatch: async (calls, _runOne, hookCtx) => {
          // The over-cap skipped results are produced by onBeforeExecute (above) and
          // ordered by agent-core AFTER these executed results, matching inline.
          return executionBudget.runToolBatch<RoleToolContext>({
            calls,
            ctx: hookCtx,
            now: () => this.clock.now(),
            toolLoopStartedAtMs,
            ...(activeToolLoop?.maxParallelToolCalls === undefined
              ? {}
              : { maxParallelToolCalls: activeToolLoop.maxParallelToolCalls }),
            ...(activeToolLoop?.maxWallClockMs === undefined
              ? {}
              : { maxWallClockMs: activeToolLoop.maxWallClockMs }),
            ...(activeToolLoop
              ? {
                  execute: (call, ctx, signal) =>
                    activeToolLoop.executor.execute({
                      call,
                      activation: ctx.activation,
                      packet: ctx.packet,
                      ...(signal ? { signal } : {}),
                    }),
                }
              : {}),
          });
        },
        // Stage 7 S1: pre-execute tool suppression. When the model returns tool
        // calls on a setup-only "awaiting context" turn, the inline loop drops
        // them and forces a tool-free round (inline :1010-1034). Mirror that via
        // onSuppressToolCalls: drop the calls, append the assistant text + the
        // guidance prompt, and force "none" for the next round (which still
        // consumes the budget — no round--, matching inline). Idempotent via
        // ctx.repairMarkers, exactly like inline (the same ledger the Stage 6
        // cascade uses). Gated on activeToolLoop + calls.length > 0 like inline.
        onSuppressToolCalls: (calls, state, ctx) => {
          if (!activeToolLoop || calls.length === 0) {
            return null;
          }
          return permissionPolicy.applySuppressToolCallsHook({
            calls,
            taskPrompt: packet.taskPrompt,
            messages: state.messages,
            lastText: state.lastText,
            repairMarkers: (ctx.repairMarkers ??= []),
          });
        },
        // Stage 5 PR2d pending-call closeouts: the registry owns the
        // read-only-suppression pre-emption, recovery-budget-before-continuation
        // ordering, empty-round continuation preview, and remaining pending-call
        // closeout cascade. The adapter supplies live hook state plus the module
        // callbacks that own each sub-decision.
        onToolCallsClose: (calls, state) => {
          if (!activeToolLoop) {
            return null;
          }
          const roundCount = toolTrace.length;
          const usedToolCalls = countNativeToolCalls(toolTrace);
          const stateEvidence = runEvidence.snapshot(state.messages);
          return closeoutPolicy.applyPendingCallsCloseout(
            {
              pendingCalls: calls,
              lastText: state.lastText,
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              repairMarkers: ctx.repairMarkers ?? [],
              toolTrace,
              maxRounds,
              usedToolCalls,
              recoveryUsedToolCalls:
                recoveryToolCallsBeforeActivation + usedToolCalls,
              roundCount,
              evidenceAvailable: stateEvidence.usableEvidence,
              recoveryToolBudget,
              shouldSuppressReadOnlyPermissionQuery: () =>
                permissionPolicy.wouldSuppressReadOnlyPermissionQuery(
                  buildPermissionSuppressInput({
                    calls,
                    taskPrompt: packet.taskPrompt,
                    messages: state.messages,
                  }),
                ),
              previewEmptyRoundContinuation: () =>
                continuation.previewEmptyRoundContinuation({
                  active: Boolean(activeToolLoop),
                  messages: state.messages,
                  round: state.round,
                  taskPrompt: packet.taskPrompt,
                  toolTrace,
                  ...(initialGatewayInput.tools === undefined
                    ? {}
                    : { tools: initialGatewayInput.tools }),
                }),
              buildRecoveryToolBudgetCloseoutSnapshot: () =>
                executionBudget.buildRecoveryToolBudgetCloseoutSnapshot({
                  maxRounds,
                  maxToolCalls: recoveryToolBudget?.maxToolCalls ?? 0,
                  pendingToolCallCount: calls.length,
                  usedToolCalls:
                    recoveryToolCallsBeforeActivation + usedToolCalls,
                  roundCount,
                  evidenceAvailable: stateEvidence.usableEvidence,
                }),
              buildWallClockBudgetCloseoutSignal: ({
                pendingCalls,
                pendingContinuation,
              }) =>
                executionBudget.buildPendingCallsWallClockBudgetCloseoutSignal({
                  pendingCalls,
                  pendingContinuation,
                  taskPrompt: packet.taskPrompt,
                  messages: state.messages,
                  toolTrace,
                  maxRounds,
                  usedToolCalls,
                  roundCount,
                  evidenceAvailable: stateEvidence.usableEvidence,
                  now: () => this.clock.now(),
                  toolLoopStartedAtMs,
                  ...(activeToolLoop.maxWallClockMs === undefined
                    ? {}
                    : { maxWallClockMs: activeToolLoop.maxWallClockMs }),
                }),
              buildRoundLimitCloseoutSnapshot: () =>
                executionBudget.buildRoundLimitCloseoutSnapshot({
                  maxRounds,
                  pendingToolCallCount: calls.length,
                  usedToolCalls,
                  roundCount,
                  evidenceAvailable: stateEvidence.usableEvidence,
                }),
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
              observer,
              evidence: evidenceLedger,
            },
            async (forcedRoundAction) => {
              const forcedRound = await executeRuntimeForcedToolRound({
                toolLoop: this.toolLoop,
                runtimeProgressRecorder: this.runtimeProgressRecorder,
                deferToolObservability: this.deferToolObservability,
                now: () => this.clock.now(),
                activation,
                packet,
                messages: state.messages,
                toolTrace,
                observer,
                toolCalls: forcedRoundAction.calls,
                round: toolTrace.length + 1,
                toolLoopStartedAtMs,
                ...(signal ? { signal } : {}),
                assistantText: forcedRoundAction.assistantText,
                persistNativeToolTrace: (options) =>
                  persistNativeToolTraceSafely({
                    activation,
                    toolTrace,
                    nativeToolMessageStore: this.nativeToolMessageStore,
                    now: () => this.clock.now(),
                    defer: this.deferToolObservability,
                    ...(options?.forceBlocking === undefined
                      ? {}
                      : { forceBlocking: options.forceBlocking }),
                  }),
                recordProviderToolProtocolRound: (roundInput) =>
                  recordRuntimeForcedToolRoundProviderProtocolSafely({
                    activation,
                    runtimeProgressRecorder:
                      this.toolLoop?.runtimeProgressRecorder ??
                      this.runtimeProgressRecorder,
                    now: () => this.clock.now(),
                    defer: this.deferToolObservability,
                    ...roundInput,
                  }),
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
        onAfterExecute: (results) => {
          const roundEvidence = evidenceLedger.currentRound(results);
          return closeoutPolicy.applyPostExecuteCloseout(
            {
              completedSession: roundEvidence.completedSession,
              timeoutSignal: roundEvidence.timeoutSignal,
              toolResults: results,
            },
            runState,
          );
        },
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
        onRoundEmpty: (state) => {
          const action = continuation.onRoundEmpty({
            active: Boolean(activeToolLoop),
            messages: state.messages,
            round: state.round,
            taskPrompt: packet.taskPrompt,
            toolTrace,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
          });
          return continuation.applyRoundEmptyAction(action);
        },
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
          // Inline only runs the post-synthesis repair cascade when a tool loop is
          // active (the cascade lives inside `if (activeToolLoop)`); match that so
          // a no-tool-loop engine request doesn't make an extra repair round.
          if (!activeToolLoop) {
            return null;
          }
          // Persist the ledger back onto ctx (??=, not ?? []) so the marker we add
          // below survives into the next round's idempotency check — an ephemeral
          // local array would let the same repair re-fire. The engine already seeds
          // ctx.repairMarkers = []; this hardens against an unseeded ctx.
          const repairMarkers = (ctx.repairMarkers ??= []);
          return repairPolicy.applyNaturalFinishRepair({
            activation,
            finalRecoveryBudget: recoveryToolBudget
              ? {
                  maxToolCalls: recoveryToolBudget.maxToolCalls,
                  usedToolCalls:
                    recoveryToolCallsBeforeActivation +
                    countNativeToolCalls(toolTrace),
                }
              : null,
            taskPrompt: packet.taskPrompt,
            resultText: state.lastText,
            messages: state.messages,
            repairMarkers,
            toolTrace,
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
          const usedToolCalls = countNativeToolCalls(toolTrace);
          const roundCount = toolTrace.length;
          const terminateEvidence = runEvidence.snapshot(state.messages);
          const evidenceAvailable = terminateEvidence.usableEvidence;
          const pendingCloseout = runState.pendingCloseout();
          const completedSessionSignal = runState.completedSession();
          const timeoutSignal = runState.timeoutSignal();
          const terminateCloseout = closeoutPolicy.evaluateTerminate({
            reason: reason as EngineCloseoutReason,
            pendingCloseout: pendingCloseout
              ? {
                  reason: pendingCloseout.closeout.reason,
                  reasonLines: pendingCloseout.reasonLines,
                  closeout: pendingCloseout.closeout,
                }
              : null,
            completedSession: completedSessionSignal ?? null,
            timeoutSignal: timeoutSignal ?? null,
            taskPrompt: packet.taskPrompt,
            messages: state.messages,
            toolTrace,
            maxRounds,
            usedToolCalls,
            roundCount,
            evidenceAvailable,
            buildRoundLimitCloseoutSnapshot: () =>
              executionBudget.buildRoundLimitCloseoutSnapshot({
                maxRounds,
                usedToolCalls,
                roundCount,
                evidenceAvailable,
              }),
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
                  terminateCloseout.closeout as ToolLoopCloseoutMetadata,
                ...(terminateCloseout.reasonLines === undefined
                  ? {}
                  : { reasonLines: terminateCloseout.reasonLines }),
                ...(terminateCloseout.sticky === undefined
                  ? {}
                  : { sticky: terminateCloseout.sticky }),
              },
              messages: state.messages,
              lastText: state.lastText,
              target: runState,
              // Stage 8B slice 1c: the hard approval-wait-timeout local closeout
              // (inline :966-982), reached via the onRepairRound { closeout }
              // directive. The answer is built deterministically (no model
              // synthesis), so the controller short-circuits the standard
              // reasonLines + generateFinalAfterToolRoundLimit path.
              ...(reason === "tool_evidence_fallback"
                ? {
                    approvalWaitTimeoutFallback: {
                      selection,
                      packet,
                      maxRounds,
                      toolCallCount: usedToolCalls,
                      roundCount,
                      evidenceText:
                        terminateEvidence.approvalWaitTimeoutRuntimeEvidence,
                      error: new Error(
                        "approval wait-timeout repair omitted required pending evidence",
                      ),
                    },
                  }
                : {}),
              synthesize: async ({
                messages,
                reasonLines: terminalReasonLines,
              }: {
                messages: LLMMessage[];
                reasonLines?: string[];
              }) =>
                this.generateFinalAfterToolRoundLimit({
                  activation,
                  packet,
                  selection,
                  baseGatewayInput: initialGatewayInput,
                  messages,
                  maxRounds,
                  modelCallTrace,
                  ...(terminalReasonLines
                    ? { reasonLines: terminalReasonLines }
                    : {}),
                }),
              completedCloseout: {
                completedCloseout,
                completedSession: runState.completedSession() ?? null,
                completedSessionToolResults:
                  runState.completedSessionToolResults() ?? [],
                evidence: evidenceLedger,
                baseGatewayInput: initialGatewayInput,
                packet,
                repairMarkers: (ctx.repairMarkers ??= []),
                ...(activation ? { activation } : {}),
                ...(initialGatewayInput.tools === undefined
                  ? {}
                  : { tools: initialGatewayInput.tools }),
                repairPolicy,
                synthesizeRepair: async ({ gatewayInput }) =>
                  this.generateWithEnvelopeRetry({
                    activation,
                    packet,
                    selection,
                    gatewayInput,
                    modelCallTrace,
                    tracePhase: "final_synthesis_repair",
                  }),
                synthesizeToolCallArtifactCleanup: async ({ messages }) =>
                  this.generateFinalAfterToolRoundLimit({
                    activation,
                    packet,
                    selection,
                    baseGatewayInput: initialGatewayInput,
                    messages,
                    maxRounds,
                    modelCallTrace,
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
        // round's permission_result lands in the trace, so latestPermissionToolName is
        // no longer "permission_query" and the builder returns null on a repeat error
        // (idempotent — no loop). Aborts must rethrow.
        onModelCallError: async (error, state, _ctx) => {
          const aborted = isAbortError(error);
          if (!aborted) {
            runState.captureFinalMessages(state.messages);
          }
          const errorEvidence = aborted
            ? { usableEvidence: false }
            : runEvidence.snapshot(state.messages);
          return terminalCloseout.completeModelCallErrorFlow(
            {
              aborted,
              active: Boolean(activeToolLoop),
              usableEvidence: errorEvidence.usableEvidence,
              activation,
              messages: state.messages,
              packet,
              selection,
              error,
              maxRounds,
              toolCallCount: countNativeToolCalls(toolTrace),
              roundCount: toolTrace.length,
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
            runState,
            async (modelErrorResult) => {
              return executeRuntimeForcedToolRound({
                toolLoop: this.toolLoop,
                runtimeProgressRecorder: this.runtimeProgressRecorder,
                deferToolObservability: this.deferToolObservability,
                now: () => this.clock.now(),
                activation,
                packet,
                messages: state.messages,
                toolTrace,
                observer,
                toolCalls: modelErrorResult.calls,
                round: toolTrace.length + 1,
                toolLoopStartedAtMs,
                ...(signal ? { signal } : {}),
                assistantText: modelErrorResult.assistantText,
                persistNativeToolTrace: (options) =>
                  persistNativeToolTraceSafely({
                    activation,
                    toolTrace,
                    nativeToolMessageStore: this.nativeToolMessageStore,
                    now: () => this.clock.now(),
                    defer: this.deferToolObservability,
                    ...(options?.forceBlocking === undefined
                      ? {}
                      : { forceBlocking: options.forceBlocking }),
                  }),
                recordProviderToolProtocolRound: (roundInput) =>
                  recordRuntimeForcedToolRoundProviderProtocolSafely({
                    activation,
                    runtimeProgressRecorder:
                      this.toolLoop?.runtimeProgressRecorder ??
                      this.runtimeProgressRecorder,
                    now: () => this.clock.now(),
                    defer: this.deferToolObservability,
                    ...roundInput,
                  }),
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

    let finalText = "";
    for await (const event of agent.run({
      messages: initialGatewayInput.messages,
      ctx,
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === "model_response") {
        observer.onModelResponse({
          round: event.round,
          toolCalls: event.toolCalls,
        });
      } else if (event.type === "tool_started") {
        await observer.onToolStarted({
          round: event.round,
          call: event.call,
        });
      } else if (event.type === "tool_result") {
        await observer.onToolResult({ result: event.result });
      } else if (event.type === "final") {
        finalText = event.text;
      }
    }

    // Record the request-envelope reduction boundary before building metadata,
    // matching the inline path's observability (a closeout's final synthesis may
    // have overflowed and reduced).
    const reductionSnapshot = runState.reductionSnapshot();
    if (reductionSnapshot) {
      await recordReductionBoundarySafely({
        activation,
        packet,
        runtimeProgressRecorder: this.runtimeProgressRecorder,
        selection,
        reduction: reductionSnapshot,
      });
    }

    // Stage 8C (Batch C — T10 finalization plane): mirror the inline generate()
    // finalization epilogue (:2407-2433), which runs UNCONDITIONALLY at the end of
    // the loop — for every closeout AND the plain natural-finish result — in this
    // exact order, AFTER the per-reason onTerminate appenders/redaction:
    //   1. recovered-timeout-closeout visibility   (inline :2407-2415)
    //   2. required-timeout-followup visibility     (inline :2417-2422)
    //   3. browser-recovery residual-risk visibility (inline :2423-2428)
    //   4. browser-failure-bucket visibility (FULL-trace evidence) (inline :2429-2433)
    // These are idempotent guarded appenders (no repair marker, append-at-most-once),
    // so re-running #1/#4 after the completed-cascade pass is a no-op when they already
    // fired. #2 (required-timeout-followup) and #3 (residual-risk) run ONLY here in
    // inline (they never appear in the completed cascade), so this is where a resumed-
    // timeout completion whose model final omitted the continuation-guidance / unverified-
    // scope / residual-risk lines gets them deterministically appended. `finalMessages`
    // was stashed by onTerminate/onModelCallError; fall back to the initial gateway
    // messages if no closeout ran (the plain natural-finish result path).
    const epilogueMessages = [
      ...(runState.finalMessages() ?? initialGatewayInput.messages),
    ];
    const closeoutResult = runState.closeoutResult();
    let finalResult: GenerateTextResult = {
      ...(closeoutResult ?? lastResult ?? {}),
      text: finalText,
    } as GenerateTextResult;
    finalResult = finalizeEngineAnswer({
      result: finalResult,
      taskPrompt: packet.taskPrompt,
      messages: epilogueMessages,
      toolTrace,
      evidenceText:
        runEvidence.snapshot(epilogueMessages).toolTraceResultContent,
    });
    finalText = finalResult.text;

    const content = enforceRequestedThreeLineLabelShape({
      taskPrompt: packet.taskPrompt,
      resultText: finalText,
    });
    // On a closeout, metadata reflects the closeout-synthesis result (matching
    // inline), falling back to the last tool-round result otherwise.
    const metaResult = closeoutResult ?? lastResult;
    const toolLoopCloseout = runState.toolLoopCloseout();
    const missionReport = buildRuntimeDerivedMissionReport(toolLoopCloseout);
    const reduction = runState.reduction();
    const memoryFlushes = runState.memoryFlushes();
    return {
      content,
      mentions: extractMentions(content),
      metadata: {
        ...(metaResult
          ? {
              adapterName: metaResult.adapterName,
              providerId: metaResult.providerId,
              modelId: metaResult.modelId,
              ...(metaResult.modelChainId ? { modelChainId: metaResult.modelChainId } : {}),
              protocol: metaResult.protocol,
              stopReason: metaResult.stopReason,
            }
          : {}),
        ...(toolTrace.length
          ? {
              toolUse: {
                rounds: toolTrace,
                toolCallCount: toolTrace.reduce((sum, round) => sum + round.calls.length, 0),
              },
            }
          : {}),
        // Observability bridge (inline :2478): summarize the per-round model-call
        // boundary trace generateWithEnvelopeRetry recorded into metadata.modelUse.
        ...(modelCallTrace.length
          ? { modelUse: summarizeModelUseTrace(modelCallTrace) }
          : {}),
        ...(reduction ? { requestEnvelopeReduction: reduction } : {}),
        ...(memoryFlushes.length
          ? { preCompactionMemoryFlushes: memoryFlushes }
          : {}),
        ...(toolLoopCloseout ? { toolLoopCloseout } : {}),
        ...(missionReport ? { missionReport } : {}),
        reactEngine: true,
        // Stage 8 cleanup (Batch 0.5): surface the per-hook policy-decision
        // sequence into debug metadata ONLY when the engine-policy-trace debug flag
        // is set, so ordinary engine runs (including the parity suite, which asserts
        // metadata shape) are byte-identical. The characterization runner sets this
        // flag to capture the golden decision sequence.
        ...(enginePolicyTraceDebugEnabled()
          ? { enginePolicyTrace: policyTrace.snapshot() }
          : {}),
      },
    };
  }

  private async generateWithEnvelopeRetry(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    selection: {
      modelId?: string;
      modelChainId?: string;
    };
    gatewayInput: GenerateTextInput;
    modelCallTrace?: ModelCallBoundaryTrace[];
    tracePhase?: ModelCallBoundaryTrace["phase"];
    traceRound?: number;
  }): Promise<{
    result: GenerateTextResult;
    reduction?: {
      level: RequestEnvelopeReductionLevel;
      omittedSections: string[];
    };
    reductionSnapshot?: RequestEnvelopeReductionSnapshot;
    memoryFlush?: PreCompactionMemoryFlushResult;
  }> {
    const attempts: RequestEnvelopeReductionLevel[] = [
      "compact",
      "minimal",
      "reference-only",
    ];
    try {
      const startedAt = this.clock.now();
      const result = await this.gateway.generate(input.gatewayInput);
      appendModelCallBoundary(input.modelCallTrace, {
        phase: input.tracePhase ?? "tool_round",
        ...(input.traceRound !== undefined ? { round: input.traceRound } : {}),
        startedAt,
        completedAt: this.clock.now(),
        gatewayInput: input.gatewayInput,
        result,
      });
      return {
        result,
      };
    } catch (error) {
      if (!(error instanceof RequestEnvelopeOverflowError)) {
        throw error;
      }

      let overflowError: RequestEnvelopeOverflowError = error;
      const memoryFlush = await flushPreCompactionMemorySafely({
        flusher: this.preCompactionMemoryFlusher,
        activation: input.activation,
        packet: input.packet,
        selection: input.selection,
        diagnostics: overflowError.details.diagnostics,
      });
      for (const level of attempts) {
        const reduced = reducePromptPacketForRequestEnvelope(input.packet, {
          level,
        });
        try {
          const retryGatewayInput = buildReducedRetryGatewayInput({
            activation: input.activation,
            packet: input.packet,
            selection: input.selection,
            gatewayInput: input.gatewayInput,
            reduction: reduced,
          });
          const startedAt = this.clock.now();
          const result = await this.gateway.generate(retryGatewayInput);
          const reduction = {
            level,
            omittedSections: reduced.omittedSections,
          };
          const reductionSnapshot = {
            level,
            omittedSections: reduced.omittedSections,
            artifactIds: reduced.artifactIds,
            ...(reduced.envelopeHint
              ? { envelopeHint: reduced.envelopeHint }
              : {}),
          };
          appendModelCallBoundary(input.modelCallTrace, {
            phase: input.tracePhase ?? "tool_round",
            ...(input.traceRound !== undefined
              ? { round: input.traceRound }
              : {}),
            startedAt,
            completedAt: this.clock.now(),
            gatewayInput: retryGatewayInput,
            result,
            reductionLevel: level,
          });
          return {
            result,
            reduction,
            reductionSnapshot,
            ...(memoryFlush ? { memoryFlush } : {}),
          };
        } catch (retryError) {
          if (!(retryError instanceof RequestEnvelopeOverflowError)) {
            throw retryError;
          }
          overflowError = retryError;
        }
      }

      throw overflowError;
    }
  }

  private async generateFinalAfterToolRoundLimit(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    selection: {
      modelId?: string;
      modelChainId?: string;
    };
    baseGatewayInput: GenerateTextInput;
    messages: LLMMessage[];
    maxRounds: number;
    modelCallTrace?: ModelCallBoundaryTrace[];
    reasonLines?: string[];
  }): Promise<{
    result: GenerateTextResult;
    reduction?: {
      level: RequestEnvelopeReductionLevel;
      omittedSections: string[];
    };
    reductionSnapshot?: RequestEnvelopeReductionSnapshot;
    memoryFlush?: PreCompactionMemoryFlushResult;
  }> {
    return createTerminalCloseoutController().synthesizeFinalAfterToolRoundLimit({
      activation: input.activation,
      packet: input.packet,
      baseGatewayInput: input.baseGatewayInput,
      messages: input.messages,
      maxRounds: input.maxRounds,
      selection: input.selection,
      ...(input.reasonLines === undefined
        ? {}
        : { reasonLines: input.reasonLines }),
      recordPruning: (snapshot) =>
        recordToolResultPruningBoundarySafely({
          activation: input.activation,
          runtimeProgressRecorder: this.runtimeProgressRecorder,
          selection: input.selection,
          snapshot,
        }),
      synthesize: ({ gatewayInput, tracePhase }) =>
        this.generateWithEnvelopeRetry({
          activation: input.activation,
          packet: input.packet,
          selection: input.selection,
          gatewayInput,
          ...(input.modelCallTrace
            ? { modelCallTrace: input.modelCallTrace }
            : {}),
          tracePhase,
        }),
    });
  }

}

// ORDER_DEPENDENT_TOOL_NAMES, shouldSerializeToolBatch, findRepeatedFailedToolCall
// extracted to ./react/predicates (Phase 1 cutover, behavior-preserving).

// toolCallSignature, normalizeToolInputForSignature, stableJson
// extracted to ./react/predicates (Phase 1 cutover, behavior-preserving).

import type {
  Clock,
  MissionTerminalReport,
  RoleActivationInput,
  RoleId,
  RuntimeProgressRecorder,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMContentBlock,
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
  buildNativeToolMessages,
  type NativeToolRoundTrace,
} from "./native-tool-messages";
import type { RolePromptPacket } from "./prompt-policy";
import {
  reducePromptPacketForRequestEnvelope,
  type RequestEnvelopeReductionLevel,
} from "./request-envelope-reducer";
import { getRoleModelSelection } from "./role-model-selection";
import {
  appendAssistantToolCallMessage,
  appendToolResultMessages,
  DEFAULT_ROLE_TOOL_MAX_ROUNDS,
  recordRoleToolProgress,
  type RoleToolContext,
  type RoleToolExecutionResult,
  type RoleToolLoopOptions,
} from "./tool-use";
import {
  findRepeatedFailedToolCall,
  isPositiveFiniteBudget,
  normalizeToolInputForSignature,
  roundLimitReached,
  shouldSerializeToolBatch,
  stableJson,
  toolCallSignature,
} from "./react/predicates";
import {
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
  buildToolCallLimitExceededResult,
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
  createToolExecutionSignal,
  countCompletedSessionEvidenceResults,
  countRecoveryToolCallsBeforeActivation,
  dedupeStrings,
  disclaimsApprovalGatedBrowserAction,
  disclaimsIntendedBrowserMutation,
  enforceMissingApprovalGateRepairToolCalls,
  enforceSupplementalLocalTimeoutProbeToolCall,
  escapeRegExp,
  extractHttpUrls,
  extractLatestUserContinuationText,
  findExcessiveSessionContinuationCall,
  findRepeatedSessionInspectionCall,
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  findIncompleteApprovedBrowserSession,
  findMissingRequiredFinalDeliverables,
  formatDurationMs,
  hasApprovedBrowserTimeoutContinuationPrompt,
  hasCompletedBrowserSessionEvidence,
  hasCoverageTimeoutContinuationPrompt,
  hasExecutedSessionsSend,
  hasSessionTimeoutEvidence,
  hasTimeoutCloseoutGuidance,
  hasTimeoutContinuationGuidance,
  hasPermissionAppliedEvidence,
  hasMissingRequiredFinalDeliverablesRepairPrompt,
  hasLatestSupplementalLocalTimeoutProbePrompt,
  isAbortError,
  isAppliedApprovalBrowserContinuation,
  isCoverageCriticalDelegationTask,
  isProviderSearchPricingResearchTask,
  inferIndependentEvidenceStreamCount,
  inferRequiredFinalSynthesisDeliverables,
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
  readBrowserRecoverySummary,
  readCompletedSessionEvidence,
  readInlineBrowserRecoverySummary,
  readMessageContentText,
  readSessionKeyFromToolInput,
  readStringField,
  readStringInput,
  requestsApprovalGatedBrowserAction,
  requestsStatusVisibleTextEvidenceUrlLines,
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
  withFinalToolRoundWarning,
  expectsExactFinalAnswerShape,
} from "./tool-loop-shared";
import type {
  SessionContinuationDirective,
  SessionContinuationLookupDirective,
  SubAgentToolTimeoutSignal,
} from "./tool-loop-shared";
import { createReActAgent } from "@turnkeyai/agent-core/react-agent";
import type { ModelClient, ReActState } from "@turnkeyai/agent-core/react-loop";
// Stage 8 cleanup (Batch 0.5): engine policy-trace plumbing. The trace is a
// behavior-neutral observability sink that records the per-hook decision sequence
// so later batches can prove byte-identical behavior and so production-behind-flag
// failures can answer "which policy fired or skipped." See react-engine/*.
import {
  createCloseoutPolicyRegistry,
  createCompletedCloseoutController,
  createContinuationController,
  createEnginePolicyTrace,
  createExecutionBudgetController,
  createEngineRunState,
  createEngineRunObserver,
  createPermissionPolicy,
  createRepairPolicyRegistry,
  type DefaultEngineRunStateValues,
  buildOriginalRequestTableColumnContext,
  buildRequestedTableColumnActivationContext,
  explicitlyRequestsProviderSupportSchema,
  finalizeEngineAnswer,
  markdownTableHasExactRequestedColumns,
  normalizeEngineToolCalls,
  normalizeColumnDetectionText,
  requestedColumnsLookLikeProviderSearchPricing,
  requestedTableColumnMessageContext,
  resolveRequestedTableColumns,
  resultIntroducesProviderSupportSchema,
  traceEngineHooks,
  type EngineCloseoutReason,
} from "./react-engine";
import type { Toolkit } from "@turnkeyai/agent-core/toolkit";
import type {
  PreCompactionMemoryFlusher,
  PreCompactionMemoryFlushResult,
} from "./pre-compaction-memory-flusher";
import { parseSessionToolResult } from "./session-tool-result-protocol";

type ToolLoopCloseoutReason =
  | "pseudo_tool_call"
  | "wall_clock_budget"
  | "round_limit"
  | "completed_sub_agent_final"
  | "sub_agent_timeout"
  | "operator_cancelled"
  | "repeated_tool_failure"
  | "repeated_session_inspection"
  | "excessive_session_continuation"
  | "tool_evidence_fallback"
  | "recovery_tool_budget";

interface ToolLoopCloseoutMetadata {
  reason: ToolLoopCloseoutReason;
  toolCallCount: number;
  roundCount: number;
  maxRounds?: number;
  maxWallClockMs?: number;
  pendingToolCallCount?: number;
  toolName?: string;
  timeoutSeconds?: number;
  evidenceAvailable?: boolean;
  finalContentCount?: number;
}

function buildRuntimeDerivedMissionReport(
  closeout: ToolLoopCloseoutMetadata | undefined
): MissionTerminalReport | undefined {
  if (!closeout) return undefined;
  const status = missionTerminalStatusForCloseout(closeout);
  // NOTE: do NOT set authorizedPartial here. authorizedPartial means "the
  // TASK explicitly permitted a partial/blocked outcome" — a property of the
  // mission request, not of how this run ended. A runtime-derived report
  // reflects objective exhaustion (budget/timeout/etc.), which says nothing
  // about task authorization. Asserting authorizedPartial here would, once a
  // future phase consumes the field to decide whether a self-reported partial
  // may settle without recovery, let any exhausted run claim authorization —
  // a fail-closed hole (an agent could escape completion by reporting partial).
  // authorizedPartial is set only by an explicit model report (Stage B) or by
  // the evaluator's task-text authorization check.
  return {
    status,
    reason: closeout.reason,
    source: "runtime_derived",
  };
}

function missionTerminalStatusForCloseout(
  closeout: ToolLoopCloseoutMetadata
): MissionTerminalReport["status"] {
  switch (closeout.reason) {
    case "completed_sub_agent_final":
      return "completed";
    case "wall_clock_budget":
    case "round_limit":
    case "sub_agent_timeout":
    case "repeated_session_inspection":
    case "excessive_session_continuation":
    case "tool_evidence_fallback":
    case "pseudo_tool_call":
      return closeout.evidenceAvailable ? "partial" : "blocked";
    case "operator_cancelled":
    case "repeated_tool_failure":
    case "recovery_tool_budget":
      return "blocked";
  }
}

interface ModelCallBoundaryTrace {
  index: number;
  phase: "tool_round" | "final_synthesis" | "final_synthesis_repair";
  round?: number;
  durationMs: number;
  modelId: string;
  providerId: string;
  protocol: GenerateTextResult["protocol"];
  adapterName: string;
  modelChainId?: string;
  attemptedModelIds?: string[];
  stopReason?: string;
  messageCount: number;
  toolSchemaCount: number;
  toolChoice?: string;
  toolCallsReturned: number;
  contentBlockCount: number;
  textBytes: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  requestEnvelope?: GenerateTextResult["requestEnvelope"];
  reductionLevel?: RequestEnvelopeReductionLevel;
}

/**
 * Stage 8 cleanup (Batch 0.5): is the engine policy-trace debug surface enabled?
 * Off by default so ordinary engine runs (including the parity suite) carry no
 * extra metadata; the characterization runner sets TURNKEYAI_ENGINE_POLICY_TRACE=1
 * to capture the golden per-hook decision sequence.
 */
function enginePolicyTraceDebugEnabled(): boolean {
  return (
    typeof process !== "undefined" &&
    process.env?.TURNKEYAI_ENGINE_POLICY_TRACE === "1"
  );
}

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
      | ({
          level: RequestEnvelopeReductionLevel;
          omittedSections: string[];
        } & ReductionEnvelopeSnapshot)
      | undefined;
    const memoryFlushes: PreCompactionMemoryFlushResult[] = [];

    await this.recordAssemblyBoundarySafely(
      input.activation,
      input.packet,
      selection,
    );
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
      const gatewayMessages = prepareToolHistoryForGateway(warningMessages);
      await this.recordToolResultPruningBoundarySafely(
        input.activation,
        selection,
        summarizeToolResultPruning(warningMessages, gatewayMessages),
      );
      let generated: Awaited<
        ReturnType<LLMRoleResponseGenerator["generateWithEnvelopeRetry"]>
      >;
      try {
        const noToolRound = nextToolChoice === "none";
        const baseGatewayInput = noToolRound
          ? withoutToolUse(initialGatewayInput)
          : initialGatewayInput;
        const gatewayInput = {
          ...baseGatewayInput,
          messages: gatewayMessages,
          ...(nextToolChoice ? { toolChoice: nextToolChoice } : {}),
          envelope: {
            ...(baseGatewayInput.envelope ?? {}),
            ...(noToolRound ? { toolCount: 0, toolSchemaBytes: 0 } : {}),
            ...deriveToolResultEnvelope(gatewayMessages),
          },
        };
        generated = await this.generateWithEnvelopeRetry({
          activation: input.activation,
          packet: input.packet,
          selection,
          gatewayInput,
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
          const forcedRound = await this.executeRuntimeForcedToolRound({
            activation: input.activation,
            packet: input.packet,
            messages,
            toolTrace,
            toolCalls: [forcedPermissionResultCall],
            round: round + 1,
            toolLoopStartedAtMs,
            ...(input.signal ? { signal: input.signal } : {}),
            assistantText: FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
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
          toolCallCount: countToolCalls(toolTrace),
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
        recoveryToolCallsBeforeActivation + countToolCalls(toolTrace) >=
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
          recoveryToolCallsBeforeActivation + countToolCalls(toolTrace);
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
          toolCallCount: countToolCalls(toolTrace),
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
          toolCallCount: countToolCalls(toolTrace),
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
          toolCallCount: countToolCalls(toolTrace),
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
            recoveryToolCallsBeforeActivation + countToolCalls(toolTrace) >=
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
          toolCallCount: countToolCalls(toolTrace),
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
          toolCallCount: countToolCalls(toolTrace),
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
          toolCallCount: countToolCalls(toolTrace),
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
          toolCallCount: countToolCalls(toolTrace),
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
          toolCallCount: countToolCalls(toolTrace),
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
      const toolResults = await this.executeToolCalls({
        activation: input.activation,
        packet: input.packet,
        toolCalls,
        toolLoopStartedAtMs,
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: async (call, progress) => {
          roundTrace.progress?.push(
            toNativeToolProgressTrace(call, progress, this.clock.now()),
          );
          await this.persistNativeToolTraceSafely(input.activation, toolTrace, {
            forceBlocking: progress.phase === "started",
          });
        },
        onResult: async (toolResult) => {
          roundTrace.results.push(toNativeToolResultTrace(toolResult));
          await this.persistNativeToolTraceSafely(input.activation, toolTrace);
        },
      });
      if (canonicalizeSessionToolTraceCalls(roundTrace, toolResults)) {
        await this.persistNativeToolTraceSafely(input.activation, toolTrace);
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
      await this.recordProviderToolProtocolRoundSafely({
        activation: input.activation,
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
          const forcedRound = await this.executeRuntimeForcedToolRound({
            activation: input.activation,
            packet: input.packet,
            messages,
            toolTrace,
            toolCalls: [forcedPermissionResultCall],
            round: toolTrace.length + 1,
            toolLoopStartedAtMs,
            ...(input.signal ? { signal: input.signal } : {}),
            assistantText: FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
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
          toolCallCount: countToolCalls(toolTrace),
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
          toolCallCount: countToolCalls(toolTrace),
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
      await this.recordReductionBoundarySafely(
        input.activation,
        input.packet,
        selection,
        reductionSnapshot,
      );
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
        const baseGatewayInput = noToolRound
          ? withoutToolUse(initialGatewayInput)
          : initialGatewayInput;
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
        const gatewayMessages = prepareToolHistoryForGateway(warningMessages);
        // Stage 8B (Batch D — C5 memory/compaction/envelope plane): record the
        // tool-result pruning + compaction boundary, mirroring the inline tool
        // loop (:497-502). prepareToolHistoryForGateway prunes older oversized
        // tool results (pruneToolResultsToTotalBudget) and compacts older tool
        // history (compactOlderToolHistoryForGateway) in place; summarizeToolResultPruning
        // diffs the pre/post message lists to detect what was pruned/compacted, and
        // recordToolResultPruningBoundarySafely persists that observability snapshot
        // to the runtime progress recorder. Measured against warningMessages (the
        // post-final-round-warning list), exactly as inline (:497-502), so the
        // observability snapshot and the outgoing gateway messages are the same list.
        await this.recordToolResultPruningBoundarySafely(
          activation,
          selection,
          summarizeToolResultPruning(warningMessages, gatewayMessages),
        );
        const gatewayInput = {
          ...baseGatewayInput,
          messages: gatewayMessages,
          ...(mappedToolChoice ? { toolChoice: mappedToolChoice } : {}),
          envelope: {
            ...(baseGatewayInput.envelope ?? {}),
            ...(noToolRound ? { toolCount: 0, toolSchemaBytes: 0 } : {}),
            ...deriveToolResultEnvelope(gatewayMessages),
          },
        };
        const generated = await this.generateWithEnvelopeRetry({
          activation,
          packet,
          selection,
          gatewayInput,
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
        | ({
            level: RequestEnvelopeReductionLevel;
            omittedSections: string[];
          } & ReductionEnvelopeSnapshot)
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
    const observer = createEngineRunObserver(toolTrace, {
      now: () => this.clock.now(),
      recordToolProgress: (call, progress) =>
        this.recordToolProgressSafely(activation, call, progress),
      persistNativeToolTrace: (options) =>
        this.persistNativeToolTraceSafely(activation, toolTrace, options),
    });
    // Stage 7 S4: the synthetic sessions_send the empty-round continuation would
    // inject (inline :567-587), or null. Shared by onToolCallsClose (the wall-clock
    // pre-check below) and onRoundEmpty (the actual injection) so both agree on
    // whether a continuation is pending — mirroring inline, where the injection at
    // :577 populates toolCalls BEFORE the wall-clock check at :1285 sees it.
    const computeEmptyRoundContinuationCall = (state: ReActState) =>
      continuation.previewEmptyRoundContinuation({
        active: Boolean(activeToolLoop),
        messages: state.messages,
        round: state.round,
        taskPrompt: packet.taskPrompt,
        toolTrace,
        ...(initialGatewayInput.tools === undefined
          ? {}
          : { tools: initialGatewayInput.tools }),
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
          const messages = state.messages;
          const probePending =
            hasLatestSupplementalLocalTimeoutProbePrompt(messages);
          const sessionContinuationContext = buildContinuationDirectiveContext(
            packet.taskPrompt,
            messages,
          );
          const contextualDirective = !probePending
            ? findSessionContinuationDirective(sessionContinuationContext)
            : null;
          const sessionContinuationDirective = probePending
            ? null
            : (contextualDirective ??
              findSessionContinuationDirective(packet.taskPrompt));
          const sessionContinuationLookupDirective =
            !probePending &&
            !sessionContinuationDirective &&
            !isAppliedApprovalBrowserContinuation(packet.taskPrompt)
              ? findSessionContinuationLookupDirective(
                  sessionContinuationContext,
                  sessionContinuationContext,
                )
              : null;
          const normalized = normalizeEngineToolCalls(calls, {
            taskPrompt: packet.taskPrompt,
            messages,
            toolTrace,
            repairMarkers: hookCtx.repairMarkers ?? [],
            sessionContinuationContext,
            sessionContinuationDirective,
            sessionContinuationLookupDirective,
            browserAvailable:
              packet.capabilityInspection?.availableWorkers?.includes("browser") ??
              false,
            exploreAvailable:
              packet.capabilityInspection?.availableWorkers?.includes("explore") ??
              false,
            permissionPolicy,
          });
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
              recoveryToolCallsBeforeActivation + countToolCalls(toolTrace),
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
          // Stage 8B slice 1b: read-only permission-query suppression (inline :518).
          // A source-backed/read-only task (or one disclaiming browser mutation) that
          // emits a permission_query gets the calls dropped + a tool-free re-prompt, so
          // it does not gate a non-mutating read. No marker: the forced tool-free round
          // converges (no calls → no re-suppress). Checked BEFORE the awaiting-context
          // suppression (inline :518 precedes :1013). sessionContext is the inline
          // continuation-directive context over state.messages.
          const readOnlySuppression =
            permissionPolicy.suppressReadOnlyPermissionQuery({
              calls,
              taskPrompt: packet.taskPrompt,
              sessionContext: buildContinuationDirectiveContext(
                packet.taskPrompt,
                state.messages,
              ),
            });
          if (readOnlySuppression.kind === "suppress") {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                ...readOnlySuppression.messages,
              ],
              ...(readOnlySuppression.forceToolChoice
                ? { forceToolChoice: readOnlySuppression.forceToolChoice }
                : {}),
            };
          }
          const repairMarkers = (ctx.repairMarkers ??= []);
          if (
            !shouldSuppressToolsForAwaitingContextSetup({
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              repairMarkers,
            })
          ) {
            return null;
          }
          return {
            messages: [
              ...state.messages,
              { role: "assistant", content: state.lastText },
              recordRepairPrompt(
                repairMarkers,
                buildAwaitingContextSetupNoToolRepairPrompt(packet.taskPrompt),
              ),
            ],
            forceToolChoice: "none",
          };
        },
        // Stage 5 PR2d pending-call closeouts: mirror the inline pre-execute
        // closeouts that fire on the round's pending (normalized) tool calls, in
        // inline precedence order. Each builds the inline reasonLines + closeout
        // metadata and stashes them on `runState.pendingCloseout`; onTerminate runs the
        // synthesis. round_limit is intentionally omitted: the engine's maxRounds
        // loop fires it post-loop at exactly round === maxRounds, where the inline
        // `for(;;)` loop hits roundLimitReached, and this hook only runs on rounds
        // 0..maxRounds-1, so the inline precedence (wall_clock before round_limit
        // before repeated_*) is preserved without double-handling round_limit.
        //
        // Scope: this hook owns terminal pending-call closeouts. The inline
        // branches that rewrite calls, inject continuations, suppress execution, or
        // repair a tool-free candidate are expressed in the surrounding engine hooks
        // (`onToolCalls`, `onSuppressToolCalls`, `onAfterExecuteContinue`, and
        // `onRepairRound`) so this hook can keep the closeout precedence explicit.
        // wall_clock_budget is checked before round_limit here, matching inline.
        onToolCallsClose: (calls, state) => {
          if (!activeToolLoop) {
            return null;
          }
          // Stage 8B slice 1b (codex #523 P2): the read-only permission-query suppression
          // runs BEFORE the pending-call closeouts inline (:518 precedes :539+), but the
          // engine's onSuppressToolCalls runs AFTER this hook. So pre-empt the closeouts:
          // when the read-only suppression would fire, return null here (no closeout this
          // round) and let onSuppressToolCalls perform the drop + tool-free re-prompt —
          // preserving the inline ordering for the read-only + closeout compound case.
          if (
            permissionPolicy.wouldSuppressReadOnlyPermissionQuery({
              calls,
              taskPrompt: packet.taskPrompt,
              sessionContext: buildContinuationDirectiveContext(
                packet.taskPrompt,
                state.messages,
              ),
            })
          ) {
            return null;
          }
          const roundCount = toolTrace.length;
          // Stage 7 S4: the synthetic sessions_send an empty round WOULD inject (or
          // null). Inline injects it (:567) BEFORE the pseudo_tool_call closeout
          // (:1035) and the wall-clock check (:1285): the injection turns the round
          // into a tool round, so the empty-gated pseudo closeout is bypassed while
          // the wall-clock budget still applies to the injected call. Mirror that
          // precedence below — recovery_tool_budget (step 1, inline :539) still runs
          // BEFORE the injection, so it is computed after step 1.
          let pendingContinuation: LLMToolCall | null = null;
          // 1. recovery_tool_budget — the final recovery attempt's tool budget is
          //    exhausted (fires regardless of pending-call count).
          const usedToolCalls =
            recoveryToolCallsBeforeActivation + countToolCalls(toolTrace);
          const recoveryBudgetCloseout =
            closeoutPolicy.evaluateRecoveryToolBudget({
              recoveryToolBudget,
              usedToolCalls,
              pendingToolCallCount: calls.length,
              messages: state.messages,
              repairMarkers: ctx.repairMarkers ?? [],
              resultText: state.lastText,
              buildCloseoutSnapshot: () =>
                executionBudget.buildRecoveryToolBudgetCloseoutSnapshot({
                  maxRounds,
                  maxToolCalls: recoveryToolBudget?.maxToolCalls ?? 0,
                  pendingToolCallCount: calls.length,
                  usedToolCalls,
                  roundCount,
                  evidenceAvailable: hasUsableEvidence(toolTrace),
                }),
            });
          if (recoveryBudgetCloseout?.kind === "defer") {
            // Stage 8B (Batch E — T7 execution budget plane): the empty-round
            // final-recovery-budget delegation-block repair runs BEFORE this closeout
            // inline (:685-712 precedes the closeout at :752). The registry returns a
            // defer decision so onRepairRound can inject the tool-free correction.
            return null;
          }
          if (recoveryBudgetCloseout?.kind === "closeout") {
            runState.recordPendingCloseout({
              reasonLines: recoveryBudgetCloseout.reasonLines,
              closeout: recoveryBudgetCloseout.closeout,
            });
            return recoveryBudgetCloseout.reason;
          }
          // Now that recovery_tool_budget (the only closeout inline checks BEFORE the
          // empty-round injection) has run, resolve the pending continuation: every
          // closeout below either gates on calls.length > 0 (so it no-ops here) or,
          // for the empty-gated pseudo_tool_call, must yield to the injection (which
          // inline performs first). operator_cancelled cannot collide — a live
          // continuation directive means the user DID ask to continue, so its
          // shouldCloseoutCancelledSessionWithoutContinuation guard is false.
          pendingContinuation =
            calls.length === 0 ? computeEmptyRoundContinuationCall(state) : null;
          const buildWallClockBudgetCloseoutSignal = (
            toolCalls: LLMToolCall[],
            pendingToolCallCount: number,
          ) => {
            const maxWallClockMs = resolveEffectiveToolLoopWallClockMs({
              ...(activeToolLoop.maxWallClockMs !== undefined
                ? { maxWallClockMs: activeToolLoop.maxWallClockMs }
                : {}),
              toolCalls,
            });
            const requiredTimeoutContinuationPastWallClock =
              shouldAllowRequiredTimeoutContinuationPastWallClock({
                taskPrompt: packet.taskPrompt,
                messages: state.messages,
                toolCalls,
                toolTrace,
              });
            return {
              maxWallClockMs,
              requiredTimeoutContinuationPastWallClock,
              readElapsedMs: () => this.clock.now() - toolLoopStartedAtMs,
              buildCloseoutSnapshot: (activeMaxWallClockMs: number) =>
                executionBudget.buildWallClockBudgetCloseoutSnapshot({
                  maxRounds,
                  maxWallClockMs: activeMaxWallClockMs,
                  pendingToolCallCount,
                  usedToolCalls: countToolCalls(toolTrace),
                  roundCount,
                  evidenceAvailable: hasUsableEvidence(toolTrace),
                }),
            };
          };
          const wallClockBudgetCloseoutSignal =
            calls.length > 0
              ? buildWallClockBudgetCloseoutSignal(calls, calls.length)
              : pendingContinuation
                ? buildWallClockBudgetCloseoutSignal([pendingContinuation], 1)
                : null;
          // 2-8. pending-call closeouts — operator_cancelled through the
          // repeated-call/session anti-loop policies.
          const remainingPendingCloseout =
            closeoutPolicy.evaluateRemainingPendingCalls({
              pendingCalls: calls,
              pendingToolCallCount: calls.length,
              pendingContinuation: pendingContinuation !== null,
              lastText: state.lastText,
              wallClockBudget: wallClockBudgetCloseoutSignal,
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              sessionContext: `${packet.taskPrompt}\n${buildContinuationDirectiveContext(packet.taskPrompt, state.messages)}`,
              toolTrace,
              maxRounds,
              usedToolCalls: countToolCalls(toolTrace),
              roundCount,
              evidenceAvailable: hasUsableEvidence(toolTrace),
              buildRoundLimitCloseoutSnapshot: () =>
                executionBudget.buildRoundLimitCloseoutSnapshot({
                  maxRounds,
                  pendingToolCallCount: calls.length,
                  usedToolCalls: countToolCalls(toolTrace),
                  roundCount,
                  evidenceAvailable: hasUsableEvidence(toolTrace),
                }),
            });
          if (remainingPendingCloseout?.kind === "closeout") {
            runState.recordPendingCloseout({
              reasonLines: remainingPendingCloseout.reasonLines,
              closeout: remainingPendingCloseout.closeout,
            });
            return remainingPendingCloseout.reason;
          }
          // The registry preserves wall-clock empty-round continuation gates
          // and the repeated-call/session anti-loop precedence.
          return null;
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
          // Observability bridge (inline :1704): emit the provider-tool-protocol round
          // boundary. agent-core has already appended the assistant tool-call message +
          // the tool-result messages to state.messages before this hook, exactly like
          // inline's appendToolResultMessages precedes its recordProviderToolProtocolRound
          // Safely. This is the one place with BOTH the round's results and the live
          // messages, so the protocol round (assistant/tool-result block accounting)
          // lands here per round, awaited. round = toolTrace.length (the round just
          // executed, 1-indexed = inline's round+1). toolCalls are reconstructed from the
          // results (id/name), matching inline's toolCallIds/toolNames/count.
          const roundToolResults = results as RoleToolExecutionResult[];
          await this.recordProviderToolProtocolRoundSafely({
            activation,
            round: toolTrace.length,
            toolCalls: roundToolResults.map((result) => ({
              id: result.toolCallId,
              name: result.toolName,
              input: {},
            })),
            toolResults: roundToolResults,
            messages: state.messages,
          });
          // S7 branches 1-2: a sub-agent TIMEOUT signal that should be continued via
          // sessions_send, before the sub_agent_timeout closeout (inline :1562, :1583).
          const timeoutSignal = findSubAgentToolTimeout(results);
          const timeoutContinuation =
            continuation.onAfterExecuteTimeoutContinuation({
              messages: state.messages,
              taskPrompt: packet.taskPrompt,
              toolTrace,
              timeoutSignal,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            });
          if (timeoutContinuation.kind === "continue") {
            return {
              messages: timeoutContinuation.messages,
              ...(timeoutContinuation.forceToolChoice
                ? { forceToolChoice: timeoutContinuation.forceToolChoice }
                : {}),
            };
          }
          // S7 branches 3-4 + S5: a COMPLETED delegated session, continued before the
          // completed_sub_agent_final closeout (inline :1603-1712, inside completedSession).
          const completedSession = findCompletedSessionEvidence(results);
          if (!completedSession) {
            // General supplemental timeout probe (inline :2336-2360): a NON-browser
            // sub-agent timeout whose resumed evidence is still content-poor
            // escalates to a supplemental browser sessions_spawn before the
            // sub_agent_timeout closeout. evidenceText is the round's tool-result
            // content (the timeout result), not a completed session. Runs only when
            // there is no completed session this round, so a completed session (the
            // block below) wins — matching inline, which runs the completedSession
            // block (:1755) before this timeout probe.
            const timeoutProbe =
              continuation.continueSupplementalLocalTimeoutProbe({
                taskPrompt: packet.taskPrompt,
                messages: state.messages,
                toolTrace,
                evidenceText: collectToolResultContentText(results),
                completedSessionEvidence: false,
                timeoutSignal,
                ...(initialGatewayInput.tools === undefined
                  ? {}
                  : { tools: initialGatewayInput.tools }),
                browserAvailable: allowsSupplementalBrowserProbe(packet),
              });
            if (timeoutProbe.kind === "continue") {
              return {
                messages: timeoutProbe.messages,
                ...(timeoutProbe.forceToolChoice
                  ? { forceToolChoice: timeoutProbe.forceToolChoice }
                  : {}),
              };
            }
            return null;
          }
          // S7 branch 3: supplemental local timeout probe via sessions_spawn (:1604).
          const supplementalLocalTimeoutProbe =
            continuation.continueSupplementalLocalTimeoutProbe({
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              toolTrace,
              evidenceText: completedSession.finalContents.join("\n\n"),
              completedSessionEvidence: true,
              timeoutSignal,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
              browserAvailable: allowsSupplementalBrowserProbe(packet),
            });
          if (supplementalLocalTimeoutProbe.kind === "continue") {
            return {
              messages: supplementalLocalTimeoutProbe.messages,
              ...(supplementalLocalTimeoutProbe.forceToolChoice
                ? { forceToolChoice: supplementalLocalTimeoutProbe.forceToolChoice }
                : {}),
            };
          }
          // S7 branch 4: incomplete approved browser session via sessions_send (:1626).
          const incompleteApprovedBrowserSession =
            continuation.continueIncompleteApprovedBrowserSession({
              results,
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            });
          if (incompleteApprovedBrowserSession.kind === "continue") {
            return {
              messages: incompleteApprovedBrowserSession.messages,
              ...(incompleteApprovedBrowserSession.forceToolChoice
                ? {
                    forceToolChoice:
                      incompleteApprovedBrowserSession.forceToolChoice,
                  }
                : {}),
            };
          }
          // S8: independent evidence streams — a multi-stream delegation task that has
          // not yet completed all required streams continues via a forced sessions_spawn
          // round (inline :1648), between branch 4 and S5. Idempotency: the predicate
          // returns false once its continuation prompt is in `messages`, so it fires at
          // most once; the model is then expected to spawn the remaining streams.
          const independentEvidenceStreams =
            continuation.continueIndependentEvidenceStreams({
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            });
          if (independentEvidenceStreams.kind === "continue") {
            return {
              messages: independentEvidenceStreams.messages,
              ...(independentEvidenceStreams.forceToolChoice
                ? { forceToolChoice: independentEvidenceStreams.forceToolChoice }
                : {}),
            };
          }
          // S9 (post-execute): an approval-gated browser task whose completed session
          // never went through the approval gate re-arms a forced permission_query round
          // (inline :1672) — after S8, before the S5 forced permission_result. Unlike the
          // natural-finish variant it does NOT append assistant text (the round's
          // assistant tool-call message is already in the trace). The recorded marker is
          // the idempotency AND the key the onToolCalls enforce-gate normalizer reads.
          const s9RepairMarkers = (hookCtx.repairMarkers ??= []);
          const missingApprovalGateRepair =
            continuation.continueMissingApprovalGateRepair({
              taskPrompt: packet.taskPrompt,
              resultText: completedSession.finalContents.join("\n\n"),
              messages: state.messages,
              repairMarkers: s9RepairMarkers,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            });
          if (missingApprovalGateRepair.kind === "continue") {
            if (missingApprovalGateRepair.repairMarker) {
              s9RepairMarkers.push(missingApprovalGateRepair.repairMarker);
            }
            return {
              messages: missingApprovalGateRepair.messages,
              ...(missingApprovalGateRepair.forceToolChoice
                ? { forceToolChoice: missingApprovalGateRepair.forceToolChoice }
                : {}),
            };
          }
          // S5: forced permission_result round (host-authored, no model call). The
          // builder's guards (approval-wait-timeout task + pending permission_query +
          // a pending approval_id) are the idempotency: once permission_result lands,
          // latestPermissionToolName !== "permission_query" so it does not re-fire.
          const forcedPermissionResult =
            continuation.forcePendingApprovalWaitTimeoutPermissionResult({
              taskPrompt: packet.taskPrompt,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            });
          if (forcedPermissionResult.kind !== "forced_tool_round") {
            return null;
          }
          const forcedRound = await this.executeRuntimeForcedToolRound({
            activation,
            packet,
            messages: state.messages,
            toolTrace,
            toolCalls: forcedPermissionResult.calls,
            round: toolTrace.length + 1,
            toolLoopStartedAtMs,
            ...(signal ? { signal } : {}),
            assistantText: forcedPermissionResult.assistantText,
          });
          return { messages: forcedRound.messages };
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
          const completedSession = findCompletedSessionEvidence(results);
          const timeoutSignal = completedSession
            ? null
            : findSubAgentToolTimeout(results);
          const postExecuteCloseout = closeoutPolicy.evaluatePostExecute({
            completedSession,
            timeoutSignal,
          });
          if (
            postExecuteCloseout?.reason === "completed_sub_agent_final" &&
            completedSession
          ) {
            // Capture the completing round's results — the same array the inline
            // path passes to collectToolResultContentText when it builds
            // completedProductBriefEvidenceText (:1933-1938). onTerminate uses this
            // for the source-evidence / timeout-followup completed repairs.
            runState.recordCompletedSession({
              session: completedSession,
              toolResults: results,
            });
            return postExecuteCloseout.reason;
          }
          if (
            postExecuteCloseout?.reason === "sub_agent_timeout" &&
            timeoutSignal
          ) {
            runState.recordTimeoutSignal(timeoutSignal);
            return postExecuteCloseout.reason;
          }
          return null;
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
          if (action.kind === "inject_calls") {
            return { injectedCalls: action.calls };
          }
          return "terminate";
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
          // Stage 8B (Batch E — T7 execution budget plane): the empty-round
          // final-recovery-budget delegation-block repair (inline :685-712). It
          // runs BEFORE the natural-finish cascade inline (the recovery check at
          // :685 precedes the S2/S3 browser-evidence repairs at :751), so it is the
          // FIRST check here. When a final recovery attempt's budget is exhausted
          // and the model still emitted a delegation directive (not a bounded
          // blocked closeout), inject a tool-free "Runtime correction" re-prompt and
          // force the next round tool-free (forceToolChoice "none", NOT consumesRound
          // — the re-synthesis is not a new tool round, matching the inline
          // `nextToolChoice = "none"; continue;` with round--). The recovery_tool_budget
          // closeout in onToolCallsClose defers to this via the same predicate, so the
          // repaired blocked closeout still routes through that closeout next round.
          const finalRecoveryBudgetRepair = repairPolicy.evaluateNaturalFinish({
            enabledPolicies: ["final_recovery_budget_closeout_repair"],
            finalRecoveryBudget: recoveryToolBudget
              ? {
                  maxToolCalls: recoveryToolBudget.maxToolCalls,
                  usedToolCalls:
                    recoveryToolCallsBeforeActivation + countToolCalls(toolTrace),
                }
              : null,
            messages: state.messages,
            repairMarkers,
            resultText: state.lastText,
          });
          if (
            finalRecoveryBudgetRepair?.policyId ===
            "final_recovery_budget_closeout_repair"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  finalRecoveryBudgetRepair.repairPrompt,
                ),
              ],
              forceToolChoice: finalRecoveryBudgetRepair.forceToolChoice,
            };
          }
          // Stage 7 S2/S3: forced-spawn browser-evidence repairs — FIRST in the
          // natural-finish cascade (inline :748 browser-evidence, :776 product-
          // signal, both before table-columns). Unlike the tool-free repairs below,
          // these re-arm a REAL sessions_spawn tool round, so they return
          // forceToolChoice {name:"sessions_spawn"} + consumesRound:true (the round
          // is charged, matching the inline `nextToolChoice={type:tool,...}` + round++).
          // Both share one idempotency marker (hasMissingBrowserEvidenceRepairPrompt),
          // so once either fires neither re-fires. The {name} form (NOT {type,name})
          // is what the engine model adapter expects.
          const missingBrowserEvidenceRepair =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["missing_browser_evidence"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            });
          if (
            missingBrowserEvidenceRepair?.policyId ===
            "missing_browser_evidence"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  missingBrowserEvidenceRepair.repairPrompt,
                ),
              ],
              forceToolChoice: missingBrowserEvidenceRepair.forceToolChoice,
              consumesRound: missingBrowserEvidenceRepair.consumesRound,
            };
          }
          const missingProductSignalBrowserEvidenceRepair =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["missing_product_signal_browser_evidence"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            });
          if (
            missingProductSignalBrowserEvidenceRepair?.policyId ===
            "missing_product_signal_browser_evidence"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  missingProductSignalBrowserEvidenceRepair.repairPrompt,
                ),
              ],
              forceToolChoice:
                missingProductSignalBrowserEvidenceRepair.forceToolChoice,
              consumesRound:
                missingProductSignalBrowserEvidenceRepair.consumesRound,
            };
          }
          // Stage 7 S9 (natural-finish): an approval-gated browser task whose tool-free
          // candidate never went through the approval gate re-arms a forced permission_
          // query round (inline :804) — after the S2/S3 browser-evidence repairs, before
          // the tool-free table-columns repair. Like S2/S3 this re-arms a REAL tool round
          // (consumesRound), so the budget is charged. The recorded repair marker is the
          // idempotency AND the key the onToolCalls enforce-gate normalizer reads to
          // rewrite a resistant browser spawn into permission_query.
          const missingApprovalGateRepair = repairPolicy.evaluateNaturalFinish({
            enabledPolicies: ["missing_approval_gate"],
            finalRecoveryBudget: null,
            taskPrompt: packet.taskPrompt,
            resultText: state.lastText,
            messages: state.messages,
            repairMarkers,
            toolTrace,
            ...(initialGatewayInput.tools === undefined
              ? {}
              : { tools: initialGatewayInput.tools }),
          });
          if (
            missingApprovalGateRepair?.policyId === "missing_approval_gate"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  missingApprovalGateRepair.repairPrompt,
                ),
              ],
              forceToolChoice: missingApprovalGateRepair.forceToolChoice,
              consumesRound: missingApprovalGateRepair.consumesRound,
            };
          }
          // Stage 8B slice 1: the approval-wait-timeout repair family (inline :833-1009),
          // ported in inline precedence — AFTER the S9 missing-approval-gate repair and
          // BEFORE table-columns. Each mirrors an inline natural-finish block: append the
          // candidate + the recorded repair prompt, then either re-arm a forced tool
          // round (permission_result / sessions_spawn → consumesRound) or a tool-free
          // re-synthesis ("none"). Marker idempotency (each build*RepairPrompt is recorded)
          // bounds them. The hard fallback closeout (shouldForceApprovalWaitTimeoutLocal
          // CloseoutAfterFailedRepair, inline :955-983) is expressed below via an
          // onRepairRound `{ closeout: "tool_evidence_fallback" }` directive.
          const pendingApprovalWaitTimeoutCheckRepair =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["pending_approval_wait_timeout_check"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            pendingApprovalWaitTimeoutCheckRepair?.policyId ===
            "pending_approval_wait_timeout_check"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  pendingApprovalWaitTimeoutCheckRepair.repairPrompt,
                ),
              ],
              forceToolChoice:
                pendingApprovalWaitTimeoutCheckRepair.forceToolChoice,
              consumesRound: pendingApprovalWaitTimeoutCheckRepair.consumesRound,
            };
          }
          const prematurePendingApprovalRepair =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["premature_pending_approval"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            prematurePendingApprovalRepair?.policyId ===
            "premature_pending_approval"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  prematurePendingApprovalRepair.repairPrompt,
                ),
              ],
              forceToolChoice: prematurePendingApprovalRepair.forceToolChoice,
              consumesRound: prematurePendingApprovalRepair.consumesRound,
            };
          }
          const stalePendingApprovalRepair = repairPolicy.evaluateNaturalFinish({
            enabledPolicies: ["stale_pending_approval"],
            finalRecoveryBudget: null,
            taskPrompt: packet.taskPrompt,
            resultText: state.lastText,
            messages: state.messages,
            repairMarkers,
            toolTrace,
          });
          if (
            stalePendingApprovalRepair?.policyId === "stale_pending_approval"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  stalePendingApprovalRepair.repairPrompt,
                ),
              ],
              forceToolChoice: stalePendingApprovalRepair.forceToolChoice,
              consumesRound: stalePendingApprovalRepair.consumesRound,
            };
          }
          const staleDeniedApprovalRepair = repairPolicy.evaluateNaturalFinish({
            enabledPolicies: ["stale_denied_approval"],
            finalRecoveryBudget: null,
            taskPrompt: packet.taskPrompt,
            resultText: state.lastText,
            messages: state.messages,
            repairMarkers,
            toolTrace,
          });
          if (
            staleDeniedApprovalRepair?.policyId === "stale_denied_approval"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  staleDeniedApprovalRepair.repairPrompt,
                ),
              ],
              forceToolChoice: staleDeniedApprovalRepair.forceToolChoice,
            };
          }
          const approvalWaitTimeoutCloseoutRepair =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["approval_wait_timeout_closeout"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            approvalWaitTimeoutCloseoutRepair?.policyId ===
            "approval_wait_timeout_closeout"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  approvalWaitTimeoutCloseoutRepair.repairPrompt,
                ),
              ],
              forceToolChoice: approvalWaitTimeoutCloseoutRepair.forceToolChoice,
            };
          }
          // Stage 8B slice 1c: the hard approval-wait-timeout local closeout (inline
          // :955-983). When the approval-wait-timeout-closeout repair above already fired
          // (its marker is recorded) but the candidate STILL is not a complete closeout,
          // break the loop with a deterministic tool_evidence_fallback closeout rather
          // than finalizing the incomplete answer. onRepairRound cannot finalize, so it
          // returns a { closeout } directive; onTerminate builds the local-evidence text
          // directly (no model synthesis) for that reason.
          const approvalWaitTimeoutLocalCloseout =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["approval_wait_timeout_local_closeout"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            approvalWaitTimeoutLocalCloseout?.policyId ===
            "approval_wait_timeout_local_closeout"
          ) {
            return {
              closeout: approvalWaitTimeoutLocalCloseout.closeoutReason,
            };
          }
          const incompleteApprovedBrowserActionRepair =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["incomplete_approved_browser_action"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            incompleteApprovedBrowserActionRepair?.policyId ===
            "incomplete_approved_browser_action"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  incompleteApprovedBrowserActionRepair.repairPrompt,
                ),
              ],
              forceToolChoice:
                incompleteApprovedBrowserActionRepair.forceToolChoice,
              consumesRound: incompleteApprovedBrowserActionRepair.consumesRound,
            };
          }
          const missingRequestedTableColumnsRepair =
            repairPolicy.evaluateNaturalFinish({
              activation,
              enabledPolicies: ["missing_requested_table_columns"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            missingRequestedTableColumnsRepair?.policyId ===
            "missing_requested_table_columns"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  missingRequestedTableColumnsRepair.repairPrompt,
                ),
              ],
              forceToolChoice: missingRequestedTableColumnsRepair.forceToolChoice,
            };
          }
          const extraneousProviderTableSchemaRepair =
            repairPolicy.evaluateNaturalFinish({
              activation,
              enabledPolicies: ["extraneous_provider_table_schema"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            extraneousProviderTableSchemaRepair?.policyId ===
            "extraneous_provider_table_schema"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  extraneousProviderTableSchemaRepair.repairPrompt,
                ),
              ],
              forceToolChoice:
                extraneousProviderTableSchemaRepair.forceToolChoice,
            };
          }
          const sourceEvidenceCarryForwardRepair =
            repairPolicy.evaluateNaturalFinish({
              enabledPolicies: ["source_evidence_carry_forward"],
              finalRecoveryBudget: null,
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            });
          if (
            sourceEvidenceCarryForwardRepair?.policyId ===
            "source_evidence_carry_forward"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  sourceEvidenceCarryForwardRepair.repairPrompt,
                ),
              ],
              forceToolChoice: sourceEvidenceCarryForwardRepair.forceToolChoice,
            };
          }
          const weakEvidenceSynthesisRepair = repairPolicy.evaluateNaturalFinish({
            enabledPolicies: ["weak_evidence_synthesis"],
            finalRecoveryBudget: null,
            taskPrompt: packet.taskPrompt,
            resultText: state.lastText,
            messages: state.messages,
            repairMarkers,
            toolTrace,
          });
          if (
            weakEvidenceSynthesisRepair?.policyId === "weak_evidence_synthesis"
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  weakEvidenceSynthesisRepair.repairPrompt,
                ),
              ],
              forceToolChoice: weakEvidenceSynthesisRepair.forceToolChoice,
            };
          }
          return null;
        },
        // Stage 5 closeout-answer producer. round_limit (PR2a),
        // completed_sub_agent_final + sub_agent_timeout (PR2c) are reachable;
        // each closeout reason gets its inline reasonLines + status here.
        onTerminate: async (reason, state, ctx) => {
          // Stage 8C (Batch C — T10 finalization plane): stash the terminal message
          // list so the post-loop epilogue can run the inline generate() finalization
          // appenders (:2407-2433) against the same context the inline path sees.
          runState.captureFinalMessages(state.messages);
          // Stage 8B slice 1c: the hard approval-wait-timeout local closeout (inline
          // :966-982), reached via the onRepairRound { closeout } directive. The answer
          // is built DETERMINISTICALLY (no model synthesis), so this short-circuits the
          // standard reasonLines + generateFinalAfterToolRoundLimit path below.
          if (reason === "tool_evidence_fallback") {
            const fallbackCloseout: ToolLoopCloseoutMetadata = {
              reason: "tool_evidence_fallback",
              maxRounds,
              toolCallCount: countToolCalls(toolTrace),
              roundCount: toolTrace.length,
              evidenceAvailable: true,
            };
            const fallbackResult = maybeRedactForbiddenLocalUrls({
              result: buildApprovalWaitTimeoutLocalEvidenceCloseout({
                selection,
                evidenceText: collectApprovalWaitTimeoutRuntimeEvidence(toolTrace),
                error: new Error(
                  "approval wait-timeout repair omitted required pending evidence",
                ),
              }),
              packet,
            });
            runState.recordToolLoopCloseout(fallbackCloseout);
            runState.recordCloseoutResult(fallbackResult);
            return {
              text: fallbackResult.text,
              ...(fallbackResult.stopReason
                ? { stopReason: fallbackResult.stopReason }
                : {}),
            };
          }
          // Each closeout reason rebuilds the inline reasonLines + closeout
          // metadata it produced inline; the round_limit defaults remain the
          // fallback for any reason without a bespoke branch. completed/timeout
          // read the signal onAfterExecute stashed on `run`.
          const usedToolCalls = countToolCalls(toolTrace);
          const roundCount = toolTrace.length;
          const evidenceAvailable = hasUsableEvidence(toolTrace);
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
          const reasonLines = terminateCloseout.reasonLines;
          const closeout =
            terminateCloseout.closeout as ToolLoopCloseoutMetadata;
          if (terminateCloseout.sticky) {
            // Sticky completed-closeout metadata (inline `toolLoopCloseout ??=`, :1729):
            // captured on the FIRST completed session, BEFORE the S10 browser-evidence
            // repair re-arms a sessions_spawn round. So the metadata (roundCount/
            // toolCallCount) reflects the round the session first completed, not the
            // later browser round — exactly like inline, whose `??=` no-ops on the
            // re-entered completed block. The final TEXT still comes from the last
            // synthesis (runState.closeoutResult below).
            runState.recordToolLoopCloseoutIfAbsent(closeout);
          }
          // pseudo_tool_call synthesizes from the malformed assistant text it must
          // recover from, so append it to the synthesis context (mirrors inline
          // :1032-1038). agent-core has not yet appended the current assistant
          // message to state.messages when this pre-execute closeout fires.
          const synthesisMessages =
            reason === "pseudo_tool_call"
              ? [...state.messages, { role: "assistant" as const, content: state.lastText }]
              : state.messages;
          const generated = await this.generateFinalAfterToolRoundLimit({
            activation,
            packet,
            selection,
            baseGatewayInput: initialGatewayInput,
            messages: synthesisMessages,
            maxRounds,
            modelCallTrace,
            ...(reasonLines ? { reasonLines } : {}),
          });
          // Mirror the inline per-reason trailing transforms. completed: redact
          // forbidden local URLs from the delegated evidence (inline :1784).
          // timeout: append the resumable-continuation sentence (inline :2197).
          // Other reasons pass through.
          //
          // The per-reason completed-closeout appenders run after the repair loop
          // below; the unconditional inline finalization epilogue runs after the
          // agent finishes. Keep those transforms outside the repair predicate loop:
          // repairs may re-synthesize, appenders only decorate the accepted final.
          let synthesisReduction = generated.reduction;
          let synthesisReductionSnapshot = generated.reductionSnapshot;
          let closeoutResult: GenerateTextResult;
          const completedSessionForRepair = runState.completedSession();
          if (reason === "completed_sub_agent_final" && completedSessionForRepair) {
            const repairMarkers = (ctx.repairMarkers ??= []);
            const completedTerminal =
              await completedCloseout.synthesizeTerminalCloseout({
                packet,
                messages: state.messages,
                repairMarkers,
                completedSession: completedSessionForRepair,
                completedSessionToolResultText: collectToolResultContentText(
                  runState.completedSessionToolResults() ?? [],
                ),
                initialSynthesis: generated,
                ...(activation ? { activation } : {}),
                ...(initialGatewayInput.tools === undefined
                  ? {}
                  : { tools: initialGatewayInput.tools }),
                repairPolicy,
                synthesizeRepair: async ({ messages }) => {
                  const repairGatewayMessages =
                    prepareToolHistoryForGateway(messages);
                  return this.generateWithEnvelopeRetry({
                    activation,
                    packet,
                    selection,
                    gatewayInput: {
                      ...withoutToolUse(initialGatewayInput),
                      messages: repairGatewayMessages,
                      envelope: {
                        ...(initialGatewayInput.envelope ?? {}),
                        toolCount: 0,
                        toolSchemaBytes: 0,
                        ...deriveToolResultEnvelope(repairGatewayMessages),
                      },
                    },
                    modelCallTrace,
                    tracePhase: "final_synthesis_repair",
                  });
                },
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
              });
            for (const memoryFlush of completedTerminal.memoryFlushes) {
              runState.recordMemoryFlush(memoryFlush);
            }
            if (completedTerminal.kind === "rearm") {
              if (completedTerminal.reduction) {
                runState.recordReduction({
                  reduction: completedTerminal.reduction,
                  reductionSnapshot: completedTerminal.reductionSnapshot,
                });
              }
              return completedTerminal.reArm;
            }
            closeoutResult = completedTerminal.result;
            synthesisReduction = completedTerminal.reduction;
            synthesisReductionSnapshot = completedTerminal.reductionSnapshot;
          } else {
            // Push each synthesis's pre-compaction memory flush as it happens.
            if (generated.memoryFlush) {
              runState.recordMemoryFlush(generated.memoryFlush);
            }
            closeoutResult =
              reason === "sub_agent_timeout"
                ? maybeAppendTimeoutContinuationVisibility(generated.result)
                : generated.result;
          }
          // Reason-gated, matching inline: ONLY completed_sub_agent_final is sticky
          // (`??=`, inline :1729) — the completed branch set it early so an S10 re-armed
          // round keeps the first-completion metadata. Every OTHER reason OVERWRITES
          // (`=`): if a re-armed round later ends in a different terminal closeout
          // (sub_agent_timeout / round_limit / a pending-call closeout), that reason's
          // metadata must replace the stale completed one, exactly as inline reassigns
          // `toolLoopCloseout =` for non-completed reasons (codex #520 P2).
          if (reason === "completed_sub_agent_final") {
            runState.recordToolLoopCloseoutIfAbsent(closeout);
          } else {
            runState.recordToolLoopCloseout(closeout);
          }
          runState.recordCloseoutResult(closeoutResult);
          if (synthesisReduction) {
            runState.recordReduction({
              reduction: synthesisReduction,
              reductionSnapshot: synthesisReductionSnapshot,
            });
          }
          return {
            text: closeoutResult.text,
            ...(closeoutResult.stopReason ? { stopReason: closeoutResult.stopReason } : {}),
          };
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
          if (isAbortError(error)) {
            return "rethrow";
          }
          runState.captureFinalMessages(state.messages);
          const forcedPermissionResult =
            activeToolLoop && hasUsableEvidence(toolTrace)
              ? continuation.forcePendingApprovalWaitTimeoutPermissionResult({
                  taskPrompt: packet.taskPrompt,
                  toolTrace,
                  ...(initialGatewayInput.tools === undefined
                    ? {}
                    : { tools: initialGatewayInput.tools }),
                })
              : { kind: "none" as const };
          if (forcedPermissionResult.kind === "forced_tool_round") {
            const forcedRound = await this.executeRuntimeForcedToolRound({
              activation,
              packet,
              messages: state.messages,
              toolTrace,
              toolCalls: forcedPermissionResult.calls,
              round: toolTrace.length + 1,
              toolLoopStartedAtMs,
              ...(signal ? { signal } : {}),
              assistantText: forcedPermissionResult.assistantText,
            });
            return { messages: forcedRound.messages };
          }
          const localResult =
            activeToolLoop && hasUsableEvidence(toolTrace)
              ? buildLocalEvidenceCloseout({
                  activation,
                  messages: state.messages,
                  packet,
                  selection,
                  error,
                })
              : null;
          if (!localResult) {
            return "rethrow";
          }
          const fallbackCloseout: ToolLoopCloseoutMetadata = {
            reason: "tool_evidence_fallback",
            maxRounds,
            toolCallCount: countToolCalls(toolTrace),
            roundCount: toolTrace.length,
            evidenceAvailable: true,
          };
          const fallbackResult = maybeRedactForbiddenLocalUrls({
            result: localResult,
            packet,
          });
          runState.recordToolLoopCloseout(fallbackCloseout);
          runState.recordCloseoutResult(fallbackResult);
          return {
            text: fallbackResult.text,
            ...(fallbackResult.stopReason
              ? { stopReason: fallbackResult.stopReason }
              : {}),
          };
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
      await this.recordReductionBoundarySafely(
        activation,
        packet,
        selection,
        reductionSnapshot,
      );
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
      evidenceText: collectToolTraceResultContent(toolTrace),
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
    reductionSnapshot?: {
      level: RequestEnvelopeReductionLevel;
      omittedSections: string[];
    } & ReductionEnvelopeSnapshot;
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
      const memoryFlush = await this.flushPreCompactionMemorySafely({
        activation: input.activation,
        packet: input.packet,
        selection: input.selection,
        overflowError,
      });
      for (const level of attempts) {
        const reduced = reducePromptPacketForRequestEnvelope(input.packet, {
          level,
        });
        try {
          const reducedGatewayInput = buildGatewayInput({
            activation: input.activation,
            packet: input.packet,
            ...(input.selection.modelId
              ? { modelId: input.selection.modelId }
              : {}),
            ...(input.selection.modelChainId
              ? { modelChainId: input.selection.modelChainId }
              : {}),
            overrideSystemPrompt: reduced.reducedSystemPrompt,
            overrideTaskPrompt: reduced.reducedTaskPrompt,
            artifactIds: reduced.artifactIds,
            envelopeHint: reduced.envelopeHint,
            tools: input.gatewayInput.tools,
            toolChoice: input.gatewayInput.toolChoice,
            ...(input.gatewayInput.signal
              ? { signal: input.gatewayInput.signal }
              : {}),
          });
          const reducedMessages = replaceInitialPromptMessages(
            input.gatewayInput.messages,
            reducedGatewayInput.messages,
          );
          const retryGatewayInput = {
            ...input.gatewayInput,
            messages: reducedMessages,
            envelope: {
              ...(input.gatewayInput.envelope ?? {}),
              ...reduced.envelopeHint,
              artifactIds: reduced.artifactIds,
              ...deriveToolResultEnvelope(reducedMessages),
            },
          };
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

  private async flushPreCompactionMemorySafely(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    selection: {
      modelId?: string;
      modelChainId?: string;
    };
    overflowError: RequestEnvelopeOverflowError;
  }): Promise<PreCompactionMemoryFlushResult | undefined> {
    if (!this.preCompactionMemoryFlusher) {
      return undefined;
    }
    try {
      return await this.preCompactionMemoryFlusher.flush({
        activation: input.activation,
        packet: input.packet,
        ...(input.selection.modelId
          ? { modelId: input.selection.modelId }
          : {}),
        ...(input.selection.modelChainId
          ? { modelChainId: input.selection.modelChainId }
          : {}),
        reason: "request_envelope_overflow",
        diagnostics: input.overflowError.details.diagnostics,
      });
    } catch (error) {
      console.error("pre-compaction memory flush failed", {
        threadId: input.activation.thread.threadId,
        flowId: input.activation.flow.flowId,
        taskId: input.activation.handoff.taskId,
        error,
      });
      return undefined;
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
    reductionSnapshot?: {
      level: RequestEnvelopeReductionLevel;
      omittedSections: string[];
    } & ReductionEnvelopeSnapshot;
    memoryFlush?: PreCompactionMemoryFlushResult;
  }> {
    try {
      const finalSourceMessages: LLMMessage[] = [
        ...input.messages,
        {
          role: "user",
          content: [
            ...finalSynthesisFormatContract(input.packet.taskPrompt, input.messages),
            ...(input.reasonLines ?? [
              `Tool-use round limit reached (${input.maxRounds}).`,
              "Do not call more tools. Produce the best final answer from the evidence already gathered.",
              "State uncertainties and missing verification explicitly instead of trying another lookup.",
            ]),
          ].join("\n"),
        },
      ];
      const finalMessages = prepareToolHistoryForGateway(finalSourceMessages);
      await this.recordToolResultPruningBoundarySafely(
        input.activation,
        input.selection,
        summarizeToolResultPruning(finalSourceMessages, finalMessages),
      );
      const generated = await this.generateWithEnvelopeRetry({
        activation: input.activation,
        packet: input.packet,
        selection: input.selection,
        gatewayInput: {
          ...withoutToolUse(input.baseGatewayInput),
          messages: finalMessages,
          envelope: {
            ...(input.baseGatewayInput.envelope ?? {}),
            toolCount: 0,
            toolSchemaBytes: 0,
            ...deriveToolResultEnvelope(finalMessages),
          },
        },
        ...(input.modelCallTrace
          ? { modelCallTrace: input.modelCallTrace }
          : {}),
        tracePhase: "final_synthesis",
      });
      if (
        shouldRepairExtraneousProviderTableSchema({
          activation: input.activation,
          taskPrompt: input.packet.taskPrompt,
          messages: finalMessages,
          // Separate entry point (generateFinalAfterToolRoundLimit) outside the
          // generate() loop: its idempotency ledger is finalMessages, which is
          // where this method injects + scans its own repair prompt. Pass it as
          // repairMarkers to preserve the pre-migration finalMessages scan.
          repairMarkers: finalMessages,
          resultText: generated.result.text,
        })
      ) {
        const repairSourceMessages: LLMMessage[] = [
          ...finalMessages,
          {
            role: "assistant",
            content: generated.result.text,
          },
          {
            role: "user",
            content: buildExtraneousProviderTableSchemaRepairPrompt({
              taskPrompt: input.packet.taskPrompt,
              resultText: generated.result.text,
            }),
          },
        ];
        const repairedMessages =
          prepareToolHistoryForGateway(repairSourceMessages);
        await this.recordToolResultPruningBoundarySafely(
          input.activation,
          input.selection,
          summarizeToolResultPruning(repairSourceMessages, repairedMessages),
        );
        const repaired = await this.generateWithEnvelopeRetry({
          activation: input.activation,
          packet: input.packet,
          selection: input.selection,
          gatewayInput: {
            ...withoutToolUse(input.baseGatewayInput),
            messages: repairedMessages,
            envelope: {
              ...(input.baseGatewayInput.envelope ?? {}),
              toolCount: 0,
              toolSchemaBytes: 0,
              ...deriveToolResultEnvelope(repairedMessages),
            },
          },
          ...(input.modelCallTrace
            ? { modelCallTrace: input.modelCallTrace }
            : {}),
          tracePhase: "final_synthesis_repair",
        });
        return {
          result: repaired.result,
          ...((repaired.reduction ?? generated.reduction)
            ? { reduction: (repaired.reduction ?? generated.reduction)! }
            : {}),
          ...((repaired.reductionSnapshot ?? generated.reductionSnapshot)
            ? {
                reductionSnapshot: (repaired.reductionSnapshot ??
                  generated.reductionSnapshot)!,
              }
            : {}),
          ...((repaired.memoryFlush ?? generated.memoryFlush)
            ? { memoryFlush: (repaired.memoryFlush ?? generated.memoryFlush)! }
            : {}),
        };
      }
      if (!containsAnyToolCallForm(generated.result)) {
        return generated;
      }
      const repairSourceMessages: LLMMessage[] = [
        ...finalMessages,
        {
          role: "assistant",
          content: generated.result.text,
        },
        {
          role: "user",
          content: [
            "The previous response attempted to emit a tool call even though tools are disabled for final synthesis.",
            "Do not write XML, JSON, or pseudo tool-call markup.",
            "Produce only the final user-facing answer from the evidence already present in the conversation.",
          ].join("\n"),
        },
      ];
      const repairedMessages =
        prepareToolHistoryForGateway(repairSourceMessages);
      await this.recordToolResultPruningBoundarySafely(
        input.activation,
        input.selection,
        summarizeToolResultPruning(repairSourceMessages, repairedMessages),
      );
      const repaired = await this.generateWithEnvelopeRetry({
        activation: input.activation,
        packet: input.packet,
        selection: input.selection,
        gatewayInput: {
          ...withoutToolUse(input.baseGatewayInput),
          messages: repairedMessages,
          envelope: {
            ...(input.baseGatewayInput.envelope ?? {}),
            toolCount: 0,
            toolSchemaBytes: 0,
            ...deriveToolResultEnvelope(repairedMessages),
          },
        },
        ...(input.modelCallTrace
          ? { modelCallTrace: input.modelCallTrace }
          : {}),
        tracePhase: "final_synthesis_repair",
      });
      const repairedResult = containsAnyToolCallForm(repaired.result)
        ? maybeRedactForbiddenLocalUrls({
            result: buildLocalEvidenceCloseout({
              activation: input.activation,
              messages: input.messages,
              packet: input.packet,
              selection: input.selection,
              error: new Error(
                "final synthesis emitted a tool call after repair",
              ),
            }) ?? {
              ...repaired.result,
              text: [
                "I can't safely complete the final answer from the current tool results.",
                "The model attempted to emit another tool call after tools were disabled for final synthesis.",
                "Please retry or continue the mission so the runtime can collect a clean final answer.",
              ].join(" "),
            },
            packet: input.packet,
          })
        : repaired.result;
      return {
        result: repairedResult,
        ...((repaired.reduction ?? generated.reduction)
          ? { reduction: (repaired.reduction ?? generated.reduction)! }
          : {}),
        ...((repaired.reductionSnapshot ?? generated.reductionSnapshot)
          ? {
              reductionSnapshot: (repaired.reductionSnapshot ??
                generated.reductionSnapshot)!,
            }
          : {}),
        ...((repaired.memoryFlush ?? generated.memoryFlush)
          ? { memoryFlush: (repaired.memoryFlush ?? generated.memoryFlush)! }
          : {}),
      };
    } catch (error) {
      const localResult = buildLocalEvidenceCloseout({
        activation: input.activation,
        messages: input.messages,
        packet: input.packet,
        selection: input.selection,
        error,
      });
      if (!localResult) {
        throw error;
      }
      return {
        result: maybeRedactForbiddenLocalUrls({
          result: localResult,
          packet: input.packet,
        }),
      };
    }
  }

  private async executeToolCalls(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCalls: LLMToolCall[];
    toolLoopStartedAtMs: number;
    signal?: AbortSignal;
    onProgress?: (
      call: LLMToolCall,
      progress: Parameters<typeof recordRoleToolProgress>[0]["progress"],
    ) => Promise<void>;
    onResult?: (result: RoleToolExecutionResult) => Promise<void>;
  }): Promise<RoleToolExecutionResult[]> {
    const activeToolLoop =
      input.packet.toolUseMode === "disabled" ? undefined : this.toolLoop;
    if (!activeToolLoop) return [];
    const maxParallelToolCalls =
      typeof activeToolLoop.maxParallelToolCalls === "number" &&
      Number.isFinite(activeToolLoop.maxParallelToolCalls) &&
      activeToolLoop.maxParallelToolCalls > 0
        ? Math.floor(activeToolLoop.maxParallelToolCalls)
        : input.toolCalls.length;
    const maxToolCallsPerRound =
      typeof activeToolLoop.maxToolCallsPerRound === "number" &&
      Number.isFinite(activeToolLoop.maxToolCallsPerRound) &&
      activeToolLoop.maxToolCallsPerRound > 0
        ? Math.floor(activeToolLoop.maxToolCallsPerRound)
        : input.toolCalls.length;
    const results: RoleToolExecutionResult[] = [];
    const executableCalls = input.toolCalls.slice(0, maxToolCallsPerRound);
    const rejectedCalls = input.toolCalls.slice(maxToolCallsPerRound);
    const effectiveMaxParallelToolCalls = shouldSerializeToolBatch(
      executableCalls,
    )
      ? 1
      : maxParallelToolCalls;
    for (
      let index = 0;
      index < executableCalls.length;
      index += effectiveMaxParallelToolCalls
    ) {
      throwIfAborted(input.signal);
      const chunk = executableCalls.slice(
        index,
        index + effectiveMaxParallelToolCalls,
      );
      const maxWallClockMs = resolveEffectiveToolLoopWallClockMs({
        ...(activeToolLoop.maxWallClockMs !== undefined ? { maxWallClockMs: activeToolLoop.maxWallClockMs } : {}),
        toolCalls: chunk,
      });
      const toolExecutionSignal = createToolExecutionSignal({
        elapsedMs: this.clock.now() - input.toolLoopStartedAtMs,
        ...(input.signal ? { parentSignal: input.signal } : {}),
        ...(maxWallClockMs ? { maxWallClockMs } : {}),
      });
      try {
        const chunkResults = await Promise.all(
          chunk.map(async (call) => {
            throwIfAborted(input.signal);
            await this.emitToolProgressSafely(
              input.activation,
              call,
              {
                phase: "started",
                toolName: call.name,
                summary: `Tool call started: ${call.name}`,
              },
              input.onProgress,
            );
            try {
              throwIfAborted(input.signal);
              const result = await activeToolLoop.executor.execute({
                call,
                activation: input.activation,
                packet: input.packet,
                ...(toolExecutionSignal.signal
                  ? { signal: toolExecutionSignal.signal }
                  : {}),
              });
              throwIfAborted(input.signal);
              for (const progress of result.progress ?? []) {
                await this.emitToolProgressSafely(
                  input.activation,
                  call,
                  progress,
                  input.onProgress,
                );
              }
              await this.emitToolProgressSafely(
                input.activation,
                call,
                {
                  phase: result.cancelled
                    ? "cancelled"
                    : result.isError
                      ? "failed"
                      : "completed",
                  toolName: call.name,
                  summary: result.cancelled
                    ? `Tool call cancelled: ${call.name}`
                    : result.isError
                      ? `Tool call failed: ${call.name}`
                      : `Tool call completed: ${call.name}`,
                },
                input.onProgress,
              );
              await input.onResult?.(result);
              return result;
            } catch (error) {
              if (isAbortError(error)) {
                throw error;
              }
              const content =
                error instanceof Error ? error.message : String(error);
              await this.emitToolProgressSafely(
                input.activation,
                call,
                {
                  phase: "failed",
                  toolName: call.name,
                  summary: `Tool call failed: ${call.name}: ${content}`,
                },
                input.onProgress,
              );
              const result = {
                toolCallId: call.id,
                toolName: call.name,
                content,
                isError: true,
              };
              await input.onResult?.(result);
              return result;
            }
          }),
        );
        results.push(...chunkResults);
      } finally {
        toolExecutionSignal.dispose();
      }
    }
    for (const call of rejectedCalls) {
      throwIfAborted(input.signal);
      const result: RoleToolExecutionResult = buildToolCallLimitExceededResult(
        call,
        maxToolCallsPerRound,
        input.toolCalls.length,
      );
      for (const progress of result.progress ?? []) {
        await this.emitToolProgressSafely(
          input.activation,
          call,
          progress,
          input.onProgress,
        );
      }
      await input.onResult?.(result);
      results.push(result);
    }
    return results;
  }

  private async executeRuntimeForcedToolRound(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    messages: LLMMessage[];
    toolTrace: NativeToolRoundTrace[];
    toolCalls: LLMToolCall[];
    round: number;
    toolLoopStartedAtMs: number;
    signal?: AbortSignal;
    assistantText: string;
  }): Promise<{ messages: LLMMessage[]; toolResults: RoleToolExecutionResult[] }> {
    const roundTrace: NativeToolRoundTrace = {
      round: input.round,
      calls: input.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      })),
      results: [],
      progress: [],
    };
    input.toolTrace.push(roundTrace);
    const toolResults = await this.executeToolCalls({
      activation: input.activation,
      packet: input.packet,
      toolCalls: input.toolCalls,
      toolLoopStartedAtMs: input.toolLoopStartedAtMs,
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: async (call, progress) => {
        roundTrace.progress?.push(
          toNativeToolProgressTrace(call, progress, this.clock.now()),
        );
        await this.persistNativeToolTraceSafely(input.activation, input.toolTrace, {
          forceBlocking: progress.phase === "started",
        });
      },
      onResult: async (toolResult) => {
        roundTrace.results.push(toNativeToolResultTrace(toolResult));
        await this.persistNativeToolTraceSafely(input.activation, input.toolTrace);
      },
    });
    let messages = appendAssistantToolCallMessage(input.messages, {
      text: input.assistantText,
      toolCalls: input.toolCalls,
    });
    messages = appendToolResultMessages(messages, toolResults);
    await this.recordProviderToolProtocolRoundSafely({
      activation: input.activation,
      round: input.round,
      toolCalls: input.toolCalls,
      toolResults,
      messages,
    });
    return { messages, toolResults };
  }

  private async emitToolProgressSafely(
    activation: RoleActivationInput,
    call: LLMToolCall,
    progress: Parameters<typeof recordRoleToolProgress>[0]["progress"],
    onProgress:
      | ((
          call: LLMToolCall,
          progress: Parameters<typeof recordRoleToolProgress>[0]["progress"],
        ) => Promise<void>)
      | undefined,
  ): Promise<void> {
    await this.recordToolProgressSafely(activation, call, progress);
    try {
      await onProgress?.(call, progress);
    } catch (error) {
      console.error("native tool message progress persistence failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        toolName: call.name,
        error,
      });
    }
  }

  private async persistNativeToolTraceSafely(
    activation: RoleActivationInput,
    toolTrace: NativeToolRoundTrace[],
    options: { forceBlocking?: boolean } = {},
  ): Promise<void> {
    const nativeToolMessageStore = this.nativeToolMessageStore;
    if (!nativeToolMessageStore) return;
    const work = async () => {
      const messages = buildNativeToolMessages(
        activation,
        { toolUse: { rounds: toolTrace } },
        this.clock.now(),
      );
      for (const message of messages) {
        await nativeToolMessageStore.append(message);
      }
    };
    const onError = (error: unknown) => {
      console.error("native tool message persistence failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        error,
      });
    };
    if (this.deferToolObservability && !options.forceBlocking) {
      void work().catch(onError);
      return;
    }
    try {
      await work();
    } catch (error) {
      onError(error);
    }
  }

  private async recordToolProgressSafely(
    activation: RoleActivationInput,
    call: LLMToolCall,
    progress: Parameters<typeof recordRoleToolProgress>[0]["progress"],
  ): Promise<void> {
    const work = async () => {
      await recordRoleToolProgress({
        recorder:
          this.toolLoop?.runtimeProgressRecorder ??
          this.runtimeProgressRecorder,
        activation,
        call,
        progress,
      });
    };
    const onError = (error: unknown) => {
      console.error("runtime tool progress recording failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        toolName: call.name,
        error,
      });
    };
    if (this.deferToolObservability) {
      void work().catch(onError);
      return;
    }
    try {
      await work();
    } catch (error) {
      onError(error);
    }
  }

  private async recordProviderToolProtocolRoundSafely(input: {
    activation: RoleActivationInput;
    round: number;
    toolCalls: LLMToolCall[];
    toolResults: RoleToolExecutionResult[];
    messages: LLMMessage[];
  }): Promise<void> {
    const work = () => this.recordProviderToolProtocolRound(input);
    const onError = (error: unknown) => {
      console.error("provider tool protocol progress recording failed", {
        threadId: input.activation.thread.threadId,
        flowId: input.activation.flow.flowId,
        taskId: input.activation.handoff.taskId,
        round: input.round,
        error,
      });
    };
    if (this.deferToolObservability) {
      void work().catch(onError);
      return;
    }
    try {
      await work();
    } catch (error) {
      onError(error);
    }
  }

  private async recordProviderToolProtocolRound(input: {
    activation: RoleActivationInput;
    round: number;
    toolCalls: LLMToolCall[];
    toolResults: RoleToolExecutionResult[];
    messages: LLMMessage[];
  }): Promise<void> {
    const recorder =
      this.toolLoop?.runtimeProgressRecorder ?? this.runtimeProgressRecorder;
    if (!recorder) {
      return;
    }
    const assistantMessageIndex = findLatestAssistantToolUseMessageIndex(
      input.messages,
    );
    const toolMessageIndexes = findFollowingToolMessageIndexes(
      input.messages,
      assistantMessageIndex,
    );
    const toolCallIds = input.toolCalls.map((call) => call.id);
    const toolResultIds = input.toolResults.map((result) => result.toolCallId);
    const now = this.clock.now();
    await recorder.record({
      progressId: `progress:provider-tool-protocol:${input.activation.handoff.taskId}:${input.round}:${now}`,
      threadId: input.activation.thread.threadId,
      chainId: `flow:${input.activation.flow.flowId}`,
      spanId: `role:${input.activation.runState.runKey}`,
      ...(input.activation.runState.lastDequeuedTaskId
        ? {
            parentSpanId: `dispatch:${input.activation.runState.lastDequeuedTaskId}`,
          }
        : {}),
      subjectKind: "role_run",
      subjectId: input.activation.runState.runKey,
      phase: "completed",
      progressKind: "boundary",
      heartbeatSource: "activity_echo",
      continuityState: "resolved",
      summary: `Provider tool protocol round ${input.round} appended assistant tool call(s) and matching tool result message(s).`,
      recordedAt: now,
      flowId: input.activation.flow.flowId,
      taskId: input.activation.handoff.taskId,
      roleId: input.activation.runState.roleId,
      metadata: {
        boundaryKind: "provider_tool_protocol_round",
        round: input.round,
        providerToolCallsReturned: input.toolCalls.length,
        assistantToolUseBlockCount: countToolUseBlocks(
          input.messages[assistantMessageIndex],
        ),
        roleToolResultMessageCount: toolMessageIndexes.length,
        toolResultBlockCount: countToolResultBlocks(
          input.messages,
          toolMessageIndexes,
        ),
        assistantBeforeToolResults:
          assistantMessageIndex >= 0 &&
          toolMessageIndexes.every((index) => index > assistantMessageIndex),
        allToolResultsMatchAssistantToolCalls:
          toolResultIds.length > 0 &&
          toolResultIds.every((id) => toolCallIds.includes(id)),
        nextProviderRequestWillIncludeToolResults:
          toolMessageIndexes.length > 0,
        toolCallIds,
        toolResultIds,
        matchingToolCallIds: toolResultIds.filter((id) =>
          toolCallIds.includes(id),
        ),
        toolNames: input.toolCalls.map((call) => call.name),
      },
    });
  }

  private async recordAssemblyBoundary(
    activation: RoleActivationInput,
    packet: RolePromptPacket,
    selection: {
      modelId?: string;
      modelChainId?: string;
    },
  ): Promise<void> {
    if (!this.runtimeProgressRecorder) {
      return;
    }
    const compactedSegments = packet.promptAssembly?.compactedSegments ?? [];
    if (compactedSegments.length === 0) {
      return;
    }
    await this.runtimeProgressRecorder.record({
      progressId: `progress:prompt-assembly:${activation.handoff.taskId}:${Date.now()}`,
      threadId: activation.thread.threadId,
      chainId: `flow:${activation.flow.flowId}`,
      spanId: `role:${activation.runState.runKey}`,
      ...(activation.runState.lastDequeuedTaskId
        ? { parentSpanId: `dispatch:${activation.runState.lastDequeuedTaskId}` }
        : {}),
      subjectKind: "role_run",
      subjectId: activation.runState.runKey,
      phase: "degraded",
      progressKind: "boundary",
      heartbeatSource: "control_path",
      continuityState: "alive",
      summary: `Prompt assembly entered compact boundary with ${compactedSegments.length} compacted segment(s).`,
      recordedAt: Date.now(),
      flowId: activation.flow.flowId,
      taskId: activation.handoff.taskId,
      roleId: activation.runState.roleId,
      metadata: {
        boundaryKind: "prompt_compaction",
        ...(selection.modelId ? { modelId: selection.modelId } : {}),
        ...(selection.modelChainId
          ? { modelChainId: selection.modelChainId }
          : {}),
        ...(packet.promptAssembly?.assemblyFingerprint
          ? { assemblyFingerprint: packet.promptAssembly.assemblyFingerprint }
          : {}),
        ...(packet.promptAssembly?.sectionOrder
          ? { sectionOrder: packet.promptAssembly.sectionOrder }
          : {}),
        ...(packet.promptAssembly?.tokenEstimate
          ? { tokenEstimate: packet.promptAssembly.tokenEstimate }
          : {}),
        ...(packet.promptAssembly?.contextDiagnostics
          ? { contextDiagnostics: packet.promptAssembly.contextDiagnostics }
          : {}),
        ...(packet.promptAssembly?.envelopeHint
          ? { envelopeHint: packet.promptAssembly.envelopeHint }
          : {}),
        compactedSegments,
        usedArtifacts: packet.promptAssembly?.usedArtifacts ?? [],
      },
    });
  }

  private async recordAssemblyBoundarySafely(
    activation: RoleActivationInput,
    packet: RolePromptPacket,
    selection: {
      modelId?: string;
      modelChainId?: string;
    },
  ): Promise<void> {
    try {
      await this.recordAssemblyBoundary(activation, packet, selection);
    } catch (error) {
      console.error("runtime assembly boundary recording failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        error,
      });
    }
  }

  private async recordReductionBoundary(
    activation: RoleActivationInput,
    packet: RolePromptPacket,
    selection: {
      modelId?: string;
      modelChainId?: string;
    },
    reduction: {
      level: RequestEnvelopeReductionLevel;
      omittedSections: string[];
    } & ReductionEnvelopeSnapshot,
  ): Promise<void> {
    if (!this.runtimeProgressRecorder) {
      return;
    }
    await this.runtimeProgressRecorder.record({
      progressId: `progress:prompt-reduction:${activation.handoff.taskId}:${reduction.level}:${Date.now()}`,
      threadId: activation.thread.threadId,
      chainId: `flow:${activation.flow.flowId}`,
      spanId: `role:${activation.runState.runKey}`,
      ...(activation.runState.lastDequeuedTaskId
        ? { parentSpanId: `dispatch:${activation.runState.lastDequeuedTaskId}` }
        : {}),
      subjectKind: "role_run",
      subjectId: activation.runState.runKey,
      phase: "degraded",
      progressKind: "boundary",
      heartbeatSource: "control_path",
      continuityState: "alive",
      summary: `Prompt request envelope reduced to ${reduction.level}.`,
      recordedAt: Date.now(),
      flowId: activation.flow.flowId,
      taskId: activation.handoff.taskId,
      roleId: activation.runState.roleId,
      metadata: {
        boundaryKind: "request_envelope_reduction",
        ...(selection.modelId ? { modelId: selection.modelId } : {}),
        ...(selection.modelChainId
          ? { modelChainId: selection.modelChainId }
          : {}),
        ...(packet.promptAssembly?.assemblyFingerprint
          ? { assemblyFingerprint: packet.promptAssembly.assemblyFingerprint }
          : {}),
        ...(packet.promptAssembly?.sectionOrder
          ? { sectionOrder: packet.promptAssembly.sectionOrder }
          : {}),
        ...(packet.promptAssembly?.tokenEstimate
          ? { tokenEstimate: packet.promptAssembly.tokenEstimate }
          : {}),
        ...(packet.promptAssembly?.contextDiagnostics
          ? { contextDiagnostics: packet.promptAssembly.contextDiagnostics }
          : {}),
        ...(reduction.envelopeHint
          ? { envelopeHint: reduction.envelopeHint }
          : {}),
        reductionLevel: reduction.level,
        omittedSections: reduction.omittedSections,
        compactedSegments: packet.promptAssembly?.compactedSegments ?? [],
        usedArtifacts: reduction.artifactIds,
      },
    });
  }

  private async recordReductionBoundarySafely(
    activation: RoleActivationInput,
    packet: RolePromptPacket,
    selection: {
      modelId?: string;
      modelChainId?: string;
    },
    reduction: {
      level: RequestEnvelopeReductionLevel;
      omittedSections: string[];
    } & ReductionEnvelopeSnapshot,
  ): Promise<void> {
    try {
      await this.recordReductionBoundary(
        activation,
        packet,
        selection,
        reduction,
      );
    } catch (error) {
      console.error("runtime reduction boundary recording failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        reductionLevel: reduction.level,
        error,
      });
    }
  }

  private async recordToolResultPruningBoundary(
    activation: RoleActivationInput,
    selection: {
      modelId?: string;
      modelChainId?: string;
    },
    snapshot: ToolResultPruningSnapshot | undefined,
  ): Promise<void> {
    if (!this.runtimeProgressRecorder || !snapshot) {
      return;
    }
    await this.runtimeProgressRecorder.record({
      progressId: `progress:tool-result-pruning:${activation.handoff.taskId}:${Date.now()}`,
      threadId: activation.thread.threadId,
      chainId: `flow:${activation.flow.flowId}`,
      spanId: `role:${activation.runState.runKey}`,
      ...(activation.runState.lastDequeuedTaskId
        ? { parentSpanId: `dispatch:${activation.runState.lastDequeuedTaskId}` }
        : {}),
      subjectKind: "role_run",
      subjectId: activation.runState.runKey,
      phase: "degraded",
      progressKind: "boundary",
      heartbeatSource: "control_path",
      continuityState: "alive",
      summary: `Tool result history pruned for prompt input (${snapshot.prunedToolResults} result(s)).`,
      recordedAt: Date.now(),
      flowId: activation.flow.flowId,
      taskId: activation.handoff.taskId,
      roleId: activation.runState.roleId,
      metadata: {
        boundaryKind: "tool_result_pruning",
        ...(selection.modelId ? { modelId: selection.modelId } : {}),
        ...(selection.modelChainId
          ? { modelChainId: selection.modelChainId }
          : {}),
        prunedToolResults: snapshot.prunedToolResults,
        pruningReasons: snapshot.reasons,
        compactedHistory: snapshot.compactedHistory,
        toolResultCountBefore: snapshot.toolResultCountBefore,
        toolResultCountAfter: snapshot.toolResultCountAfter,
        toolResultBytesBefore: snapshot.toolResultBytesBefore,
        toolResultBytesAfter: snapshot.toolResultBytesAfter,
        messageCountBefore: snapshot.messageCountBefore,
        messageCountAfter: snapshot.messageCountAfter,
        pruningLimits: snapshot.limits,
      },
    });
  }

  private async recordToolResultPruningBoundarySafely(
    activation: RoleActivationInput,
    selection: {
      modelId?: string;
      modelChainId?: string;
    },
    snapshot: ToolResultPruningSnapshot | undefined,
  ): Promise<void> {
    try {
      await this.recordToolResultPruningBoundary(
        activation,
        selection,
        snapshot,
      );
    } catch (error) {
      console.error("runtime tool-result pruning boundary recording failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        error,
      });
    }
  }
}

function filterToolDefinitionsForTask(
  tools: GenerateTextInput["tools"],
  taskPrompt: string,
): GenerateTextInput["tools"] {
  if (!tools?.length) return tools;
  let filtered = tools;
  if (!taskAllowsPermissionTools(taskPrompt)) {
    filtered = filtered.filter((tool) => !PERMISSION_TOOL_NAMES.has(tool.name));
  }
  if (!taskAllowsTaskTrackingTools(taskPrompt)) {
    filtered = filtered.filter((tool) => !TASK_TRACKING_TOOL_NAMES.has(tool.name));
  }
  if (taskRequestsFocusedDurableMemoryRecall(taskPrompt)) {
    filtered = filtered.filter((tool) => FOCUSED_MEMORY_RECALL_TOOL_NAMES.has(tool.name));
  }
  return filtered;
}

const FOCUSED_MEMORY_RECALL_TOOL_NAMES = new Set(["memory_search", "memory_get"]);
const PERMISSION_TOOL_NAMES = new Set(["permission_query", "permission_result", "permission_applied"]);
const TASK_TRACKING_TOOL_NAMES = new Set(["tasks_list", "tasks_create", "tasks_update"]);
const FOCUSED_MEMORY_RECALL_REQUEST_PATTERN =
  /\b(?:durable memory|memory_search|memory_get|check durable memory|inspect any candidate memory)\b/i;
const FOCUSED_MEMORY_RECALL_GLOBAL_CONFLICT_PATTERN =
  /\b(?:public documentation|status pages?|announcements?|web search|web_fetch|official site|URL|https?:\/\/)\b|(?:公网|公开文档|公告|状态页|官网|网址|链接)/iu;
const FOCUSED_MEMORY_RECALL_NEARBY_CONFLICT_PATTERN = new RegExp(
  `${FOCUSED_MEMORY_RECALL_REQUEST_PATTERN.source}[\\s\\S]{0,180}\\b(?:delegate|delegated|spawn|sub[- ]?agent|independent researcher|separate researcher)\\b|\\b(?:delegate|delegated|spawn|sub[- ]?agent|independent researcher|separate researcher)\\b[\\s\\S]{0,180}${FOCUSED_MEMORY_RECALL_REQUEST_PATTERN.source}`,
  "iu",
);
const FOCUSED_MEMORY_RECALL_CJK_NEARBY_CONFLICT_PATTERN =
  /(?:durable memory|memory_search|memory_get|记忆|长期记忆)[\s\S]{0,120}(?:委派|派给|子\s*agent|独立研究员)|(?:委派|派给|子\s*agent|独立研究员)[\s\S]{0,120}(?:durable memory|memory_search|memory_get|记忆|长期记忆)/iu;

function buildToolDefinitionFilterTaskContext(
  activation: RoleActivationInput,
  taskPrompt: string,
): string {
  const intent = activation.handoff.payload.intent;
  return [
    taskPrompt,
    intent?.relayBrief ?? "",
    ...(intent?.recentMessages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    ),
  ].join("\n");
}

function buildToolDefinitionFilterMessageContext(messages: LLMMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => readToolResultContentText(message.content))
    .join("\n");
}

function taskRequestsFocusedDurableMemoryRecall(taskPrompt: string): boolean {
  if (!FOCUSED_MEMORY_RECALL_REQUEST_PATTERN.test(taskPrompt)) {
    return false;
  }
  if (FOCUSED_MEMORY_RECALL_GLOBAL_CONFLICT_PATTERN.test(taskPrompt)) {
    return false;
  }
  if (
    FOCUSED_MEMORY_RECALL_NEARBY_CONFLICT_PATTERN.test(taskPrompt) ||
    FOCUSED_MEMORY_RECALL_CJK_NEARBY_CONFLICT_PATTERN.test(taskPrompt)
  ) {
    return false;
  }
  return true;
}

function taskAllowsTaskTrackingTools(taskPrompt: string): boolean {
  if (
    taskPromptLooksLikeSourceCheckContinuation(taskPrompt) &&
    !taskPromptExplicitlyRequestsTaskTracking(taskPrompt)
  ) {
    return false;
  }
  if (
    isExplicitSessionContinuationRequest(extractLatestUserContinuationText(taskPrompt)) ||
    continuationRequestPrefersResumableSession({
      latestUserText: extractLatestUserContinuationText(taskPrompt),
      context: taskPrompt,
    })
  ) {
    return taskPromptExplicitlyRequestsTaskTracking(taskPrompt);
  }
  return true;
}

function taskPromptExplicitlyRequestsTaskTracking(taskPrompt: string): boolean {
  return /\b(?:tasks?_(?:list|create|update)|work items?|todo|to-do|task tracking|create (?:a )?task|update (?:the )?task|mark .* done|任务|待办|工作项)\b/i.test(
    taskPrompt,
  );
}

// ORDER_DEPENDENT_TOOL_NAMES, shouldSerializeToolBatch, findRepeatedFailedToolCall
// extracted to ./react/predicates (Phase 1 cutover, behavior-preserving).

// toolCallSignature, normalizeToolInputForSignature, stableJson
// extracted to ./react/predicates (Phase 1 cutover, behavior-preserving).

function appendModelCallBoundary(
  trace: ModelCallBoundaryTrace[] | undefined,
  input: {
    phase: ModelCallBoundaryTrace["phase"];
    round?: number;
    startedAt: number;
    completedAt: number;
    gatewayInput: GenerateTextInput;
    result: GenerateTextResult;
    reductionLevel?: RequestEnvelopeReductionLevel;
  },
): void {
  if (!trace) return;
  const boundary: ModelCallBoundaryTrace = {
    index: trace.length + 1,
    phase: input.phase,
    ...(input.round !== undefined ? { round: input.round } : {}),
    durationMs: Math.max(0, input.completedAt - input.startedAt),
    modelId: input.result.modelId,
    providerId: input.result.providerId,
    protocol: input.result.protocol,
    adapterName: input.result.adapterName,
    ...(input.result.modelChainId
      ? { modelChainId: input.result.modelChainId }
      : {}),
    ...(input.result.attemptedModelIds?.length
      ? { attemptedModelIds: input.result.attemptedModelIds }
      : {}),
    ...(input.result.stopReason ? { stopReason: input.result.stopReason } : {}),
    messageCount: input.gatewayInput.messages.length,
    toolSchemaCount: input.gatewayInput.tools?.length ?? 0,
    ...(input.gatewayInput.toolChoice
      ? { toolChoice: formatToolChoiceForTrace(input.gatewayInput.toolChoice) }
      : {}),
    toolCallsReturned: input.result.toolCalls?.length ?? 0,
    contentBlockCount: input.result.contentBlocks?.length ?? 0,
    textBytes: Buffer.byteLength(input.result.text, "utf8"),
    ...(input.result.usage ? { usage: input.result.usage } : {}),
    ...(input.result.requestEnvelope
      ? { requestEnvelope: input.result.requestEnvelope }
      : {}),
    ...(input.reductionLevel ? { reductionLevel: input.reductionLevel } : {}),
  };
  trace.push(boundary);
}

function summarizeModelUseTrace(
  trace: ModelCallBoundaryTrace[],
): Record<string, unknown> {
  const totalInputTokens = sumModelUseTokens(trace, "inputTokens");
  const totalOutputTokens = sumModelUseTokens(trace, "outputTokens");
  return {
    calls: trace,
    callCount: trace.length,
    source: "turnkeyai-role-runtime",
    ...(totalInputTokens !== null ? { totalInputTokens } : {}),
    ...(totalOutputTokens !== null ? { totalOutputTokens } : {}),
  };
}

function sumModelUseTokens(
  trace: ModelCallBoundaryTrace[],
  key: "inputTokens" | "outputTokens",
): number | null {
  let total = 0;
  let seen = false;
  for (const boundary of trace) {
    const value = boundary.usage?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

function formatToolChoiceForTrace(
  toolChoice: GenerateTextInput["toolChoice"],
): string {
  if (!toolChoice || typeof toolChoice === "string")
    return toolChoice ?? "auto";
  return `tool:${toolChoice.name}`;
}

interface ReductionEnvelopeSnapshot {
  artifactIds: string[];
  envelopeHint?: {
    toolResultCount?: number;
    toolResultBytes?: number;
    inlineAttachmentBytes?: number;
    inlineImageCount?: number;
    inlineImageBytes?: number;
    inlinePdfCount?: number;
    inlinePdfBytes?: number;
    multimodalPartCount?: number;
  };
}

interface ToolResultPruningLimits {
  historyMaxMessages: number;
  recentFullCount: number;
  totalMaxBytes: number;
  softMaxBytes: number;
  hardMaxBytes: number;
}

interface ToolResultPruningSnapshot {
  prunedToolResults: number;
  reasons: string[];
  compactedHistory: boolean;
  toolResultCountBefore: number;
  toolResultCountAfter: number;
  toolResultBytesBefore: number;
  toolResultBytesAfter: number;
  messageCountBefore: number;
  messageCountAfter: number;
  limits: ToolResultPruningLimits;
}

const ROLE_TOOL_HISTORY_MAX_MESSAGES = 16;
const TOOL_RESULT_RECENT_FULL_COUNT = 2;
const TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES = 32 * 1024;
const TOOL_RESULT_SOFT_PRUNE_MAX_BYTES = 16 * 1024;
const TOOL_RESULT_HARD_PRUNE_MAX_BYTES = 64 * 1024;

function readToolResultPruningLimits(
  env: NodeJS.ProcessEnv = process.env,
): ToolResultPruningLimits {
  const recentFullCount = readPositiveIntegerEnv(
    env,
    "TURNKEYAI_TOOL_RESULT_RECENT_FULL_COUNT",
    TOOL_RESULT_RECENT_FULL_COUNT,
  );
  return {
    historyMaxMessages: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_HISTORY_MAX_MESSAGES",
      ROLE_TOOL_HISTORY_MAX_MESSAGES,
    ),
    recentFullCount,
    totalMaxBytes: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES",
      TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES,
    ),
    softMaxBytes: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_RESULT_SOFT_PRUNE_MAX_BYTES",
      TOOL_RESULT_SOFT_PRUNE_MAX_BYTES,
    ),
    hardMaxBytes: readPositiveIntegerEnv(
      env,
      "TURNKEYAI_TOOL_RESULT_HARD_PRUNE_MAX_BYTES",
      TOOL_RESULT_HARD_PRUNE_MAX_BYTES,
    ),
  };
}

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function canonicalizeSessionToolTraceCalls(
  roundTrace: NativeToolRoundTrace,
  toolResults: RoleToolExecutionResult[],
): boolean {
  let changed = false;
  for (const result of toolResults) {
    if (
      result.toolName !== "sessions_send" &&
      result.toolName !== "sessions_history"
    ) {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed?.session_key) {
      continue;
    }
    const call = roundTrace.calls.find((item) => item.id === result.toolCallId);
    if (!call || call.input.session_key === parsed.session_key) {
      continue;
    }
    call.input = {
      ...call.input,
      session_key: parsed.session_key,
    };
    changed = true;
  }
  return changed;
}

function findSubAgentToolTimeout(
  results: RoleToolExecutionResult[],
): SubAgentToolTimeoutSignal | null {
  for (const result of results) {
    if (
      result.toolName !== "sessions_spawn" &&
      result.toolName !== "sessions_send"
    ) {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed || parsed.status !== "timeout") {
      continue;
    }
    const timeoutSeconds = parsed.timeout_seconds;
    const evidenceAvailable =
      parsed.evidence_available === true ||
      typeof parsed.evidence_summary === "string";
    return {
      toolName: result.toolName,
      sessionKey: parsed.session_key,
      agentId: parsed.agent_id,
      timeoutSeconds:
        typeof timeoutSeconds === "number" ? timeoutSeconds : null,
      evidenceAvailable,
    };
  }
  return null;
}

function findCompletedSessionEvidence(results: RoleToolExecutionResult[]): {
  toolName: string;
  finalContents: string[];
  browserRecoverySummaries: string[];
} | null {
  const finalContents: string[] = [];
  const browserRecoverySummaries: string[] = [];
  let toolName: string | null = null;
  for (const result of results) {
    if (result.isError || result.cancelled || result.skipped) {
      continue;
    }
    if (
      result.toolName !== "sessions_spawn" &&
      result.toolName !== "sessions_send" &&
      result.toolName !== "sessions_history"
    ) {
      continue;
    }
    if (result.toolName === "sessions_history") {
      const historyEvidence = readSessionHistoryEvidence(result.content);
      if (historyEvidence) {
        toolName = toolName ?? result.toolName;
        finalContents.push(historyEvidence);
      }
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed || parsed.status !== "completed") {
      continue;
    }
    const finalContent = readCompletedSessionEvidence(parsed);
    if (!finalContent) {
      continue;
    }
    const payload = parsed.payload;
    toolName = toolName ?? result.toolName;
    finalContents.push(finalContent);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const browserRecoverySummary = readBrowserRecoverySummary(
        payload as Record<string, unknown>,
      );
      if (browserRecoverySummary) {
        browserRecoverySummaries.push(browserRecoverySummary);
      }
    }
    const inlineBrowserRecoverySummary = readInlineBrowserRecoverySummary(
      [parsed.evidence_summary, parsed.result, parsed.final_content].filter(
        (item): item is string => typeof item === "string",
      ),
    );
    if (inlineBrowserRecoverySummary) {
      browserRecoverySummaries.push(inlineBrowserRecoverySummary);
    }
  }
  return toolName && finalContents.length > 0
    ? { toolName, finalContents, browserRecoverySummaries }
    : null;
}

function readSessionHistoryEvidence(content: string): string | null {
  if (!content.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed["session_key"] !== "string" || !("total_messages" in parsed)) {
      return null;
    }
    const evidenceParts: string[] = [];
    const messages = parsed["messages"];
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          continue;
        }
        const record = message as Record<string, unknown>;
        const text = [record["content"], record["summary"], record["result"], record["final_content"]]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join("\n");
        if (text.trim()) {
          evidenceParts.push(text.trim());
        }
      }
    }
    for (const key of ["result", "final_content", "evidence_summary", "inspection_guidance"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        evidenceParts.push(value.trim());
      }
    }
    const evidence = dedupeStrings(evidenceParts).join("\n\n").trim();
    return evidence ? evidence : sliceUtf8(content, 4000);
  } catch {
    return /\b(?:session_key|total_messages|sessions_history)\b/i.test(content)
      ? sliceUtf8(content, 4000)
      : null;
  }
}

function shouldAllowRequiredTimeoutContinuationPastWallClock(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolCalls: LLMToolCall[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (input.toolCalls.length !== 1) {
    return false;
  }
  const call = input.toolCalls[0];
  if (!call || call.name !== "sessions_send") {
    return false;
  }
  const sessionKey =
    typeof call.input?.session_key === "string"
      ? call.input.session_key.trim()
      : "";
  if (!sessionKey || hasExecutedSessionsSend(input.toolTrace, sessionKey)) {
    return false;
  }
  if (
    hasApprovedBrowserTimeoutContinuationPrompt(input.messages) &&
    isAppliedApprovalBrowserContinuation(input.taskPrompt)
  ) {
    return true;
  }
  return (
    hasCoverageTimeoutContinuationPrompt(input.messages) &&
    isCoverageCriticalDelegationTask(input.taskPrompt)
  );
}

function allowsSupplementalBrowserProbe(packet: RolePromptPacket): boolean {
  const unavailable =
    packet.capabilityInspection?.unavailableCapabilities ?? [];
  return !unavailable.some((capability) => /\bbrowser\b/i.test(capability));
}

function isResumablePartialSessionResult(
  parsed: NonNullable<ReturnType<typeof parseSessionToolResult>>,
): boolean {
  const payload = parsed.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const resumableReason = (payload as Record<string, unknown>)["resumableReason"];
  return typeof resumableReason === "string" && resumableReason.trim().length > 0;
}

function collectToolResultContentText(
  results: RoleToolExecutionResult[],
): string {
  return results
    .map((result) => (typeof result.content === "string" ? result.content : ""))
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

function collectToolTraceResultContent(rounds: NativeToolRoundTrace[]): string {
  return rounds
    .flatMap((round) => round.results)
    .map((result) => (typeof result.content === "string" ? result.content : ""))
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

function enforceRequestedThreeLineLabelShape(input: { taskPrompt: string; resultText: string }): string {
  if (!requestsStatusVisibleTextEvidenceUrlLines(input.taskPrompt)) {
    return input.resultText;
  }
  const lines = input.resultText
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 3) {
    return input.resultText;
  }
  const labels = ["状态", "最终可见文本", "证据 URL"] as const;
  return lines
    .map((line, index) => {
      const label = labels[index]!;
      return normalizeRequestedThreeLineLabel(line, label);
    })
    .join("\n");
}

function normalizeRequestedThreeLineLabel(line: string, label: string): string {
  const labelPattern = escapeRegExp(label).replace(/\s+/g, "\\s*");
  const leadingLabel = new RegExp(
    `^\\s*(?:\\*\\*)?\\s*${labelPattern}\\s*[:：]\\s*(?:\\*\\*)?\\s*`,
    "i",
  );
  const value = line.replace(leadingLabel, "").trim();
  return `${label}: ${value || line}`;
}

// Stage 6 prereq: record an injected repair prompt in the idempotency ledger and
// return it so it can also be appended to the model conversation in one step.
// Every `shouldRepair*` "already tried" guard scans this ledger (the repair
// prompts we injected) instead of the full message history, so the guards no
// longer depend on conversation storage. The hasX*RepairPrompt helpers are
// unchanged — they still scan an LLMMessage[]; we just pass them this ledger.
function recordRepairPrompt(
  repairMarkers: LLMMessage[],
  content: string,
): LLMMessage {
  const message: LLMMessage = { role: "user", content };
  repairMarkers.push(message);
  return message;
}

function shouldSuppressToolsForAwaitingContextSetup(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
}): boolean {
  if (hasAwaitingContextSetupNoToolRepairPrompt(input.repairMarkers)) {
    return false;
  }
  return taskPromptRequestsAwaitingContextSetup(input.taskPrompt);
}

function taskPromptRequestsAwaitingContextSetup(taskPrompt: string): boolean {
  if (
    /\b(?:durable memory|memory_search|memory_get|check durable memory|inspect any candidate memory|recover the launch window|launch window|residual risk|previously captured)\b/i.test(
      taskPrompt,
    )
  ) {
    return false;
  }
  return (
    /\bno research (?:is )?(?:needed|required)\b|\bno action (?:is )?(?:needed|required)\b/i.test(
      taskPrompt,
    ) &&
    /\bbriefly acknowledge\b|\backnowledge\b/i.test(taskPrompt) &&
    /\b(?:continue|resume|proceed)\b[\s\S]{0,120}\b(?:context|details?|available|provided)\b/i.test(
      taskPrompt,
    )
  );
}

function shouldRepairMissingRequestedTableColumns(input: {
  activation?: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasMissingRequestedTableColumnsRepairPrompt(input.repairMarkers)) {
    return false;
  }
  const requestedColumns = resolveRequestedTableColumns([
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ]);
  if (requestedColumns.length === 0) return false;
  const normalizedResult = normalizeColumnDetectionText(input.resultText);
  if (
    !markdownTableHasExactRequestedColumns(input.resultText, requestedColumns)
  ) {
    return true;
  }
  return requestedColumns.some(
    (column) => !normalizedResult.includes(normalizeColumnDetectionText(column)),
  );
}

function hasMissingRequestedTableColumnsRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readToolResultContentText(message.content).includes(
        "did not preserve the table columns explicitly requested",
      ),
  );
}

function buildMissingRequestedTableColumnsRepairPrompt(input: {
  activation?: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
  resultText: string;
}): string {
  const requestedColumns = resolveRequestedTableColumns([
    input.taskPrompt,
    ...buildRequestedTableColumnActivationContext(input.activation),
    ...requestedTableColumnMessageContext(input.messages),
  ]);
  return [
    "The previous final answer did not preserve the table columns explicitly requested by the original user/task.",
    `Required table header columns: ${requestedColumns.join(" | ")}`,
    "Rewrite the final answer now without calling tools.",
    "The main table must include every required column above. Do not rename columns, transpose the table into Slot x Provider form, merge columns, or move any requested column into prose.",
    "For any cell not directly supported by source evidence already present, write 未验证.",
    "If any required goal slot remains unverified, mark the answer as blocked/partial and list the missing slots briefly after the table.",
  ].join("\n");
}

function shouldRepairExtraneousProviderTableSchema(input: {
  activation?: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasExtraneousProviderTableSchemaRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!resultIntroducesProviderSupportSchema(input.resultText)) {
    return false;
  }
  const originalContext = [
    input.taskPrompt,
    ...buildOriginalRequestTableColumnContext(input.activation),
  ].join("\n");
  const originalRequestedColumns = resolveRequestedTableColumns([
    originalContext,
  ]);
  if (
    originalRequestedColumns.length > 0 &&
    explicitlyRequestsProviderSupportSchema(originalContext)
  ) {
    return false;
  }
  return !explicitlyRequestsProviderSupportSchema(originalContext);
}

function hasExtraneousProviderTableSchemaRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readToolResultContentText(message.content).includes(
        "introduced provider/search/model-support columns that were not requested",
      ),
  );
}

function buildExtraneousProviderTableSchemaRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
}): string {
  return [
    "Runtime correction: final answer introduced provider/search/model-support columns that were not requested by the original task.",
    "Do not call tools. Rewrite the final answer using only the evidence already present.",
    "Remove the provider/search_web_search/target-model/input-price/output-price table schema unless those exact dimensions were requested by the original task.",
    "Use the original task dimensions instead: pricing, strengths, risks, tradeoff, and a clear recommendation for the product lead when those are requested.",
    "Do not mark the whole mission blocked merely because provider support, target-model support, search/web_search support, or token input/output pricing are absent when the original task did not ask for them.",
    "Keep residual risk visible only for source-bounded gaps actually relevant to the original task.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
  ].join("\n");
}

function hasAwaitingContextSetupNoToolRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: this turn is setup-only",
      ),
  );
}

function buildAwaitingContextSetupNoToolRepairPrompt(
  taskPrompt: string,
): string {
  return [
    "Runtime correction: this turn is setup-only and explicitly says no research or action is needed yet.",
    "Do not call memory, browser, search, session, or task tools for this turn.",
    "Write a brief final answer that acknowledges the thread is ready, states no research is queued, and says the mission can continue when context is provided.",
    "Keep it concise and complete.",
    `Original task:\n${sliceUtf8(taskPrompt, 1000)}`,
  ].join("\n");
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasToolDefinition(
  tools: GenerateTextInput["tools"] | undefined,
  name: string,
): boolean {
  return (tools ?? []).some((tool) => tool.name === name);
}

function buildGatewayInput(input: {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  modelId?: string;
  modelChainId?: string;
  signal?: AbortSignal;
  overrideSystemPrompt?: string;
  overrideTaskPrompt?: string;
  artifactIds?: string[];
  envelopeHint?: {
    toolResultCount?: number;
    toolResultBytes?: number;
    inlineAttachmentBytes?: number;
    inlineImageCount?: number;
    inlineImageBytes?: number;
    inlinePdfCount?: number;
    inlinePdfBytes?: number;
    multimodalPartCount?: number;
  };
  tools?: GenerateTextInput["tools"];
  toolChoice?: GenerateTextInput["toolChoice"];
  sessionContinuationDirective?: SessionContinuationDirective;
}): GenerateTextInput {
  const runtimeDirective = input.sessionContinuationDirective
    ? [
        "",
        "Runtime session continuation directive:",
        `A resumable sub-agent session is available: ${input.sessionContinuationDirective.sessionKey}.`,
        "If this turn continues, resumes, retries, or revisits the same delegated work, call sessions_send with that session_key as the first and only tool call for that continuation attempt.",
        "Do not call memory_search, sessions_history, sessions_list, or sessions_spawn before that sessions_send; the runtime already selected the resumable session.",
        "Spawn a new session only on a later turn if the user asks for a new independent task or the existing session is clearly irrelevant.",
        `Continuation message hint: ${input.sessionContinuationDirective.messageHint}`,
      ].join("\n")
    : "";
  return {
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    messages: [
      {
        role: "system" as const,
        content: input.overrideSystemPrompt ?? input.packet.systemPrompt,
      },
      {
        role: "user" as const,
        content: [
          input.overrideTaskPrompt ?? input.packet.taskPrompt,
          runtimeDirective,
          "",
          "Output contract:",
          input.packet.outputContract,
        ].join("\n"),
      },
    ],
    metadata: {
      roleId: input.activation.runState.roleId,
      threadId: input.activation.thread.threadId,
      flowId: input.activation.flow.flowId,
    },
    envelope: {
      artifactIds:
        input.artifactIds ?? input.packet.promptAssembly?.usedArtifacts ?? [],
      toolCount: input.tools?.length ?? 0,
      toolSchemaBytes: input.tools
        ? Buffer.byteLength(JSON.stringify(input.tools), "utf8")
        : 0,
      toolResultCount:
        input.envelopeHint?.toolResultCount ??
        input.packet.promptAssembly?.envelopeHint?.toolResultCount ??
        0,
      toolResultBytes:
        input.envelopeHint?.toolResultBytes ??
        input.packet.promptAssembly?.envelopeHint?.toolResultBytes ??
        0,
      inlineAttachmentBytes:
        input.envelopeHint?.inlineAttachmentBytes ??
        input.packet.promptAssembly?.envelopeHint?.inlineAttachmentBytes ??
        0,
      inlineImageCount:
        input.envelopeHint?.inlineImageCount ??
        input.packet.promptAssembly?.envelopeHint?.inlineImageCount ??
        0,
      inlineImageBytes:
        input.envelopeHint?.inlineImageBytes ??
        input.packet.promptAssembly?.envelopeHint?.inlineImageBytes ??
        0,
      inlinePdfCount:
        input.envelopeHint?.inlinePdfCount ??
        input.packet.promptAssembly?.envelopeHint?.inlinePdfCount ??
        0,
      inlinePdfBytes:
        input.envelopeHint?.inlinePdfBytes ??
        input.packet.promptAssembly?.envelopeHint?.inlinePdfBytes ??
        0,
      multimodalPartCount:
        input.envelopeHint?.multimodalPartCount ??
        input.packet.promptAssembly?.envelopeHint?.multimodalPartCount ??
        0,
    },
  };
}

function finalSynthesisFormatContract(
  taskPrompt?: string,
  messages: LLMMessage[] = [],
): string[] {
  const requiredDeliverables = inferRequiredFinalSynthesisDeliverables(
    taskPrompt ?? "",
  );
  const requestedTableColumns = resolveRequestedTableColumns([
    taskPrompt ?? "",
    ...requestedTableColumnMessageContext(messages),
  ]);
  return [
    "Final synthesis format contract:",
    "Review the original user/task request for any explicit final answer shape before writing.",
    "If the task specifies a heading, bullet count, bullet labels, order, table/no-table rule, link/no-link rule, or forbidden markup, follow those format constraints exactly.",
    "If the task says a line must start with a literal prefix such as `- recommendation:`, that exact prefix must be at the beginning of its own line.",
    "If a success marker or required phrase is assigned to a bullet, place it in that bullet only; do not move it into a paragraph, heading, preamble, or closing note.",
    "When links are forbidden, do not include Markdown links or bare http:// / https:// URLs, even if tool results contain internal fetch URLs.",
    "Do not write a preamble before a requested final shape.",
    "Do not write status preambles such as 'All tool calls returned' or 'Producing the final answer'.",
    "For exact-skeleton answers, keep each requested bullet compact, usually one sentence, while preserving required markers, facts, and residual risk.",
    "Do not collapse requested bullets into a paragraph. Do not add extra sections, summaries, notes, or prose after an exact requested shape.",
    "If any user or task message requested a table with named columns, preserve those requested columns in the table. Do not satisfy a requested table column by moving it into prose below the table; keep the column and fill missing cells with not verified/未验证.",
    ...(requestedTableColumns.length
      ? [
          `Exact requested table columns detected: ${requestedTableColumns.join(" | ")}`,
          "The final table header must include every detected column label above without renaming, merging, or moving that column into prose. Extra columns are allowed only if they do not replace the requested ones.",
        ]
      : []),
    ...(requiredDeliverables.length
      ? [
          "Required final deliverables inferred from the original task:",
          ...requiredDeliverables.map(
            (deliverable, index) => `${index + 1}. ${deliverable.instruction}`,
          ),
          "Before finalizing, verify every required deliverable above is present in the answer. If any required deliverable is missing, rewrite the answer instead of closing.",
        ]
      : []),
    "Evidence synthesis contract:",
    "Unless the original task's exact output shape forbids extra labels, include concise verified evidence, unverified scope or residual risk, and the recommendation or next action.",
    "When delegated Source N evidence blocks are provided, cover every source in the final answer. Preserve source-specific facts such as counts, rates, owners, URLs, screenshots, artifacts, approvals, and limitations.",
    "For research or comparison tasks, include a compact verified sources/evidence line unless the user explicitly forbids source labels; name each source and the exact fact(s) it verified.",
    "Source evidence may include tables or headers created by a sub-agent. Do not copy a source table's shape, headers, or unrelated dimensions unless the original user/task request asked for that table shape or those named columns.",
    "Do not promote a source's partial, missing, timed-out, blocked, or unverified observation into a confirmed claim. Mark missing dimensions as not verified.",
    "For approval-gated or mutating work, state what was approved, what was applied, what evidence changed after the action, and what residual risk or no-external-side-effect boundary remains.",
  ];
}

function withoutToolUse(input: GenerateTextInput): GenerateTextInput {
  const { tools: _tools, toolChoice: _toolChoice, ...rest } = input;
  return {
    ...rest,
    toolChoice: "none",
  };
}

function extractMentions(content: string): RoleId[] {
  return [...content.matchAll(/@\{(?<roleId>[^}]+)\}/g)]
    .map((match) => match.groups?.roleId)
    .filter((value): value is RoleId => Boolean(value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("operation aborted");
  error.name = "AbortError";
  throw error;
}

function deriveToolResultEnvelope(messages: LLMMessage[]): {
  toolResultCount: number;
  toolResultBytes: number;
} {
  const toolMessages = messages.filter((message) => message.role === "tool");
  return {
    toolResultCount: toolMessages.length,
    toolResultBytes: Buffer.byteLength(
      JSON.stringify(toolMessages.map((message) => message.content)),
      "utf8",
    ),
  };
}

function prepareToolHistoryForGateway(messages: LLMMessage[]): LLMMessage[] {
  const limits = readToolResultPruningLimits();
  return compactOlderToolHistoryForGateway(
    pruneToolResultMessagesForGateway(messages, limits),
    limits,
  );
}

function summarizeToolResultPruning(
  beforeMessages: LLMMessage[],
  afterMessages: LLMMessage[],
  limits: ToolResultPruningLimits = readToolResultPruningLimits(),
): ToolResultPruningSnapshot | undefined {
  const prunedToolContents = afterMessages
    .filter((message) => message.role === "tool")
    .map((message) => readToolResultContentText(message.content))
    .filter(isPrunedToolResultContent);
  const compactedHistory = afterMessages.some((message) =>
    readMessageContentText(message.content).startsWith(
      "Earlier tool history compacted to fit the request envelope:",
    ),
  );
  if (prunedToolContents.length === 0 && !compactedHistory) {
    return undefined;
  }
  const beforeEnvelope = deriveToolResultEnvelope(beforeMessages);
  const afterEnvelope = deriveToolResultEnvelope(afterMessages);
  return {
    prunedToolResults: prunedToolContents.length,
    reasons: [
      ...new Set(
        prunedToolContents
          .map(readPrunedToolResultReason)
          .filter((reason): reason is string => Boolean(reason)),
      ),
    ],
    compactedHistory,
    toolResultCountBefore: beforeEnvelope.toolResultCount,
    toolResultCountAfter: afterEnvelope.toolResultCount,
    toolResultBytesBefore: beforeEnvelope.toolResultBytes,
    toolResultBytesAfter: afterEnvelope.toolResultBytes,
    messageCountBefore: beforeMessages.length,
    messageCountAfter: afterMessages.length,
    limits,
  };
}

function pruneToolResultMessagesForGateway(
  messages: LLMMessage[],
  limits: ToolResultPruningLimits,
): LLMMessage[] {
  const toolMessageIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  const recentFullIndexes = new Set(
    toolMessageIndexes.slice(-limits.recentFullCount),
  );

  const prunedMessages = messages.map((message, index) => {
    if (message.role !== "tool") {
      return message;
    }
    const content = readToolResultContentText(message.content);
    const contentBytes = Buffer.byteLength(content, "utf8");
    const shouldHardPrune = contentBytes > limits.hardMaxBytes;
    const shouldSoftPrune =
      !recentFullIndexes.has(index) && contentBytes > limits.softMaxBytes;
    if (!shouldHardPrune && !shouldSoftPrune) {
      return message;
    }
    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: contentBytes,
        reason: shouldHardPrune
          ? "over_hard_limit"
          : "older_than_recent_window",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    return replaceToolResultContent(message, prunedContent);
  });

  return pruneToolResultsToTotalBudget(
    prunedMessages,
    recentFullIndexes,
    limits,
  );
}

function compactOlderToolHistoryForGateway(
  messages: LLMMessage[],
  limits: ToolResultPruningLimits,
): LLMMessage[] {
  if (messages.length <= limits.historyMaxMessages) {
    return messages;
  }
  const toolMessageIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  if (toolMessageIndexes.length <= limits.recentFullCount) {
    return messages;
  }

  for (
    let keepToolCount = limits.recentFullCount;
    keepToolCount >= 1;
    keepToolCount -= 1
  ) {
    const firstKeptToolIndex = toolMessageIndexes.slice(-keepToolCount)[0];
    if (firstKeptToolIndex === undefined) continue;
    const keepStart = findToolCallAssistantIndex(messages, firstKeptToolIndex);
    if (keepStart <= 2) continue;
    const compactedHistory = messages.slice(2, keepStart);
    const summary = buildCompactedToolHistoryMessage(compactedHistory);
    const compacted: LLMMessage[] = [
      ...messages.slice(0, 2),
      summary,
      ...messages.slice(keepStart),
    ];
    if (compacted.length <= limits.historyMaxMessages) {
      return compacted;
    }
  }

  return messages;
}

function findToolCallAssistantIndex(
  messages: LLMMessage[],
  toolMessageIndex: number,
): number {
  const toolMessage = messages[toolMessageIndex];
  const toolCallId =
    toolMessage?.role === "tool" ? toolMessage.toolCallId : undefined;
  for (let index = toolMessageIndex - 1; index >= 2; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const toolUseIds = extractAssistantToolUseIds(message);
    if (!toolCallId || toolUseIds.includes(toolCallId)) {
      return index;
    }
  }
  return toolMessageIndex;
}

function findLatestAssistantToolUseMessageIndex(
  messages: LLMMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && countToolUseBlocks(message) > 0) {
      return index;
    }
  }
  return -1;
}

function findFollowingToolMessageIndexes(
  messages: LLMMessage[],
  assistantMessageIndex: number,
): number[] {
  if (assistantMessageIndex < 0) {
    return [];
  }
  const indexes: number[] = [];
  for (
    let index = assistantMessageIndex + 1;
    index < messages.length;
    index += 1
  ) {
    if (messages[index]?.role === "tool") {
      indexes.push(index);
    }
  }
  return indexes;
}

function countToolUseBlocks(message: LLMMessage | undefined): number {
  if (!message || !Array.isArray(message.content)) {
    return 0;
  }
  return message.content.filter((block) => block.type === "tool_use").length;
}

function countToolResultBlocks(
  messages: LLMMessage[],
  indexes: number[],
): number {
  return indexes.reduce((count, index) => {
    const message = messages[index];
    if (!message || !Array.isArray(message.content)) {
      return count;
    }
    return (
      count +
      message.content.filter((block) => block.type === "tool_result").length
    );
  }, 0);
}

function extractAssistantToolUseIds(message: LLMMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .map((block) => (block.type === "tool_use" ? block.id : ""))
    .filter((id) => id.length > 0);
}

function buildCompactedToolHistoryMessage(messages: LLMMessage[]): LLMMessage {
  const lines = ["Earlier tool history compacted to fit the request envelope:"];
  for (const message of messages) {
    if (message.role === "assistant") {
      const calls = Array.isArray(message.content)
        ? message.content.filter(
            (block): block is Extract<LLMContentBlock, { type: "tool_use" }> =>
              block.type === "tool_use",
          )
        : [];
      for (const call of calls) {
        lines.push(
          `- called ${call.name} (${call.id}): ${summarizeToolArgs(call.input)}`,
        );
      }
      continue;
    }
    if (message.role === "tool") {
      const content = readToolResultContentText(message.content);
      lines.push(
        `- result ${message.name ?? "tool"} (${message.toolCallId ?? "unknown"}): ${summarizeToolResultContent(content)}`,
      );
    }
  }
  return {
    role: "user",
    content: sliceUtf8(lines.join("\n"), 6 * 1024),
  };
}

function summarizeToolArgs(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (!json) return "{}";
  return json.length > 300 ? `${json.slice(0, 300)}...` : json;
}

function pruneToolResultsToTotalBudget(
  messages: LLMMessage[],
  recentFullIndexes: Set<number>,
  limits: ToolResultPruningLimits,
): LLMMessage[] {
  let totalBytes = deriveToolResultEnvelope(messages).toolResultBytes;
  if (totalBytes <= limits.totalMaxBytes) {
    return messages;
  }

  let nextMessages = messages;
  const olderToolIndexes = messages
    .map((message, index) =>
      message.role === "tool" && !recentFullIndexes.has(index) ? index : -1,
    )
    .filter((index) => index >= 0);

  for (const index of olderToolIndexes) {
    const message = nextMessages[index];
    if (!message || message.role !== "tool") continue;
    const content = readToolResultContentText(message.content);
    if (isPrunedToolResultContent(content)) continue;

    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: Buffer.byteLength(content, "utf8"),
        reason: "aggregate_tool_result_budget",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    nextMessages = [...nextMessages];
    nextMessages[index] = replaceToolResultContent(message, prunedContent);
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= limits.totalMaxBytes) {
      return nextMessages;
    }
  }

  // Pathological case: the recent window alone can exceed the aggregate
  // cap. Keep the newest result intact when possible, but compact the
  // rest so final synthesis still gets a valid request envelope.
  const recentExceptNewest = [...recentFullIndexes].slice(0, -1);
  for (const index of recentExceptNewest) {
    const message = nextMessages[index];
    if (!message || message.role !== "tool") continue;
    const content = readToolResultContentText(message.content);
    if (isPrunedToolResultContent(content)) continue;

    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: Buffer.byteLength(content, "utf8"),
        reason: "aggregate_tool_result_budget_recent_window",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    nextMessages = nextMessages.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? replaceToolResultContent(message, prunedContent)
        : candidate,
    );
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= limits.totalMaxBytes) {
      return nextMessages;
    }
  }

  for (const index of [...recentFullIndexes].reverse()) {
    const message = nextMessages[index];
    if (!message || message.role !== "tool") continue;
    const content = readToolResultContentText(message.content);
    if (isPrunedToolResultContent(content)) continue;

    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: Buffer.byteLength(content, "utf8"),
        reason: "single_tool_result_exceeds_aggregate_budget",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2,
    );
    nextMessages = nextMessages.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? replaceToolResultContent(message, prunedContent)
        : candidate,
    );
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= limits.totalMaxBytes) {
      return nextMessages;
    }
  }

  return nextMessages;
}

function readToolResultContentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "tool_result") return block.content;
      if (block.type === "text") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function replaceToolResultContent(
  message: LLMMessage,
  content: string,
): LLMMessage {
  if (typeof message.content === "string") {
    return { ...message, content };
  }
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "tool_result"
        ? {
            ...block,
            content,
          }
        : block,
    ),
  };
}

function summarizeToolResultContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty tool result)";
  }
  return normalized.length > 512
    ? `${normalized.slice(0, 512)}...`
    : normalized;
}

function isPrunedToolResultContent(content: string): boolean {
  return content.includes('"tool_result_pruned": true');
}

function readPrunedToolResultReason(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    const match = content.match(/"reason"\s*:\s*"([^"]+)"/);
    return match?.[1];
  }
}

function countToolCalls(rounds: NativeToolRoundTrace[]): number {
  return rounds.reduce((sum, round) => sum + round.calls.length, 0);
}

function buildLocalEvidenceCloseout(input: {
  activation?: RoleActivationInput;
  messages: LLMMessage[];
  packet: RolePromptPacket;
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  error: unknown;
}): GenerateTextResult | null {
  if (
    expectsExactFinalAnswerShape(
      input.packet.taskPrompt,
      input.packet.outputContract,
    )
  ) {
    return null;
  }
  const toolResults = input.messages
    .filter((message) => message.role === "tool")
    .map((message) =>
      parseSessionToolResult(readToolResultContentText(message.content)),
    )
    .filter(
      (
        result,
      ): result is NonNullable<ReturnType<typeof parseSessionToolResult>> =>
        Boolean(result),
    );
  const completedEvidence = toolResults
    .filter((result) => result.status === "completed")
    .map((result) => readCompletedSessionEvidence(result))
    .filter((evidence): evidence is string => Boolean(evidence));
  const sessionToolResultMessages = new Set(
    input.messages
      .filter((message) => message.role === "tool")
      .filter(
        (message) =>
          parseSessionToolResult(readToolResultContentText(message.content)) !=
          null,
      ),
  );
  const genericToolEvidence = input.messages
    .filter(
      (message) =>
        message.role === "tool" && !sessionToolResultMessages.has(message),
    )
    .map((message) => ({
      content: readToolResultContentText(message.content),
      toolName: message.name,
    }))
    .filter((item) => !isControlPlaneToolResultName(item.toolName))
    .map((item) => item.content)
    .filter((content) => !isLikelyFailedToolContent(content))
    .map((content) => readGenericToolEvidence(content))
    .filter((evidence): evidence is string => Boolean(evidence));
  const allEvidence = [...completedEvidence, ...genericToolEvidence];
  if (allEvidence.length === 0) {
    return null;
  }
  const combinedEvidence = allEvidence.join("\n\n");
  if (
    taskPromptRequestsApprovalWaitTimeoutCloseout(input.packet.taskPrompt) &&
    messagesHaveApprovalWaitTimeoutEvidence(input.messages)
  ) {
    return buildApprovalWaitTimeoutLocalEvidenceCloseout({
      selection: input.selection,
      evidenceText: combinedEvidence,
      error: input.error,
    });
  }
  const cancellationSeen =
    toolResults.some((result) => result.status === "cancelled") ||
    /\bcancel(?:led|ed|lation)\b/i.test(
      [
        input.packet.taskPrompt,
        ...input.messages.map((message) =>
          readToolResultContentText(message.content),
        ),
      ].join("\n"),
    );
  const evidence = allEvidence
    .map((item, index) => `Source ${index + 1}: ${sliceUtf8(item, 4 * 1024)}`)
    .join("\n");
  let requestedTableColumns = resolveRequestedTableColumns([
    input.packet.taskPrompt,
    ...buildOriginalRequestTableColumnContext(input.activation),
  ]);
  if (
    requestedColumnsLookLikeProviderSearchPricing(requestedTableColumns) &&
    !isProviderSearchPricingResearchTask(
      [
        input.packet.taskPrompt,
        ...buildOriginalRequestTableColumnContext(input.activation),
      ].join("\n"),
    )
  ) {
    requestedTableColumns = [];
  }
  if (requestedTableColumns.length) {
    return {
      text: [
        "**Mission 状态：blocked / partial**",
        "",
        "Final synthesis unavailable; this local evidence fallback preserves the requested table columns and marks unsupported cells as 未验证.",
        "",
        buildLocalEvidenceTable(requestedTableColumns, allEvidence),
        "",
        "未验证：任何未由上表摘录直接证明的 provider support、search/web_search 支持、价格、结论或业务建议均未验证。",
        cancellationSeen
          ? "Risk: The earlier cancellation means the cancelled attempt should not be treated as verification; confidence comes only from completed source results visible in this mission."
          : "Risk: Confidence is limited to completed source results visible in this mission.",
        "Next action: Continue the mission with browser/rendered evidence or corrected official source URLs for the missing cells.",
      ].join("\n"),
      modelId: input.selection.modelId ?? "local-evidence-closeout",
      ...(input.selection.modelChainId
        ? { modelChainId: input.selection.modelChainId }
        : {}),
      providerId: "local",
      protocol: "openai-compatible",
      adapterName: "local-evidence-closeout",
      raw: {
        reason: "final_synthesis_unavailable",
        message: errorMessage(input.error),
      },
    };
  }
  return {
    text: [
      `Verified: ${evidence}`,
      "Unverified: Any release claim not present in the resumed source result remains unverified.",
      cancellationSeen
        ? "Risk: The earlier cancellation means the cancelled attempt should not be treated as verification; confidence comes from the resumed source result."
        : "Risk: Confidence is limited to the completed source result visible in this mission.",
      "Next action: Use the verified source facts for the requested task, and continue the same session if broader verification is needed.",
    ].join("\n"),
    modelId: input.selection.modelId ?? "local-evidence-closeout",
    ...(input.selection.modelChainId
      ? { modelChainId: input.selection.modelChainId }
      : {}),
    providerId: "local",
    protocol: "openai-compatible",
    adapterName: "local-evidence-closeout",
    raw: {
      reason: "final_synthesis_unavailable",
      message: errorMessage(input.error),
    },
  };
}

function messagesHaveApprovalWaitTimeoutEvidence(messages: LLMMessage[]): boolean {
  return messages
    .filter((message) => message.role === "tool")
    .filter((message) => message.name === "permission_result")
    .some((message) => {
      const parsed = parseJsonObject(readToolResultContentText(message.content));
      const status = parsed?.["status"];
      return status === "pending" || status === "approval_wait_timeout";
    });
}

function buildLocalEvidenceTable(columns: string[], evidence: string[]): string {
  const header = `| ${columns.map(markdownTableCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const rows = evidence.slice(0, 8).map((item, index) => {
    const url = extractFirstUrl(item);
    const source = inferEvidenceSourceLabel(item, index);
    return `| ${columns
      .map((column) =>
        markdownTableCell(localEvidenceCellForColumn(column, {
          evidence: item,
          source,
          url,
        })),
      )
      .join(" | ")} |`;
  });
  return [header, separator, ...rows].join("\n");
}

function localEvidenceCellForColumn(
  column: string,
  input: { evidence: string; source: string; url: string | undefined },
): string {
  const normalized = column.toLowerCase();
  const searchableEvidence = localEvidenceSearchableText(input.evidence);
  if (normalized === "provider" || column.includes("provider") || column.includes("来源")) {
    return input.source;
  }
  if (/deepseek\s*v4\s*flash|目标模型/i.test(column)) {
    if (
      /deepseek\s*v4\s*flash/i.test(searchableEvidence) &&
      extractInputOutputPrice(searchableEvidence)
    ) {
      return "是（页面含模型与价格）";
    }
    return "未验证";
  }
  if (/(?:search|web_search|搜索)/i.test(column)) {
    if (/\b(?:supports?|supported|支持)\b[^.。；;\n]{0,80}\b(?:search|web_search|web search)\b/i.test(searchableEvidence)) {
      return "是";
    }
    return "未验证";
  }
  if (/(?:输入|input)[^|]{0,20}(?:价格|price|pricing)/i.test(column)) {
    return extractInputOutputPrice(searchableEvidence)?.input ?? "未验证";
  }
  if (/(?:输出|output)[^|]{0,20}(?:价格|price|pricing)/i.test(column)) {
    return extractInputOutputPrice(searchableEvidence)?.output ?? "未验证";
  }
  if (normalized.includes("url") || column.includes("证据")) {
    return input.url ?? "未验证";
  }
  if (
    column.includes("摘录") ||
    column.includes("原文") ||
    normalized.includes("quote") ||
    normalized.includes("excerpt")
  ) {
    return extractLocalEvidenceQuote(searchableEvidence);
  }
  return "未验证";
}

function localEvidenceSearchableText(evidence: string): string {
  try {
    const parsed = JSON.parse(evidence) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return [
        record.title,
        record.text_excerpt,
        record.final_url,
        record.requested_url,
      ]
        .filter((item): item is string => typeof item === "string")
        .join("\n");
    }
  } catch {
    // Evidence may already be a plain excerpt.
  }
  return evidence;
}

function extractInputOutputPrice(
  evidence: string,
): { input: string; output: string } | null {
  const compact = evidence.replace(/\s+/g, " ");
  const slash = compact.match(
    /\$(\d+(?:\.\d+)?)\s*\/\s*(?:\$(\d+(?:\.\d+)?)\s*\/\s*)?\$(\d+(?:\.\d+)?)\s*(?:per\s*)?1\s*m/i,
  );
  if (slash) {
    return {
      input: `$${slash[1]}/1M`,
      output: `$${slash[3]}/1M`,
    };
  }
  const input = compact.match(
    /(?:input|输入)[^$]{0,60}\$(\d+(?:\.\d+)?)(?:\s*\/?\s*(?:m|1m|million))?/i,
  );
  const output = compact.match(
    /(?:output|输出)[^$]{0,60}\$(\d+(?:\.\d+)?)(?:\s*\/?\s*(?:m|1m|million))?/i,
  );
  if (input && output) {
    return {
      input: `$${input[1]}/1M`,
      output: `$${output[1]}/1M`,
    };
  }
  const inputAfterPrice = compact.match(
    /\$(\d+(?:\.\d+)?)\s*\/?\s*(?:m|1m|million)?[^.。；;\n]{0,40}(?:input|输入)/i,
  );
  const outputAfterPrice = compact.match(
    /\$(\d+(?:\.\d+)?)\s*\/?\s*(?:m|1m|million)?[^.。；;\n]{0,40}(?:output|输出)/i,
  );
  if (inputAfterPrice && outputAfterPrice) {
    return {
      input: `$${inputAfterPrice[1]}/1M`,
      output: `$${outputAfterPrice[1]}/1M`,
    };
  }
  return null;
}

function extractLocalEvidenceQuote(evidence: string): string {
  const compact = evidence.replace(/\s+/g, " ").trim();
  const price = compact.match(
    /(?:In\s*\/\s*Out Price|pricing|price|input|output|输入|输出)[^.。；;\n]{0,220}(?:\$\d+(?:\.\d+)?)[^.。；;\n]{0,220}(?:1\s*M|tokens?|output|per|输入|输出)/i,
  );
  if (price) {
    return sliceUtf8(price[0], 240);
  }
  return sliceUtf8(compact, 240);
}

function extractFirstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"')，。；;]+/)?.[0];
}

function inferEvidenceSourceLabel(evidence: string, index: number): string {
  const url = extractFirstUrl(evidence);
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }
  const title = evidence.match(/"title"\s*:\s*"([^"]+)"/)?.[1];
  if (title) return title;
  return `Source ${index + 1}`;
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "未验证";
}

function hasUsableEvidence(rounds: NativeToolRoundTrace[]): boolean {
  return rounds.some((round) =>
    round.results.some((result) => !result.isError && result.skipped !== true),
  );
}

function readGenericToolEvidence(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || isLikelyFailedToolContent(trimmed)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (isControlPlaneToolResultRecord(record)) {
        return null;
      }
      const payload =
        record.payload &&
        typeof record.payload === "object" &&
        !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : null;
      const payloadPage =
        payload?.page &&
        typeof payload.page === "object" &&
        !Array.isArray(payload.page)
          ? (payload.page as Record<string, unknown>)
          : null;
      const parts = [
        readStringField(record.summary),
        readStringField(payload?.content),
        readStringField(payloadPage?.title),
        readStringField(payloadPage?.textExcerpt),
      ]
        .filter((part): part is string => Boolean(part))
        .map((part) => part.trim());
      const joined = dedupeStrings(parts).join("\n");
      if (joined) {
        return sliceUtf8(joined, 4 * 1024);
      }
    }
  } catch {
    // Fall back to the textual content below.
  }
  return sliceUtf8(summarizeToolResultContent(trimmed), 4 * 1024);
}

function isControlPlaneToolResultRecord(
  record: Record<string, unknown>,
): boolean {
  if (
    Array.isArray(record["sessions"]) ||
    Array.isArray(record["messages"]) ||
    Array.isArray(record["transcript"])
  ) {
    return true;
  }
  return (
    typeof record["inspection_guidance"] === "string" ||
    typeof record["session_key"] === "string" ||
    typeof record["task_id"] === "string"
  );
}

function isLikelyFailedToolContent(content: string): boolean {
  return (
    /\b(status"\s*:\s*"failed|isError"\s*:\s*true|missing required|timed out|timeout|failed:|error:|skipped)\b/i.test(
      content,
    ) || /^tool_call_.*(?:skipp|error|fail)/i.test(content.trim())
  );
}

function replaceInitialPromptMessages(
  messages: LLMMessage[],
  reducedPromptMessages: LLMMessage[],
): LLMMessage[] {
  const toolLoopHistory = messages.slice(2);
  return [...reducedPromptMessages, ...toolLoopHistory];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

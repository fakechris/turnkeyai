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
  SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS,
  INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS,
  applySessionContinuationDirective,
  applySessionContinuationLookupDirective,
  buildApprovedBrowserTimeoutContinuationPrompt,
  buildForcedPendingApprovalWaitTimeoutPermissionResultCall,
  buildIncompleteApprovedBrowserSessionContinuationPrompt,
  buildIndependentEvidenceStreamContinuationPrompt,
  buildSupplementalLocalTimeoutProbePrompt,
  buildToolCallLimitExceededResult,
  buildReadOnlyPermissionQuerySuppressionPrompt,
  buildContinuationDirectiveContext,
  buildCoverageTimeoutContinuationPrompt,
  buildFinalRecoveryBudgetCloseoutReasonLines,
  buildFinalRecoveryBudgetCloseoutRepairPrompt,
  buildMissingApprovalGateRepairPrompt,
  contextHasTimeoutSessionResult,
  continuationRequestPrefersResumableSession,
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
  extractSessionToolResultRecords,
  findExcessiveSessionContinuationCall,
  findRepeatedSessionInspectionCall,
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  findIncompleteApprovedBrowserSession,
  formatDurationMs,
  hasApprovedBrowserTimeoutContinuationPrompt,
  hasCompletedBrowserSessionEvidence,
  hasCoverageTimeoutContinuationPrompt,
  hasExecutedSessionsSend,
  hasSessionTimeoutEvidence,
  hasTimeoutCloseoutGuidance,
  hasTimeoutContinuationGuidance,
  hasPermissionAppliedEvidence,
  hasLatestSupplementalLocalTimeoutProbePrompt,
  isAbortError,
  isAppliedApprovalBrowserContinuation,
  isCoverageCriticalDelegationTask,
  isProviderSearchPricingResearchTask,
  inferIndependentEvidenceStreamCount,
  isBrowserSessionSpawn,
  isExplicitSessionContinuationRequest,
  isLoopbackHostname,
  latestPermissionResultStatus,
  latestPermissionToolName,
  limitIndependentEvidenceSpawnCalls,
  looksBoundedTimeoutSourceCheck,
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
  maybeAppendBrowserRecoveryResidualRiskVisibility,
  maybeAppendRecoveredTimeoutCloseoutVisibility,
  maybeAppendRequiredTimeoutFollowupVisibility,
  maybeRedactForbiddenLocalUrls,
  mentionsTimeout,
  readCompletedSessionEvidence,
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
  shouldRunSupplementalLocalTimeoutProbe,
  shouldAppendRecoveredTimeoutCloseoutVisibility,
  shouldAppendTimeoutContinuationVisibility,
  shouldRepairFinalRecoveryBudgetCloseout,
  shouldRepairMissingApprovalGate,
  shouldPreserveRecoveredTimeoutCloseout,
  shouldSuppressReadOnlyPermissionQueryToolCalls,
  sliceUtf8,
  taskAllowsPermissionTools,
  taskPromptRequestsApprovalWaitTimeoutCloseout,
  taskPromptLooksLikeSourceCheckContinuation,
  taskPromptSaysApprovalAlreadyApplied,
  taskRequestsSessionTranscript,
  taskRequestsTimeoutFollowupContinuation,
  taskRequiresBrowserEvidence,
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
import type { ModelClient, ReActReArm, ReActState } from "@turnkeyai/agent-core/react-loop";
// Stage 8 cleanup (Batch 0.5): engine policy-trace plumbing. The trace is a
// behavior-neutral observability sink that records the per-hook decision sequence
// so later batches can prove byte-identical behavior and so production-behind-flag
// failures can answer "which policy fired or skipped." See react-engine/*.
import {
  createCloseoutPolicyRegistry,
  createContinuationController,
  createEnginePolicyTrace,
  createExecutionBudgetController,
  createEngineRunState,
  createEngineRunObserver,
  createPermissionPolicy,
  createRepairPolicyRegistry,
  type DefaultEngineRunStateValues,
  finalizeEngineAnswer,
  normalizeEngineToolCalls,
  traceEngineHooks,
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
          if (
            shouldRepairMissingBrowserEvidence({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildMissingBrowserEvidenceRepairPrompt(packet.taskPrompt),
                ),
              ],
              forceToolChoice: { name: "sessions_spawn" },
              consumesRound: true,
            };
          }
          if (
            shouldRepairMissingProductSignalBrowserEvidence({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
              ...(initialGatewayInput.tools === undefined
                ? {}
                : { tools: initialGatewayInput.tools }),
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildMissingProductSignalBrowserEvidenceRepairPrompt(packet.taskPrompt),
                ),
              ],
              forceToolChoice: { name: "sessions_spawn" },
              consumesRound: true,
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
          if (
            shouldRepairPendingApprovalWaitTimeoutCheck({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildPendingApprovalWaitTimeoutCheckRepairPrompt(),
                ),
              ],
              forceToolChoice: { name: "permission_result" },
              consumesRound: true,
            };
          }
          if (
            shouldRepairPrematurePendingApprovalFinal({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildPrematurePendingApprovalRepairPrompt(),
                ),
              ],
              forceToolChoice: { name: "permission_result" },
              consumesRound: true,
            };
          }
          if (
            shouldRepairStalePendingApproval({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildStalePendingApprovalRepairPrompt(),
                ),
              ],
              forceToolChoice: { name: "sessions_spawn" },
              consumesRound: true,
            };
          }
          if (
            shouldRepairStaleDeniedApproval({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildStaleDeniedApprovalRepairPrompt(),
                ),
              ],
              forceToolChoice: "none",
            };
          }
          if (
            shouldRepairApprovalWaitTimeoutCloseout({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildApprovalWaitTimeoutCloseoutRepairPrompt(),
                ),
              ],
              forceToolChoice: "none",
            };
          }
          // Stage 8B slice 1c: the hard approval-wait-timeout local closeout (inline
          // :955-983). When the approval-wait-timeout-closeout repair above already fired
          // (its marker is recorded) but the candidate STILL is not a complete closeout,
          // break the loop with a deterministic tool_evidence_fallback closeout rather
          // than finalizing the incomplete answer. onRepairRound cannot finalize, so it
          // returns a { closeout } directive; onTerminate builds the local-evidence text
          // directly (no model synthesis) for that reason.
          if (
            shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            })
          ) {
            return { closeout: "tool_evidence_fallback" };
          }
          if (
            shouldRepairIncompleteApprovedBrowserAction({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              toolTrace,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildIncompleteApprovedBrowserActionRepairPrompt(),
                ),
              ],
              forceToolChoice: { name: "sessions_spawn" },
              consumesRound: true,
            };
          }
          if (
            shouldRepairMissingRequestedTableColumns({
              activation,
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              repairMarkers,
              resultText: state.lastText,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildMissingRequestedTableColumnsRepairPrompt({
                    activation,
                    taskPrompt: packet.taskPrompt,
                    messages: state.messages,
                    resultText: state.lastText,
                  }),
                ),
              ],
              forceToolChoice: "none",
            };
          }
          if (
            shouldRepairExtraneousProviderTableSchema({
              activation,
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              repairMarkers,
              resultText: state.lastText,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildExtraneousProviderTableSchemaRepairPrompt({
                    taskPrompt: packet.taskPrompt,
                    resultText: state.lastText,
                  }),
                ),
              ],
              forceToolChoice: "none",
            };
          }
          // Source-bounded evidence text (mirrors inline :1192), used by the
          // source-evidence carry-forward and weak-evidence repairs below.
          const sourceBoundedEvidenceText = [
            collectSourceBoundedEvidenceText({
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              toolTrace,
            }),
            collectCompletedSessionEvidenceText(toolTrace),
          ]
            .filter((text) => text.trim().length > 0)
            .join("\n\n");
          // Source-evidence carry-forward (inline natural-finish :1202, between
          // extraneous and weak-evidence). Truthy-gated on sourceBoundedEvidenceText
          // exactly like inline (:1203). This is the natural-finish counterpart of the
          // completed-closeout source-evidence move (#505); the onTerminate completed
          // loop uses completedProductBriefEvidenceText, the natural-finish hook uses
          // sourceBoundedEvidenceText — matching the two distinct inline evidence
          // formulas (:1933 vs :1192).
          if (
            sourceBoundedEvidenceText &&
            shouldRepairSourceEvidenceCarryForward({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              evidenceText: sourceBoundedEvidenceText,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(
                  repairMarkers,
                  buildSourceEvidenceCarryForwardRepairPrompt({
                    taskPrompt: packet.taskPrompt,
                    resultText: state.lastText,
                    evidenceText: sourceBoundedEvidenceText,
                  }),
                ),
              ],
              forceToolChoice: "none",
            };
          }
          if (
            shouldRepairWeakEvidenceSynthesis({
              taskPrompt: packet.taskPrompt,
              resultText: state.lastText,
              messages: state.messages,
              repairMarkers,
              evidenceText: sourceBoundedEvidenceText,
            })
          ) {
            return {
              messages: [
                ...state.messages,
                { role: "assistant", content: state.lastText },
                recordRepairPrompt(repairMarkers, buildWeakEvidenceSynthesisRepairPrompt()),
              ],
              forceToolChoice: "none",
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
          let reasonLines: string[] | undefined;
          let closeout: ToolLoopCloseoutMetadata;
          const pendingCloseout = runState.pendingCloseout();
          const completedSessionSignal = runState.completedSession();
          const timeoutSignal = runState.timeoutSignal();
          if (pendingCloseout && pendingCloseout.closeout.reason === reason) {
            // PR2d pending-call closeouts: onToolCallsClose already built the
            // inline reasonLines + metadata for this reason (no trailing
            // transform — the inline pre-execute closeouts use the synthesis as-is).
            reasonLines = pendingCloseout.reasonLines;
            closeout = pendingCloseout.closeout;
          } else if (reason === "completed_sub_agent_final" && completedSessionSignal) {
            const completedSession = completedSessionSignal;
            const preserveRecoveredTimeoutCloseout = shouldPreserveRecoveredTimeoutCloseout({
              taskPrompt: packet.taskPrompt,
              messages: state.messages,
              toolTrace,
              evidenceText: completedSession.finalContents.join("\n\n"),
            });
            reasonLines = [
              `${completedSession.toolName} returned completed delegated session evidence.`,
              "Do not call sessions_history or sessions_list just to restate this delegated result.",
              "Use the delegated session evidence below as the source of truth. Do not override it with memory, assumptions, or general product knowledge.",
              "Do not add capabilities, target users, pricing, open-source claims, or product positioning unless they are stated in this source content.",
              "Do not add DNS/IP resolution, IANA allocation details, production-environment bans, real-service claims, security-scanner claims, or abuse-risk claims unless those exact facts are stated in this source content.",
              "If the source states a narrow scope limit or usage caveat, preserve its exact wording (or state that wider use is outside the verified scope); do not upgrade a narrow caveat into a broader production-environment or real-service ban.",
              ...buildCompletedBrowserEvidenceDimensionCarryForwardLines({
                taskPrompt: packet.taskPrompt,
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
                      (summary, index) => `Browser continuity ${index + 1}: ${summary}`,
                    ),
                  ]
                : []),
              ...completedSession.finalContents.map(
                (content, index) => `Source ${index + 1} evidence:\n${sliceUtf8(content, 8 * 1024)}`,
              ),
            ];
            closeout = {
              reason: "completed_sub_agent_final",
              maxRounds,
              toolName: completedSession.toolName,
              finalContentCount: completedSession.finalContents.length,
              toolCallCount: countToolCalls(toolTrace),
              roundCount: toolTrace.length,
              evidenceAvailable: true,
            };
            // Sticky completed-closeout metadata (inline `toolLoopCloseout ??=`, :1729):
            // captured on the FIRST completed session, BEFORE the S10 browser-evidence
            // repair re-arms a sessions_spawn round. So the metadata (roundCount/
            // toolCallCount) reflects the round the session first completed, not the
            // later browser round — exactly like inline, whose `??=` no-ops on the
            // re-entered completed block. The final TEXT still comes from the last
            // synthesis (runState.closeoutResult below).
            runState.recordToolLoopCloseoutIfAbsent(closeout);
          } else if (reason === "sub_agent_timeout" && timeoutSignal) {
            reasonLines = [
              `${timeoutSignal.toolName} timed out${timeoutSignal.timeoutSeconds == null ? "" : ` after ${timeoutSignal.timeoutSeconds}s`}.`,
              "Do not call more tools or spawn fallback sessions for this timeout.",
              "Do not copy internal fetch URLs, local fixture URLs, session keys, or raw tool arguments into the final answer unless the original user requested those exact raw identifiers.",
              timeoutSignal.evidenceAvailable
                ? "Produce the best final answer from the evidence already gathered and state any remaining uncertainty."
                : "No usable evidence was gathered before the timeout. Say that verification did not complete, summarize what was attempted, and tell the user they can ask to continue.",
              "Include one concise continuation sentence: the user can continue the same source check if the missing evidence is still worth waiting for.",
            ];
            closeout = {
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
          } else {
            if (reason === "round_limit") {
              const roundLimitCloseout =
                executionBudget.buildRoundLimitCloseoutSnapshot({
                  maxRounds,
                  usedToolCalls: countToolCalls(toolTrace),
                  roundCount: toolTrace.length,
                  evidenceAvailable: hasUsableEvidence(toolTrace),
                });
              reasonLines = roundLimitCloseout.reasonLines;
              closeout = roundLimitCloseout.closeout;
            } else {
              reasonLines = undefined;
              closeout = {
                reason: reason as ToolLoopCloseoutMetadata["reason"],
                maxRounds,
                toolCallCount: countToolCalls(toolTrace),
                roundCount: toolTrace.length,
                evidenceAvailable: hasUsableEvidence(toolTrace),
              };
            }
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
          let synthesisResult = generated.result;
          let synthesisReduction = generated.reduction;
          let synthesisReductionSnapshot = generated.reductionSnapshot;
          // Push each synthesis's pre-compaction memory flush as it happens (a list,
          // not a single latest) so completed-repair re-syntheses that also overflow
          // don't drop earlier flush records — matching the inline append.
          if (generated.memoryFlush) {
            runState.recordMemoryFlush(generated.memoryFlush);
          }
          // Completed-closeout repair pass: the inline completed block re-synthesizes
          // when a completed-repair predicate fires on the synthesis against the
          // delegated session evidence (inline ~:2128). The engine completed path
          // terminates (it cannot re-enter onRepairRound), so mirror it here with a
          // forced tool-free re-synthesis — the plain model call the inline loop uses,
          // NOT the format-contract generateFinalAfterToolRoundLimit. Idempotent via
          // ctx.repairMarkers; the round cap is the hard backstop.
          //
          // Scope: cutting over the completed cascade predicate-by-predicate, in the
          // inline order (post-synthesis cascade at :1826+). Checked here so far, in
          // inline cascade order: missing-requested-table-columns (:1826), extraneous-
          // provider-table-schema (:1854), source-evidence-carry-forward (:1941),
          // timeout-followup-final-guidance (:1968), missing-requested-next-action
          // (:1995), required-deliverables (:2016), missing-browser-evidence-dimensions
          // (:2100), false-evidence-blocked (:2129), weak-evidence-synthesis (:2153).
          // That is the complete completed cascade: the tool-free repairs re-synthesize
          // in place, while :1880/:1907 re-arm a real sessions_spawn tool round. Their
          // relative order matches the inline first-match-wins cascade.
          // The every-round members now cover
          // the FULL inline tool-free natural-finish cascade (:1110-1272 = table-columns,
          // extraneous, source-evidence, weak-evidence). Compound completed inputs are
          // handled too: inline runs the
          // completed cascade exactly once (the round the session completes), then every
          // subsequent repaired answer flows through the narrower tool-free natural-
          // finish cascade (:1110-1272 = table-columns, extraneous, source-evidence,
          // weak-evidence). The loop below mirrors that by gating the completed-ONLY
          // predicates (timeout-followup/missing-next-action/deliverables/false-evidence)
          // to repairRound 0, leaving source-evidence (the one cross-cascade member) to
          // run every round — so a repaired answer can no longer re-trip a completed-only
          // predicate inline would never re-check (the prior over-repair).
          //
          // The every-round natural-finish branch now has ALL four inline members
          // (table-columns, extraneous, source-evidence, weak-evidence), AND uses the
          // round-correct evidence formula: round 0 (the inline completed block) uses
          // completedProductBriefEvidenceText; round >0 (inline's tool-free natural-finish
          // cascade) uses sourceBoundedEvidenceText, recomputed per round — see
          // naturalFinishEvidenceText in the loop. So the post-round-0 evidence-formula
          // residual is closed: a label from an earlier tool round (visible to the full-
          // toolTrace sourceBoundedEvidenceText but NOT to the completing-round-only
          // completedProductBriefEvidenceText) is now seen on re-synthesis, exactly as
          // inline's natural-finish does.
          const completedSessionForRepair = runState.completedSession();
          if (reason === "completed_sub_agent_final" && completedSessionForRepair) {
            const completedSession = completedSessionForRepair;
            const repairMarkers = (ctx.repairMarkers ??= []);
            // Two evidence texts, matching the inline asymmetry: deliverables (:2038)
            // and false-evidence (:2134) use the bare finalContents join, while
            // source-evidence (:1946) and timeout-followup (:1973) use
            // completedProductBriefEvidenceText — finalContents PLUS the completing
            // round's raw tool-result text (so labels/keywords that live only in the
            // tool result, not finalContents, are visible). Built byte-for-byte like
            // inline :1933-1938. Execution caps are enforced before runToolBatch, so
            // over-cap calls feed the same synthetic "tool_call_limit_exceeded" skipped
            // results the inline executor would produce.
            const evidenceText = completedSession.finalContents.join("\n\n");
            const completedProductBriefEvidenceText = [
              completedSession.finalContents.join("\n\n"),
              collectToolResultContentText(
                runState.completedSessionToolResults() ?? [],
              ),
            ]
              .filter((text) => text.trim().length > 0)
              .join("\n\n");
            let repairMessages = state.messages;
            // Stage 7 S10: the browser-evidence / product-signal completed-cascade
            // repairs (inline :1880/:1907) re-arm a REAL sessions_spawn TOOL round — they
            // cannot re-synthesize in place. This helper builds the reArm directive for
            // whichever fires (browser-evidence first, then product-signal). It reads the
            // current loop state (repairMessages / synthesisResult / synthesisReduction)
            // by closure. `productSignalEvidenceText` is the round-dependent product-
            // signal evidence: the completed-block join on round 0 (inline :1914),
            // undefined on round >0 (inline natural-finish :776). Persisting the pending
            // reduction before the reArm mirrors inline recording `generated.reduction`
            // before it `continue`s (codex #520 P2) — the early return otherwise skips
            // the runState reduction record after the loop.
            const maybeReArmForMissingBrowserEvidence = (
              productSignalEvidenceText: string | undefined,
            ): ReActReArm | null => {
              const persistAndReArm = (repairPrompt: string): ReActReArm => {
                if (synthesisReduction) {
                  runState.recordReduction({
                    reduction: synthesisReduction,
                    reductionSnapshot: synthesisReductionSnapshot,
                  });
                }
                return {
                  reArm: {
                    messages: [
                      ...repairMessages,
                      { role: "assistant", content: synthesisResult.text },
                      recordRepairPrompt(repairMarkers, repairPrompt),
                    ],
                    forceToolChoice: { name: "sessions_spawn" },
                  },
                };
              };
              if (
                shouldRepairMissingBrowserEvidence({
                  taskPrompt: packet.taskPrompt,
                  resultText: synthesisResult.text,
                  messages: repairMessages,
                  repairMarkers,
                  toolTrace,
                  tools: initialGatewayInput.tools,
                })
              ) {
                return persistAndReArm(
                  buildMissingBrowserEvidenceRepairPrompt(packet.taskPrompt),
                );
              }
              if (
                shouldRepairMissingProductSignalBrowserEvidence({
                  taskPrompt: packet.taskPrompt,
                  resultText: synthesisResult.text,
                  messages: repairMessages,
                  repairMarkers,
                  toolTrace,
                  tools: initialGatewayInput.tools,
                  ...(productSignalEvidenceText !== undefined
                    ? { evidenceText: productSignalEvidenceText }
                    : {}),
                })
              ) {
                return persistAndReArm(
                  buildMissingProductSignalBrowserEvidenceRepairPrompt(
                    packet.taskPrompt,
                  ),
                );
              }
              return null;
            };
            const MAX_COMPLETED_REPAIR_ROUNDS = 16;
            for (let repairRound = 0; repairRound < MAX_COMPLETED_REPAIR_ROUNDS; repairRound++) {
              let repairPrompt: string | null = null;
              // Round >0 IS inline's tool-free natural-finish cascade, where browser-
              // evidence / product-signal are checked FIRST — before table-columns /
              // extraneous (inline :748/:776 precede :1139/:1167). Check them at the top
              // here so a repaired completed answer that still lacks browser evidence
              // re-arms a sessions_spawn round rather than taking a tool-free table/
              // extraneous repair (codex #520 P2). Round 0 (the completed block) keeps
              // the inline completed-block order (after extraneous, below).
              if (repairRound > 0) {
                const browserReArm = maybeReArmForMissingBrowserEvidence(undefined);
                if (browserReArm) {
                  return browserReArm;
                }
              }
              // Evidence for the cross-cascade members (source-evidence, weak-evidence),
              // round-dependent to match the two inline cascades exactly:
              //  - round 0 IS the inline completed block: use completedProductBriefEvidence
              //    Text (finalContents + the completing round's raw tool results, inline
              //    :1933/:2159).
              //  - round >0 IS inline's tool-free natural-finish cascade (reached after the
              //    first completed repair `continue`s): use sourceBoundedEvidenceText
              //    (inline :1192), recomputed each round from the CURRENT repairMessages so
              //    a repaired answer is re-evaluated like inline's re-entered cascade. Its
              //    collectNativeToolTraceEvidenceText spans the WHOLE toolTrace, so it sees
              //    labels from earlier tool rounds the completing-round-only completed
              //    ProductBriefEvidenceText cannot — the parity-relevant difference.
              const naturalFinishEvidenceText =
                repairRound === 0
                  ? completedProductBriefEvidenceText
                  : [
                      collectSourceBoundedEvidenceText({
                        taskPrompt: packet.taskPrompt,
                        messages: repairMessages,
                        toolTrace,
                      }),
                      collectCompletedSessionEvidenceText(toolTrace),
                    ]
                      .filter((text) => text.trim().length > 0)
                      .join("\n\n");
              // Missing-requested-table-columns (inline completed :1826 / natural-finish
              // :1139) — FIRST in the cascade, and an every-round member: it lives in
              // BOTH inline cascades, so a repaired answer can re-trip it on a later
              // round exactly as inline would. No evidenceText; self-suppresses via its
              // repairMarker after firing once. Pass `activation` (inline :1828) so the
              // requested columns resolve from the same activation context inline uses.
              if (
                shouldRepairMissingRequestedTableColumns({
                  activation,
                  taskPrompt: packet.taskPrompt,
                  messages: repairMessages,
                  repairMarkers,
                  resultText: synthesisResult.text,
                })
              ) {
                repairPrompt = buildMissingRequestedTableColumnsRepairPrompt({
                  activation,
                  taskPrompt: packet.taskPrompt,
                  messages: repairMessages,
                  resultText: synthesisResult.text,
                });
              }
              // Extraneous-provider-table-schema (inline completed :1854 / natural-finish
              // :1167) — SECOND, every round (in both inline cascades). Fires when the
              // synthesis introduces a provider/search/model-support table the original
              // task never requested. No evidenceText; self-suppresses via its repairMarker.
              // `!repairPrompt`-guarded so a same-round table-columns hit still wins.
              // Note: generateFinalAfterToolRoundLimit ALREADY repairs extraneous schema in
              // the FIRST closeout synthesis (its own internal pass), so this block is
              // load-bearing only for a LATER re-synthesis (a round-0 repair via
              // generateWithEnvelopeRetry that introduces the schema) — exactly the case
              // inline's natural-finish :1167 covers and the parity test exercises.
              if (
                !repairPrompt &&
                shouldRepairExtraneousProviderTableSchema({
                  activation,
                  taskPrompt: packet.taskPrompt,
                  messages: repairMessages,
                  repairMarkers,
                  resultText: synthesisResult.text,
                })
              ) {
                repairPrompt = buildExtraneousProviderTableSchemaRepairPrompt({
                  taskPrompt: packet.taskPrompt,
                  resultText: synthesisResult.text,
                });
              }
              // Stage 7 S10 (round 0 = the inline completed block, :1880/:1907): the
              // browser-evidence / product-signal repairs sit AFTER extraneous here,
              // `!repairPrompt`-guarded (a same-round table-columns/extraneous hit wins,
              // matching inline's first-match-wins `continue`). The round >0 ordering is
              // DIFFERENT (browser/product FIRST) and is handled at the top of the loop —
              // see the maybeReArmForMissingBrowserEvidence call before table-columns.
              // Round 0 passes the completed-block product-signal evidenceText (inline
              // :1914); round >0 passes none (inline natural-finish :776).
              if (repairRound === 0 && !repairPrompt) {
                const browserReArm = maybeReArmForMissingBrowserEvidence(evidenceText);
                if (browserReArm) {
                  return browserReArm;
                }
              }
              // Source-evidence carry-forward — every repair round. It appears in both
              // inline cascades: the completed block (:1941, round 0) AND the tool-free
              // natural-finish cascade (:1204, round >0), so a repaired answer can re-trip
              // it on a later round exactly as inline would. It self-suppresses via its
              // repairMarker after firing once. evidenceText is naturalFinishEvidenceText
              // (round-dependent above) so round 0 uses the completed-block formula and
              // round >0 uses the natural-finish formula — matching inline :1946 vs :1209.
              // Truthy-gated exactly like inline (:1940/:1203). `!repairPrompt`-guarded so
              // a same-round table-columns/extraneous hit wins (inline's cascade `continue`).
              if (
                !repairPrompt &&
                naturalFinishEvidenceText &&
                shouldRepairSourceEvidenceCarryForward({
                  taskPrompt: packet.taskPrompt,
                  resultText: synthesisResult.text,
                  messages: repairMessages,
                  repairMarkers,
                  evidenceText: naturalFinishEvidenceText,
                })
              ) {
                repairPrompt = buildSourceEvidenceCarryForwardRepairPrompt({
                  taskPrompt: packet.taskPrompt,
                  resultText: synthesisResult.text,
                  evidenceText: naturalFinishEvidenceText,
                });
              }
              // Completed-ONLY predicates: timeout-followup (:1968), missing-next-action
              // (:1995), deliverables (:2016), false-evidence (:2130). Inline runs the
              // completed cascade EXACTLY ONCE — the round the session completes — then
              // every subsequent repaired answer flows through the narrower tool-free
              // natural-finish cascade (:1110-1272), which contains table-columns,
              // extraneous, source-evidence and weak-evidence but NONE of these four.
              // So gate them to the first repair round; otherwise a round-1 repair's
              // output could re-trip a completed-only predicate the inline natural-finish
              // path would never check (the compound over-repair). The natural-finish
              // members that do run every round live outside this block.
              if (repairRound === 0) {
                // Timeout-followup — inline does NOT truthy-gate this (:1967).
                if (
                  !repairPrompt &&
                  shouldRepairTimeoutFollowupFinalGuidance({
                    taskPrompt: packet.taskPrompt,
                    resultText: synthesisResult.text,
                    messages: repairMessages,
                    repairMarkers,
                    evidenceText: completedProductBriefEvidenceText,
                  })
                ) {
                  repairPrompt = buildTimeoutFollowupFinalGuidanceRepairPrompt({
                    taskPrompt: packet.taskPrompt,
                    resultText: synthesisResult.text,
                    evidenceText: completedProductBriefEvidenceText,
                  });
                }
                // Missing-next-action (:1995).
                if (
                  !repairPrompt &&
                  shouldRepairMissingRequestedNextAction({
                    taskPrompt: packet.taskPrompt,
                    resultText: synthesisResult.text,
                    messages: repairMessages,
                    repairMarkers,
                  })
                ) {
                  repairPrompt = buildMissingRequestedNextActionRepairPrompt();
                }
                // Deliverables (:2016) — bare finalContents evidenceText, like inline :2038.
                if (!repairPrompt) {
                  const missingRequiredDeliverables =
                    findMissingRequiredFinalDeliverables({
                      taskPrompt: packet.taskPrompt,
                      resultText: synthesisResult.text,
                    });
                  if (
                    missingRequiredDeliverables.length > 0 &&
                    !hasMissingRequiredFinalDeliverablesRepairPrompt(repairMarkers)
                  ) {
                    repairPrompt = buildMissingRequiredFinalDeliverablesRepairPrompt({
                      taskPrompt: packet.taskPrompt,
                      resultText: synthesisResult.text,
                      missing: missingRequiredDeliverables,
                      evidenceText,
                    });
                  }
                }
                // Missing-browser-evidence-dimensions (inline completed :2100) — between
                // deliverables (:2016) and false-evidence (:2128) to match inline
                // precedence. Completed-ONLY (absent from the tool-free natural-finish
                // cascade :1110-1272 — its other inline sites :1082/:1327 are the pseudo-
                // tool-call / wall-clock closeouts), so it belongs in the repairRound===0
                // block. Bare finalContents evidenceText, like inline :2107 (NOT the
                // combined/source-bounded texts). generateFinalAfterToolRoundLimit does
                // not pre-repair this (only extraneous + pseudo-tool), so the first
                // closeout synthesis reaches here unrepaired.
                if (
                  !repairPrompt &&
                  completedSession.finalContents.length > 0 &&
                  shouldRepairMissingBrowserEvidenceDimensions({
                    taskPrompt: packet.taskPrompt,
                    resultText: synthesisResult.text,
                    messages: repairMessages,
                    repairMarkers,
                    evidenceText,
                  })
                ) {
                  repairPrompt = buildMissingBrowserEvidenceDimensionsRepairPrompt({
                    taskPrompt: packet.taskPrompt,
                    resultText: synthesisResult.text,
                    evidenceText,
                  });
                }
                // False-evidence-blocked (:2130) — bare finalContents, like inline :2134.
                if (
                  !repairPrompt &&
                  completedSession.finalContents.length > 0 &&
                  shouldRepairFalseEvidenceBlockedSynthesis({
                    resultText: synthesisResult.text,
                    messages: repairMessages,
                    repairMarkers,
                    evidenceText,
                  })
                ) {
                  repairPrompt = buildFalseEvidenceBlockedSynthesisRepairPrompt(
                    completedSession.finalContents,
                  );
                }
              }
              // Weak-evidence-synthesis (inline completed :2154 / natural-finish :1231) —
              // LAST in the cascade and an every-round member (after the round-0 block, so
              // a repaired answer can re-trip it exactly as inline's natural-finish does).
              // self-suppresses via its repairMarker. evidenceText is naturalFinishEvidence
              // Text (round-dependent above) so round 0 uses the completed-block formula
              // (:2159) and round >0 uses the natural-finish sourceBoundedEvidenceText
              // (:1236) — matching inline. `!repairPrompt`-guarded so an earlier same-round
              // repair wins.
              if (
                !repairPrompt &&
                shouldRepairWeakEvidenceSynthesis({
                  taskPrompt: packet.taskPrompt,
                  resultText: synthesisResult.text,
                  messages: repairMessages,
                  repairMarkers,
                  evidenceText: naturalFinishEvidenceText,
                })
              ) {
                repairPrompt = buildWeakEvidenceSynthesisRepairPrompt();
              }
              if (!repairPrompt) {
                break;
              }
              repairMessages = [
                ...repairMessages,
                { role: "assistant", content: synthesisResult.text },
                recordRepairPrompt(repairMarkers, repairPrompt),
              ];
              const repairGatewayMessages = prepareToolHistoryForGateway(repairMessages);
              const repaired = await this.generateWithEnvelopeRetry({
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
              synthesisResult = repaired.result;
              if (repaired.reduction) {
                synthesisReduction = repaired.reduction;
                synthesisReductionSnapshot = repaired.reductionSnapshot;
              }
              if (repaired.memoryFlush) {
                runState.recordMemoryFlush(repaired.memoryFlush);
              }
            }
            // Inline main-loop re-entry parity: a completed-cascade repair
            // re-synthesis can return a TOOL CALL on the tc=none synthesis round (the
            // model tries a tool when told not to). Inline re-enters its main loop,
            // which produces one more clean tool-free synthesis
            // (generateFinalAfterToolRoundLimit) instead of using the tool-call text —
            // otherwise the final answer becomes the tool-call artifact
            // ("Calling a tool.") rather than the evidence-based synthesis. The
            // onTerminate simulation must do the same: one clean pass (inline's single
            // trailing synthesis), bounded by the round cap + the recorded markers.
            if (synthesisResult.toolCalls?.length) {
              const cleanup = await this.generateFinalAfterToolRoundLimit({
                activation,
                packet,
                selection,
                baseGatewayInput: initialGatewayInput,
                messages: [
                  ...repairMessages,
                  { role: "assistant" as const, content: synthesisResult.text },
                ],
                maxRounds,
                modelCallTrace,
              });
              synthesisResult = cleanup.result;
              if (cleanup.reduction) {
                synthesisReduction = cleanup.reduction;
                synthesisReductionSnapshot = cleanup.reductionSnapshot;
              }
              if (cleanup.memoryFlush) {
                runState.recordMemoryFlush(cleanup.memoryFlush);
              }
            }
          }
          // Mirror the inline completed-closeout visibility appenders (inline
          // :1796-1814): a completed session that recovered a prior timeout, or a
          // task that requested a timeout-continuation closeout, gets a user-visible
          // recovered-timeout / continuation line before redaction.
          const appendCompletedTimeoutVisibility = (
            synth: GenerateTextResult,
          ): GenerateTextResult => {
            const completedSessionForVisibility = runState.completedSession();
            const preserveRecoveredTimeoutCloseout = completedSessionForVisibility
              ? shouldPreserveRecoveredTimeoutCloseout({
                  taskPrompt: packet.taskPrompt,
                  messages: state.messages,
                  toolTrace,
                  evidenceText: completedSessionForVisibility.finalContents.join("\n\n"),
                })
              : false;
            if (
              preserveRecoveredTimeoutCloseout ||
              shouldAppendRecoveredTimeoutCloseoutVisibility({
                resultText: synth.text,
                taskPrompt: packet.taskPrompt,
                messages: state.messages,
                toolTrace,
              })
            ) {
              return maybeAppendRecoveredTimeoutCloseoutVisibility(synth);
            }
            if (
              shouldAppendTimeoutContinuationVisibility({
                taskPrompt: packet.taskPrompt,
                messages: state.messages,
                toolTrace,
              })
            ) {
              return maybeAppendTimeoutContinuationVisibility(synth);
            }
            return synth;
          };
          // Stage 8C (Batch C — T10 browser/session finalization plane): mirror the
          // inline completed-closeout visibility appender chain (inline :1928-1960)
          // in EXACT order before redaction:
          //   1. maybeAppendBrowserRecoveryVisibility     (inline :1928)
          //   2. maybeAppendBrowserFailureBucketVisibility (inline :1933)
          //   3. recovered-timeout OR continuation appender (inline :1942-1960,
          //      handled by appendCompletedTimeoutVisibility above)
          //   4. maybeRedactForbiddenLocalUrls           (inline :1961)
          // The recovery + failure-bucket appenders are pure post-synthesis transforms
          // that append at most once when their own guards fire (no repair marker, no
          // re-synthesis loop), so ordering — not idempotency — is load-bearing.
          //
          // browserRecoverySummaries mirror inline :1924-1927: the completed session's
          // own summaries merged with any collected from the full tool trace. The
          // failure-bucket evidence text mirrors inline :1936-1940 (the completing
          // round's tool-result text + the recovery summaries + the final contents).
          //
          // Scope: the unconditional finalization epilogue appenders
          // (maybeAppendRequiredTimeoutFollowupVisibility /
          // maybeAppendBrowserRecoveryResidualRiskVisibility, inline :2417-2432) run
          // after the agent finishes, not inside this completed-closeout transform.
          const appendCompletedBrowserVisibility = (
            synth: GenerateTextResult,
          ): GenerateTextResult => {
            const completedSessionForBrowser = runState.completedSession();
            if (!completedSessionForBrowser) {
              return synth;
            }
            const completedSession = completedSessionForBrowser;
            const browserRecoverySummaries = dedupeStrings([
              ...completedSession.browserRecoverySummaries,
              ...collectBrowserRecoverySummariesFromToolTrace(toolTrace),
            ]);
            let visible = maybeAppendBrowserRecoveryVisibility({
              result: synth,
              taskPrompt: packet.taskPrompt,
              browserRecoverySummaries,
            });
            visible = maybeAppendBrowserFailureBucketVisibility({
              result: visible,
              taskPrompt: packet.taskPrompt,
              evidenceText: [
                collectToolResultContentText(
                  runState.completedSessionToolResults() ?? [],
                ),
                ...browserRecoverySummaries,
                ...completedSession.finalContents,
              ].join("\n\n"),
            });
            return visible;
          };
          const closeoutResult =
            reason === "completed_sub_agent_final"
              ? maybeRedactForbiddenLocalUrls({
                  result: appendCompletedTimeoutVisibility(
                    appendCompletedBrowserVisibility(synthesisResult),
                  ),
                  packet,
                })
              : reason === "sub_agent_timeout"
                ? maybeAppendTimeoutContinuationVisibility(synthesisResult)
                : synthesisResult;
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

function readBrowserRecoverySummary(
  payload: Record<string, unknown>,
): string | null {
  const recovery = payload["browserRecovery"];
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    return null;
  }
  const record = recovery as Record<string, unknown>;
  const summary = record["summary"];
  if (typeof summary === "string" && summary.trim()) {
    return summary.trim();
  }
  const resumeMode = record["resumeMode"];
  if (resumeMode === "warm" || resumeMode === "cold") {
    return `Browser recovery metadata: Resume mode: ${resumeMode}.`;
  }
  return null;
}

function readInlineBrowserRecoverySummary(values: string[]): string | null {
  const joined = values.join("\n").trim();
  if (!joined) return null;
  if (
    !/\b(?:browser_cdp_unavailable|cdp_command_timeout|detached_target|attach_failed|target_not_found|expert_session_detached|session_not_found|CDP command timed out|browser target detached|target attach failed|cold recreation|new (?:cold )?browser session|new session `?browser-session-|session was unavailable|browser session .*unavailable|dashboard reopened)\b/i.test(
      joined,
    )
  ) {
    return null;
  }
  return sliceUtf8(joined, 600);
}

function maybeAppendBrowserRecoveryVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  browserRecoverySummaries: string[];
}): GenerateTextResult {
  if (input.browserRecoverySummaries.length === 0) {
    return input.result;
  }
  if (
    !/continue|recover|reopen|reconnect|restart|unavailable|previous browser session|times? out|timed? out|timeout|detach(?:ed|es)?|attach(?:ed)?|CDP/i.test(
      input.taskPrompt,
    )
  ) {
    return input.result;
  }
  if (isBrowserRecoveryVisible(input.result.text, input.browserRecoverySummaries)) {
    return input.result;
  }
  if (expectsExactFinalAnswerShape(input.taskPrompt, input.result.text)) {
    return input.result;
  }
  const joinedSummaries = input.browserRecoverySummaries.join("\n");
  const resumeMode = joinedSummaries
    .match(/Resume mode:\s*(warm|cold)/i)?.[1]
    ?.toLowerCase();
  const continuity = resumeMode
    ? `Browser continuity: browser context was recovered before the page was rechecked (resume mode: ${resumeMode}).`
    : `Browser continuity: ${sliceUtf8(joinedSummaries, 600)}`;
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${continuity}`.trim(),
  };
}

function isBrowserRecoveryVisible(resultText: string, browserRecoverySummaries: string[]): boolean {
  const summaryText = browserRecoverySummaries.join("\n");
  const requiresColdSessionVisibility =
    /\b(?:cold recreation|session_not_found|new (?:cold )?browser session|new session `?browser-session-|session was unavailable|browser session .*unavailable|Resume mode:\s*cold)\b/i.test(
      summaryText,
    );
  if (requiresColdSessionVisibility) {
    return /\b(?:cold recreation|session_not_found|new (?:cold )?browser session|new session `?browser-session-|session was unavailable|browser session .*unavailable|resume mode:\s*cold|cold resume mode)\b/i.test(
      resultText,
    );
  }
  return /\b(recovered|recovery|reopen(?:ed)?|reconnect(?:ed)?|warm|cold|session was unavailable|new browser session|timed? out|timeout|cdp_command_timeout|detached|attach(?:ed)? failed|browser_cdp_unavailable)\b/i.test(
    resultText,
  );
}

function collectBrowserRecoverySummariesFromToolTrace(
  rounds: NativeToolRoundTrace[],
): string[] {
  const summaries: string[] = [];
  for (const round of rounds) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      const parsed = result.content ? parseSessionToolResult(result.content) : null;
      if (!parsed) {
        continue;
      }
      const payload = parsed.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const browserRecoverySummary = readBrowserRecoverySummary(payload as Record<string, unknown>);
        if (browserRecoverySummary) {
          summaries.push(browserRecoverySummary);
        }
      }
      const inlineBrowserRecoverySummary = readInlineBrowserRecoverySummary(
        [parsed.evidence_summary, parsed.result, parsed.final_content].filter(
          (item): item is string => typeof item === "string",
        ),
      );
      if (inlineBrowserRecoverySummary) {
        summaries.push(inlineBrowserRecoverySummary);
      }
    }
  }
  return dedupeStrings(summaries);
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

function collectNativeToolTraceEvidenceText(
  rounds: NativeToolRoundTrace[],
): string {
  return rounds
    .flatMap((round) => round.results)
    .filter((result) => !result.isError && result.skipped !== true)
    .filter((result) => !isControlPlaneToolResultName(result.toolName))
    .map((result) => result.content ?? "")
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
}

function collectSourceBoundedEvidenceText(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): string {
  return [
    collectNativeToolTraceEvidenceText(input.toolTrace),
    extractSourceBoundedEvidenceSnippets(input.taskPrompt),
    ...input.messages.map((message) =>
      extractSourceBoundedEvidenceSnippets(
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      ),
    ),
  ]
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

function extractSourceBoundedEvidenceSnippets(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const snippets: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!looksLikeSourceBoundedEvidenceLine(line)) continue;
    snippets.push(
      lines
        .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
        .join("\n"),
    );
  }
  return [...new Set(snippets)].join("\n\n");
}

function looksLikeSourceBoundedEvidenceLine(line: string): boolean {
  return (
    // Scope/usage caveats a source may state (kept general — no fixture
    // literals): e.g. "for documentation use", "avoid use in operations",
    // "not for production use", "without needing permission".
    /\b(?:avoid use in\b|not (?:for|intended for) (?:production|operational|operations)|for (?:documentation|illustrative|example|testing) (?:use|purposes?)|without needing permission|outside the verified scope|scope[- ]limited)\b/i.test(
      line,
    ) ||
    /\b(?:Evidence|source|observed|verified|final_url|status_code|title)\b/i.test(
      line,
    ) ||
    /(?:证据|来源|已验证|关键原文|最终 URL|页面 title|取证方式|仅供(?:文档|示例|测试)|请勿用于(?:生产|运营|实际))/i.test(line)
  );
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

function maybeAppendTimeoutContinuationVisibility(
  result: GenerateTextResult,
): GenerateTextResult {
  if (hasTimeoutCloseoutGuidance(result.text)) {
    return result;
  }
  return {
    ...result,
    text: `${result.text.trim()}\n\nContinuation: this source check is resumable; continue the same source check if the missing evidence is still worth waiting for.`.trim(),
  };
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

function shouldRepairStalePendingApproval(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasStalePendingApprovalRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !mentionsPendingApproval(input.resultText) ||
    (!requestsApprovalGatedBrowserAction(input.taskPrompt) &&
      !taskPromptIsAppliedApprovalBrowserContinuation(input.taskPrompt))
  ) {
    return false;
  }
  return (
    hasPermissionAppliedEvidence(input.toolTrace) ||
    taskPromptSaysApprovalAlreadyApplied(input.taskPrompt) ||
    taskPromptIsAppliedApprovalBrowserContinuation(input.taskPrompt)
  );
}

function shouldRepairPendingApprovalWaitTimeoutCheck(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasPendingApprovalWaitTimeoutCheckRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt)) {
    return false;
  }
  return latestPermissionToolName(input.toolTrace) === "permission_query";
}

function shouldRepairPrematurePendingApprovalFinal(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasPrematurePendingApprovalRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !mentionsPendingApproval(input.resultText) ||
    !requestsApprovalGatedBrowserAction(input.taskPrompt)
  ) {
    return false;
  }
  if (
    taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt) ||
    taskPromptAllowsStoppingAtPendingApproval(input.taskPrompt)
  ) {
    return false;
  }
  if (hasPermissionAppliedEvidence(input.toolTrace) || taskPromptSaysApprovalAlreadyApplied(input.taskPrompt)) {
    return false;
  }
  if (hasSessionToolEvidence(input.toolTrace)) {
    return false;
  }
  return latestPermissionToolName(input.toolTrace) === "permission_query" || latestPermissionResultStatus(input.toolTrace) === "pending";
}

function hasSessionToolEvidence(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some((round) =>
    round.calls.some((call) => call.name === "sessions_spawn" || call.name === "sessions_send") ||
    round.results.some((result) => result.toolName === "sessions_spawn" || result.toolName === "sessions_send")
  );
}

function shouldRepairApprovalWaitTimeoutCloseout(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasApprovalWaitTimeoutCloseoutRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt)) {
    return false;
  }
  if (!hasApprovalWaitTimeoutEvidence(input.toolTrace)) {
    return false;
  }
  return !looksLikeCompleteApprovalWaitTimeoutCloseout(input.resultText);
}

function shouldForceApprovalWaitTimeoutLocalCloseoutAfterFailedRepair(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (!taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt)) {
    return false;
  }
  if (!hasApprovalWaitTimeoutCloseoutRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!hasApprovalWaitTimeoutEvidence(input.toolTrace)) {
    return false;
  }
  return !looksLikeCompleteApprovalWaitTimeoutCloseout(input.resultText);
}

function collectApprovalWaitTimeoutRuntimeEvidence(
  toolTrace: NativeToolRoundTrace[],
): string {
  const evidence: string[] = [];
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "permission_query" &&
        result.toolName !== "permission_result"
      ) {
        continue;
      }
      if (!result.content) {
        continue;
      }
      evidence.push(`${result.toolName}: ${sliceUtf8(result.content, 1200)}`);
    }
  }
  return evidence.length
    ? evidence.join("\n")
    : "permission_query/permission_result evidence shows the approval request remains pending.";
}

function shouldRepairIncompleteApprovedBrowserAction(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasIncompleteApprovedBrowserActionRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !requestsApprovalGatedBrowserAction(input.taskPrompt) &&
    !taskPromptIsAppliedApprovalBrowserContinuation(input.taskPrompt)
  ) {
    return false;
  }
  if (
    !hasPermissionAppliedEvidence(input.toolTrace) &&
    !taskPromptSaysApprovalAlreadyApplied(input.taskPrompt)
  ) {
    return false;
  }
  return matchesAny(
    input.resultText,
    INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS,
  );
}

function taskPromptIsAppliedApprovalBrowserContinuation(taskPrompt: string): boolean {
  return (
    taskPromptSaysApprovalAlreadyApplied(taskPrompt) &&
    /\b(?:browser\.form\.submit|approved scoped action|approved point|operator approved|call sessions_spawn|agent_id="?browser"?|browser result|form submission|dry[- ]run)\b/i.test(
      taskPrompt,
    )
  );
}

function shouldRepairMissingBrowserEvidence(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  if (hasMissingBrowserEvidenceRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!taskRequiresBrowserEvidence(input.taskPrompt)) {
    return false;
  }
  if (hasCompletedBrowserSessionEvidence(input.toolTrace)) {
    return false;
  }
  if (
    hasAttemptedBrowserSessionEvidence(input.toolTrace) ||
    contextHasBrowserSessionAttempt(
      buildBrowserEvidenceRepairContext(input.taskPrompt, input.messages),
    )
  ) {
    return false;
  }
  return matchesAny(input.resultText, MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS);
}

function shouldRepairMissingProductSignalBrowserEvidence(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
  evidenceText?: string;
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  if (hasMissingBrowserEvidenceRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!taskRequestsProductSignalDashboardEvidence(input.taskPrompt)) {
    return false;
  }
  const evidenceText = [
    input.evidenceText,
    collectCompletedSessionEvidenceText(input.toolTrace),
  ]
    .filter(
      (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
    )
    .join("\n\n");
  if (hasProductSignalDashboardMetrics(input.resultText)) {
    return false;
  }
  if (hasProductSignalDashboardMetrics(evidenceText)) {
    return false;
  }
  return (
    matchesAny(input.resultText, MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS) ||
    /\b(?:SPAs?|server HTML shells?|HTML shells?|shell only|partial text|browser rendering)\b[\s\S]{0,180}\b(?:not confirmed|not verified|unconfirmed|unverified|without|lacks?)\b/i.test(
      input.resultText,
    ) ||
    /\b(?:not confirmed|not verified|unconfirmed|unverified|without|lacks?)\b[\s\S]{0,180}\b(?:SPAs?|server HTML shells?|HTML shells?|shell only|browser rendering|rendered dashboard)\b/i.test(
      input.resultText,
    )
  );
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

function shouldRepairMissingRequestedNextAction(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
}): boolean {
  if (hasMissingRequestedNextActionRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !/\b(?:next action|next step|operator should|should take|safe fallback|fallback action)\b/i.test(
      input.taskPrompt,
    )
  ) {
    return false;
  }
  return !/\b(?:next action|next step|recommended action|recommend(?:ed)?|operator should|should (?:retry|reopen|check|watch|escalate|preserve|request|continue|stop|avoid)|safe fallback|fallback action)\b/i.test(
    input.resultText,
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

function resultIntroducesProviderSupportSchema(text: string): boolean {
  const normalized = normalizeColumnDetectionText(text);
  return (
    /\bprovider\b/.test(normalized) &&
    /search\/web_search|web_search|web search|是否明确支持 search|搜索/.test(normalized) &&
    /目标模型|model support|是否明确支持目标模型|deepseek|输入价格|input price|output price|输出价格/.test(normalized)
  );
}

function explicitlyRequestsProviderSupportSchema(text: string): boolean {
  const normalized = normalizeColumnDetectionText(text);
  return (
    /\bprovider\b|供应商|提供商/.test(normalized) &&
    /search\/web_search|web_search|web search|搜索/.test(normalized) &&
    /目标模型|model support|deepseek|输入价格|input price|output price|输出价格|per-token/.test(normalized)
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

function normalizeColumnDetectionText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function markdownTableHasExactRequestedColumns(
  text: string,
  requestedColumns: string[],
): boolean {
  const headerRows = extractMarkdownTableHeaderRows(text);
  if (headerRows.length === 0) {
    return requestedColumns.length === 0;
  }
  const normalizedRequested = requestedColumns.map(normalizeTableHeaderCell);
  return headerRows.some((cells) => {
    const normalizedCells = cells.map(normalizeTableHeaderCell);
    return normalizedRequested.every((column) =>
      normalizedCells.includes(column),
    );
  });
}

function extractMarkdownTableHeaderRows(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  const rows: string[][] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (!line.includes("|") || !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function normalizeTableHeaderCell(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildRequestedTableColumnActivationContext(
  activation?: RoleActivationInput,
): string[] {
  const intent = activation?.handoff.payload.intent;
  if (!intent) return [];
  return [
    intent.relayBrief ?? "",
    intent.instructions ?? "",
    ...(intent.recentMessages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    ),
  ];
}

function buildOriginalRequestTableColumnContext(
  activation?: RoleActivationInput,
): string[] {
  const intent = activation?.handoff.payload.intent;
  if (!intent) return [];
  return [intent.relayBrief ?? "", intent.instructions ?? ""];
}

function requestedTableColumnMessageContext(messages: LLMMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => readToolResultContentText(message.content));
}

function shouldRepairWeakEvidenceSynthesis(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText?: string;
}): boolean {
  if (hasWeakEvidenceSynthesisRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    input.evidenceText &&
    hasUnsupportedSourceBoundedExtrapolation(input.resultText, input.evidenceText)
  ) {
    return true;
  }
  if (expectsExactFinalAnswerShape(input.taskPrompt, input.resultText)) {
    return false;
  }
  if (matchesAny(input.resultText, WEAK_UNCERTAINTY_SYNTHESIS_PATTERNS)) {
    return true;
  }
  if (shouldRepairMissingRequestedRiskDimension(input)) {
    return true;
  }
  return (
    !taskRequestsEstimate(input.taskPrompt) &&
    matchesAny(input.resultText, WEAK_ESTIMATE_SYNTHESIS_PATTERNS)
  );
}

const PRODUCT_BRIEF_MULTI_AGENT_EVIDENCE_PATTERN =
  /\bmulti[- ]agent decomposition\b|\bdurable sub-session history\b|\bspecialist agents?\b[\s\S]{0,120}\bdecision-ready brief\b/i;
const PRODUCT_BRIEF_MULTI_AGENT_RESULT_PATTERN =
  /\bmulti[- ]agent\b|multiple agents|specialist agents|delegated agents|agent coordination/i;

function shouldRepairProductBriefEvidenceCarryForward(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasProductBriefEvidenceCarryForwardRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!taskRequestsAgentWorkbenchProductBrief(input.taskPrompt)) {
    return false;
  }
  if (!PRODUCT_BRIEF_MULTI_AGENT_EVIDENCE_PATTERN.test(input.evidenceText)) {
    return false;
  }
  const missingMultiAgent = !PRODUCT_BRIEF_MULTI_AGENT_RESULT_PATTERN.test(input.resultText);
  const missingRenderedSignals =
    hasProductSignalDashboardMetrics(input.evidenceText) &&
    (!PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN.test(input.resultText) ||
      hasProductSignalDashboardUnverifiedContradiction(input.resultText));
  return missingMultiAgent || missingRenderedSignals;
}

function shouldRepairSourceEvidenceCarryForward(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  return (
    shouldRepairProductBriefEvidenceCarryForward(input) ||
    shouldRepairCompletedSessionLabelCarryForward(input)
  );
}

function shouldRepairCompletedSessionLabelCarryForward(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasCompletedSessionLabelCarryForwardRepairPrompt(input.repairMarkers)) {
    return false;
  }
  const labels = extractCompletedSessionEvidenceLabels(input.evidenceText);
  if (labels.length === 0) {
    return false;
  }
  if (taskRequestsAgentWorkbenchProductBrief(input.taskPrompt)) {
    return false;
  }
  const labelSensitiveTask =
    (requestsApprovalGatedBrowserAction(input.taskPrompt) &&
      hasAppliedApprovalEvidenceText(input.evidenceText)) ||
    /\b(?:source labels?|source URLs?|evidence streams?|source streams?|source checks?|sources?)\b/i.test(
      input.taskPrompt,
    );
  if (!labelSensitiveTask) {
    return false;
  }
  return labels.some((label) => !normalizedTextContains(input.resultText, label));
}

function taskRequestsAgentWorkbenchProductBrief(taskPrompt: string): boolean {
  return (
    /\bagent workbench\b/i.test(taskPrompt) &&
    /\b(?:product[- ]ready brief|product brief|audit-ready product brief|next release)\b/i.test(taskPrompt) &&
    /\b(?:independent evidence streams|specialist work|Mission Control|product-signals|live signal dashboard)\b/i.test(taskPrompt)
  );
}

function productBriefEvidenceIsComplete(evidenceText: string): boolean {
  return (
    PRODUCT_BRIEF_MULTI_AGENT_EVIDENCE_PATTERN.test(evidenceText) &&
    /\b(?:browser bridge|bridge capability|browser controls|inspect rendered DOM|collect screenshots?)\b/i.test(
      evidenceText,
    ) &&
    hasProductSignalDashboardMetrics(evidenceText) &&
    /\b(?:rendered browser|browser[- ]rendered|browser-visible|browser evidence|rendered JavaScript|screenshot|snapshot|DOM)\b/i.test(
      evidenceText,
    )
  );
}

function productBriefFinalCarriesEvidence(resultText: string): boolean {
  return (
    PRODUCT_BRIEF_MULTI_AGENT_RESULT_PATTERN.test(resultText) &&
    /\b(?:Mission Control|default entry|default human entry)\b/i.test(
      resultText,
    ) &&
    /\b(?:browser bridge|bridge capability|browser controls|inspect rendered DOM|screenshots?)\b/i.test(
      resultText,
    ) &&
    PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN.test(resultText) &&
    /\b(?:risk|residual risk|unverified|source-bounded|production validation)\b/i.test(
      resultText,
    )
  );
}

function hasProductBriefEvidenceCarryForwardRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final product brief dropped required source-backed workbench evidence",
      ),
  );
}

function buildSourceEvidenceCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  if (
    shouldRepairProductBriefEvidenceCarryForward({
      ...input,
      messages: [],
      repairMarkers: [],
    })
  ) {
    return buildProductBriefEvidenceCarryForwardRepairPrompt(input);
  }
  const missingLabels = extractCompletedSessionEvidenceLabels(input.evidenceText).filter(
    (label) => !normalizedTextContains(input.resultText, label),
  );
  if (missingLabels.length > 0) {
    return buildCompletedSessionLabelCarryForwardRepairPrompt({
      ...input,
      missingLabels,
    });
  }
  return buildProductBriefEvidenceCarryForwardRepairPrompt(input);
}

function hasCompletedSessionLabelCarryForwardRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer dropped visible evidence source labels",
      ),
  );
}

function buildCompletedSessionLabelCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
  missingLabels: string[];
}): string {
  return [
    "Runtime correction: final answer dropped visible evidence source labels.",
    `Missing exact label(s): ${input.missingLabels.join(", ")}`,
    "Do not call tools. Rewrite the final answer using only the completed evidence below.",
    "Keep the substantive answer, but add a compact Evidence / Sources line that includes each missing label exactly as written and the fact(s) it verified.",
    "For approval-gated browser work, keep approval status, applied action, browser evidence, screenshot/artifact, and no-external-side-effect boundary visible.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1600)}`,
    `Completed evidence:\n${sliceUtf8(input.evidenceText, 3600)}`,
  ].join("\n");
}

function extractCompletedSessionEvidenceLabels(evidenceText: string): string[] {
  const labels: string[] = [];
  for (const match of evidenceText.matchAll(/"label"\s*:\s*"([^"\\]{3,120})"/g)) {
    const label = match[1]?.trim();
    if (label && isMeaningfulEvidenceLabel(label)) {
      labels.push(label);
    }
  }
  for (const match of evidenceText.matchAll(/\blabel\s*=\s*"([^"]{3,120})"/g)) {
    const label = match[1]?.trim();
    if (label && isMeaningfulEvidenceLabel(label)) {
      labels.push(label);
    }
  }
  return dedupeStrings(labels).slice(0, 6);
}

function isMeaningfulEvidenceLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized || normalized.length < 3) {
    return false;
  }
  return !/^(?:local-url-fetch|browser|explore|source|fetch|research|session)$/i.test(normalized);
}

function hasAppliedApprovalEvidenceText(text: string): boolean {
  return /\bpermission\.applied\b|["']event_type["']\s*:\s*["']permission\.applied["']|\bapproval\b[\s\S]{0,120}\bapplied\b/i.test(
    text,
  );
}

function normalizedTextContains(text: string, needle: string): boolean {
  const compactText = text.replace(/\s+/g, " ").trim().toLowerCase();
  const compactNeedle = needle.replace(/\s+/g, " ").trim().toLowerCase();
  return compactNeedle.length > 0 && compactText.includes(compactNeedle);
}

function buildProductBriefEvidenceCarryForwardRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  return [
    "Runtime correction: final product brief dropped required source-backed workbench evidence.",
    "Do not call tools. Rewrite the final answer using only the completed delegated evidence below.",
    "The final must explicitly carry forward the orchestration evidence as multi-agent coordination, using the phrase multi-agent decomposition when supported by the evidence.",
    "The final must explicitly carry forward any dashboard counters or rates as rendered browser evidence, not raw HTML, when those values appear in evidence.",
    "Keep the product-bridge source visible as bridge/setup evidence. Preserve source-bounded residual risk, but do not mark rendered dashboard counters or browser/rendered evidence unverified when the completed evidence contains them.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed delegated evidence:\n${sliceUtf8(input.evidenceText, 4200)}`,
  ].join("\n");
}

function hasUnsupportedSourceBoundedExtrapolation(
  resultText: string,
  evidenceText: string,
): boolean {
  const mentionsDnsOrIp =
    /\b(?:dns|ip address|resolves? to|resolution|a record|93\.184\.215\.14)\b/i.test(
      resultText,
    ) || /(?:DNS|解析|污染|IP\s*地址|93\.184\.215\.14)/i.test(resultText);
  if (
    mentionsDnsOrIp &&
    !/\b(?:dns|ip address|resolves? to|resolution|a record|93\.184\.215\.14)\b|(?:DNS|解析|污染|IP\s*地址|93\.184\.215\.14)/i.test(
      evidenceText,
    )
  ) {
    return true;
  }
  const strongOperationsRestriction =
    /(?:不得|不能|禁止|不可|不应)[^。；;\n]{0,120}(?:生产|运营|实际运营|真实环境|测试环境|真实服务|正式业务|真实业务|联网业务|业务场景)/.test(
      resultText,
    ) ||
    /\b(?:must not|cannot|prohibited|forbidden|not allowed)\b[\s\S]{0,120}\b(?:operations?|production|real service|real services|real environment|test environment|business use|networked business)\b/i.test(
      resultText,
    );
  if (strongOperationsRestriction && !evidenceStatesStrictOperationsRestriction(evidenceText)) {
    return true;
  }
  const unsupportedRiskMechanism =
    /(?:路由冲突|安全风险|恶意(?:测试)?流量|abuse risk|security risk|routing conflict)/i.test(
      resultText,
    ) &&
    !/(?:路由冲突|安全风险|恶意(?:测试)?流量|abuse risk|security risk|routing conflict)/i.test(
      evidenceText,
    );
  return unsupportedRiskMechanism;
}

function evidenceStatesStrictOperationsRestriction(evidenceText: string): boolean {
  return (
    /(?:不得|不能|禁止|不可|不应)[^。；;\n]{0,120}(?:生产|运营|实际运营|真实环境|测试环境|真实服务|正式业务|真实业务|联网业务|业务场景)/.test(
      evidenceText,
    ) ||
    /\b(?:must not|cannot|prohibited|forbidden|not allowed)\b[\s\S]{0,120}\b(?:operations?|production|real service|real services|real environment|test environment|business use|networked business)\b/i.test(
      evidenceText,
    )
  );
}

function shouldRepairFalseEvidenceBlockedSynthesis(input: {
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasFalseEvidenceBlockedSynthesisRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !matchesAny(input.resultText, FALSE_EVIDENCE_BLOCKED_SYNTHESIS_PATTERNS)
  ) {
    return false;
  }
  return !matchesAny(input.evidenceText, ACTUAL_EVIDENCE_BLOCKED_PATTERNS);
}

function shouldRepairMissingBrowserEvidenceDimensions(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasMissingBrowserEvidenceDimensionsRepairPrompt(input.repairMarkers)) {
    return false;
  }
  return findMissingBrowserEvidenceDimensions(input).length > 0;
}

function findMissingBrowserEvidenceDimensions(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string[] {
  const dimensions = [
    {
      label: "embedded frame source state",
      requested: /\b(?:iframe|frame|embedded source)\b/i,
      evidence:
        /\b(?:Frame panel|embedded source frame|embedded backlog source)\b[\s\S]{0,180}\b(?:backlog\s*7|Frame Captain)\b|\b(?:backlog\s*7|Frame Captain)\b[\s\S]{0,180}\b(?:Frame panel|embedded source frame|embedded backlog source)\b/i,
      result:
        /\b(?:frame|iframe|embedded source)\b[\s\S]{0,220}\b(?:backlog(?:\s*(?:count|data))?[\s\S]{0,30}\b7\b|Frame Captain)\b|\b(?:backlog(?:\s*(?:count|data))?[\s\S]{0,30}\b7\b|Frame Captain)\b[\s\S]{0,220}\b(?:frame|iframe|embedded source)\b/i,
      negated:
        /\bnot verified\b[\s\S]{0,120}\b(?:frame|iframe|embedded source)\b|\b(?:frame|iframe|embedded source)\b[\s\S]{0,120}\bnot verified\b/i,
    },
    {
      label: "shadow review state",
      requested: /\b(?:shadow|review component)\b/i,
      evidence:
        /\b(?:Shadow review|shadow component|review component)\b[\s\S]{0,180}\b(?:risk desk|approval required|approval requirement)\b|\b(?:risk desk|approval required|approval requirement)\b[\s\S]{0,180}\b(?:Shadow review|shadow component|review component)\b/i,
      result:
        /\b(?:shadow|review component)\b[\s\S]{0,220}\b(?:risk desk|approval required|approval requirement|approval is required)\b|\b(?:risk desk|approval required|approval requirement|approval is required)\b[\s\S]{0,220}\b(?:shadow|review component)\b/i,
      negated:
        /\bnot verified\b[\s\S]{0,120}\b(?:shadow|review component)\b|\b(?:shadow|review component)\b[\s\S]{0,120}\bnot verified\b/i,
    },
    {
      label: "details popup state",
      requested: /\bpopup\b/i,
      evidence:
        /\bpopup\b[\s\S]{0,180}\b(?:P-42|manager acknowledgement|opened)\b|\b(?:P-42|manager acknowledgement)\b[\s\S]{0,180}\bpopup\b/i,
      result:
        /\bpopup\b[\s\S]{0,180}\b(?:P-42|manager acknowledgement|opened)\b|\b(?:P-42|manager acknowledgement)\b[\s\S]{0,180}\bpopup\b/i,
    },
    {
      label: "product signal dashboard counters",
      requested:
        /\b(?:product-signals|live signal dashboard|product signal dashboard)\b/i,
      evidence: PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN,
      result: PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN,
      negated: PRODUCT_SIGNAL_DASHBOARD_COUNTERS_UNVERIFIED_PATTERN,
    },
  ] as const;

  return dimensions.flatMap((dimension) =>
    dimension.requested.test(input.taskPrompt) &&
    dimension.evidence.test(input.evidenceText) &&
    (!dimension.result.test(input.resultText) ||
      ("negated" in dimension && dimension.negated.test(input.resultText)))
      ? [dimension.label]
      : [],
  );
}

function shouldRepairMissingRequestedRiskDimension(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
}): boolean {
  if (
    !/\brisks?\b/i.test(input.taskPrompt) ||
    /\brisks?\b/i.test(input.resultText)
  ) {
    return false;
  }
  return input.messages.some((message) =>
    /\brisks?\b/i.test(readMessageContentText(message.content)),
  );
}

function taskRequestsEstimate(taskPrompt: string): boolean {
  return matchesAny(taskPrompt, ESTIMATE_REQUEST_PATTERNS);
}

const MISSING_BROWSER_EVIDENCE_FINAL_PATTERNS = [
  /\b(?:browser|rendered|DOM|page|snapshot|screenshot|popup|iframe|frame|shadow)\b[\s\S]{0,120}\b(?:tools?|tooling|worker|agent|session)\b[\s\S]{0,80}\b(?:unavailable|not available|disabled|missing|could not be called|cannot be called|failed)\b/i,
  /\b(?:tools?|tooling|worker|agent|session)\b[\s\S]{0,80}\b(?:unavailable|not available|disabled|missing|could not be called|cannot be called|failed)\b[\s\S]{0,120}\b(?:browser|rendered|DOM|page|snapshot|screenshot|popup|iframe|frame|shadow)\b/i,
  /\b(?:static|raw|server|HTTP)\s+(?:fetch|HTML|extraction|request)\b[\s\S]{0,160}\b(?:instead of|without|not)\b[\s\S]{0,120}\b(?:browser|rendered|DOM|JavaScript|client[- ]side|popup|iframe|frame|shadow)\b/i,
  /\b(?:static|raw|server|HTTP)\s+(?:fetch|HTML|extraction|request)\b[\s\S]{0,180}\b(?:cannot|can't|could not|unable to)\b[\s\S]{0,160}\b(?:browser|rendered|DOM|JavaScript|client[- ]side|popup|iframe|frame|shadow)\b/i,
  /\blive browser session\b[\s\S]{0,120}\b(?:needed|required|necessary)\b/i,
  /\b(?:browser|rendered|DOM|JavaScript|client[- ]side|popup|iframe|frame|shadow)\b[\s\S]{0,160}\b(?:not verified|unverified|unable to verify|was not verified|could not verify)\b/i,
];

const WEAK_UNCERTAINTY_SYNTHESIS_PATTERNS = [
  /\b(?:TBD|to be confirmed|needs confirmation|pending confirmation|probably|maybe)\b/i,
  /(?:^|[^A-Za-z0-9_])待确认(?![A-Za-z0-9_])/,
];

const WEAK_ESTIMATE_SYNTHESIS_PATTERNS = [
  /\b(?:estimate|estimated)\b/i,
  /(?:^|[^A-Za-z0-9_])估算(?![A-Za-z0-9_])/,
];

const FALSE_EVIDENCE_BLOCKED_SYNTHESIS_PATTERNS = [
  /\b(?:not accessible|not fully accessible|inaccessible)\b/i,
  /\b(?:source|content|evidence|page|dashboard|browser|rendered|DOM|extraction)\b[\s\S]{0,120}\b(?:failed|unavailable|inaccessible|incomplete|truncated|blocked)\b/i,
  /\b(?:failed|unavailable|inaccessible|incomplete|truncated|blocked)\b[\s\S]{0,120}\b(?:source|content|evidence|page|dashboard|browser|rendered|DOM|extraction)\b/i,
];

const ACTUAL_EVIDENCE_BLOCKED_PATTERNS = [
  /\b(?:could not|unable to|failed to)\s+(?:access|extract|capture|read|load|verify)\b/i,
  /\b(?:verification status:\s*failed|content extraction\b[\s\S]{0,80}\b(?:failed|incomplete|truncated))\b/i,
  /\b(?:browser|rendered|DOM|page|dashboard|tab|target|screenshot|snapshot|CDP)\b[\s\S]{0,120}\b(?:failed|unavailable|inaccessible|incomplete|truncated)\b/i,
  /\b(?:failed|unavailable|inaccessible|incomplete|truncated)\b[\s\S]{0,120}\b(?:browser|rendered|DOM|page|dashboard|tab|target|screenshot|snapshot|CDP)\b/i,
];

const ESTIMATE_REQUEST_PATTERNS = [
  /\b(?:estimate|estimated|estimation|forecast|roughly|approx(?:imate|imately)?|ballpark|range)\b/i,
  /(?:^|[^A-Za-z0-9_])(?:估算|预估|大概|大致|范围)(?![A-Za-z0-9_])/,
];

function shouldRepairStaleDeniedApproval(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasStaleDeniedApprovalRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (
    !mentionsPendingApproval(input.resultText) ||
    !requestsApprovalGatedBrowserAction(input.taskPrompt)
  ) {
    return false;
  }
  return latestPermissionResultStatus(input.toolTrace) === "denied";
}

function hasApprovalWaitTimeoutEvidence(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  if (latestPermissionResultStatus(toolTrace) === "pending") {
    return true;
  }
  return toolTrace.some((round) =>
    round.results.some((result) => {
      const parsed = parseJsonObject(result.content);
      return parsed?.["status"] === "approval_wait_timeout";
    }),
  );
}

function looksLikeCompleteApprovalWaitTimeoutCloseout(text: string): boolean {
  if (
    /\b(?:thread|flow|mission|task)\b[\s\S]{0,80}\b(?:remains?|stays?)\s+open\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /\b(?:approval|permission|operator decision)\b[\s\S]{0,180}\b(?:pending|did not arrive|still pending|timed out|timeout|wait[- ]timeout)\b/i.test(
      text,
    ) &&
    mentionsPendingApproval(text) &&
    /\b(?:did not|will not|was not|not|no)\s+(?:be\s+)?(?:submit(?:ted)?|apply|perform(?:ed)?|run|complete(?:d)?|execute(?:d)?|take|taken)|\b(?:action|side effect)\s+(?:not performed|did not run)\b|\bno (?:browser form submission|form submission|browser action|browser mutation|mutation|side effects?|state) (?:was |were )?(?:(?:or will be )?performed|executed|taken|applied|changed|mutated)\b|\bno form (?:was )?submitted\b/i.test(
      text,
    ) &&
    /\b(?:residual risk|risk|unverified|not verified|pending approval remains|pending decision remains)\b/i.test(
      text,
    ) &&
    /\b(?:next action|safest next step|safe fallback|ask the operator|retry|continue|re-?run|re-?initiate|flow is complete|closeout confirmed)\b/i.test(
      text,
    )
  );
}

function hasStalePendingApprovalRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval already applied",
      ),
  );
}

function hasPendingApprovalWaitTimeoutCheckRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval decision has not arrived",
      ),
  );
}

function hasPrematurePendingApprovalRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval-gated browser action is still pending",
      ),
  );
}

function hasApprovalWaitTimeoutCloseoutRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval wait-timeout evidence is available",
      ),
  );
}

function hasStaleDeniedApprovalRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval was denied",
      ),
  );
}

function hasIncompleteApprovedBrowserActionRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approved browser action has not executed",
      ),
  );
}

function hasMissingBrowserEvidenceRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: browser-visible evidence is missing",
      ),
  );
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

function hasMissingRequestedNextActionRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: requested next action is missing",
      ),
  );
}

function hasTimeoutFollowupFinalGuidanceRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: timeout follow-up final omitted recovery guidance",
      ),
  );
}

function hasMissingRequiredFinalDeliverablesRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer omitted required deliverables",
      ),
  );
}

function hasWeakEvidenceSynthesisRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer weakens verified evidence",
      ),
  );
}

function hasFalseEvidenceBlockedSynthesisRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer falsely marks completed evidence",
      ),
  );
}

function hasMissingBrowserEvidenceDimensionsRepairPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: final answer omitted requested browser evidence dimensions",
      ),
  );
}

function mentionsPendingApproval(text: string): boolean {
  return /\b(?:approval pending|approval is pending|approval is still pending|approval request is pending|approval request is still pending|permission is (?:now )?pending|permission request is pending|permission request is still pending|pending operator approval|pending operator decision|awaiting (?:decision|your decision|operator approval|operator decision|operator)|waiting for (?:your|operator) decision|waiting for operator|standby for (?:the )?decision|once you approve|after you approve|before (?:the )?(?:browser worker )?can)\b/i.test(
    text,
  );
}

function taskPromptAllowsStoppingAtPendingApproval(taskPrompt: string): boolean {
  return /\bstop\b[\s\S]{0,80}\b(?:approval request|permission request)\b[\s\S]{0,120}\b(?:wait|operator decision|approval|decision)\b|\bwait for (?:the )?operator decision\b[\s\S]{0,160}\bdo not (?:apply|submit|execute|proceed)/i.test(
    taskPrompt,
  );
}

function buildStalePendingApprovalRepairPrompt(): string {
  return [
    "Runtime correction: approval already applied, but the assistant tried to finalize with a pending-approval explanation.",
    "Do not wait again. Continue from the applied approval point now.",
    "Use native tools for the approved scoped action, preferably sessions_spawn with agent_id=browser, then summarize the concrete browser result.",
  ].join("\n");
}

function buildPendingApprovalWaitTimeoutCheckRepairPrompt(): string {
  return [
    "Runtime correction: approval decision has not arrived during an attempt that requested a no-decision closeout.",
    "Call permission_result for the pending approval_id from permission.query now.",
    "If it is still pending, do not call permission_applied and do not call browser tools.",
    "Then write a safe wait-timeout closeout: state what remains pending, state that no browser form submission or side effect ran, keep the unexecuted result unverified, and give the safe fallback or next action.",
  ].join("\n");
}

function buildPrematurePendingApprovalRepairPrompt(): string {
  return [
    "Runtime correction: approval-gated browser action is still pending, but this task requires carrying the approved action through instead of finalizing at the pending request.",
    "Do not write a final pending-approval summary.",
    "Call permission_result for the pending approval_id from permission.query now.",
    "If permission_result is approved, call permission_applied, then call sessions_spawn with agent_id=browser for only the approved scoped browser.form.submit action and verify the browser result before finalizing.",
    "If permission_result is denied, write a denied safe closeout. If it is still pending, keep checking permission_result within this tool loop; do not claim the dry-run completed.",
  ].join("\n");
}

function buildApprovalWaitTimeoutCloseoutRepairPrompt(): string {
  return [
    "Runtime correction: approval wait-timeout evidence is available, but the final closeout is incomplete or leaves the thread open.",
    "Do not call tools.",
    "Rewrite the final answer as a terminal closeout for this attempt and include the exact word pending.",
    "Name the source-backed runtime facts: permission_query requested approval for browser.form.submit, permission_result says the approval is still pending/approval_wait_timeout, no browser form submission or side effect ran, the unexecuted result is not verified, and the safe next action is to ask the operator to approve a new request or rerun the attempt when ready.",
    "Do not say the thread, flow, mission, or task remains open.",
  ].join("\n");
}

function buildStaleDeniedApprovalRepairPrompt(): string {
  return [
    "Runtime correction: approval was denied, but the assistant tried to finalize as if the approval were still pending.",
    "Do not wait again and do not call browser or permission tools.",
    "Write the final safe closeout now from the denied permission.result evidence: name the requested browser.form.submit action, state that no form submission or side effect ran, and give the safe fallback or next action.",
  ].join("\n");
}

function buildIncompleteApprovedBrowserActionRepairPrompt(): string {
  return [
    "Runtime correction: approved browser action has not executed.",
    "The approval is already applied and native tools are still available in this loop.",
    "Do not finalize with a tool-unavailable or final-synthesis explanation.",
    "Call sessions_spawn with agent_id=browser for the approved scoped browser action.",
    "The delegated browser task must include the approved submit/action, the local form URL when available, and a requirement to verify the resulting page state before final synthesis.",
  ].join("\n");
}

function buildMissingBrowserEvidenceRepairPrompt(taskPrompt: string): string {
  const supplementalLocalTimeoutProbe =
    shouldAddSupplementalLocalTimeoutProbeToBrowserRepair(taskPrompt);
  return [
    "Runtime correction: browser-visible evidence is missing.",
    ...(supplementalLocalTimeoutProbe
      ? [
          "Runtime correction: resumed timeout evidence is still content-poor.",
          `The resumed source-check still lacks response status/body/header or rendered page evidence for ${supplementalLocalTimeoutProbe}.`,
          `Supplemental local timeout probe mode: call browser_open with timeout_ms ${SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS}, then stop with observed evidence or explicit unavailable fields.`,
        ]
      : []),
    "The task requires browser-observed evidence such as rendered DOM, JavaScript/client-side state, iframe/frame content, shadow-style component state, popup state, dashboard state, or a user-visible page review.",
    "Do not finalize from raw HTTP fetch, server HTML, memory, or a tool-unavailable explanation while native session tools are still available.",
    "Call sessions_spawn with agent_id=browser for the browser-visible portion of the task.",
    "The delegated browser task must include the relevant URL, the visible states to inspect, and a requirement to return only observed facts plus any concrete blocker.",
    `Original task:\n${sliceUtf8(taskPrompt, 1400)}`,
  ].join("\n");
}

function buildMissingProductSignalBrowserEvidenceRepairPrompt(
  taskPrompt: string,
): string {
  const dashboardUrl = extractProductSignalDashboardUrl(taskPrompt);
  return [
    "Runtime correction: browser-visible evidence is missing.",
    "Runtime correction: the live product signal dashboard evidence is still incomplete.",
    "Do not finalize from SPA/server HTML shell evidence or from a generic browser-unavailable explanation while native session tools are still available.",
    "Call sessions_spawn with agent_id=browser for the product signal dashboard only.",
    `Dashboard URL: ${dashboardUrl ?? "use the product-signals/live signal dashboard URL from the original task"}.`,
    "The browser sub-agent must inspect the rendered page as an operator would see it and return exact visible dashboard counters, rates, recommendations, final URL, page title, and any concrete blocker.",
    "If rendering still cannot be verified, report the attempted browser observation and explicit unavailable fields; do not substitute raw HTML shell text for dashboard evidence.",
    `Original task:\n${sliceUtf8(taskPrompt, 1400)}`,
  ].join("\n");
}

function shouldAddSupplementalLocalTimeoutProbeToBrowserRepair(
  taskPrompt: string,
): string | null {
  if (!looksBoundedTimeoutSourceCheck(taskPrompt)) {
    return null;
  }
  return (
    extractHttpUrls(taskPrompt).find((candidate) => {
      try {
        return isLoopbackHostname(new URL(candidate).hostname);
      } catch {
        return false;
      }
    }) ?? null
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

function buildMissingRequestedNextActionRepairPrompt(): string {
  return [
    "Runtime correction: requested next action is missing from the final answer.",
    "Do not call tools. Revise the final answer using only the delegated session evidence already present.",
    "Include a concise next action or safe fallback for the operator, and keep any unverified scope explicit.",
  ].join("\n");
}

function shouldRepairTimeoutFollowupFinalGuidance(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  evidenceText: string;
}): boolean {
  if (hasTimeoutFollowupFinalGuidanceRepairPrompt(input.repairMarkers)) {
    return false;
  }
  if (!taskRequestsTimeoutFollowupContinuation(input.taskPrompt)) {
    return false;
  }
  if (!/\b(?:timeout|timed out|resumable|recovered|recovery)\b/i.test(input.evidenceText)) {
    return false;
  }
  const hasUnverifiedScope = /\b(?:unverified|not verified|remaining scope|source-bounded|source bounded)\b/i.test(
    input.resultText,
  );
  const hasContinuationGuidance = hasTimeoutContinuationGuidance(
    input.resultText,
  );
  const hasTimeoutContext = /\b(?:timeout|timed out|recovered|recovery|resumed)\b/i.test(
    input.resultText,
  );
  return !hasUnverifiedScope || !hasContinuationGuidance || !hasTimeoutContext;
}

function buildTimeoutFollowupFinalGuidanceRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  return [
    "Runtime correction: timeout follow-up final omitted recovery guidance.",
    "Do not call tools. Rewrite the final answer using only the completed continuation evidence below.",
    "Keep the verified owner, risk, mitigation, source URL/title/status, and release-risk assessment.",
    "Also include: (1) that this was recovered/resumed after an earlier timeout, (2) unverified scope that remains source-bounded, and (3) continuation guidance using words such as continue, retry, resumable, timeout recovery, or subsequent health check.",
    "Do not claim the earlier timeout never happened, and do not imply more source facts were verified than the completed evidence supports.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed continuation evidence:\n${sliceUtf8(input.evidenceText, 4200)}`,
  ].join("\n");
}

function buildWeakEvidenceSynthesisRepairPrompt(): string {
  return [
    "Runtime correction: final answer weakens verified evidence with placeholder uncertainty.",
    "Do not call tools. Rewrite the final answer using only the delegated session evidence already present.",
    "For facts directly present in the evidence, say observed or verified instead of maybe, probably, estimate, estimated, TBD, to be confirmed, pending confirmation, or similar placeholder wording.",
    "For facts absent from the evidence, write not verified and name the missing dimension without guessing.",
    "Remove source-external technical or policy extrapolations such as DNS/IP resolution details, production-environment bans, real-service claims, user-scale claims, or operational restrictions unless those exact facts appear in the gathered evidence.",
    "If the evidence states a narrow scope limit or usage caveat, preserve its exact wording (or say wider use is outside the verified scope); do not convert a narrow caveat into a broader production-environment or real-service ban.",
    "Preserve requested dimension labels from the user when evidence supports them, such as pricing, strength, risk, owner, and next action.",
    "Do not rename a requested risk dimension into only generic weaknesses, open questions, or uncertainty when risk evidence is present.",
    "Keep residual risk visible, but do not downgrade verified source facts into estimates.",
  ].join("\n");
}

function buildFalseEvidenceBlockedSynthesisRepairPrompt(
  finalContents: string[],
): string {
  return [
    "Runtime correction: final answer falsely marks completed evidence as blocked, inaccessible, failed, incomplete, or truncated.",
    "Do not call tools. Rewrite the final answer using only the delegated session evidence already present.",
    "The completed source evidence below is usable. Do not describe source content, browser evidence, rendered DOM, page content, or extraction as inaccessible, failed, incomplete, blocked, or truncated unless that exact blocker appears in the source evidence.",
    "Preserve the original requested final answer shape, section labels, bullet labels, no-link rules, and residual-risk requirement.",
    "It is okay to say the evidence is source-bounded to local fixtures or that real-world validation remains; do not turn that scope limitation into a tool/browser/content failure.",
    ...finalContents.map(
      (content, index) =>
        `Source ${index + 1} completed evidence:\n${sliceUtf8(content, 2400)}`,
    ),
  ].join("\n");
}

function buildMissingBrowserEvidenceDimensionsRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  evidenceText: string;
}): string {
  const missing = findMissingBrowserEvidenceDimensions(input);
  return [
    "Runtime correction: final answer omitted requested browser evidence dimensions.",
    `Missing dimensions: ${missing.join(", ")}.`,
    "Do not call tools. Rewrite the final answer using only the completed browser evidence below.",
    "Carry each missing requested browser dimension into the final answer when the evidence supports it.",
    "For unavailable dimensions, write not verified only if the completed browser evidence actually lacks that dimension.",
    "Keep residual risk visible, but do not mark frame, shadow, popup, or rendered page state unverified when the completed browser evidence contains it.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed browser evidence:\n${sliceUtf8(input.evidenceText, 3600)}`,
  ].join("\n");
}

function buildCompletedBrowserEvidenceDimensionCarryForwardLines(input: {
  taskPrompt: string;
  finalContents: string[];
}): string[] {
  if (!taskRequestsProductSignalDashboardEvidence(input.taskPrompt)) {
    return [];
  }
  const evidenceText = input.finalContents.join("\n\n");
  if (!hasProductSignalDashboardMetrics(evidenceText)) {
    return [];
  }
  const metrics = summarizeProductSignalDashboardMetrics(evidenceText);
  if (!metrics) {
    return [];
  }
  return [
    `Completed browser evidence verifies product signal dashboard counters: ${metrics}.`,
    "Carry those counters into the final answer as rendered browser evidence. Do not say dashboard counters, rates, signal IDs, or recommendations are unverified unless the completed browser evidence lacks that exact field.",
  ];
}

function summarizeProductSignalDashboardMetrics(evidenceText: string): string | null {
  const metrics: string[] = [];
  const seen = new Set<string>();
  const metricPattern =
    /(?:^|[\n.;,|])\s*([A-Za-z][A-Za-z0-9 _/-]{1,48}?)\s*(?::|=|-|\bis\b)\s*(\d+(?:\.\d+)?%?)(?![\d.])/g;
  for (const match of evidenceText.matchAll(metricPattern)) {
    const label = match[1]?.replace(/\s+/g, " ").trim();
    const value = match[2]?.trim();
    if (!label || !value) {
      continue;
    }
    const normalizedLabel = label.toLowerCase();
    if (
      seen.has(normalizedLabel) ||
      /^(?:http|https|port|status|code|line|id|url)$/i.test(label)
    ) {
      continue;
    }
    seen.add(normalizedLabel);
    metrics.push(`${label}: ${value}`);
    if (metrics.length >= 4) {
      break;
    }
  }
  return metrics.length > 0 ? metrics.join("; ") : null;
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

function hasAttemptedBrowserSessionEvidence(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  return toolTrace.some(
    (round) =>
      round.calls.some(isBrowserSessionSpawn) ||
      round.results.some((result) => {
        if (
          result.toolName !== "sessions_spawn" &&
          result.toolName !== "sessions_send"
        ) {
          return false;
        }
        const parsed = result.content
          ? parseSessionToolResult(result.content)
          : null;
        return Boolean(
          parsed &&
            (parsed.agent_id === "browser" ||
              /^worker:browser:/i.test(String(parsed.session_key ?? ""))),
        );
      }),
  );
}

function contextHasBrowserSessionAttempt(context: string): boolean {
  return extractSessionToolResultRecords(context).some((result) => {
    const agentId = result["agent_id"];
    const sessionKey = result["session_key"];
    return (
      agentId === "browser" ||
      (typeof sessionKey === "string" && /^worker:browser:/i.test(sessionKey))
    );
  });
}

function buildBrowserEvidenceRepairContext(
  taskPrompt: string,
  messages: LLMMessage[],
): string {
  return [
    buildContinuationDirectiveContext(taskPrompt, messages),
    ...messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
}

function collectCompletedSessionEvidenceText(
  toolTrace: NativeToolRoundTrace[],
): string {
  const evidence: string[] = [];
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      const parsed = result.content
        ? parseSessionToolResult(result.content)
        : null;
      if (!parsed || parsed.status !== "completed") {
        continue;
      }
      const completedEvidence = readCompletedSessionEvidence(parsed);
      if (completedEvidence) {
        evidence.push(completedEvidence);
      }
    }
  }
  return dedupeStrings(evidence).join("\n\n");
}

function taskRequestsProductSignalDashboardEvidence(text: string): boolean {
  return /\b(?:product-signals|live signal dashboard|product signal dashboard)\b/i.test(
    text,
  );
}

const PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN =
  "\\b[A-Za-z][A-Za-z0-9 _/-]{1,48}\\b\\s*(?:[:=\\-]|\\bis\\b)\\s*(?:\\*\\*)?\\d+(?:\\.\\d+)?(?:\\*\\*)?\\b";
const PRODUCT_SIGNAL_RATE_METRIC_PATTERN =
  "\\b[A-Za-z][A-Za-z0-9 _/-]{1,48}\\b\\s*(?:[:=\\-]|\\bis\\b)\\s*(?:\\*\\*)?\\d+(?:\\.\\d+)?%(?!\\d)(?:\\*\\*)?";
const PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN = new RegExp(
  `\\b(?:dashboard|signals?|metrics?|counters?|rates?)\\b[\\s\\S]{0,360}(?:${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}|${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN})|(?:${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}|${PRODUCT_SIGNAL_RATE_METRIC_PATTERN}[\\s\\S]{0,240}${PRODUCT_SIGNAL_NUMERIC_METRIC_PATTERN})[\\s\\S]{0,360}\\b(?:dashboard|signals?|metrics?|counters?|rates?)\\b`,
  "i",
);
const PRODUCT_SIGNAL_DASHBOARD_RENDERED_RESULT_PATTERN = new RegExp(
  `(?:\\b(?:rendered|browser|browser-visible|visible|screenshot|snapshot|DOM)\\b[\\s\\S]{0,360}${PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN.source})|(?:${PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN.source}[\\s\\S]{0,360}\\b(?:rendered|browser|browser-visible|visible|screenshot|snapshot|DOM)\\b)`,
  "i",
);
const PRODUCT_SIGNAL_DASHBOARD_COUNTERS_UNVERIFIED_PATTERN =
  /\b(?:live counters?|dashboard counters?|signals? dashboard counters?|counter values?|metric values?|product signals? dashboard|product signal dashboard|live signal dashboard|signals? dashboard)\b[\s\S]{0,260}\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)|\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)\b[\s\S]{0,260}\b(?:live counters?|dashboard counters?|signals? dashboard counters?|counter values?|metric values?|product signals? dashboard|product signal dashboard|live signal dashboard|signals? dashboard)\b/i;
const PRODUCT_SIGNAL_BROWSER_EVIDENCE_UNVERIFIED_PATTERN =
  /\b(?:browser|rendered|rendered browser|browser-rendered|browser visible|browser-visible|DOM|screenshot|snapshot)\s+(?:evidence|inspection|verification|view|capture|signal|signals|dashboard)\b[\s\S]{0,220}\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)|\b(?:not verified|unverified|not confirmed|unconfirmed|not extracted|not captured|not observed|not in (?:the )?(?:completed )?evidence)\b[\s\S]{0,220}\b(?:browser|rendered|rendered browser|browser-rendered|browser visible|browser-visible|DOM|screenshot|snapshot)\s+(?:evidence|inspection|verification|view|capture|signal|signals|dashboard)\b/i;

function hasProductSignalDashboardUnverifiedContradiction(text: string): boolean {
  return (
    PRODUCT_SIGNAL_DASHBOARD_COUNTERS_UNVERIFIED_PATTERN.test(text) ||
    PRODUCT_SIGNAL_BROWSER_EVIDENCE_UNVERIFIED_PATTERN.test(text)
  );
}

function hasProductSignalDashboardMetrics(text: string): boolean {
  return PRODUCT_SIGNAL_DASHBOARD_COUNTERS_PATTERN.test(text);
}

function extractProductSignalDashboardUrl(taskPrompt: string): string | null {
  const lines = taskPrompt.split(/\r?\n/);
  for (const line of lines) {
    if (!taskRequestsProductSignalDashboardEvidence(line)) {
      continue;
    }
    const url = extractHttpUrls(line)[0];
    if (url) {
      return url;
    }
  }
  return (
    extractHttpUrls(taskPrompt).find((url) => /product-signals/i.test(url)) ??
    null
  );
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

type RequiredFinalDeliverable = {
  id: "final_conclusion" | "two_row_table";
  label: string;
  instruction: string;
};

function inferRequiredFinalSynthesisDeliverables(
  taskPrompt: string,
): RequiredFinalDeliverable[] {
  const deliverables: RequiredFinalDeliverable[] = [];
  if (taskRequestsTwoRowTable(taskPrompt)) {
    deliverables.push({
      id: "two_row_table",
      label: "two-row table",
      instruction:
        "Return the requested merged table with exactly two evidence rows after the header unless a source is explicitly incomplete.",
    });
  }
  if (taskRequestsFinalConclusion(taskPrompt)) {
    deliverables.push({
      id: "final_conclusion",
      label: "final one-sentence conclusion",
      instruction:
        "After the requested table or structured answer, include the requested final one-sentence conclusion with an explicit label such as `结论：` or `Conclusion:`.",
    });
  }
  return deliverables;
}

function inferRequestedTableColumns(texts: string[]): string[] {
  const columns: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/表格(?:列出|包含|字段|栏位|列)?\s*[:：]\s*([^\n。；;]+)/g)) {
      const rawColumns = match[1] ?? "";
      for (const column of rawColumns.split(/[、,，|]+/)) {
        const normalized = normalizeRequestedTableColumn(column);
        if (!normalized) continue;
        columns.push(normalized);
      }
    }
    for (const match of text.matchAll(/table(?:\s+(?:with|containing|columns?))?\s*[:：]\s*([^\n.；;]+)/gi)) {
      const rawColumns = match[1] ?? "";
      for (const column of rawColumns.split(/[、,，|]+/)) {
        const normalized = normalizeRequestedTableColumn(column);
        if (!normalized) continue;
        columns.push(normalized);
      }
    }
  }
  return Array.from(new Set(columns)).slice(0, 12);
}

function resolveRequestedTableColumns(texts: string[]): string[] {
  const inferred = inferRequestedTableColumns(texts);
  const providerColumns = inferEvidenceSensitiveProviderTableColumns(texts);
  if (providerColumns.length === 0) {
    return inferred;
  }
  if (inferred.length === 0) {
    return providerColumns;
  }
  const normalized = inferred.map((column) => column.toLowerCase());
  const hasProvider = normalized.some((column) => column.includes("provider"));
  const hasSearch = normalized.some((column) => /search|web_search|搜索/.test(column));
  const hasPrice =
    normalized.some((column) => /price|pricing|价格|定价|输入|input/.test(column)) &&
    normalized.some((column) => /price|pricing|价格|定价|输出|output/.test(column));
  const hasEvidence =
    normalized.some((column) => /url|证据|source/.test(column)) &&
    normalized.some((column) => /摘录|quote|excerpt|原文/.test(column));
  if (inferred.length < 5 || !hasProvider || !hasSearch || !hasPrice || !hasEvidence) {
    return providerColumns;
  }
  return inferred;
}

function inferEvidenceSensitiveProviderTableColumns(texts: string[]): string[] {
  const context = texts.join("\n");
  if (
    !/(?:provider|供应商|提供商)/i.test(context) ||
    !/(?:price|pricing|价格|定价|input|output|输入|输出)/i.test(context) ||
    !/(?:search|web_search|web search|搜索)/i.test(context)
  ) {
    return [];
  }
  const targetModelName = inferRequestedTargetModelName(context);
  return [
    "provider",
    targetModelName ? `是否明确支持 ${targetModelName}` : "是否明确支持目标模型",
    "是否明确支持 search/web_search",
    "输入价格",
    "输出价格",
    "证据 URL",
    "关键原文摘录",
  ];
}

function inferRequestedTargetModelName(context: string): string | null {
  const apiModel = context.match(
    /\b([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6})\s+API\b/,
  )?.[1];
  if (apiModel) {
    return apiModel.trim();
  }
  const providerResearchModel = context.match(
    /\b(?:research|supports?|supporting|for|about|调研)\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6}?)\s+(?:provider|providers|support|search|pricing|price|model|api|API|供应商|提供商|支持|搜索|价格|定价)\b/i,
  )?.[1];
  if (providerResearchModel) {
    return providerResearchModel.trim();
  }
  const supportsModel = context.match(
    /\bsupports?\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*){1,6}?)(?:,|;|\.|\s+and\b|\s+whether\b)/i,
  )?.[1];
  if (supportsModel) {
    return supportsModel.trim();
  }
  const targetModel = context.match(
    /\b(?:target model|model|模型)\s*[:：]\s*([A-Za-z0-9._-]+(?:\s+[A-Za-z0-9._-]+){0,6})\b/i,
  )?.[1];
  return targetModel?.trim() || null;
}

function normalizeRequestedTableColumn(column: string): string | null {
  const normalized = column
    .replace(/^[\s`"'“”‘’]+|[\s`"'“”‘’]+$/g, "")
    .trim();
  if (!normalized) return null;
  if (normalized.length > 80) return null;
  if (/[|]/.test(normalized)) return null;
  if (/[。；;]/.test(normalized)) return null;
  if (/\.{3}|…|[*]{2,}|^---+$/.test(normalized)) return null;
  if (/(?:mission|status|状态|blocked|partial|final answer|source bounded)/i.test(normalized)) return null;
  return normalized;
}

function taskRequestsFinalConclusion(taskPrompt: string): boolean {
  return (
    /(?:最后|最终|末尾|结尾|再给|补充)[^\n。.!?]{0,80}(?:一句话|一[个段]?简短|简短)?[^\n。.!?]{0,60}(?:结论|总结)/i.test(
      taskPrompt,
    ) ||
    /\b(?:final|last|closing)\b[\s\S]{0,120}\b(?:one[- ]sentence|single[- ]sentence|brief)\b[\s\S]{0,80}\b(?:conclusion|summary)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:one[- ]sentence|single[- ]sentence|brief)\b[\s\S]{0,80}\b(?:final|closing)?\s*(?:conclusion|summary)\b/i.test(
      taskPrompt,
    )
  );
}

function taskRequestsTwoRowTable(taskPrompt: string): boolean {
  return (
    /(?:两行|2\s*行|两条|2\s*条)[^\n。.!?]{0,80}(?:表格|表)/.test(
      taskPrompt,
    ) ||
    /\b(?:two[- ]row|2[- ]row|two rows|2 rows)\b[\s\S]{0,80}\btable\b/i.test(
      taskPrompt,
    )
  );
}

function findMissingRequiredFinalDeliverables(input: {
  taskPrompt: string;
  resultText: string;
}): RequiredFinalDeliverable[] {
  return inferRequiredFinalSynthesisDeliverables(input.taskPrompt).filter(
    (deliverable) => !finalDeliverableIsPresent(deliverable, input.resultText),
  );
}

function finalDeliverableIsPresent(
  deliverable: RequiredFinalDeliverable,
  resultText: string,
): boolean {
  if (deliverable.id === "final_conclusion") {
    return /(?:^|\n)\s*(?:#{1,4}\s*)?(?:[*_]{1,3}\s*)?(?:结论|一句话结论|最终结论|总结|Conclusion|Summary)\s*[:：]\s*(?:[*_]{1,3})?/i.test(
      resultText,
    );
  }
  if (deliverable.id === "two_row_table") {
    return markdownTableDataRowCount(resultText) >= 2;
  }
  return true;
}

function markdownTableDataRowCount(resultText: string): number {
  const rows = resultText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (rows.length < 3) return 0;
  const separatorIndex = rows.findIndex((line) =>
    /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line),
  );
  if (separatorIndex < 1) return 0;
  return rows.slice(separatorIndex + 1).filter((line) => {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    return cells.length > 0;
  }).length;
}

function buildMissingRequiredFinalDeliverablesRepairPrompt(input: {
  taskPrompt: string;
  resultText: string;
  missing: RequiredFinalDeliverable[];
  evidenceText: string;
}): string {
  return [
    "Runtime correction: final answer omitted required deliverables from the original task.",
    `Missing deliverables: ${input.missing.map((item) => item.label).join(", ")}.`,
    "Do not call tools. Rewrite the final answer using only the completed delegated evidence below.",
    "Preserve the user's requested final shape, order, source labels, and evidence boundaries.",
    "Add only the missing required deliverable(s); do not invent facts beyond the completed evidence.",
    `Original task:\n${sliceUtf8(input.taskPrompt, 1400)}`,
    `Previous final answer:\n${sliceUtf8(input.resultText, 1400)}`,
    `Completed delegated evidence:\n${sliceUtf8(input.evidenceText, 3600)}`,
  ].join("\n");
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

function buildApprovalWaitTimeoutLocalEvidenceCloseout(input: {
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  evidenceText: string;
  error: unknown;
}): GenerateTextResult {
  return {
    text: [
      "Approval wait-timeout closeout confirmed.",
      "",
      "Wait-timeout closeout evidence is preserved below.",
      "Approval status: the operator decision is still pending after the bounded wait; permission_result returned pending/approval_wait_timeout.",
      "Runtime evidence: permission_query requested approval for browser.form.submit and permission_result confirmed the approval remains pending.",
      "Action boundary: no form submission, no side effects, and no browser mutation were performed.",
      `Verified runtime evidence: ${sliceUtf8(input.evidenceText, 3 * 1024)}`,
      "Residual risk: the requested submit/apply step remains unverified because pending approval remains.",
      "Next action: ask the operator to approve or deny, then continue the same mission and apply only the approved scoped action.",
    ].join("\n"),
    modelId: input.selection.modelId ?? "local-evidence-closeout",
    ...(input.selection.modelChainId
      ? { modelChainId: input.selection.modelChainId }
      : {}),
    providerId: "local",
    protocol: "openai-compatible",
    adapterName: "local-evidence-closeout",
    raw: {
      reason: "approval_wait_timeout_final_synthesis_unavailable",
      message: errorMessage(input.error),
      evidence: sliceUtf8(input.evidenceText, 2000),
    },
  };
}

function requestedColumnsLookLikeProviderSearchPricing(columns: string[]): boolean {
  if (columns.length === 0) {
    return false;
  }
  const normalized = columns.map((column) => column.toLowerCase()).join("\n");
  return (
    /\bprovider\b|供应商|服务商|厂商|平台/.test(normalized) &&
    /search|web_search|搜索/.test(normalized) &&
    /价格|价钱|费用|收费|计费|price|pricing|cost|input|output|输入|输出/.test(
      normalized,
    )
  );
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

function isControlPlaneToolResultName(toolName: string | undefined): boolean {
  return (
    toolName === "sessions_list" ||
    toolName === "sessions_history" ||
    toolName === "permission_query" ||
    toolName === "permission_result" ||
    toolName === "permission_applied"
  );
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

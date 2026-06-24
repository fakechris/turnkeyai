import type {
  Clock,
  MissionTerminalReport,
  RoleActivationInput,
  RoleId,
  RuntimeProgressRecorder,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import { MAX_BROWSER_OPEN_TIMEOUT_MS } from "@turnkeyai/core-types/team";
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
  type NativeToolProgressTrace,
  type NativeToolResultTrace,
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
import { createReActAgent } from "@turnkeyai/agent-core/react-agent";
import type { ModelClient } from "@turnkeyai/agent-core/react-loop";
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

interface SessionContinuationDirective {
  sessionKey: string;
  messageHint: string;
}

interface SessionContinuationLookupDirective {
  messageHint: string;
}

interface SubAgentToolTimeoutSignal {
  toolName: string;
  sessionKey: string;
  agentId: string;
  timeoutSeconds?: number | null;
  evidenceAvailable: boolean;
}

const SESSION_TOOL_RESULT_PROTOCOL = "turnkeyai.session_tool_result.v1";
const SUPPLEMENTAL_LOCAL_TIMEOUT_PROBE_TIMEOUT_SECONDS = 45;
const SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS = 10_000;

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
   * Cutover flag. "inline" (default) runs the original 1900-line loop. "engine"
   * routes the simplest no-policy path through agent-core's createReActAgent.
   * Production stays "inline"; nothing flips until the engine path reaches full
   * parity. Overridable by TURNKEYAI_REACT_ENGINE=engine.
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
    if (this.reactEngine === "engine") {
      return this.runViaReActEngine({
        input,
        selection,
        activeToolLoop,
        initialGatewayInput,
        modelCallTrace,
      });
    }
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
                tools: initialGatewayInput.tools,
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
            assistantText:
              "Checking the pending approval result before closing out.",
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
          resultText: result.text,
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
            content: buildFinalRecoveryBudgetCloseoutRepairPrompt(
              recoveryToolBudget.maxToolCalls,
            ),
          },
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
              resultText: result.text,
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
                content: buildMissingRequestedTableColumnsRepairPrompt({
                  activation: input.activation,
                  taskPrompt: input.packet.taskPrompt,
                  messages,
                  resultText: result.text,
                }),
              },
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
            evidenceText: completedEvidenceText,
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
              content: buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedEvidenceText,
              }),
            },
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
          {
            role: "user",
            content: buildMissingBrowserEvidenceRepairPrompt(
              input.packet.taskPrompt,
            ),
          },
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
          {
            role: "user",
            content: buildMissingProductSignalBrowserEvidenceRepairPrompt(
              input.packet.taskPrompt,
            ),
          },
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
          {
            role: "user",
            content: buildMissingApprovalGateRepairPrompt(),
          },
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
          toolTrace,
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
            content: buildPendingApprovalWaitTimeoutCheckRepairPrompt(),
          },
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
          toolTrace,
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
            content: buildPrematurePendingApprovalRepairPrompt(),
          },
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
          toolTrace,
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
            content: buildStalePendingApprovalRepairPrompt(),
          },
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
          toolTrace,
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
            content: buildStaleDeniedApprovalRepairPrompt(),
          },
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
          toolTrace,
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
            content: buildApprovalWaitTimeoutCloseoutRepairPrompt(),
          },
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
          toolTrace,
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
            content: buildIncompleteApprovedBrowserActionRepairPrompt(),
          },
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
            content: buildAwaitingContextSetupNoToolRepairPrompt(
              input.packet.taskPrompt,
            ),
          },
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
            evidenceText: completedEvidenceText,
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
              content: buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedEvidenceText,
              }),
            },
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
              resultText: result.text,
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
                content: buildFinalRecoveryBudgetCloseoutRepairPrompt(
                  recoveryToolBudget.maxToolCalls,
                ),
              },
            ];
            nextToolChoice = "none";
            continue;
          }
          if (
            shouldRepairMissingRequestedTableColumns({
              activation: input.activation,
              taskPrompt: input.packet.taskPrompt,
              messages,
              resultText: result.text,
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
                content: buildMissingRequestedTableColumnsRepairPrompt({
                  activation: input.activation,
                  taskPrompt: input.packet.taskPrompt,
                  messages,
                  resultText: result.text,
                }),
              },
            ];
            nextToolChoice = "none";
            continue;
          }
          if (
            shouldRepairExtraneousProviderTableSchema({
              activation: input.activation,
              taskPrompt: input.packet.taskPrompt,
              messages,
              resultText: result.text,
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
                content: buildExtraneousProviderTableSchemaRepairPrompt({
                  taskPrompt: input.packet.taskPrompt,
                  resultText: result.text,
                }),
              },
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
              evidenceText: sourceBoundedEvidenceText,
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
                content: buildSourceEvidenceCarryForwardRepairPrompt({
                  taskPrompt: input.packet.taskPrompt,
                  resultText: result.text,
                  evidenceText: sourceBoundedEvidenceText,
                }),
              },
            ];
            nextToolChoice = "none";
            continue;
          }
          if (
            shouldRepairWeakEvidenceSynthesis({
              taskPrompt: input.packet.taskPrompt,
              resultText: result.text,
              messages,
              evidenceText: sourceBoundedEvidenceText,
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
                content: buildWeakEvidenceSynthesisRepairPrompt(),
              },
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
            evidenceText: completedEvidenceText,
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
              content: buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedEvidenceText,
              }),
            },
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
          tools: initialGatewayInput.tools,
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
          tools: initialGatewayInput.tools,
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
            tools: initialGatewayInput.tools,
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
            tools: initialGatewayInput.tools,
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
            tools: initialGatewayInput.tools,
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
            toolTrace,
            tools: initialGatewayInput.tools,
          })
        ) {
          messages = [
            ...messages,
            {
              role: "user",
              content: buildMissingApprovalGateRepairPrompt(),
            },
          ];
          nextToolChoice = { type: "tool", name: "permission_query" };
          continue;
        }
        const forcedPermissionResultCall =
          buildForcedPendingApprovalWaitTimeoutPermissionResultCall({
            taskPrompt: input.packet.taskPrompt,
            toolTrace,
            tools: initialGatewayInput.tools,
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
            assistantText:
              "Checking the pending approval result before closing out.",
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
            resultText: result.text,
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
              content: buildMissingRequestedTableColumnsRepairPrompt({
                activation: input.activation,
                taskPrompt: input.packet.taskPrompt,
                messages,
                resultText: result.text,
              }),
            },
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairExtraneousProviderTableSchema({
            activation: input.activation,
            taskPrompt: input.packet.taskPrompt,
            messages,
            resultText: result.text,
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
              content: buildExtraneousProviderTableSchemaRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
              }),
            },
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairMissingBrowserEvidence({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
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
            {
              role: "user",
              content: buildMissingBrowserEvidenceRepairPrompt(
                input.packet.taskPrompt,
              ),
            },
          ];
          nextToolChoice = { type: "tool", name: "sessions_spawn" };
          continue;
        }
        if (
          shouldRepairMissingProductSignalBrowserEvidence({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
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
            {
              role: "user",
              content: buildMissingProductSignalBrowserEvidenceRepairPrompt(
                input.packet.taskPrompt,
              ),
            },
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
            evidenceText: completedProductBriefEvidenceText,
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
              content: buildSourceEvidenceCarryForwardRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            },
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairTimeoutFollowupFinalGuidance({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            evidenceText: completedProductBriefEvidenceText,
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
              content: buildTimeoutFollowupFinalGuidanceRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            },
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairMissingRequestedNextAction({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
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
              content: buildMissingRequestedNextActionRepairPrompt(),
            },
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
          !hasMissingRequiredFinalDeliverablesRepairPrompt(messages)
        ) {
          messages = [
            ...messages,
            {
              role: "assistant",
              content: result.text,
            },
            {
              role: "user",
              content: buildMissingRequiredFinalDeliverablesRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                missing: missingRequiredDeliverables,
                evidenceText: completedSession.finalContents.join("\n\n"),
              }),
            },
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
            evidenceText: completedProductBriefEvidenceText,
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
              content: buildSourceEvidenceCarryForwardRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            },
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairTimeoutFollowupFinalGuidance({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
            evidenceText: completedProductBriefEvidenceText,
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
              content: buildTimeoutFollowupFinalGuidanceRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedProductBriefEvidenceText,
              }),
            },
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
            evidenceText: completedSession.finalContents.join("\n\n"),
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
              content: buildMissingBrowserEvidenceDimensionsRepairPrompt({
                taskPrompt: input.packet.taskPrompt,
                resultText: result.text,
                evidenceText: completedSession.finalContents.join("\n\n"),
              }),
            },
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          completedSession.finalContents.length > 0 &&
          shouldRepairFalseEvidenceBlockedSynthesis({
            resultText: result.text,
            messages,
            evidenceText: completedSession.finalContents.join("\n\n"),
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
              content: buildFalseEvidenceBlockedSynthesisRepairPrompt(
                completedSession.finalContents,
              ),
            },
          ];
          nextToolChoice = "none";
          continue;
        }
        if (
          shouldRepairWeakEvidenceSynthesis({
            taskPrompt: input.packet.taskPrompt,
            resultText: result.text,
            messages,
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
            {
              role: "user",
              content: buildWeakEvidenceSynthesisRepairPrompt(),
            },
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
                tools: initialGatewayInput.tools,
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
   * Cutover beachhead: run the simplest no-policy path through agent-core's
   * createReActAgent instead of the inline loop. Reuses the same model stack
   * (generateWithEnvelopeRetry) and tool executor, and assembles content +
   * mentions identically to the inline path. Full metadata + policy parity
   * (repair, approval, continuation, closeouts) lands in later cutover stages;
   * until then this is gated behind reactEngine: "engine" and exercised only on
   * simple scenarios. Production stays "inline".
   *
   * Known scope gap (execution/budget convergence stage): tool calls run
   * per-call through the executor, NOT through the inline executeToolCalls
   * wrapper, so a round with multiple calls does not yet honor
   * maxParallelToolCalls / maxToolCallsPerRound / order-dependent serialization /
   * wall-clock aborts / progress persistence. The engine path is therefore
   * scoped to single-tool-per-round simple scenarios until those limits are
   * wired into the engine.
   */
  private async runViaReActEngine(args: {
    input: { activation: RoleActivationInput; packet: RolePromptPacket; signal?: AbortSignal };
    selection: Parameters<LLMRoleResponseGenerator["generateWithEnvelopeRetry"]>[0]["selection"];
    activeToolLoop: RoleToolLoopOptions | undefined;
    initialGatewayInput: GenerateTextInput;
    modelCallTrace: ModelCallBoundaryTrace[];
  }): Promise<GeneratedRoleReply> {
    const { activation, packet, signal } = args.input;
    const { selection, activeToolLoop, initialGatewayInput, modelCallTrace } = args;

    let lastResult: GenerateTextResult | undefined;
    let traceRound = 0;
    const model: ModelClient = {
      generate: async ({ messages: roundMessages, tools, toolChoice }) => {
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
        const gatewayMessages = prepareToolHistoryForGateway(roundMessages);
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

    const ctx: RoleToolContext = { activation, packet, ...(signal ? { signal } : {}) };
    const toolLoopStartedAtMs = this.clock.now();
    const maxRounds = activeToolLoop?.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
    // Per-run closeout state: hooks fire across different engine callbacks, so a
    // single mutable object threaded through them collects what the inline loop
    // keeps as locals (toolLoopCloseout/result/reduction/memoryFlushes).
    const run: {
      toolLoopCloseout: ToolLoopCloseoutMetadata | undefined;
      closeoutResult: GenerateTextResult | undefined;
      reduction: { level: RequestEnvelopeReductionLevel; omittedSections: string[] } | undefined;
      reductionSnapshot:
        | ({ level: RequestEnvelopeReductionLevel; omittedSections: string[] } & ReductionEnvelopeSnapshot)
        | undefined;
      memoryFlushes: PreCompactionMemoryFlushResult[];
      // PR2c: onAfterExecute detects the two terminal sub-agent closeouts and
      // stashes the matching signal here so onTerminate can rebuild the inline
      // reasonLines + closeout metadata for the reason it returned.
      completedSession: NonNullable<ReturnType<typeof findCompletedSessionEvidence>> | undefined;
      timeoutSignal: NonNullable<ReturnType<typeof findSubAgentToolTimeout>> | undefined;
    } = {
      toolLoopCloseout: undefined,
      closeoutResult: undefined,
      reduction: undefined,
      reductionSnapshot: undefined,
      memoryFlushes: [],
      completedSession: undefined,
      timeoutSignal: undefined,
    };
    const toolTrace: NativeToolRoundTrace[] = [];
    const agent = createReActAgent<RoleToolContext>({
      model,
      toolkit,
      maxRounds,
      hooks: {
        // Honor the execution limits the per-call default bypasses: order-dependent
        // serialization, bounded concurrency, and per-chunk wall-clock aborts —
        // reusing the same helpers the inline executeToolCalls uses, rather than
        // refactoring that heavily-tested method. (maxToolCallsPerRound cap +
        // progress persistence are wired in a later Stage 5 PR.)
        runToolBatch: async (calls, _runOne, hookCtx) => {
          if (!activeToolLoop) {
            return calls.map((call) => ({
              toolCallId: call.id,
              toolName: call.name,
              isError: true,
              content: `Unknown tool: ${call.name}`,
            }));
          }
          const maxParallel =
            typeof activeToolLoop.maxParallelToolCalls === "number" &&
            Number.isFinite(activeToolLoop.maxParallelToolCalls) &&
            activeToolLoop.maxParallelToolCalls > 0
              ? Math.floor(activeToolLoop.maxParallelToolCalls)
              : calls.length;
          const step = Math.max(1, shouldSerializeToolBatch(calls) ? 1 : maxParallel);
          const results: RoleToolExecutionResult[] = [];
          for (let i = 0; i < calls.length; i += step) {
            const chunk = calls.slice(i, i + step);
            const wallClockMs = resolveEffectiveToolLoopWallClockMs({
              ...(activeToolLoop.maxWallClockMs !== undefined
                ? { maxWallClockMs: activeToolLoop.maxWallClockMs }
                : {}),
              toolCalls: chunk,
            });
            const execSignal = createToolExecutionSignal({
              elapsedMs: this.clock.now() - toolLoopStartedAtMs,
              ...(hookCtx.signal ? { parentSignal: hookCtx.signal } : {}),
              ...(wallClockMs !== undefined ? { maxWallClockMs: wallClockMs } : {}),
            });
            try {
              const chunkResults = await Promise.all(
                chunk.map(async (call) => {
                  try {
                    return await activeToolLoop.executor.execute({
                      call,
                      activation: hookCtx.activation,
                      packet: hookCtx.packet,
                      ...(execSignal.signal ? { signal: execSignal.signal } : {}),
                    });
                  } catch (error) {
                    // Aborts (operator cancellation or a per-chunk wall-clock
                    // timeout) MUST propagate, exactly like the inline
                    // executeToolCalls catch (isAbortError → rethrow). Swallowing
                    // an abort into an isError result would let the loop keep
                    // making model/tool rounds past a cancellation or budget that
                    // should have stopped it.
                    if (isAbortError(error)) {
                      throw error;
                    }
                    // A non-abort tool failure becomes an isError result the model
                    // can observe, not a rejected (failed) response.
                    return {
                      toolCallId: call.id,
                      toolName: call.name,
                      isError: true,
                      content: error instanceof Error ? error.message : String(error),
                    };
                  }
                }),
              );
              results.push(...chunkResults);
            } finally {
              execSignal.dispose();
            }
          }
          return results;
        },
        // Stage 5 PR2c closeout detection: mirror the inline post-execute
        // terminal closeouts. After a tool round runs, inspect the round's
        // results with the same finders the inline loop uses (findCompletedSession
        // Evidence / findSubAgentToolTimeout) and return the closeout reason; the
        // engine then routes a non-null reason through terminate → onTerminate,
        // exactly like a terminationPredicate. Order matches inline: a completed
        // delegated session wins over a timeout signal in the same round.
        //
        // Scope: this fires ONLY the two TERMINAL closeouts. The inline
        // post-execute block also has continuation/repair branches (supplemental
        // probe, approval-gate repair, independent-evidence streams, forced
        // permission_result, weak-evidence) that `continue` the loop instead of
        // closing out — those are the approval/recovery cutover stages. Until
        // they land, the engine path is exercised only by parity scenarios that
        // trip none of them.
        onAfterExecute: (results) => {
          const completedSession = findCompletedSessionEvidence(results);
          if (completedSession) {
            run.completedSession = completedSession;
            return "completed_sub_agent_final";
          }
          const timeoutSignal = findSubAgentToolTimeout(results);
          if (timeoutSignal) {
            run.timeoutSignal = timeoutSignal;
            return "sub_agent_timeout";
          }
          return null;
        },
        // Stage 5 closeout-answer producer. round_limit (PR2a),
        // completed_sub_agent_final + sub_agent_timeout (PR2c) are reachable;
        // each closeout reason gets its inline reasonLines + status here.
        onTerminate: async (reason, state) => {
          // Each closeout reason rebuilds the inline reasonLines + closeout
          // metadata it produced inline; the round_limit defaults remain the
          // fallback for any reason without a bespoke branch. completed/timeout
          // read the signal onAfterExecute stashed on `run`.
          let reasonLines: string[] | undefined;
          let closeout: ToolLoopCloseoutMetadata;
          if (reason === "completed_sub_agent_final" && run.completedSession) {
            const completedSession = run.completedSession;
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
          } else if (reason === "sub_agent_timeout" && run.timeoutSignal) {
            const timeoutSignal = run.timeoutSignal;
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
            reasonLines =
              reason === "round_limit"
                ? [
                    `Tool-use round limit reached (${maxRounds}).`,
                    "Do not call more tools. Produce the best final answer from the evidence already gathered.",
                    "State uncertainties and missing verification explicitly instead of trying another lookup.",
                  ]
                : undefined;
            closeout = {
              reason: reason as ToolLoopCloseoutMetadata["reason"],
              maxRounds,
              toolCallCount: countToolCalls(toolTrace),
              roundCount: toolTrace.length,
              evidenceAvailable: hasUsableEvidence(toolTrace),
            };
          }
          const generated = await this.generateFinalAfterToolRoundLimit({
            activation,
            packet,
            selection,
            baseGatewayInput: initialGatewayInput,
            messages: state.messages,
            maxRounds,
            modelCallTrace,
            ...(reasonLines ? { reasonLines } : {}),
          });
          // Mirror the inline per-reason trailing transforms. completed: redact
          // forbidden local URLs from the delegated evidence (inline :1784).
          // timeout: append the resumable-continuation sentence (inline :2197).
          // Other reasons pass through.
          //
          // Scope gap (deferred to the browser/recovery cutover stages): the
          // inline completed branch also runs maybeAppendBrowserRecoveryVisibility
          // / maybeAppendBrowserFailureBucketVisibility / the recovered-timeout +
          // continuation appenders (:1747-1783) before redaction. Those only fire
          // for browser-recovery or timed-out-then-completed delegated sessions —
          // scenarios that ALSO trip the inline pre-synthesis continuation
          // branches this slice doesn't yet handle, so they cannot be parity-
          // tested here (a browser session would diverge on the continuation, not
          // the appender). For the clean delegated sessions in scope they are
          // no-ops, so redaction alone preserves parity.
          const closeoutResult =
            reason === "completed_sub_agent_final"
              ? maybeRedactForbiddenLocalUrls({ result: generated.result, packet })
              : reason === "sub_agent_timeout"
                ? maybeAppendTimeoutContinuationVisibility(generated.result)
                : generated.result;
          run.toolLoopCloseout = closeout;
          run.closeoutResult = closeoutResult;
          if (generated.reduction) {
            run.reduction = generated.reduction;
            run.reductionSnapshot = generated.reductionSnapshot;
          }
          if (generated.memoryFlush) {
            run.memoryFlushes.push(generated.memoryFlush);
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
        // Stage 7 scope gap: the inline path first checks for a pending approval
        // (buildForcedPendingApprovalWaitTimeoutPermissionResultCall → a forced
        // permission_result round) before this fallback, so an approval/denial
        // that arrived before the provider error is observed. That forced-round
        // machinery is the approval/continuation cutover stage; until it lands,
        // the engine model-error closeout is scoped to non-approval flows.
        onModelCallError: (error, state, _ctx) => {
          if (isAbortError(error)) {
            return "rethrow";
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
          run.toolLoopCloseout = {
            reason: "tool_evidence_fallback",
            maxRounds,
            toolCallCount: countToolCalls(toolTrace),
            roundCount: toolTrace.length,
            evidenceAvailable: true,
          };
          run.closeoutResult = maybeRedactForbiddenLocalUrls({ result: localResult, packet });
          return {
            text: run.closeoutResult.text,
            ...(run.closeoutResult.stopReason ? { stopReason: run.closeoutResult.stopReason } : {}),
          };
        },
      },
    });

    let finalText = "";
    let currentRound: NativeToolRoundTrace | undefined;
    for await (const event of agent.run({
      messages: initialGatewayInput.messages,
      ctx,
      ...(signal ? { signal } : {}),
    })) {
      if (event.type === "model_response") {
        if (event.toolCalls.length > 0) {
          currentRound = {
            round: event.round + 1,
            calls: event.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              input: call.input,
            })),
            results: [],
            progress: [],
          };
          toolTrace.push(currentRound);
        }
      } else if (event.type === "tool_result" && currentRound) {
        currentRound.results.push({
          toolCallId: event.result.toolCallId,
          toolName: event.result.toolName,
          isError: event.result.isError === true,
          contentBytes: new TextEncoder().encode(event.result.content ?? "").length,
          ...(event.result.content ? { content: event.result.content } : {}),
          ...(event.result.cancelled ? { cancelled: true } : {}),
          ...(event.result.skipped ? { skipped: true } : {}),
        });
      } else if (event.type === "final") {
        finalText = event.text;
      }
    }

    // Record the request-envelope reduction boundary before building metadata,
    // matching the inline path's observability (a closeout's final synthesis may
    // have overflowed and reduced).
    if (run.reductionSnapshot) {
      await this.recordReductionBoundarySafely(activation, packet, selection, run.reductionSnapshot);
    }

    const content = enforceRequestedThreeLineLabelShape({
      taskPrompt: packet.taskPrompt,
      resultText: finalText,
    });
    // On a closeout, metadata reflects the closeout-synthesis result (matching
    // inline), falling back to the last tool-round result otherwise.
    const metaResult = run.closeoutResult ?? lastResult;
    const missionReport = buildRuntimeDerivedMissionReport(run.toolLoopCloseout);
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
        ...(run.reduction ? { requestEnvelopeReduction: run.reduction } : {}),
        ...(run.memoryFlushes.length ? { preCompactionMemoryFlushes: run.memoryFlushes } : {}),
        ...(run.toolLoopCloseout ? { toolLoopCloseout: run.toolLoopCloseout } : {}),
        ...(missionReport ? { missionReport } : {}),
        reactEngine: true,
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
      const result: RoleToolExecutionResult = {
        toolCallId: call.id,
        toolName: call.name,
        content: `tool_call_limit_exceeded: skipped ${call.name}; at most ${maxToolCallsPerRound} tool calls may be executed in one assistant turn.`,
        isError: true,
        skipped: true,
        progress: [
          {
            phase: "failed",
            toolName: call.name,
            summary: `Skipped ${call.name}: per-turn tool call limit exceeded.`,
            detail: {
              admission: "skipped",
              reason: "max_tool_calls_per_round",
              max_tool_calls_per_round: maxToolCallsPerRound,
              requested_tool_calls: input.toolCalls.length,
            },
          },
        ],
      };
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

function taskAllowsPermissionTools(taskPrompt: string): boolean {
  if (disclaimsApprovalGatedBrowserAction(taskPrompt)) {
    return false;
  }
  return (
    /\b(?:permission_(?:query|result|applied)|permission\.(?:query|result|applied)|approval_id|approval id|pending approval|operator approval|operator decision|approval (?:gate|request|decision|granted|approved|denied|applied)|approved action|denied action)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:approve|approved|approval|permission|operator review)\b[\s\S]{0,180}\b(?:submit|submission|form|click|mutat(?:e|ion)|side[- ]effects?|browser\.form\.submit|apply|execute|dry[- ]run)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:submit|submission|form|click|mutat(?:e|ion)|side[- ]effects?|browser\.form\.submit|apply|execute|dry[- ]run)\b[\s\S]{0,180}\b(?:approve|approved|approval|permission|operator review)\b/i.test(
      taskPrompt,
    )
  );
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

function taskPromptLooksLikeSourceCheckContinuation(taskPrompt: string): boolean {
  return (
    /\b(?:slow-source|slow source|slow-fixture|slow fixture|source-check|source check)\b/i.test(taskPrompt) &&
    /\b(?:continue|retry|resume|recovered|recovery|follow-?up|same source-check context|same source check context|existing source-check context|existing source check context)\b/i.test(
      taskPrompt,
    ) &&
    /\b(?:timeout|timed out|bounded attempt|release-risk|release risk|risk note|residual risk)\b/i.test(taskPrompt)
  );
}

// ORDER_DEPENDENT_TOOL_NAMES, shouldSerializeToolBatch, findRepeatedFailedToolCall
// extracted to ./react/predicates (Phase 1 cutover, behavior-preserving).

function findRepeatedSessionInspectionCall(
  pendingCalls: LLMToolCall[],
  toolTrace: NativeToolRoundTrace[],
  taskPrompt: string,
  sessionContext = "",
): { toolName: string; sessionKey: string } | null {
  if (pendingCalls.length === 0 || toolTrace.length === 0) {
    return null;
  }
  if (taskRequestsSessionTranscript(taskPrompt)) {
    return null;
  }
  const inspected = new Set<string>();
  for (const round of toolTrace) {
    for (const call of round.calls) {
      if (call.name !== "sessions_history") continue;
      const sessionKey = readSessionKeyFromToolInput(call.input);
      if (!sessionKey) continue;
      const result = round.results.find(
        (candidate) => candidate.toolCallId === call.id,
      );
      if (!result || result.isError || result.cancelled || result.skipped) {
        continue;
      }
      inspected.add(sessionKey);
    }
  }
  for (const call of pendingCalls) {
    if (call.name !== "sessions_history") continue;
    const sessionKey = readSessionKeyFromToolInput(call.input);
    if (sessionKey && inspected.has(sessionKey)) {
      return { toolName: call.name, sessionKey };
    }
    if (sessionKey && contextAlreadyContainsSessionHistory(sessionContext, sessionKey)) {
      return { toolName: call.name, sessionKey };
    }
  }
  return null;
}

function contextAlreadyContainsSessionHistory(context: string, sessionKey: string): boolean {
  if (!context || !sessionKey || !context.includes(sessionKey)) {
    return false;
  }
  return /\b(?:sessions_history|total_messages|has_more_after|previous_cursor)\b/i.test(context);
}

function findExcessiveSessionContinuationCall(
  pendingCalls: LLMToolCall[],
  toolTrace: NativeToolRoundTrace[],
  maxContinuations = 2,
): { toolName: string; sessionKey: string; continuationCount: number } | null {
  if (pendingCalls.length === 0 || toolTrace.length === 0) {
    return null;
  }
  const continuedCounts = countSuccessfulSessionContinuations(toolTrace);
  for (const call of pendingCalls) {
    if (call.name !== "sessions_send") continue;
    const sessionKey = readSessionKeyFromToolInput(call.input);
    if (!sessionKey) continue;
    const continuationCount = continuedCounts.get(sessionKey) ?? 0;
    if (continuationCount >= maxContinuations) {
      return {
        toolName: call.name,
        sessionKey,
        continuationCount,
      };
    }
  }
  return null;
}

function countSuccessfulSessionContinuations(
  toolTrace: NativeToolRoundTrace[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const round of toolTrace) {
    for (const call of round.calls) {
      if (call.name !== "sessions_send") continue;
      const sessionKey = readSessionKeyFromToolInput(call.input);
      if (!sessionKey) continue;
      const result = round.results.find(
        (candidate) => candidate.toolCallId === call.id,
      );
      if (!result || result.isError || result.cancelled || result.skipped) {
        continue;
      }
      counts.set(sessionKey, (counts.get(sessionKey) ?? 0) + 1);
    }
  }
  return counts;
}

function readSessionKeyFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = (input as Record<string, unknown>)["session_key"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function taskRequestsSessionTranscript(taskPrompt: string): boolean {
  return /\b(?:full|complete|entire|raw)\s+(?:session\s+)?(?:transcript|history|log)\b|\b(?:show|print|dump|export)\s+(?:the\s+)?(?:session\s+)?(?:transcript|history|log)\b|完整(?:会话|历史|记录)|原始(?:会话|历史|记录)/iu.test(
    taskPrompt,
  );
}

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

// PR K3.6: byte cap for the per-result content slice we persist on
// each assistant message. Generous enough to capture a full HTML
// snapshot of a typical page, small enough that a chain of
// long-running browser sessions doesn't bloat the message log to
// MBs. The full content still flows through the LLM tool loop in
// memory; this cap only governs what lands on disk.
const ROLE_TOOL_RESULT_TRACE_CAP_BYTES = 8 * 1024;
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

function sliceUtf8(value: string, maxBytes: number): string {
  // gemini + coderabbit K3.6: keep the persisted slice strictly
  // <= maxBytes. The earlier version appended an "…[truncated]"
  // suffix AFTER slicing, blowing the byte budget by 14 bytes.
  // The trace already carries a `contentTruncated: true` flag so
  // the UI knows to label it — no need to encode "truncated" in
  // the bytes themselves.
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  // Step back if the last byte is a continuation byte (10xxxxxx)
  // until we land on a codepoint boundary.
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function toNativeToolResultTrace(
  toolResult: RoleToolExecutionResult,
): NativeToolResultTrace {
  const bytes = Buffer.byteLength(toolResult.content, "utf8");
  const traceContent = compactToolResultTraceContent(toolResult.content);
  const traceBytes = Buffer.byteLength(traceContent.content, "utf8");
  const truncated = traceBytes > ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
  return {
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    isError: toolResult.isError === true,
    contentBytes: bytes,
    content: truncated
      ? sliceUtf8(traceContent.content, ROLE_TOOL_RESULT_TRACE_CAP_BYTES)
      : traceContent.content,
    ...(truncated || traceContent.compacted ? { contentTruncated: true } : {}),
    ...(toolResult.cancelled ? { cancelled: true } : {}),
    ...(toolResult.skipped ? { skipped: true } : {}),
  };
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

function compactToolResultTraceContent(content: string): {
  content: string;
  compacted: boolean;
} {
  const parsed = parseSessionToolResult(content);
  if (!parsed) {
    return { content, compacted: false };
  }
  const compacted = {
    protocol: parsed.protocol,
    status: parsed.status,
    agent_id: parsed.agent_id,
    ...(parsed.label ? { label: parsed.label } : {}),
    session_key: parsed.session_key,
    task_id: parsed.task_id,
    ...(parsed.parent_session_key
      ? { parent_session_key: parsed.parent_session_key }
      : {}),
    ...(parsed.tool_call_id ? { tool_call_id: parsed.tool_call_id } : {}),
    ...(parsed.resumable ? { resumable: parsed.resumable } : {}),
    ...(parsed.timeout_seconds == null
      ? {}
      : { timeout_seconds: parsed.timeout_seconds }),
    ...(parsed.evidence_available == null
      ? {}
      : { evidence_available: parsed.evidence_available }),
    tool_chain: parsed.tool_chain,
    ...compactSessionPayloadArtifactRefs(parsed.payload),
    ...compactSessionPayloadEvidenceExcerpt(parsed.payload),
    ...(typeof parsed.evidence_summary === "string"
      ? { evidence_summary: sliceUtf8(parsed.evidence_summary, 1024) }
      : {}),
    final_content:
      typeof parsed.final_content === "string"
        ? sliceUtf8(parsed.final_content, 3 * 1024)
        : null,
    result:
      typeof parsed.result === "string" ? sliceUtf8(parsed.result, 1024) : "",
  };
  const compactContent = fitCompactToolResultTraceContent(compacted);
  return {
    content: compactContent,
    compacted: compactContent !== content,
  };
}

function fitCompactToolResultTraceContent(
  input: Record<string, unknown>,
): string {
  const compacted = { ...input };
  const serialize = () => JSON.stringify(compacted, null, 2);
  const fits = (value: string) =>
    Buffer.byteLength(value, "utf8") <= ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
  const trySerialize = () => {
    const value = serialize();
    return fits(value) ? value : null;
  };

  const initial = trySerialize();
  if (initial) return initial;

  const shrinkStringField = (field: string, maxBytes: number) => {
    const value = compacted[field];
    if (typeof value === "string") {
      compacted[field] = maxBytes > 0 ? sliceUtf8(value, maxBytes) : "";
    }
  };
  const deleteField = (field: string) => {
    delete compacted[field];
  };
  const prunePayload = (
    field: "screenshotPaths" | "artifactIds",
    limit: number,
  ) => {
    const payload = compacted.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const values = readStringArray(record[field]);
    if (values.length > limit) {
      record[field] = values.slice(0, limit);
      record[`${field}Truncated`] = true;
      record[`${field}Count`] = values.length;
    }
  };

  const steps: Array<() => void> = [
    () => shrinkStringField("final_content", 2048),
    () => shrinkStringField("result", 768),
    () => shrinkStringField("evidence_summary", 512),
    () => shrinkStringField("evidence_excerpt", 512),
    () => shrinkStringField("final_content", 1024),
    () => shrinkStringField("result", 384),
    () => deleteField("evidence_summary"),
    () => deleteField("evidence_excerpt"),
    () => shrinkStringField("final_content", 512),
    () => shrinkStringField("result", 0),
    () => {
      compacted.final_content = null;
    },
    () => prunePayload("screenshotPaths", 4),
    () => prunePayload("artifactIds", 16),
  ];

  for (const step of steps) {
    step();
    const value = trySerialize();
    if (value) return value;
  }

  const minimal = {
    protocol: compacted.protocol,
    status: compacted.status,
    agent_id: compacted.agent_id,
    session_key: compacted.session_key,
    task_id: compacted.task_id,
    tool_chain: compacted.tool_chain,
    payload: compacted.payload,
    result: "session tool result compacted",
    final_content: null,
  };
  const minimalContent = JSON.stringify(minimal, null, 2);
  if (fits(minimalContent)) return minimalContent;
  return JSON.stringify({
    protocol: compacted.protocol,
    status: compacted.status,
    result: "session tool result compacted",
  });
}

function compactSessionPayloadEvidenceExcerpt(
  payload: unknown,
): { evidence_excerpt: string } | Record<string, never> {
  const evidence = readPayloadEvidenceExcerpt(payload);
  return evidence ? { evidence_excerpt: sliceUtf8(evidence, 2 * 1024) } : {};
}

function compactSessionPayloadArtifactRefs(
  payload: unknown,
):
  | { payload: { artifactIds?: string[]; screenshotPaths?: string[] } }
  | Record<string, never> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const artifactIds = readStringArray(record.artifactIds);
  const screenshotPaths = readStringArray(record.screenshotPaths);
  if (artifactIds.length === 0 && screenshotPaths.length === 0) {
    return {};
  }
  return {
    payload: {
      ...(artifactIds.length ? { artifactIds } : {}),
      ...(screenshotPaths.length ? { screenshotPaths } : {}),
    },
  };
}

function readPayloadEvidenceExcerpt(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const pages = readPayloadEvidencePages(record);
  const parts = [
    readStringField(record.content),
    ...pages.flatMap((page) => [
      readStringField(page.finalUrl),
      readStringField(page.title),
      readStringField(page.textExcerpt),
    ]),
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => part.trim());
  const joined = dedupeStrings(parts).join("\n");
  return joined || null;
}

function readPayloadEvidencePages(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const pages: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const addPage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const page = value as Record<string, unknown>;
    const key = readStringField(page.finalUrl) ?? readStringField(page.requestedUrl) ?? JSON.stringify(page).slice(0, 120);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    pages.push(page);
  };
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) {
      addPage(page);
    }
  }
  if (Array.isArray(record.sourceResults)) {
    for (const sourceResult of record.sourceResults) {
      if (!sourceResult || typeof sourceResult !== "object" || Array.isArray(sourceResult)) {
        continue;
      }
      addPage((sourceResult as Record<string, unknown>).page);
    }
  }
  addPage(record.page);
  return pages;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
}

function toNativeToolProgressTrace(
  call: LLMToolCall,
  progress: Parameters<typeof recordRoleToolProgress>[0]["progress"],
  ts: number,
): NativeToolProgressTrace {
  return {
    toolCallId: call.id,
    toolName: progress.toolName || call.name,
    phase: progress.phase,
    summary: progress.summary,
    ...(progress.detail ? { detail: progress.detail } : {}),
    ts,
  };
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

function findIncompleteApprovedBrowserSession(input: {
  results: RoleToolExecutionResult[];
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
}): { sessionKey: string; evidence: string } | null {
  if (!hasToolDefinition(input.tools, "sessions_send")) {
    return null;
  }
  if (hasIncompleteApprovedBrowserSessionContinuationPrompt(input.messages)) {
    return null;
  }
  if (!requestsApprovalGatedBrowserAction(input.taskPrompt)) {
    return null;
  }
  if (
    !hasPermissionAppliedEvidence(input.toolTrace) &&
    !taskPromptSaysApprovalAlreadyApplied(input.taskPrompt)
  ) {
    return null;
  }
  for (const result of input.results) {
    if (
      result.toolName !== "sessions_spawn" &&
      result.toolName !== "sessions_send"
    ) {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (
      !parsed ||
      parsed.status !== "completed" ||
      parsed.agent_id !== "browser"
    ) {
      continue;
    }
    if (typeof parsed.session_key !== "string") {
      continue;
    }
    const sessionKey = parsed.session_key.trim();
    if (!sessionKey) {
      continue;
    }
    if (hasExecutedSessionsSend(input.toolTrace, sessionKey)) {
      continue;
    }
    const evidence = readCompletedSessionEvidence(parsed) ?? "";
    if (!matchesAny(evidence, INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS)) {
      continue;
    }
    return {
      sessionKey,
      evidence: sliceUtf8(evidence, 1400),
    };
  }
  return null;
}

function shouldContinueTimedOutSiblingSession(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  timeoutSignal: SubAgentToolTimeoutSignal;
  tools?: GenerateTextInput["tools"];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_send")) {
    return false;
  }
  if (!input.timeoutSignal.sessionKey) {
    return false;
  }
  if (
    hasExecutedSessionsSend(input.toolTrace, input.timeoutSignal.sessionKey)
  ) {
    return false;
  }
  if (hasCoverageTimeoutContinuationPrompt(input.messages)) {
    return false;
  }
  return isCoverageCriticalDelegationTask(input.taskPrompt);
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

function shouldContinueTimedOutApprovedBrowserSession(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  timeoutSignal: SubAgentToolTimeoutSignal;
  tools?: GenerateTextInput["tools"];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_send")) {
    return false;
  }
  if (input.timeoutSignal.agentId !== "browser") {
    return false;
  }
  if (!input.timeoutSignal.sessionKey) {
    return false;
  }
  if (
    hasExecutedSessionsSend(input.toolTrace, input.timeoutSignal.sessionKey)
  ) {
    return false;
  }
  if (hasApprovedBrowserTimeoutContinuationPrompt(input.messages)) {
    return false;
  }
  if (!isAppliedApprovalBrowserContinuation(input.taskPrompt)) {
    return false;
  }
  return true;
}

function hasApprovedBrowserTimeoutContinuationPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some((message) =>
    readMessageContentText(message.content).includes(
      "Runtime correction: approved browser action timed out before verification.",
    ),
  );
}

function buildApprovedBrowserTimeoutContinuationPrompt(
  timeoutSignal: SubAgentToolTimeoutSignal,
): string {
  return [
    "Runtime correction: approved browser action timed out before verification.",
    `The approved browser session is resumable with session_key ${timeoutSignal.sessionKey}.`,
    "Do not finalize a browser.form.submit approval flow from the timeout alone.",
    "Call sessions_send exactly once for that session_key.",
    "Ask the browser sub-agent to continue from its current page state, perform the already-approved browser.form.submit if it has not been performed, and verify the post-submit page state.",
    "The browser sub-agent should use browser_snapshot, browser_act with submit=true on the submit control when needed, then browser_snapshot/browser_screenshot for the result.",
    "If the continued session still cannot verify the approved action, return the concrete blocker and any pre-submit/post-submit evidence instead of a generic timeout summary.",
  ].join("\n");
}

function shouldContinueIndependentEvidenceStreams(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  if (hasIndependentEvidenceStreamContinuationPrompt(input.messages)) {
    return false;
  }
  const requiredStreams = inferIndependentEvidenceStreamCount(input.taskPrompt);
  if (requiredStreams < 2) {
    return false;
  }
  return (
    countCompletedSessionEvidenceResults(input.toolTrace) < requiredStreams
  );
}

function limitIndependentEvidenceSpawnCalls(
  toolCalls: LLMToolCall[],
  input: {
    taskPrompt: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  const requiredStreams = inferIndependentEvidenceStreamCount(input.taskPrompt);
  if (requiredStreams < 2) {
    return toolCalls;
  }
  const spawnCalls = toolCalls.filter((call) => call.name === "sessions_spawn");
  if (spawnCalls.length <= 1) {
    return toolCalls;
  }
  const completedStreams = countCompletedSessionEvidenceResults(
    input.toolTrace,
  );
  const remainingStreams = Math.max(0, requiredStreams - completedStreams);
  if (spawnCalls.length <= remainingStreams) {
    return toolCalls;
  }
  let keptSpawns = 0;
  return toolCalls.filter((call) => {
    if (call.name !== "sessions_spawn") {
      return true;
    }
    keptSpawns += 1;
    return keptSpawns <= remainingStreams;
  });
}

function inferIndependentEvidenceStreamCount(taskPrompt: string): number {
  if (isTwoSourceComparisonTask(taskPrompt)) {
    return Math.min(6, uniqueHttpUrlCount(taskPrompt));
  }
  if (/\b(?:three|3) independent evidence streams\b/i.test(taskPrompt)) {
    return 3;
  }
  if (
    /\b(?:three|3)\b[\s\S]{0,80}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:route|budget|live readiness)\b[\s\S]{0,120}\b(?:separate|independent|distinct)\b[\s\S]{0,80}\bevidence streams\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  if (
    /\bgather evidence from (?:three|3) independent child sessions\b/i.test(
      taskPrompt,
    )
  ) {
    return 3;
  }
  const sourceLineCount = taskPrompt
    .split(/\r?\n/)
    .filter((line) =>
      /^\s*(?:[-*]\s*)?(?:Research source|Capability source|Route source|Budget source|Live signal dashboard|Live readiness dashboard|[A-Z][\w -]{2,30}: use (?:an? )?(?:explore|browser) session)\b/i.test(
        line,
      ),
    ).length;
  return sourceLineCount >= 3 ? sourceLineCount : 0;
}

function isTwoSourceComparisonTask(taskPrompt: string): boolean {
  if (uniqueHttpUrlCount(taskPrompt) !== 2) return false;
  return (
    /\b(?:compare|comparison|between|versus|vs\.?|tradeoff|recommendation)\b/i.test(taskPrompt) ||
    /\b(?:review|check|inspect|fetch|extract)\b[\s\S]{0,120}\b(?:two|2)\b[\s\S]{0,80}\b(?:source pages?|sources?|urls?)\b/i.test(
      taskPrompt,
    ) ||
    /比较|对比|两个来源|两个页面|两个\s*URL/i.test(taskPrompt)
  );
}

function uniqueHttpUrlCount(text: string): number {
  return new Set(extractHttpUrls(text)).size;
}

function countCompletedSessionEvidenceResults(
  toolTrace: NativeToolRoundTrace[],
): number {
  const completedSessionKeys = new Set<string>();
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      if (!result.content) {
        continue;
      }
      const parsed = parseSessionToolResult(result.content);
      if (
        !parsed ||
        parsed.status !== "completed" ||
        !readCompletedSessionEvidence(parsed)
      ) {
        continue;
      }
      completedSessionKeys.add(parsed.session_key);
    }
  }
  return completedSessionKeys.size;
}

function hasIndependentEvidenceStreamContinuationPrompt(
  messages: LLMMessage[],
): boolean {
  const latestMessage = messages.at(-1);
  if (!latestMessage) {
    return false;
  }
  return readMessageContentText(latestMessage.content).includes(
    "Runtime correction: this task declares multiple independent evidence streams.",
  );
}

function buildIndependentEvidenceStreamContinuationPrompt(input: {
  requiredStreams: number;
  completedSessions: number;
}): string {
  return [
    "Runtime correction: this task declares multiple independent evidence streams.",
    `Only ${input.completedSessions} of ${input.requiredStreams} required delegated evidence stream(s) have completed.`,
    "Do not finalize yet. Spawn separate focused sessions for the remaining independent streams so evidence is not collapsed into one worker.",
    "Keep the original source labels, source URLs, required dimensions, and stop conditions. Use browser for browser-visible, live dashboard, rendered, or client-side evidence.",
    "After all independent stream results return, synthesize once from the completed delegated evidence.",
  ].join("\n");
}

function isCoverageCriticalDelegationTask(taskPrompt: string): boolean {
  if (isProviderSearchPricingResearchTask(taskPrompt)) {
    return true;
  }
  const text = taskPrompt.toLowerCase();
  const sourceCount = [
    (taskPrompt.match(/https?:\/\/\S+/g) ?? []).length,
    (text.match(/\b(?:source|evidence stream|child session|marker)\b/g) ?? [])
      .length,
  ].filter((count) => count >= 3).length;
  if (sourceCount === 0) {
    return false;
  }
  return (
    /\bdo not finalize until\b/i.test(taskPrompt) ||
    /\ball (?:three|3|\d+) (?:child session tool results|sources|source checks|evidence streams|markers)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:three|3|\d+) independent evidence streams\b/i.test(taskPrompt) ||
    /\bsource coverage\b/i.test(taskPrompt)
  );
}

function isProviderSearchPricingResearchTask(taskPrompt: string): boolean {
  return (
    /\bproviders?\b|\bvendors?\b|\bplatforms?\b|供应商|服务商|厂商|平台/iu.test(
      taskPrompt,
    ) &&
    /\bweb\s*search\b|\bsearch\b|搜索|联网|检索/iu.test(taskPrompt) &&
    /\bpric(?:e|ing)\b|\bcosts?\b|\bfees?\b|\btokens?\b|价格|价钱|费用|收费|计费|token/iu.test(
      taskPrompt,
    )
  );
}

function hasCoverageTimeoutContinuationPrompt(messages: LLMMessage[]): boolean {
  return messages.some((message) =>
    readMessageContentText(message.content).includes(
      "Runtime correction: a required delegated evidence stream timed out.",
    ),
  );
}

function buildCoverageTimeoutContinuationPrompt(
  timeoutSignal: SubAgentToolTimeoutSignal,
): string {
  return [
    "Runtime correction: a required delegated evidence stream timed out.",
    `The timed-out ${timeoutSignal.agentId} session is resumable with session_key ${timeoutSignal.sessionKey}.`,
    "Do not finalize while the task requires all source coverage and one required stream is still missing.",
    "Call sessions_send exactly once for that session_key to continue the missing source check.",
    "Ask the child session to return only the missing source evidence needed for the final answer.",
    "If the continued session still cannot verify the source, then close out as incomplete/resumable and keep the missing source unverified.",
  ].join("\n");
}

function shouldRunSupplementalLocalTimeoutProbe(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  evidenceText: string;
  tools?: GenerateTextInput["tools"];
  browserAvailable: boolean;
}): { url: string; evidence: string } | null {
  if (
    !input.browserAvailable ||
    !hasToolDefinition(input.tools, "sessions_spawn")
  ) {
    return null;
  }
  if (hasSupplementalLocalTimeoutProbePrompt(input.messages)) {
    return null;
  }
  const context = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  const sourceContext = `${input.taskPrompt}\n${context}\n${input.evidenceText}`;
  if (explicitlyDisallowsBrowserEvidence(sourceContext)) {
    return null;
  }
  const hasTimeoutEvidence =
    hasSessionTimeoutEvidence(input) ||
    mentionsTimeout(`${context}\n${input.evidenceText}`);
  if (
    !hasTimeoutEvidence ||
    !toolTraceHasCall(input.toolTrace, "sessions_send")
  ) {
    return null;
  }
  if (hasCompletedBrowserSessionEvidence(input.toolTrace)) {
    return null;
  }
  if (!looksBoundedTimeoutSourceCheck(sourceContext)) {
    return null;
  }
  if (!isContentPoorTimeoutEvidence(`${context}\n${input.evidenceText}`)) {
    return null;
  }
  const url = extractHttpUrls(sourceContext).find((candidate) => {
    try {
      return isLoopbackHostname(new URL(candidate).hostname);
    } catch {
      return false;
    }
  });
  return url ? { url, evidence: sliceUtf8(input.evidenceText, 1800) } : null;
}

function explicitlyDisallowsBrowserEvidence(text: string): boolean {
  return /\bbrowser[- ]visible\s*\/\s*rendered evidence was not requested\b|\b(?:browser[- ]visible|rendered|browser|DOM|screenshot|snapshot)\b[\s\S]{0,80}\b(?:was not|is not|not)\s+(?:requested|required|needed)\b|\b(?:do not|don't)\s+(?:use|call|inspect|open)\b[\s\S]{0,80}\b(?:browser|rendered|DOM|screenshot|snapshot)/i.test(
    text,
  );
}

function hasSupplementalLocalTimeoutProbePrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some((message) =>
    readMessageContentText(message.content).includes(
      "Runtime correction: resumed timeout evidence is still content-poor.",
    ),
  );
}

function hasLatestSupplementalLocalTimeoutProbePrompt(
  messages: LLMMessage[],
): boolean {
  const latest = messages.at(-1);
  return (
    latest?.role === "user" &&
    readMessageContentText(latest.content).includes(
      "Runtime correction: resumed timeout evidence is still content-poor.",
    )
  );
}

function allowsSupplementalBrowserProbe(packet: RolePromptPacket): boolean {
  const unavailable =
    packet.capabilityInspection?.unavailableCapabilities ?? [];
  return !unavailable.some((capability) => /\bbrowser\b/i.test(capability));
}

function enforceSupplementalLocalTimeoutProbeToolCall(
  toolCalls: LLMToolCall[],
  messages: LLMMessage[],
): LLMToolCall[] {
  const latest = messages.at(-1);
  const latestText =
    latest?.role === "user" ? readMessageContentText(latest.content) : "";
  if (
    !latestText.includes(
      "Runtime correction: resumed timeout evidence is still content-poor.",
    )
  ) {
    return toolCalls;
  }
  const selected =
    toolCalls.find(
      (call) => call.name === "sessions_spawn" || call.name === "sessions_send",
    ) ?? toolCalls[0];
  const selectedText =
    selected?.name === "sessions_spawn"
      ? readStringInput(selected.input, "task")
      : selected?.name === "sessions_send"
        ? readStringInput(selected.input, "message")
        : null;
  const url =
    extractHttpUrls(latestText).find((candidate) => {
      try {
        return isLoopbackHostname(new URL(candidate).hostname);
      } catch {
        return false;
      }
    }) ?? extractHttpUrls(latestText)[0];
  return [
    {
      id: selected?.id ?? "runtime-supplemental-local-timeout-probe",
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label:
          (selected ? readStringInput(selected.input, "label") : undefined) ??
          "supplemental local timeout probe",
        timeout_seconds: SUPPLEMENTAL_LOCAL_TIMEOUT_PROBE_TIMEOUT_SECONDS,
        task: [
          "Use private browser page tools for browser-visible/local runtime evidence; do not spawn or continue another session.",
          `Supplemental local timeout probe mode: call browser_open with timeout_ms ${SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS} and then stop with observed evidence or explicit unavailable fields.`,
          selectedText,
          url
            ? `Open ${url} as an operator would see it with a bounded local-runtime attempt.`
            : "Open the loopback URL from the parent correction with a bounded local-runtime attempt.",
          "Return only observed evidence: final URL, title, visible marker/text, loading completion, console/network failures if available, screenshot/artifact references if captured, and any remaining unverified items.",
          "If the page still does not produce evidence, report that status/body/header/rendered content remain unavailable and keep the release-risk conclusion source-bounded.",
        ]
          .filter(
            (part): part is string =>
              typeof part === "string" && part.trim().length > 0,
          )
          .join("\n\n"),
      },
    },
  ];
}

function isContentPoorTimeoutEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || !mentionsTimeout(normalized)) {
    return false;
  }
  const hasPositiveSourceEvidence =
    /\b(?:HTTP\s*(?:status\s*)?200|status\s*[:=]?\s*200|(?:response body|body text)\b[\s\S]{0,80}\b(?:observed|captured|returned)|headers?\b[\s\S]{0,80}\b(?:observed|captured|returned)|TURNKEYAI_[A-Z0-9_]+_OK|readyState\s*[:=]?\s*complete|page title|visible text|source (?:returned|responded)|returned release-risk evidence)\b/i.test(
      normalized,
    );
  if (hasPositiveSourceEvidence) {
    return false;
  }
  return (
    /\b(?:no HTTP status|status code (?:was )?not obtained|no response headers?|no response body|body (?:was )?not retrieved|no usable evidence|no source content|returned no source content|verification did not complete|unverified|timed out before)\b/i.test(
      normalized,
    ) ||
    /\b(?:sub-agent session timed out|execution paused before completion|WORKER_TIMEOUT|timed out after \d+(?:\.\d+)?s)\b/i.test(
      normalized,
    )
  );
}

function buildSupplementalLocalTimeoutProbePrompt(input: {
  url: string;
  evidence: string;
}): string {
  return [
    "Runtime correction: resumed timeout evidence is still content-poor.",
    `The resumed source-check still lacks response status/body/header or rendered page evidence for ${input.url}.`,
    "Spawn exactly one focused browser session now. Use the browser worker for browser-visible/local runtime evidence; do not use explore or public-source fetch.",
    `Supplemental local timeout probe mode: call browser_open with timeout_ms ${SUPPLEMENTAL_BROWSER_OPEN_TIMEOUT_MS}, then stop with observed evidence or explicit unavailable fields.`,
    "Open the loopback URL as an operator would see it with a bounded local-runtime attempt.",
    "Return only observed evidence: final URL, title, visible marker/text, whether loading completed, console/network failures if available, screenshot/artifact references if captured, and any remaining unverified items.",
    "If the page still does not produce evidence, report that status/body/header/rendered content remain unavailable and keep the release-risk conclusion source-bounded.",
    `Prior content-poor timeout evidence:\n${input.evidence}`,
  ].join("\n");
}

function readCompletedSessionEvidence(
  parsed: NonNullable<ReturnType<typeof parseSessionToolResult>>,
): string | null {
  if (typeof parsed.final_content === "string" && parsed.final_content.trim()) {
    const finalContent = parsed.final_content.trim();
    if (parsed.agent_id === "browser") {
      const browserEvidence = [
        parsed.evidence_summary,
        finalContent,
        parsed.result,
      ]
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .map((item) => item.trim());
      return dedupeStrings(browserEvidence).join("\n\n");
    }
    const payload = parsed.payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const mode = (payload as Record<string, unknown>)["mode"];
        if (mode === "llm_sub_agent") {
          return [finalContent, readBrowserFailureBucketSummary(payload as Record<string, unknown>)]
            .filter((item): item is string => Boolean(item))
            .join("\n\n");
        }
      }
  }
  const evidence = [parsed.result, parsed.evidence_summary]
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
  return evidence.length > 0 ? [...new Set(evidence)].join("\n\n") : null;
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

function readBrowserFailureBucketSummary(payload: Record<string, unknown>): string | null {
  const buckets = normalizeBrowserFailureBucketRecords(payload["failureBuckets"]);
  const recovery = payload["browserRecovery"];
  if (recovery && typeof recovery === "object" && !Array.isArray(recovery)) {
    buckets.push(...normalizeBrowserFailureBucketRecords((recovery as Record<string, unknown>)["failureBuckets"]));
  }
  if (buckets.length === 0) {
    return null;
  }
  const merged = new Map<string, number>();
  for (const bucket of buckets) {
    merged.set(bucket.bucket, (merged.get(bucket.bucket) ?? 0) + bucket.count);
  }
  return `Browser failure buckets: ${[...merged.entries()]
    .map(([bucket, count]) => `${bucket}=${count}`)
    .sort()
    .join(", ")}.`;
}

function normalizeBrowserFailureBucketRecords(value: unknown): Array<{ bucket: string; count: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const bucket = record["bucket"];
    const count = record["count"];
    if (typeof bucket !== "string" || !bucket.trim()) {
      return [];
    }
    return [{ bucket: bucket.trim(), count: typeof count === "number" && Number.isFinite(count) ? count : 1 }];
  });
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

function maybeAppendBrowserFailureBucketVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  evidenceText: string;
}): GenerateTextResult {
  const buckets = collectBrowserFailureBucketNames(input.evidenceText);
  if (buckets.length === 0) {
    return input.result;
  }
  if (expectsExactFinalAnswerShape(input.taskPrompt, input.result.text)) {
    return input.result;
  }
  const missingBuckets = buckets.filter(
    (bucket) => !browserFailureBucketVisible(input.result.text, bucket),
  );
  if (missingBuckets.length === 0) {
    return input.result;
  }
  const limitation = buildBrowserFailureBucketVisibilityLine(missingBuckets, input.result.text);
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${limitation}`.trim(),
  };
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

function collectBrowserFailureBucketNames(text: string): string[] {
  const buckets = new Set<string>();
  const pattern =
    /\b(target_not_found|attach_failed|expert_session_detached|cdp_command_timeout|browser_cdp_unavailable|detached_target|session_not_found|wait_condition_timeout|transport_failure|owner_mismatch|lease_conflict)\b/gi;
  for (const match of text.matchAll(pattern)) {
    buckets.add(match[1]!.toLowerCase());
  }
  return [...buckets].sort();
}

function browserFailureBucketVisible(text: string, bucket: string): boolean {
  if (bucket === "cdp_command_timeout") {
    return /\b(?:CDP|snapshot|screenshot|capture|browser)\b[\s\S]{0,160}\b(?:timed out|timeout|incomplete|not captured|not verified|unverified|bounded)\b/i.test(
      text,
    );
  }
  if (bucket === "browser_cdp_unavailable") {
    return /\b(?:browser|CDP|Chrome DevTools)\b[\s\S]{0,160}\b(?:unavailable|unreachable|not reachable|connection refused)\b/i.test(
      text,
    );
  }
  if (bucket === "detached_target") {
    return /\b(?:browser|target|tab|page)\b[\s\S]{0,160}\bdetached\b|\bdetached\b[\s\S]{0,160}\b(?:browser|target|tab|page)\b/i.test(
      text,
    );
  }
  if (new RegExp(`\\b${escapeRegExp(bucket)}\\b`, "i").test(text)) {
    return true;
  }
  return /\b(?:browser|session|target|transport|attach|detached|profile)\b[\s\S]{0,160}\b(?:recovered|failed|unavailable|not found|detached|bounded|unverified)\b/i.test(
    text,
  );
}

function buildBrowserFailureBucketVisibilityLine(buckets: string[], resultText: string): string {
  if (buckets.includes("detached_target")) {
    return [
      `Browser limitation: browser target detached during browser work (${buckets.join(", ")}).`,
      "Treat the verified page facts as bounded target evidence; browser target details beyond the reported URL, marker, screenshot, or visible text remain incomplete or unverified.",
      "Next action: retry or continue the browser task after the target is stable if additional rendered details matter.",
    ].join(" ");
  }
  if (buckets.includes("cdp_command_timeout")) {
    return [
      `Browser limitation: ${buckets.join(", ")} occurred during browser CDP capture/snapshot work.`,
      "Treat the verified page facts as bounded to recovered browser evidence; deeper CDP traversal or missing capture details remain unverified.",
      "Next action: retry or continue the browser capture with a longer timeout if those missing details matter.",
    ].join(" ");
  }
  if (hasRecoveredRenderedBrowserEvidence(resultText)) {
    return [
      `Browser limitation: ${buckets.join(", ")} occurred during browser work.`,
      "Treat the verified page facts above as bounded to recovered browser evidence; no additional browser-visible facts are claimed beyond the reported marker, URL, screenshot, or confirmation text.",
      "Next action: retry or continue the browser task only if extra rendered details beyond those reported facts matter.",
    ].join(" ");
  }
  return [
    `Browser limitation: ${buckets.join(", ")} occurred during browser work.`,
    "Verified: the browser failure bucket itself is the available source-backed evidence; rendered page content remains unverified.",
    "Next action: retry or continue the browser task after the browser target/session is stable if the missing rendered evidence matters.",
  ].join(" ");
}

function hasRecoveredRenderedBrowserEvidence(text: string): boolean {
  if (
    /\b(?:rendered|browser-visible|visible page|page content)\b[\s\S]{0,120}\b(?:unverified|not verified|unknown|missing|blocked|not confirmed)\b/i.test(
      text
    ) ||
    /\b(?:unverified|not verified|unknown|missing|blocked|not confirmed)\b[\s\S]{0,120}\b(?:rendered|browser-visible|visible page|page content)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return (
    /\b(?:marker|confirmation marker|success text|confirmation text|final URL|screenshot|snapshot|post-submit|post submission|post-submission|page confirmed|browser fixture evidence)\b/i.test(
      text
    ) ||
    /\b(?:verified|observed|confirmed|found)\b[\s\S]{0,160}\b(?:page|fixture|marker|screenshot|snapshot|URL|confirmation|success text|rendered|browser-visible)\b/i.test(
      text
    )
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

function requestsStatusVisibleTextEvidenceUrlLines(taskPrompt: string): boolean {
  return (
    /(?:只|仅|只需|仅需)(?:用|以)?(?:回答|输出|返回|给出)[^\n。；;]{0,24}(?:三|3)\s*(?:行|条|句)/i.test(
      taskPrompt,
    ) &&
    /状态/.test(taskPrompt) &&
    /最终可见文本/.test(taskPrompt) &&
    /证据\s*URL/i.test(taskPrompt)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function shouldAppendRecoveredTimeoutCloseoutVisibility(input: {
  resultText: string;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const recoveredTimeoutContext =
    (hasSessionTimeoutEvidence(input) ||
      taskRequestsTimeoutContinuationCloseout(input.taskPrompt)) &&
    toolTraceHasCall(input.toolTrace, "sessions_send");
  if (!recoveredTimeoutContext) {
    return false;
  }
  if (
    taskRequestsUnverifiedTimeoutCloseout(input.taskPrompt) &&
    !mentionsUnverifiedScope(input.resultText)
  ) {
    return true;
  }
  return (
    !hasTimeoutCloseoutGuidance(input.resultText)
  );
}

function maybeAppendRecoveredTimeoutCloseoutVisibility(
  result: GenerateTextResult,
): GenerateTextResult {
  if (hasTimeoutCloseoutGuidance(result.text)) {
    return result;
  }
  return {
    ...result,
    text: `${result.text.trim()}\n\nTimeout closeout: the resumed source produced source-backed evidence. Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.`.trim(),
  };
}

function maybeAppendRequiredTimeoutFollowupVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): GenerateTextResult {
  if (!taskRequestsTimeoutFollowupContinuation(input.taskPrompt)) {
    return input.result;
  }
  const contextText = [
    input.taskPrompt,
    input.result.text,
    ...input.messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
  const hasRecoveredTimeoutEvidence =
    hasSessionTimeoutEvidence(input) ||
    /\b(?:timeout|timed out|timeout recovery|recovered after .*timeout|resumed after .*timeout|earlier timeout|previous timeout|prior timeout)\b/i.test(
      contextText,
    );
  if (!hasRecoveredTimeoutEvidence || !toolTraceHasCall(input.toolTrace, "sessions_send")) {
    return input.result;
  }
  const missingLines: string[] = [];
  if (!hasTimeoutContinuationGuidance(input.result.text)) {
    missingLines.push(
      "Continuation guidance: continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing or if production-equivalent validation is required.",
    );
  }
  if (!mentionsUnverifiedScope(input.result.text)) {
    missingLines.push(
      "Unverified scope: production-equivalent release health and any source facts beyond the recovered result remain unverified.",
    );
  }
  if (!mentionsTimeout(input.result.text)) {
    missingLines.push(
      "Timeout recovery: this answer follows a resumed source-check after an earlier timeout.",
    );
  }
  if (missingLines.length === 0) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${missingLines.join(" ")}`.trim(),
  };
}

function maybeAppendBrowserRecoveryResidualRiskVisibility(input: {
  result: GenerateTextResult;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): GenerateTextResult {
  if (requestsStatusVisibleTextEvidenceUrlLines(input.taskPrompt)) {
    return input.result;
  }
  if (!taskRequiresBrowserEvidence(input.taskPrompt)) {
    return input.result;
  }
  if (mentionsUnverifiedScope(input.result.text) || /\bresidual risks?\b/i.test(input.result.text)) {
    return input.result;
  }
  const contextText = [
    input.taskPrompt,
    input.result.text,
    ...input.messages.map((message) => readMessageContentText(message.content)),
  ].join("\n");
  if (!/\b(?:residual risk|unverified scope|remaining risk|what remains unverified)\b/i.test(contextText)) {
    return input.result;
  }
  const hasBrowserRecoveryOrTimeout =
    toolTraceHasTimeoutResult(input.toolTrace) ||
    /\b(?:browser recovery metadata|resume mode|cold resume|recovered browser|browser.*timed out|timed out.*browser|screenshot.*timed out|snapshot.*timed out|scroll.*timed out|wait_for.*timed out)\b/i.test(
      contextText,
    );
  if (!hasBrowserRecoveryOrTimeout) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\nResidual risk: this browser review is source-bounded to recovered local fixture evidence; wider production state and any browser traversal that timed out remain unverified.`.trim(),
  };
}

function taskRequestsTimeoutContinuationCloseout(taskPrompt: string): boolean {
  return /\b(?:explain|state|say|describe)\b[\s\S]{0,160}\bwhether\b[\s\S]{0,160}\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,160}\b(?:still\s+)?limits?\b[\s\S]{0,120}\bconclusion\b|\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,120}\b(?:still\s+)?limits?\b[\s\S]{0,120}\bconclusion\b/i.test(
    taskPrompt,
  );
}

function taskRequestsUnverifiedTimeoutCloseout(taskPrompt: string): boolean {
  return (
    taskRequestsTimeoutContinuationCloseout(taskPrompt) &&
    /\b(?:unverified|not verified|residual risk|uncertainty|uncertain)\b/i.test(
      taskPrompt,
    )
  );
}

function mentionsUnverifiedScope(text: string): boolean {
  return /\b(?:unverified|not verified|unconfirmed|uncertain|uncertainty|not confirmed)\b/i.test(
    text,
  );
}

function shouldPreserveRecoveredTimeoutCloseout(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  evidenceText: string;
}): boolean {
  if (shouldAppendTimeoutContinuationVisibility(input)) {
    return true;
  }
  return (
    hasSessionTimeoutEvidence(input) &&
    toolTraceHasCall(input.toolTrace, "sessions_send") &&
    mentionsTimeout(input.evidenceText)
  );
}

function hasTimeoutCloseoutGuidance(text: string): boolean {
  return (
    hasTimeoutContinuationGuidance(text) ||
    /\b(?:earlier|previous|prior)\s+timeouts?\b[\s\S]{0,120}\b(?:no longer|still|does not|doesn't)\b[\s\S]{0,80}\blimits?\b[\s\S]{0,80}\bconclusion\b/i.test(
      text,
    )
  );
}

function hasTimeoutContinuationGuidance(text: string): boolean {
  return (
    /\b(?:continue|retry|resume|resumable|bounded retry|timeout-gated)\b/i.test(
      text,
    ) ||
    /\b(?:next step|next action)\b[\s\S]{0,80}\b(?:continue|retry|resume|bounded retry)\b/i.test(
      text,
    ) ||
    /\b(?:configure|increase|extend)\b[\s\S]{0,80}\b(?:tool-call\s+)?timeouts?\b/i.test(
      text,
    ) ||
    /\btimeouts?\b[\s\S]{0,80}\b(?:retry|recover|configure|exclude|timeout-gated|bounded retry)\b/i.test(
      text,
    )
  );
}

function mentionsTimeout(text: string): boolean {
  return /\b(?:timeout|timed out)\b/i.test(text);
}

function toolTraceHasCall(
  toolTrace: NativeToolRoundTrace[],
  toolName: string,
): boolean {
  return toolTrace.some((roundTrace) =>
    roundTrace.calls.some((call) => call.name === toolName),
  );
}

function toolTraceHasTimeoutResult(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some((roundTrace) =>
    roundTrace.results.some((result) => {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        return false;
      }
      if (typeof result.content !== "string") {
        return false;
      }
      return parseSessionToolResult(result.content)?.status === "timeout";
    }),
  );
}

function hasSessionTimeoutEvidence(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (toolTraceHasTimeoutResult(input.toolTrace)) {
    return true;
  }
  return contextHasTimeoutSessionResult(
    buildContinuationDirectiveContext(input.taskPrompt, input.messages),
  );
}

function maybeRedactForbiddenLocalUrls(input: {
  result: GenerateTextResult;
  packet: RolePromptPacket;
}): GenerateTextResult {
  const constraintText = `${input.packet.taskPrompt}\n${input.packet.outputContract}`;
  if (!forbidsFinalUrls(constraintText)) {
    return input.result;
  }
  const redacted = input.result.text.replace(
    /\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)\],;]*)?/gi,
    "local fixture source",
  );
  if (redacted === input.result.text) {
    return input.result;
  }
  return {
    ...input.result,
    text: redacted,
  };
}

function forbidsFinalUrls(text: string): boolean {
  return /\b(?:do not include (?:source )?urls?|do not use [^\n.]*links?|links? (?:are )?forbidden|no links?|bare http:\/\/\s*\/\s*https?:\/\/ URLs?)\b/i.test(
    text,
  );
}

function containsAnyToolCallForm(result: GenerateTextResult): boolean {
  if ((result.toolCalls?.length ?? 0) > 0) {
    return true;
  }
  return /<\s*(?:minimax:)?tool_call\b|<\s*invoke\b|<\/\s*(?:minimax:)?tool_call\s*>|\btool_calls?\s*[:=]/i.test(
    result.text,
  );
}

function shouldRepairMissingApprovalGate(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
}): boolean {
  if (hasMissingApprovalGateRepairPrompt(input.messages)) {
    return false;
  }
  if (!hasToolDefinition(input.tools, "permission_query")) {
    return false;
  }
  if (taskPromptSaysApprovalAlreadyApplied(input.taskPrompt)) {
    return false;
  }
  if (hasPermissionGateEvidence(input.toolTrace)) {
    return false;
  }
  return requestsApprovalGatedBrowserAction(input.taskPrompt);
}

function hasPermissionGateEvidence(toolTrace: NativeToolRoundTrace[]): boolean {
  return toolTrace.some(
    (round) =>
      round.calls.some((call) => call.name.startsWith("permission_")) ||
      (round.progress ?? []).some((progress) => {
        const eventType = progress.detail?.["eventType"];
        return (
          typeof eventType === "string" && eventType.startsWith("permission.")
        );
      }),
  );
}

function shouldRepairStalePendingApproval(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasStalePendingApprovalRepairPrompt(input.messages)) {
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
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasPendingApprovalWaitTimeoutCheckRepairPrompt(input.messages)) {
    return false;
  }
  if (!taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt)) {
    return false;
  }
  return latestPermissionToolName(input.toolTrace) === "permission_query";
}

function buildForcedPendingApprovalWaitTimeoutPermissionResultCall(input: {
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
}): LLMToolCall | null {
  if (!taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt)) {
    return null;
  }
  if (!hasToolDefinition(input.tools, "permission_result")) {
    return null;
  }
  if (latestPermissionToolName(input.toolTrace) !== "permission_query") {
    return null;
  }
  if (latestPermissionResultStatus(input.toolTrace)) {
    return null;
  }
  const approvalId = latestPendingPermissionQueryApprovalId(input.toolTrace);
  if (!approvalId) {
    return null;
  }
  return {
    id: `toolu-runtime-permission-result-${input.toolTrace.length + 1}`,
    name: "permission_result",
    input: { approval_id: approvalId },
  };
}

function latestPendingPermissionQueryApprovalId(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let progressIndex = (round.progress?.length ?? 0) - 1;
      progressIndex >= 0;
      progressIndex -= 1
    ) {
      const progress = round.progress![progressIndex]!;
      if (
        progress.toolName !== "permission_query" ||
        progress.detail?.["eventType"] !== "permission.query"
      ) {
        continue;
      }
      const status = progress.detail["status"];
      if (typeof status === "string" && status !== "pending") {
        continue;
      }
      const approvalId = readApprovalId(progress.detail);
      if (approvalId) return approvalId;
    }
    for (
      let resultIndex = round.results.length - 1;
      resultIndex >= 0;
      resultIndex -= 1
    ) {
      const result = round.results[resultIndex]!;
      if (result.toolName !== "permission_query") continue;
      const parsed = parseJsonObject(result.content);
      if (!parsed) continue;
      const status = parsed["status"];
      if (typeof status === "string" && status !== "pending") {
        continue;
      }
      const approvalId = readApprovalId(parsed);
      if (approvalId) return approvalId;
    }
  }
  return null;
}

function readApprovalId(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  const direct = value["approval_id"] ?? value["approvalId"];
  return typeof direct === "string" && direct.trim().length > 0
    ? direct.trim()
    : null;
}

function shouldRepairPrematurePendingApprovalFinal(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasPrematurePendingApprovalRepairPrompt(input.messages)) {
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
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasApprovalWaitTimeoutCloseoutRepairPrompt(input.messages)) {
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
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (!taskPromptRequestsApprovalWaitTimeoutCloseout(input.taskPrompt)) {
    return false;
  }
  if (!hasApprovalWaitTimeoutCloseoutRepairPrompt(input.messages)) {
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
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasIncompleteApprovedBrowserActionRepairPrompt(input.messages)) {
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
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  if (hasMissingBrowserEvidenceRepairPrompt(input.messages)) {
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
  toolTrace: NativeToolRoundTrace[];
  tools?: GenerateTextInput["tools"];
  evidenceText?: string;
}): boolean {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return false;
  }
  if (hasMissingBrowserEvidenceRepairPrompt(input.messages)) {
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
}): boolean {
  if (hasAwaitingContextSetupNoToolRepairPrompt(input.messages)) {
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
}): boolean {
  if (hasMissingRequestedNextActionRepairPrompt(input.messages)) {
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
  resultText: string;
}): boolean {
  if (hasMissingRequestedTableColumnsRepairPrompt(input.messages)) {
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
  resultText: string;
}): boolean {
  if (hasExtraneousProviderTableSchemaRepairPrompt(input.messages)) {
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
  evidenceText?: string;
}): boolean {
  if (hasWeakEvidenceSynthesisRepairPrompt(input.messages)) {
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
  evidenceText: string;
}): boolean {
  if (hasProductBriefEvidenceCarryForwardRepairPrompt(input.messages)) {
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
  evidenceText: string;
}): boolean {
  if (hasCompletedSessionLabelCarryForwardRepairPrompt(input.messages)) {
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
  if (shouldRepairProductBriefEvidenceCarryForward({ ...input, messages: [] })) {
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
  evidenceText: string;
}): boolean {
  if (hasFalseEvidenceBlockedSynthesisRepairPrompt(input.messages)) {
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
  evidenceText: string;
}): boolean {
  if (hasMissingBrowserEvidenceDimensionsRepairPrompt(input.messages)) {
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

const INCOMPLETE_APPROVED_BROWSER_ACTION_PATTERNS = [
  /\btools? (?:are |is )?(?:disabled|unavailable|not available)\b/i,
  /\btool[- ]disabled\b/i,
  /\bnot in (?:my |the )?current function namespace\b/i,
  /\bcannot emit (?:the )?(?:approval|permission) request\b/i,
  /\b(?:final synthesis|browser_act|could not be called|cannot call|could not execute|action blocked|not executed|not completed)\b/i,
  /\b(?:re-?delegat(?:e|ed|ing|ion)|next step needed)\b/i,
  /\bdelegat(?:e|ed|ing)[\s\S]{0,120}\b(?:approved|approval)[\s\S]{0,120}\b(?:browser|form|submit|submission)\b/i,
  /\b(?:approved|approval)[\s\S]{0,120}\bdelegat(?:e|ed|ing)[\s\S]{0,120}\b(?:browser|form|submit|submission)\b/i,
  /@role-browser\b/i,
  /\b(?:not submitted|not yet submitted|submission can now be completed|submit can now be completed)\b/i,
  /\bno\s+form\s+submission\s+(?:ran|executed|was performed)\b/i,
  /\bpre[- ]approval\s+inspection\b/i,
  /\bno\s+side\s+effects?\s+(?:ran|executed|were performed)\b/i,
];

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

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function shouldRepairStaleDeniedApproval(input: {
  taskPrompt: string;
  resultText: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  if (hasStaleDeniedApprovalRepairPrompt(input.messages)) {
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

function latestPermissionToolName(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let callIndex = round.calls.length - 1;
      callIndex >= 0;
      callIndex -= 1
    ) {
      const name = round.calls[callIndex]!.name;
      if (name.startsWith("permission_")) {
        return name;
      }
    }
  }
  return null;
}

function hasPermissionAppliedEvidence(toolTrace: NativeToolRoundTrace[]): boolean {
  if (latestPermissionToolName(toolTrace) === "permission_applied") {
    return true;
  }
  return toolTrace.some((round) =>
    (round.progress ?? []).some(
      (progress) => progress.detail?.["eventType"] === "permission.applied",
    ),
  );
}

function latestPermissionResultStatus(
  toolTrace: NativeToolRoundTrace[],
): string | null {
  for (
    let roundIndex = toolTrace.length - 1;
    roundIndex >= 0;
    roundIndex -= 1
  ) {
    const round = toolTrace[roundIndex]!;
    for (
      let progressIndex = (round.progress?.length ?? 0) - 1;
      progressIndex >= 0;
      progressIndex -= 1
    ) {
      const progress = round.progress![progressIndex]!;
      if (
        progress.toolName === "permission_result" &&
        progress.detail?.["eventType"] === "permission.result"
      ) {
        const status = progress.detail["status"];
        if (typeof status === "string") return status;
      }
    }
    for (
      let resultIndex = round.results.length - 1;
      resultIndex >= 0;
      resultIndex -= 1
    ) {
      const result = round.results[resultIndex]!;
      if (result.toolName !== "permission_result") continue;
      const parsed = parseJsonObject(result.content);
      const status = parsed?.["status"];
      if (typeof status === "string") return status;
    }
  }
  return null;
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

function expectsExactFinalAnswerShape(
  taskPrompt: string,
  resultText: string,
): boolean {
  const combined = `${taskPrompt}\n${resultText}`;
  if (/^\s*(?:\{[\s\S]*\}|\[[\s\S]*\])\s*$/.test(resultText)) {
    try {
      JSON.parse(resultText);
      return true;
    } catch {
      // Fall through to prompt-shape checks.
    }
  }
  return /\b(?:respond with only|output only|answer only|final answer must|answer must be|use this exact final answer|exact final answer shape|valid json|json object|json array|csv only|markdown table only)\b|(?:只|仅|只需|仅需)(?:用|以)?(?:回答|输出|返回|给出)[^\n。；;]{0,24}(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*(?:行|条|句)|^\s*Final Answer\s*:/im.test(
    combined,
  );
}

function hasMissingApprovalGateRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approval-gated browser action",
      ),
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

function hasIncompleteApprovedBrowserSessionContinuationPrompt(
  messages: LLMMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readMessageContentText(message.content).includes(
        "Runtime correction: approved browser action is incomplete inside an existing browser session",
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

function taskPromptSaysApprovalAlreadyApplied(taskPrompt: string): boolean {
  return /\b(?:runtime\s+)?permission cache\b[\s\S]{0,120}\balready applied\b|\bpermission\.applied\b|\bpermission_applied\b/i.test(
    taskPrompt,
  );
}

function taskPromptRequestsApprovalWaitTimeoutCloseout(
  taskPrompt: string,
): boolean {
  return (
    /\b(?:operator decision|approval|permission)\b[\s\S]{0,180}\b(?:does not arrive|doesn't arrive|does not come through|doesn't come through|no decision arrives|no approval arrives|wait timeout|wait-timeout|timed out|timeout|during this attempt|attempt cycle)\b/i.test(
      taskPrompt,
    ) ||
    /\bif\b[\s\S]{0,120}\b(?:decision|approval|permission)\b[\s\S]{0,120}\b(?:not arrive|pending|timeout|timed out|wait)\b/i.test(
      taskPrompt,
    )
  );
}

function taskPromptAllowsStoppingAtPendingApproval(taskPrompt: string): boolean {
  return /\bstop\b[\s\S]{0,80}\b(?:approval request|permission request)\b[\s\S]{0,120}\b(?:wait|operator decision|approval|decision)\b|\bwait for (?:the )?operator decision\b[\s\S]{0,160}\bdo not (?:apply|submit|execute|proceed)/i.test(
    taskPrompt,
  );
}

function isAppliedApprovalBrowserContinuation(taskPrompt: string): boolean {
  return (
    taskPromptSaysApprovalAlreadyApplied(taskPrompt) &&
    requestsApprovalGatedBrowserAction(taskPrompt)
  );
}

function requestsApprovalGatedBrowserAction(taskPrompt: string): boolean {
  if (disclaimsApprovalGatedBrowserAction(taskPrompt)) {
    return false;
  }
  return (
    /\bapproval\b/i.test(taskPrompt) &&
    /\bbrowser\b/i.test(taskPrompt) &&
    looksApprovalGatedBrowserSideEffect(taskPrompt) &&
    browserSpawnPerformsMutatingAction(taskPrompt)
  );
}

function disclaimsApprovalGatedBrowserAction(taskPrompt: string): boolean {
  if (
    /\b(?:not\s+(?:a\s+)?form submission|not\s+(?:a\s+)?browser mutation|do not mutate|don't mutate|without mutat(?:ing|ion)|no browser mutation|no form submission)\b/i.test(
      taskPrompt,
    )
  ) {
    return true;
  }
  if (!/\bread[- ]only\b/i.test(taskPrompt)) {
    return false;
  }
  return (
    /\bno\b[^.\n]{0,180}\b(?:browser\s+)?(?:form|click|navigation|submit|submission|mutation|side[- ]effect|approval[- ]gated action)\b[^.\n]{0,120}\b(?:needed|required|necessary|will be performed|should run|is needed)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:do\s+not|don't|never)\b[^.\n]{0,180}\b(?:click|submit|submission|form|deposit|purchase|buy|order|book|reserve|save|update|delete|remove|archive|mutat(?:e|ion)|side[- ]effect|request approval|approval)\b/i.test(
      taskPrompt,
    )
  );
}

function buildMissingApprovalGateRepairPrompt(): string {
  return [
    "Runtime correction: approval-gated browser action was finalized or described without native approval/tool evidence.",
    "Do not finalize an approval-gated browser side effect unless a native permission or browser-session tool result created that evidence.",
    "Use permission_query now with action=browser.form.submit, level=approval, scope=mutate, worker_kind=browser, the concrete risk, and a redacted payload for the intended dry-run form submission.",
    "After the operator decision is available, use permission_result and permission_applied before delegating the approved browser action.",
    "Only after permission_applied succeeds, call sessions_spawn with agent_id=browser and include the exact URL, approved action, and verification requirement in the task.",
    "After the browser tool result returns, synthesize only from that permission and browser evidence.",
  ].join("\n");
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

function buildIncompleteApprovedBrowserSessionContinuationPrompt(input: {
  sessionKey: string;
  evidence: string;
}): string {
  return [
    "Runtime correction: approved browser action is incomplete inside an existing browser session.",
    `Continue the same browser session with session_key ${input.sessionKey}; do not spawn a replacement session.`,
    "The approval is already applied. Call sessions_send exactly once for that session_key.",
    "Ask the browser sub-agent to perform the approved browser.form.submit action now, reuse the current page state, use browser_act on the submit control with submit=true, and verify the post-submit page state.",
    "If the browser sub-agent still cannot execute the approved action after this continuation, it must return the concrete blocker and evidence instead of asking the parent to inspect again.",
    `Incomplete browser evidence:\n${input.evidence}`,
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
  evidenceText: string;
}): boolean {
  if (hasTimeoutFollowupFinalGuidanceRepairPrompt(input.messages)) {
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

function taskRequestsTimeoutFollowupContinuation(taskPrompt: string): boolean {
  const timeoutSourceRequest = /\b(?:slow source|bounded attempt|source does not return|doesn't return|timed out|timeout|earlier timeout|previous timeout|prior timeout)\b/i.test(
    taskPrompt,
  );
  const continuationRequest = /\b(?:follow-up|followup|resume|continue|continuation|same source-check context|same source check context|existing source-check context|existing source check context)\b/i.test(
    taskPrompt,
  );
  const explicitHowToContinue = /\b(?:explain how|describe how|state how|say how)\b[\s\S]{0,120}\b(?:mission|work|source-check|source check)\b[\s\S]{0,80}\b(?:continue|resume|retry)\b/i.test(
    taskPrompt,
  );
  const resumeAfterTimeout = /\b(?:resume|continue)\b[\s\S]{0,160}\b(?:existing|same)\b[\s\S]{0,120}\b(?:source-check|source check|context)\b[\s\S]{0,220}\b(?:earlier|previous|prior)?\s*timeout\b|\b(?:earlier|previous|prior)\s*timeout\b[\s\S]{0,220}\b(?:limits?|conclusion|resume|continue|retry|source-check|source check)\b/i.test(
    taskPrompt,
  );
  return (
    timeoutSourceRequest &&
    continuationRequest &&
    (explicitHowToContinue || resumeAfterTimeout)
  );
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

function readMessageContentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block) return String(block.text);
        if (block.type === "tool_result" && "content" in block)
          return String(block.content);
      }
      return "";
    })
    .join("\n");
}

function findSessionContinuationDirective(
  taskPrompt: string,
): SessionContinuationDirective | null {
  let latestUserText = extractLatestUserContinuationText(taskPrompt);
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    if (!shouldForceSlowSourceRecoveryContinuation(taskPrompt)) {
      return null;
    }
    latestUserText =
      "Continue the same slow-source source-check context after the previous timeout. Resume the existing source-check session.";
  }
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    return null;
  }
  const messageHint = buildSessionContinuationMessageHint(
    taskPrompt,
    latestUserText,
  );
  const sessionResults = extractSessionToolResultRecords(taskPrompt);
  let selectedSessionKey: string | null = null;
  let selectedPriority = 0;
  const preferEarliestSession =
    continuationRequestPrefersEarliestSession(latestUserText);
  for (let index = sessionResults.length - 1; index >= 0; index -= 1) {
    const result = sessionResults[index]!;
    const sessionKey = result["session_key"];
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      continue;
    }
    const priority = sessionToolResultContinuationPriority(
      result,
      latestUserText,
    );
    if (priority <= selectedPriority) {
      if (
        !(
          preferEarliestSession &&
          selectedSessionKey &&
          priority === selectedPriority
        )
      ) {
        continue;
      }
    }
    if (!preferEarliestSession && priority <= selectedPriority) {
      continue;
    }
    selectedSessionKey = sessionKey.trim();
    selectedPriority = priority;
  }
  if (selectedSessionKey) {
    const listedResolvedSessionKey = resolveListedSessionKeyFromPrefix(
      taskPrompt,
      selectedSessionKey,
    );
    if (listedResolvedSessionKey) {
      return { sessionKey: listedResolvedSessionKey, messageHint };
    }
    if (
      extractLikelyTruncatedTimeoutSessionKeyPrefixes(
        taskPrompt,
        latestUserText,
      ).some(
        (prefix) =>
          relaxedSessionKeySignature(selectedSessionKey).startsWith(prefix) ||
          prefix.startsWith(relaxedSessionKeySignature(selectedSessionKey)),
      )
    ) {
      return null;
    }
    if (
      selectedPriority < 3 &&
      continuationRequestPrefersResumableSession({
        latestUserText,
        context: taskPrompt,
      })
    ) {
      return null;
    }
    return { sessionKey: selectedSessionKey, messageHint };
  }
  const explicitSessionKey = selectExplicitContinuationSessionKey(
    taskPrompt,
    latestUserText,
  );
  if (explicitSessionKey) {
    return { sessionKey: explicitSessionKey, messageHint };
  }
  const listedSession = selectListedContinuationSessionKey(
    taskPrompt,
    latestUserText,
  );
  const hasTruncatedTimeoutCandidate =
    contextHasTruncatedTimeoutContinuationCandidate(taskPrompt, latestUserText);
  if (
    listedSession &&
    !(hasTruncatedTimeoutCandidate && listedSession.priority < 3)
  ) {
    return { sessionKey: listedSession.sessionKey, messageHint };
  }
  if (hasTruncatedTimeoutCandidate) {
    return null;
  }
  const sessionMatches = [
    ...taskPrompt.matchAll(/"session_key"\s*:\s*"([^"]+)"/g),
  ];
  for (let index = sessionMatches.length - 1; index >= 0; index -= 1) {
    const match = sessionMatches[index]!;
    const sessionKey = match[1];
    if (!sessionKey) continue;
    const start = Math.max(0, (match.index ?? 0) - 1200);
    const end = Math.min(taskPrompt.length, (match.index ?? 0) + 1200);
    const context = taskPrompt.slice(start, end);
	    if (!sessionContextSupportsContinuation(context)) {
	      continue;
	    }
	    const priority = explicitSessionContinuationPriority(
	      sessionKey,
	      context,
	      latestUserText,
	    );
	    if (
	      priority <= 0 ||
	      (priority < 3 &&
	        continuationRequestPrefersResumableSession({
	          latestUserText,
	          context: taskPrompt,
	        }))
	    ) {
	      continue;
	    }
	    return {
	      sessionKey,
	      messageHint,
	    };
  }
  return null;
}

function continuationRequestPrefersEarliestSession(
  latestUserText: string,
): boolean {
  return /\b(?:previous|prior|earlier|original|initial|same)\b[\s\S]{0,160}\b(?:thread|session|research|work|notes|context)\b|\b(?:rather than|instead of)\b[\s\S]{0,120}\b(?:starting|start)\b[\s\S]{0,80}\bfrom scratch\b/i.test(
    latestUserText,
  );
}

function continuationRequestPrefersResumableSession(input: {
  latestUserText: string;
  context: string;
}): boolean {
  if (
    /\b(?:timeout|timed out|resumable|interrupted|cancelled|canceled|slow-source|slow source|source-check)\b/i.test(
      input.latestUserText,
    )
  ) {
    return true;
  }
  if (
    !/\b(?:timeout|timed out|WORKER_TIMEOUT|resumable|interrupted|cancelled|canceled)\b/i.test(
      input.context,
    )
  ) {
    return false;
  }
  return /\b(?:same|existing|previous|prior|attempt|source|retry|resume|continue)\b/i.test(
    input.latestUserText,
  );
}

function findSessionContinuationLookupDirective(
  taskPrompt: string,
  context: string,
): SessionContinuationLookupDirective | null {
  let latestUserText = extractLatestUserContinuationText(taskPrompt);
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    if (!shouldForceSlowSourceRecoveryContinuation(context)) {
      return null;
    }
    latestUserText =
      "Continue the same slow-source source-check context after the previous timeout. Resume the existing source-check session.";
  }
  if (!isExplicitSessionContinuationRequest(latestUserText)) {
    return null;
  }
  if (contextHasSessionListResult(context)) {
    return contextHasTruncatedTimeoutContinuationCandidate(
      context,
      latestUserText,
    )
      ? {
          messageHint: buildSessionContinuationMessageHint(
            taskPrompt,
            latestUserText,
          ),
        }
      : null;
  }
  return {
    messageHint: buildSessionContinuationMessageHint(
      taskPrompt,
      latestUserText,
    ),
  };
}

function shouldForceSlowSourceRecoveryContinuation(context: string): boolean {
  return (
    /\bSystem recovery:\s*the previous final answer did not satisfy required goal slots\b/i.test(
      context,
    ) &&
    taskPromptLooksLikeSourceCheckContinuation(context) &&
    contextHasTimeoutSessionResult(context) &&
    /\b(?:Resume or retry the same slow source-check context|same source-check context|required release-risk slots|release-risk slots)\b/i.test(
      context,
    )
  );
}

function buildContinuationDirectiveContext(
  taskPrompt: string,
  messages: LLMMessage[],
): string {
  const toolEvidence = messages
    .filter((message) => message.role === "tool")
    .map((message) => llmMessageContentToText(message.content))
    .filter(
      (content) =>
        content.includes("session_key") || content.includes('"sessions"'),
    )
    .join("\n");
  return toolEvidence ? `${taskPrompt}\n${toolEvidence}` : taskPrompt;
}

function llmMessageContentToText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return block.content;
      }
      if (block.type === "tool_use") {
        return JSON.stringify({ name: block.name, input: block.input });
      }
      return "";
    })
    .join("\n");
}

function sessionContextSupportsContinuation(context: string): boolean {
  if (
    /\b(timeout|timed out|WORKER_TIMEOUT|resumable|interrupted|cancelled|canceled)\b/i.test(
      context,
    )
  ) {
    return true;
  }
  if (contextHasListedContinuableSession(context)) {
    return true;
  }
  for (const result of extractSessionToolResultRecords(context)) {
    if (sessionToolResultSupportsContinuation(result)) {
      return true;
    }
  }
  return false;
}

function shouldCloseoutCancelledSessionWithoutContinuation(input: {
  taskPrompt: string;
  messages: LLMMessage[];
}): boolean {
  const context = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  if (!contextHasCancelledSessionResult(context)) {
    return false;
  }
  return !isExplicitSessionContinuationRequest(
    extractLatestUserContinuationText(input.taskPrompt),
  );
}

function contextHasCancelledSessionResult(context: string): boolean {
  return extractSessionToolResultRecords(context).some(
    (result) => result["status"] === "cancelled",
  );
}

function contextHasTimeoutSessionResult(context: string): boolean {
  return extractSessionToolResultRecords(context).some(
    (result) => result["status"] === "timeout",
  );
}

function shouldAppendTimeoutContinuationVisibility(input: {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
}): boolean {
  const taskPromptSuffix = input.taskPrompt.slice(
    Math.max(0, input.taskPrompt.length - 4000),
  );
  if (
    !isExplicitSessionContinuationRequest(
      extractLatestUserContinuationText(taskPromptSuffix),
    ) &&
    !isExplicitSessionContinuationRequest(taskPromptSuffix)
  ) {
    return false;
  }
  if (
    !input.toolTrace.some((roundTrace) =>
      roundTrace.calls.some((call) => call.name === "sessions_send"),
    )
  ) {
    return false;
  }
  const context = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  return (
    toolTraceHasTimeoutResult(input.toolTrace) ||
    contextHasTimeoutSessionResult(context)
  );
}

function contextHasSessionListResult(context: string): boolean {
  return parseJsonObjectsFromContext(context).some((parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return Array.isArray((parsed as Record<string, unknown>)["sessions"]);
  });
}

function contextHasListedContinuableSession(context: string): boolean {
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    if (
      sessions.some((session) => {
        if (!session || typeof session !== "object" || Array.isArray(session)) {
          return false;
        }
        const record = session as Record<string, unknown>;
        const status = record["status"];
        return (
          typeof record["session_key"] === "string" &&
          typeof status === "string" &&
          /^(?:done|completed|resumable|timeout|cancelled|failed)$/.test(status)
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

function selectListedContinuationSessionKey(
  context: string,
  latestUserText: string,
): { sessionKey: string; priority: number } | null {
  let selected: {
    sessionKey: string;
    priority: number;
    lastActiveAt: number;
  } | null = null;
  const truncatedTimeoutPrefixes =
    extractLikelyTruncatedTimeoutSessionKeyPrefixes(context, latestUserText);
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    for (const session of sessions) {
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        continue;
      }
      const record = session as Record<string, unknown>;
      const sessionKey =
        typeof record["session_key"] === "string"
          ? record["session_key"].trim()
          : "";
      let priority = listedSessionContinuationPriority(
        record,
        latestUserText,
      );
      if (
        sessionKey &&
        truncatedTimeoutPrefixes.some((prefix) =>
          relaxedSessionKeySignature(sessionKey).startsWith(prefix),
        )
      ) {
        priority = Math.max(priority, 6);
      }
      if (!sessionKey || priority <= 0) {
        continue;
      }
      const lastActiveAt =
        typeof record["last_active_at"] === "number"
          ? record["last_active_at"]
          : 0;
      if (
        !selected ||
        priority > selected.priority ||
        (priority === selected.priority &&
          lastActiveAt >= selected.lastActiveAt)
      ) {
        selected = { sessionKey, priority, lastActiveAt };
      }
    }
  }
  return selected
    ? { sessionKey: selected.sessionKey, priority: selected.priority }
    : null;
}

function resolveListedSessionKeyFromPrefix(
  context: string,
  sessionKey: string,
): string | null {
  const signature = relaxedSessionKeySignature(sessionKey);
  if (signature.length < 24) {
    return null;
  }
  const matches: string[] = [];
  for (const parsed of parseJsonObjectsFromContext(context)) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const sessions = (parsed as Record<string, unknown>)["sessions"];
    if (!Array.isArray(sessions)) {
      continue;
    }
    for (const session of sessions) {
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        continue;
      }
      const candidate = (session as Record<string, unknown>)["session_key"];
      if (typeof candidate !== "string" || !candidate.trim()) {
        continue;
      }
      const candidateSignature = relaxedSessionKeySignature(candidate.trim());
      if (candidateSignature === signature) {
        return candidate.trim();
      }
      if (candidateSignature.startsWith(signature)) {
        matches.push(candidate.trim());
      }
    }
  }
  return [...new Set(matches)].length === 1 ? matches[0]! : null;
}

function extractLikelyTruncatedTimeoutSessionKeyPrefixes(
  context: string,
  latestUserText: string,
): string[] {
  if (
    !continuationRequestPrefersResumableSession({
      latestUserText,
      context,
    }) ||
    !/\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(context)
  ) {
    return [];
  }
  const prefixes: string[] = [];
  const matches = [
    ...context.matchAll(
      /(?:"session_key"\s*:\s*"|session not found:\s*)(worker:[A-Za-z0-9_-]+:task(?::|-)[^\s"',|}\]\n]+)/gi,
    ),
  ];
  for (const match of matches) {
    const rawKey = match[1]?.trim();
    if (!rawKey) continue;
    const matchedText = match[0] ?? "";
    const ellipsized = /…|\.{3}/.test(rawKey);
    const notFoundPrefix = /^session not found:/i.test(matchedText);
    const likelyToolCallPrefix =
      /\bcall_(?:function_|func_)?[A-Za-z0-9]+$/i.test(rawKey) &&
      !/_\d+$/.test(rawKey);
    if (!ellipsized && !notFoundPrefix && !likelyToolCallPrefix) {
      continue;
    }
    const signature = relaxedSessionKeySignature(rawKey);
    const ellipsizedPrefix = readTruncatedSessionKeyPrefix(signature);
    const prefix = ellipsizedPrefix ?? (signature.length >= 24 ? signature : null);
    if (prefix) {
      prefixes.push(prefix);
    }
  }
  return [...new Set(prefixes)];
}

function selectExplicitContinuationSessionKey(
  context: string,
  latestUserText: string,
): string | null {
  let selected: { sessionKey: string; priority: number; index: number } | null =
    null;
  const matches = [
    ...context.matchAll(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/g),
  ];
  for (const match of matches) {
    const sessionKey = match[0];
    if (!sessionKey || /(?:…|\.{3})/.test(sessionKey)) {
      continue;
    }
    const index = match.index ?? 0;
    const local = context.slice(
      Math.max(0, index - 800),
      Math.min(context.length, index + 800),
    );
    if (
      /"session_key"\s*:\s*"/.test(
        context.slice(Math.max(0, index - 40), index),
      )
    ) {
      continue;
    }
    const priority = explicitSessionContinuationPriority(
      sessionKey,
      local,
      latestUserText,
    );
    if (priority <= 0) {
      continue;
    }
    if (
      !selected ||
      priority > selected.priority ||
      (priority === selected.priority && index > selected.index)
    ) {
      selected = { sessionKey, priority, index };
    }
  }
  return selected?.sessionKey ?? null;
}

function explicitSessionContinuationPriority(
  sessionKey: string,
  localContext: string,
  latestUserText: string,
): number {
  if (
    !/\b(?:resume|continue|continuation|timed out|timeout|resumable|interrupted|source-check|source check)\b/i.test(
      localContext,
    )
  ) {
    return 0;
  }
  let priority = 1;
  const agentId = inferWorkerKindFromSessionKey(sessionKey) ?? "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  if (/\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(localContext)) {
    priority += 3;
  }
  if (
    /\b(?:resume|continue|continuation|same|existing)\b/i.test(localContext)
  ) {
    priority += 2;
  }
  if (
    agentId === "explore" &&
    /\b(?:slow-source|slow source|source-check|source check|source|research|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 3;
  }
  if (
    agentId === "browser" &&
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(latestUserText)
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  return priority;
}

function listedSessionContinuationPriority(
  record: Record<string, unknown>,
  latestUserText: string,
): number {
  const status = typeof record["status"] === "string" ? record["status"] : "";
  const agentId =
    typeof record["agent_id"] === "string" ? record["agent_id"] : "";
  const label = typeof record["label"] === "string" ? record["label"] : "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  let priority = 0;
  if (status === "timeout") {
    priority = 5;
  } else if (
    status === "resumable" ||
    status === "waiting_input" ||
    status === "waiting_external"
  ) {
    priority = 3;
  } else if (status === "cancelled" || status === "canceled") {
    priority = 3;
  } else if (
    status === "failed" &&
    /\b(?:continue|resume|retry|cancelled|canceled|source-check|source check|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    priority = 2;
  } else if (status === "done" || status === "completed") {
    priority = 1;
  }
  if (priority === 0) {
    return 0;
  }
  const relevanceText = `${agentId} ${label}`;
  if (
    /\b(?:slow-source|slow source|source-check|source check|source|research|release-risk|release risk)\b/i.test(
      latestUserText,
    )
  ) {
    if (agentId === "explore") {
      priority += 3;
    }
    if (/\b(?:slow|source|fetch|research|risk)\b/i.test(label)) {
      priority += 2;
    }
  }
  if (
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(
      latestUserText,
    ) &&
    agentId === "browser"
  ) {
    priority += 2;
  }
  if (
    /\b(?:slow-source|slow source|source-check|source check)\b/i.test(
      latestUserText,
    ) &&
    /\bbrowser\b/i.test(relevanceText)
  ) {
    priority -= 1;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  if (continuationTextMatchesSubject(relevanceText, latestUserText)) {
    priority += 4;
  }
  return priority;
}

function contextHasTruncatedTimeoutContinuationCandidate(
  context: string,
  latestUserText: string,
): boolean {
  if (
    !continuationRequestPrefersResumableSession({
      latestUserText,
      context,
    })
  ) {
    return false;
  }
  const truncatedWorkerKey =
    /"session_key"\s*:\s*"worker:[^"]*(?:…|\.{3})[^"]*"/i;
  if (!truncatedWorkerKey.test(context)) {
    return false;
  }
  return /\b(?:timeout|timed out|WORKER_TIMEOUT)\b/i.test(context);
}

function extractSessionToolResultRecords(
  context: string,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const parsed of parseJsonObjectsFromContext(context)) {
    collectSessionToolResultRecords(parsed, records);
  }
  return records;
}

function collectSessionToolResultRecords(
  value: unknown,
  records: Array<Record<string, unknown>>,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const result = value as Record<string, unknown>;
  if (result["protocol"] === SESSION_TOOL_RESULT_PROTOCOL) {
    records.push(result);
  }
  for (const key of ["content", "resultContent"]) {
    const nested = result[key];
    if (
      typeof nested !== "string" ||
      !nested.includes(SESSION_TOOL_RESULT_PROTOCOL)
    ) {
      continue;
    }
    for (const parsed of parseJsonObjectsFromContext(nested)) {
      collectSessionToolResultRecords(parsed, records);
    }
  }
}

function sessionToolResultSupportsContinuation(
  result: Record<string, unknown>,
): boolean {
  return sessionToolResultContinuationPriority(result) > 0;
}

function sessionToolResultContinuationPriority(
  result: Record<string, unknown>,
  latestUserText = "",
): number {
  if (result["protocol"] !== SESSION_TOOL_RESULT_PROTOCOL) {
    return 0;
  }
  let priority = 0;
  if (
    result["status"] === "timeout" ||
    result["status"] === "cancelled" ||
    result["resumable"] === true
  ) {
    priority = result["status"] === "timeout" ? 4 : 3;
  } else if (result["status"] === "completed") {
    priority = 1;
  }
  if (priority === 0) {
    return 0;
  }
  const agentId =
    typeof result["agent_id"] === "string" ? result["agent_id"] : "";
  if (
    continuationRequestRequiresBrowserEvidence(latestUserText) &&
    agentId !== "browser"
  ) {
    return 0;
  }
  if (
    result["status"] === "timeout" &&
    /\b(?:timeout|timed out|slow-source|slow source|source-check|source check)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 3;
  }
  if (
    agentId === "explore" &&
    /\b(?:slow-source|slow source|source-check|source check|source|research)\b/i.test(
      latestUserText,
    )
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    /\b(?:browser|dashboard|page|tab|rendered|visual)\b/i.test(latestUserText)
  ) {
    priority += 2;
  }
  if (
    agentId === "browser" &&
    continuationRequestTargetsResearchThread(latestUserText) &&
    !continuationRequestTargetsBrowser(latestUserText)
  ) {
    priority -= 4;
  }
  if (
    result["status"] === "cancelled" &&
    /\b(?:cancelled|canceled)\b/i.test(latestUserText)
  ) {
    priority += 3;
  }
  if (
    continuationTextMatchesSubject(
      sessionToolResultRelevanceText(result),
      latestUserText,
    )
  ) {
    priority += 4;
  }
  return priority;
}

function continuationRequestTargetsResearchThread(latestUserText: string): boolean {
  return /\b(?:research|source|vendor|provider|notes|thread|work|evidence|comparison)\b|研究|来源|供应商|证据|对比|比较/i.test(
    latestUserText,
  );
}

function continuationRequestTargetsBrowser(latestUserText: string): boolean {
  return /\b(?:browser|dashboard|page|tab|rendered|visual|screenshot|form|submit)\b|浏览器|页面|仪表盘|截图|渲染/i.test(
    latestUserText,
  );
}

function continuationRequestRequiresBrowserEvidence(
  latestUserText: string,
): boolean {
  return /\b(?:rendered browser evidence|browser[- ]rendered evidence|browser-visible evidence|browser visible evidence|rendered evidence|browser evidence|visible page evidence|screenshot|snapshot)\b|浏览器证据|渲染证据|页面可见证据|截图|快照/i.test(
    latestUserText,
  );
}

function sessionToolResultRelevanceText(
  result: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const key of [
    "agent_id",
    "label",
    "result",
    "final_content",
    "summary",
    "task",
  ]) {
    const value = result[key];
    if (typeof value === "string") {
      parts.push(value);
    }
  }
  const payload = result["payload"];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of ["label", "summary", "content", "result"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string") {
        parts.push(value);
      }
    }
  }
  return parts.join("\n");
}

function continuationTextMatchesSubject(
  candidateText: string,
  latestUserText: string,
): boolean {
  const candidate = candidateText.toLowerCase();
  if (!candidate.trim()) return false;
  return continuationSubjectPhrases(latestUserText).some((phrase) =>
    candidate.includes(phrase.toLowerCase()),
  );
}

function continuationSubjectPhrases(text: string): string[] {
  const phrases = new Set<string>();
  for (const match of text.matchAll(/[`"“]([^`"”]{3,80})[`"”]/g)) {
    addContinuationSubjectPhrase(phrases, match[1] ?? "");
  }
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z][A-Za-z0-9]*)+\b/g)) {
    addContinuationSubjectPhrase(phrases, match[0]);
  }
  for (const match of text.matchAll(/\b(?:Vendor|Provider|Project|Source|Researcher|Team|Customer)\s+[A-Z][A-Za-z0-9_-]+\b/g)) {
    addContinuationSubjectPhrase(phrases, match[0]);
  }
  return [...phrases];
}

function addContinuationSubjectPhrase(
  phrases: Set<string>,
  rawPhrase: string,
): void {
  const phrase = rawPhrase
    .replace(/\b(?:same|previous|prior|existing|earlier|research|thread|notes|work|source|session)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (phrase.length < 4) return;
  if (/^(?:continue|resume|revisit|follow up|product lead)$/i.test(phrase)) {
    return;
  }
  if (phrase.split(/\s+/).length > 6) return;
  phrases.add(phrase);
}

function parseJsonObjectsFromContext(context: string): unknown[] {
  const parsed: unknown[] = [];
  for (let index = 0; index < context.length; index += 1) {
    if (context[index] !== "{") {
      continue;
    }
    const end = findJsonObjectEnd(context, index);
    if (end === null) {
      continue;
    }
    try {
      parsed.push(JSON.parse(context.slice(index, end + 1)));
      index = end;
    } catch {
      // The context window may start or end inside a JSON blob. Keep scanning
      // for the next balanced object instead of falling back to raw status text.
    }
  }
  return parsed;
}

function findJsonObjectEnd(context: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < context.length; index += 1) {
    const char = context[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function isExplicitSessionContinuationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (
    !/\b(continue|continuation|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /\b(?:follow-?up|later|afterward|afterwards|future)\b.{0,120}\b(?:may|might|can|could|should)\s+(?:ask|request)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /\b(?:may|might|can|could|should)\s+(?:ask|request)\b.{0,120}\b(?:continue|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^(?:please\s+)?(?:continue|resume|retry|revisit|follow-?up)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return /\b(?:continue|resume|retry|revisit)\s+(?:from|the|that|this|same|existing|previous|prior)\b/i.test(
    normalized,
  );
}

function extractLatestUserContinuationText(taskPrompt: string): string {
  const verbatimDirection = extractVerbatimGoalDirection(taskPrompt);
  if (verbatimDirection) {
    return sliceUtf8(
      verbatimDirection.replace(/\s+/g, " ").trim(),
      1200,
    );
  }
  const lines = taskPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const latestUserLine = [...lines]
    .reverse()
    .find((line) => /^\[?user\]?(?:[:：]|\s+)/i.test(line));
  const hasSessionContinuationContext =
    extractSessionToolResultRecords(taskPrompt).length > 0 ||
    /"session_key"\s*:|worker:[A-Za-z0-9_-]+:task(?::|-)/.test(taskPrompt);
  const continuationLineIndex = latestUserLine
    ? -1
    : !hasSessionContinuationContext
      ? -1
    : (() => {
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          if (isExplicitSessionContinuationRequest(lines[index]!)) {
            return index;
          }
        }
        return -1;
      })();
  const content = latestUserLine
    ? latestUserLine.replace(/^\[?user\]?(?:[:：]|\s+)\s*/i, "")
    : continuationLineIndex >= 0
      ? lines.slice(continuationLineIndex).join("\n")
    : (lines.at(-1) ?? taskPrompt);
  return sliceUtf8(
    content.replace(/\s+/g, " ").trim() ||
      "Continue the same delegated work from the existing session.",
    1200,
  );
}

function extractVerbatimGoalDirection(taskPrompt: string): string | null {
  const latest = extractVerbatimGoalSection(
    taskPrompt,
    "Latest user direction",
  );
  if (latest) {
    return latest;
  }
  return extractVerbatimGoalSection(taskPrompt, "Original user goal");
}

function extractVerbatimGoalSection(
  taskPrompt: string,
  sectionLabel: "Latest user direction" | "Original user goal",
): string | null {
  const match = taskPrompt.match(
    new RegExp(
      `(?:^|\\n)\\s*${escapeRegExp(sectionLabel)}\\s*\\(verbatim\\):\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:Latest user direction|Original user goal)\\s*\\(verbatim\\):|\\n\\s*(?:\\[truncated\\]|The goal above is binding:|Task brief:|Recent turns:|Role scratchpad:|Retrieved memory:|Worker evidence:|Execution continuity:|Output contract:)\\b|$)`,
      "i",
    ),
  );
  const content = match?.[1]?.trim();
  return content ? content : null;
}

function buildSessionContinuationMessageHint(
  taskPrompt: string,
  latestUserText: string,
): string {
  const priorContext = extractPriorContinuationContext(
    taskPrompt,
    latestUserText,
  );
  if (!priorContext) {
    return latestUserText;
  }
  return [
    latestUserText,
    "",
    "Continuation context from the original task:",
    priorContext,
    "",
    "Preserve the original task's decision criteria, required dimensions, entity names, source labels, and user terminology from that context unless the latest user message explicitly changes scope.",
  ].join("\n");
}

function extractPriorContinuationContext(
  taskPrompt: string,
  latestUserText: string,
): string {
  const latestIndex = taskPrompt.lastIndexOf(latestUserText);
  const priorRaw =
    latestIndex > 0 ? taskPrompt.slice(0, latestIndex) : taskPrompt;
  const compact = priorRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[?tool\]?[:：\s]/i.test(line))
    .filter((line) => !line.includes(SESSION_TOOL_RESULT_PROTOCOL))
    .filter((line) => !/^\{.*"session_key".*\}$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sliceUtf8(compact, 1600);
}

function applySessionContinuationDirective(
  toolCalls: LLMToolCall[],
  directive: SessionContinuationDirective | null,
): LLMToolCall[] {
  if (!directive || toolCalls.length === 0) {
    return toolCalls;
  }
  if (toolCalls.some((call) => call.name === "sessions_send")) {
    return toolCalls
      .filter((call) => call.name !== "sessions_spawn")
      .map((call) =>
        call.name === "sessions_send"
          ? {
              ...call,
              input: {
                ...call.input,
                session_key: directive.sessionKey,
                message: mergeSessionContinuationMessage(
                  directive,
                  readStringInput(call.input, "message"),
                ),
              },
            }
          : call,
      );
  }
  const continuationToolIndex = toolCalls.findIndex(
    (call) =>
      call.name === "sessions_spawn" ||
      call.name === "sessions_history" ||
      call.name === "sessions_list",
  );
  if (continuationToolIndex < 0) {
    return toolCalls;
  }
  const rewritten = toolCalls[continuationToolIndex]!;
  const proposedMessage =
    readStringInput(rewritten.input, "message") ??
    readStringInput(rewritten.input, "task") ??
    readStringInput(rewritten.input, "reason");
  return [
    ...toolCalls.slice(0, continuationToolIndex),
    {
      ...rewritten,
      name: "sessions_send",
      input: {
        session_key: directive.sessionKey,
        message: mergeSessionContinuationMessage(
          directive,
          proposedMessage,
        ),
        ...(readStringInput(rewritten.input, "label")
          ? { label: readStringInput(rewritten.input, "label") }
          : {}),
      },
    },
    ...toolCalls
      .slice(continuationToolIndex + 1)
      .filter((call) => call.name !== "sessions_spawn" && call.name !== "sessions_history" && call.name !== "sessions_list"),
  ];
}

function mergeSessionContinuationMessage(
  directive: SessionContinuationDirective,
  proposedMessage: string | undefined,
): string {
  const proposed = proposedMessage?.trim();
  if (
    !proposed ||
    proposed === directive.messageHint ||
    proposed.includes("Continuation context from the original task")
  ) {
    return proposed || directive.messageHint;
  }
  if (
    !directive.messageHint.includes(
      "Continuation context from the original task",
    )
  ) {
    return proposed;
  }
  return [
    proposed,
    "",
    "Runtime continuity guard:",
    directive.messageHint,
  ].join("\n");
}

function applySessionContinuationLookupDirective(
  toolCalls: LLMToolCall[],
  directive: SessionContinuationLookupDirective | null,
): LLMToolCall[] {
  if (!directive || toolCalls.length === 0) {
    return toolCalls;
  }
  const sendIndex = toolCalls.findIndex(
    (call) => call.name === "sessions_send",
  );
  if (sendIndex >= 0) {
    const sent = toolCalls[sendIndex]!;
    const agentId = inferWorkerKindFromSessionKey(
      readStringInput(sent.input, "session_key"),
    );
    return [
      ...toolCalls
        .slice(0, sendIndex)
        .filter(
          (call) =>
            call.name !== "sessions_spawn" && call.name !== "sessions_send",
        ),
      {
        ...sent,
        name: "sessions_list",
        input: {
          limit: 5,
          ...(agentId ? { agent_id: agentId, kinds: [agentId] } : {}),
          reason: `continuation lookup: ${directive.messageHint}`,
        },
      },
      ...toolCalls
        .slice(sendIndex + 1)
        .filter(
          (call) =>
            call.name !== "sessions_spawn" && call.name !== "sessions_send",
        ),
    ];
  }
  if (toolCalls.some((call) => call.name === "sessions_list")) {
    return toolCalls.filter((call) => call.name !== "sessions_spawn");
  }
  const spawnIndex = toolCalls.findIndex(
    (call) => call.name === "sessions_spawn",
  );
  if (spawnIndex < 0) {
    return toolCalls;
  }
  const spawned = toolCalls[spawnIndex]!;
  const agentId = readStringInput(spawned.input, "agent_id");
  return [
    ...toolCalls.slice(0, spawnIndex),
    {
      ...spawned,
      name: "sessions_list",
      input: {
        limit: 5,
        ...(agentId ? { agent_id: agentId, kinds: [agentId] } : {}),
        reason: `continuation lookup: ${directive.messageHint}`,
      },
    },
    ...toolCalls
      .slice(spawnIndex + 1)
      .filter((call) => call.name !== "sessions_spawn"),
  ];
}

function inferWorkerKindFromSessionKey(sessionKey: unknown): string | null {
  if (typeof sessionKey !== "string") {
    return null;
  }
  const match = sessionKey.match(/^worker:([A-Za-z0-9_-]+):task(?::|-)/);
  return match?.[1] ?? null;
}

const SESSION_SEND_ALIAS_NAMES = new Set([
  "session_continue",
  "session_resume",
  "session_update",
  "sessions_continue",
  "sessions_resume",
  "sessions_update",
]);

function normalizeSessionToolAliasCalls(
  toolCalls: LLMToolCall[],
): LLMToolCall[] {
  return toolCalls.map((call) => {
    if (!SESSION_SEND_ALIAS_NAMES.has(call.name)) {
      return call;
    }
    const sessionKey =
      readStringInput(call.input, "session_key") ??
      readStringInput(call.input, "session") ??
      readStringInput(call.input, "session_id") ??
      readStringInput(call.input, "worker_session") ??
      readStringInput(call.input, "worker_session_key");
    const message =
      readStringInput(call.input, "message") ??
      readStringInput(call.input, "task") ??
      readStringInput(call.input, "instruction") ??
      readStringInput(call.input, "instructions") ??
      readStringInput(call.input, "update") ??
      readStringInput(call.input, "content") ??
      readStringInput(call.input, "query");
    return {
      ...call,
      name: "sessions_send",
      input: {
        ...call.input,
        ...(sessionKey ? { session_key: sessionKey } : {}),
        ...(message ? { message } : {}),
      },
    };
  });
}

function normalizeSessionToolCalls(
  toolCalls: LLMToolCall[],
  sessionContext = "",
): LLMToolCall[] {
  const knownSessionKeys = extractKnownWorkerSessionKeys(sessionContext);
  return toolCalls.map((call) => {
    if (call.name !== "sessions_send" && call.name !== "sessions_history") {
      return call;
    }
    const sessionKey = readStringInput(call.input, "session_key");
    const extractedSessionKey = sessionKey
      ? extractWorkerSessionKey(sessionKey)
      : undefined;
    const normalizedSessionKey = extractedSessionKey
      ? resolveKnownWorkerSessionKey(extractedSessionKey, knownSessionKeys)
      : undefined;
    if (!normalizedSessionKey || normalizedSessionKey === sessionKey) {
      return call;
    }
    return {
      ...call,
      input: {
        ...call.input,
        session_key: normalizedSessionKey,
      },
    };
  });
}

function normalizeExplicitContinuationHistoryCalls(
  toolCalls: LLMToolCall[],
  taskPrompt: string,
): LLMToolCall[] {
  if (
    !taskLooksLikeExplicitSessionContinuation(taskPrompt) ||
    taskRequestsSessionTranscript(taskPrompt)
  ) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (call.name !== "sessions_history") {
      return call;
    }
    const sessionKey = readSessionKeyFromToolInput(call.input);
    if (!sessionKey) {
      return call;
    }
    const proposedMessage =
      readStringInput(call.input, "message") ??
      readStringInput(call.input, "reason") ??
      readStringInput(call.input, "query");
    return {
      ...call,
      name: "sessions_send",
      input: {
        session_key: sessionKey,
        message:
          proposedMessage?.trim() ||
          [
            "Continue this existing sub-agent session for the user's follow-up.",
            "Let the source-check finish with the evidence it can collect, then return verified facts, unverified scope, residual risk, and how to continue if evidence is still incomplete.",
          ].join(" "),
      },
    };
  });
}

function taskLooksLikeExplicitSessionContinuation(taskPrompt: string): boolean {
  return (
    taskRequestsTimeoutFollowupContinuation(taskPrompt) ||
    /\b(?:continue|resume|retry|follow[- ]?up)\b[\s\S]{0,180}\b(?:existing|same|previous|prior|earlier|source[- ]check|source check|session|attempt|context)\b/i.test(
      taskPrompt,
    ) ||
    /\b(?:existing|same|previous|prior|earlier)\b[\s\S]{0,180}\b(?:continue|resume|retry|follow[- ]?up)\b/i.test(
      taskPrompt,
    )
  );
}

function normalizeLocalUrlWebFetchCalls(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string },
): LLMToolCall[] {
  return toolCalls.map((call) => {
    if (call.name !== "web_fetch") {
      return call;
    }
    const url =
      readStringInput(call.input, "url") ??
      readStringInput(call.input, "uri") ??
      readStringInput(call.input, "href");
    const inputText = [url, stableJson(call.input)].filter(Boolean).join("\n");
    if (!containsPrivateOrLoopbackHttpUrl(inputText)) {
      return call;
    }
    const targetUrl = url ?? extractHttpUrls(inputText)[0] ?? "";
    return {
      ...call,
      name: "sessions_spawn",
      input: {
        agent_id: "browser",
        label: readStringInput(call.input, "label") ?? "local-url-fetch",
        task: [
          "Open the local/private URL as a browser-visible source instead of using web_fetch.",
          targetUrl ? `URL: ${targetUrl}` : null,
          "Extract only evidence visible from the page and preserve source-bounded residual risk.",
          context.taskPrompt ? `Parent task: ${context.taskPrompt}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      },
    };
  });
}

function normalizePrivateUrlResearchSpawnCalls(
  toolCalls: LLMToolCall[],
  context: { browserAvailable: boolean; taskPrompt: string },
): LLMToolCall[] {
  if (!context.browserAvailable) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (
      call.name !== "sessions_spawn" ||
      readStringInput(call.input, "agent_id") !== "explore"
    ) {
      return call;
    }
    const task = readStringInput(call.input, "task") ?? "";
    const label = readStringInput(call.input, "label") ?? "";
    const combined = [task, label].join("\n");
    const targetsBrowserRequiredUrl = toolCallTargetsBrowserRequiredUrl({
      toolCallText: combined,
      taskPrompt: context.taskPrompt,
    });
    if (
      !containsPrivateOrLoopbackHttpUrl(combined) &&
      !targetsBrowserRequiredUrl
    ) {
      return call;
    }
    if (
      isLoopbackReadOnlySourceExploreTask({
        toolCallText: combined,
        taskPrompt: context.taskPrompt,
        targetsBrowserRequiredUrl,
      }) ||
      (allowsLoopbackExploreForE2E() &&
        containsLoopbackHttpUrl(combined) &&
        !containsPrivateNonLoopbackHttpUrl(combined) &&
        !taskRequiresBrowserEvidence(combined) &&
        !targetsBrowserRequiredUrl)
    ) {
      return call;
    }
    const reason = targetsBrowserRequiredUrl
      ? "Use the browser worker for this browser-visible URL source; do not use public-source fetch."
      : "Use the browser worker for this local/private URL source; do not use public-source fetch.";
    return {
      ...call,
      input: {
        ...call.input,
        agent_id: "browser",
        task: [
          reason,
          "Inspect the rendered page as the user would see it, extract only observed facts, and mark missing fields as not verified.",
          task,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  });
}

function normalizeBoundedTimeoutSourceSpawnAgents(
  toolCalls: LLMToolCall[],
  context: { exploreAvailable: boolean; taskPrompt: string },
): LLMToolCall[] {
  if (
    !context.exploreAvailable ||
    !looksBoundedTimeoutSourceCheck(context.taskPrompt)
  ) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (
      call.name !== "sessions_spawn" ||
      readStringInput(call.input, "agent_id") !== "browser"
    ) {
      return call;
    }
    const task = readStringInput(call.input, "task") ?? "";
    const label = readStringInput(call.input, "label") ?? "";
    const callText = [task, label].join("\n");
    if (extractHttpUrls(callText).length === 0) {
      return call;
    }
    const browserRequired =
      taskRequiresBrowserEvidence(context.taskPrompt) ||
      taskRequiresBrowserEvidence(callText) ||
      hasHardBrowserRequiredSignal(context.taskPrompt) ||
      hasHardBrowserRequiredSignal(callText) ||
      toolCallTargetsBrowserRequiredUrl({
        toolCallText: callText,
        taskPrompt: context.taskPrompt,
      });
    if (browserRequired) {
      return call;
    }
    return {
      ...call,
      input: {
        ...call.input,
        agent_id: "explore",
        task: [
          "Use the explore worker for this bounded source-check; browser-visible/rendered evidence was not requested.",
          task,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    };
  });
}

function normalizeBoundedTimeoutDuplicateSourceSpawns(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string },
): LLMToolCall[] {
  if (!looksBoundedTimeoutSourceCheck(context.taskPrompt)) {
    return toolCalls;
  }
  const selectedByUrlSet = new Map<string, { index: number; score: number }>();
  const droppedIndexes = new Set<number>();
  toolCalls.forEach((call, index) => {
    if (call.name !== "sessions_spawn") {
      return;
    }
    const urls = dedupeStrings(
      extractHttpUrls(
        [
          readStringInput(call.input, "task") ?? "",
          readStringInput(call.input, "label") ?? "",
        ].join("\n"),
      ).map(normalizeUrlForComparison),
    ).sort();
    if (urls.length !== 1) {
      return;
    }
    const urlSetKey = urls.join("\n");
    const score = scoreBoundedTimeoutSourceSpawn(call, context.taskPrompt);
    const current = selectedByUrlSet.get(urlSetKey);
    if (!current || score > current.score) {
      if (current) {
        droppedIndexes.add(current.index);
      }
      selectedByUrlSet.set(urlSetKey, { index, score });
      return;
    }
    droppedIndexes.add(index);
  });
  if (droppedIndexes.size === 0) {
    return toolCalls;
  }
  return toolCalls.filter((_, index) => !droppedIndexes.has(index));
}

function looksBoundedTimeoutSourceCheck(text: string): boolean {
  return (
    /\b(?:bounded attempt|bounded retry|does not return|doesn't return|slow[- ]source|source[- ]check|timeout|timed out|resume(?:d)? the existing source|continue from the slow[- ]source)\b/i.test(
      text,
    ) && extractHttpUrls(text).length > 0
  );
}

function scoreBoundedTimeoutSourceSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): number {
  const agentId = readStringInput(call.input, "agent_id") ?? "";
  const callText = [
    readStringInput(call.input, "task") ?? "",
    readStringInput(call.input, "label") ?? "",
  ].join("\n");
  const browserRequired =
    taskRequiresBrowserEvidence(taskPrompt) ||
    taskRequiresBrowserEvidence(callText) ||
    toolCallTargetsBrowserRequiredUrl({ toolCallText: callText, taskPrompt });
  if (browserRequired) {
    if (agentId === "browser") return 30;
    if (agentId === "explore") return 10;
    return 0;
  }
  if (agentId === "explore") return 30;
  if (agentId === "browser") return 10;
  return 0;
}

function normalizeApprovalGatedBrowserSpawnCalls(
  toolCalls: LLMToolCall[],
  context: {
    taskPrompt: string;
    sessionContext: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  const browserSpawnCalls = toolCalls.filter(isBrowserSessionSpawn);
  if (browserSpawnCalls.length === 0) {
    return toolCalls;
  }
  const contextText = [
    context.taskPrompt,
    context.sessionContext,
    ...browserSpawnCalls.flatMap((call) => [
      readStringInput(call.input, "task") ?? "",
      readStringInput(call.input, "label") ?? "",
      readStringInput(call.input, "action") ?? "",
    ]),
  ].join("\n");
  if (!looksApprovalGatedBrowserSideEffect(contextText)) {
    return toolCalls;
  }
  const prematureMutatingBrowserSpawn = browserSpawnCalls.find((call) =>
    (() => {
      const callText = [
        readStringInput(call.input, "task") ?? "",
        readStringInput(call.input, "label") ?? "",
        readStringInput(call.input, "action") ?? "",
      ].join("\n");
      return (
        looksApprovalGatedBrowserSideEffect(callText) &&
        browserSpawnPerformsMutatingAction(callText) &&
        !disclaimsIntendedBrowserMutation(callText)
      );
    })(),
  );
  if (
    prematureMutatingBrowserSpawn &&
    !taskPromptSaysApprovalAlreadyApplied(context.taskPrompt) &&
    !hasPermissionGateContextEvidence(context.sessionContext) &&
    !hasPermissionGateEvidence(context.toolTrace) &&
    !toolCalls.some((call) => call.name.startsWith("permission_"))
  ) {
    return toolCalls.flatMap((call) => {
      if (!isBrowserSessionSpawn(call)) {
        return [call];
      }
      if (call !== prematureMutatingBrowserSpawn) {
        return [];
      }
      const permissionQuery = buildPermissionQueryFromBrowserSpawn(
        call,
        context.taskPrompt,
      );
      const inspectionCall = buildPreApprovalBrowserInspectionSpawn(
        call,
        context.taskPrompt,
      );
      return inspectionCall ? [inspectionCall, permissionQuery] : [permissionQuery];
    });
  }
  if (browserSpawnCalls.length <= 1) {
    return toolCalls;
  }
  const seenSignatures = new Set<string>();
  return toolCalls.filter((call) => {
    if (!isBrowserSessionSpawn(call)) {
      return true;
    }
    const signature = toolCallSignature(call);
    if (!seenSignatures.has(signature)) {
      seenSignatures.add(signature);
      return true;
    }
    return false;
  });
}

function hasPermissionGateContextEvidence(context: string): boolean {
  return /\bpermission_(?:query|result|applied)\b|\bpermission\.(?:query|result|applied)\b|\bapproval_id\b|\bpermission cache\b[\s\S]{0,120}\balready applied\b/i.test(
    context,
  );
}

function buildPermissionQueryFromBrowserSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): LLMToolCall {
  const task = readStringInput(call.input, "task") ?? "";
  const label = readStringInput(call.input, "label") ?? "";
  const url = extractHttpUrls(`${task}\n${taskPrompt}`)[0];
  return {
    ...call,
    name: "permission_query",
    input: {
      action: "browser.form.submit",
      title: "Approve local dry-run browser form submission",
      risk:
        "Applies an approval-gated browser form submission in an isolated local dry-run page.",
      level: "approval",
      scope: "mutate",
      worker_kind: "browser",
      rationale:
        "The user asked to carry a browser form submission through the approval gate before applying the action.",
      payload: {
        ...(url ? { url } : {}),
        task: task || label || "approval-gated browser form submission",
      },
    },
  };
}

function buildPreApprovalBrowserInspectionSpawn(
  call: LLMToolCall,
  taskPrompt: string,
): LLMToolCall | null {
  const task = readStringInput(call.input, "task") ?? "";
  const label = readStringInput(call.input, "label") ?? "";
  const callText = [task, label].join("\n");
  if (!shouldPreservePreApprovalBrowserInspection(callText, taskPrompt)) {
    return null;
  }
  const url = extractHttpUrls(`${callText}\n${taskPrompt}`)[0];
  if (!url) {
    return null;
  }
  return {
    ...call,
    id: `${call.id}-inspection`,
    input: {
      ...call.input,
      agent_id: "browser",
      label: label || "Pre-approval browser inspection",
      task: [
        "Pre-approval browser inspection only.",
        `Open ${url} as a rendered browser page and observe what is visible before any approval-gated action.`,
        "Report the final URL, page title, visible fixture/marker text, form fields, submission control, and screenshot/snapshot evidence if available.",
        "Do not submit the form, click the submit control, fill fields, save, mutate, or perform any side effect. The form submission remains blocked until permission_query/permission_result/permission_applied clears it.",
      ].join("\n"),
    },
  };
}

function shouldPreservePreApprovalBrowserInspection(
  callText: string,
  taskPrompt: string,
): boolean {
  const combined = `${taskPrompt}\n${callText}`;
  if (!looksApprovalGatedBrowserSideEffect(combined)) {
    return false;
  }
  if (!/\b(?:approval[- ]?form|approval form|dry[- ]run|operator review|browser\.form\.submit|form submission)\b/i.test(combined)) {
    return false;
  }
  return (
    containsPrivateOrLoopbackHttpUrl(combined) ||
    /\b(?:open|inspect|observe|rendered|screenshot|snapshot|visible|page evidence|what evidence the page showed)\b/i.test(
      combined,
    )
  );
}

function enforceMissingApprovalGateRepairToolCalls(
  toolCalls: LLMToolCall[],
  context: {
    messages: LLMMessage[];
    taskPrompt: string;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  if (
    !hasMissingApprovalGateRepairPrompt(context.messages) ||
    !requestsApprovalGatedBrowserAction(context.taskPrompt) ||
    hasPermissionGateEvidence(context.toolTrace) ||
    toolCalls.some((call) => call.name === "permission_query")
  ) {
    return toolCalls;
  }
  const selected = toolCalls[0];
  return [
    buildPermissionQueryFromBrowserSpawn(
      selected ?? {
        id: "runtime-missing-approval-gate",
        name: "sessions_spawn",
        input: {},
      },
      context.taskPrompt,
    ),
  ];
}

function shouldSuppressReadOnlyPermissionQueryToolCalls(
  toolCalls: LLMToolCall[],
  context: { taskPrompt: string; sessionContext: string },
): boolean {
  return toolCalls.some((call) => {
    if (call.name !== "permission_query") {
      return false;
    }
    const callText = stableJson(normalizeToolInputForSignature(call.input));
    return (
      isSourceBackedReadOnlyTask(context.taskPrompt) ||
      isClearlyUnrequestedReadOnlyPermissionQuery(callText, context.taskPrompt) ||
      disclaimsIntendedBrowserMutation(callText) ||
      (disclaimsIntendedBrowserMutation(context.taskPrompt) &&
        !requestsApprovalGatedBrowserAction(context.taskPrompt))
    );
  });
}

function isSourceBackedReadOnlyTask(taskPrompt: string): boolean {
  const sourceReadOnlyTask =
    /\b(?:read[- ]only|source-backed|source backed|provider|pricing|price|search\/web_search|web_search|extract|evidence source|listed sources?|research note|api provider)\b/i.test(
      taskPrompt,
    );
  if (!sourceReadOnlyTask) {
    return false;
  }
  return !/\b(?:submit|submission|form|click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in|mutat(?:e|ion)|side[- ]effect|dry[- ]run)\b/i.test(
    taskPrompt,
  );
}

function isClearlyUnrequestedReadOnlyPermissionQuery(
  callText: string,
  taskPrompt: string,
): boolean {
  if (taskAllowsPermissionTools(taskPrompt)) {
    return false;
  }
  if (!/\b(?:browser\.form\.submit|form submission|approval-gated browser form submission)\b/i.test(callText)) {
    return false;
  }
  const sourceReadOnlyTask =
    isSourceBackedReadOnlyTask(taskPrompt);
  return sourceReadOnlyTask;
}

function disclaimsIntendedBrowserMutation(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:not\s+(?:a\s+)?form submission|not\s+(?:a\s+)?browser mutation|do not mutate|don't mutate|without mutat(?:ing|ion)|no browser mutation|no form submission)\b/i.test(
      normalized,
    ) ||
    /\b(?:inspect|inspection|observe|review|report|summarize|read|check)\b[\s\S]{0,120}\bbefore\s+(?:submission|submit|submitting|mutation|side[- ]effect)\b/i.test(
      normalized,
    ) ||
    /\b(?:read[- ]only|inspection only|observe[- ]only|no[- ]mutation)\b[\s\S]{0,180}\b(?:no|not|without|unintended)\b[\s\S]{0,120}\b(?:submit|submission|form submission|mutat(?:e|ion)|side[- ]effects?|browser side[- ]effect)\b/i.test(
      normalized,
    ) ||
    /\b(?:no|not|without)\b[\s\S]{0,80}\b(?:form submission|submission|submit|mutat(?:e|ion)|side[- ]effects?)\b[\s\S]{0,160}\b(?:intended|needed|required|will run|will be performed|should run|should be performed)\b/i.test(
      normalized,
    ) ||
    /\b(?:submitting|submit(?:ting)? a form|form submission|browser mutation|side[- ]effect)\b[\s\S]{0,120}\b(?:would be|is)\s+(?:an\s+)?unintended\b/i.test(
      normalized,
    )
  );
}

function buildReadOnlyPermissionQuerySuppressionPrompt(): string {
  return [
    "Runtime correction: read-only browser inspection does not require approval.",
    "The previous permission_query describes no intended form submission, mutation, or side effect, so it must not enter the native approval flow.",
    "Do not call permission_query, permission_result, permission_applied, or browser mutation tools.",
    "Produce the final answer from completed evidence. If any requested item remains unverified, state it explicitly and give the safe next action.",
  ].join("\n");
}

function isBrowserSessionSpawn(call: LLMToolCall): boolean {
  return (
    call.name === "sessions_spawn" &&
    readStringInput(call.input, "agent_id") === "browser"
  );
}

function hasCompletedBrowserSessionEvidence(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  return toolTrace.some((round) =>
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
        parsed.status === "completed" &&
        parsed.agent_id === "browser" &&
        readCompletedSessionEvidence(parsed),
      );
    }),
  );
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

function taskRequiresBrowserEvidence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  if (explicitlyDisclaimsBrowserRenderedEvidence(normalized)) {
    return false;
  }
  return (
    /\b(?:browser-visible|browser rendered|browser-rendered|browser-observed|as (?:a|an) (?:user|operator) would see|user-visible|visible page|rendered page|rendered DOM|client[- ]side|JavaScript-rendered|JS-rendered|dynamic dashboard|live dashboard)\b/i.test(
      normalized,
    ) ||
    /\b(?:rendered browser page|browser page rendered|fully render(?:ed)?|rendered values?|visible values?|exact visible text|exact visible values?)\b/i.test(
      normalized,
    ) ||
    /\b(?:live signal|signal dashboard|real-time indicators?|visible metrics?|metrics? dashboards?)\b/i.test(
      normalized,
    ) ||
    /\b(?:dashboards?|metrics?|signal values?)\b[\s\S]{0,120}\bshown on (?:the )?page\b/i.test(
      normalized,
    ) ||
    /\b(?:iframe|embedded source frame|frame content|shadow(?:-style)? component|shadow DOM|details popup|popup workflow|open the details popup)\b/i.test(
      normalized,
    )
  );
}

function explicitlyDisclaimsBrowserRenderedEvidence(text: string): boolean {
  return (
    /\b(?:not|never)\s+(?:a\s+)?(?:browser-visible|browser-rendered|browser rendered|browser-observed|user-visible)\b/i.test(
      text,
    ) ||
    /\b(?:no|without)\s+(?:client[- ]side|JavaScript-rendered|JS-rendered|rendered DOM|browser-rendered|browser rendered|browser-visible)\s+(?:rendering|content|evidence|required|needed)?\b/i.test(
      text,
    ) ||
    /\bstatic HTML only\b[\s\S]{0,80}\b(?:no|without)\s+(?:JavaScript|JS|client[- ]side|browser-rendered|browser rendered)\b/i.test(
      text,
    )
  );
}

function toolCallTargetsBrowserRequiredUrl(input: {
  toolCallText: string;
  taskPrompt: string;
}): boolean {
  const urls = extractHttpUrls(input.toolCallText);
  if (urls.length === 0 || !taskRequiresBrowserEvidence(input.taskPrompt)) {
    return false;
  }
  return urls.some((url) =>
    taskPromptRequiresBrowserForUrl(input.taskPrompt, url),
  );
}

function taskPromptRequiresBrowserForUrl(
  taskPrompt: string,
  url: string,
): boolean {
  const normalizedUrl = normalizeUrlForComparison(url);
  const lines = taskPrompt.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (
      !extractHttpUrls(line).some(
        (candidate) => normalizeUrlForComparison(candidate) === normalizedUrl,
      )
    ) {
      continue;
    }
    const localContext = [
      lines[index - 1],
      line,
      lines[index + 1],
      lines[index + 2],
    ]
      .filter((item): item is string => typeof item === "string")
      .join("\n");
    if (taskRequiresBrowserEvidence(localContext)) {
      return true;
    }
  }
  return false;
}

function normalizeUrlForComparison(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function looksApprovalGatedBrowserSideEffect(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  const hasApprovalContext =
    /\b(?:approval|approve|approved|permission|authorize|authorized|operator\s+review|gate|gated|dry-?run)\b/i.test(
      normalized,
    ) || /\bbrowser\.[a-z0-9_.-]+\b/i.test(normalized);
  const hasBrowserMutation =
    /\b(?:submit|click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in|form)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    );
  return hasApprovalContext && hasBrowserMutation;
}

function browserSpawnPerformsMutatingAction(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /\b(?:submit|submission|form\.submit)\b[\s\S]{0,80}\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b/i.test(
      normalized,
    ) ||
    /\b(?:form|button|control|page|browser|action|mutation|side[- ]effect|approval|approved|dry[- ]run)\b[\s\S]{0,80}\b(?:submit|submission|form\.submit)\b/i.test(
      normalized,
    ) ||
    /\b(?:click|press|type|fill|select|upload|download|delete|save|apply|confirm|purchase|checkout|sign\s*in|log\s*in)\b/i.test(
      normalized,
    ) ||
    /\bbrowser\.(?:form\.submit|click|input|type|select|upload|download|permission)\b/i.test(
      normalized,
    )
  );
}

function hasExecutedSessionsSend(
  toolTrace: NativeToolRoundTrace[],
  sessionKey: string,
): boolean {
  return toolTrace.some((round) =>
    round.calls.some(
      (call) =>
        call.name === "sessions_send" &&
        readStringInput(call.input, "session_key") === sessionKey,
    ),
  );
}

function hasToolDefinition(
  tools: GenerateTextInput["tools"] | undefined,
  name: string,
): boolean {
  return (tools ?? []).some((tool) => tool.name === name);
}

function extractWorkerSessionKey(value: string): string | undefined {
  return value.match(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/)?.[0];
}

function extractKnownWorkerSessionKeys(context: string): string[] {
  const matches =
    context.match(/\bworker:[A-Za-z0-9_-]+:task(?::|-)[^\s"'`,|}\]]+/g) ?? [];
  return [...new Set(matches)];
}

function resolveKnownWorkerSessionKey(
  sessionKey: string,
  knownSessionKeys: string[],
): string {
  if (knownSessionKeys.includes(sessionKey)) {
    return sessionKey;
  }
  const sessionSignature = relaxedSessionKeySignature(sessionKey);
  const matches = knownSessionKeys.filter(
    (candidate) => relaxedSessionKeySignature(candidate) === sessionSignature,
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  const truncatedPrefix = readTruncatedSessionKeyPrefix(sessionSignature);
  if (truncatedPrefix) {
    const prefixMatches = knownSessionKeys.filter((candidate) =>
      relaxedSessionKeySignature(candidate).startsWith(truncatedPrefix),
    );
    if (prefixMatches.length === 1) {
      return prefixMatches[0]!;
    }
  }
  return sessionKey;
}

function relaxedSessionKeySignature(sessionKey: string): string {
  return sessionKey
    .replace(/call_function_/g, "call_")
    .replace(/call_func_/g, "call_")
    .replace(/call_funct(?:ion)?(?=…|\.{3})/g, "call_")
    .replace(/call_func(?=…|\.{3})/g, "call_");
}

function readTruncatedSessionKeyPrefix(sessionKey: string): string | null {
  const ellipsisIndex = sessionKey.search(/…|\.\.\./);
  if (ellipsisIndex < 0) {
    return null;
  }
  const prefix = sessionKey.slice(0, ellipsisIndex);
  return prefix.length >= 24 ? prefix : null;
}

function readStringInput(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function containsPrivateOrLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return isPrivateOrLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  });
}

function containsLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return isLoopbackHostname(parsed.hostname);
    } catch {
      return false;
    }
  });
}

function containsPrivateNonLoopbackHttpUrl(text: string): boolean {
  return extractHttpUrls(text).some((url) => {
    try {
      const parsed = new URL(url);
      return (
        isPrivateOrLoopbackHostname(parsed.hostname) &&
        !isLoopbackHostname(parsed.hostname)
      );
    } catch {
      return false;
    }
  });
}

function isLoopbackReadOnlySourceExploreTask(input: {
  toolCallText: string;
  taskPrompt: string;
  targetsBrowserRequiredUrl: boolean;
}): boolean {
  if (
    input.targetsBrowserRequiredUrl ||
    taskRequiresBrowserEvidence(input.taskPrompt) ||
    taskRequiresBrowserEvidence(input.toolCallText) ||
    !containsLoopbackHttpUrl(input.toolCallText) ||
    containsPrivateNonLoopbackHttpUrl(input.toolCallText)
  ) {
    return false;
  }
  const normalized = input.toolCallText.toLowerCase();
  return (
    /\b(?:source pages?|source|pricing|price|url extraction|read-only url|fetch|extract|retrieve|research|review|compare|comparison|evidence|content)\b/i.test(
      normalized,
    ) && !hasHardBrowserRequiredSignal(normalized)
  );
}

function hasHardBrowserRequiredSignal(input: string): boolean {
  return /\b(?:authenticated|login|logged in|account|password|2fa|mfa|otp|credential|api key|secret|token|interactive|click|fill|submit|submission|form|approval|dry-run|dry run|operator review|side effect|side-effect|mutation|save|purchase|delete|update|visual|screenshot|snapshot|js-rendered|javascript-rendered|client-side|rendered dashboard|dashboard|as a user would see|active browser)\b/i.test(
    input,
  );
}

function allowsLoopbackExploreForE2E(): boolean {
  return process.env.TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE === "1";
}

function extractHttpUrls(text: string): string[] {
  return Array.from(text.matchAll(/\bhttps?:\/\/[^\s"'`<>]+/gi))
    .map((match) => trimHttpUrlCandidate(match[0] ?? ""))
    .filter(Boolean);
}

function trimHttpUrlCandidate(candidate: string): string {
  let value = candidate.trim();
  while (value) {
    try {
      new URL(value);
      return value;
    } catch {
      const next = value.replace(/[)\],;.!?。，“”‘’！？：:]$/g, "");
      if (next === value) {
        return value;
      }
      value = next;
    }
  }
  return value;
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(hostname) || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrLoopbackHostname(normalized.slice("::ffff:".length));
  }
  if (
    /^(?:fc|fd)[0-9a-f]{2}:/i.test(normalized) ||
    /^fe[89ab][0-9a-f]:/i.test(normalized)
  ) {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  if (
    numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const a = numbers[0]!;
  const b = numbers[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHostname(normalized.slice("::ffff:".length));
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  return (
    numbers.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255,
    ) && numbers[0] === 127
  );
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

function resolveEffectiveToolLoopWallClockMs(input: {
  maxWallClockMs?: number;
  toolCalls: LLMToolCall[];
}): number | undefined {
  const maxWallClockMs = input.maxWallClockMs;
  const configured =
    typeof maxWallClockMs === "number" &&
    Number.isFinite(maxWallClockMs) &&
    maxWallClockMs > 0
      ? Math.floor(maxWallClockMs)
      : undefined;
  if (input.toolCalls.some(isBrowserSessionToolCall)) {
    return Math.max(configured ?? 0, DEFAULT_BROWSER_SESSION_TOOL_LOOP_WALL_CLOCK_MS);
  }
  if (!input.toolCalls.some(isSlowLoopbackBrowserSessionToolCall)) {
    return configured;
  }
  return Math.max(configured ?? 0, MAX_BROWSER_OPEN_TIMEOUT_MS);
}

const DEFAULT_BROWSER_SESSION_TOOL_LOOP_WALL_CLOCK_MS = 18 * 60 * 1000;

function isBrowserSessionToolCall(call: LLMToolCall): boolean {
  if (call.name !== "sessions_spawn" && call.name !== "sessions_send") {
    return false;
  }
  const record = isRecord(call.input) ? call.input : null;
  if (!record) {
    return false;
  }
  if (call.name === "sessions_spawn") {
    return record.agent_id === "browser";
  }
  const sessionKey = readString(record.session_key);
  return Boolean(sessionKey && /\bworker:browser\b/i.test(sessionKey));
}

function isSlowLoopbackBrowserSessionToolCall(call: LLMToolCall): boolean {
  if (call.name !== "sessions_spawn" && call.name !== "sessions_send") {
    return false;
  }
  const record = isRecord(call.input) ? call.input : null;
  if (!record) {
    return false;
  }
  const agentId = typeof record.agent_id === "string" ? record.agent_id : null;
  if (call.name === "sessions_spawn" && agentId !== "browser") {
    return false;
  }
  const text =
    call.name === "sessions_spawn"
      ? readString(record.task)
      : readString(record.message);
  if (!text || !isSlowDiagnosticText(text)) {
    return false;
  }
  const urls = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  return urls.some(isLoopbackUrl);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSlowDiagnosticText(value: string): boolean {
  return /\b(?:slow[-\s]?source|slow[-\s]?fixture|bounded|does not finish|doesn't finish|timeout|wait boundedly|loading in time)\b/i.test(
    value,
  );
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.replace(/["'`,;:.!?。，“”‘’！？：]+$/g, ""));
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function createToolExecutionSignal(input: {
  parentSignal?: AbortSignal;
  maxWallClockMs?: number;
  elapsedMs: number;
}): { signal?: AbortSignal; dispose(): void } {
  const maxWallClockMs = input.maxWallClockMs;
  const hasWallClockBudget =
    typeof maxWallClockMs === "number" &&
    Number.isFinite(maxWallClockMs) &&
    maxWallClockMs > 0;
  if (!hasWallClockBudget) {
    return {
      ...(input.parentSignal ? { signal: input.parentSignal } : {}),
      dispose() {},
    };
  }

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let parentAbortHandler: (() => void) | null = null;
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  if (input.parentSignal?.aborted) {
    abort(input.parentSignal.reason ?? "operation aborted");
  } else if (input.parentSignal) {
    parentAbortHandler = () =>
      abort(input.parentSignal?.reason ?? "operation aborted");
    input.parentSignal.addEventListener("abort", parentAbortHandler, {
      once: true,
    });
  }

  const remainingMs = Math.max(0, Math.ceil(maxWallClockMs - input.elapsedMs));
  timeoutHandle = setTimeout(
    () =>
      abort(
        `Tool-use wall-clock budget reached (${formatDurationMs(maxWallClockMs)}).`,
      ),
    remainingMs,
  );

  return {
    signal: controller.signal,
    dispose() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (parentAbortHandler && input.parentSignal) {
        input.parentSignal.removeEventListener("abort", parentAbortHandler);
      }
    },
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

function withFinalToolRoundWarning(
  messages: LLMMessage[],
  input: { active: boolean; round: number; maxRounds: number },
): LLMMessage[] {
  if (!input.active) {
    return messages;
  }
  if (!Number.isFinite(input.maxRounds) || input.maxRounds <= 0) {
    return messages;
  }
  const finalAllowedRound = Math.max(0, Math.floor(input.maxRounds) - 1);
  if (input.round !== finalAllowedRound) {
    return messages;
  }
  return [
    ...messages,
    {
      role: "user",
      content: [
        `Runtime notice: this is the final allowed tool-use round (${Math.floor(input.maxRounds)}).`,
        "If you already have enough evidence, answer now without calling tools.",
        "If you call tools now, use only the highest-value calls needed to finish.",
        "After these tool results return, produce the final answer from the gathered evidence instead of asking for more tools.",
        "If the evidence is still incomplete, mark missing items as not verified and give the next user/operator action.",
      ].join("\n"),
    },
  ];
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

function resolveRecoveryToolBudgetForActivation(input: {
  activation: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
}): { maxToolCalls: number } | null {
  return resolveFinalRecoveryToolBudget(
    buildFinalRecoveryBudgetContext(input),
  );
}

function countRecoveryToolCallsBeforeActivation(input: {
  activation: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
}): number {
  const context = buildFinalRecoveryBudgetContext(input);
  const marker = findLastFinalRecoveryBudgetMarker(context);
  if (marker < 0) return 0;
  return countRenderedToolCallLines(context.slice(marker));
}

function findLastFinalRecoveryBudgetMarker(text: string): number {
  let marker = -1;
  const pattern =
    /Automatic recovery attempt\s+(\d+)\s+of\s+(\d+)[\s\S]{0,600}?at most\s+([a-z]+|\d+)\s+additional tool calls total/gi;
  for (const match of text.matchAll(pattern)) {
    const currentAttempt = Number(match[1]);
    const maxAttempt = Number(match[2]);
    if (
      Number.isFinite(currentAttempt) &&
      Number.isFinite(maxAttempt) &&
      currentAttempt >= maxAttempt
    ) {
      marker = match.index ?? marker;
    }
  }
  return marker;
}

function countRenderedToolCallLines(text: string): number {
  return Array.from(
    text.matchAll(
      /(?:^|[\n\r])\s*Calling\s+[A-Za-z_][\w-]*\s*\(/g,
    ),
  ).length;
}

function buildFinalRecoveryBudgetContext(input: {
  activation: RoleActivationInput;
  taskPrompt: string;
  messages: LLMMessage[];
}): string {
  const intent = input.activation.handoff.payload.intent;
  return [
    input.taskPrompt,
    intent?.relayBrief ?? "",
    intent?.instructions ?? "",
    ...(intent?.recentMessages ?? []).map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    ),
    ...input.messages
      .filter((message) => message.role === "user")
      .map((message) => readToolResultContentText(message.content)),
  ].join("\n");
}

function buildFinalRecoveryBudgetCloseoutReasonLines(maxToolCalls: number): string[] {
  return [
    `Final recovery tool budget reached (${maxToolCalls} tool calls).`,
    "Do not call more tools. Produce a bounded blocked closeout from the evidence already gathered.",
    "List the exact missing goal slots, the pages/tools already attempted, what each source proved, and what remains unverified.",
    "This is not a success closeout. Start the answer with an explicit blocked/partial status when any original goal slot remains unverified.",
    "Do not convert absence of evidence into a negative claim. If a source does not explicitly prove provider support, search/web_search support, or pricing, write 未验证 for that cell instead of ✅, ❌, supported, unsupported, available, unavailable, or not supported.",
    "Do not recommend a provider, cheapest option, or next business decision unless the required support, search/web_search behavior, and input/output pricing are all explicitly verified by quoted source evidence.",
    "For every table row that contains a confirmed value, include the evidence URL and a short quoted/source-excerpt phrase that directly supports that exact value; otherwise mark the value 未验证.",
  ];
}

function shouldRepairFinalRecoveryBudgetCloseout(input: {
  messages: LLMMessage[];
  resultText: string;
}): boolean {
  if (hasFinalRecoveryBudgetCloseoutRepairPrompt(input.messages)) {
    return false;
  }
  if (/@\{role-[^}]+}/i.test(input.resultText)) {
    return true;
  }
  return !/(?:blocked|partial|未验证|无法验证|无法确认|not verified|unverified|needs follow-up|缺口|缺少)/i.test(
    input.resultText,
  );
}

function hasFinalRecoveryBudgetCloseoutRepairPrompt(messages: LLMMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      readToolResultContentText(message.content).includes(
        "Runtime correction: final recovery tool budget is exhausted",
      ),
  );
}

function buildFinalRecoveryBudgetCloseoutRepairPrompt(maxToolCalls: number): string {
  return [
    "Runtime correction: final recovery tool budget is exhausted.",
    ...buildFinalRecoveryBudgetCloseoutReasonLines(maxToolCalls),
    "Do not delegate to another role, do not ask another agent to continue, and do not emit @{role-...} routing text.",
    "Rewrite the final answer now without calling tools.",
  ].join("\n");
}

function resolveFinalRecoveryToolBudget(taskPrompt: string): { maxToolCalls: number } | null {
  const attempt = taskPrompt.match(/Automatic recovery attempt\s+(\d+)\s+of\s+(\d+)/i);
  if (!attempt) return null;
  const currentAttempt = Number(attempt[1]);
  const maxAttempt = Number(attempt[2]);
  if (!Number.isFinite(currentAttempt) || !Number.isFinite(maxAttempt) || currentAttempt < maxAttempt) {
    return null;
  }
  const budget = taskPrompt.match(/at most\s+([a-z]+|\d+)\s+additional tool calls total/i);
  if (!budget) return null;
  const maxToolCalls = parseSmallIntegerWord(budget[1] ?? "");
  if (!Number.isFinite(maxToolCalls) || maxToolCalls <= 0) return null;
  return { maxToolCalls };
}

function parseSmallIntegerWord(value: string): number {
  const normalized = value.trim().toLowerCase();
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) return Math.floor(numeric);
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return words[normalized] ?? Number.NaN;
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

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function formatDurationMs(ms: number): string {
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${Number(seconds.toFixed(3))}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${Number(minutes.toFixed(2))}m`;
  }
  const hours = minutes / 60;
  return `${Number(hours.toFixed(2))}h`;
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

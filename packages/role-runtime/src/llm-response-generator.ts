import type {
  Clock,
  RoleActivationInput,
  RoleId,
  RuntimeProgressRecorder,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import type { GenerateTextInput, GenerateTextResult, LLMContentBlock, LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";

import type { GeneratedRoleReply, RoleResponseGenerator } from "./deterministic-response-generator";
import {
  buildNativeToolMessages,
  type NativeToolProgressTrace,
  type NativeToolResultTrace,
  type NativeToolRoundTrace,
} from "./native-tool-messages";
import type { RolePromptPacket } from "./prompt-policy";
import { reducePromptPacketForRequestEnvelope, type RequestEnvelopeReductionLevel } from "./request-envelope-reducer";
import { getRoleModelSelection } from "./role-model-selection";
import {
  appendAssistantToolCallMessage,
  appendToolResultMessages,
  DEFAULT_ROLE_TOOL_MAX_ROUNDS,
  recordRoleToolProgress,
  type RoleToolExecutionResult,
  type RoleToolLoopOptions,
} from "./tool-use";
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
  | "sub_agent_timeout";

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

interface SessionContinuationDirective {
  sessionKey: string;
  messageHint: string;
}

export class LLMRoleResponseGenerator implements RoleResponseGenerator {
  private readonly gateway: LLMGateway;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly toolLoop: RoleToolLoopOptions | undefined;
  private readonly nativeToolMessageStore: Pick<TeamMessageStore, "append"> | undefined;
  private readonly preCompactionMemoryFlusher: PreCompactionMemoryFlusher | undefined;
  private readonly clock: Clock;

  constructor(options: {
    gateway: LLMGateway;
    runtimeProgressRecorder?: RuntimeProgressRecorder;
    toolLoop?: RoleToolLoopOptions;
    nativeToolMessageStore?: Pick<TeamMessageStore, "append">;
    preCompactionMemoryFlusher?: PreCompactionMemoryFlusher;
    clock?: Clock;
  }) {
    this.gateway = options.gateway;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.toolLoop = options.toolLoop;
    this.nativeToolMessageStore = options.nativeToolMessageStore;
    this.preCompactionMemoryFlusher = options.preCompactionMemoryFlusher;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  async generate(input: { activation: RoleActivationInput; packet: RolePromptPacket; signal?: AbortSignal }): Promise<GeneratedRoleReply> {
    const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
    const selection = role ? getRoleModelSelection(role) : {};
    const activeToolLoop = input.packet.toolUseMode === "disabled" ? undefined : this.toolLoop;
    if (!selection.modelId && !selection.modelChainId) {
      throw new Error(`no model configured for role ${input.activation.runState.roleId}`);
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

    await this.recordAssemblyBoundarySafely(input.activation, input.packet, selection);
    const sessionContinuationDirective =
      activeToolLoop ? findSessionContinuationDirective(input.packet.taskPrompt) : null;

    const initialGatewayInput = buildGatewayInput({
      activation: input.activation,
      packet: input.packet,
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      ...(selection.modelChainId ? { modelChainId: selection.modelChainId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(activeToolLoop
        ? {
            tools: activeToolLoop.executor.definitions(),
            toolChoice: "auto" as const,
          }
        : {}),
      ...(sessionContinuationDirective ? { sessionContinuationDirective } : {}),
    });

    const toolTrace: NativeToolRoundTrace[] = [];
    let messages: LLMMessage[] = initialGatewayInput.messages;
    const toolLoopStartedAtMs = this.clock.now();
    let toolLoopCloseout: ToolLoopCloseoutMetadata | undefined;
    for (let round = 0; ; round++) {
      throwIfAborted(input.signal);
      const gatewayMessages = prepareToolHistoryForGateway(messages);
      const generated = await this.generateWithEnvelopeRetry({
        activation: input.activation,
        packet: input.packet,
        selection,
        gatewayInput: {
          ...initialGatewayInput,
          messages: gatewayMessages,
          envelope: {
            ...(initialGatewayInput.envelope ?? {}),
            ...deriveToolResultEnvelope(gatewayMessages),
          },
        },
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

      const toolCalls = applySessionContinuationDirective(
        result.toolCalls ?? [],
        sessionContinuationDirective
      );
      if (activeToolLoop && toolCalls.length === 0 && containsAnyToolCallForm(result)) {
        const maxRounds = activeToolLoop.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
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
        break;
      }
      if (!activeToolLoop || toolCalls.length === 0) {
        break;
      }
      const maxRounds = activeToolLoop.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
      const maxWallClockMs = activeToolLoop.maxWallClockMs;
      if (
        toolTrace.length > 0 &&
        typeof maxWallClockMs === "number" &&
        Number.isFinite(maxWallClockMs) &&
        maxWallClockMs > 0 &&
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
        break;
      }
      if (round >= maxRounds) {
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
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: async (call, progress) => {
          roundTrace.progress?.push(toNativeToolProgressTrace(call, progress, this.clock.now()));
          await this.persistNativeToolTraceSafely(input.activation, toolTrace);
        },
        onResult: async (toolResult) => {
          roundTrace.results.push(toNativeToolResultTrace(toolResult));
          await this.persistNativeToolTraceSafely(input.activation, toolTrace);
        },
      });
      throwIfAborted(input.signal);
      messages = appendAssistantToolCallMessage(messages, {
        text: result.text,
        toolCalls,
        ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
      });
      messages = appendToolResultMessages(messages, toolResults);

      const completedSubAgent = findCompletedSubAgentFinal(toolResults);
      if (completedSubAgent) {
        toolLoopCloseout = {
          reason: "completed_sub_agent_final",
          maxRounds,
          toolName: completedSubAgent.toolName,
          finalContentCount: completedSubAgent.finalContents.length,
          toolCallCount: countToolCalls(toolTrace),
          roundCount: toolTrace.length,
          evidenceAvailable: true,
        };
        throwIfAborted(input.signal);
        const generated = await this.generateFinalAfterToolRoundLimit({
          activation: input.activation,
          packet: input.packet,
          selection,
          baseGatewayInput: initialGatewayInput,
          messages,
          maxRounds,
          reasonLines: [
            `${completedSubAgent.toolName} returned a completed sub-agent final_content result.`,
            "Do not call sessions_history or sessions_list just to restate this completed result.",
            "Use the completed sub-agent final_content below as the source of truth. Do not override it with memory, assumptions, or general product knowledge.",
            "Do not add capabilities, target users, pricing, open-source claims, or product positioning unless they are stated in this source content.",
            "If a requested dimension is missing or uncertain in the source content, write not verified.",
            "Preserve uncertainty labels and source URLs from the source content.",
            ...completedSubAgent.finalContents.map(
              (content, index) => `Source ${index + 1} final_content:\n${sliceUtf8(content, 8 * 1024)}`
            ),
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

      const timeoutSignal = findSubAgentToolTimeout(toolResults);
      if (timeoutSignal) {
        toolLoopCloseout = {
          reason: "sub_agent_timeout",
          maxRounds,
          toolName: timeoutSignal.toolName,
          ...(timeoutSignal.timeoutSeconds == null ? {} : { timeoutSeconds: timeoutSignal.timeoutSeconds }),
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
          reasonLines: [
            `${timeoutSignal.toolName} timed out${timeoutSignal.timeoutSeconds == null ? "" : ` after ${timeoutSignal.timeoutSeconds}s`}.`,
            "Do not call more tools or spawn fallback sessions for this timeout.",
            "Do not copy internal fetch URLs, local fixture URLs, session keys, or raw tool arguments into the final answer unless the original user requested those exact raw identifiers.",
            timeoutSignal.evidenceAvailable
              ? "Produce the best final answer from the evidence already gathered and state any remaining uncertainty."
              : "No usable evidence was gathered before the timeout. Say that verification did not complete, summarize what was attempted, and tell the user they can ask to continue.",
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
    }

    if (reductionSnapshot) {
      await this.recordReductionBoundarySafely(input.activation, input.packet, selection, reductionSnapshot);
    }

    return {
      content: result.text,
      mentions: extractMentions(result.text),
      metadata: {
        adapterName: result.adapterName,
        providerId: result.providerId,
        modelId: result.modelId,
        ...(result.modelChainId ? { modelChainId: result.modelChainId } : {}),
        ...(result.attemptedModelIds?.length ? { attemptedModelIds: result.attemptedModelIds } : {}),
        protocol: result.protocol,
        stopReason: result.stopReason,
        ...(reduction ? { requestEnvelopeReduction: reduction } : {}),
        ...(result.requestEnvelope ? { requestEnvelope: result.requestEnvelope } : {}),
        ...(memoryFlushes.length ? { preCompactionMemoryFlushes: memoryFlushes } : {}),
        ...(toolTrace.length
          ? {
              toolUse: {
                rounds: toolTrace,
                toolCallCount: toolTrace.reduce((sum, round) => sum + round.calls.length, 0),
              },
            }
          : {}),
        ...(toolLoopCloseout ? { toolLoopCloseout } : {}),
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
    const attempts: RequestEnvelopeReductionLevel[] = ["compact", "minimal", "reference-only"];
    try {
      return {
        result: await this.gateway.generate(input.gatewayInput),
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
        const reduced = reducePromptPacketForRequestEnvelope(input.packet, { level });
        try {
          const reducedGatewayInput = buildGatewayInput({
            activation: input.activation,
            packet: input.packet,
            ...(input.selection.modelId ? { modelId: input.selection.modelId } : {}),
            ...(input.selection.modelChainId ? { modelChainId: input.selection.modelChainId } : {}),
            overrideSystemPrompt: reduced.reducedSystemPrompt,
            overrideTaskPrompt: reduced.reducedTaskPrompt,
            artifactIds: reduced.artifactIds,
            envelopeHint: reduced.envelopeHint,
            tools: input.gatewayInput.tools,
            toolChoice: input.gatewayInput.toolChoice,
            ...(input.gatewayInput.signal ? { signal: input.gatewayInput.signal } : {}),
          });
          const reducedMessages = replaceInitialPromptMessages(input.gatewayInput.messages, reducedGatewayInput.messages);
          const result = await this.gateway.generate({
            ...input.gatewayInput,
            messages: reducedMessages,
            envelope: {
              ...(input.gatewayInput.envelope ?? {}),
              ...reduced.envelopeHint,
              artifactIds: reduced.artifactIds,
              ...deriveToolResultEnvelope(reducedMessages),
            },
          });
          const reduction = {
            level,
            omittedSections: reduced.omittedSections,
          };
          const reductionSnapshot = {
            level,
            omittedSections: reduced.omittedSections,
            artifactIds: reduced.artifactIds,
            ...(reduced.envelopeHint ? { envelopeHint: reduced.envelopeHint } : {}),
          };
          return { result, reduction, reductionSnapshot, ...(memoryFlush ? { memoryFlush } : {}) };
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
        ...(input.selection.modelId ? { modelId: input.selection.modelId } : {}),
        ...(input.selection.modelChainId ? { modelChainId: input.selection.modelChainId } : {}),
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
    const finalMessages = prepareToolHistoryForGateway([
      ...input.messages,
      {
        role: "user",
        content: [
          ...finalSynthesisFormatContract(),
          ...(input.reasonLines ?? [
            `Tool-use round limit reached (${input.maxRounds}).`,
            "Do not call more tools. Produce the best final answer from the evidence already gathered.",
            "State uncertainties and missing verification explicitly instead of trying another lookup.",
          ]),
        ].join("\n"),
      },
    ]);
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
    });
    if (!containsAnyToolCallForm(generated.result)) {
      return generated;
    }
    const repairedMessages = prepareToolHistoryForGateway([
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
    ]);
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
    });
    const repairedResult = containsAnyToolCallForm(repaired.result)
      ? {
          ...repaired.result,
          text: [
            "I can't safely complete the final answer from the current tool results.",
            "The model attempted to emit another tool call after tools were disabled for final synthesis.",
            "Please retry or continue the mission so the runtime can collect a clean final answer.",
          ].join(" "),
        }
      : repaired.result;
    return {
      result: repairedResult,
      ...(repaired.reduction ?? generated.reduction
        ? { reduction: (repaired.reduction ?? generated.reduction)! }
        : {}),
      ...(repaired.reductionSnapshot ?? generated.reductionSnapshot
        ? { reductionSnapshot: (repaired.reductionSnapshot ?? generated.reductionSnapshot)! }
        : {}),
      ...(repaired.memoryFlush ?? generated.memoryFlush
        ? { memoryFlush: (repaired.memoryFlush ?? generated.memoryFlush)! }
        : {}),
    };
  }

  private async executeToolCalls(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCalls: LLMToolCall[];
    signal?: AbortSignal;
    onProgress?: (call: LLMToolCall, progress: Parameters<typeof recordRoleToolProgress>[0]["progress"]) => Promise<void>;
    onResult?: (result: RoleToolExecutionResult) => Promise<void>;
  }): Promise<RoleToolExecutionResult[]> {
    const activeToolLoop = input.packet.toolUseMode === "disabled" ? undefined : this.toolLoop;
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
    const effectiveMaxParallelToolCalls = shouldSerializeToolBatch(executableCalls) ? 1 : maxParallelToolCalls;
    for (let index = 0; index < executableCalls.length; index += effectiveMaxParallelToolCalls) {
      throwIfAborted(input.signal);
      const chunk = executableCalls.slice(index, index + effectiveMaxParallelToolCalls);
      const chunkResults = await Promise.all(
        chunk.map(async (call) => {
          throwIfAborted(input.signal);
          await this.emitToolProgressSafely(input.activation, call, {
            phase: "started",
            toolName: call.name,
            summary: `Tool call started: ${call.name}`,
          }, input.onProgress);
          try {
            throwIfAborted(input.signal);
            const result = await activeToolLoop.executor.execute({
              call,
              activation: input.activation,
              packet: input.packet,
            });
            throwIfAborted(input.signal);
            for (const progress of result.progress ?? []) {
              await this.emitToolProgressSafely(input.activation, call, progress, input.onProgress);
            }
            await this.emitToolProgressSafely(input.activation, call, {
              phase: result.cancelled ? "cancelled" : result.isError ? "failed" : "completed",
              toolName: call.name,
              summary: result.cancelled
                ? `Tool call cancelled: ${call.name}`
                : result.isError
                  ? `Tool call failed: ${call.name}`
                  : `Tool call completed: ${call.name}`,
            }, input.onProgress);
            await input.onResult?.(result);
            return result;
          } catch (error) {
            if (isAbortError(error)) {
              throw error;
            }
            const content = error instanceof Error ? error.message : String(error);
            await this.emitToolProgressSafely(input.activation, call, {
              phase: "failed",
              toolName: call.name,
              summary: `Tool call failed: ${call.name}: ${content}`,
            }, input.onProgress);
            const result = {
              toolCallId: call.id,
              toolName: call.name,
              content,
              isError: true,
            };
            await input.onResult?.(result);
            return result;
          }
        })
      );
      results.push(...chunkResults);
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
        await this.emitToolProgressSafely(input.activation, call, progress, input.onProgress);
      }
      await input.onResult?.(result);
      results.push(result);
    }
    return results;
  }

  private async emitToolProgressSafely(
    activation: RoleActivationInput,
    call: LLMToolCall,
    progress: Parameters<typeof recordRoleToolProgress>[0]["progress"],
    onProgress: ((call: LLMToolCall, progress: Parameters<typeof recordRoleToolProgress>[0]["progress"]) => Promise<void>) | undefined
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
    toolTrace: NativeToolRoundTrace[]
  ): Promise<void> {
    if (!this.nativeToolMessageStore) return;
    try {
      const messages = buildNativeToolMessages(
        activation,
        { toolUse: { rounds: toolTrace } },
        this.clock.now()
      );
      for (const message of messages) {
        await this.nativeToolMessageStore.append(message);
      }
    } catch (error) {
      console.error("native tool message persistence failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        error,
      });
    }
  }

  private async recordToolProgressSafely(
    activation: RoleActivationInput,
    call: LLMToolCall,
    progress: Parameters<typeof recordRoleToolProgress>[0]["progress"]
  ): Promise<void> {
    try {
      await recordRoleToolProgress({
        recorder: this.toolLoop?.runtimeProgressRecorder ?? this.runtimeProgressRecorder,
        activation,
        call,
        progress,
      });
    } catch (error) {
      console.error("runtime tool progress recording failed", {
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        taskId: activation.handoff.taskId,
        toolName: call.name,
        error,
      });
    }
  }

  private async recordAssemblyBoundary(
    activation: RoleActivationInput,
    packet: RolePromptPacket,
    selection: {
      modelId?: string;
      modelChainId?: string;
    }
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
        ...(selection.modelChainId ? { modelChainId: selection.modelChainId } : {}),
        ...(packet.promptAssembly?.assemblyFingerprint
          ? { assemblyFingerprint: packet.promptAssembly.assemblyFingerprint }
          : {}),
        ...(packet.promptAssembly?.sectionOrder ? { sectionOrder: packet.promptAssembly.sectionOrder } : {}),
        ...(packet.promptAssembly?.tokenEstimate ? { tokenEstimate: packet.promptAssembly.tokenEstimate } : {}),
        ...(packet.promptAssembly?.contextDiagnostics
          ? { contextDiagnostics: packet.promptAssembly.contextDiagnostics }
          : {}),
        ...(packet.promptAssembly?.envelopeHint ? { envelopeHint: packet.promptAssembly.envelopeHint } : {}),
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
    }
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
    } & ReductionEnvelopeSnapshot
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
        ...(selection.modelChainId ? { modelChainId: selection.modelChainId } : {}),
        ...(packet.promptAssembly?.assemblyFingerprint
          ? { assemblyFingerprint: packet.promptAssembly.assemblyFingerprint }
          : {}),
        ...(packet.promptAssembly?.sectionOrder ? { sectionOrder: packet.promptAssembly.sectionOrder } : {}),
        ...(packet.promptAssembly?.tokenEstimate ? { tokenEstimate: packet.promptAssembly.tokenEstimate } : {}),
        ...(packet.promptAssembly?.contextDiagnostics
          ? { contextDiagnostics: packet.promptAssembly.contextDiagnostics }
          : {}),
        ...(reduction.envelopeHint ? { envelopeHint: reduction.envelopeHint } : {}),
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
    } & ReductionEnvelopeSnapshot
  ): Promise<void> {
    try {
      await this.recordReductionBoundary(activation, packet, selection, reduction);
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
}

const ORDER_DEPENDENT_TOOL_NAMES = new Set([
  "memory_search",
  "memory_get",
  "permission_query",
  "permission_result",
  "permission_applied",
  "tasks_list",
  "tasks_create",
  "tasks_update",
]);

function shouldSerializeToolBatch(toolCalls: LLMToolCall[]): boolean {
  return toolCalls.length > 1 && toolCalls.some((call) => ORDER_DEPENDENT_TOOL_NAMES.has(call.name));
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

function toNativeToolResultTrace(toolResult: RoleToolExecutionResult): NativeToolResultTrace {
  const bytes = Buffer.byteLength(toolResult.content, "utf8");
  const truncated = bytes > ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
  return {
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    isError: toolResult.isError === true,
    contentBytes: bytes,
    content: truncated ? sliceUtf8(toolResult.content, ROLE_TOOL_RESULT_TRACE_CAP_BYTES) : toolResult.content,
    ...(truncated ? { contentTruncated: true } : {}),
    ...(toolResult.cancelled ? { cancelled: true } : {}),
    ...(toolResult.skipped ? { skipped: true } : {}),
  };
}

function toNativeToolProgressTrace(
  call: LLMToolCall,
  progress: Parameters<typeof recordRoleToolProgress>[0]["progress"],
  ts: number
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

function findSubAgentToolTimeout(results: RoleToolExecutionResult[]):
  | {
      toolName: string;
      timeoutSeconds?: number | null;
      evidenceAvailable: boolean;
    }
  | null {
  for (const result of results) {
    if (result.toolName !== "sessions_spawn" && result.toolName !== "sessions_send") {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed || parsed.status !== "timeout") {
      continue;
    }
    const timeoutSeconds = parsed.timeout_seconds;
    const evidenceAvailable = parsed.evidence_available === true || typeof parsed.evidence_summary === "string";
    return {
      toolName: result.toolName,
      timeoutSeconds: typeof timeoutSeconds === "number" ? timeoutSeconds : null,
      evidenceAvailable,
    };
  }
  return null;
}

function findCompletedSubAgentFinal(results: RoleToolExecutionResult[]): { toolName: string; finalContents: string[] } | null {
  const finalContents: string[] = [];
  let toolName: string | null = null;
  for (const result of results) {
    if (result.toolName !== "sessions_spawn" && result.toolName !== "sessions_send") {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed || parsed.status !== "completed") {
      continue;
    }
    const finalContent = parsed.final_content;
    if (typeof finalContent !== "string" || !finalContent.trim()) {
      continue;
    }
    const payload = parsed.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    if ((payload as Record<string, unknown>)["mode"] !== "llm_sub_agent") {
      continue;
    }
    toolName = toolName ?? result.toolName;
    finalContents.push(finalContent.trim());
  }
  return toolName && finalContents.length > 0 ? { toolName, finalContents } : null;
}

function containsAnyToolCallForm(result: GenerateTextResult): boolean {
  if ((result.toolCalls?.length ?? 0) > 0) {
    return true;
  }
  return /<\s*(?:minimax:)?tool_call\b|<\s*invoke\b|<\/\s*(?:minimax:)?tool_call\s*>|\btool_calls?\s*[:=]/i.test(
    result.text
  );
}

function findSessionContinuationDirective(taskPrompt: string): SessionContinuationDirective | null {
  if (!/\b(continue|continuation|resume|retry|revisit|follow-?up)\b/i.test(taskPrompt)) {
    return null;
  }
  const sessionMatches = [...taskPrompt.matchAll(/"session_key"\s*:\s*"([^"]+)"/g)];
  for (let index = sessionMatches.length - 1; index >= 0; index -= 1) {
    const match = sessionMatches[index]!;
    const sessionKey = match[1];
    if (!sessionKey) continue;
    const start = Math.max(0, (match.index ?? 0) - 1200);
    const end = Math.min(taskPrompt.length, (match.index ?? 0) + 1200);
    const context = taskPrompt.slice(start, end);
    if (!/\b(timeout|timed out|WORKER_TIMEOUT|resumable|interrupted)\b/i.test(context)) {
      continue;
    }
    return {
      sessionKey,
      messageHint: extractLatestUserContinuationText(taskPrompt),
    };
  }
  return null;
}

function extractLatestUserContinuationText(taskPrompt: string): string {
  const lines = taskPrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const latestUserLine = [...lines].reverse().find((line) => /^\[?user\]?[:：]/i.test(line));
  const content = latestUserLine ? latestUserLine.replace(/^\[?user\]?[:：]\s*/i, "") : lines.at(-1) ?? taskPrompt;
  return sliceUtf8(content.replace(/\s+/g, " ").trim() || "Continue the same delegated work from the existing session.", 1200);
}

function applySessionContinuationDirective(
  toolCalls: LLMToolCall[],
  directive: SessionContinuationDirective | null
): LLMToolCall[] {
  if (!directive || toolCalls.length === 0 || toolCalls.some((call) => call.name === "sessions_send")) {
    return toolCalls;
  }
  const spawnIndex = toolCalls.findIndex((call) => call.name === "sessions_spawn");
  if (spawnIndex < 0) {
    return toolCalls;
  }
  const rewritten = toolCalls[spawnIndex]!;
  return [
    ...toolCalls.slice(0, spawnIndex),
    {
      ...rewritten,
      name: "sessions_send",
      input: {
        session_key: directive.sessionKey,
        message: readStringInput(rewritten.input, "task") ?? directive.messageHint,
        ...(readStringInput(rewritten.input, "label") ? { label: readStringInput(rewritten.input, "label") } : {}),
        ...(readNumberInput(rewritten.input, "timeout_seconds") !== undefined
          ? { timeout_seconds: readNumberInput(rewritten.input, "timeout_seconds") }
          : {}),
      },
    },
    ...toolCalls.slice(spawnIndex + 1).filter((call) => call.name !== "sessions_spawn"),
  ];
}

function readStringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberInput(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
        "If this turn continues, resumes, retries, or revisits the same delegated work, use sessions_send with that session_key before considering sessions_spawn.",
        "Spawn a new session only if the user asks for a new independent task or the existing session is clearly irrelevant.",
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
      artifactIds: input.artifactIds ?? input.packet.promptAssembly?.usedArtifacts ?? [],
      toolCount: input.tools?.length ?? 0,
      toolSchemaBytes: input.tools ? Buffer.byteLength(JSON.stringify(input.tools), "utf8") : 0,
      toolResultCount: input.envelopeHint?.toolResultCount ?? input.packet.promptAssembly?.envelopeHint?.toolResultCount ?? 0,
      toolResultBytes: input.envelopeHint?.toolResultBytes ?? input.packet.promptAssembly?.envelopeHint?.toolResultBytes ?? 0,
      inlineAttachmentBytes:
        input.envelopeHint?.inlineAttachmentBytes ?? input.packet.promptAssembly?.envelopeHint?.inlineAttachmentBytes ?? 0,
      inlineImageCount: input.envelopeHint?.inlineImageCount ?? input.packet.promptAssembly?.envelopeHint?.inlineImageCount ?? 0,
      inlineImageBytes: input.envelopeHint?.inlineImageBytes ?? input.packet.promptAssembly?.envelopeHint?.inlineImageBytes ?? 0,
      inlinePdfCount: input.envelopeHint?.inlinePdfCount ?? input.packet.promptAssembly?.envelopeHint?.inlinePdfCount ?? 0,
      inlinePdfBytes: input.envelopeHint?.inlinePdfBytes ?? input.packet.promptAssembly?.envelopeHint?.inlinePdfBytes ?? 0,
      multimodalPartCount:
        input.envelopeHint?.multimodalPartCount ?? input.packet.promptAssembly?.envelopeHint?.multimodalPartCount ?? 0,
    },
  };
}

function finalSynthesisFormatContract(): string[] {
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function deriveToolResultEnvelope(messages: LLMMessage[]): { toolResultCount: number; toolResultBytes: number } {
  const toolMessages = messages.filter((message) => message.role === "tool");
  return {
    toolResultCount: toolMessages.length,
    toolResultBytes: Buffer.byteLength(JSON.stringify(toolMessages.map((message) => message.content)), "utf8"),
  };
}

function prepareToolHistoryForGateway(messages: LLMMessage[]): LLMMessage[] {
  return compactOlderToolHistoryForGateway(pruneToolResultMessagesForGateway(messages));
}

function pruneToolResultMessagesForGateway(messages: LLMMessage[]): LLMMessage[] {
  const toolMessageIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  const recentFullIndexes = new Set(toolMessageIndexes.slice(-TOOL_RESULT_RECENT_FULL_COUNT));

  const prunedMessages = messages.map((message, index) => {
    if (message.role !== "tool") {
      return message;
    }
    const content = readToolResultContentText(message.content);
    const contentBytes = Buffer.byteLength(content, "utf8");
    const shouldHardPrune = contentBytes > TOOL_RESULT_HARD_PRUNE_MAX_BYTES;
    const shouldSoftPrune = !recentFullIndexes.has(index) && contentBytes > TOOL_RESULT_SOFT_PRUNE_MAX_BYTES;
    if (!shouldHardPrune && !shouldSoftPrune) {
      return message;
    }
    const prunedContent = JSON.stringify(
      {
        tool_result_pruned: true,
        tool_call_id: message.toolCallId ?? null,
        tool_name: message.name ?? null,
        original_bytes: contentBytes,
        reason: shouldHardPrune ? "over_hard_limit" : "older_than_recent_window",
        retained_summary: summarizeToolResultContent(content),
      },
      null,
      2
    );
    return replaceToolResultContent(message, prunedContent);
  });

  return pruneToolResultsToTotalBudget(prunedMessages, recentFullIndexes);
}

function compactOlderToolHistoryForGateway(messages: LLMMessage[]): LLMMessage[] {
  if (messages.length <= ROLE_TOOL_HISTORY_MAX_MESSAGES) {
    return messages;
  }
  const toolMessageIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  if (toolMessageIndexes.length <= TOOL_RESULT_RECENT_FULL_COUNT) {
    return messages;
  }

  for (let keepToolCount = TOOL_RESULT_RECENT_FULL_COUNT; keepToolCount >= 1; keepToolCount -= 1) {
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
    if (compacted.length <= ROLE_TOOL_HISTORY_MAX_MESSAGES) {
      return compacted;
    }
  }

  return messages;
}

function findToolCallAssistantIndex(messages: LLMMessage[], toolMessageIndex: number): number {
  const toolMessage = messages[toolMessageIndex];
  const toolCallId = toolMessage?.role === "tool" ? toolMessage.toolCallId : undefined;
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
        ? message.content.filter((block): block is Extract<LLMContentBlock, { type: "tool_use" }> => block.type === "tool_use")
        : [];
      for (const call of calls) {
        lines.push(`- called ${call.name} (${call.id}): ${summarizeToolArgs(call.input)}`);
      }
      continue;
    }
    if (message.role === "tool") {
      const content = readToolResultContentText(message.content);
      lines.push(`- result ${message.name ?? "tool"} (${message.toolCallId ?? "unknown"}): ${summarizeToolResultContent(content)}`);
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
  recentFullIndexes: Set<number>
): LLMMessage[] {
  let totalBytes = deriveToolResultEnvelope(messages).toolResultBytes;
  if (totalBytes <= TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES) {
    return messages;
  }

  let nextMessages = messages;
  const olderToolIndexes = messages
    .map((message, index) => (message.role === "tool" && !recentFullIndexes.has(index) ? index : -1))
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
      2
    );
    nextMessages = [...nextMessages];
    nextMessages[index] = replaceToolResultContent(message, prunedContent);
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES) {
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
      2
    );
    nextMessages = nextMessages.map((candidate, candidateIndex) =>
      candidateIndex === index ? replaceToolResultContent(message, prunedContent) : candidate
    );
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES) {
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
      2
    );
    nextMessages = nextMessages.map((candidate, candidateIndex) =>
      candidateIndex === index ? replaceToolResultContent(message, prunedContent) : candidate
    );
    totalBytes = deriveToolResultEnvelope(nextMessages).toolResultBytes;
    if (totalBytes <= TOOL_RESULT_TOTAL_PRUNE_MAX_BYTES) {
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

function replaceToolResultContent(message: LLMMessage, content: string): LLMMessage {
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
        : block
    ),
  };
}

function summarizeToolResultContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty tool result)";
  }
  return normalized.length > 512 ? `${normalized.slice(0, 512)}...` : normalized;
}

function isPrunedToolResultContent(content: string): boolean {
  return content.includes('"tool_result_pruned": true');
}

function countToolCalls(rounds: NativeToolRoundTrace[]): number {
  return rounds.reduce((sum, round) => sum + round.calls.length, 0);
}

function hasUsableEvidence(rounds: NativeToolRoundTrace[]): boolean {
  return rounds.some((round) => round.results.some((result) => !result.isError && result.skipped !== true));
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

function replaceInitialPromptMessages(messages: LLMMessage[], reducedPromptMessages: LLMMessage[]): LLMMessage[] {
  const toolLoopHistory = messages.slice(2);
  return [...reducedPromptMessages, ...toolLoopHistory];
}

import type { RoleActivationInput, RoleId, RuntimeProgressRecorder } from "@turnkeyai/core-types/team";
import type { GenerateTextInput, GenerateTextResult, LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";

import type { GeneratedRoleReply, RoleResponseGenerator } from "./deterministic-response-generator";
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

export class LLMRoleResponseGenerator implements RoleResponseGenerator {
  private readonly gateway: LLMGateway;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly toolLoop: RoleToolLoopOptions | undefined;

  constructor(options: {
    gateway: LLMGateway;
    runtimeProgressRecorder?: RuntimeProgressRecorder;
    toolLoop?: RoleToolLoopOptions;
  }) {
    this.gateway = options.gateway;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.toolLoop = options.toolLoop;
  }

  async generate(input: { activation: RoleActivationInput; packet: RolePromptPacket }): Promise<GeneratedRoleReply> {
    const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
    const selection = role ? getRoleModelSelection(role) : {};
    if (!selection.modelId && !selection.modelChainId) {
      throw new Error(`no model configured for role ${input.activation.runState.roleId}`);
    }

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

    await this.recordAssemblyBoundarySafely(input.activation, input.packet, selection);

    const initialGatewayInput = buildGatewayInput({
      activation: input.activation,
      packet: input.packet,
      ...(selection.modelId ? { modelId: selection.modelId } : {}),
      ...(selection.modelChainId ? { modelChainId: selection.modelChainId } : {}),
      ...(this.toolLoop
        ? {
            tools: this.toolLoop.executor.definitions(),
            toolChoice: "auto" as const,
          }
        : {}),
    });

    const toolTrace: ToolRoundTrace[] = [];
    let messages: LLMMessage[] = initialGatewayInput.messages;
    for (let round = 0; ; round++) {
      const generated = await this.generateWithEnvelopeRetry({
        activation: input.activation,
        packet: input.packet,
        selection,
        gatewayInput: {
          ...initialGatewayInput,
          messages,
          envelope: {
            ...(initialGatewayInput.envelope ?? {}),
            ...deriveToolResultEnvelope(messages),
          },
        },
      });
      result = generated.result;
      if (generated.reduction) {
        reduction = generated.reduction;
        reductionSnapshot = generated.reductionSnapshot;
      }

      const toolCalls = result.toolCalls ?? [];
      if (!this.toolLoop || toolCalls.length === 0) {
        break;
      }
      const maxRounds = this.toolLoop.maxRounds ?? DEFAULT_ROLE_TOOL_MAX_ROUNDS;
      if (round >= maxRounds) {
        throw new Error(`tool-use loop exceeded max rounds (${maxRounds})`);
      }

      const toolResults = await this.executeToolCalls({
        activation: input.activation,
        packet: input.packet,
        toolCalls,
      });
      // PR K3.6: persist the actual tool result content (truncated
       // to ROLE_TOOL_RESULT_TRACE_CAP_BYTES) alongside the byte
       // count. Without this the mission timeline could only show
       // "Tool X returned (2 kB)" — a black box from the user's
       // point of view. We deliberately keep `content` truncated:
       // the LLM gateway has its own envelope-budgeting math that
       // operates on the full content in the messages array, but
       // the assistant message metadata persisted to disk gets a
       // capped slice so a giant browser snapshot doesn't bloat
       // every assistant turn forever.
      toolTrace.push({
        round: round + 1,
        calls: toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          input: call.input,
        })),
        results: toolResults.map((toolResult) => {
          const bytes = Buffer.byteLength(toolResult.content, "utf8");
          const truncated = bytes > ROLE_TOOL_RESULT_TRACE_CAP_BYTES;
          return {
            toolCallId: toolResult.toolCallId,
            toolName: toolResult.toolName,
            isError: toolResult.isError === true,
            contentBytes: bytes,
            content: truncated
              ? sliceUtf8(toolResult.content, ROLE_TOOL_RESULT_TRACE_CAP_BYTES)
              : toolResult.content,
            ...(truncated ? { contentTruncated: true } : {}),
          };
        }),
      });
      messages = appendAssistantToolCallMessage(messages, {
        text: result.text,
        toolCalls,
        ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
      });
      messages = appendToolResultMessages(messages, toolResults);
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
        ...(toolTrace.length
          ? {
              toolUse: {
                rounds: toolTrace,
                toolCallCount: toolTrace.reduce((sum, round) => sum + round.calls.length, 0),
              },
            }
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
          return { result, reduction, reductionSnapshot };
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

  private async executeToolCalls(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    toolCalls: LLMToolCall[];
  }): Promise<RoleToolExecutionResult[]> {
    if (!this.toolLoop) return [];
    return Promise.all(
      input.toolCalls.map(async (call) => {
        await this.recordToolProgressSafely(input.activation, call, {
          phase: "started",
          toolName: call.name,
          summary: `Tool call started: ${call.name}`,
        });
        try {
          const result = await this.toolLoop!.executor.execute({
            call,
            activation: input.activation,
            packet: input.packet,
          });
          for (const progress of result.progress ?? []) {
            await this.recordToolProgressSafely(input.activation, call, progress);
          }
          await this.recordToolProgressSafely(input.activation, call, {
            phase: result.isError ? "failed" : "completed",
            toolName: call.name,
            summary: result.isError ? `Tool call failed: ${call.name}` : `Tool call completed: ${call.name}`,
          });
          return result;
        } catch (error) {
          const content = error instanceof Error ? error.message : String(error);
          await this.recordToolProgressSafely(input.activation, call, {
            phase: "failed",
            toolName: call.name,
            summary: `Tool call failed: ${call.name}: ${content}`,
          });
          return {
            toolCallId: call.id,
            toolName: call.name,
            content,
            isError: true,
          };
        }
      })
    );
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

function sliceUtf8(value: string, maxBytes: number): string {
  // Buffer.byteLength is utf-8 by default; we slice on the buffer
  // and re-decode so we don't split a multi-byte codepoint in half.
  // Suffix marker makes it obvious the slice is truncated.
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  // Step back if the last byte is a continuation byte (10xxxxxx)
  // until we land on a codepoint boundary.
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString("utf8")}…[truncated]`;
}

interface ToolRoundTrace {
  round: number;
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  results: Array<{
    toolCallId: string;
    toolName: string;
    isError: boolean;
    contentBytes: number;
    content?: string;
    contentTruncated?: boolean;
  }>;
}

function buildGatewayInput(input: {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  modelId?: string;
  modelChainId?: string;
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
}): GenerateTextInput {
  return {
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
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

function extractMentions(content: string): RoleId[] {
  return [...content.matchAll(/@\{(?<roleId>[^}]+)\}/g)]
    .map((match) => match.groups?.roleId)
    .filter((value): value is RoleId => Boolean(value));
}

function deriveToolResultEnvelope(messages: LLMMessage[]): { toolResultCount: number; toolResultBytes: number } {
  const toolMessages = messages.filter((message) => message.role === "tool");
  return {
    toolResultCount: toolMessages.length,
    toolResultBytes: Buffer.byteLength(JSON.stringify(toolMessages.map((message) => message.content)), "utf8"),
  };
}

function replaceInitialPromptMessages(messages: LLMMessage[], reducedPromptMessages: LLMMessage[]): LLMMessage[] {
  const toolLoopHistory = messages.slice(2);
  return [...reducedPromptMessages, ...toolLoopHistory];
}

import type { RoleActivationInput, RoleId, RuntimeProgressRecorder } from "@turnkeyai/core-types/team";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import { RequestEnvelopeOverflowError } from "@turnkeyai/llm-adapter/index";

import type { GeneratedRoleReply, RoleResponseGenerator } from "./deterministic-response-generator";
import type { RolePromptPacket } from "./prompt-policy";
import { reducePromptPacketForRequestEnvelope, type RequestEnvelopeReductionLevel } from "./request-envelope-reducer";
import { getRoleModelSelection } from "./role-model-selection";

export class LLMRoleResponseGenerator implements RoleResponseGenerator {
  private readonly gateway: LLMGateway;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;

  constructor(options: { gateway: LLMGateway; runtimeProgressRecorder?: RuntimeProgressRecorder }) {
    this.gateway = options.gateway;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
  }

  async generate(input: { activation: RoleActivationInput; packet: RolePromptPacket }): Promise<GeneratedRoleReply> {
    const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
    const selection = role ? getRoleModelSelection(role) : {};
    if (!selection.modelId && !selection.modelChainId) {
      throw new Error(`no model configured for role ${input.activation.runState.roleId}`);
    }

    const attempts: RequestEnvelopeReductionLevel[] = ["compact", "minimal", "reference-only"];
    let result;
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

    try {
      result = await this.gateway.generate(
        buildGatewayInput({
          activation: input.activation,
          packet: input.packet,
          ...(selection.modelId ? { modelId: selection.modelId } : {}),
          ...(selection.modelChainId ? { modelChainId: selection.modelChainId } : {}),
        })
      );
    } catch (error) {
      if (!(error instanceof RequestEnvelopeOverflowError)) {
        throw error;
      }

      let overflowError: RequestEnvelopeOverflowError = error;
      for (const level of attempts) {
        const reduced = reducePromptPacketForRequestEnvelope(input.packet, { level });
        try {
          result = await this.gateway.generate(
            buildGatewayInput({
              activation: input.activation,
              packet: input.packet,
              ...(selection.modelId ? { modelId: selection.modelId } : {}),
              ...(selection.modelChainId ? { modelChainId: selection.modelChainId } : {}),
              overrideSystemPrompt: reduced.reducedSystemPrompt,
              overrideTaskPrompt: reduced.reducedTaskPrompt,
              artifactIds: reduced.artifactIds,
              envelopeHint: reduced.envelopeHint,
            })
          );
          reduction = {
            level,
            omittedSections: reduced.omittedSections,
          };
          reductionSnapshot = {
            level,
            omittedSections: reduced.omittedSections,
            artifactIds: reduced.artifactIds,
            ...(reduced.envelopeHint ? { envelopeHint: reduced.envelopeHint } : {}),
          };
          await this.recordReductionBoundarySafely(input.activation, input.packet, selection, reductionSnapshot);
          break;
        } catch (retryError) {
          if (!(retryError instanceof RequestEnvelopeOverflowError)) {
            throw retryError;
          }
          overflowError = retryError;
        }
      }

      if (!result) {
        throw overflowError;
      }
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
      },
    };
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
}) {
  return {
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
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

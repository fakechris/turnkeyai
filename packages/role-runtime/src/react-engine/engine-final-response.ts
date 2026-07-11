import type {
  RoleActivationInput,
  RuntimeProgressRecorder,
} from "@turnkeyai/core-types/team";
import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { GeneratedRoleReply } from "../deterministic-response-generator";
import {
  enforceRequestedThreeLineLabelShape,
  extractMentions,
} from "../gateway-input-builder";
import {
  summarizeModelUseTrace,
  type ModelCallBoundaryTrace,
} from "../model-call-trace";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { PreCompactionMemoryFlushResult } from "../pre-compaction-memory-flusher";
import {
  recordReductionBoundarySafely,
  type RequestEnvelopeReductionLevel,
  type RequestEnvelopeReductionSnapshot,
} from "../request-envelope-reducer";
import {
  buildRuntimeDerivedMissionReport,
  type ToolLoopCloseoutMetadata,
} from "../runtime-derived-mission-report";
import { finalizeEngineAnswer } from "./finalization-pipeline";
import {
  buildEngineRunReplaySeed,
  buildRunTrace,
  type BuildRunTraceInput,
  type EngineRunReplaySeed,
} from "./run-trace";
import type { EnginePolicyTrace } from "./types";
import type { RolePromptPacket } from "../prompt-policy";

export interface EngineFinalResponseReduction {
  level: RequestEnvelopeReductionLevel;
  omittedSections: string[];
}

export interface CreateEngineFinalResponseBuilderInput {
  taskPrompt: string;
  initialMessages: readonly LLMMessage[];
  readToolTraceResultContent(messages: LLMMessage[]): string;
  policyTrace: EnginePolicyTrace;
  enginePolicyTraceDebugEnabled: () => boolean;
}

export interface EngineFinalResponseInput {
  finalText: string;
  closeoutResult?: GenerateTextResult | undefined;
  lastModelResult?: GenerateTextResult | undefined;
  finalMessages?: readonly LLMMessage[] | undefined;
  toolTrace: NativeToolRoundTrace[];
  modelCallTrace: ModelCallBoundaryTrace[];
  reduction?: EngineFinalResponseReduction | undefined;
  memoryFlushes: readonly PreCompactionMemoryFlushResult[];
  toolLoopCloseout?: ToolLoopCloseoutMetadata | undefined;
  runTrace?: Omit<BuildRunTraceInput, "finalText"> | undefined;
  runReplay?: Omit<
    Parameters<typeof buildEngineRunReplaySeed>[0],
    "finalText"
  > | undefined;
}

export interface EngineReductionBoundaryInput {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  selection: {
    modelId?: string | undefined;
    modelChainId?: string | undefined;
  };
  reduction?: RequestEnvelopeReductionSnapshot | undefined;
}

export type EngineFinalResponseBuilder = (
  input: EngineFinalResponseInput,
) => GeneratedRoleReply;

export async function recordEngineReductionBoundary(
  input: EngineReductionBoundaryInput,
): Promise<void> {
  if (!input.reduction) {
    return;
  }
  await recordReductionBoundarySafely({
    activation: input.activation,
    packet: input.packet,
    runtimeProgressRecorder: input.runtimeProgressRecorder,
    selection: input.selection,
    reduction: input.reduction,
  });
}

export function createEngineFinalResponseBuilder(
  input: CreateEngineFinalResponseBuilderInput,
): EngineFinalResponseBuilder {
  return (responseInput) => {
    const epilogueMessages = [
      ...(responseInput.finalMessages ?? input.initialMessages),
    ];
    const closeoutResult = responseInput.closeoutResult;
    const lastModelResult = responseInput.lastModelResult;
    let finalResult: GenerateTextResult = {
      ...(closeoutResult ?? lastModelResult ?? {}),
      text: responseInput.finalText,
    } as GenerateTextResult;
    finalResult = finalizeEngineAnswer({
      result: finalResult,
      taskPrompt: input.taskPrompt,
      messages: epilogueMessages,
      toolTrace: responseInput.toolTrace,
      evidenceText: input.readToolTraceResultContent(epilogueMessages),
    });
    const content = enforceRequestedThreeLineLabelShape({
      taskPrompt: input.taskPrompt,
      resultText: finalResult.text,
    });
    const metaResult = closeoutResult ?? lastModelResult;
    const missionReport = buildRuntimeDerivedMissionReport(
      responseInput.toolLoopCloseout,
    );
    const runTrace = responseInput.runTrace
      ? buildRunTrace({ ...responseInput.runTrace, finalText: content })
      : undefined;
    const engineRunReplay: EngineRunReplaySeed | undefined =
      responseInput.runReplay
        ? buildEngineRunReplaySeed({
            ...responseInput.runReplay,
            finalText: content,
          })
        : undefined;
    return {
      content,
      mentions: extractMentions(content),
      metadata: {
        ...(metaResult
          ? {
              adapterName: metaResult.adapterName,
              providerId: metaResult.providerId,
              modelId: metaResult.modelId,
              ...(metaResult.modelChainId
                ? { modelChainId: metaResult.modelChainId }
                : {}),
              protocol: metaResult.protocol,
              stopReason: metaResult.stopReason,
            }
          : {}),
        ...(responseInput.toolTrace.length
          ? {
              toolUse: {
                rounds: responseInput.toolTrace,
                toolCallCount: responseInput.toolTrace.reduce(
                  (sum, round) => sum + round.calls.length,
                  0,
                ),
              },
            }
          : {}),
        ...(responseInput.modelCallTrace.length
          ? { modelUse: summarizeModelUseTrace(responseInput.modelCallTrace) }
          : {}),
        ...(responseInput.reduction
          ? { requestEnvelopeReduction: responseInput.reduction }
          : {}),
        ...(responseInput.memoryFlushes.length
          ? { preCompactionMemoryFlushes: responseInput.memoryFlushes }
          : {}),
        ...(responseInput.toolLoopCloseout
          ? { toolLoopCloseout: responseInput.toolLoopCloseout }
          : {}),
        ...(missionReport ? { missionReport } : {}),
        ...(runTrace ? { runTrace } : {}),
        ...(engineRunReplay ? { engineRunReplay } : {}),
        reactEngine: true,
        ...(input.enginePolicyTraceDebugEnabled()
          ? { enginePolicyTrace: input.policyTrace.snapshot() }
          : {}),
      },
    };
  };
}

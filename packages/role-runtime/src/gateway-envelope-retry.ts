import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import {
  RequestEnvelopeOverflowError,
  type GenerateTextInput,
  type GenerateTextResult,
} from "@turnkeyai/llm-adapter/index";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { buildReducedRetryGatewayInput } from "./gateway-input-builder";
import {
  appendModelCallBoundary,
  type ModelCallBoundaryTrace,
} from "./model-call-trace";
import {
  flushPreCompactionMemorySafely,
  type PreCompactionMemoryFlusher,
  type PreCompactionMemoryFlushResult,
} from "./pre-compaction-memory-flusher";
import type { RolePromptPacket } from "./prompt-policy";
import {
  reducePromptPacketForRequestEnvelope,
  type RequestEnvelopeReductionLevel,
  type RequestEnvelopeReductionSnapshot,
} from "./request-envelope-reducer";

export interface GenerateWithEnvelopeRetryInput {
  gateway: LLMGateway;
  now: () => number;
  preCompactionMemoryFlusher?: PreCompactionMemoryFlusher | undefined;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  gatewayInput: GenerateTextInput;
  modelCallTrace?: ModelCallBoundaryTrace[] | undefined;
  tracePhase?: ModelCallBoundaryTrace["phase"] | undefined;
  traceRound?: number | undefined;
}

export interface GenerateWithEnvelopeRetryResult {
  result: GenerateTextResult;
  reduction?: {
    level: RequestEnvelopeReductionLevel;
    omittedSections: string[];
  };
  reductionSnapshot?: RequestEnvelopeReductionSnapshot;
  memoryFlush?: PreCompactionMemoryFlushResult;
}

export async function generateWithEnvelopeRetry(
  input: GenerateWithEnvelopeRetryInput,
): Promise<GenerateWithEnvelopeRetryResult> {
  const attempts: RequestEnvelopeReductionLevel[] = [
    "compact",
    "minimal",
    "reference-only",
  ];
  try {
    const startedAt = input.now();
    const result = await input.gateway.generate(input.gatewayInput);
    appendModelCallBoundary(input.modelCallTrace, {
      phase: input.tracePhase ?? "tool_round",
      ...(input.traceRound !== undefined ? { round: input.traceRound } : {}),
      startedAt,
      completedAt: input.now(),
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
      flusher: input.preCompactionMemoryFlusher,
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
        const startedAt = input.now();
        const result = await input.gateway.generate(retryGatewayInput);
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
          ...(input.traceRound !== undefined ? { round: input.traceRound } : {}),
          startedAt,
          completedAt: input.now(),
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

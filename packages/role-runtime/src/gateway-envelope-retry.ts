import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import {
  RequestEnvelopeOverflowError,
  type GenerateTextInput,
  type GenerateTextResult,
  type LLMMessage,
  type ProviderLifecycleEvent,
  type RequestEnvelopeDiagnostics,
} from "@turnkeyai/llm-adapter/index";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import {
  buildForcedCompactionGatewayInput,
  buildReducedRetryGatewayInput,
} from "./gateway-input-builder";
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
import type { RunLifecycleRecorder } from "./react-engine/run-lifecycle";
import {
  reducePromptPacketForRequestEnvelope,
  type RequestEnvelopeReductionLevel,
  type RequestEnvelopeReductionSnapshot,
} from "./request-envelope-reducer";

export interface GenerateWithEnvelopeRetryInput {
  gateway: LLMGateway;
  now: () => number;
  preCompactionMemoryFlusher?: PreCompactionMemoryFlusher | undefined;
  forceCompact?:
    | ((input: {
        messages: LLMMessage[];
        diagnostics: RequestEnvelopeDiagnostics;
      }) => Promise<{ messages: LLMMessage[] }>)
    | undefined;
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
  lifecycle?: RunLifecycleRecorder | undefined;
}

export interface GenerateWithEnvelopeRetryResult {
  result: GenerateTextResult;
  reduction?: {
    level: RequestEnvelopeReductionLevel;
    omittedSections: string[];
  };
  reductionSnapshot?: RequestEnvelopeReductionSnapshot;
  memoryFlush?: PreCompactionMemoryFlushResult;
  forcedCompaction?: {
    messageCountBefore: number;
    messageCountAfter: number;
  };
}

export async function generateWithEnvelopeRetry(
  input: GenerateWithEnvelopeRetryInput,
): Promise<GenerateWithEnvelopeRetryResult> {
  const attempts: RequestEnvelopeReductionLevel[] = [
    "compact",
    "minimal",
    "reference-only",
  ];
  const generate = (gatewayInput: GenerateTextInput) =>
    input.gateway.generate(
      attachRunLifecycleToGatewayInput({
        gatewayInput,
        lifecycle: input.lifecycle,
        phase: input.tracePhase ?? "tool_round",
        ...(input.traceRound === undefined ? {} : { round: input.traceRound }),
      }),
    );
  try {
    const startedAt = input.now();
    const result = await generate(input.gatewayInput);
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
    if (input.forceCompact) {
      let forced: { messages: LLMMessage[] } | undefined;
      try {
        forced = await input.forceCompact({
          messages: input.gatewayInput.messages,
          diagnostics: overflowError.details.diagnostics,
        });
      } catch {
        // Forced compaction is best-effort; the reduction ladder remains the
        // final request-envelope recovery path.
      }
      if (forced && forced.messages !== input.gatewayInput.messages) {
        const retryGatewayInput = buildForcedCompactionGatewayInput({
          gatewayInput: input.gatewayInput,
          messages: forced.messages,
        });
        try {
          const startedAt = input.now();
          const result = await generate(retryGatewayInput);
          appendModelCallBoundary(input.modelCallTrace, {
            phase: input.tracePhase ?? "tool_round",
            ...(input.traceRound !== undefined
              ? { round: input.traceRound }
              : {}),
            startedAt,
            completedAt: input.now(),
            gatewayInput: retryGatewayInput,
            result,
          });
          return {
            result,
            ...(memoryFlush ? { memoryFlush } : {}),
            forcedCompaction: {
              messageCountBefore: input.gatewayInput.messages.length,
              messageCountAfter: forced.messages.length,
            },
          };
        } catch (retryError) {
          if (!(retryError instanceof RequestEnvelopeOverflowError)) {
            throw retryError;
          }
          overflowError = retryError;
        }
      }
    }
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
        const result = await generate(retryGatewayInput);
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

export function attachRunLifecycleToGatewayInput(input: {
  gatewayInput: GenerateTextInput;
  lifecycle: RunLifecycleRecorder | undefined;
  phase: ModelCallBoundaryTrace["phase"];
  round?: number;
}): GenerateTextInput {
  if (!input.lifecycle) return input.gatewayInput;
  const existing = input.gatewayInput.onProviderLifecycle;
  const attemptScope = input.lifecycle.allocateModelCall(
    input.phase,
    input.round,
  );
  return {
    ...input.gatewayInput,
    async onProviderLifecycle(event) {
      try {
        await existing?.(event);
      } catch {
        // Observability callbacks are behavior-neutral.
      }
      await input.lifecycle!.record(
        toRunLifecycleEvent({
          event,
          phase: input.phase,
          ...(input.round === undefined ? {} : { round: input.round }),
          attemptScope,
        }),
      );
    },
  };
}

function toRunLifecycleEvent(input: {
  event: ProviderLifecycleEvent;
  phase: ModelCallBoundaryTrace["phase"];
  round?: number;
  attemptScope: string;
}): Parameters<RunLifecycleRecorder["record"]>[0] {
  const attemptId = `${input.attemptScope}:${input.event.attempt}`;
  switch (input.event.kind) {
    case "attempt_started":
      return {
        kind: "model_attempt_started",
        at: input.event.at,
        attemptId,
        phase: input.phase,
        ...(input.round === undefined ? {} : { round: input.round }),
      };
    case "activity":
      return {
        kind: "provider_activity",
        at: input.event.at,
        attemptId,
        activity: input.event.activity,
      };
    case "attempt_failed":
      return {
        kind: "model_attempt_failed",
        at: input.event.at,
        attemptId,
        code: input.event.code,
        message: input.event.message,
      };
    case "retry_wait":
      return {
        kind: "model_retry_wait",
        at: input.event.at,
        attemptId,
        retry: input.event.retry,
        delayMs: input.event.delayMs,
        code: input.event.code,
      };
    case "attempt_completed":
      return {
        kind: "model_attempt_completed",
        at: input.event.at,
        attemptId,
      };
  }
}

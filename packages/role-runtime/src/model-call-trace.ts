import type {
  GenerateTextInput,
  GenerateTextResult,
} from "@turnkeyai/llm-adapter/index";

import type { RequestEnvelopeReductionLevel } from "./request-envelope-reducer";

export interface ModelCallBoundaryTrace {
  index: number;
  phase:
    | "tool_round"
    | "checkpoint_compaction"
    | "final_synthesis"
    | "final_synthesis_repair";
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
  usage?: NonNullable<GenerateTextResult["usage"]>;
  retryDiagnostics?: GenerateTextResult["retryDiagnostics"];
  requestEnvelope?: GenerateTextResult["requestEnvelope"];
  reductionLevel?: RequestEnvelopeReductionLevel;
  replayResponse?: ModelCallReplayResponse;
}

export interface ModelCallReplayResponse {
  text: string;
  contentBlocks?: NonNullable<GenerateTextResult["contentBlocks"]>;
  toolCalls?: NonNullable<GenerateTextResult["toolCalls"]>;
  modelId: string;
  modelChainId?: string;
  providerId: string;
  protocol: GenerateTextResult["protocol"];
  adapterName: string;
  attemptedModelIds?: string[];
  stopReason?: string;
  usage?: NonNullable<GenerateTextResult["usage"]>;
  requestEnvelope?: NonNullable<GenerateTextResult["requestEnvelope"]>;
  retryDiagnostics?: NonNullable<GenerateTextResult["retryDiagnostics"]>;
}

export function appendModelCallBoundary(
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
    ...(input.result.retryDiagnostics
      ? { retryDiagnostics: input.result.retryDiagnostics }
      : {}),
    ...(input.result.requestEnvelope
      ? { requestEnvelope: input.result.requestEnvelope }
      : {}),
    ...(input.reductionLevel ? { reductionLevel: input.reductionLevel } : {}),
    replayResponse: toModelCallReplayResponse(input.result),
  };
  trace.push(boundary);
}

export function summarizeModelUseTrace(
  trace: ModelCallBoundaryTrace[],
): Record<string, unknown> {
  const totalInputTokens = sumModelUseTokens(trace, "inputTokens");
  const totalUncachedInputTokens = sumModelUseTokens(trace, "uncachedInputTokens");
  const totalCacheReadInputTokens = sumModelUseTokens(trace, "cacheReadInputTokens");
  const totalCacheCreationInputTokens = sumModelUseTokens(
    trace,
    "cacheCreationInputTokens",
  );
  const totalOutputTokens = sumModelUseTokens(trace, "outputTokens");
  const cacheHitCalls = trace.filter((boundary) => {
    const value = boundary.usage?.cacheReadInputTokens;
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }).length;
  return {
    calls: trace.map(({ replayResponse: _replayResponse, ...boundary }) =>
      boundary
    ),
    callCount: trace.length,
    source: "turnkeyai-role-runtime",
    ...(totalInputTokens !== null ? { totalInputTokens } : {}),
    ...(totalUncachedInputTokens !== null ? { totalUncachedInputTokens } : {}),
    ...(totalCacheReadInputTokens !== null ? { totalCacheReadInputTokens } : {}),
    ...(totalCacheCreationInputTokens !== null
      ? { totalCacheCreationInputTokens }
      : {}),
    ...(totalOutputTokens !== null ? { totalOutputTokens } : {}),
    ...(trace.length > 0 ? { cacheHitCalls } : {}),
  };
}

function toModelCallReplayResponse(
  result: GenerateTextResult,
): ModelCallReplayResponse {
  return {
    text: result.text,
    ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
    ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    modelId: result.modelId,
    ...(result.modelChainId ? { modelChainId: result.modelChainId } : {}),
    providerId: result.providerId,
    protocol: result.protocol,
    adapterName: result.adapterName,
    ...(result.attemptedModelIds
      ? { attemptedModelIds: result.attemptedModelIds }
      : {}),
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.requestEnvelope
      ? { requestEnvelope: result.requestEnvelope }
      : {}),
    ...(result.retryDiagnostics
      ? { retryDiagnostics: result.retryDiagnostics }
      : {}),
  };
}

function sumModelUseTokens(
  trace: ModelCallBoundaryTrace[],
  key:
    | "inputTokens"
    | "uncachedInputTokens"
    | "cacheReadInputTokens"
    | "cacheCreationInputTokens"
    | "outputTokens",
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

import type {
  GenerateTextInput,
  GenerateTextResult,
} from "@turnkeyai/llm-adapter/index";

import type { RequestEnvelopeReductionLevel } from "./request-envelope-reducer";

export interface ModelCallBoundaryTrace {
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
    ...(input.result.requestEnvelope
      ? { requestEnvelope: input.result.requestEnvelope }
      : {}),
    ...(input.reductionLevel ? { reductionLevel: input.reductionLevel } : {}),
  };
  trace.push(boundary);
}

export function summarizeModelUseTrace(
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

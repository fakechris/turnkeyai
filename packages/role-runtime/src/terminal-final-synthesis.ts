import type {
  RoleActivationInput,
  RuntimeProgressRecorder,
} from "@turnkeyai/core-types/team";
import type {
  GenerateTextInput,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import {
  generateWithEnvelopeRetry,
  type GenerateWithEnvelopeRetryResult,
} from "./gateway-envelope-retry";
import type { ModelCallBoundaryTrace } from "./model-call-trace";
import type {
  PreCompactionMemoryFlusher,
} from "./pre-compaction-memory-flusher";
import type { RolePromptPacket } from "./prompt-policy";
import { createTerminalCloseoutController } from "./react-engine/terminal-closeout-controller";
import { recordToolResultPruningBoundarySafely } from "./tool-history-pruning";

export interface GenerateFinalAfterToolRoundLimitInput {
  gateway: LLMGateway;
  now: () => number;
  runtimeProgressRecorder?: RuntimeProgressRecorder | undefined;
  preCompactionMemoryFlusher?: PreCompactionMemoryFlusher | undefined;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  baseGatewayInput: GenerateTextInput;
  messages: LLMMessage[];
  maxRounds: number;
  modelCallTrace?: ModelCallBoundaryTrace[] | undefined;
  reasonLines?: string[] | undefined;
}

export type GenerateFinalAfterToolRoundLimitResult =
  GenerateWithEnvelopeRetryResult;

export async function generateFinalAfterToolRoundLimit(
  input: GenerateFinalAfterToolRoundLimitInput,
): Promise<GenerateFinalAfterToolRoundLimitResult> {
  return createTerminalCloseoutController().synthesizeFinalAfterToolRoundLimit({
    activation: input.activation,
    packet: input.packet,
    baseGatewayInput: input.baseGatewayInput,
    messages: input.messages,
    maxRounds: input.maxRounds,
    selection: input.selection,
    ...(input.reasonLines === undefined ? {} : { reasonLines: input.reasonLines }),
    recordPruning: (snapshot) =>
      recordToolResultPruningBoundarySafely({
        activation: input.activation,
        runtimeProgressRecorder: input.runtimeProgressRecorder,
        selection: input.selection,
        snapshot,
      }),
    synthesize: ({ gatewayInput, tracePhase }) =>
      generateWithEnvelopeRetry({
        gateway: input.gateway,
        now: input.now,
        preCompactionMemoryFlusher: input.preCompactionMemoryFlusher,
        activation: input.activation,
        packet: input.packet,
        selection: input.selection,
        gatewayInput,
        ...(input.modelCallTrace ? { modelCallTrace: input.modelCallTrace } : {}),
        tracePhase,
      }),
  });
}

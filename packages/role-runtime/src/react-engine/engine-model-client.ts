import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type {
  ModelClient,
  ReActToolChoice,
} from "@turnkeyai/agent-core/react-loop";
import type {
  GenerateTextInput,
  GenerateTextResult,
} from "@turnkeyai/llm-adapter/index";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import {
  generateWithEnvelopeRetry,
  type GenerateWithEnvelopeRetryInput,
  type GenerateWithEnvelopeRetryResult,
} from "../gateway-envelope-retry";
import { buildToolRoundGatewayRequest } from "../gateway-input-builder";
import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { PreCompactionMemoryFlusher } from "../pre-compaction-memory-flusher";
import type { RolePromptPacket } from "../prompt-policy";
import type { ToolResultPruningSnapshot } from "../tool-history-pruning";
import type { FinalToolRoundWarningInput } from "./execution-budget-controller";

type EngineModelReduction = NonNullable<GenerateWithEnvelopeRetryResult["reduction"]>;
type EngineModelReductionSnapshot =
  GenerateWithEnvelopeRetryResult["reductionSnapshot"] | undefined;
type EngineModelMemoryFlush = NonNullable<
  GenerateWithEnvelopeRetryResult["memoryFlush"]
>;

export interface EngineModelRunState {
  recordReduction(input: {
    reduction: EngineModelReduction;
    reductionSnapshot: EngineModelReductionSnapshot;
  }): void;
  recordMemoryFlush(input: EngineModelMemoryFlush): void;
}

export interface EngineModelExecutionBudget {
  applyFinalToolRoundWarning(input: FinalToolRoundWarningInput): GenerateTextInput["messages"];
}

export interface CreateEngineModelClientInput {
  gateway: LLMGateway;
  now: () => number;
  preCompactionMemoryFlusher?: PreCompactionMemoryFlusher | undefined;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  selection: GenerateWithEnvelopeRetryInput["selection"];
  baseGatewayInput: GenerateTextInput;
  modelCallTrace: ModelCallBoundaryTrace[];
  maxRounds: number;
  activeToolLoop: boolean;
  executionBudget: EngineModelExecutionBudget;
  runState: EngineModelRunState;
  recordPruning(snapshot: ToolResultPruningSnapshot | undefined): Promise<void> | void;
}

export interface EngineModelClient {
  model: ModelClient;
  lastResult(): GenerateTextResult | undefined;
}

export function createEngineModelClient(
  input: CreateEngineModelClientInput,
): EngineModelClient {
  let lastResult: GenerateTextResult | undefined;
  let traceRound = 0;
  const model: ModelClient = {
    generate: async ({ messages: roundMessages, tools, toolChoice }) => {
      const modelCallRound = traceRound;
      const noToolRound = toolChoice === "none" || tools === undefined;
      const mappedToolChoice = mapReActToolChoice(toolChoice);
      const warningMessages = input.executionBudget.applyFinalToolRoundWarning({
        messages: roundMessages,
        active: input.activeToolLoop && !noToolRound,
        round: modelCallRound,
        maxRounds: input.maxRounds,
      });
      const gatewayRequest = buildToolRoundGatewayRequest({
        baseGatewayInput: input.baseGatewayInput,
        messages: warningMessages,
        noToolRound,
        ...(mappedToolChoice ? { toolChoice: mappedToolChoice } : {}),
      });
      await input.recordPruning(gatewayRequest.pruning);
      const generated = await generateWithEnvelopeRetry({
        gateway: input.gateway,
        now: input.now,
        preCompactionMemoryFlusher: input.preCompactionMemoryFlusher,
        activation: input.activation,
        packet: input.packet,
        selection: input.selection,
        gatewayInput: gatewayRequest.gatewayInput,
        modelCallTrace: input.modelCallTrace,
        tracePhase: "tool_round",
        traceRound: traceRound++,
      });
      lastResult = generated.result;
      if (generated.reduction) {
        input.runState.recordReduction({
          reduction: generated.reduction,
          reductionSnapshot: generated.reductionSnapshot,
        });
      }
      if (generated.memoryFlush) {
        input.runState.recordMemoryFlush(generated.memoryFlush);
      }
      return {
        text: generated.result.text,
        ...(generated.result.toolCalls?.length
          ? { toolCalls: generated.result.toolCalls }
          : {}),
        ...(generated.result.stopReason
          ? { stopReason: generated.result.stopReason }
          : {}),
      };
    },
  };
  return {
    model,
    lastResult: () => lastResult,
  };
}

function mapReActToolChoice(
  toolChoice: ReActToolChoice | undefined,
): GenerateTextInput["toolChoice"] | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }
  return typeof toolChoice === "string"
    ? toolChoice
    : { type: "tool", name: toolChoice.name };
}

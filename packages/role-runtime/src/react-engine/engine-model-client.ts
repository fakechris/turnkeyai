import type {
  RoleActivationInput,
  RuntimeProgressRecorder,
} from "@turnkeyai/core-types/team";
import type {
  ModelClient,
  ReActToolChoice,
} from "@turnkeyai/agent-core/react-loop";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMMessage,
  RequestEnvelopeDiagnostics,
} from "@turnkeyai/llm-adapter/index";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import {
  createInputTokenEstimateTracker,
  estimateGenerateTextInputTokens,
  type InputTokenEstimate,
} from "@turnkeyai/llm-adapter/token-estimator";

import {
  generateWithEnvelopeRetry,
  type GenerateWithEnvelopeRetryInput,
  type GenerateWithEnvelopeRetryResult,
} from "../gateway-envelope-retry";
import { buildToolRoundGatewayRequest } from "../gateway-input-builder";
import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { PreCompactionMemoryFlusher } from "../pre-compaction-memory-flusher";
import type { RolePromptPacket } from "../prompt-policy";
import {
  recordToolResultPruningBoundarySafely,
  type ToolResultPruningSnapshot,
} from "../tool-history-pruning";
import type { FinalToolRoundWarningInput } from "./execution-budget-controller";
import type { RunLifecycleRecorder } from "./run-lifecycle";

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
  lifecycle?: RunLifecycleRecorder | undefined;
  maxRounds: number;
  activeToolLoop: boolean;
  executionBudget: EngineModelExecutionBudget;
  runState: EngineModelRunState;
  recordPruning(
    snapshot: ToolResultPruningSnapshot | undefined,
    round: number,
  ): Promise<void> | void;
  forceCompact?:
    | ((input: {
        messages: LLMMessage[];
        round: number;
        diagnostics: RequestEnvelopeDiagnostics;
      }) => Promise<{ messages: LLMMessage[] }>)
    | undefined;
}

export interface CreateRoleEngineModelClientInput
  extends Omit<CreateEngineModelClientInput, "recordPruning"> {
  runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  onPruning?: (
    snapshot: ToolResultPruningSnapshot | undefined,
    round: number,
  ) => void;
}

export interface EngineModelClient {
  model: ModelClient;
  lastResult(): GenerateTextResult | undefined;
  estimateTokenBudget(
    input: Pick<GenerateTextInput, "messages" | "tools" | "toolChoice">,
  ): EngineModelTokenBudgetEstimate;
}

export interface EngineModelTokenBudgetEstimate extends InputTokenEstimate {
  inputTokenLimit?: number;
  utilization?: number;
}

export function createEngineModelClient(
  input: CreateEngineModelClientInput,
): EngineModelClient {
  let lastResult: GenerateTextResult | undefined;
  let inputTokenLimit: number | undefined;
  const inputTokenEstimateTracker = createInputTokenEstimateTracker();
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
        ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
        ...(mappedToolChoice ? { toolChoice: mappedToolChoice } : {}),
      });
      await input.recordPruning(gatewayRequest.pruning, modelCallRound);
      const generated = await generateWithEnvelopeRetry({
        gateway: input.gateway,
        now: input.now,
        preCompactionMemoryFlusher: input.preCompactionMemoryFlusher,
        ...(input.forceCompact
          ? {
              forceCompact: ({ messages, diagnostics }) =>
                input.forceCompact!({
                  messages,
                  diagnostics,
                  round: modelCallRound,
                }),
            }
          : {}),
        activation: input.activation,
        packet: input.packet,
        selection: input.selection,
        gatewayInput: gatewayRequest.gatewayInput,
        modelCallTrace: input.modelCallTrace,
        lifecycle: input.lifecycle,
        tracePhase: "tool_round",
        traceRound: traceRound++,
      });
      lastResult = generated.result;
      const observedRawInputTokens =
        generated.result.requestEnvelope?.estimatedInputTokens ??
        estimateGenerateTextInputTokens(gatewayRequest.gatewayInput);
      inputTokenEstimateTracker.observe({
        rawInputTokens: observedRawInputTokens,
        ...(generated.result.usage?.inputTokens === undefined
          ? {}
          : { actualInputTokens: generated.result.usage.inputTokens }),
      });
      inputTokenLimit = generated.result.requestEnvelope?.inputTokenLimit;
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
    estimateTokenBudget(estimateInput) {
      const estimate = inputTokenEstimateTracker.estimate(
        estimateGenerateTextInputTokens(estimateInput),
      );
      return {
        ...estimate,
        ...(inputTokenLimit === undefined ? {} : { inputTokenLimit }),
        ...(inputTokenLimit === undefined || inputTokenLimit <= 0
          ? {}
          : {
              utilization:
                estimate.estimatedInputTokens / inputTokenLimit,
            }),
      };
    },
  };
}

export function createRoleEngineModelClient(
  input: CreateRoleEngineModelClientInput,
): EngineModelClient {
  const { runtimeProgressRecorder, onPruning, ...engineInput } = input;
  return createEngineModelClient({
    ...engineInput,
    recordPruning: async (snapshot, round) => {
      onPruning?.(snapshot, round);
      await recordToolResultPruningBoundarySafely({
        activation: input.activation,
        runtimeProgressRecorder,
        selection: input.selection,
        snapshot,
      });
    },
  });
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

import type {
  RoleActivationInput,
  RuntimeProgressRecorder,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import type {
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";

import {
  persistNativeToolTraceSafely,
  type NativeToolRoundTrace,
} from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import { recordRuntimeForcedToolRoundProviderProtocolSafely } from "../tool-history-pruning";
import {
  executeRuntimeForcedToolRound,
  type RoleToolExecutionResult,
  type RoleToolLoopOptions,
  type RuntimeForcedToolRoundObserver,
} from "../tool-use";

export interface CreateEngineRuntimeForcedToolRoundRunnerInput {
  toolLoop: RoleToolLoopOptions | undefined;
  runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  providerRuntimeProgressRecorder?: RuntimeProgressRecorder | undefined;
  nativeToolMessageStore?: Pick<TeamMessageStore, "append"> | undefined;
  deferToolObservability?: boolean | undefined;
  now: () => number;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  toolTrace: NativeToolRoundTrace[];
  observer?: RuntimeForcedToolRoundObserver | undefined;
  toolLoopStartedAtMs: number;
  signal?: AbortSignal | undefined;
}

export interface CreateRoleEngineRuntimeForcedToolRoundRunnerInput
  extends Omit<
    CreateEngineRuntimeForcedToolRoundRunnerInput,
    "providerRuntimeProgressRecorder"
  > {}

export interface EngineRuntimeForcedToolRoundRunnerInput {
  messages: LLMMessage[];
  toolCalls: LLMToolCall[];
  assistantText: string;
  round?: number | undefined;
}

export type EngineRuntimeForcedToolRoundRunner = (
  input: EngineRuntimeForcedToolRoundRunnerInput,
) => Promise<{ messages: LLMMessage[]; toolResults: RoleToolExecutionResult[] }>;

export function createEngineRuntimeForcedToolRoundRunner(
  input: CreateEngineRuntimeForcedToolRoundRunnerInput,
): EngineRuntimeForcedToolRoundRunner {
  return (roundInput) =>
    executeRuntimeForcedToolRound({
      toolLoop: input.toolLoop,
      runtimeProgressRecorder: input.runtimeProgressRecorder,
      deferToolObservability: input.deferToolObservability,
      now: input.now,
      activation: input.activation,
      packet: input.packet,
      messages: roundInput.messages,
      toolTrace: input.toolTrace,
      observer: input.observer,
      toolCalls: roundInput.toolCalls,
      round: roundInput.round ?? input.toolTrace.length + 1,
      toolLoopStartedAtMs: input.toolLoopStartedAtMs,
      ...(input.signal ? { signal: input.signal } : {}),
      assistantText: roundInput.assistantText,
      persistNativeToolTrace: (options) =>
        persistNativeToolTraceSafely({
          activation: input.activation,
          toolTrace: input.toolTrace,
          nativeToolMessageStore: input.nativeToolMessageStore,
          now: input.now,
          defer: input.deferToolObservability,
          ...(options?.forceBlocking === undefined
            ? {}
            : { forceBlocking: options.forceBlocking }),
        }),
      recordProviderToolProtocolRound: (protocolRound) =>
        recordRuntimeForcedToolRoundProviderProtocolSafely({
          activation: input.activation,
          runtimeProgressRecorder:
            input.providerRuntimeProgressRecorder ??
            input.runtimeProgressRecorder,
          now: input.now,
          defer: input.deferToolObservability,
          ...protocolRound,
        }),
    });
}

export function createRoleEngineRuntimeForcedToolRoundRunner(
  input: CreateRoleEngineRuntimeForcedToolRoundRunnerInput,
): EngineRuntimeForcedToolRoundRunner {
  return createEngineRuntimeForcedToolRoundRunner({
    ...input,
    providerRuntimeProgressRecorder:
      input.toolLoop?.runtimeProgressRecorder ?? input.runtimeProgressRecorder,
  });
}

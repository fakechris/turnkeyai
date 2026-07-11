import type {
  RoleActivationInput,
  RuntimeProgressRecorder,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import type { ToolProgressEvent, ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import {
  persistNativeToolTraceSafely,
  type NativeToolRoundTrace,
} from "../native-tool-messages";
import { recordProviderToolProtocolRoundSafely } from "../tool-history-pruning";
import { toNativeToolProgressTrace, toNativeToolResultTrace } from "../tool-protocol";
import {
  appendAssistantToolCallMessage,
  appendToolResultMessages,
  recordRoleToolProgressSafely,
  type RoleToolLoopOptions,
} from "../tool-use";

// Stage 8 engine cleanup — EngineRunObserver.
//
// Authority: own the engine path's tool observability sinks (toolTrace,
// runtime progress events, and native tool-message persistence). It does NOT
// decide whether a tool call is allowed, whether a continuation fires, whether a
// repair fires, or transform final answer text.
export const ENGINE_RUN_OBSERVER_MODULE = "engine-run-observer" as const;

export interface EngineRunObserverDependencies {
  now(): number;
  recordToolProgress(
    call: LLMToolCall,
    progress: ToolProgressEvent,
  ): Promise<void>;
  recordProviderToolProtocolRound(
    input: EngineObservedProviderToolProtocolRound,
  ): Promise<void>;
  persistNativeToolTrace(options?: { forceBlocking?: boolean }): Promise<void>;
}

export interface RoleEngineRunObserverInput {
  toolTrace: NativeToolRoundTrace[];
  toolLoop:
    | Pick<RoleToolLoopOptions, "runtimeProgressRecorder">
    | undefined;
  runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  nativeToolMessageStore?: Pick<TeamMessageStore, "append"> | undefined;
  deferToolObservability?: boolean | undefined;
  now(): number;
  activation: RoleActivationInput;
}

export interface EngineObservedModelResponse {
  round: number;
  toolCalls: LLMToolCall[];
}

export interface EngineObservedToolStart {
  round: number;
  call: LLMToolCall;
}

export interface EngineObservedToolResult {
  result: ToolResult;
}

export interface EngineObservedProviderToolProtocolRound {
  round: number;
  toolCalls: LLMToolCall[];
  toolResults: ToolResult[];
  messages: LLMMessage[];
}

export interface EngineRuntimeForcedToolRoundHandlers {
  onProgress(call: LLMToolCall, progress: ToolProgressEvent): Promise<void>;
  onResult(result: ToolResult): Promise<void>;
}

export interface EngineObservedRuntimeForcedToolRound {
  round: number;
  messages: LLMMessage[];
  assistantText: string;
  toolCalls: LLMToolCall[];
  executeToolCalls(
    handlers: EngineRuntimeForcedToolRoundHandlers,
  ): Promise<ToolResult[]>;
  mapToolResultsForHistory?(results: ToolResult[]): Promise<ToolResult[]>;
}

export class EngineRunObserver {
  private currentRound: NativeToolRoundTrace | undefined;
  private readonly replayToolResults: ToolResult[] = [];

  constructor(
    private readonly toolTrace: NativeToolRoundTrace[],
    private readonly deps: EngineRunObserverDependencies,
  ) {}

  onModelResponse(input: EngineObservedModelResponse): void {
    if (input.toolCalls.length === 0) {
      return;
    }
    this.currentRound = {
      round: input.round + 1,
      calls: input.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      })),
      results: [],
      progress: [],
    };
    this.toolTrace.push(this.currentRound);
  }

  async onToolStarted(input: EngineObservedToolStart): Promise<void> {
    this.ensureRoundForToolStart(input);
    const round = this.currentRound;
    if (!round) {
      return;
    }
    if (!round.calls.some((existing) => existing.id === input.call.id)) {
      round.calls.push({
        id: input.call.id,
        name: input.call.name,
        input: input.call.input,
      });
    }
    const startedProgress: ToolProgressEvent = {
      phase: "started",
      toolName: input.call.name,
      summary: `Tool call started: ${input.call.name}`,
    };
    round.progress?.push(
      toNativeToolProgressTrace(input.call, startedProgress, this.deps.now()),
    );
    await this.deps.recordToolProgress(input.call, startedProgress);
    await this.deps.persistNativeToolTrace({ forceBlocking: true });
  }

  async onToolResult(input: EngineObservedToolResult): Promise<void> {
    const round = this.currentRound;
    if (!round) {
      return;
    }
    const roleToolResult = input.result;
    this.replayToolResults.push(structuredClone(roleToolResult));
    round.results.push(toNativeToolResultTrace(roleToolResult));

    const progressCall: LLMToolCall = {
      id: roleToolResult.toolCallId,
      name: roleToolResult.toolName,
      input: {},
    };
    for (const progress of roleToolResult.progress ?? []) {
      round.progress?.push(
        toNativeToolProgressTrace(progressCall, progress, this.deps.now()),
      );
      await this.deps.recordToolProgress(progressCall, progress);
    }

    const terminalProgress: ToolProgressEvent = {
      phase: roleToolResult.cancelled
        ? "cancelled"
        : roleToolResult.isError
          ? "failed"
          : "completed",
      toolName: roleToolResult.toolName,
      summary: roleToolResult.cancelled
        ? `Tool call cancelled: ${roleToolResult.toolName}`
        : roleToolResult.isError
          ? `Tool call failed: ${roleToolResult.toolName}`
          : `Tool call completed: ${roleToolResult.toolName}`,
    };
    round.progress?.push(
      toNativeToolProgressTrace(progressCall, terminalProgress, this.deps.now()),
    );
    await this.deps.recordToolProgress(progressCall, terminalProgress);
    await this.deps.persistNativeToolTrace();
  }

  async onProviderToolProtocolRound(
    input: EngineObservedProviderToolProtocolRound,
  ): Promise<void> {
    await this.deps.recordProviderToolProtocolRound(input);
  }

  async observeRuntimeForcedToolRound(
    input: EngineObservedRuntimeForcedToolRound,
  ): Promise<{ messages: LLMMessage[]; toolResults: ToolResult[] }> {
    const roundTrace: NativeToolRoundTrace = {
      round: input.round,
      calls: input.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      })),
      results: [],
      progress: [],
    };
    this.currentRound = roundTrace;
    this.toolTrace.push(roundTrace);

    const toolResults = await input.executeToolCalls({
      onProgress: async (call, progress) => {
        roundTrace.progress?.push(
          toNativeToolProgressTrace(call, progress, this.deps.now()),
        );
        await this.deps.persistNativeToolTrace({
          forceBlocking: progress.phase === "started",
        });
      },
      onResult: async (toolResult) => {
        this.replayToolResults.push(structuredClone(toolResult));
        roundTrace.results.push(toNativeToolResultTrace(toolResult));
        await this.deps.persistNativeToolTrace();
      },
    });

    const historyResults = input.mapToolResultsForHistory
      ? await input.mapToolResultsForHistory(toolResults)
      : toolResults;
    let messages = appendAssistantToolCallMessage(input.messages, {
      text: input.assistantText,
      toolCalls: input.toolCalls,
    });
    messages = appendToolResultMessages(messages, historyResults);
    await this.onProviderToolProtocolRound({
      round: input.round,
      toolCalls: input.toolCalls,
      toolResults,
      messages,
    });
    return { messages, toolResults };
  }

  snapshot(): {
    toolTrace: NativeToolRoundTrace[];
    currentRound: NativeToolRoundTrace | undefined;
  } {
    return {
      toolTrace: this.toolTrace,
      currentRound: this.currentRound,
    };
  }

  replayToolResultsSnapshot(): ToolResult[] {
    return structuredClone(this.replayToolResults);
  }

  private ensureRoundForToolStart(input: EngineObservedToolStart): void {
    if (this.currentRound?.round === input.round + 1) {
      return;
    }
    this.currentRound = {
      round: input.round + 1,
      calls: [],
      results: [],
      progress: [],
    };
    this.toolTrace.push(this.currentRound);
  }
}

export function createEngineRunObserver(
  toolTrace: NativeToolRoundTrace[],
  deps: EngineRunObserverDependencies,
): EngineRunObserver {
  return new EngineRunObserver(toolTrace, deps);
}

export function createRoleEngineRunObserver(
  input: RoleEngineRunObserverInput,
): EngineRunObserver {
  const selectRuntimeProgressRecorder = () =>
    input.toolLoop?.runtimeProgressRecorder ?? input.runtimeProgressRecorder;
  return createEngineRunObserver(input.toolTrace, {
    now: input.now,
    recordToolProgress: (call, progress) =>
      recordRoleToolProgressSafely({
        recorder: selectRuntimeProgressRecorder(),
        activation: input.activation,
        call,
        progress,
        defer: input.deferToolObservability,
      }),
    recordProviderToolProtocolRound: (round) =>
      recordProviderToolProtocolRoundSafely({
        activation: input.activation,
        runtimeProgressRecorder: selectRuntimeProgressRecorder(),
        now: input.now,
        defer: input.deferToolObservability,
        round: round.round,
        toolCalls: round.toolCalls,
        toolResults: round.toolResults,
        messages: round.messages,
      }),
    persistNativeToolTrace: (options) =>
      persistNativeToolTraceSafely({
        activation: input.activation,
        toolTrace: input.toolTrace,
        nativeToolMessageStore: input.nativeToolMessageStore,
        now: input.now,
        defer: input.deferToolObservability,
        ...options,
      }),
  });
}

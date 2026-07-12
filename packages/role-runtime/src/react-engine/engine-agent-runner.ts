import type { ToolContext, ToolResult } from "@turnkeyai/agent-core/tool";
import { createReActAgent } from "@turnkeyai/agent-core/react-agent";
import type {
  ModelClient,
  ReActHooks,
  ReActLoop,
} from "@turnkeyai/agent-core/react-loop";
import type { Toolkit } from "@turnkeyai/agent-core/toolkit";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { EngineRunObserver } from "./engine-run-observer";

export interface EngineAgentRunnerInput<Ctx extends ToolContext> {
  agent: ReActLoop<Ctx>;
  messages: LLMMessage[];
  initialRound?: number | undefined;
  ctx: Ctx;
  signal?: AbortSignal | undefined;
  observer: Pick<
    EngineRunObserver,
    "onModelResponse" | "onToolStarted" | "onToolResult"
  >;
  effectLifecycle?: EngineEffectLifecycle | undefined;
}

export interface EngineEffectLifecycle {
  onAdmitted(input: { round: number; call: LLMToolCall }): Promise<void>;
  onStarted(input: { round: number; call: LLMToolCall }): Promise<void>;
  onResult(input: { round: number; result: ToolResult }): Promise<void>;
}

export interface CreateRoleEngineAgentRunnerInput<Ctx extends ToolContext> {
  model: ModelClient;
  toolkit: Toolkit<Ctx>;
  maxRounds: number;
  hooks: ReActHooks<Ctx>;
}

export type RoleEngineAgentRunner<Ctx extends ToolContext> = (
  input: Omit<EngineAgentRunnerInput<Ctx>, "agent">,
) => Promise<string>;

export function createRoleEngineAgentRunner<Ctx extends ToolContext>(
  input: CreateRoleEngineAgentRunnerInput<Ctx>,
): RoleEngineAgentRunner<Ctx> {
  const agent = createReActAgent<Ctx>({
    model: input.model,
    toolkit: input.toolkit,
    // Give agent-core one extra boundary round so the model call that hits the
    // real tool-loop limit can still surface pending calls to closeout policy.
    maxRounds: input.maxRounds + 1,
    hooks: input.hooks,
  });
  return (runInput) =>
    runEngineAgent({
      ...runInput,
      agent,
    });
}

export async function runEngineAgent<Ctx extends ToolContext>(
  input: EngineAgentRunnerInput<Ctx>,
): Promise<string> {
  let finalText = "";
  for await (const event of input.agent.run({
    messages: input.messages,
    ctx: input.ctx,
    ...(input.initialRound === undefined
      ? {}
      : { initialRound: input.initialRound }),
    ...(input.signal ? { signal: input.signal } : {}),
    onToolExecutionStart: async ({ round, call }) => {
      await input.effectLifecycle?.onStarted({ round, call });
      await input.observer.onToolStarted({ round, call });
    },
    onToolExecutionResult: async ({ round, result }) => {
      await input.effectLifecycle?.onResult({ round, result });
    },
  })) {
    if (event.type === "model_response") {
      input.observer.onModelResponse({
        round: event.round,
        toolCalls: event.toolCalls,
      });
    } else if (event.type === "tool_admitted") {
      await input.effectLifecycle?.onAdmitted({
        round: event.round,
        call: event.call,
      });
    } else if (event.type === "tool_result") {
      await input.observer.onToolResult({ result: event.result });
    } else if (event.type === "final") {
      finalText = event.text;
    }
  }
  return finalText;
}

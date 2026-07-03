import type { ToolContext } from "@turnkeyai/agent-core/tool";
import type { ReActLoop } from "@turnkeyai/agent-core/react-loop";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { EngineRunObserver } from "./engine-run-observer";

export interface EngineAgentRunnerInput<Ctx extends ToolContext> {
  agent: ReActLoop<Ctx>;
  messages: LLMMessage[];
  ctx: Ctx;
  signal?: AbortSignal | undefined;
  observer: Pick<
    EngineRunObserver,
    "onModelResponse" | "onToolStarted" | "onToolResult"
  >;
}

export async function runEngineAgent<Ctx extends ToolContext>(
  input: EngineAgentRunnerInput<Ctx>,
): Promise<string> {
  let finalText = "";
  for await (const event of input.agent.run({
    messages: input.messages,
    ctx: input.ctx,
    ...(input.signal ? { signal: input.signal } : {}),
  })) {
    if (event.type === "model_response") {
      input.observer.onModelResponse({
        round: event.round,
        toolCalls: event.toolCalls,
      });
    } else if (event.type === "tool_started") {
      await input.observer.onToolStarted({
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

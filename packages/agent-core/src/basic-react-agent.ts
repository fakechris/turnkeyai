import type { ToolContext, ToolResult } from "./tool";
import { appendAssistantToolCallMessage, appendToolResultMessages } from "./tool-messages";
import type { ReActEvent, ReActLoop, ReActLoopOptions, ReActRunInput } from "./react-loop";

export const DEFAULT_REACT_MAX_ROUNDS = 16;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("react loop aborted");
  }
}

/**
 * The canonical ReAct loop, the reusable counterpart to AgentScope's ReActAgent:
 *
 *   call model -> parse tool calls -> execute -> append results -> repeat
 *   until the model stops requesting tools or the round budget is hit.
 *
 * It streams {@link ReActEvent}s (the streaming gap the single-shot
 * `RoleResponseGenerator` has), reuses agent-core's generic message helpers and
 * {@link Toolkit}, and knows nothing host-specific. Tool calls in a round run
 * concurrently, matching the existing generator's batch execution.
 */
export function createBasicReActAgent<Ctx extends ToolContext>(
  options: ReActLoopOptions<Ctx>
): ReActLoop<Ctx> {
  const maxRounds = options.maxRounds ?? DEFAULT_REACT_MAX_ROUNDS;
  return {
    async *run({ messages, ctx, signal }: ReActRunInput<Ctx>): AsyncIterable<ReActEvent> {
      let current = messages;
      const tools = options.toolkit.definitions();

      for (let round = 0; round < maxRounds; round++) {
        throwIfAborted(signal);
        const response = await options.model.generate({
          messages: current,
          tools,
          ...(signal ? { signal } : {}),
        });
        let toolCalls = response.toolCalls ?? [];
        if (options.onToolCalls) {
          toolCalls = options.onToolCalls(toolCalls, round, ctx);
        }
        yield { type: "model_response", round, text: response.text, toolCalls };

        if (toolCalls.length === 0) {
          yield {
            type: "final",
            text: response.text,
            rounds: round + 1,
            ...(response.stopReason ? { stopReason: response.stopReason } : {}),
          };
          return;
        }

        current = appendAssistantToolCallMessage(current, { text: response.text, toolCalls });
        for (const call of toolCalls) {
          yield { type: "tool_started", round, call };
        }
        // Thread the run's abort signal into the tool context so tools (e.g. the
        // MCP adapter, which cancels via ctx.signal) can abort an in-flight call.
        const toolCtx: Ctx = signal ? ({ ...ctx, signal } as Ctx) : ctx;
        const results: ToolResult[] = await Promise.all(
          toolCalls.map(async (call) => {
            try {
              return await options.toolkit.execute(call, toolCtx);
            } catch (error) {
              // Isolate a throwing tool as an error result instead of rejecting
              // Promise.all and crashing the whole loop; the model sees the error.
              return {
                toolCallId: call.id,
                toolName: call.name,
                isError: true,
                content: error instanceof Error ? error.message : String(error),
              };
            }
          })
        );
        for (const result of results) {
          yield { type: "tool_result", round, result };
        }
        current = appendToolResultMessages(current, results);
      }

      // Round budget exhausted with tools still pending: force one tool-free
      // synthesis so the caller never gets an empty/dangling answer (mirrors the
      // existing generator's generateFinalAfterToolRoundLimit).
      throwIfAborted(signal);
      const finalResponse = await options.model.generate({
        messages: current,
        ...(signal ? { signal } : {}),
      });
      yield { type: "model_response", round: maxRounds, text: finalResponse.text, toolCalls: [] };
      yield {
        type: "final",
        text: finalResponse.text,
        rounds: maxRounds,
        ...(finalResponse.stopReason ? { stopReason: finalResponse.stopReason } : {}),
      };
    },
  };
}

/** Drain a run to its terminal answer for non-streaming callers. */
export async function collectReActRun(
  events: AsyncIterable<ReActEvent>
): Promise<{ text: string; rounds: number; stopReason?: string }> {
  let result: { text: string; rounds: number; stopReason?: string } = { text: "", rounds: 0 };
  for await (const event of events) {
    if (event.type === "final") {
      result = {
        text: event.text,
        rounds: event.rounds,
        ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      };
    }
  }
  return result;
}

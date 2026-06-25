import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { ToolContext, ToolResult } from "./tool";
import { appendAssistantToolCallMessage, appendToolResultMessages } from "./tool-messages";
import type {
  ReActEvent,
  ReActLoop,
  ReActLoopOptions,
  ReActRunInput,
  ReActState,
  ReActSynthesis,
  ReActToolChoice,
} from "./react-loop";

export const DEFAULT_REACT_MAX_ROUNDS = 16;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("react loop aborted");
  }
}

function runPredicates<Ctx extends ToolContext>(
  predicates: Array<(state: ReActState, ctx: Ctx) => string | null> | undefined,
  state: ReActState,
  ctx: Ctx
): string | null {
  for (const predicate of predicates ?? []) {
    const reason = predicate(state, ctx);
    if (reason) return reason;
  }
  return null;
}

/**
 * The full ReAct engine — the reusable counterpart to AgentScope's ReActAgent.
 *
 *   call model -> parse tool calls -> execute -> append results -> repeat
 *   until the model stops, a closeout predicate fires, or the round budget is hit.
 *
 * With no hooks it is the plain canonical loop (what {@link createBasicReActAgent}
 * exposes). The optional {@link ReActHooks} surface is what lets a policy-heavy
 * host (TurnkeyAI's response generator) converge onto this loop without the loop
 * learning any host concept — every hook receives the opaque `Ctx` and the
 * generic {@link ReActState}, never an activation/packet/evidence type.
 */
export function createReActAgent<Ctx extends ToolContext>(options: ReActLoopOptions<Ctx>): ReActLoop<Ctx> {
  const maxRounds = options.maxRounds ?? DEFAULT_REACT_MAX_ROUNDS;
  const hooks = options.hooks ?? {};
  const onToolCalls = hooks.onToolCalls ?? options.onToolCalls;

  return {
    async *run({ messages, ctx, signal }: ReActRunInput<Ctx>): AsyncIterable<ReActEvent> {
      const state: ReActState = { messages, results: [], round: 0, lastText: "" };
      const emit = (event: ReActEvent): ReActEvent => {
        hooks.onProgress?.(event);
        return event;
      };
      const tools = hooks.filterTools
        ? hooks.filterTools(options.toolkit.definitions(), ctx)
        : options.toolkit.definitions();

      const finalEvent = (synthesis: ReActSynthesis, rounds: number, closeoutReason?: string): ReActEvent => {
        // Guard the hook boundary: a misbehaving onTerminate could hand back a
        // null/partial synthesis.
        const rawText = synthesis?.text ?? "";
        const text = hooks.onFinalize ? hooks.onFinalize(rawText, state, ctx) : rawText;
        return emit({
          type: "final",
          text,
          rounds,
          ...(synthesis?.stopReason ? { stopReason: synthesis.stopReason } : {}),
          ...(closeoutReason ? { closeoutReason } : {}),
        });
      };

      // Produce a terminal answer for a closeout reason. The host's onTerminate
      // wins; the default is a single tool-free synthesis model call (mirrors the
      // existing generator's generateFinalAfterToolRoundLimit), surfaced as a
      // model_response so observers still see it.
      async function* terminate(reason: string): AsyncGenerator<ReActEvent, void> {
        if (hooks.onTerminate) {
          yield finalEvent(await hooks.onTerminate(reason, state, ctx), state.round, reason);
          return;
        }
        throwIfAborted(signal);
        const response = await options.model.generate({
          messages: state.messages,
          ...(signal ? { signal } : {}),
        });
        yield emit({ type: "model_response", round: state.round, text: response.text, toolCalls: [] });
        yield finalEvent(
          { text: response.text, ...(response.stopReason ? { stopReason: response.stopReason } : {}) },
          state.round,
          reason
        );
      }

      // Carries a forced tool choice from an onRepairRound directive into the
      // next round (the repair re-synthesis), then clears.
      let pendingRepairToolChoice: ReActToolChoice | undefined;
      for (let round = 0; round < maxRounds; round++) {
        state.round = round;
        throwIfAborted(signal);

        const preReason = runPredicates(hooks.terminationPredicates, state, ctx);
        if (preReason) {
          yield* terminate(preReason);
          return;
        }

        let forceToolChoice: ReActToolChoice | undefined;
        if (hooks.onRoundMessages) {
          const rewritten = hooks.onRoundMessages(state.messages, round, ctx);
          state.messages = rewritten?.messages ?? state.messages;
          forceToolChoice = rewritten?.forceToolChoice;
        }
        if (pendingRepairToolChoice !== undefined) {
          forceToolChoice = pendingRepairToolChoice;
          pendingRepairToolChoice = undefined;
        }

        try {
          const generated = await options.model.generate({
            messages: state.messages,
            // Drop the tool schemas entirely for a forced tool-free round so they
            // don't count toward provider/envelope tool-size limits during a
            // synthesis or repair round.
            ...(forceToolChoice === "none" ? {} : { tools }),
            ...(forceToolChoice ? { toolChoice: forceToolChoice } : {}),
            ...(signal ? { signal } : {}),
          });
          state.lastText = generated.text;
          let toolCalls = generated.toolCalls ?? [];
          if (onToolCalls) toolCalls = onToolCalls(toolCalls, round, ctx) ?? [];
          // Pending-call closeouts fire before the round is recorded/executed, so
          // a terminating reason leaves this round out of the trace (matching a
          // host loop that closes out on the pending calls without executing).
          const closeReason = hooks.onToolCallsClose
            ? hooks.onToolCallsClose(toolCalls, state, ctx)
            : null;
          if (closeReason) {
            yield* terminate(closeReason);
            return;
          }
          yield emit({ type: "model_response", round, text: generated.text, toolCalls });

          if (toolCalls.length === 0) {
            const decision = hooks.onRoundEmpty ? hooks.onRoundEmpty(state, ctx) : "terminate";
            if (decision === "terminate" || !decision?.injectedCalls?.length) {
              // Before finalizing this tool-free candidate answer, let the host
              // request a repair re-synthesis round (rewritten messages + forced
              // tool choice). Idempotency + the round budget bound the loop.
              const repair = hooks.onRepairRound ? hooks.onRepairRound(state, ctx) : null;
              if (repair) {
                state.messages = repair.messages;
                pendingRepairToolChoice = repair.forceToolChoice ?? "none";
                continue;
              }
              yield finalEvent(
                { text: generated.text, ...(generated.stopReason ? { stopReason: generated.stopReason } : {}) },
                round + 1
              );
              return;
            }
            toolCalls = decision.injectedCalls;
          }

          let executable = toolCalls;
          let rejected: ToolResult[] = [];
          if (hooks.onBeforeExecute) {
            const gated = hooks.onBeforeExecute(toolCalls, ctx);
            executable = gated?.executable ?? toolCalls;
            rejected = gated?.rejected ?? [];
          }

          state.messages = appendAssistantToolCallMessage(state.messages, {
            text: generated.text,
            toolCalls,
          });
          for (const call of executable) {
            yield emit({ type: "tool_started", round, call });
          }
          const toolCtx: Ctx = signal ? ({ ...ctx, signal } as Ctx) : ctx;
          const runOne = async (call: LLMToolCall): Promise<ToolResult> => {
            try {
              return await options.toolkit.execute(call, toolCtx);
            } catch (error) {
              // Isolate a throwing tool as an error result instead of rejecting
              // the batch and crashing the whole loop.
              return {
                toolCallId: call.id,
                toolName: call.name,
                isError: true,
                content: error instanceof Error ? error.message : String(error),
              };
            }
          };
          const executed: ToolResult[] = hooks.runToolBatch
            ? await hooks.runToolBatch(executable, runOne, toolCtx)
            : await Promise.all(executable.map(runOne));
          const results = [...rejected, ...executed];
          for (const result of results) {
            yield emit({ type: "tool_result", round, result });
          }
          state.messages = appendToolResultMessages(state.messages, results);
          state.results.push(...results);

          const postReason = hooks.onAfterExecute ? hooks.onAfterExecute(results, state, ctx) : null;
          if (postReason) {
            yield* terminate(postReason);
            return;
          }
        } catch (error) {
          // Re-thrown abort (cooperative cancellation) must propagate, not be
          // swallowed by the model-call error hook.
          if (signal?.aborted) throw error;
          const recovery = hooks.onModelCallError ? hooks.onModelCallError(error, state, ctx) : "rethrow";
          if (recovery === "rethrow") throw error;
          yield finalEvent(recovery, round, "model_call_error");
          return;
        }
      }

      // Round budget exhausted with tools still pending.
      state.round = maxRounds;
      yield* terminate("round_limit");
    },
  };
}

/** Drain a run to its terminal answer for non-streaming callers. */
export async function collectReActRun(
  events: AsyncIterable<ReActEvent>
): Promise<{ text: string; rounds: number; stopReason?: string; closeoutReason?: string }> {
  let result: { text: string; rounds: number; stopReason?: string; closeoutReason?: string } = {
    text: "",
    rounds: 0,
  };
  for await (const event of events) {
    if (event.type === "final") {
      result = {
        text: event.text,
        rounds: event.rounds,
        ...(event.stopReason ? { stopReason: event.stopReason } : {}),
        ...(event.closeoutReason ? { closeoutReason: event.closeoutReason } : {}),
      };
    }
  }
  return result;
}

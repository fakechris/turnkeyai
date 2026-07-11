import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { ToolContext, ToolResult } from "./tool";
import { appendAssistantToolCallMessage, appendToolResultMessages } from "./tool-messages";
import type {
  ReActEvent,
  ReActLoop,
  ReActLoopOptions,
  ReActReArm,
  ReActRunInput,
  ReActState,
  ReActSynthesis,
  ReActToolChoice,
} from "./react-loop";

export const DEFAULT_REACT_MAX_ROUNDS = 16;

/**
 * Hard safety backstop on repair re-synthesis rounds (onRepairRound). Repair
 * rounds don't consume the tool-round budget, so this caps a non-converging
 * repair loop. Set well above any realistic repair cascade — host idempotency
 * (e.g. ctx.repairMarkers) is the normal bound; this only fires on a bug.
 */
export const MAX_REPAIR_ROUNDS = 32;

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
    async *run({ messages, ctx, signal, initialRound }: ReActRunInput<Ctx>): AsyncIterable<ReActEvent> {
      const resumedRound =
        typeof initialRound === "number" && Number.isFinite(initialRound)
          ? Math.max(0, Math.floor(initialRound))
          : 0;
      const state: ReActState = { messages, results: [], round: resumedRound, lastText: "" };
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
      // model_response so observers still see it. Returns a ReActReArm directive when
      // onTerminate aborts the closeout to run another round (no `final` is emitted);
      // the caller adopts the rewritten messages + forced choice and continues.
      async function* terminate(
        reason: string
      ): AsyncGenerator<ReActEvent, ReActReArm | undefined> {
        if (hooks.onTerminate) {
          const outcome = await hooks.onTerminate(reason, state, ctx);
          if (outcome && "reArm" in outcome) {
            return outcome;
          }
          yield finalEvent(outcome, state.round, reason);
          return undefined;
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
        return undefined;
      }

      // Carries a forced tool choice from an onRepairRound directive into the
      // next round (the repair re-synthesis), then clears.
      let pendingRepairToolChoice: ReActToolChoice | undefined;
      // Carries a forced tool choice from an onSuppressToolCalls directive into
      // the next round, then clears. Unlike a repair, a suppressed round still
      // consumes the round budget (no round-- below), matching an inline loop that
      // drops the calls and continues a normal round.
      let pendingForceToolChoice: ReActToolChoice | undefined;
      // Repair rounds don't consume the tool-round budget (see `round--` below),
      // so a separate counter caps them as a safety backstop in case host
      // idempotency fails to converge. Well above any real repair cascade.
      let repairRounds = 0;
      for (let round = resumedRound; round < maxRounds; round++) {
        state.round = round;
        throwIfAborted(signal);

        const preReason = runPredicates(hooks.terminationPredicates, state, ctx);
        if (preReason) {
          const reArm = yield* terminate(preReason);
          if (reArm) {
            state.messages = reArm.reArm.messages;
            if (reArm.reArm.forceToolChoice !== undefined) {
              pendingForceToolChoice = reArm.reArm.forceToolChoice;
            }
            continue;
          }
          return;
        }

        let forceToolChoice: ReActToolChoice | undefined;
        if (hooks.onRoundMessages) {
          const rewritten = await hooks.onRoundMessages(
            state.messages,
            round,
            ctx,
          );
          throwIfAborted(signal);
          state.messages = rewritten?.messages ?? state.messages;
          forceToolChoice = rewritten?.forceToolChoice;
        }
        if (pendingRepairToolChoice !== undefined) {
          forceToolChoice = pendingRepairToolChoice;
          pendingRepairToolChoice = undefined;
        }
        if (pendingForceToolChoice !== undefined) {
          forceToolChoice = pendingForceToolChoice;
          pendingForceToolChoice = undefined;
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
          throwIfAborted(signal);
          state.lastText = generated.text;
          let toolCalls = generated.toolCalls ?? [];
          if (onToolCalls) toolCalls = onToolCalls(toolCalls, state, ctx) ?? [];
          // Pending-call closeouts fire before the round is recorded/executed, so
          // a terminating reason leaves this round out of the trace (matching a
          // host loop that closes out on the pending calls without executing).
          // Runs BEFORE onSuppressToolCalls: a host's pre-execute closeouts that
          // precede a suppression branch (e.g. an operator-cancelled or recovery-
          // budget closeout) must win over the drop, so the host keeps them in
          // onToolCallsClose and the suppress check sits after. The closeouts a host
          // orders AFTER its suppression branch only fire once tool rounds have
          // accrued, which the round-0 suppression precludes, so this single split
          // preserves the host's pre-execute precedence.
          const closeReason = hooks.onToolCallsClose
            ? hooks.onToolCallsClose(toolCalls, state, ctx)
            : null;
          if (closeReason) {
            const reArm = yield* terminate(closeReason);
            if (reArm) {
              state.messages = reArm.reArm.messages;
              if (reArm.reArm.forceToolChoice !== undefined) {
              pendingForceToolChoice = reArm.reArm.forceToolChoice;
            }
              continue;
            }
            return;
          }
          // Pre-execute suppression: a host may drop this round's tool calls and
          // re-prompt the next round (e.g. a setup-only turn that should not run
          // tools). The dropped round is NOT emitted/executed/traced, and the
          // forced choice carries into the next round — which still consumes the
          // budget (no round--), unlike an onRepairRound re-synthesis. Edge: if a
          // suppression fires on the final budgeted round (round === maxRounds-1),
          // the forced retry cannot run (the loop exits to a budget closeout) — a
          // host that lets a forced tool-free synthesis run past the budget must
          // bound suppression away from that boundary (matching maxRounds).
          const suppress = hooks.onSuppressToolCalls
            ? hooks.onSuppressToolCalls(toolCalls, state, ctx)
            : null;
          if (suppress) {
            state.messages = suppress.messages;
            pendingForceToolChoice = suppress.forceToolChoice ?? "none";
            continue;
          }
          yield emit({ type: "model_response", round, text: generated.text, toolCalls });

          if (toolCalls.length === 0) {
            const decision = hooks.onRoundEmpty ? hooks.onRoundEmpty(state, ctx) : "terminate";
            if (decision === "terminate" || !decision?.injectedCalls?.length) {
              // Before finalizing this tool-free candidate answer, let the host
              // request a repair re-synthesis round (rewritten messages + forced
              // tool choice). Idempotency + the round budget bound the loop.
              const repair =
                hooks.onRepairRound && repairRounds < MAX_REPAIR_ROUNDS
                  ? hooks.onRepairRound(state, ctx)
                  : null;
              if (repair && "closeout" in repair) {
                // A loop-breaker: abort the candidate and terminate the run with this
                // closeout reason (routed through onTerminate), instead of repairing or
                // finalizing the still-incomplete candidate.
                const reArm = yield* terminate(repair.closeout);
                if (reArm) {
                  state.messages = reArm.reArm.messages;
                  if (reArm.reArm.forceToolChoice !== undefined) {
                    pendingForceToolChoice = reArm.reArm.forceToolChoice;
                  }
                  continue;
                }
                return;
              }
              if (repair) {
                state.messages = repair.messages;
                pendingRepairToolChoice = repair.forceToolChoice ?? "none";
                if (!repair.consumesRound) {
                  // A tool-free repair re-synthesis is not a new tool round, so it
                  // must not consume the round budget: the for-loop's round++ would
                  // otherwise push past maxRounds and mislabel a final-round repair
                  // as round_limit. Cancel the increment and count it against the
                  // MAX_REPAIR_ROUNDS backstop (host repair-marker idempotency
                  // converges it). state.round is reset at the top.
                  repairRounds++;
                  round--;
                }
                // A consumesRound repair re-arms a REAL tool round (forced
                // sessions_spawn): keep round++ (charge the budget, exactly like the
                // inline `continue` after nextToolChoice={type:tool,name:...}) and do
                // NOT touch repairRounds — it is bounded by maxRounds + the host's
                // shared repairMarker. forceToolChoice is {name} (not "none"), so the
                // tools stay attached and the next round executes a real tool call.
                continue;
              }
              throwIfAborted(signal);
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
          throwIfAborted(signal);
          for (const call of executable) {
            yield emit({ type: "tool_started", round, call });
          }
          const toolCtx: Ctx = signal ? ({ ...ctx, signal } as Ctx) : ctx;
          const runOne = async (call: LLMToolCall): Promise<ToolResult> => {
            try {
              return await options.toolkit.execute(call, toolCtx);
            } catch (error) {
              throwIfAborted(signal);
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
          throwIfAborted(signal);
          // Executed results first, then onBeforeExecute's rejected results. A host
          // that rejects over-cap calls (e.g. an execution-cap that keeps the first N
          // and skips the rest) appends the skipped results AFTER the executed ones;
          // this order is the parity contract such a host relies on.
          const results = [...executed, ...rejected];
          for (const result of results) {
            yield emit({ type: "tool_result", round, result });
          }
          const historyResults = hooks.onToolResultsForHistory
            ? await hooks.onToolResultsForHistory(results, state, ctx)
            : results;
          throwIfAborted(signal);
          state.messages = appendToolResultMessages(
            state.messages,
            historyResults,
          );
          state.results.push(...results);

          // Post-execute continuation: the host may run a forced tool round itself
          // and hand back rewritten messages to run another round, pre-empting a
          // terminal closeout the results would otherwise trigger (e.g. a forced
          // permission_result check before a completed-session closeout). The forced
          // round is the host's own; the engine just adopts the messages and loops
          // (round++), so it is bounded by maxRounds.
          if (hooks.onAfterExecuteContinue) {
            const cont = await hooks.onAfterExecuteContinue(results, state, ctx);
            if (cont) {
              state.messages = cont.messages;
              // A re-prompt continuation carries a forced tool choice into the next
              // model call (a normal budget-consuming round, like a suppression — no
              // round--); a host-executed forced round leaves it unset (auto round).
              if (cont.forceToolChoice !== undefined) {
                pendingForceToolChoice = cont.forceToolChoice;
              }
              continue;
            }
          }

          const postReason = hooks.onAfterExecute ? hooks.onAfterExecute(results, state, ctx) : null;
          if (postReason) {
            // onTerminate may abort this closeout to re-arm a forced tool round (e.g.
            // a completed-session synthesis that still lacks required browser evidence
            // re-arms a sessions_spawn round): adopt its messages + forced choice and
            // continue (round++, a budget-consuming round bounded by maxRounds).
            const reArm = yield* terminate(postReason);
            if (reArm) {
              state.messages = reArm.reArm.messages;
              if (reArm.reArm.forceToolChoice !== undefined) {
              pendingForceToolChoice = reArm.reArm.forceToolChoice;
            }
              continue;
            }
            return;
          }
        } catch (error) {
          // Re-thrown abort (cooperative cancellation) must propagate, not be
          // swallowed by the model-call error hook.
          if (signal?.aborted) throw error;
          const recovery = hooks.onModelCallError
            ? await hooks.onModelCallError(error, state, ctx)
            : "rethrow";
          if (recovery === "rethrow") throw error;
          // A { messages } continuation: the host ran a forced recovery round (e.g.
          // a forced permission_result check) and handed back rewritten messages —
          // adopt them and run another round instead of finalizing.
          if ("messages" in recovery) {
            state.messages = recovery.messages;
            continue;
          }
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

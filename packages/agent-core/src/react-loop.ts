import type { LLMMessage, LLMToolCall, LLMToolDefinition } from "@turnkeyai/llm-adapter/types";
import type { ToolContext, ToolResult } from "./tool";
import type { Toolkit } from "./toolkit";

/** Which tools the next model call may use. Mirrors the gateway's tool choice. */
export type ReActToolChoice = "auto" | "none" | "required" | { name: string };

/**
 * The minimal model port the ReAct loop needs. It matches `LLMGateway.generate`
 * structurally, so any gateway adapts with a tiny wrapper, and tests can script
 * it directly. agent-core does not know about providers, retries, or envelopes.
 */
export interface ModelClient {
  generate(input: {
    messages: LLMMessage[];
    tools?: LLMToolDefinition[];
    toolChoice?: ReActToolChoice;
    signal?: AbortSignal;
  }): Promise<{ text: string; toolCalls?: LLMToolCall[]; stopReason?: string }>;
}

/** Streaming events emitted while the loop runs. */
export type ReActEvent =
  | { type: "model_response"; round: number; text: string; toolCalls: LLMToolCall[] }
  | { type: "tool_started"; round: number; call: LLMToolCall }
  | { type: "tool_result"; round: number; result: ToolResult }
  | { type: "final"; text: string; rounds: number; stopReason?: string; closeoutReason?: string };

/** A model-produced final answer (text + optional stop reason). */
export interface ReActSynthesis {
  text: string;
  stopReason?: string;
}

/** An onTerminate directive to ABORT the closeout and run another round instead:
 *  adopt rewritten messages + an optional forced tool choice, then re-enter the loop
 *  (round++, a budget-consuming round, bounded by `maxRounds`). The host returns this
 *  when a closeout-time check (e.g. a completed-session synthesis that still lacks
 *  required browser evidence) must re-arm a real tool round rather than finalize. The
 *  host guards idempotency (e.g. via a recorded repair marker) so this converges. */
export interface ReActReArm {
  reArm: { messages: LLMMessage[]; forceToolChoice?: ReActToolChoice };
}

/** What to do when the model requests no tools in a round. */
export type ReActEmptyDecision = { injectedCalls: LLMToolCall[] } | "terminate";

/** A repair directive: rewritten messages for one more (typically tool-free)
 *  round instead of finalizing the candidate answer. */
export interface ReActRepairDecision {
  messages: LLMMessage[];
  forceToolChoice?: ReActToolChoice;
  /** When true, the repair re-arms a REAL tool round (e.g. a forced
   *  `sessions_spawn`) that must CONSUME the round budget — agent-core keeps the
   *  for-loop's `round++` (no `round--`) and does NOT bump `repairRounds`, so the
   *  forced round is bounded by `maxRounds` + the host's repairMarker idempotency,
   *  not by `MAX_REPAIR_ROUNDS`. Omitted/false (the default) keeps the tool-free
   *  re-synthesis semantics: `round--` (a free round) counted against
   *  `MAX_REPAIR_ROUNDS`. */
  consumesRound?: boolean;
}

/** Mutable run state visible to every hook. `agent-core` never inspects `Ctx`. */
export interface ReActState {
  /** Conversation so far (assistant tool-call + tool-result messages appended each round). */
  messages: LLMMessage[];
  /** Every tool result produced so far — the de-facto run trace. */
  results: ToolResult[];
  /** Zero-based round index about to run / just run. */
  round: number;
  /** Text from the most recent model response. */
  lastText: string;
}

/**
 * The full host-policy surface a generic ReAct loop must expose so a policy-heavy
 * generator can converge onto it WITHOUT the loop learning any host concept.
 * Every hook is optional; the defaults reproduce the plain canonical loop.
 *
 * Category → hook map (see plan Appendix A.4):
 *  - normalization        → onToolCalls (+ onRoundMessages for suppress-and-retry)
 *  - pre-execute suppress → onSuppressToolCalls (drop calls + re-prompt a normal round)
 *  - termination/closeout → terminationPredicates + onTerminate
 *  - repair/recovery      → onRepairRound (re-synthesize) + onModelCallError (forced round / fallback)
 *  - approval/permission  → filterTools + onToolCalls + onRoundMessages + onBeforeExecute + onAfterExecuteContinue
 *  - session-continuation → onToolCalls + onRoundEmpty + onAfterExecuteContinue + onAfterExecute
 *  - finalization         → onFinalize
 *  - execution/budget     → onBeforeExecute + terminationPredicates
 */
export interface ReActHooks<Ctx extends ToolContext> {
  /** Strip/restrict the offered tool definitions once, before the loop. */
  filterTools?(tools: LLMToolDefinition[], ctx: Ctx): LLMToolDefinition[];
  /** Rewrite messages before a model call; optionally force the tool choice
   *  (e.g. "none" to force a synthesis round). */
  onRoundMessages?(
    messages: LLMMessage[],
    round: number,
    ctx: Ctx
  ): { messages: LLMMessage[]; forceToolChoice?: ReActToolChoice };
  /** Recover from a model-call error. Return a terminal synthesis (finalize with
   *  `closeoutReason: "model_call_error"`), `"rethrow"` to propagate, or a
   *  `{ messages }` continuation to adopt rewritten messages and run another round
   *  (e.g. a host-authored forced tool round executed inside the hook before the
   *  fallback synthesis). May be async. */
  onModelCallError?(
    error: unknown,
    state: ReActState,
    ctx: Ctx
  ):
    | ReActSynthesis
    | "rethrow"
    | { messages: LLMMessage[] }
    | Promise<ReActSynthesis | "rethrow" | { messages: LLMMessage[] }>;
  /** Normalize/rewrite the requested tool calls before execution. */
  onToolCalls?(calls: LLMToolCall[], round: number, ctx: Ctx): LLMToolCall[];
  /** Suppress the round's pending tool calls BEFORE execution: drop them, inject
   *  guidance, and force the next round. Return a directive (rewritten messages +
   *  optional forced tool choice) to suppress + re-prompt, or null to proceed to
   *  execution. Runs AFTER `onToolCallsClose` (so a host's pre-execute closeouts
   *  win over the drop) and before the `model_response` emit. Unlike onRepairRound
   *  this does NOT cancel the round budget (round--): the dropped round still
   *  counts, matching an inline loop that drops the calls and `continue`s a normal
   *  round. The host guards idempotency (e.g. via `ctx.repairMarkers`) so it
   *  converges. */
  onSuppressToolCalls?(
    calls: LLMToolCall[],
    state: ReActState,
    ctx: Ctx
  ): { messages: LLMMessage[]; forceToolChoice?: ReActToolChoice } | null;
  /** Inspect the round's pending (normalized) tool calls before execution;
   *  return a closeout reason to terminate the run (routed through onTerminate),
   *  or null to proceed. Runs after onToolCalls and before the empty-round /
   *  execute steps, so a host can fire pending-call closeouts (budget/cap/loop
   *  breakers) without executing the round. */
  onToolCallsClose?(calls: LLMToolCall[], state: ReActState, ctx: Ctx): string | null;
  /** Decide what to do when a round yields no tool calls: terminate, or inject
   *  calls (the forced-continuation override). */
  onRoundEmpty?(state: ReActState, ctx: Ctx): ReActEmptyDecision;
  /** Inspect a candidate final answer from a tool-free round that would otherwise
   *  finalize the run; return a repair directive to run one more round (rewritten
   *  messages + forced tool choice) or null to finalize. A default (tool-free)
   *  repair does NOT consume the tool-round budget, so the host must guard
   *  idempotency (e.g. via `ctx.repairMarkers`) so this converges; agent-core's
   *  MAX_REPAIR_ROUNDS is the hard backstop. A `consumesRound: true` repair instead
   *  re-arms a REAL tool round that DOES consume the budget (bounded by `maxRounds`
   *  + the host's repairMarker, not `MAX_REPAIR_ROUNDS`); it is still only ARMED
   *  while `repairRounds < MAX_REPAIR_ROUNDS`, but never increments that counter.
   *  A `{ closeout }` directive instead ABORTS the candidate and terminates the run
   *  with that closeout reason (routed through onTerminate) — a loop-breaker for a
   *  repair that has failed (e.g. force a local-evidence fallback after a repair
   *  re-synthesis still left the answer incomplete). */
  onRepairRound?(
    state: ReActState,
    ctx: Ctx
  ): ReActRepairDecision | { closeout: string } | null;
  /** Gate/split calls before execution (rejected calls become synthetic results). */
  onBeforeExecute?(
    calls: LLMToolCall[],
    ctx: Ctx
  ): { executable: LLMToolCall[]; rejected?: ToolResult[] };
  /**
   * Strategy for executing a round's executable calls. Default is an unbounded
   * `Promise.all`. A host supplies this to enforce concurrency caps, ordered
   * serialization, and per-call wall-clock aborts. It MUST return results in the
   * same order as `calls` so `tool_result` emission and message pairing stay
   * correct. `runOne` is the default per-call executor (with the run signal); a
   * host may call it or run the executor directly with its own signals.
   */
  runToolBatch?(
    calls: LLMToolCall[],
    runOne: (call: LLMToolCall) => Promise<ToolResult>,
    ctx: Ctx
  ): Promise<ToolResult[]>;
  /** After a round executes and its messages are appended, optionally run a
   *  host-authored CONTINUATION instead of finalizing: return rewritten messages to
   *  adopt and run another round, or null to fall through to onAfterExecute. Two
   *  shapes of continuation are supported, both bounded by `maxRounds`:
   *   - a re-prompt: rewritten `messages` plus an optional `forceToolChoice` carried
   *     into the next model call (e.g. append a timeout-continuation prompt and force
   *     `sessions_send`); the budget-consuming round semantics match an inline loop
   *     that appends a message, sets the next tool choice, and `continue`s.
   *   - a host-executed forced round: the host runs the tool round itself inside the
   *     hook and returns the resulting `messages` (no `forceToolChoice`); the next
   *     model call is a normal auto round.
   *  Runs BEFORE onAfterExecute so a post-execute continuation pre-empts a terminal
   *  closeout the results would otherwise trigger. May be async. The host guards
   *  idempotency (e.g. via the trace/messages it inspects) so this converges. */
  onAfterExecuteContinue?(
    results: ToolResult[],
    state: ReActState,
    ctx: Ctx
  ):
    | Promise<{ messages: LLMMessage[]; forceToolChoice?: ReActToolChoice } | null>
    | { messages: LLMMessage[]; forceToolChoice?: ReActToolChoice }
    | null;
  /** Inspect results after a round; return a closeout reason to stop, or null. */
  onAfterExecute?(results: ToolResult[], state: ReActState, ctx: Ctx): string | null;
  /** Ordered closeout predicates checked each round (round/budget/cap closeouts). */
  terminationPredicates?: Array<(state: ReActState, ctx: Ctx) => string | null>;
  /** Produce the terminal answer for a closeout reason (default: a tool-free
   *  synthesis model call). May instead return a {@link ReActReArm} directive to
   *  abort the closeout and run another (budget-consuming) round — e.g. a completed-
   *  session synthesis that still lacks required browser evidence re-arms a forced
   *  `sessions_spawn` round instead of finalizing. */
  onTerminate?(
    reason: string,
    state: ReActState,
    ctx: Ctx
  ): ReActSynthesis | ReActReArm | Promise<ReActSynthesis | ReActReArm>;
  /** Final text transform chain (visibility appends, redaction, shaping). */
  onFinalize?(text: string, state: ReActState, ctx: Ctx): string;
  /** Fire-and-forget observability for every emitted event. */
  onProgress?(event: ReActEvent): void;
}

export interface ReActLoopOptions<Ctx extends ToolContext> {
  model: ModelClient;
  toolkit: Toolkit<Ctx>;
  /** Max reasoning rounds before a final tool-free synthesis is forced. Default 16. */
  maxRounds?: number;
  /**
   * Convenience seam equivalent to `hooks.onToolCalls`. When both are provided,
   * `hooks.onToolCalls` wins.
   */
  onToolCalls?: (calls: LLMToolCall[], round: number, ctx: Ctx) => LLMToolCall[];
  /** Full host-policy hook surface (see {@link ReActHooks}). */
  hooks?: ReActHooks<Ctx>;
}

export interface ReActRunInput<Ctx extends ToolContext> {
  messages: LLMMessage[];
  ctx: Ctx;
  signal?: AbortSignal;
}

export interface ReActLoop<Ctx extends ToolContext> {
  run(input: ReActRunInput<Ctx>): AsyncIterable<ReActEvent>;
}

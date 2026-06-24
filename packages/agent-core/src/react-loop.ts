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

/** What to do when the model requests no tools in a round. */
export type ReActEmptyDecision = { injectedCalls: LLMToolCall[] } | "terminate";

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
 *  - termination/closeout → terminationPredicates + onTerminate
 *  - repair/recovery      → onRoundMessages (inject-and-reloop) + onModelCallError
 *  - approval/permission  → filterTools + onToolCalls + onRoundMessages + onBeforeExecute
 *  - session-continuation → onToolCalls + onRoundEmpty + onAfterExecute
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
  /** Recover from a model-call error: return a terminal synthesis or rethrow. */
  onModelCallError?(error: unknown, state: ReActState, ctx: Ctx): ReActSynthesis | "rethrow";
  /** Normalize/rewrite the requested tool calls before execution. */
  onToolCalls?(calls: LLMToolCall[], round: number, ctx: Ctx): LLMToolCall[];
  /** Decide what to do when a round yields no tool calls: terminate, or inject
   *  calls (the forced-continuation override). */
  onRoundEmpty?(state: ReActState, ctx: Ctx): ReActEmptyDecision;
  /** Gate/split calls before execution (rejected calls become synthetic results). */
  onBeforeExecute?(
    calls: LLMToolCall[],
    ctx: Ctx
  ): { executable: LLMToolCall[]; rejected?: ToolResult[] };
  /** Inspect results after a round; return a closeout reason to stop, or null. */
  onAfterExecute?(results: ToolResult[], state: ReActState, ctx: Ctx): string | null;
  /** Ordered closeout predicates checked each round (round/budget/cap closeouts). */
  terminationPredicates?: Array<(state: ReActState, ctx: Ctx) => string | null>;
  /** Produce the terminal answer for a closeout reason (default: a tool-free
   *  synthesis model call). */
  onTerminate?(reason: string, state: ReActState, ctx: Ctx): ReActSynthesis | Promise<ReActSynthesis>;
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

import type { LLMMessage, LLMToolCall, LLMToolDefinition } from "@turnkeyai/llm-adapter/types";
import type { ToolContext, ToolResult } from "./tool";
import type { Toolkit } from "./toolkit";

/**
 * The minimal model port the ReAct loop needs. It matches `LLMGateway.generate`
 * structurally, so any gateway adapts with a tiny wrapper, and tests can script
 * it directly. agent-core does not know about providers, retries, or envelopes.
 */
export interface ModelClient {
  generate(input: {
    messages: LLMMessage[];
    tools?: LLMToolDefinition[];
    signal?: AbortSignal;
  }): Promise<{ text: string; toolCalls?: LLMToolCall[]; stopReason?: string }>;
}

/** Streaming events emitted while the loop runs. */
export type ReActEvent =
  | { type: "model_response"; round: number; text: string; toolCalls: LLMToolCall[] }
  | { type: "tool_started"; round: number; call: LLMToolCall }
  | { type: "tool_result"; round: number; result: ToolResult }
  | { type: "final"; text: string; rounds: number; stopReason?: string };

export interface ReActLoopOptions<Ctx extends ToolContext> {
  model: ModelClient;
  toolkit: Toolkit<Ctx>;
  /** Max reasoning rounds before a final tool-free synthesis is forced. Default 16. */
  maxRounds?: number;
  /**
   * Optional transform of the model's requested tool calls before execution.
   * This is the single host-policy seam the basic agent exposes (e.g. call
   * normalization). Returning `[]` ends the loop with the current text.
   *
   * The broader hook surface (termination predicates, repair, approval gating)
   * needed to converge TurnkeyAI's policy-heavy generator onto this primitive is
   * intentionally NOT added here yet — it lands incrementally with that work.
   */
  onToolCalls?: (calls: LLMToolCall[], round: number, ctx: Ctx) => LLMToolCall[];
}

export interface ReActRunInput<Ctx extends ToolContext> {
  messages: LLMMessage[];
  ctx: Ctx;
  signal?: AbortSignal;
}

export interface ReActLoop<Ctx extends ToolContext> {
  run(input: ReActRunInput<Ctx>): AsyncIterable<ReActEvent>;
}

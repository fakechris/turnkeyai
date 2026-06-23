import type { LLMToolCall, LLMToolDefinition } from "@turnkeyai/llm-adapter/types";

/**
 * Generic, role-agnostic tool abstractions for the reusable agent core.
 *
 * Nothing in this module may reference host concepts (roles, workers,
 * evidence, approval). Host-specific state travels through the `Ctx` type
 * parameter, which the core never inspects.
 */

/** Per-call execution context. Hosts extend this with their own shape via `Ctx`. */
export interface ToolContext {
  /** Cooperative cancellation for the whole tool call. */
  signal?: AbortSignal;
}

/** Lifecycle event a tool may surface while running. */
export interface ToolProgressEvent {
  phase: "started" | "progress" | "completed" | "failed" | "cancelled";
  toolName: string;
  summary: string;
  detail?: Record<string, unknown>;
}

/** The outcome of a single tool call. */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
  cancelled?: boolean;
  skipped?: boolean;
  progress?: ToolProgressEvent[];
  raw?: unknown;
}

/** A single executable tool. `Ctx` is the host-specific per-call context. */
export interface Tool<Ctx extends ToolContext = ToolContext> {
  readonly definition: LLMToolDefinition;
  execute(call: LLMToolCall, ctx: Ctx): Promise<ToolResult>;
}

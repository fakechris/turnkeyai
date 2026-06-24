import type { LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { NativeToolRoundTrace } from "../native-tool-messages";

/**
 * Generic, role-agnostic execution + termination helpers for the ReAct loop.
 *
 * These were inline in `llm-response-generator.ts`. They are pure (no instance
 * or loop-local state) and are extracted here so the existing loop and the
 * future `createReActAgent` path can share — and unit-test — them. Behavior is
 * unchanged: each function is a verbatim move or a thin wrapper over a check the
 * loop already performed inline.
 */

/** Tools whose effects are order-dependent and must not run concurrently. */
const ORDER_DEPENDENT_TOOL_NAMES = new Set([
  "memory_search",
  "memory_get",
  "permission_query",
  "permission_result",
  "permission_applied",
  "tasks_list",
  "tasks_create",
  "tasks_update",
]);

/** A batch must be serialized when it mixes >1 calls and any is order-dependent. */
export function shouldSerializeToolBatch(toolCalls: LLMToolCall[]): boolean {
  return (
    toolCalls.length > 1 &&
    toolCalls.some((call) => ORDER_DEPENDENT_TOOL_NAMES.has(call.name))
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function normalizeToolInputForSignature(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeToolInputForSignature(entry));
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    normalized[key] = normalizeToolInputForSignature(
      (value as Record<string, unknown>)[key],
    );
  }
  return normalized;
}

/** A stable structural key for a tool call (name + whitespace-normalized input). */
export function toolCallSignature(call: LLMToolCall): string {
  return `${call.name}:${stableJson(normalizeToolInputForSignature(call.input))}`;
}

/**
 * Anti-loop breaker: returns the first pending call whose structural signature
 * has already failed `maxFailures` times in the trace (cancellations excluded).
 */
export function findRepeatedFailedToolCall(
  pendingCalls: LLMToolCall[],
  toolTrace: NativeToolRoundTrace[],
  maxFailures = 2,
): { toolName: string; failureCount: number } | null {
  if (pendingCalls.length === 0) {
    return null;
  }
  const callsById = new Map<string, LLMToolCall>();
  const failedCounts = new Map<string, { toolName: string; count: number }>();
  for (const round of toolTrace) {
    for (const call of round.calls) {
      callsById.set(call.id, call);
    }
    for (const result of round.results) {
      if (!result.isError || result.cancelled) {
        continue;
      }
      const call = callsById.get(result.toolCallId);
      if (!call) {
        continue;
      }
      const signature = toolCallSignature(call);
      const current = failedCounts.get(signature) ?? {
        toolName: call.name,
        count: 0,
      };
      failedCounts.set(signature, { ...current, count: current.count + 1 });
    }
  }
  for (const call of pendingCalls) {
    const current = failedCounts.get(toolCallSignature(call));
    if (current && current.count >= maxFailures) {
      return { toolName: current.toolName, failureCount: current.count };
    }
  }
  return null;
}

/** Generic round-budget predicate. */
export function roundLimitReached(round: number, maxRounds: number): boolean {
  return round >= maxRounds;
}

/**
 * Type guard for a usable positive, finite millisecond budget. A guard (rather
 * than a combined `elapsed >= budget` boolean) so the caller's `&&` chain still
 * narrows `maxWallClockMs` to `number` for the elapsed comparison and the
 * downstream closeout metadata — exactly as the original inline check did.
 */
export function isPositiveFiniteBudget(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

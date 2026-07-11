import type { LLMTokenUsage } from "./types";

export function normalizeAnthropicTokenUsage(raw: unknown): LLMTokenUsage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;

  const uncachedInputTokens = toNonNegativeInteger(usage["input_tokens"]);
  const cacheReadInputTokens = toNonNegativeInteger(usage["cache_read_input_tokens"]);
  const cacheCreationInputTokens = toNonNegativeInteger(usage["cache_creation_input_tokens"]);
  const outputTokens = toNonNegativeInteger(usage["output_tokens"]);
  const inputComponents = [
    uncachedInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  ].filter((value): value is number => value !== undefined);

  return compactUsage({
    inputTokens:
      inputComponents.length > 0
        ? inputComponents.reduce((total, value) => total + value, 0)
        : undefined,
    uncachedInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    outputTokens,
  });
}

export function normalizeOpenAITokenUsage(raw: unknown): LLMTokenUsage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;

  const inputTokens = toNonNegativeInteger(usage["prompt_tokens"]);
  const outputTokens = toNonNegativeInteger(usage["completion_tokens"]);
  const promptTokenDetails = asRecord(usage["prompt_tokens_details"]);
  const cacheReadInputTokens = toNonNegativeInteger(promptTokenDetails?.["cached_tokens"]);
  const uncachedInputTokens =
    inputTokens === undefined
      ? undefined
      : Math.max(0, inputTokens - (cacheReadInputTokens ?? 0));

  return compactUsage({
    inputTokens,
    uncachedInputTokens,
    cacheReadInputTokens,
    outputTokens,
  });
}

function compactUsage(usage: Record<string, number | undefined>): LLMTokenUsage | undefined {
  const entries = Object.entries(usage).filter((entry): entry is [string, number] => {
    return entry[1] !== undefined;
  });
  return entries.length > 0 ? Object.fromEntries(entries) as LLMTokenUsage : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

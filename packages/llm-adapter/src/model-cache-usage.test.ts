import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAnthropicTokenUsage,
  normalizeOpenAITokenUsage,
} from "./model-cache-usage";

test("normalizes Anthropic cache usage into provider-neutral token totals", () => {
  assert.deepEqual(
    normalizeAnthropicTokenUsage({
      input_tokens: 50,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
    }),
    {
      inputTokens: 1050,
      uncachedInputTokens: 50,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 100,
      outputTokens: 20,
    },
  );
});

test("normalizes OpenAI cached prompt tokens and derives uncached input", () => {
  assert.deepEqual(
    normalizeOpenAITokenUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 800 },
    }),
    {
      inputTokens: 1000,
      uncachedInputTokens: 200,
      cacheReadInputTokens: 800,
      outputTokens: 25,
    },
  );
});

test("omits missing and invalid optional cache counters", () => {
  assert.deepEqual(
    normalizeAnthropicTokenUsage({
      input_tokens: 12.9,
      output_tokens: Number.POSITIVE_INFINITY,
      cache_read_input_tokens: -1,
      cache_creation_input_tokens: Number.NaN,
    }),
    {
      inputTokens: 12,
      uncachedInputTokens: 12,
    },
  );
  assert.deepEqual(
    normalizeOpenAITokenUsage({
      completion_tokens: 8.8,
      prompt_tokens_details: { cached_tokens: -10 },
    }),
    { outputTokens: 8 },
  );
  assert.equal(normalizeAnthropicTokenUsage(undefined), undefined);
  assert.equal(normalizeOpenAITokenUsage({}), undefined);
});

test("clamps derived OpenAI uncached input when cached tokens exceed total", () => {
  assert.deepEqual(
    normalizeOpenAITokenUsage({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 120 },
    }),
    {
      inputTokens: 100,
      uncachedInputTokens: 0,
      cacheReadInputTokens: 120,
    },
  );
});

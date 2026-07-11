import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicCompatibleClient } from "./anthropic-compatible-client";
import type { ProviderActivityKind, ResolvedModelConfig } from "./types";

test("anthropic-compatible client requests SSE and reports transport activity", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  const activity: ProviderActivityKind[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return streamResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Streaming works."}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  }) as typeof fetch;

  try {
    const result = await new AnthropicCompatibleClient().generate(model(), {
      messages: [{ role: "user", content: "Stream the answer." }],
      onProviderActivity: (kind) => activity.push(kind ?? "event"),
    });

    assert.equal(requests[0]?.["stream"], true);
    assert.equal(result.text, "Streaming works.");
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result.usage, {
      inputTokens: 4,
      uncachedInputTokens: 4,
      outputTokens: 3,
    });
    assert.equal(activity[0], "headers");
    assert.ok(activity.includes("body"));
    assert.equal(activity.filter((kind) => kind === "event").length, 5);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("anthropic-compatible client falls back to JSON when streaming is not returned", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        content: [{ type: "text", text: "JSON fallback." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await new AnthropicCompatibleClient().generate(model(), {
      messages: [{ role: "user", content: "Fallback." }],
    });

    assert.equal(result.text, "JSON fallback.");
    assert.equal(result.stopReason, "end_turn");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function model(): ResolvedModelConfig {
  return {
    id: "model-1",
    label: "Model",
    providerId: "test",
    protocol: "anthropic-compatible",
    model: "model-1",
    baseURL: "https://example.test/anthropic/v1/",
    apiKeyEnv: "TEST_KEY",
    apiKey: "key",
  };
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

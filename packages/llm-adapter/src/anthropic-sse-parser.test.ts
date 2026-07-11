import assert from "node:assert/strict";
import test from "node:test";

import {
  AnthropicStreamInterruptedError,
  consumeAnthropicMessageStream,
} from "./anthropic-sse-parser";
import { ProviderRequestError } from "./types";

test("Anthropic SSE parser assembles UTF-8 text, tool JSON, usage, and stop reason", async () => {
  const encoded = new TextEncoder().encode([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":20}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"status\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join(""));
  const splitInsideUtf8 = encoded.indexOf(0xe4) + 1;
  const response = byteStreamResponse([
    encoded.slice(0, splitInsideUtf8),
    encoded.slice(splitInsideUtf8, splitInsideUtf8 + 2),
    encoded.slice(splitInsideUtf8 + 2),
  ]);
  const activity: string[] = [];

  const result = await consumeAnthropicMessageStream(response, {
    onActivity: (kind) => activity.push(kind),
  });

  assert.equal(result.text, "你好");
  assert.deepEqual(result.contentBlocks, [
    { type: "text", text: "你好" },
    { type: "tool_use", id: "toolu_1", name: "lookup", input: { query: "status" } },
  ]);
  assert.deepEqual(result.toolCalls, [
    { id: "toolu_1", name: "lookup", input: { query: "status" } },
  ]);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.usage, {
    inputTokens: 110,
    uncachedInputTokens: 10,
    cacheReadInputTokens: 80,
    cacheCreationInputTokens: 20,
    outputTokens: 5,
  });
  assert.equal(result.eventCount, 8);
  assert.equal(activity.filter((kind) => kind === "body").length, 3);
  assert.equal(activity.filter((kind) => kind === "event").length, 8);
});

test("Anthropic SSE parser surfaces provider error events", async () => {
  const response = textStreamResponse([
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"provider overloaded"}}\n\n',
  ]);

  await assert.rejects(
    () => consumeAnthropicMessageStream(response),
    (error) => {
      assert.ok(error instanceof ProviderRequestError);
      assert.equal(error.code, "provider_error");
      assert.match(error.message, /provider overloaded/);
      return true;
    },
  );
});

test("Anthropic SSE parser rejects malformed and interrupted streams without tool calls", async () => {
  const response = textStreamResponse([
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Partial "}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_partial","name":"lookup","input":{}}}\n\n',
    'event: content_block_delta\ndata: not-json\n\n',
  ]);

  await assert.rejects(
    () => consumeAnthropicMessageStream(response),
    (error) => {
      assert.ok(error instanceof AnthropicStreamInterruptedError);
      assert.equal(error.partialText, "Partial ");
      assert.equal(error.sawToolCallFragments, true);
      assert.deepEqual(error.completedToolCalls, []);
      return true;
    },
  );
});

test("Anthropic SSE parser aborts a stalled body read", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => undefined);
    },
  });
  const reason = new Error("deadline reached");
  const parsing = consumeAnthropicMessageStream(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    { signal: controller.signal },
  );

  controller.abort(reason);

  await assert.rejects(parsing, (error) => error === reason);
});

function textStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return byteStreamResponse(chunks.map((chunk) => encoder.encode(chunk)));
}

function byteStreamResponse(chunks: Uint8Array[]): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

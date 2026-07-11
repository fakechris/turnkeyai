import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeOpenAIChatCompletionStream,
  OpenAIStreamInterruptedError,
} from "./openai-sse-parser";

test("OpenAI SSE parser assembles text, tool calls, finish reason, and usage across chunk boundaries", async () => {
  const activity: number[] = [];
  const response = streamResponse([
    ": keep-alive\r\n\r\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"},\"finish_reason\":null}]}\r\n\r",
    "\ndata: {\"choices\":[{\"delta\":{\"content\":\"lo \"},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"query\\\":\"}}]},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"status\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":8}}}\n\n",
    "data: [DONE]\n\n",
  ]);

  const result = await consumeOpenAIChatCompletionStream(response, {
    onActivity: () => activity.push(1),
  });

  assert.equal(result.text, "Hello ");
  assert.deepEqual(result.toolCalls, [
    { id: "call_1", name: "lookup", input: { query: "status" } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    uncachedInputTokens: 4,
    cacheReadInputTokens: 8,
    outputTokens: 7,
  });
  assert.equal(result.eventCount, 4);
  assert.ok(activity.length >= 6);
});

test("OpenAI SSE parser accepts EOF after an explicit finish reason", async () => {
  const response = streamResponse([
    'data: {"choices":[{"delta":{"content":"Complete."},"finish_reason":"stop"}]}\n\n',
  ]);

  const result = await consumeOpenAIChatCompletionStream(response);

  assert.equal(result.text, "Complete.");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.toolCalls, []);
});

test("OpenAI SSE parser rejects interrupted streams and never returns partial tool calls", async () => {
  const response = streamResponse(
    [
      'data: {"choices":[{"delta":{"content":"Partial text ","tool_calls":[{"index":0,"id":"call_partial","function":{"name":"lookup","arguments":"{\\"query\\":"}}]},"finish_reason":null}]}\n\n',
    ],
    new Error("socket reset"),
  );

  await assert.rejects(
    () => consumeOpenAIChatCompletionStream(response),
    (error: unknown) => {
      assert.ok(error instanceof OpenAIStreamInterruptedError);
      assert.equal(error.partialText, "Partial text ");
      assert.equal(error.sawToolCallFragments, true);
      assert.equal(error.completedToolCalls.length, 0);
      return true;
    },
  );
});

function streamResponse(chunks: string[], terminalError?: Error): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk !== undefined) {
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      if (terminalError) {
        controller.error(terminalError);
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

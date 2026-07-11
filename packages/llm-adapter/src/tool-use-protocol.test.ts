import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicCompatibleClient } from "./anthropic-compatible-client";
import { OpenAICompatibleClient } from "./openai-compatible-client";
import { OpenAIStreamInterruptedError } from "./openai-sse-parser";
import { ProviderRequestError } from "./types";
import type { ResolvedModelConfig } from "./types";

test("anthropic-compatible client sends tools and parses tool_use blocks", async () => {
  const requests: unknown[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return response({
      content: [
        { type: "text", text: "I will inspect the page." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "sessions_spawn",
          input: { agent_id: "browser", task: "Open https://example.com" },
        },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    });
  }) as typeof fetch;

  try {
    const result = await new AnthropicCompatibleClient().generate(model("anthropic-compatible"), {
      messages: [{ role: "user", content: "Open example.com" }],
      tools: [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ],
      toolChoice: "auto",
    });

    assert.deepEqual((requests[0] as { tools?: unknown[] }).tools, [
      {
        name: "sessions_spawn",
        description: "Spawn a sub-agent",
        input_schema: { type: "object", properties: { task: { type: "string" } } },
      },
    ]);
    assert.deepEqual((requests[0] as { tool_choice?: unknown }).tool_choice, { type: "auto" });
    assert.equal((requests[0] as { max_tokens?: unknown }).max_tokens, 4096);
    assert.equal(result.text, "I will inspect the page.");
    assert.deepEqual(result.usage, {
      inputTokens: 110,
      uncachedInputTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 20,
      outputTokens: 5,
    });
    assert.deepEqual(result.toolCalls, [
      {
        id: "toolu_1",
        name: "sessions_spawn",
        input: { agent_id: "browser", task: "Open https://example.com" },
      },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("anthropic-compatible client preserves failed tool_result state", async () => {
  const requests: unknown[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return response({
      content: [{ type: "text", text: "I saw the failed tool result." }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }) as typeof fetch;

  try {
    await new AnthropicCompatibleClient().generate(model("anthropic-compatible"), {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "sessions_spawn", input: { task: "Open page" } }],
        },
        {
          role: "tool",
          toolCallId: "toolu_1",
          name: "sessions_spawn",
          content: [
            {
              type: "tool_result",
              toolUseId: "toolu_1",
              content: "browser unavailable",
              isError: true,
            },
          ],
        },
      ],
    });

    const request = requests[0] as { messages?: Array<{ content?: Array<Record<string, unknown>> }> };
    assert.equal(request.messages?.[1]?.content?.[0]?.type, "tool_result");
    assert.equal(request.messages?.[1]?.content?.[0]?.is_error, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("anthropic-compatible active prompt cache marks only static prefix boundaries", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response({
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  }) as typeof fetch;

  const input = {
    messages: [
      { role: "system" as const, content: "Stable policy." },
      { role: "system" as const, content: "Stable tool instructions." },
      { role: "user" as const, content: "Run the task." },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look up a record",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
      {
        name: "summarize",
        description: "Summarize a record",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
    toolChoice: "auto" as const,
    temperature: 0.25,
    maxOutputTokens: 321,
  };

  try {
    await new AnthropicCompatibleClient().generate(model("anthropic-compatible"), input);
    await new AnthropicCompatibleClient().generate(
      { ...model("anthropic-compatible"), promptCacheMode: "off" },
      input,
    );
    await new AnthropicCompatibleClient().generate(
      { ...model("anthropic-compatible"), promptCacheMode: "active" },
      input,
    );

    assert.equal(requests[0]?.["system"], "Stable policy.\n\nStable tool instructions.");
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(requests[2]?.["system"], [
      { type: "text", text: "Stable policy." },
      {
        type: "text",
        text: "Stable tool instructions.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    assert.deepEqual(requests[2]?.["tools"], [
      {
        name: "lookup",
        description: "Look up a record",
        input_schema: { type: "object", properties: { id: { type: "string" } } },
      },
      {
        name: "summarize",
        description: "Summarize a record",
        input_schema: { type: "object", properties: { text: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      },
    ]);
    assert.deepEqual(requests[2]?.["messages"], requests[0]?.["messages"]);
    assert.equal(requests[2]?.["temperature"], requests[0]?.["temperature"]);
    assert.equal(requests[2]?.["max_tokens"], requests[0]?.["max_tokens"]);
    assert.deepEqual(requests[2]?.["tool_choice"], requests[0]?.["tool_choice"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("openai-compatible client sends tools and parses tool_calls", async () => {
  const requests: unknown[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return response({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Checking with a browser worker.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "sessions_spawn",
                  arguments: JSON.stringify({ agent_id: "browser", task: "Open https://example.com" }),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        prompt_tokens_details: { cached_tokens: 9 },
      },
    });
  }) as typeof fetch;

  try {
    const result = await new OpenAICompatibleClient().generate(model("openai-compatible"), {
      messages: [{ role: "user", content: "Open example.com" }],
      tools: [
        {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          inputSchema: { type: "object", properties: { task: { type: "string" } } },
        },
      ],
      toolChoice: { type: "tool", name: "sessions_spawn" },
    });

    assert.deepEqual((requests[0] as { tools?: unknown[] }).tools, [
      {
        type: "function",
        function: {
          name: "sessions_spawn",
          description: "Spawn a sub-agent",
          parameters: { type: "object", properties: { task: { type: "string" } } },
        },
      },
    ]);
    assert.deepEqual((requests[0] as { tool_choice?: unknown }).tool_choice, {
      type: "function",
      function: { name: "sessions_spawn" },
    });
    assert.equal("stream" in (requests[0] as Record<string, unknown>), false);
    assert.equal(result.text, "Checking with a browser worker.");
    assert.deepEqual(result.usage, {
      inputTokens: 12,
      uncachedInputTokens: 3,
      cacheReadInputTokens: 9,
      outputTokens: 6,
    });
    assert.deepEqual(result.toolCalls, [
      {
        id: "call_1",
        name: "sessions_spawn",
        input: { agent_id: "browser", task: "Open https://example.com" },
      },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("openai-compatible client consumes SSE behind the streaming gate", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const previousFetch = globalThis.fetch;
  const previousStreaming = process.env.TURNKEYAI_LLM_STREAMING;
  process.env.TURNKEYAI_LLM_STREAMING = "1";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return openAIStreamResponse([
      'data: {"choices":[{"delta":{"content":"Streamed answer."},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":7}}}\n\n',
      "data: [DONE]\n\n",
    ]);
  }) as typeof fetch;

  try {
    const result = await new OpenAICompatibleClient().generate(
      model("openai-compatible"),
      { messages: [{ role: "user", content: "Answer." }] },
    );

    assert.equal(requests[0]?.["stream"], true);
    assert.deepEqual(requests[0]?.["stream_options"], { include_usage: true });
    assert.equal(result.text, "Streamed answer.");
    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.usage, {
      inputTokens: 9,
      uncachedInputTokens: 2,
      cacheReadInputTokens: 7,
      outputTokens: 3,
    });
    assert.deepEqual(result.raw, {
      stream: true,
      eventCount: 1,
      completed: true,
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStreaming === undefined) {
      delete process.env.TURNKEYAI_LLM_STREAMING;
    } else {
      process.env.TURNKEYAI_LLM_STREAMING = previousStreaming;
    }
  }
});

test("openai-compatible client makes interrupted SSE retryable without returning partial tool calls", async () => {
  const previousFetch = globalThis.fetch;
  const previousStreaming = process.env.TURNKEYAI_LLM_STREAMING;
  process.env.TURNKEYAI_LLM_STREAMING = "1";
  globalThis.fetch = (async () =>
    openAIStreamResponse(
      [
        'data: {"choices":[{"delta":{"content":"Partial", "tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{"}}]},"finish_reason":null}]}\n\n',
      ],
      new Error("connection lost"),
    )) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        new OpenAICompatibleClient().generate(model("openai-compatible"), {
          messages: [{ role: "user", content: "Answer." }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError);
        assert.equal(error.code, "network_error");
        assert.equal(error.retryable, true);
        assert.match(error.message, /interrupted/i);
        assert.ok(error.cause instanceof OpenAIStreamInterruptedError);
        assert.equal(error.cause.partialText, "Partial");
        assert.deepEqual(error.cause.completedToolCalls, []);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStreaming === undefined) {
      delete process.env.TURNKEYAI_LLM_STREAMING;
    } else {
      process.env.TURNKEYAI_LLM_STREAMING = previousStreaming;
    }
  }
});

test("compatible clients strip leading provider reasoning blocks from visible text", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { system?: unknown };
    if ("system" in body) {
      return response({
        content: [
          { type: "text", text: "<think>private chain of thought</think>\n\nVisible answer." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "sessions_spawn",
            input: { agent_id: "explore", task: "Check source" },
          },
        ],
        stop_reason: "tool_use",
      });
    }
    return response({
      choices: [
        {
          message: {
            role: "assistant",
            content: "<think>private chain of thought</think>\n\nVisible answer.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "sessions_spawn",
                  arguments: JSON.stringify({ agent_id: "explore", task: "Check source" }),
                },
              },
            ],
          },
        },
      ],
    });
  }) as typeof fetch;

  try {
    const anthropicResult = await new AnthropicCompatibleClient().generate(model("anthropic-compatible"), {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Answer." },
      ],
    });
    const openaiResult = await new OpenAICompatibleClient().generate(model("openai-compatible"), {
      messages: [{ role: "user", content: "Answer." }],
    });

    assert.equal(anthropicResult.text, "Visible answer.");
    assert.equal(openaiResult.text, "Visible answer.");
    assert.deepEqual(anthropicResult.contentBlocks?.[0], { type: "text", text: "Visible answer." });
    assert.deepEqual(openaiResult.contentBlocks?.[0], { type: "text", text: "Visible answer." });
    assert.equal(anthropicResult.toolCalls?.[0]?.name, "sessions_spawn");
    assert.equal(openaiResult.toolCalls?.[0]?.name, "sessions_spawn");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("compatible clients pass AbortSignal through to provider fetch", async () => {
  const signals: Array<AbortSignal | null> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal ?? null);
    return response({
      content: [{ type: "text", text: "ok" }],
      choices: [{ message: { content: "ok" } }],
      usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;

  try {
    const anthropicController = new AbortController();
    await new AnthropicCompatibleClient().generate(model("anthropic-compatible"), {
      signal: anthropicController.signal,
      messages: [{ role: "user", content: "hello" }],
    });
    const openaiController = new AbortController();
    await new OpenAICompatibleClient().generate(model("openai-compatible"), {
      signal: openaiController.signal,
      messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(signals[0], anthropicController.signal);
    assert.equal(signals[1], openaiController.signal);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("compatible clients expose typed provider failures and Retry-After", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    response(
      { error: { message: "capacity limited" } },
      { status: 429, headers: { "retry-after": "2" } },
    )) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        new OpenAICompatibleClient().generate(model("openai-compatible"), {
          messages: [{ role: "user", content: "hello" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError);
        assert.equal(error.code, "rate_limit");
        assert.equal(error.status, 429);
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterMs, 2_000);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("compatible clients do not mark authentication failures retryable", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    response({ error: { message: "invalid key" } }, { status: 401 })) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        new AnthropicCompatibleClient().generate(model("anthropic-compatible"), {
          messages: [{ role: "user", content: "hello" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRequestError);
        assert.equal(error.code, "authentication");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function model(protocol: "openai-compatible" | "anthropic-compatible"): ResolvedModelConfig {
  return {
    id: "model-1",
    label: "Model",
    providerId: "test",
    protocol,
    model: "model-1",
    baseURL: "https://example.test/v1",
    apiKeyEnv: "TEST_KEY",
    apiKey: "key",
  };
}

function response(
  body: unknown,
  input: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = input.status ?? 200;
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null;
      },
    },
    json: async () => body,
  } as Response;
}

function openAIStreamResponse(
  chunks: string[],
  terminalError?: Error,
): Response {
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

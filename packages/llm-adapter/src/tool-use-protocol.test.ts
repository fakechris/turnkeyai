import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicCompatibleClient } from "./anthropic-compatible-client";
import { OpenAICompatibleClient } from "./openai-compatible-client";
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
      usage: { input_tokens: 10, output_tokens: 5 },
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
    assert.equal(result.text, "I will inspect the page.");
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
      usage: { prompt_tokens: 12, completion_tokens: 6 },
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
    assert.equal(result.text, "Checking with a browser worker.");
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

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

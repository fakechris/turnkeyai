import assert from "node:assert/strict";
import test from "node:test";

import { LLMGateway } from "./gateway";
import { ModelRegistry } from "./registry";
import { ProviderRequestError } from "./types";
import type { GenerateTextInput, GenerateTextResult, ModelCatalog, ModelCatalogSource, ModelProtocol, ProtocolClient, ProviderLifecycleEvent, ResolvedModelConfig } from "./types";

class InMemoryCatalogSource implements ModelCatalogSource {
  constructor(private readonly catalog: ModelCatalog) {}

  async load(): Promise<ModelCatalog> {
    return this.catalog;
  }
}

class StubProtocolClient implements ProtocolClient {
  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    if (model.id === "primary-model") {
      throw new Error("primary model unavailable");
    }

    return {
      text: "fallback model response",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "stub",
      raw: {
        selectedModel: model.id,
      },
    };
  }
}

class SuccessProtocolClient implements ProtocolClient {
  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    return {
      text: "primary model response",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "success-stub",
      raw: {
        selectedModel: model.id,
      },
    };
  }
}

class EquivalentBackingFailoverClient implements ProtocolClient {
  readonly attemptedModelIds: string[] = [];

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.attemptedModelIds.push(model.id);
    if (model.id !== "regional-model") {
      throw new Error(`${model.id} unavailable`);
    }

    return {
      text: "regional model response",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "equivalent-backing-stub",
      raw: {
        selectedModel: model.id,
      },
    };
  }
}

class HangingProtocolClient implements ProtocolClient {
  signal: AbortSignal | null = null;

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(_model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.signal = input.signal ?? null;
    return new Promise<GenerateTextResult>(() => {
      // Intentionally unresolved; the gateway must enforce the timeout.
    });
  }
}

class ActiveLongRunningProtocolClient implements ProtocolClient {
  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(
    model: ResolvedModelConfig,
    input: GenerateTextInput,
  ): Promise<GenerateTextResult> {
    await delay(20);
    input.onProviderActivity?.();
    await delay(20);
    input.onProviderActivity?.();
    await delay(20);
    return {
      text: "healthy long response",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "active-long-running-stub",
      raw: {},
    };
  }
}

class StalledStreamingProtocolClient implements ProtocolClient {
  signal: AbortSignal | undefined;

  constructor(private readonly activityBeforeStall: boolean) {}

  supports(protocol: ModelProtocol): boolean {
    return protocol === "anthropic-compatible";
  }

  async generate(_model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.signal = input.signal;
    if (this.activityBeforeStall) {
      await delay(30);
      input.onProviderActivity?.("headers");
      await delay(25);
      input.onProviderActivity?.("body");
      input.onProviderActivity?.("event");
    }
    return await new Promise<GenerateTextResult>(() => undefined);
  }
}

class RetryThenSuccessClient implements ProtocolClient {
  attempts = 0;

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    this.attempts += 1;
    if (this.attempts < 3) {
      throw new ProviderRequestError("rate limited", {
        code: "rate_limit",
        status: 429,
        retryable: true,
        retryAfterMs: 25,
      });
    }
    return {
      text: "response after retry",
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "retry-stub",
      raw: {},
    };
  }
}

class RetryableFailureByModelClient implements ProtocolClient {
  readonly attemptedModelIds: string[] = [];

  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig): Promise<GenerateTextResult> {
    this.attemptedModelIds.push(model.id);
    if (model.id === "fallback-model") {
      return {
        text: "fallback should not run after allowance exhaustion",
        modelId: model.id,
        providerId: model.providerId,
        protocol: model.protocol,
        adapterName: "retry-allowance-stub",
        raw: {},
      };
    }
    throw new ProviderRequestError("primary unavailable", {
      code: "server_error",
      status: 503,
      retryable: true,
    });
  }
}

test("llm gateway retries one model before falling back and reports diagnostics", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  const client = new RetryThenSuccessClient();
  const delays: number[] = [];
  const lifecycle: ProviderLifecycleEvent[] = [];

  try {
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-model": {
              label: "Primary",
              providerId: "provider",
              protocol: "openai-compatible",
              model: "primary-model",
              baseURL: "https://primary.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
          },
        }),
      ),
      clients: [client],
      retrySleep: async (delayMs) => {
        delays.push(delayMs);
      },
      retryRandom: () => 0,
    });

    const result = await gateway.generate({
      modelId: "primary-model",
      messages: [{ role: "user", content: "Retry transient failures." }],
      onProviderLifecycle: (event) => {
        lifecycle.push(event);
      },
    });

    assert.equal(result.text, "response after retry");
    assert.equal(client.attempts, 3);
    assert.deepEqual(delays, [25, 25]);
    assert.equal(result.retryDiagnostics?.totalAttempts, 3);
    assert.equal(result.retryDiagnostics?.totalRetries, 2);
    assert.deepEqual(result.retryDiagnostics?.models, [
      {
        modelId: "primary-model",
        attempts: 3,
        retries: 2,
        errors: ["rate_limit", "rate_limit"],
      },
    ]);
    assert.deepEqual(
      lifecycle.map((event) => ({
        kind: event.kind,
        attempt: event.attempt,
        ...(event.kind === "attempt_failed" || event.kind === "retry_wait"
          ? { code: event.code }
          : {}),
        ...(event.kind === "retry_wait" ? { delayMs: event.delayMs } : {}),
      })),
      [
        { kind: "attempt_started", attempt: 1 },
        { kind: "attempt_failed", attempt: 1, code: "rate_limit" },
        { kind: "retry_wait", attempt: 1, code: "rate_limit", delayMs: 25 },
        { kind: "attempt_started", attempt: 2 },
        { kind: "attempt_failed", attempt: 2, code: "rate_limit" },
        { kind: "retry_wait", attempt: 2, code: "rate_limit", delayMs: 25 },
        { kind: "attempt_started", attempt: 3 },
        { kind: "attempt_completed", attempt: 3 },
      ],
    );
  } finally {
    if (previousPrimaryKey == null) delete process.env.TEST_PRIMARY_KEY;
    else process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
  }
});

test("llm gateway retries through configured model fallbacks", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  const previousFallbackKey = process.env.TEST_FALLBACK_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  process.env.TEST_FALLBACK_KEY = "fallback-key";

  try {
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-model": {
              label: "Primary",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "primary-model",
              baseURL: "https://primary.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
            "fallback-model": {
              label: "Fallback",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "fallback-model",
              baseURL: "https://fallback.example/v1",
              apiKeyEnv: "TEST_FALLBACK_KEY",
            },
          },
          modelChains: {
            reasoning_primary: {
              primary: "primary-model",
              fallbacks: ["fallback-model"],
            },
          },
        })
      ),
      clients: [new StubProtocolClient()],
    });

    const result = await gateway.generate({
      modelChainId: "reasoning_primary",
      messages: [
        {
          role: "user",
          content: "Test the model fallback chain.",
        },
      ],
    });

    assert.equal(result.text, "fallback model response");
    assert.equal(result.modelId, "fallback-model");
    assert.equal(result.modelChainId, "reasoning_primary");
    assert.deepEqual(result.attemptedModelIds, ["primary-model", "fallback-model"]);
  } finally {
    if (previousPrimaryKey == null) {
      delete process.env.TEST_PRIMARY_KEY;
    } else {
      process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
    if (previousFallbackKey == null) {
      delete process.env.TEST_FALLBACK_KEY;
    } else {
      process.env.TEST_FALLBACK_KEY = previousFallbackKey;
    }
  }
});

test("llm gateway uses one retry allowance across primary and fallback models", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  const previousFallbackKey = process.env.TEST_FALLBACK_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  process.env.TEST_FALLBACK_KEY = "fallback-key";
  const client = new RetryableFailureByModelClient();

  try {
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-model": {
              label: "Primary",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "primary-model",
              baseURL: "https://primary.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
            "fallback-model": {
              label: "Fallback",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "fallback-model",
              baseURL: "https://fallback.example/v1",
              apiKeyEnv: "TEST_FALLBACK_KEY",
            },
          },
          modelChains: {
            bounded_chain: {
              primary: "primary-model",
              fallbacks: ["fallback-model"],
            },
          },
        }),
      ),
      clients: [client],
      retryPolicy: {
        transientMaxAttempts: 2,
        timeoutMaxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
      retrySleep: async () => undefined,
    });

    await assert.rejects(
      () => gateway.generate({
        modelChainId: "bounded_chain",
        messages: [{ role: "user", content: "Use one bounded allowance." }],
      }),
      /primary unavailable/,
    );
    assert.deepEqual(client.attemptedModelIds, [
      "primary-model",
      "primary-model",
    ]);
  } finally {
    if (previousPrimaryKey == null) delete process.env.TEST_PRIMARY_KEY;
    else process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    if (previousFallbackKey == null) delete process.env.TEST_FALLBACK_KEY;
    else process.env.TEST_FALLBACK_KEY = previousFallbackKey;
  }
});

test("llm gateway reports only actually attempted models when the primary succeeds", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  const previousFallbackKey = process.env.TEST_FALLBACK_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  process.env.TEST_FALLBACK_KEY = "fallback-key";

  try {
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-model": {
              label: "Primary",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "primary-model",
              baseURL: "https://primary.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
            "fallback-model": {
              label: "Fallback",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "fallback-model",
              baseURL: "https://fallback.example/v1",
              apiKeyEnv: "TEST_FALLBACK_KEY",
            },
          },
          modelChains: {
            reasoning_primary: {
              primary: "primary-model",
              fallbacks: ["fallback-model"],
            },
          },
        })
      ),
      clients: [new SuccessProtocolClient()],
    });

    const result = await gateway.generate({
      modelChainId: "reasoning_primary",
      messages: [
        {
          role: "user",
          content: "Use the primary model.",
        },
      ],
    });

    assert.equal(result.text, "primary model response");
    assert.equal(result.modelId, "primary-model");
    assert.equal(result.modelChainId, "reasoning_primary");
    assert.deepEqual(result.attemptedModelIds, ["primary-model"]);
  } finally {
    if (previousPrimaryKey == null) {
      delete process.env.TEST_PRIMARY_KEY;
    } else {
      process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
    if (previousFallbackKey == null) {
      delete process.env.TEST_FALLBACK_KEY;
    } else {
      process.env.TEST_FALLBACK_KEY = previousFallbackKey;
    }
  }
});

test("llm gateway skips equivalent backing aliases while preserving distinct fallbacks", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  const previousRegionalKey = process.env.TEST_REGIONAL_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  process.env.TEST_REGIONAL_KEY = "regional-key";
  const client = new EquivalentBackingFailoverClient();

  try {
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-alias": {
              label: "Primary alias",
              providerId: "minimax",
              protocol: "openai-compatible",
              model: "MiniMax-M2.7-highspeed",
              baseURL: "https://api.minimax.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
            "duplicate-alias": {
              label: "Duplicate alias",
              providerId: "minimax",
              protocol: "openai-compatible",
              model: "MiniMax-M2.7-highspeed",
              baseURL: "https://api.minimax.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
            "active-cache-alias": {
              label: "Active cache alias",
              providerId: "minimax",
              protocol: "openai-compatible",
              model: "MiniMax-M2.7-highspeed",
              baseURL: "https://api.minimax.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
              promptCacheMode: "active",
            },
            "regional-model": {
              label: "Regional fallback",
              providerId: "minimax-cn",
              protocol: "openai-compatible",
              model: "MiniMax-M2.7-highspeed",
              baseURL: "https://api.minimaxi.example/v1",
              apiKeyEnv: "TEST_REGIONAL_KEY",
            },
          },
          modelChains: {
            lead_reasoning: {
              primary: "primary-alias",
              fallbacks: ["duplicate-alias", "active-cache-alias", "regional-model"],
            },
          },
        })
      ),
      clients: [client],
    });

    const result = await gateway.generate({
      modelChainId: "lead_reasoning",
      messages: [
        {
          role: "user",
          content: "Use equivalent alias de-duplication.",
        },
      ],
    });

    assert.equal(result.text, "regional model response");
    assert.equal(result.modelId, "regional-model");
    assert.deepEqual(client.attemptedModelIds, [
      "primary-alias",
      "active-cache-alias",
      "regional-model",
    ]);
    assert.deepEqual(result.attemptedModelIds, [
      "primary-alias",
      "active-cache-alias",
      "regional-model",
    ]);
  } finally {
    if (previousPrimaryKey == null) {
      delete process.env.TEST_PRIMARY_KEY;
    } else {
      process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
    if (previousRegionalKey == null) {
      delete process.env.TEST_REGIONAL_KEY;
    } else {
      process.env.TEST_REGIONAL_KEY = previousRegionalKey;
    }
  }
});

test("llm gateway aborts provider requests that exceed the configured timeout", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  const client = new HangingProtocolClient();
  const lifecycle: ProviderLifecycleEvent[] = [];

  try {
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-model": {
              label: "Primary",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "primary-model",
              baseURL: "https://primary.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
          },
        })
      ),
      clients: [client],
      requestTimeoutMs: 5,
    });

    await assert.rejects(
      () =>
        gateway.generate({
          modelId: "primary-model",
          messages: [{ role: "user", content: "Hang forever." }],
          onProviderLifecycle: (event) => {
            lifecycle.push(event);
          },
        }),
      /llm_request_timeout: model primary-model produced no provider activity for 5ms/
    );
    assert.equal(client.signal?.aborted, true);
    assert.equal(lifecycle[0]?.kind, "attempt_started");
    assert.equal(
      lifecycle.filter((event) => event.kind === "attempt_started").length,
      2,
    );
    assert.equal(lifecycle.at(-1)?.kind, "attempt_failed");
  } finally {
    if (previousPrimaryKey == null) {
      delete process.env.TEST_PRIMARY_KEY;
    } else {
      process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
  }
});

test("llm gateway treats provider activity as an idle-timeout heartbeat", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  try {
    const lifecycle: ProviderLifecycleEvent[] = [];
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-model": {
              label: "Primary",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "primary-model",
              baseURL: "https://primary.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
          },
        }),
      ),
      clients: [new ActiveLongRunningProtocolClient()],
      requestTimeoutMs: 50,
    });

    const result = await gateway.generate({
      modelId: "primary-model",
      messages: [{ role: "user", content: "Take your time." }],
      onProviderLifecycle: (event) => {
        lifecycle.push(event);
      },
    });

    assert.equal(result.text, "healthy long response");
    assert.equal(
      lifecycle.filter((event) => event.kind === "activity").length,
      2,
    );
  } finally {
    if (previousPrimaryKey == null) {
      delete process.env.TEST_PRIMARY_KEY;
    } else {
      process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
  }
});

test("llm gateway caps request and retry work at the shared absolute deadline", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  const client = new HangingProtocolClient();
  const retryDelays: number[] = [];
  const lifecycle: ProviderLifecycleEvent[] = [];
  try {
    const gateway = new LLMGateway({
      registry: new ModelRegistry(
        new InMemoryCatalogSource({
          models: {
            "primary-model": {
              label: "Primary",
              providerId: "openai",
              protocol: "openai-compatible",
              model: "primary-model",
              baseURL: "https://primary.example/v1",
              apiKeyEnv: "TEST_PRIMARY_KEY",
            },
          },
        }),
      ),
      clients: [client],
      requestTimeoutMs: 1_000,
      generateWallClockMs: 1_000,
      retrySleep: async (delayMs) => {
        retryDelays.push(delayMs);
      },
    });
    const startedAt = Date.now();

    await assert.rejects(
      () =>
        gateway.generate({
          modelId: "primary-model",
          deadlineAt: startedAt + 20,
          messages: [{ role: "user", content: "Stop at the run deadline." }],
          onProviderLifecycle: (event) => {
            lifecycle.push(event);
          },
        }),
      /llm_request_timeout/,
    );

    assert.ok(Date.now() - startedAt < 250);
    assert.equal(
      lifecycle.filter((event) => event.kind === "attempt_started").length,
      1,
    );
    assert.deepEqual(retryDelays, []);
    assert.equal(client.signal?.aborted, true);
  } finally {
    if (previousPrimaryKey == null) {
      delete process.env.TEST_PRIMARY_KEY;
    } else {
      process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
  }
});

for (const [name, activityBeforeStall] of [
  ["before response headers", false],
  ["between streaming events", true],
] as const) {
  test(`llm gateway bounds a provider stall ${name}`, async () => {
    const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
    process.env.TEST_PRIMARY_KEY = "primary-key";
    const client = new StalledStreamingProtocolClient(activityBeforeStall);
    const retryDelays: number[] = [];
    try {
      const gateway = new LLMGateway({
        registry: new ModelRegistry(
          new InMemoryCatalogSource({
            models: {
              "primary-model": {
                label: "Primary",
                providerId: "anthropic",
                protocol: "anthropic-compatible",
                model: "primary-model",
                baseURL: "https://primary.example/v1",
                apiKeyEnv: "TEST_PRIMARY_KEY",
              },
            },
          }),
        ),
        clients: [client],
        streamIdleTimeoutMs: 40,
        generateWallClockMs: 1_000,
        retrySleep: async (delayMs) => {
          retryDelays.push(delayMs);
        },
        retryRandom: () => 1,
      });
      const startedAt = Date.now();

      await assert.rejects(
        () => gateway.generate({
          modelId: "primary-model",
          deadlineAt: startedAt + 60,
          messages: [{ role: "user", content: "Bound the stalled stream." }],
        }),
        /llm_request_timeout/,
      );

      assert.ok(Date.now() - startedAt < (activityBeforeStall ? 85 : 70));
      assert.equal(client.signal?.aborted, true);
      assert.deepEqual(retryDelays, []);
    } finally {
      if (previousPrimaryKey == null) delete process.env.TEST_PRIMARY_KEY;
      else process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("llm gateway exposes model chains and default selection for operator settings", async () => {
  const gateway = new LLMGateway({
    registry: new ModelRegistry(
      new InMemoryCatalogSource({
        defaultModelChainId: "reasoning_primary",
        models: {
          "primary-model": {
            label: "Primary",
            providerId: "openai",
            protocol: "openai-compatible",
            model: "primary-model",
            baseURL: "https://primary.example/v1",
            apiKeyEnv: "TEST_PRIMARY_KEY",
          },
          "fallback-model": {
            label: "Fallback",
            providerId: "openai",
            protocol: "openai-compatible",
            model: "fallback-model",
            baseURL: "https://fallback.example/v1",
            apiKeyEnv: "TEST_FALLBACK_KEY",
          },
        },
        modelChains: {
          reasoning_primary: {
            primary: "primary-model",
            fallbacks: ["fallback-model"],
          },
        },
      })
    ),
    clients: [new SuccessProtocolClient()],
  });

  const chains = await gateway.listModelChains();
  assert.equal(chains[0]?.id, "reasoning_primary");
  assert.equal(chains[0]?.primary, "primary-model");
  assert.deepEqual(chains[0]?.fallbacks, ["fallback-model"]);

  const selection = await gateway.describeSelection({});
  assert.equal(selection.chainId, "reasoning_primary");
  assert.equal(selection.primary.id, "primary-model");
  assert.deepEqual(selection.fallbacks.map((model) => model.id), ["fallback-model"]);
});

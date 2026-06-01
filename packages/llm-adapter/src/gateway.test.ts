import assert from "node:assert/strict";
import test from "node:test";

import { LLMGateway } from "./gateway";
import { ModelRegistry } from "./registry";
import type { GenerateTextInput, GenerateTextResult, ModelCatalog, ModelCatalogSource, ModelProtocol, ProtocolClient, ResolvedModelConfig } from "./types";

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

test("llm gateway aborts provider requests that exceed the configured timeout", async () => {
  const previousPrimaryKey = process.env.TEST_PRIMARY_KEY;
  process.env.TEST_PRIMARY_KEY = "primary-key";
  const client = new HangingProtocolClient();

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
        }),
      /llm_request_timeout: model primary-model did not respond within 5ms/
    );
    assert.equal(client.signal?.aborted, true);
  } finally {
    if (previousPrimaryKey == null) {
      delete process.env.TEST_PRIMARY_KEY;
    } else {
      process.env.TEST_PRIMARY_KEY = previousPrimaryKey;
    }
  }
});

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

import assert from "node:assert/strict";
import test from "node:test";

import { ModelRegistry } from "./registry";
import type { ModelCatalog, ModelCatalogSource } from "./types";

class InMemoryCatalogSource implements ModelCatalogSource {
  constructor(private readonly catalog: ModelCatalog) {}

  async load(): Promise<ModelCatalog> {
    return this.catalog;
  }
}

test("model registry normalizes object-based model and chain catalogs", async () => {
  const previousApiKey = process.env.TEST_MINIMAX_API_KEY;
  const previousBaseUrl = process.env.TEST_MINIMAX_BASE_URL;
  process.env.TEST_MINIMAX_API_KEY = "test-minimax-key";
  process.env.TEST_MINIMAX_BASE_URL = "https://minimax.example/v1";

  try {
    const registry = new ModelRegistry(
      new InMemoryCatalogSource({
        defaultModelId: "gpt-5",
        defaultModelChainId: "reasoning_primary",
        models: {
          "gpt-5": {
            label: "GPT 5",
            providerId: "openai",
            protocol: "openai-compatible",
            model: "gpt-5",
            baseURL: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
          },
          minimax_reasoning: {
            label: "MiniMax Reasoning",
            providerId: "minimax",
            apiType: "anthropic",
            model: "MiniMax-M2.7-highspeed",
            baseURLEnv: "TEST_MINIMAX_BASE_URL",
            apiKeyEnv: "TEST_MINIMAX_API_KEY",
          },
        },
        modelChains: {
          reasoning_primary: {
            primary: "minimax_reasoning",
            fallbacks: ["gpt-5"],
          },
        },
      })
    );

    const chains = await registry.listChains();
    assert.equal(chains.length, 1);
    assert.equal(chains[0]?.id, "reasoning_primary");
    assert.equal(chains[0]?.primary, "minimax_reasoning");
    assert.deepEqual(chains[0]?.fallbacks, ["gpt-5"]);

    const described = await registry.describeSelection({ modelChainId: "reasoning_primary" });
    assert.equal(described.primary.id, "minimax_reasoning");
    assert.equal(described.primary.protocol, "anthropic-compatible");
    assert.equal(described.fallbacks[0]?.id, "gpt-5");

    const resolved = await registry.resolve("minimax_reasoning");
    assert.equal(resolved.baseURL, "https://minimax.example/v1");
    assert.equal(resolved.apiKey, "test-minimax-key");
    assert.equal(resolved.protocol, "anthropic-compatible");
  } finally {
    if (previousApiKey == null) {
      delete process.env.TEST_MINIMAX_API_KEY;
    } else {
      process.env.TEST_MINIMAX_API_KEY = previousApiKey;
    }
    if (previousBaseUrl == null) {
      delete process.env.TEST_MINIMAX_BASE_URL;
    } else {
      process.env.TEST_MINIMAX_BASE_URL = previousBaseUrl;
    }
  }
});

test("model registry falls back to model ref when a requested chain does not exist", async () => {
  const registry = new ModelRegistry(
    new InMemoryCatalogSource({
      defaultModelId: "gpt-5",
      models: [
        {
          id: "gpt-5",
          label: "GPT 5",
          providerId: "openai",
          protocol: "openai-compatible",
          model: "gpt-5",
          baseURL: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      ],
    })
  );

  const selection = await registry.resolveSelection({
    modelId: "gpt-5",
    modelChainId: "missing_chain",
  });

  assert.equal(selection.primaryModelId, "gpt-5");
  assert.deepEqual(selection.fallbackModelIds, []);
});

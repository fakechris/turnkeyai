import assert from "node:assert/strict";
import test from "node:test";

import { LLMGateway } from "./gateway";
import {
  RequestEnvelopeOverflowError,
  buildProviderRequestEnvelopeOverflowError,
  buildRequestEnvelopeDiagnostics,
  isProviderSizeLikeFailure,
  resolveRequestEnvelopeLimits,
} from "./request-envelope-guard";
import { ModelRegistry } from "./registry";
import type { GenerateTextInput, GenerateTextResult, ModelCatalogSource, ProtocolClient, ResolvedModelConfig } from "./types";

class InMemoryCatalogSource implements ModelCatalogSource {
  async load() {
    return {
      defaultModelId: "test-model",
      models: [
        {
          id: "test-model",
          label: "Test Model",
          providerId: "test",
          protocol: "openai-compatible" as const,
          model: "test-model",
          baseURL: "https://example.com",
          apiKeyEnv: "TEST_MODEL_API_KEY",
        },
      ],
    };
  }
}

class StubClient implements ProtocolClient {
  constructor(private readonly impl: (model: ResolvedModelConfig, input: GenerateTextInput) => Promise<GenerateTextResult>) {}

  supports(): boolean {
    return true;
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.impl(model, input);
  }
}

test("request envelope diagnostics count prompt bytes, metadata bytes, and artifacts", () => {
  const diagnostics = buildRequestEnvelopeDiagnostics({
    modelId: "test-model",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Summarize the pricing blocker." },
    ],
    metadata: {
      threadId: "thread-1",
      flowId: "flow-1",
    },
    envelope: {
      artifactIds: ["artifact-1", "artifact-2"],
    },
  });

  assert.equal(diagnostics.messageCount, 2);
  assert.equal(diagnostics.artifactCount, 2);
  assert.equal(diagnostics.toolCount, 0);
  assert.equal(diagnostics.toolResultCount, 0);
  assert.equal(diagnostics.inlineImageCount, 0);
  assert.equal(diagnostics.inlineAttachmentBytes, 0);
  assert.ok(diagnostics.promptBytes > 0);
  assert.ok(diagnostics.metadataBytes > 0);
  assert.equal(diagnostics.overLimitKeys.length, 0);
});

test("request envelope limits resolve per protocol/provider with stricter media caps", () => {
  const openaiLimits = resolveRequestEnvelopeLimits({
    protocol: "openai-compatible",
    providerId: "openai",
    model: "gpt-test",
  });
  const anthropicLimits = resolveRequestEnvelopeLimits({
    protocol: "anthropic-compatible",
    providerId: "anthropic",
    model: "claude-test",
  });

  assert.ok(openaiLimits.maxInlineImageBytes > anthropicLimits.maxInlineImageBytes);
  assert.ok(openaiLimits.maxToolSchemaBytes > anthropicLimits.maxToolSchemaBytes);
  assert.ok(openaiLimits.maxMultimodalPartCount > anthropicLimits.maxMultimodalPartCount);
});

test("gateway blocks oversized request envelopes before the protocol client runs", async () => {
  const originalKey = process.env.TEST_MODEL_API_KEY;
  process.env.TEST_MODEL_API_KEY = "test-key";

  try {
    let clientCalled = false;
    const gateway = new LLMGateway({
      registry: new ModelRegistry(new InMemoryCatalogSource()),
      clients: [
        new StubClient(async () => {
          clientCalled = true;
          return {
            text: "should not happen",
            modelId: "test-model",
            providerId: "test",
            protocol: "openai-compatible",
            adapterName: "stub",
            raw: {},
          };
        }),
      ],
    });

    await assert.rejects(
      () =>
        gateway.generate({
          modelId: "test-model",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "x".repeat(200_000) },
          ],
        }),
      (error: unknown) => {
        assert.equal(clientCalled, false);
        assert.ok(error instanceof RequestEnvelopeOverflowError);
        assert.equal(error.code, "REQUEST_ENVELOPE_OVERFLOW");
        assert.equal(error.retryable, false);
        assert.ok(error.details.diagnostics.overLimitKeys.includes("promptChars"));
        assert.ok(error.details.diagnostics.overLimitKeys.includes("promptBytes"));
        return true;
      }
    );
  } finally {
    if (originalKey === undefined) {
      delete process.env.TEST_MODEL_API_KEY;
    } else {
      process.env.TEST_MODEL_API_KEY = originalKey;
    }
  }
});

test("gateway returns request envelope diagnostics on successful model calls", async () => {
  process.env.TEST_MODEL_API_KEY = "test-key";

  const gateway = new LLMGateway({
    registry: new ModelRegistry(new InMemoryCatalogSource()),
    clients: [
      new StubClient(async (_model, input) => ({
        text: "ok",
        modelId: input.modelId ?? "test-model",
        providerId: "test",
        protocol: "openai-compatible",
        adapterName: "stub",
        raw: {},
      })),
    ],
  });

  const result = await gateway.generate({
    modelId: "test-model",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Summarize the current thread state." },
    ],
    envelope: {
      artifactIds: ["artifact-1"],
    },
  });

  assert.equal(result.text, "ok");
  assert.equal(result.requestEnvelope?.artifactCount, 1);
  assert.equal(result.requestEnvelope?.messageCount, 2);
  assert.equal(result.requestEnvelope?.overLimitKeys.length, 0);
});

test("provider size-like failures are normalized into request envelope overflow", () => {
  assert.equal(isProviderSizeLikeFailure({ status: 413, message: "payload too large" }), true);
  assert.equal(isProviderSizeLikeFailure({ status: 500, message: "maximum context length exceeded" }), true);
  assert.equal(isProviderSizeLikeFailure({ status: 500, message: "internal server error" }), false);

  const error = buildProviderRequestEnvelopeOverflowError({
    request: {
      modelId: "test-model",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "x".repeat(10_000) },
      ],
      envelope: {
        toolCount: 12,
        toolSchemaBytes: 40_000,
        toolResultCount: 6,
        toolResultBytes: 18_000,
        inlineAttachmentBytes: 10_000,
        inlineImageCount: 2,
        inlineImageBytes: 50_000,
        inlinePdfCount: 1,
        inlinePdfBytes: 10_000,
        multimodalPartCount: 4,
      },
    },
    status: 413,
    message: "request too large for model context",
  });

  assert.ok(error instanceof RequestEnvelopeOverflowError);
  assert.equal(error.code, "REQUEST_ENVELOPE_OVERFLOW");
  assert.equal(error.details.source, "provider");
  assert.equal(error.details.providerStatus, 413);
  assert.match(error.details.providerMessage ?? "", /request too large/i);
  assert.equal(error.details.diagnostics.toolCount, 12);
  assert.equal(error.details.diagnostics.toolSchemaBytes, 40_000);
  assert.equal(error.details.diagnostics.toolResultCount, 6);
  assert.equal(error.details.diagnostics.inlineImageCount, 2);
});

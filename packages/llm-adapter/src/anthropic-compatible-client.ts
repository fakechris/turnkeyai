import type { GenerateTextInput, GenerateTextResult, ModelProtocol, ProtocolClient, ResolvedModelConfig } from "./types";
import { buildProviderRequestEnvelopeOverflowError, isProviderSizeLikeFailure } from "./request-envelope-guard";

export class AnthropicCompatibleClient implements ProtocolClient {
  supports(protocol: ModelProtocol): boolean {
    return protocol === "anthropic-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    const systemMessages = input.messages.filter((item) => item.role === "system").map((item) => item.content);
    const chatMessages = input.messages
      .filter((item) => item.role !== "system")
      .map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.content,
      }));

    const response = await fetch(buildURL(model.baseURL, "/messages", model.query), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": model.apiKey,
        "anthropic-version": "2023-06-01",
        ...model.headers,
      },
      body: JSON.stringify({
        model: model.model,
        system: systemMessages.join("\n\n"),
        messages: chatMessages,
        temperature: input.temperature ?? model.temperature,
        max_tokens: input.maxOutputTokens ?? model.maxOutputTokens ?? 1024,
      }),
    });

    const raw = await response.json();
    if (!response.ok) {
      const message = raw?.error?.message ?? `anthropic-compatible request failed: ${response.status}`;
      if (isProviderSizeLikeFailure({ status: response.status, message })) {
        throw buildProviderRequestEnvelopeOverflowError({
          request: input,
          model,
          status: response.status,
          message,
        });
      }
      throw new Error(message);
    }

    return {
      text: extractAnthropicContent(raw?.content),
      modelId: input.modelId ?? model.id,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "anthropic-compatible",
      stopReason: raw?.stop_reason,
      usage: {
        inputTokens: raw?.usage?.input_tokens,
        outputTokens: raw?.usage?.output_tokens,
      },
      raw,
    };
  }
}

function buildURL(baseURL: string, pathname: string, query?: Record<string, string>): string {
  const url = new URL(pathname, ensureTrailingSlash(baseURL));
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function extractAnthropicContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      if ("text" in item) {
        return String((item as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

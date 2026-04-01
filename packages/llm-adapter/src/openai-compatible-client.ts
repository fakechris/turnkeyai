import type { GenerateTextInput, GenerateTextResult, ModelProtocol, ProtocolClient, ResolvedModelConfig } from "./types";
import { buildProviderRequestEnvelopeOverflowError, isProviderSizeLikeFailure } from "./request-envelope-guard";

export class OpenAICompatibleClient implements ProtocolClient {
  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    const response = await fetch(buildURL(model.baseURL, "/chat/completions", model.query), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${model.apiKey}`,
        ...model.headers,
      },
      body: JSON.stringify({
        model: model.model,
        messages: input.messages.map((item) => ({
          role: item.role,
          content: item.content,
        })),
        temperature: input.temperature ?? model.temperature,
        max_tokens: input.maxOutputTokens ?? model.maxOutputTokens,
      }),
    });

    const raw = await response.json();
    if (!response.ok) {
      const message = raw?.error?.message ?? `openai-compatible request failed: ${response.status}`;
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

    const firstChoice = raw?.choices?.[0];
    const text = extractOpenAIContent(firstChoice?.message?.content);

    return {
      text,
      modelId: input.modelId,
      providerId: model.providerId,
      protocol: model.protocol,
      adapterName: "openai-compatible",
      stopReason: firstChoice?.finish_reason,
      usage: {
        inputTokens: raw?.usage?.prompt_tokens,
        outputTokens: raw?.usage?.completion_tokens,
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

function extractOpenAIContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }

  return "";
}

import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMContentBlock,
  LLMMessage,
  LLMToolChoice,
  LLMToolCall,
  ModelProtocol,
  ProtocolClient,
  ResolvedModelConfig,
} from "./types";
import { buildProviderRequestEnvelopeOverflowError, isProviderSizeLikeFailure } from "./request-envelope-guard";

export class OpenAICompatibleClient implements ProtocolClient {
  supports(protocol: ModelProtocol): boolean {
    return protocol === "openai-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    // Relative pathname (no leading slash) so providers whose baseURL
    // carries a routing prefix (e.g. `/v1`) don't get their path
    // stripped by URL resolution. For canonical OpenAI
    // (`https://api.openai.com/v1/`) the result is identical:
    // .../v1/chat/completions.
    const response = await fetch(buildURL(model.baseURL, "chat/completions", model.query), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${model.apiKey}`,
        ...model.headers,
      },
      body: JSON.stringify({
        model: model.model,
        messages: input.messages.map(toOpenAIMessage),
        temperature: input.temperature ?? model.temperature,
        max_tokens: input.maxOutputTokens ?? model.maxOutputTokens,
        ...(input.tools?.length
          ? {
              tools: input.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
        ...(input.toolChoice ? { tool_choice: toOpenAIToolChoice(input.toolChoice) } : {}),
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
    const contentBlocks = extractOpenAIContentBlocks(firstChoice?.message);
    const text = contentBlocks
      .filter((block): block is Extract<LLMContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = extractOpenAIToolCalls(firstChoice?.message?.tool_calls);

    return {
      text,
      contentBlocks,
      ...(toolCalls.length ? { toolCalls } : {}),
      modelId: input.modelId ?? model.id,
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

function toOpenAIMessage(message: LLMMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: contentAsText(message.content),
      ...(message.name ? { name: message.name } : {}),
    };
  }

  const contentBlocks = Array.isArray(message.content) ? message.content : null;
  if (message.role === "assistant" && contentBlocks) {
    const toolCalls = contentBlocks
      .filter((block): block is Extract<LLMContentBlock, { type: "tool_use" }> => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      }));
    return {
      role: "assistant",
      content: contentAsText(message.content) || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
  }

  return {
    role: message.role,
    content: contentAsText(message.content),
  };
}

function toOpenAIToolChoice(choice: LLMToolChoice): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice === "required" ? "required" : choice;
  }
  return {
    type: "function",
    function: {
      name: choice.name,
    },
  };
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

function extractOpenAIContentBlocks(message: unknown): LLMContentBlock[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map((item): LLMContentBlock | null => {
      if (typeof item === "string") {
        return { type: "text" as const, text: item };
      }
      if (isRecord(item) && "text" in item) {
        return { type: "text" as const, text: String(item.text ?? "") };
      }
      return null;
    })
    .filter((item): item is LLMContentBlock => item !== null);
}

function extractOpenAIToolCalls(value: unknown): LLMToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const fn = isRecord(item.function) ? item.function : {};
      const name = typeof fn.name === "string" ? fn.name : "";
      const id = typeof item.id === "string" ? item.id : "";
      if (!id || !name) return null;
      return {
        id,
        name,
        input: parseToolArguments(fn.arguments),
      };
    })
    .filter((item): item is LLMToolCall => item !== null);
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function contentAsText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_result") return block.content;
      return "";
    })
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

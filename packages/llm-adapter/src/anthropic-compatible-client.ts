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
import { sanitizeContentBlocks } from "./provider-output-sanitizer";
import { buildProviderRequestEnvelopeOverflowError, isProviderSizeLikeFailure } from "./request-envelope-guard";

const DEFAULT_ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS = 4096;

export class AnthropicCompatibleClient implements ProtocolClient {
  supports(protocol: ModelProtocol): boolean {
    return protocol === "anthropic-compatible";
  }

  async generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult> {
    const systemMessages = input.messages
      .filter((item) => item.role === "system")
      .map((item) => contentAsText(item.content));
    const chatMessages = input.messages
      .filter((item) => item.role !== "system")
      .map(toAnthropicMessage);

    const tools = input.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    // Relative pathname (no leading slash) so providers whose baseURL
    // carries a routing prefix (e.g. MiniMax's
    // `https://api.minimaxi.com/anthropic/v1/`) don't get their path
    // stripped by URL resolution. For canonical Anthropic
    // (`https://api.anthropic.com/v1/`) the result is identical:
    // .../v1/messages.
    const response = await fetch(buildURL(model.baseURL, "messages", model.query), {
      method: "POST",
      ...(input.signal ? { signal: input.signal } : {}),
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
        max_tokens:
          input.maxOutputTokens ??
          model.maxOutputTokens ??
          DEFAULT_ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS,
        ...(tools?.length ? { tools } : {}),
        ...(input.toolChoice ? { tool_choice: toAnthropicToolChoice(input.toolChoice) } : {}),
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

    const contentBlocks = sanitizeContentBlocks(extractAnthropicContentBlocks(raw?.content));
    const toolCalls = extractToolCalls(contentBlocks);
    return {
      text: contentBlocks
        .filter((block): block is Extract<LLMContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join(""),
      contentBlocks,
      ...(toolCalls.length ? { toolCalls } : {}),
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

function toAnthropicMessage(message: LLMMessage): { role: "user" | "assistant"; content: unknown } {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: contentAsText(message.content),
          ...(contentHasErrorToolResult(message.content) ? { is_error: true } : {}),
        },
      ],
    };
  }

  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: toAnthropicContent(message.content),
  };
}

function toAnthropicContent(content: LLMMessage["content"]): unknown {
  if (typeof content === "string") {
    return content;
  }
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    return {
      type: "tool_result",
      tool_use_id: block.toolUseId,
      content: block.content,
      ...(block.isError ? { is_error: true } : {}),
    };
  });
}

function toAnthropicToolChoice(choice: LLMToolChoice): unknown {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
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

function extractAnthropicContentBlocks(content: unknown): LLMContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((item): LLMContentBlock | null => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      if (record.type === "text" || "text" in record) {
        return {
          type: "text" as const,
          text: String(record.text ?? ""),
        };
      }
      if (record.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: String(record.id ?? ""),
          name: String(record.name ?? ""),
          input: isRecord(record.input) ? record.input : {},
        };
      }
      return null;
    })
    .filter((item): item is LLMContentBlock => item !== null);
}

function extractToolCalls(blocks: LLMContentBlock[]): LLMToolCall[] {
  return blocks
    .filter((block): block is Extract<LLMContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .filter((block) => block.id.length > 0 && block.name.length > 0)
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
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

function contentHasErrorToolResult(content: LLMMessage["content"]): boolean {
  return Array.isArray(content) && content.some((block) => block.type === "tool_result" && block.isError === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

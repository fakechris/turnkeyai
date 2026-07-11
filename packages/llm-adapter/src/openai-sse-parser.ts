import { normalizeOpenAITokenUsage } from "./model-cache-usage";
import type { LLMTokenUsage, LLMToolCall } from "./types";

export interface OpenAIStreamResult {
  text: string;
  toolCalls: LLMToolCall[];
  finishReason?: string;
  usage?: LLMTokenUsage;
  eventCount: number;
}

export class OpenAIStreamInterruptedError extends Error {
  readonly partialText: string;
  readonly partialTextBytes: number;
  readonly sawToolCallFragments: boolean;
  readonly completedToolCalls: readonly LLMToolCall[] = [];

  constructor(
    message: string,
    input: {
      partialText: string;
      sawToolCallFragments: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "OpenAIStreamInterruptedError";
    this.partialText = input.partialText;
    this.partialTextBytes = Buffer.byteLength(input.partialText, "utf8");
    this.sawToolCallFragments = input.sawToolCallFragments;
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}

export async function consumeOpenAIChatCompletionStream(
  response: Response,
  options: {
    onActivity?: () => void;
  } = {},
): Promise<OpenAIStreamResult> {
  if (!response.body) {
    throw new OpenAIStreamInterruptedError(
      "openai-compatible stream interrupted: response body is unavailable",
      { partialText: "", sawToolCallFragments: false },
    );
  }

  const state = createStreamState();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      buffer = normalizeSseNewlines(buffer, false);
      buffer = consumeCompleteSseEvents(buffer, state);
      if (state.done) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    buffer += decoder.decode();
    buffer = normalizeSseNewlines(buffer, true);
    if (buffer.trim()) {
      consumeSseEvent(buffer, state);
    }
  } catch (error) {
    throw interruptedStreamError(state, error);
  } finally {
    reader.releaseLock();
  }

  if (!state.done && !state.finishReason) {
    throw interruptedStreamError(
      state,
      new Error("stream ended before [DONE] or finish_reason"),
    );
  }
  return {
    text: state.text,
    toolCalls: finalizeToolCalls(state.toolCalls),
    ...(state.finishReason ? { finishReason: state.finishReason } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    eventCount: state.eventCount,
  };
}

interface ToolCallFragments {
  id: string;
  name: string;
  arguments: string;
}

interface StreamState {
  text: string;
  toolCalls: Map<number, ToolCallFragments>;
  finishReason: string | undefined;
  usage: LLMTokenUsage | undefined;
  eventCount: number;
  done: boolean;
}

function createStreamState(): StreamState {
  return {
    text: "",
    toolCalls: new Map(),
    finishReason: undefined,
    usage: undefined,
    eventCount: 0,
    done: false,
  };
}

function normalizeSseNewlines(value: string, final: boolean): string {
  const hasPendingCarriageReturn = !final && value.endsWith("\r");
  const complete = hasPendingCarriageReturn ? value.slice(0, -1) : value;
  return (
    complete.replaceAll("\r\n", "\n").replaceAll("\r", "\n") +
    (hasPendingCarriageReturn ? "\r" : "")
  );
}

function consumeCompleteSseEvents(
  input: string,
  state: StreamState,
): string {
  let buffer = input;
  while (!state.done) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary < 0) break;
    consumeSseEvent(buffer.slice(0, boundary), state);
    buffer = buffer.slice(boundary + 2);
  }
  return buffer;
}

function consumeSseEvent(rawEvent: string, state: StreamState): void {
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return;
  if (data === "[DONE]") {
    state.done = true;
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch (error) {
    throw interruptedStreamError(state, error);
  }
  if (!isRecord(event)) return;
  state.eventCount += 1;
  consumeUsage(event.usage, state);
  const choices = Array.isArray(event.choices) ? event.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      state.finishReason = choice.finish_reason;
    }
    consumeDelta(choice.delta, state);
  }
}

function consumeUsage(value: unknown, state: StreamState): void {
  const usage = normalizeOpenAITokenUsage(value);
  if (usage) state.usage = usage;
}

function consumeDelta(value: unknown, state: StreamState): void {
  if (!isRecord(value)) return;
  state.text += readDeltaText(value.content);
  if (!Array.isArray(value.tool_calls)) return;
  for (const item of value.tool_calls) {
    if (!isRecord(item)) continue;
    const index = finiteNumber(item.index);
    if (index === undefined || index < 0 || !Number.isInteger(index)) continue;
    const current = state.toolCalls.get(index) ?? {
      id: "",
      name: "",
      arguments: "",
    };
    if (typeof item.id === "string") current.id += item.id;
    const fn = isRecord(item.function) ? item.function : {};
    if (typeof fn.name === "string") current.name += fn.name;
    if (typeof fn.arguments === "string") current.arguments += fn.arguments;
    state.toolCalls.set(index, current);
  }
}

function readDeltaText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) =>
      isRecord(item) && typeof item.text === "string" ? item.text : "",
    )
    .join("");
}

function finalizeToolCalls(
  fragments: Map<number, ToolCallFragments>,
): LLMToolCall[] {
  return [...fragments.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => {
      if (!item.id || !item.name) return null;
      return {
        id: item.id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      };
    })
    .filter((item): item is LLMToolCall => item !== null);
}

function parseToolArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function interruptedStreamError(
  state: StreamState,
  cause: unknown,
): OpenAIStreamInterruptedError {
  if (cause instanceof OpenAIStreamInterruptedError) return cause;
  return new OpenAIStreamInterruptedError(
    "openai-compatible stream interrupted before completion",
    {
      partialText: state.text,
      sawToolCallFragments: state.toolCalls.size > 0,
      cause,
    },
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

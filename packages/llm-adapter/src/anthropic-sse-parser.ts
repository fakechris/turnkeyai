import { normalizeAnthropicTokenUsage } from "./model-cache-usage";
import {
  ProviderRequestError,
  type LLMContentBlock,
  type LLMTokenUsage,
  type LLMToolCall,
  type ProviderActivityKind,
} from "./types";

export interface AnthropicStreamResult {
  text: string;
  contentBlocks: LLMContentBlock[];
  toolCalls: LLMToolCall[];
  stopReason?: string;
  usage?: LLMTokenUsage;
  eventCount: number;
}

export class AnthropicStreamInterruptedError extends Error {
  readonly partialText: string;
  readonly partialTextBytes: number;
  readonly sawToolCallFragments: boolean;
  readonly completedToolCalls: readonly LLMToolCall[] = [];

  constructor(input: {
    partialText: string;
    sawToolCallFragments: boolean;
    cause?: unknown;
  }) {
    super("anthropic-compatible stream interrupted before message_stop");
    this.name = "AnthropicStreamInterruptedError";
    this.partialText = input.partialText;
    this.partialTextBytes = Buffer.byteLength(input.partialText, "utf8");
    this.sawToolCallFragments = input.sawToolCallFragments;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

interface TextBlockState {
  type: "text";
  text: string;
}

interface ToolBlockState {
  type: "tool_use";
  id: string;
  name: string;
  initialInput: Record<string, unknown>;
  partialJson: string;
}

type BlockState = TextBlockState | ToolBlockState;

interface StreamState {
  blocks: Map<number, BlockState>;
  stopReason: string | undefined;
  usage: Record<string, unknown>;
  eventCount: number;
  done: boolean;
}

export async function consumeAnthropicMessageStream(
  response: Response,
  options: {
    signal?: AbortSignal;
    onActivity?: (kind: ProviderActivityKind) => void;
  } = {},
): Promise<AnthropicStreamResult> {
  if (!response.body) {
    throw interrupted(createState(), new Error("response body is unavailable"));
  }
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("stream aborted");
  }

  const state = createState();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!state.done) {
      const { done, value } = await readWithSignal(reader, options.signal);
      if (done) break;
      options.onActivity?.("body");
      buffer += decoder.decode(value, { stream: true });
      buffer = normalizeSseNewlines(buffer, false);
      buffer = consumeCompleteEvents(buffer, state, options.onActivity);
    }
    buffer += decoder.decode();
    buffer = normalizeSseNewlines(buffer, true);
    if (!state.done && buffer.trim()) {
      consumeEvent(buffer, state);
      options.onActivity?.("event");
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    if (error instanceof ProviderRequestError) throw error;
    throw interrupted(state, error);
  } finally {
    if (state.done) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // An aborting stream may still be unwinding its pending read.
    }
  }

  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("stream aborted");
  }
  if (!state.done) {
    throw interrupted(state, new Error("stream ended before message_stop"));
  }

  const contentBlocks = finalizeContentBlocks(state.blocks);
  const toolCalls = contentBlocks
    .filter((block): block is Extract<LLMContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
  const text = contentBlocks
    .filter((block): block is Extract<LLMContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  const usage = normalizeAnthropicTokenUsage(state.usage);
  return {
    text,
    contentBlocks,
    toolCalls,
    ...(state.stopReason ? { stopReason: state.stopReason } : {}),
    ...(usage ? { usage } : {}),
    eventCount: state.eventCount,
  };
}

function createState(): StreamState {
  return {
    blocks: new Map(),
    stopReason: undefined,
    usage: {},
    eventCount: 0,
    done: false,
  };
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw signal.reason ?? new Error("stream aborted");
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason = signal.reason ?? new Error("stream aborted");
      void reader.cancel(reason).catch(() => undefined);
      reject(reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function normalizeSseNewlines(value: string, final: boolean): string {
  const pendingCarriageReturn = !final && value.endsWith("\r");
  const complete = pendingCarriageReturn ? value.slice(0, -1) : value;
  return complete.replaceAll("\r\n", "\n").replaceAll("\r", "\n") +
    (pendingCarriageReturn ? "\r" : "");
}

function consumeCompleteEvents(
  input: string,
  state: StreamState,
  onActivity?: (kind: ProviderActivityKind) => void,
): string {
  let buffer = input;
  while (!state.done) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary < 0) break;
    const rawEvent = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    if (consumeEvent(rawEvent, state)) onActivity?.("event");
  }
  return buffer;
}

function consumeEvent(rawEvent: string, state: StreamState): boolean {
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return false;

  const event = JSON.parse(data) as unknown;
  if (!isRecord(event)) return false;
  state.eventCount += 1;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "error") {
    const detail = isRecord(event.error) ? event.error : {};
    throw new ProviderRequestError(
      typeof detail.message === "string" ? detail.message : "anthropic-compatible stream error",
      { code: "provider_error", retryable: false },
    );
  }
  if (type === "message_start") {
    const message = isRecord(event.message) ? event.message : {};
    mergeUsage(state.usage, message.usage);
  } else if (type === "content_block_start") {
    startBlock(state, event);
  } else if (type === "content_block_delta") {
    appendBlockDelta(state, event);
  } else if (type === "message_delta") {
    const delta = isRecord(event.delta) ? event.delta : {};
    if (typeof delta.stop_reason === "string" && delta.stop_reason) {
      state.stopReason = delta.stop_reason;
    }
    mergeUsage(state.usage, event.usage);
  } else if (type === "message_stop") {
    state.done = true;
  }
  return true;
}

function startBlock(state: StreamState, event: Record<string, unknown>): void {
  const index = blockIndex(event.index);
  const block = isRecord(event.content_block) ? event.content_block : null;
  if (index === undefined || !block) return;
  if (block.type === "text") {
    state.blocks.set(index, {
      type: "text",
      text: typeof block.text === "string" ? block.text : "",
    });
  } else if (block.type === "tool_use") {
    state.blocks.set(index, {
      type: "tool_use",
      id: typeof block.id === "string" ? block.id : "",
      name: typeof block.name === "string" ? block.name : "",
      initialInput: isRecord(block.input) ? block.input : {},
      partialJson: "",
    });
  }
}

function appendBlockDelta(state: StreamState, event: Record<string, unknown>): void {
  const index = blockIndex(event.index);
  const delta = isRecord(event.delta) ? event.delta : null;
  if (index === undefined || !delta) return;
  const block = state.blocks.get(index);
  if (delta.type === "text_delta" && block?.type === "text" && typeof delta.text === "string") {
    block.text += delta.text;
  } else if (
    delta.type === "input_json_delta" &&
    block?.type === "tool_use" &&
    typeof delta.partial_json === "string"
  ) {
    block.partialJson += delta.partial_json;
  }
}

function mergeUsage(target: Record<string, unknown>, value: unknown): void {
  if (!isRecord(value)) return;
  Object.assign(target, value);
}

function finalizeContentBlocks(blocks: Map<number, BlockState>): LLMContentBlock[] {
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]): LLMContentBlock | null => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (!block.id || !block.name) return null;
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.partialJson ? parseJsonObject(block.partialJson) : block.initialInput,
      };
    })
    .filter((block): block is LLMContentBlock => block !== null);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function interrupted(state: StreamState, cause: unknown): AnthropicStreamInterruptedError {
  if (cause instanceof AnthropicStreamInterruptedError) return cause;
  const partialText = [...state.blocks.values()]
    .filter((block): block is TextBlockState => block.type === "text")
    .map((block) => block.text)
    .join("");
  return new AnthropicStreamInterruptedError({
    partialText,
    sawToolCallFragments: [...state.blocks.values()].some((block) => block.type === "tool_use"),
    cause,
  });
}

function blockIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

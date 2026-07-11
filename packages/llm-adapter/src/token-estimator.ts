import type { GenerateTextInput, LLMContentBlock } from "./types";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_CONTEXT_SAFETY_RATIO = 0.1;
const STRUCTURED_ASCII_PATTERN = /[{}[\]():,;"'`=<>/\\]/;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function estimateTextTokens(content: string): number {
  if (!content) return 0;
  let cjkTokens = 0;
  let asciiChars = 0;
  let structuredAsciiChars = 0;
  let otherUnicodeBytes = 0;

  for (const character of content) {
    if (CJK_PATTERN.test(character)) {
      cjkTokens += 1;
      continue;
    }
    if (character.codePointAt(0)! <= 0x7f) {
      asciiChars += 1;
      if (STRUCTURED_ASCII_PATTERN.test(character)) {
        structuredAsciiChars += 1;
      }
      continue;
    }
    otherUnicodeBytes += Buffer.byteLength(character, "utf8");
  }

  const structuredRatio =
    asciiChars === 0 ? 0 : structuredAsciiChars / asciiChars;
  const asciiCharsPerToken = structuredRatio >= 0.08 ? 3.3 : 4;
  return Math.ceil(
    cjkTokens +
      asciiChars / asciiCharsPerToken +
      otherUnicodeBytes / 3,
  );
}

export function estimateGenerateTextInputTokens(
  input: Pick<GenerateTextInput, "messages" | "tools" | "toolChoice">,
): number {
  let tokens = 2;
  for (const message of input.messages) {
    tokens += 4;
    tokens += estimateTextTokens(message.role);
    tokens += estimateMessageContentTokens(message.content);
    if (message.name) tokens += estimateTextTokens(message.name);
    if (message.toolCallId) tokens += estimateTextTokens(message.toolCallId);
  }
  for (const tool of input.tools ?? []) {
    tokens += 8;
    tokens += estimateTextTokens(tool.name);
    tokens += estimateTextTokens(tool.description);
    tokens += estimateTextTokens(JSON.stringify(tool.inputSchema));
  }
  if (input.toolChoice) {
    tokens += estimateTextTokens(JSON.stringify(input.toolChoice));
  }
  return Math.max(0, Math.ceil(tokens));
}

export function calibrateInputTokenEstimate(input: {
  currentRawEstimate: number;
  previousRawEstimate?: number;
  previousActualInputTokens?: number;
}): number {
  const current = finiteNonNegative(input.currentRawEstimate);
  const previousRaw = finiteNonNegative(input.previousRawEstimate);
  const previousActual = finiteNonNegative(input.previousActualInputTokens);
  if (previousRaw === undefined || previousActual === undefined) {
    return Math.ceil(current ?? 0);
  }
  return Math.max(
    0,
    Math.ceil(previousActual + (current ?? 0) - previousRaw),
  );
}

export interface InputTokenEstimate {
  rawInputTokens: number;
  estimatedInputTokens: number;
  source: "heuristic" | "provider_calibrated";
}

export interface InputTokenEstimateTracker {
  estimate(rawInputTokens: number): InputTokenEstimate;
  observe(input: {
    rawInputTokens: number;
    actualInputTokens?: number;
  }): void;
}

export function createInputTokenEstimateTracker(): InputTokenEstimateTracker {
  let previousRawEstimate: number | undefined;
  let previousActualInputTokens: number | undefined;
  return {
    estimate(rawInputTokens) {
      const calibrated = calibrateInputTokenEstimate({
        currentRawEstimate: rawInputTokens,
        ...(previousRawEstimate === undefined
          ? {}
          : { previousRawEstimate }),
        ...(previousActualInputTokens === undefined
          ? {}
          : { previousActualInputTokens }),
      });
      return {
        rawInputTokens: Math.max(0, Math.ceil(rawInputTokens)),
        estimatedInputTokens: calibrated,
        source:
          previousRawEstimate !== undefined &&
          previousActualInputTokens !== undefined
            ? "provider_calibrated"
            : "heuristic",
      };
    },
    observe(input) {
      const raw = finiteNonNegative(input.rawInputTokens);
      const actual = finiteNonNegative(input.actualInputTokens);
      if (raw === undefined || actual === undefined) return;
      previousRawEstimate = raw;
      previousActualInputTokens = actual;
    },
  };
}

export function resolveModelContextWindowTokens(input: {
  model: string;
  contextWindowTokens?: number;
}): number {
  const explicit = positiveInteger(input.contextWindowTokens);
  if (explicit !== undefined) return explicit;
  const bracketedMillions = input.model.match(/\[(\d+(?:\.\d+)?)m\]/i)?.[1];
  if (bracketedMillions) {
    const parsed = Number(bracketedMillions);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed * 1_000_000);
    }
  }
  if (/\bminimax[-_ ]?m3\b/i.test(input.model)) {
    return 1_000_000;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function resolveInputTokenBudget(input: {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyRatio?: number;
}): number {
  const contextWindowTokens = positiveInteger(input.contextWindowTokens) ??
    DEFAULT_CONTEXT_WINDOW_TOKENS;
  const reservedOutputTokens = finiteNonNegative(input.reservedOutputTokens) ?? 0;
  const safetyRatio =
    typeof input.safetyRatio === "number" &&
    Number.isFinite(input.safetyRatio) &&
    input.safetyRatio >= 0 &&
    input.safetyRatio < 1
      ? input.safetyRatio
      : DEFAULT_CONTEXT_SAFETY_RATIO;
  return Math.max(
    0,
    Math.floor(
      contextWindowTokens -
        reservedOutputTokens -
        contextWindowTokens * safetyRatio,
    ),
  );
}

function estimateMessageContentTokens(
  content: string | LLMContentBlock[],
): number {
  if (typeof content === "string") return estimateTextTokens(content);
  return content.reduce((total, block) => {
    if (block.type === "text") {
      return total + 3 + estimateTextTokens(block.text);
    }
    if (block.type === "tool_result") {
      return (
        total +
        5 +
        estimateTextTokens(block.toolUseId) +
        estimateTextTokens(block.content)
      );
    }
    return (
      total +
      6 +
      estimateTextTokens(block.id) +
      estimateTextTokens(block.name) +
      estimateTextTokens(JSON.stringify(block.input))
    );
  }, 0);
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

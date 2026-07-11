import type { LLMContentBlock } from "./types";

const LEADING_REASONING_BLOCK = /^\s*<think(?:\s[^>]*)?>[\s\S]*?<\/think>\s*/i;
const UNCLOSED_LEADING_REASONING_BLOCK = /^\s*<think(?:\s[^>]*)?>[\s\S]*$/i;

export function stripLeadingReasoningBlocks(value: string): string {
  let next = value;
  while (LEADING_REASONING_BLOCK.test(next)) {
    next = next.replace(LEADING_REASONING_BLOCK, "");
  }
  if (UNCLOSED_LEADING_REASONING_BLOCK.test(next)) {
    return "";
  }
  return next === value ? value : next.trimStart();
}

export function sanitizeContentBlocks(blocks: LLMContentBlock[]): LLMContentBlock[] {
  return blocks.map((block) =>
    block.type === "text"
      ? {
          ...block,
          text: stripLeadingReasoningBlocks(block.text),
        }
      : block
  );
}

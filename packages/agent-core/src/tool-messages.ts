import type { LLMContentBlock, LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/types";
import type { ToolResult } from "./tool";

/**
 * Append the assistant turn that carried tool calls. When explicit content
 * blocks are not provided, synthesize them from the assistant text plus one
 * `tool_use` block per call (the canonical ReAct assistant message shape).
 */
export function appendAssistantToolCallMessage(
  messages: LLMMessage[],
  input: { text: string; contentBlocks?: LLMContentBlock[]; toolCalls: LLMToolCall[] }
): LLMMessage[] {
  const contentBlocks =
    input.contentBlocks && input.contentBlocks.length > 0
      ? input.contentBlocks
      : [
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
          ...input.toolCalls.map((call) => ({
            type: "tool_use" as const,
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ];
  return [
    ...messages,
    {
      role: "assistant",
      content: contentBlocks,
    },
  ];
}

/** Append one `tool` message per tool result, linked back by tool-call id. */
export function appendToolResultMessages(
  messages: LLMMessage[],
  results: ToolResult[]
): LLMMessage[] {
  return [
    ...messages,
    ...results.map((result) => ({
      role: "tool" as const,
      name: result.toolName,
      toolCallId: result.toolCallId,
      content: [
        {
          type: "tool_result" as const,
          toolUseId: result.toolCallId,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        },
      ],
    })),
  ];
}

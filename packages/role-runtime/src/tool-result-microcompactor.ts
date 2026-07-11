import { createHash } from "node:crypto";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { buildHistoryProtocolUnits } from "./tool-history-pruning";

export const MICROCOMPACTED_TOOL_RESULT_PROTOCOL =
  "turnkeyai.microcompacted_tool_result.v1" as const;

export interface ToolResultMicrocompactionResult {
  messages: LLMMessage[];
  compactedToolResults: number;
  bytesBefore: number;
  bytesAfter: number;
}

export function microcompactOldToolResults(
  messages: LLMMessage[],
  options: {
    recentProtocolUnits?: number;
    previewBytes?: number;
  } = {},
): ToolResultMicrocompactionResult {
  const recentProtocolUnits = Math.max(0, options.recentProtocolUnits ?? 4);
  const previewBytes = Math.max(0, options.previewBytes ?? 512);
  const prefix = messages.slice(0, 2);
  const units = buildHistoryProtocolUnits(messages.slice(2));
  const compactableEnd = Math.max(0, units.length - recentProtocolUnits);
  let compactedToolResults = 0;

  const compactedUnits = units.map((unit, index) => {
    if (index >= compactableEnd || !unit.protocolSafe || unit.messages.length < 2) {
      return unit.messages;
    }
    return unit.messages.map((message) => {
      if (
        message.role !== "tool" ||
        typeof message.content !== "string" ||
        !message.content ||
        isTypedEvidenceContent(message.content)
      ) {
        return message;
      }
      compactedToolResults += 1;
      const contentBytes = Buffer.from(message.content, "utf8");
      return {
        ...message,
        content: JSON.stringify(
          {
            protocol: MICROCOMPACTED_TOOL_RESULT_PROTOCOL,
            version: 1,
            tool_call_id: message.toolCallId ?? null,
            tool_name: message.name ?? null,
            bytes: contentBytes.length,
            sha256: createHash("sha256").update(contentBytes).digest("hex"),
            preview: utf8Prefix(contentBytes, previewBytes),
          },
          null,
          2,
        ),
      } satisfies LLMMessage;
    });
  });
  const nextMessages = [...prefix, ...compactedUnits.flat()];
  return {
    messages: compactedToolResults > 0 ? nextMessages : messages,
    compactedToolResults,
    bytesBefore: serializedBytes(messages),
    bytesAfter: serializedBytes(compactedToolResults > 0 ? nextMessages : messages),
  };
}

function isTypedEvidenceContent(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return false;
  }
  return Boolean(
    parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "protocol" in parsed &&
      typeof parsed.protocol === "string" &&
      parsed.protocol.startsWith("turnkeyai."),
  );
}

function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function serializedBytes(messages: LLMMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

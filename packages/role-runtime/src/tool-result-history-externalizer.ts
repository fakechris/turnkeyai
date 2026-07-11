import type { ToolResult } from "@turnkeyai/agent-core/tool";

import { sliceUtf8 } from "./tool-protocol";
import {
  TOOL_RESULT_ARTIFACT_PROTOCOL,
  type ToolResultArtifactRecord,
  type ToolResultArtifactStore,
} from "./tool-result-artifact-store";

export type { ToolResultArtifactRecord, ToolResultArtifactStore };

const DEFAULT_HARD_MAX_BYTES = 64 * 1024;
const DEFAULT_PREVIEW_BYTES = 2 * 1024;

export interface ToolResultHistoryExternalizer {
  externalize(
    results: ToolResult[],
    context: {
      threadId: string;
      runKey: string;
      onExternalized?: (artifact: ToolResultArtifactRecord) => void;
    },
  ): Promise<ToolResult[]>;
}

export function createToolResultHistoryExternalizer(input: {
  store: ToolResultArtifactStore;
  hardMaxBytes?: number;
  previewBytes?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}): ToolResultHistoryExternalizer {
  const hardMaxBytes = input.hardMaxBytes ?? DEFAULT_HARD_MAX_BYTES;
  const previewBytes = input.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const now = input.now ?? (() => Date.now());

  return {
    externalize(results, context) {
      return Promise.all(
        results.map(async (result) => {
          const contentBytes = Buffer.byteLength(result.content, "utf8");
          if (
            result.toolName === "artifacts_read" ||
            contentBytes <= hardMaxBytes
          ) {
            return result;
          }
          try {
            const record = await input.store.put({
              threadId: context.threadId,
              runKey: context.runKey,
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              content: result.content,
              createdAt: now(),
            });
            context.onExternalized?.(record);
            return {
              ...result,
              content: JSON.stringify(
                {
                  protocol: TOOL_RESULT_ARTIFACT_PROTOCOL,
                  artifact_id: record.artifactId,
                  tool_call_id: record.toolCallId,
                  tool_name: record.toolName,
                  bytes: record.sizeBytes,
                  sha256: record.sha256,
                  preview: sliceUtf8(result.content, previewBytes),
                  read_instruction:
                    "Call artifacts_read with artifact_id and offset_bytes to read additional content.",
                },
                null,
                2,
              ),
            };
          } catch (error) {
            input.onError?.(error);
            return result;
          }
        }),
      );
    },
  };
}

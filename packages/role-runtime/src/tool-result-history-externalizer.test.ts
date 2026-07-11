import assert from "node:assert/strict";
import test from "node:test";

import type { ToolResult } from "@turnkeyai/agent-core/tool";

import {
  createToolResultHistoryExternalizer,
  type ToolResultArtifactStore,
  type ToolResultArtifactRecord,
} from "./tool-result-history-externalizer";

const record: ToolResultArtifactRecord = {
  protocol: "turnkeyai.tool_result_artifact.v1",
  artifactId: "tool-result-1",
  threadId: "thread-1",
  runKey: "run-1",
  toolCallId: "call-1",
  toolName: "web_fetch",
  sizeBytes: 70_000,
  sha256: "a".repeat(64),
  createdAt: 123,
};

test("tool result history externalizer stores oversized results and returns recoverable references", async () => {
  const writes: string[] = [];
  const externalized: ToolResultArtifactRecord[] = [];
  const store: ToolResultArtifactStore = {
    async put(input) {
      writes.push(input.content);
      return record;
    },
    async read() {
      return null;
    },
  };
  const original: ToolResult = {
    toolCallId: "call-1",
    toolName: "web_fetch",
    content: `EARLY_FACT\n${"x".repeat(70_000)}`,
  };
  const externalizer = createToolResultHistoryExternalizer({
    store,
    hardMaxBytes: 64 * 1024,
    previewBytes: 2_048,
    now: () => 123,
  });

  const history = await externalizer.externalize([original], {
    threadId: "thread-1",
    runKey: "run-1",
    onExternalized: (artifact) => externalized.push(artifact),
  });
  const reference = JSON.parse(history[0]!.content) as Record<string, unknown>;

  assert.equal(writes[0], original.content);
  assert.equal(original.content.length > 70_000, true);
  assert.equal(reference["protocol"], "turnkeyai.tool_result_artifact.v1");
  assert.equal(reference["artifact_id"], "tool-result-1");
  assert.equal(reference["bytes"], 70_000);
  assert.equal(reference["sha256"], "a".repeat(64));
  assert.match(String(reference["preview"]), /EARLY_FACT/);
  assert.match(String(reference["read_instruction"]), /artifacts_read/);
  assert.deepEqual(externalized, [record]);
});

test("tool result history externalizer leaves small and artifacts_read results inline", async () => {
  let writes = 0;
  const store: ToolResultArtifactStore = {
    async put() {
      writes += 1;
      return record;
    },
    async read() {
      return null;
    },
  };
  const results: ToolResult[] = [
    {
      toolCallId: "small",
      toolName: "web_fetch",
      content: "small evidence",
    },
    {
      toolCallId: "reader",
      toolName: "artifacts_read",
      content: "x".repeat(70_000),
    },
  ];
  const externalizer = createToolResultHistoryExternalizer({ store });

  const history = await externalizer.externalize(results, {
    threadId: "thread-1",
    runKey: "run-1",
  });

  assert.deepEqual(history, results);
  assert.equal(writes, 0);
});

test("tool result history externalizer preserves original content when artifact persistence fails", async () => {
  const errors: unknown[] = [];
  const store: ToolResultArtifactStore = {
    async put() {
      throw new Error("disk unavailable");
    },
    async read() {
      return null;
    },
  };
  const result: ToolResult = {
    toolCallId: "call-1",
    toolName: "web_fetch",
    content: "x".repeat(70_000),
  };
  const externalizer = createToolResultHistoryExternalizer({
    store,
    onError: (error) => errors.push(error),
  });

  const history = await externalizer.externalize([result], {
    threadId: "thread-1",
    runKey: "run-1",
  });

  assert.equal(history[0], result);
  assert.equal(errors.length, 1);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileToolResultArtifactStore } from "./tool-result-artifact-store";

test("FileToolResultArtifactStore persists content and reads bounded UTF-8 pages", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-tool-artifacts-"));
  try {
    const store = new FileToolResultArtifactStore({ rootDir });
    const content = `${"alpha ".repeat(80)}中文证据${" omega".repeat(80)}`;
    const record = await store.put({
      threadId: "thread-1",
      runKey: "run-1",
      toolCallId: "call-1",
      toolName: "web_fetch",
      content,
      createdAt: 123,
    });

    assert.equal(record.protocol, "turnkeyai.tool_result_artifact.v1");
    assert.equal(record.sizeBytes, Buffer.byteLength(content, "utf8"));
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    const first = await store.read({
      artifactId: record.artifactId,
      offsetBytes: 0,
      limitBytes: 517,
    });
    assert.ok(first);
    assert.equal(first.offsetBytes, 0);
    assert.equal(first.eof, false);
    const second = await store.read({
      artifactId: record.artifactId,
      offsetBytes: first.nextOffsetBytes,
      limitBytes: 4_096,
    });
    assert.ok(second);
    assert.equal(second.eof, true);
    assert.equal(`${first.content}${second.content}`, content);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("FileToolResultArtifactStore returns null for unknown artifacts", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-tool-artifacts-"));
  try {
    const store = new FileToolResultArtifactStore({ rootDir });
    assert.equal(
      await store.read({
        artifactId: "../../unknown",
        offsetBytes: 0,
        limitBytes: 1_024,
      }),
      null,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

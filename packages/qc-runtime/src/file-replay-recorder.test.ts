import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileReplayRecorder } from "./file-replay-recorder";

test("file replay recorder records, lists, and reads replay entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "file-replay-recorder-"));
  const recorder = new FileReplayRecorder({
    rootDir: tempDir,
  });

  try {
    const firstReplayId = await recorder.record({
      replayId: "role-1",
      layer: "role",
      status: "completed",
      recordedAt: 10,
      threadId: "thread-1",
      summary: "Role completed.",
    });
    const secondReplayId = await recorder.record({
      replayId: "worker-1",
      layer: "worker",
      status: "failed",
      recordedAt: 20,
      threadId: "thread-1",
      workerType: "browser",
      summary: "Worker failed.",
      failure: {
        category: "transport_failed",
        layer: "worker",
        retryable: true,
        message: "browser crashed",
        recommendedAction: "fallback",
      },
    });

    assert.equal(firstReplayId, "role-1");
    assert.equal(secondReplayId, "worker-1");

    const listed = await recorder.list({ threadId: "thread-1", limit: 10 });
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.replayId, "role-1");
    assert.equal(listed[1]?.replayId, "worker-1");

    const replay = await recorder.get("worker-1");
    assert.equal(replay?.layer, "worker");
    assert.equal(replay?.failure?.category, "transport_failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

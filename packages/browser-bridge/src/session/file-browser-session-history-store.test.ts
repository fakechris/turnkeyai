import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBrowserSessionHistoryStore } from "./file-browser-session-history-store";

test("browser session history store appends and lists entries in cursor order", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-session-history-"));

  try {
    const store = new FileBrowserSessionHistoryStore({
      rootDir: tempDir,
    });

    await store.append({
      entryId: "entry-2",
      browserSessionId: "session-1",
      dispatchMode: "send",
      threadId: "thread-1",
      taskId: "task-2",
      ownerType: "thread",
      ownerId: "thread-1",
      historyCursor: 20,
      startedAt: 20,
      completedAt: 21,
      status: "completed",
      actionKinds: ["snapshot"],
      instructions: "snapshot current page",
      summary: "second entry",
    });
    await store.append({
      entryId: "entry-1",
      browserSessionId: "session-1",
      dispatchMode: "spawn",
      threadId: "thread-1",
      taskId: "task-1",
      ownerType: "thread",
      ownerId: "thread-1",
      historyCursor: 10,
      startedAt: 10,
      completedAt: 11,
      status: "completed",
      actionKinds: ["open", "snapshot"],
      instructions: "open example.com",
      summary: "first entry",
    });

    const allEntries = await store.listBySession("session-1");
    assert.deepEqual(
      allEntries.map((entry) => entry.entryId),
      ["entry-1", "entry-2"]
    );

    const limitedEntries = await store.listBySession("session-1", 1);
    assert.deepEqual(
      limitedEntries.map((entry) => entry.entryId),
      ["entry-2"]
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FileTeamMessageStore } from "./file-team-message-store";

test("file team message store appends messages as per-message journal entries", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-"));

  try {
    const store = new FileTeamMessageStore({ rootDir });
    await store.append({
      id: "msg-1",
      threadId: "thread-1",
      role: "user",
      name: "Chris",
      content: "hello",
      createdAt: 10,
      updatedAt: 10,
    });
    await store.append({
      id: "msg-2",
      threadId: "thread-1",
      role: "assistant",
      name: "Lead",
      content: "hi",
      createdAt: 20,
      updatedAt: 20,
    });

    const messages = await store.list("thread-1");
    assert.deepEqual(
      messages.map((message) => message.id),
      ["msg-1", "msg-2"]
    );
    assert.equal((await store.get("msg-2"))?.content, "hi");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file team message store merges legacy thread files with append-only journal entries", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-legacy-"));

  try {
    await writeJsonFileAtomic(path.join(rootDir, "thread-1.json"), [
      {
        id: "msg-legacy",
        threadId: "thread-1",
        role: "user",
        name: "Chris",
        content: "legacy",
        createdAt: 10,
        updatedAt: 10,
      },
    ]);

    const store = new FileTeamMessageStore({ rootDir });
    await store.append({
      id: "msg-new",
      threadId: "thread-1",
      role: "assistant",
      name: "Lead",
      content: "new",
      createdAt: 20,
      updatedAt: 20,
    });

    const messages = await store.list("thread-1");
    assert.deepEqual(
      messages.map((message) => message.id),
      ["msg-legacy", "msg-new"]
    );
    assert.equal((await store.get("msg-legacy"))?.content, "legacy");
    assert.equal((await store.get("msg-new"))?.content, "new");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file team message store prefers newer append-only entries over legacy duplicates", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-dedupe-"));

  try {
    await writeJsonFileAtomic(path.join(rootDir, "thread-1.json"), [
      {
        id: "msg-1",
        threadId: "thread-1",
        role: "assistant",
        name: "Lead",
        content: "older",
        createdAt: 10,
        updatedAt: 10,
      },
    ]);

    const store = new FileTeamMessageStore({ rootDir });
    await store.append({
      id: "msg-1",
      threadId: "thread-1",
      role: "assistant",
      name: "Lead",
      content: "newer",
      createdAt: 10,
      updatedAt: 20,
    });

    const messages = await store.list("thread-1");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content, "newer");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

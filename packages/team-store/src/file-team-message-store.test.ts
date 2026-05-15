import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

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

test("file team message store backfills by-id projection from legacy thread records on read", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-backfill-"));

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
    const restored = await store.get("msg-legacy");

    assert.equal(restored?.content, "legacy");
    assert.deepEqual(
      await readJsonFile(path.join(rootDir, "by-id", "msg-legacy.json")),
      restored
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file team message store appendIfAbsent is idempotent for redelivered messages", async () => {
  // P0.1 + P0.2 — outbox replay must be a no-op at the store level.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-idempotent-"));

  try {
    const store = new FileTeamMessageStore({ rootDir });
    const message = {
      id: "msg-1",
      threadId: "thread-1",
      role: "user" as const,
      name: "Chris",
      content: "hello",
      createdAt: 10,
      updatedAt: 10,
    };

    const first = await store.appendIfAbsent(message);
    assert.equal(first.written, true);
    assert.equal(first.existing, undefined);

    const second = await store.appendIfAbsent(message);
    assert.equal(second.written, false);
    assert.equal(second.existing?.id, "msg-1");
    assert.equal(second.existing?.content, "hello");

    // Even a different timestamp on the same id is a no-op — at-least-once
    // delivery must not allow the second copy to overwrite.
    const third = await store.appendIfAbsent({ ...message, content: "hello-replay", updatedAt: 99 });
    assert.equal(third.written, false);
    assert.equal(third.existing?.content, "hello");

    const messages = await store.list("thread-1");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content, "hello");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file team message store appendIfAbsent reports threadId conflicts without overwriting", async () => {
  // P0.1 + P0.2 — if a buggy caller tries to attach an existing message id to a
  // different thread, the store reports the conflict instead of silently
  // overwriting (which is what plain `append` would do).
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-thread-conflict-"));

  try {
    const store = new FileTeamMessageStore({ rootDir });
    await store.appendIfAbsent({
      id: "msg-shared",
      threadId: "thread-A",
      role: "user",
      name: "Chris",
      content: "from A",
      createdAt: 10,
      updatedAt: 10,
    });

    const conflict = await store.appendIfAbsent({
      id: "msg-shared",
      threadId: "thread-B",
      role: "user",
      name: "Chris",
      content: "from B",
      createdAt: 20,
      updatedAt: 20,
    });

    assert.equal(conflict.written, false);
    assert.deepEqual(conflict.threadIdConflict, { existing: "thread-A", requested: "thread-B" });
    assert.equal(conflict.existing?.content, "from A");

    // Verify nothing leaked into thread-B.
    assert.deepEqual(await store.list("thread-B"), []);
    const stored = await store.get("msg-shared");
    assert.equal(stored?.threadId, "thread-A");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file team message store appendIfAbsent observes legacy-only messages as existing", async () => {
  // P0.1 + P0.2 regression — after upgrade from legacy thread-file format,
  // a message that only lives in `thread-1.json` (no by-id projection yet)
  // must still be observed as existing on appendIfAbsent so an outbox replay
  // doesn't write a fresh entry and lose the original threadId guard.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-legacy-idempotent-"));

  try {
    await writeJsonFileAtomic(path.join(rootDir, "thread-1.json"), [
      {
        id: "msg-legacy",
        threadId: "thread-1",
        role: "user",
        name: "Chris",
        content: "from legacy file",
        createdAt: 5,
        updatedAt: 5,
      },
    ]);

    const store = new FileTeamMessageStore({ rootDir });

    const replay = await store.appendIfAbsent({
      id: "msg-legacy",
      threadId: "thread-1",
      role: "user",
      name: "Chris",
      content: "from replay",
      createdAt: 5,
      updatedAt: 5,
    });
    assert.equal(replay.written, false);
    assert.equal(replay.existing?.content, "from legacy file");

    // And the same id reused under a different thread must still be flagged.
    const conflict = await store.appendIfAbsent({
      id: "msg-legacy",
      threadId: "thread-other",
      role: "user",
      name: "Chris",
      content: "from wrong thread",
      createdAt: 9,
      updatedAt: 9,
    });
    assert.equal(conflict.written, false);
    assert.deepEqual(conflict.threadIdConflict, { existing: "thread-1", requested: "thread-other" });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file team message store appendIfAbsent serializes concurrent calls with the same id", async () => {
  // P0.1 + P0.2 — within a single process, concurrent outbox redeliveries
  // (multiple ack-pending replays before the first finishes) must produce
  // exactly one write.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-concurrent-"));

  try {
    const store = new FileTeamMessageStore({ rootDir });
    const message = {
      id: "msg-race",
      threadId: "thread-1",
      role: "user" as const,
      name: "Chris",
      content: "race",
      createdAt: 1,
      updatedAt: 1,
    };

    const results = await Promise.all([
      store.appendIfAbsent(message),
      store.appendIfAbsent(message),
      store.appendIfAbsent(message),
    ]);

    const written = results.filter((result) => result.written);
    assert.equal(written.length, 1, "exactly one parallel appendIfAbsent must report written=true");
    assert.equal(results.length - written.length, 2);

    const messages = await store.list("thread-1");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.id, "msg-race");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file team message store restores append-only entry when by-id projection write fails", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-message-store-rollback-"));
  const byIdDir = path.join(rootDir, "by-id");

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

    if (process.platform === "win32") {
      return;
    }

    await chmod(byIdDir, 0o500);
    await assert.rejects(() =>
      store.append({
        id: "msg-2",
        threadId: "thread-1",
        role: "assistant",
        name: "Lead",
        content: "should rollback",
        createdAt: 20,
        updatedAt: 20,
      })
    );
    await chmod(byIdDir, 0o700);

    const messages = await store.list("thread-1");
    assert.deepEqual(
      messages.map((message) => message.id),
      ["msg-1"]
    );
    assert.equal(await store.get("msg-2"), null);
  } finally {
    await chmod(byIdDir, 0o700).catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

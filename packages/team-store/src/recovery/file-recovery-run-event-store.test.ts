import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FileRecoveryRunEventStore } from "./file-recovery-run-event-store";

test("file recovery run event store appends and lists events", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-event-store-"));
  try {
    const store = new FileRecoveryRunEventStore({ rootDir });

    await store.append({
      eventId: "event-2",
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      kind: "action_dispatched",
      status: "running",
      recordedAt: 20,
      summary: "dispatch accepted",
    });

    await store.append({
      eventId: "event-1",
      recoveryRunId: "recovery:task-1",
      threadId: "thread-1",
      sourceGroupId: "task-1",
      kind: "action_requested",
      status: "planned",
      recordedAt: 10,
      summary: "retry requested",
      action: "retry",
    });

    await store.append({
      eventId: "event-3",
      recoveryRunId: "recovery:task-2",
      threadId: "thread-2",
      sourceGroupId: "task-2",
      kind: "recovered",
      status: "recovered",
      recordedAt: 30,
      summary: "done",
    });

    const events = await store.listByRecoveryRun("recovery:task-1");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventId, "event-1");
    assert.equal(events[1]?.eventId, "event-2");

    const threadEvents = await store.listByThread("thread-1");
    assert.equal(threadEvents.length, 2);
    assert.equal(threadEvents[0]?.recoveryRunId, "recovery:task-1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run event store preserves legacy events on first migrated append", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-event-store-"));
  try {
    const store = new FileRecoveryRunEventStore({ rootDir });
    const recoveryRunId = "recovery:task-legacy";
    await writeJsonFileAtomic(path.join(rootDir, `${encodeURIComponent(recoveryRunId)}.json`), [
      {
        eventId: "legacy-event-1",
        recoveryRunId,
        threadId: "thread-legacy",
        sourceGroupId: "task-legacy",
        kind: "action_requested",
        status: "planned",
        recordedAt: 10,
        summary: "legacy event",
      },
    ]);

    await store.append({
      eventId: "event-2",
      recoveryRunId,
      threadId: "thread-legacy",
      sourceGroupId: "task-legacy",
      kind: "action_dispatched",
      status: "running",
      recordedAt: 20,
      summary: "dispatch accepted",
    });

    const events = await store.listByRecoveryRun(recoveryRunId);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventId, "legacy-event-1");
    assert.equal(events[1]?.eventId, "event-2");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run event store reads legacy by-run array files", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-event-store-"));
  try {
    const store = new FileRecoveryRunEventStore({ rootDir });
    const recoveryRunId = "recovery:task-by-run-legacy";
    await writeJsonFileAtomic(path.join(rootDir, "by-run", `${encodeURIComponent(recoveryRunId)}.json`), [
      {
        eventId: "legacy-by-run-event-1",
        recoveryRunId,
        threadId: "thread-legacy",
        sourceGroupId: "task-legacy",
        kind: "action_requested",
        status: "planned",
        recordedAt: 10,
        summary: "legacy by-run event",
      },
    ]);

    const events = await store.listByRecoveryRun(recoveryRunId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventId, "legacy-by-run-event-1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file recovery run event store merges thread-scoped, legacy flat, and by-run arrays for thread reads", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-recovery-run-event-store-merge-thread-"));
  try {
    const store = new FileRecoveryRunEventStore({ rootDir });
    await writeJsonFileAtomic(path.join(rootDir, "recovery%3Atask-legacy.json"), [
      {
        eventId: "legacy-flat-event",
        recoveryRunId: "recovery:task-legacy",
        threadId: "thread-1",
        sourceGroupId: "task-legacy",
        kind: "action_requested",
        status: "planned",
        recordedAt: 10,
        summary: "legacy flat event",
      },
    ]);
    await writeJsonFileAtomic(path.join(rootDir, "by-run", "recovery%3Atask-by-run.json"), [
      {
        eventId: "legacy-by-run-event",
        recoveryRunId: "recovery:task-by-run",
        threadId: "thread-1",
        sourceGroupId: "task-by-run",
        kind: "action_dispatched",
        status: "running",
        recordedAt: 20,
        summary: "legacy by-run event",
      },
    ]);

    await store.append({
      eventId: "thread-event",
      recoveryRunId: "recovery:task-thread",
      threadId: "thread-1",
      sourceGroupId: "task-thread",
      kind: "recovered",
      status: "recovered",
      recordedAt: 30,
      summary: "thread event",
    });

    const events = await store.listByThread("thread-1");
    assert.deepEqual(
      events.map((event) => event.eventId),
      ["legacy-flat-event", "legacy-by-run-event", "thread-event"]
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

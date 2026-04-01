import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TeamEvent, TeamEventBus } from "@turnkeyai/core-types/team";

import { FileBatchOutbox, type OutboxBatchRecord } from "./file-batch-outbox";
import { DefaultRuntimeProgressRecorder } from "./runtime-progress-recorder";

async function waitForOutboxItems<T>(
  outbox: FileBatchOutbox<T>,
  expectedAtLeast = 1,
  isReady?: (items: Array<OutboxBatchRecord<T>>) => boolean
): Promise<Array<OutboxBatchRecord<T>>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const items = await outbox.listDue(32, Date.now() + 1_000);
    if (items.length >= expectedAtLeast && (isReady ? isReady(items) : true)) {
      return items;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return outbox.listDue(32, Date.now() + 1_000);
}

test("runtime progress recorder emits an audit event when progress persistence fails permanently", async () => {
  const events: TeamEvent[] = [];
  const eventBus: TeamEventBus = {
    async publish(event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    async listRecent() {
      return events;
    },
  };

  const recorder = new DefaultRuntimeProgressRecorder({
    progressStore: {
      async append() {
        throw new Error("progress store unavailable");
      },
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    },
    teamEventBus: eventBus,
    maxBatchItems: 1,
  });

  await recorder.record({
    progressId: "progress-1",
    threadId: "thread-1",
    subjectKind: "role_run",
    subjectId: "run-1",
    phase: "heartbeat",
    summary: "Role is still active.",
    recordedAt: 1,
  });
  await recorder.flush();

  assert.ok(events.some((event) => event.kind === "audit.logged" && String(event.payload.summary).includes("Failed to persist")));
});

test("runtime progress recorder keeps local persistence when remote forwarding fails", async () => {
  const events: TeamEvent[] = [];
  const stored: string[] = [];
  const eventBus: TeamEventBus = {
    async publish(event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    async listRecent() {
      return events;
    },
  };

  const recorder = new DefaultRuntimeProgressRecorder({
    progressStore: {
      async append(event) {
        stored.push(event.progressId);
      },
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    },
    teamEventBus: eventBus,
    remoteSink: async () => {
      throw new Error("remote sink unavailable");
    },
  });

  await recorder.record({
    progressId: "progress-remote-1",
    threadId: "thread-1",
    subjectKind: "worker_run",
    subjectId: "worker-1",
    phase: "heartbeat",
    summary: "Worker is still active.",
    recordedAt: 1,
  });
  await recorder.flush();

  assert.deepEqual(stored, ["progress-remote-1"]);
  assert.ok(
    events.some(
      (event) => event.kind === "audit.logged" && String(event.payload.summary).includes("remote sink")
    )
  );
});

test("runtime progress recorder does not block on a slow remote sink", async () => {
  const events: TeamEvent[] = [];
  const stored: string[] = [];
  const eventBus: TeamEventBus = {
    async publish(event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    async listRecent() {
      return events;
    },
  };

  const recorder = new DefaultRuntimeProgressRecorder({
    progressStore: {
      async append(event) {
        stored.push(event.progressId);
      },
      async listByThread() {
        return [];
      },
      async listByChain() {
        return [];
      },
    },
    teamEventBus: eventBus,
    remoteSinkTimeoutMs: 5,
    remoteSink: async () => {
      await new Promise(() => {});
    },
  });

  await recorder.record({
    progressId: "progress-remote-timeout",
    threadId: "thread-timeout",
    subjectKind: "worker_run",
    subjectId: "worker-timeout",
    phase: "heartbeat",
    summary: "Worker is still active.",
    recordedAt: 1,
  });
  await recorder.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(stored, ["progress-remote-timeout"]);
  assert.ok(events.some((event) => event.kind === "audit.logged"));
});

test("runtime progress recorder retries remote delivery through the durable outbox", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-progress-outbox-"));
  const events: TeamEvent[] = [];
  const stored: string[] = [];
  let attempts = 0;
  const delivered: string[][] = [];
  const eventBus: TeamEventBus = {
    async publish(event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    async listRecent() {
      return events;
    },
  };

  try {
    const recorder = new DefaultRuntimeProgressRecorder({
      progressStore: {
        async append(event) {
          stored.push(event.progressId);
        },
        async listByThread() {
          return [];
        },
        async listByChain() {
          return [];
        },
      },
      teamEventBus: eventBus,
      remoteOutboxRootDir: tempDir,
      remoteSink: async (items) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient remote outage");
        }
        delivered.push(items.map((item) => item.progressId));
      },
    });

    await recorder.record({
      progressId: "progress-outbox-1",
      threadId: "thread-outbox",
      subjectKind: "worker_run",
      subjectId: "worker-outbox",
      phase: "heartbeat",
      summary: "Worker is still active.",
      recordedAt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(attempts, 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await recorder.flush();

    const outbox = new FileBatchOutbox<unknown>({
      rootDir: tempDir,
    });
    let remaining = await outbox.listDue();
    for (let attempt = 0; remaining.length > 0 && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      remaining = await outbox.listDue();
    }

    assert.equal(attempts, 2);
    assert.deepEqual(stored, ["progress-outbox-1"]);
    assert.deepEqual(delivered, [["progress-outbox-1"]]);
    assert.equal(remaining.length, 0);
    assert.ok(
      events.some(
        (event) => event.kind === "audit.logged" && String(event.payload.summary).includes("Retrying remote sink delivery")
      )
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime progress recorder persists failed remote deliveries in the durable outbox", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-progress-outbox-drop-"));
  const events: TeamEvent[] = [];
  const eventBus: TeamEventBus = {
    async publish(event) {
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    async listRecent() {
      return events;
    },
  };

  try {
    const recorder = new DefaultRuntimeProgressRecorder({
      progressStore: {
        async append() {},
        async listByThread() {
          return [];
        },
        async listByChain() {
          return [];
        },
      },
      teamEventBus: eventBus,
      remoteOutboxRootDir: tempDir,
      remoteSink: async () => {
        throw new Error("remote sink unavailable");
      },
    });

    await recorder.record({
      progressId: "progress-outbox-drop-1",
      threadId: "thread-outbox-drop",
      subjectKind: "worker_run",
      subjectId: "worker-outbox-drop",
      phase: "heartbeat",
      summary: "Worker is still active.",
      recordedAt: 1,
    });
    const outbox = new FileBatchOutbox<unknown>({
      rootDir: tempDir,
    });
    const remaining = await waitForOutboxItems(
      outbox,
      1,
      (items) =>
        (items[0] as { attemptCount?: number; lastError?: string } | undefined)?.attemptCount === 1 &&
        String((items[0] as { lastError?: string } | undefined)?.lastError ?? "").includes("remote sink unavailable")
    );

    assert.equal(remaining.length, 1);
    assert.equal((remaining[0] as { attemptCount?: number }).attemptCount, 1);
    assert.match(String((remaining[0] as { lastError?: string }).lastError ?? ""), /remote sink unavailable/);
    assert.ok(events.some((event) => event.kind === "runtime.progress"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

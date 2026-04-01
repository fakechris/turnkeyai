import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TeamEvent, TeamEventBus } from "@turnkeyai/core-types/team";

import { FileBatchOutbox, type OutboxBatchRecord } from "./file-batch-outbox";
import { InMemoryTeamEventBus } from "./in-memory-team-event-bus";
import { DefaultRuntimeStateRecorder } from "./runtime-state-recorder";

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

test("runtime state recorder coalesces repeated chain status updates", async () => {
  const eventBus = new InMemoryTeamEventBus();
  let releaseFirstPublish: (() => void) | undefined;
  const firstPublishGate = new Promise<void>((resolve) => {
    releaseFirstPublish = resolve;
  });
  let runtimeStateCount = 0;
  eventBus.subscribe(async (event) => {
    if (event.kind !== "runtime.state") {
      return;
    }
    runtimeStateCount += 1;
    if (runtimeStateCount === 1) {
      await firstPublishGate;
    }
  });

  const recorder = new DefaultRuntimeStateRecorder({
    teamEventBus: eventBus,
  });
  const chain = {
    chainId: "flow:flow-1",
    threadId: "thread-1",
    rootKind: "flow" as const,
    rootId: "flow-1",
    flowId: "flow-1",
    createdAt: 1,
    updatedAt: 2,
  };

  const pending = Promise.all([
    recorder.record({
      chain,
      status: {
        chainId: chain.chainId,
        threadId: chain.threadId,
        phase: "started",
        latestSummary: "Flow created.",
        attention: false,
        updatedAt: 2,
      },
    }),
    recorder.record({
      chain: { ...chain, updatedAt: 4 },
      status: {
        chainId: chain.chainId,
        threadId: chain.threadId,
        phase: "waiting",
        latestSummary: "Waiting on lead.",
        waitingReason: "waiting for lead",
        continuityState: "waiting",
        attention: false,
        updatedAt: 4,
      },
    }),
  ]);
  releaseFirstPublish?.();
  await pending;
  await recorder.flush();

  const events = await eventBus.listRecent("thread-1", 10);
  const runtimeStateEvents = events.filter((event) => event.kind === "runtime.state");
  assert.equal(runtimeStateEvents.length, 1);
  assert.equal(runtimeStateEvents[0]?.payload.phase, "waiting");
  assert.equal(runtimeStateEvents[0]?.payload.waitingReason, "waiting for lead");
});

test("runtime state recorder emits an audit event when state publication fails permanently", async () => {
  const events: TeamEvent[] = [];
  const eventBus: TeamEventBus = {
    async publish(event) {
      if (event.kind === "runtime.state") {
        throw new Error("state sink unavailable");
      }
      events.push(event);
    },
    subscribe() {
      return () => {};
    },
    async listRecent() {
      return events;
    },
  };

  const recorder = new DefaultRuntimeStateRecorder({
    teamEventBus: eventBus,
  });

  await recorder.record({
    chain: {
      chainId: "flow:flow-1",
      threadId: "thread-1",
      rootKind: "flow",
      rootId: "flow-1",
      flowId: "flow-1",
      createdAt: 1,
      updatedAt: 2,
    },
    status: {
      chainId: "flow:flow-1",
      threadId: "thread-1",
      phase: "started",
      latestSummary: "Flow started.",
      attention: false,
      updatedAt: 2,
    },
  });
  await recorder.flush();

  assert.ok(events.some((event) => event.kind === "audit.logged" && String(event.payload.summary).includes("Failed to publish")));
});

test("runtime state recorder keeps local publication when remote forwarding fails", async () => {
  const eventBus = new InMemoryTeamEventBus();
  const recorder = new DefaultRuntimeStateRecorder({
    teamEventBus: eventBus,
    remoteSink: async () => {
      throw new Error("remote state sink unavailable");
    },
  });

  await recorder.record({
    chain: {
      chainId: "flow:flow-remote",
      threadId: "thread-remote",
      rootKind: "flow",
      rootId: "flow-remote",
      flowId: "flow-remote",
      createdAt: 1,
      updatedAt: 2,
    },
    status: {
      chainId: "flow:flow-remote",
      threadId: "thread-remote",
      phase: "waiting",
      latestSummary: "Waiting on remote sink test.",
      attention: true,
      updatedAt: 2,
    },
  });
  await recorder.flush();

  const events = await eventBus.listRecent("thread-remote", 10);
  assert.ok(events.some((event) => event.kind === "runtime.state"));
  assert.ok(
    events.some(
      (event) => event.kind === "audit.logged" && String(event.payload.summary).includes("remote sink")
    )
  );
});

test("runtime state recorder does not block on a slow remote sink", async () => {
  const eventBus = new InMemoryTeamEventBus();
  const recorder = new DefaultRuntimeStateRecorder({
    teamEventBus: eventBus,
    remoteSinkTimeoutMs: 5,
    remoteSink: async () => {
      await new Promise(() => {});
    },
  });

  await recorder.record({
    chain: {
      chainId: "flow:flow-timeout",
      threadId: "thread-timeout",
      rootKind: "flow",
      rootId: "flow-timeout",
      flowId: "flow-timeout",
      createdAt: 1,
      updatedAt: 2,
    },
    status: {
      chainId: "flow:flow-timeout",
      threadId: "thread-timeout",
      phase: "started",
      latestSummary: "Flow started.",
      attention: false,
      updatedAt: 2,
    },
  });
  await recorder.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const events = await eventBus.listRecent("thread-timeout", 10);
  assert.ok(events.some((event) => event.kind === "runtime.state"));
  assert.ok(events.some((event) => event.kind === "audit.logged"));
});

test("runtime state recorder retries remote delivery through the durable outbox", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-state-outbox-"));
  const eventBus = new InMemoryTeamEventBus();
  let attempts = 0;
  const delivered: string[][] = [];

  try {
    const recorder = new DefaultRuntimeStateRecorder({
      teamEventBus: eventBus,
      remoteOutboxRootDir: tempDir,
      remoteSink: async (items) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient state sink outage");
        }
        delivered.push(items.map((item) => item.chain.chainId));
      },
    });

    await recorder.record({
      chain: {
        chainId: "flow:flow-outbox",
        threadId: "thread-outbox",
        rootKind: "flow",
        rootId: "flow-outbox",
        flowId: "flow-outbox",
        createdAt: 1,
        updatedAt: 2,
      },
      status: {
        chainId: "flow:flow-outbox",
        threadId: "thread-outbox",
        phase: "waiting",
        latestSummary: "Waiting on browser continuity.",
        attention: true,
        updatedAt: 2,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 140));
    await recorder.flush();

    const events = await eventBus.listRecent("thread-outbox", 10);
    const outbox = new FileBatchOutbox<unknown>({
      rootDir: tempDir,
    });
    let remaining = await outbox.listDue();
    for (let attempt = 0; remaining.length > 0 && attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      remaining = await outbox.listDue();
    }

    assert.equal(attempts, 2);
    assert.deepEqual(delivered, [["flow:flow-outbox"]]);
    assert.equal(remaining.length, 0);
    assert.ok(events.some((event) => event.kind === "runtime.state"));
    assert.ok(
      events.some(
        (event) => event.kind === "audit.logged" && String(event.payload.summary).includes("Retrying remote sink delivery")
      )
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runtime state recorder persists failed remote deliveries in the durable outbox", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runtime-state-outbox-drop-"));
  const eventBus = new InMemoryTeamEventBus();

  try {
    const recorder = new DefaultRuntimeStateRecorder({
      teamEventBus: eventBus,
      remoteOutboxRootDir: tempDir,
      remoteSink: async () => {
        throw new Error("remote state sink unavailable");
      },
    });

    await recorder.record({
      chain: {
        chainId: "flow:flow-outbox-drop",
        threadId: "thread-outbox-drop",
        rootKind: "flow",
        rootId: "flow-outbox-drop",
        flowId: "flow-outbox-drop",
        createdAt: 1,
        updatedAt: 2,
      },
      status: {
        chainId: "flow:flow-outbox-drop",
        threadId: "thread-outbox-drop",
        phase: "waiting",
        latestSummary: "Waiting on a failing remote state sink.",
        attention: true,
        updatedAt: 2,
      },
    });
    const outbox = new FileBatchOutbox<unknown>({
      rootDir: tempDir,
    });
    const remaining = await waitForOutboxItems(
      outbox,
      1,
      (items) =>
        (items[0] as { attemptCount?: number; lastError?: string } | undefined)?.attemptCount === 1 &&
        String((items[0] as { lastError?: string } | undefined)?.lastError ?? "").includes("remote state sink unavailable")
    );

    assert.equal(remaining.length, 1);
    assert.equal((remaining[0] as { attemptCount?: number }).attemptCount, 1);
    assert.match(String((remaining[0] as { lastError?: string }).lastError ?? ""), /remote state sink unavailable/);

    const events = await eventBus.listRecent("thread-outbox-drop", 10);
    assert.ok(events.some((event) => event.kind === "runtime.state"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

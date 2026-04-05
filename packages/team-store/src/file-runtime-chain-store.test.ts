import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FileRuntimeChainEventStore } from "./file-runtime-chain-event-store";
import { FileRuntimeChainSpanStore } from "./file-runtime-chain-span-store";
import { FileRuntimeChainStatusStore } from "./file-runtime-chain-status-store";
import { FileRuntimeChainStore } from "./file-runtime-chain-store";

test("runtime chain stores persist chains, spans, events, and active status", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-runtime-chain-store-"));

  try {
    const chainStore = new FileRuntimeChainStore({
      rootDir: path.join(rootDir, "chains"),
    });
    const spanStore = new FileRuntimeChainSpanStore({
      rootDir: path.join(rootDir, "spans"),
    });
    const eventStore = new FileRuntimeChainEventStore({
      rootDir: path.join(rootDir, "events"),
    });
    const statusStore = new FileRuntimeChainStatusStore({
      rootDir: path.join(rootDir, "status"),
    });

    await chainStore.put({
      chainId: "flow:flow-1",
      threadId: "thread-1",
      rootKind: "flow",
      rootId: "flow-1",
      flowId: "flow-1",
      createdAt: 10,
      updatedAt: 20,
    });

    await spanStore.put({
      spanId: "flow:flow-1",
      chainId: "flow:flow-1",
      subjectKind: "flow",
      subjectId: "flow-1",
      threadId: "thread-1",
      flowId: "flow-1",
      createdAt: 10,
      updatedAt: 20,
    });
    await spanStore.put({
      spanId: "dispatch:task-1",
      chainId: "flow:flow-1",
      parentSpanId: "flow:flow-1",
      subjectKind: "dispatch",
      subjectId: "task-1",
      threadId: "thread-1",
      flowId: "flow-1",
      taskId: "task-1",
      roleId: "lead",
      createdAt: 21,
      updatedAt: 21,
    });

    await eventStore.append({
      eventId: "event-1",
      chainId: "flow:flow-1",
      spanId: "flow:flow-1",
      threadId: "thread-1",
      subjectKind: "flow",
      subjectId: "flow-1",
      phase: "started",
      recordedAt: 10,
      summary: "Flow created",
    });
    await eventStore.append({
      eventId: "event-2",
      chainId: "flow:flow-1",
      spanId: "dispatch:task-1",
      parentSpanId: "flow:flow-1",
      threadId: "thread-1",
      subjectKind: "dispatch",
      subjectId: "task-1",
      phase: "waiting",
      recordedAt: 21,
      summary: "Dispatch enqueued",
      statusReason: "waiting for lead",
    });

    await statusStore.put({
      chainId: "flow:flow-1",
      threadId: "thread-1",
      activeSpanId: "dispatch:task-1",
      activeSubjectKind: "dispatch",
      activeSubjectId: "task-1",
      phase: "waiting",
      waitingReason: "waiting for lead",
      latestSummary: "Dispatch enqueued",
      lastHeartbeatAt: 21,
      attention: false,
      updatedAt: 21,
    });
    await statusStore.put({
      chainId: "flow:flow-2",
      threadId: "thread-2",
      phase: "resolved",
      latestSummary: "done",
      attention: false,
      updatedAt: 30,
    });

    const chains = await chainStore.listByThread("thread-1");
    const spans = await spanStore.listByChain("flow:flow-1");
    const events = await eventStore.listByChain("flow:flow-1", 10);
    const active = await statusStore.listActive(10);

    assert.equal(chains.length, 1);
    assert.equal(chains[0]?.chainId, "flow:flow-1");
    assert.equal(spans.length, 2);
    assert.equal(spans[1]?.spanId, "dispatch:task-1");
    assert.equal(events.length, 2);
    assert.equal(events[1]?.statusReason, "waiting for lead");
    assert.equal(active.length, 1);
    assert.equal(active[0]?.chainId, "flow:flow-1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runtime chain store merges thread-scoped and legacy thread records", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-runtime-chain-legacy-"));

  try {
    const chainStore = new FileRuntimeChainStore({
      rootDir: path.join(rootDir, "chains"),
    });
    await chainStore.put({
      chainId: "flow:new",
      threadId: "thread-1",
      rootKind: "flow",
      rootId: "flow:new",
      flowId: "flow:new",
      createdAt: 10,
      updatedAt: 20,
    });
    await writeJsonFileAtomic(path.join(rootDir, "chains", "flow_legacy.json"), {
      chainId: "flow:legacy",
      threadId: "thread-1",
      rootKind: "flow",
      rootId: "flow:legacy",
      flowId: "flow:legacy",
      createdAt: 5,
      updatedAt: 15,
    });

    const chains = await chainStore.listByThread("thread-1");
    assert.deepEqual(
      chains.map((chain) => chain.chainId),
      ["flow:new", "flow:legacy"]
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

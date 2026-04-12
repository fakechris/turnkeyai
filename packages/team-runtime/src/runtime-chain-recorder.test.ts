import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeChainSpan, RuntimeChainSpanStore } from "@turnkeyai/core-types/team";
import { FileRuntimeChainEventStore } from "@turnkeyai/team-store/file-runtime-chain-event-store";
import { FileRuntimeChainSpanStore } from "@turnkeyai/team-store/file-runtime-chain-span-store";
import { FileRuntimeChainStatusStore } from "@turnkeyai/team-store/file-runtime-chain-status-store";
import { FileRuntimeChainStore } from "@turnkeyai/team-store/file-runtime-chain-store";

import { DefaultRuntimeChainRecorder } from "./runtime-chain-recorder";

class ConflictInjectingSpanStore implements RuntimeChainSpanStore {
  private readonly inner: FileRuntimeChainSpanStore;
  private injectedConflict = false;

  constructor(inner: FileRuntimeChainSpanStore) {
    this.inner = inner;
  }

  async get(spanId: string): Promise<RuntimeChainSpan | null> {
    return this.inner.get(spanId);
  }

  async put(span: RuntimeChainSpan, options?: { expectedVersion?: number | undefined }): Promise<void> {
    if (
      !this.injectedConflict &&
      span.spanId === "dispatch:task-race" &&
      options?.expectedVersion === 0
    ) {
      this.injectedConflict = true;
      const { roleId: _roleId, ...thinSpan } = span;
      await this.inner.put({
        ...thinSpan,
        createdAt: span.createdAt - 10,
        updatedAt: span.updatedAt - 10,
      });
      throw new Error(
        `runtime chain span version conflict for ${span.spanId}: expected ${options.expectedVersion}, found 1`
      );
    }
    await this.inner.put(span, options);
  }

  async listByChain(chainId: string): Promise<RuntimeChainSpan[]> {
    return this.inner.listByChain(chainId);
  }
}

test("runtime chain recorder tracks flow creation, dispatch, and resolution", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-runtime-chain-recorder-"));

  try {
    const chainStore = new FileRuntimeChainStore({ rootDir: path.join(rootDir, "chains") });
    const spanStore = new FileRuntimeChainSpanStore({ rootDir: path.join(rootDir, "spans") });
    const eventStore = new FileRuntimeChainEventStore({ rootDir: path.join(rootDir, "events") });
    const statusStore = new FileRuntimeChainStatusStore({ rootDir: path.join(rootDir, "status") });
    const recorder = new DefaultRuntimeChainRecorder({
      chainStore,
      spanStore,
      eventStore,
      statusStore,
      clock: {
        now: () => 50,
      },
    });

    const flow = {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "msg-root",
      mode: "serial" as const,
      status: "created" as const,
      currentStageIndex: 0,
      activeRoleIds: [],
      completedRoleIds: [],
      failedRoleIds: [],
      nextExpectedRoleId: "lead",
      hopCount: 0,
      maxHops: 5,
      edges: [],
      shardGroups: [],
      createdAt: 10,
      updatedAt: 10,
    };

    await recorder.recordFlowCreated(flow);
    const handoff = {
      taskId: "task-1",
      flowId: flow.flowId,
      sourceMessageId: "msg-root",
      targetRoleId: "lead",
      activationType: "cascade" as const,
      threadId: flow.threadId,
      payload: {
        threadId: flow.threadId,
        relayBrief: "brief",
        recentMessages: [],
      },
      createdAt: 20,
    };
    const waitingFlow = {
      ...flow,
      status: "waiting_role" as const,
      activeRoleIds: ["lead"],
      hopCount: 1,
      edges: [
        {
          edgeId: "task-1:edge",
          flowId: flow.flowId,
          toRoleId: "lead",
          sourceMessageId: "msg-root",
          state: "delivered" as const,
          createdAt: 20,
        },
      ],
      updatedAt: 20,
    };

    await recorder.recordDispatchEnqueued({
      flow: waitingFlow,
      handoff,
    });
    await recorder.syncFlowStatus(waitingFlow);

    const resolvedFlow = {
      ...waitingFlow,
      status: "completed" as const,
      activeRoleIds: [],
      completedRoleIds: ["lead"],
      edges: [
        {
          ...waitingFlow.edges[0]!,
          state: "closed" as const,
          respondedAt: 30,
          closedAt: 30,
        },
      ],
      updatedAt: 30,
    };
    await recorder.syncFlowStatus(resolvedFlow);

    const chain = await chainStore.get("flow:flow-1");
    const spans = await spanStore.listByChain("flow:flow-1");
    const events = await eventStore.listByChain("flow:flow-1", 20);
    const status = await statusStore.get("flow:flow-1");

    assert.ok(chain);
    assert.equal(spans.length, 2);
    assert.equal(spans[1]?.subjectKind, "dispatch");
    assert.equal(events.length, 4);
    assert.equal(events[1]?.subjectKind, "dispatch");
    assert.equal(status?.phase, "resolved");
    assert.equal(status?.lastCompletedSpanId, "dispatch:task-1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runtime chain recorder materializes dispatch span from flow status without prior enqueue", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-runtime-chain-recorder-sync-"));

  try {
    const chainStore = new FileRuntimeChainStore({ rootDir: path.join(rootDir, "chains") });
    const spanStore = new FileRuntimeChainSpanStore({ rootDir: path.join(rootDir, "spans") });
    const eventStore = new FileRuntimeChainEventStore({ rootDir: path.join(rootDir, "events") });
    const statusStore = new FileRuntimeChainStatusStore({ rootDir: path.join(rootDir, "status") });
    const recorder = new DefaultRuntimeChainRecorder({
      chainStore,
      spanStore,
      eventStore,
      statusStore,
      clock: {
        now: () => 99,
      },
    });

    const flow = {
      flowId: "flow-2",
      threadId: "thread-1",
      rootMessageId: "msg-root",
      mode: "serial" as const,
      status: "waiting_role" as const,
      currentStageIndex: 0,
      activeRoleIds: ["lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      nextExpectedRoleId: "lead",
      hopCount: 1,
      maxHops: 5,
      edges: [
        {
          edgeId: "task-2:edge",
          flowId: "flow-2",
          toRoleId: "lead",
          sourceMessageId: "msg-root",
          state: "delivered" as const,
          createdAt: 20,
        },
      ],
      shardGroups: [],
      createdAt: 10,
      updatedAt: 20,
    };

    await recorder.recordFlowCreated(flow);
    await recorder.syncFlowStatus(flow);

    const spans = await spanStore.listByChain("flow:flow-2");
    const status = await statusStore.get("flow:flow-2");

    assert.ok(spans.some((span) => span.spanId === "dispatch:task-2"));
    assert.equal(status?.activeSpanId, "dispatch:task-2");
    assert.equal(status?.lastCompletedSpanId, undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runtime chain recorder merges richer dispatch span data after CAS creation conflict", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-runtime-chain-recorder-race-"));

  try {
    const chainStore = new FileRuntimeChainStore({ rootDir: path.join(rootDir, "chains") });
    const innerSpanStore = new FileRuntimeChainSpanStore({ rootDir: path.join(rootDir, "spans") });
    const spanStore = new ConflictInjectingSpanStore(innerSpanStore);
    const eventStore = new FileRuntimeChainEventStore({ rootDir: path.join(rootDir, "events") });
    const statusStore = new FileRuntimeChainStatusStore({ rootDir: path.join(rootDir, "status") });
    const recorder = new DefaultRuntimeChainRecorder({
      chainStore,
      spanStore,
      eventStore,
      statusStore,
      clock: {
        now: () => 99,
      },
    });

    const flow = {
      flowId: "flow-race",
      threadId: "thread-race",
      rootMessageId: "msg-root",
      mode: "serial" as const,
      status: "created" as const,
      currentStageIndex: 0,
      activeRoleIds: [],
      completedRoleIds: [],
      failedRoleIds: [],
      nextExpectedRoleId: "lead",
      hopCount: 0,
      maxHops: 5,
      edges: [],
      shardGroups: [],
      createdAt: 10,
      updatedAt: 10,
    };
    const handoff = {
      taskId: "task-race",
      flowId: flow.flowId,
      sourceMessageId: "msg-root",
      targetRoleId: "lead",
      activationType: "cascade" as const,
      threadId: flow.threadId,
      payload: {
        threadId: flow.threadId,
        relayBrief: "brief",
        recentMessages: [],
      },
      createdAt: 40,
    };
    const waitingFlow = {
      ...flow,
      status: "waiting_role" as const,
      activeRoleIds: ["lead"],
      hopCount: 1,
      edges: [
        {
          edgeId: "task-race:edge",
          flowId: flow.flowId,
          toRoleId: "lead",
          sourceMessageId: "msg-root",
          state: "delivered" as const,
          createdAt: 40,
        },
      ],
      updatedAt: 40,
    };

    await recorder.recordFlowCreated(flow);
    await recorder.recordDispatchEnqueued({
      flow: waitingFlow,
      handoff,
    });

    const dispatchSpan = await innerSpanStore.get("dispatch:task-race");
    assert.ok(dispatchSpan);
    assert.equal(dispatchSpan.roleId, "lead");
    assert.equal(dispatchSpan.parentSpanId, "flow:flow-race");
    assert.equal(dispatchSpan.createdAt, 30);
    assert.equal(dispatchSpan.updatedAt, 40);
    assert.equal(dispatchSpan.version, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

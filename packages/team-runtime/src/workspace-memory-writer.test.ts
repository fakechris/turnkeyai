import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceMemorySourceEvent } from "@turnkeyai/core-types/team";
import { FileWorkspaceMemoryStore } from "@turnkeyai/team-store/context/file-workspace-memory-store";

import { DefaultWorkspaceMemoryWriter } from "./workspace-memory-writer";

function event(
  sequence: number,
  content: string,
  authoritative = true,
): WorkspaceMemorySourceEvent {
  return {
    eventId: `${authoritative ? "user" : "runtime"}:event-${sequence}`,
    workspaceId: "workspace-1",
    threadId: "thread-1",
    sequence,
    kind: authoritative ? "user-message" : "runtime-message",
    content,
    sourceRefs: [`message:${sequence}`],
    occurredAt: sequence,
    authoritative,
  };
}

async function setup(options: {
  events: WorkspaceMemorySourceEvent[];
  minSourceDelta?: number;
  pollIntervalMs?: number;
  propose?: ConstructorParameters<
    typeof DefaultWorkspaceMemoryWriter
  >[0]["propose"];
}) {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "turnkeyai-memory-writer-"),
  );
  const store = new FileWorkspaceMemoryStore({ rootDir });
  let now = 100;
  const writer = new DefaultWorkspaceMemoryWriter({
    store,
    loadEvents: async ({ afterSequence, limit }) =>
      options.events
        .filter((candidate) => candidate.sequence > afterSequence)
        .slice(0, limit),
    ...(options.propose ? { propose: options.propose } : {}),
    minSourceDelta: options.minSourceDelta ?? 1,
    pollIntervalMs: options.pollIntervalMs ?? 100_000,
    idleDelayMs: 100_000,
    now: () => ++now,
  });
  return { store, writer };
}

test("workspace memory writer consumes deltas and persists a durable cursor", async () => {
  const { store, writer } = await setup({
    events: [event(1, "偏好：报告必须使用中文。")],
  });
  await writer.enqueue({
    workspaceId: "workspace-1",
    trigger: "manual",
    force: true,
  });
  await writer.flush();

  const snapshot = await store.getSnapshot("workspace-1");
  assert.equal(snapshot.cursor.lastSequence, 1);
  assert.equal(snapshot.records[0]?.confidence, "authoritative");
  assert.match(snapshot.records[0]?.content ?? "", /中文/);
  assert.equal(snapshot.audits[0]?.status, "written");
});

test("workspace memory writer coalesces through the turn interval", async () => {
  const events = Array.from({ length: 10 }, (_, index) =>
    event(index + 1, `普通消息 ${index + 1}`)
  );
  const { store, writer } = await setup({
    events,
    minSourceDelta: 10,
  });
  await writer.enqueue({
    workspaceId: "workspace-1",
    trigger: "turn-interval",
  });
  await writer.flush();

  const snapshot = await store.getSnapshot("workspace-1");
  assert.equal(snapshot.cursor.lastSequence, 10);
  assert.equal(snapshot.records.length, 0);
  assert.equal(snapshot.audits[0]?.status, "noop");
});

test("workspace memory writer rejects inferred correction over user authority", async () => {
  const { store, writer } = await setup({
    events: [
      event(1, "偏好：输出格式必须是表格。"),
      event(2, "偏好：输出格式必须是散文。", false),
    ],
  });
  await writer.enqueue({
    workspaceId: "workspace-1",
    trigger: "manual",
    force: true,
  });
  await writer.flush();

  const snapshot = await store.getSnapshot("workspace-1");
  assert.equal(snapshot.records.length, 1);
  assert.match(snapshot.records[0]?.content ?? "", /表格/);
  assert.ok(snapshot.audits[0]?.rejectedMutations.length);
});

test("workspace memory writer records failure and retries independently", async () => {
  let attempts = 0;
  const { store, writer } = await setup({
    events: [event(1, "记住：预算是 500 元。")],
    propose: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("writer model unavailable");
      return [];
    },
  });
  await writer.enqueue({
    workspaceId: "workspace-1",
    trigger: "manual",
    force: true,
  });
  await writer.flush();

  const snapshot = await store.getSnapshot("workspace-1");
  assert.equal(attempts, 2);
  assert.equal(snapshot.cursor.lastSequence, 1);
  assert.equal(snapshot.audits[0]?.status, "failed");
  assert.equal(snapshot.audits[1]?.status, "noop");
});

test("workspace memory writer flush waits for an in-flight background drain", async () => {
  let releaseProposal: (() => void) | undefined;
  const proposalGate = new Promise<void>((resolve) => {
    releaseProposal = resolve;
  });
  let markProposalStarted: (() => void) | undefined;
  const proposalStarted = new Promise<void>((resolve) => {
    markProposalStarted = resolve;
  });
  const { store, writer } = await setup({
    events: [event(1, "记住：交付前必须运行测试。")],
    pollIntervalMs: 0,
    propose: async () => {
      markProposalStarted?.();
      await proposalGate;
      return [];
    },
  });
  await writer.enqueue({
    workspaceId: "workspace-1",
    trigger: "turn-interval",
  });
  await proposalStarted;

  let flushCompleted = false;
  const flush = writer.flush().then(() => {
    flushCompleted = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flushCompleted, false);

  releaseProposal?.();
  await flush;
  assert.equal(
    (await store.getSnapshot("workspace-1")).cursor.lastSequence,
    1,
  );
  await writer.close();
});

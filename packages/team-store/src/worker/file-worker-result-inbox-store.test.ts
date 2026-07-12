import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  WorkerJoinRecord,
  WorkerResultNotification,
} from "@turnkeyai/core-types/team";
import { FileWorkerResultInboxStore } from "./file-worker-result-inbox-store";

function notification(
  overrides: Partial<WorkerResultNotification> = {},
): WorkerResultNotification {
  return {
    notificationId: "worker-result:1",
    ownerScopeId: "mission:1",
    sourceScopeId: "worker:explore:1",
    sourceVersion: 20,
    resultRef: "worker-session:worker:explore:1",
    state: "pending",
    createdAt: 21,
    ...overrides,
  };
}

function join(overrides: Partial<WorkerJoinRecord> = {}): WorkerJoinRecord {
  return {
    joinId: "join:1",
    ownerScopeId: "mission:1",
    sourceScopeId: "worker:explore:1",
    state: "waiting",
    createdAt: 10,
    expiresAt: 30,
    ...overrides,
  };
}

test("worker result inbox persists one idempotent notification across restart", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-worker-inbox-"));
  try {
    const first = new FileWorkerResultInboxStore({ rootDir });
    assert.deepEqual(await first.putNotification(notification()), notification());
    assert.deepEqual(await first.putNotification(notification()), notification());

    const restarted = new FileWorkerResultInboxStore({ rootDir });
    assert.deepEqual(
      await restarted.listNotifications({ ownerScopeId: "mission:1", state: "pending" }),
      [notification()],
    );
    await assert.rejects(
      () => restarted.putNotification(notification({ sourceVersion: 21 })),
      /notification id reused/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("worker result inbox consumes only after a stable durable message id", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-worker-inbox-"));
  try {
    const store = new FileWorkerResultInboxStore({ rootDir });
    await store.putNotification(notification());
    const consumed = await store.consumeNotification({
      notificationId: "worker-result:1",
      consumedAt: 40,
      consumedByMessageId: "message:1",
    });
    assert.equal(consumed.state, "consumed");
    assert.equal(consumed.consumedByMessageId, "message:1");
    assert.deepEqual(
      await store.consumeNotification({
        notificationId: "worker-result:1",
        consumedAt: 50,
        consumedByMessageId: "message:1",
      }),
      consumed,
    );
    await assert.rejects(
      () => store.consumeNotification({
        notificationId: "worker-result:1",
        consumedAt: 60,
        consumedByMessageId: "message:2",
      }),
      /already consumed/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("join satisfaction and expiry never remove the detached result", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-worker-inbox-"));
  try {
    const store = new FileWorkerResultInboxStore({ rootDir });
    await store.putJoin(join());
    await store.putJoin(join({
      joinId: "join:expired",
      ownerScopeId: "mission:terminal-parent",
      expiresAt: 15,
    }));
    await store.putJoin(join({
      joinId: "join:late-result",
      sourceScopeId: "worker:explore:late",
      expiresAt: 22,
    }));
    const abandoned = await store.abandonExpiredJoins({ now: 20 });
    assert.deepEqual(abandoned.map((record) => record.joinId), ["join:expired"]);

    await store.putNotification(notification());
    const satisfied = await store.satisfyWaitingJoins({
      sourceScopeId: "worker:explore:1",
      notificationId: "worker-result:1",
      resolvedAt: 21,
    });
    assert.deepEqual(satisfied.map((record) => record.joinId), ["join:1"]);
    assert.equal((await store.getJoin("join:1"))?.state, "satisfied");
    assert.equal((await store.getJoin("join:expired"))?.state, "abandoned");
    assert.deepEqual(
      await store.satisfyWaitingJoins({
        sourceScopeId: "worker:explore:late",
        notificationId: "worker-result:late",
        resolvedAt: 23,
      }),
      [],
    );
    await store.abandonExpiredJoins({ now: 23 });
    assert.equal((await store.getJoin("join:late-result"))?.state, "abandoned");
    assert.deepEqual(
      await store.listNotifications({ ownerScopeId: "mission:1", state: "pending" }),
      [notification()],
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

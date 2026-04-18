import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBatchOutbox } from "./file-batch-outbox";

test("file batch outbox claims pending batches and acknowledges them by lease", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "file-batch-outbox-claim-"));
  let now = 1_000;

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
      now: () => now,
    });
    const batch = await outbox.enqueue([1, 2, 3]);

    const claimed = await outbox.claimDue({
      leaseDurationMs: 500,
      now,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.batchId, batch.batchId);
    assert.equal(claimed[0]?.state, "inflight");
    assert.ok(claimed[0]?.leaseId);

    const dueAfterClaim = await outbox.listDue(32, now);
    assert.equal(dueAfterClaim.length, 0);

    const acked = await outbox.ack(batch.batchId, claimed[0]!.leaseId);
    assert.equal(acked, true);
    assert.equal(await outbox.get(batch.batchId), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file batch outbox reclaims expired inflight batches after restart-safe lease expiry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "file-batch-outbox-reclaim-"));
  let now = 1_000;

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
      now: () => now,
    });
    const batch = await outbox.enqueue([9]);
    const firstClaim = await outbox.claimDue({
      leaseDurationMs: 100,
      now,
    });
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0]?.batchId, batch.batchId);

    now = 1_250;
    const reclaimed = await outbox.claimDue({
      leaseDurationMs: 100,
      now,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.batchId, batch.batchId);
    assert.notEqual(reclaimed[0]?.leaseId, firstClaim[0]?.leaseId);
    assert.equal(reclaimed[0]?.lastAttemptAt, 1_250);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file batch outbox preserves original creation time across retries and dead-letter transitions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "file-batch-outbox-dead-letter-"));
  let now = 10_000;

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
      now: () => now,
    });
    const batch = await outbox.enqueue([42]);

    const claim = await outbox.claimDue({
      leaseDurationMs: 100,
      now,
    });
    now = 10_050;
    const retried = await outbox.reschedule(batch.batchId, {
      attemptCount: 1,
      delayMs: 25,
      items: [42],
      error: new Error("temporary failure"),
      leaseId: claim[0]!.leaseId,
    });
    assert.equal(retried.createdAt, batch.createdAt);
    assert.equal(retried.state, "pending");
    assert.equal(retried.attemptCount, 1);

    now = 10_100;
    const secondClaim = await outbox.claimDue({
      leaseDurationMs: 100,
      now,
    });
    now = 10_150;
    const deadLetter = await outbox.deadLetter(batch.batchId, {
      attemptCount: 2,
      items: [42],
      error: new Error("permanent failure"),
      leaseId: secondClaim[0]!.leaseId,
    });
    assert.equal(deadLetter.createdAt, batch.createdAt);
    assert.equal(deadLetter.state, "dead_letter");
    assert.equal(deadLetter.attemptCount, 2);
    assert.equal(deadLetter.deadLetteredAt, 10_150);

    const inspection = await outbox.inspect(now);
    assert.equal(inspection.deadLetterBatches, 1);
    assert.deepEqual(inspection.affectedBatchIds, [batch.batchId]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file batch outbox can release an optimistic claim back to pending without incrementing attempts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "file-batch-outbox-release-"));
  let now = 20_000;

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
      now: () => now,
    });
    const claimed = await outbox.enqueueClaimed([7], {
      leaseDurationMs: 100,
    });
    assert.equal(claimed.state, "inflight");
    assert.equal(claimed.attemptCount, 0);

    now = 20_010;
    const released = await outbox.release(claimed.batchId, {
      leaseId: claimed.leaseId,
      error: new Error("optimistic materialization failed"),
    });
    assert.equal(released.state, "pending");
    assert.equal(released.attemptCount, 0);
    assert.equal(released.availableAt, 20_010);
    assert.equal(released.lastError, "optimistic materialization failed");

    const due = await outbox.listDue(32, now);
    assert.equal(due.length, 1);
    assert.equal(due[0]?.batchId, claimed.batchId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file batch outbox preserves dead letters and reclaimable inflight batches across store recreation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "file-batch-outbox-restart-"));
  let now = 30_000;

  try {
    let outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
      now: () => now,
    });
    const inflight = await outbox.enqueueClaimed([1], {
      leaseDurationMs: 50,
    });
    const pending = await outbox.enqueue([2]);
    const pendingClaim = await outbox.claimDue({
      leaseDurationMs: 50,
      now,
    });
    await outbox.deadLetter(pending.batchId, {
      attemptCount: 1,
      items: [2],
      error: new Error("permanent failure"),
      leaseId: pendingClaim[0]!.leaseId,
    });

    now = 30_200;
    outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
      now: () => now,
    });

    const inspection = await outbox.inspect(now);
    assert.equal(inspection.deadLetterBatches, 1);
    assert.equal(inspection.expiredInflightBatches, 1);
    assert.deepEqual(inspection.affectedBatchIds.sort(), [inflight.batchId, pending.batchId].sort());

    const reclaimed = await outbox.claimDue({
      leaseDurationMs: 50,
      now,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.batchId, inflight.batchId);
    assert.notEqual(reclaimed[0]?.leaseId, inflight.leaseId);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBatchOutbox } from "./file-batch-outbox";
import { OutboxBatchShipper } from "./outbox-batch-shipper";

test("outbox batch shipper retries durable batches before succeeding", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outbox-batch-shipper-"));
  let attempts = 0;

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
    });
    const delivered: number[][] = [];
    const shipper = new OutboxBatchShipper<number>({
      outbox,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      sink: async (items) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("remote sink unavailable");
        }
        delivered.push(items);
      },
    });

    await shipper.enqueue([1, 2, 3]);
    await shipper.flush();

    assert.equal(attempts, 2);
    assert.deepEqual(delivered, [[1, 2, 3]]);
    const remaining = await outbox.listDue();
    assert.equal(remaining.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outbox batch shipper start drains pre-existing due batches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outbox-batch-shipper-start-"));

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
    });
    await outbox.enqueue([7, 8, 9]);

    const delivered: number[][] = [];
    const shipper = new OutboxBatchShipper<number>({
      outbox,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      sink: async (items) => {
        delivered.push(items);
      },
    });

    shipper.start();
    await shipper.flush();

    assert.deepEqual(delivered, [[7, 8, 9]]);
    const remaining = await outbox.listDue();
    assert.equal(remaining.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outbox batch shipper keeps exhausted batches as dead letters", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outbox-batch-shipper-dead-letter-"));

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
    });
    const droppedBatchIds: string[] = [];
    const shipper = new OutboxBatchShipper<number>({
      outbox,
      maxRetries: 1,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      sink: async () => {
        throw new Error("still unavailable");
      },
      onDroppedBatch: async (batch) => {
        droppedBatchIds.push(batch.batchId);
      },
    });

    await shipper.enqueue([5, 6]);
    await shipper.flush();

    const deadLetters = await outbox.listDeadLetters();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]?.state, "dead_letter");
    assert.equal(deadLetters[0]?.attemptCount, 2);
    assert.deepEqual(droppedBatchIds, [deadLetters[0]!.batchId]);
    assert.equal((await outbox.listDue()).length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("outbox batch shipper reclaims expired inflight batches on a new shipper instance", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "outbox-batch-shipper-reclaim-"));
  let now = 1_000;

  try {
    const outbox = new FileBatchOutbox<number>({
      rootDir: tempDir,
      now: () => now,
    });
    await outbox.enqueue([11]);
    const claimed = await outbox.claimDue({
      leaseDurationMs: 10,
      now,
    });
    assert.equal(claimed.length, 1);

    now = 2_000;
    const delivered: number[][] = [];
    const shipper = new OutboxBatchShipper<number>({
      outbox,
      now: () => now,
      leaseDurationMs: 10,
      sink: async (items) => {
        delivered.push(items);
      },
    });

    shipper.start();
    await shipper.flush();

    assert.deepEqual(delivered, [[11]]);
    assert.equal((await outbox.listDeadLetters()).length, 0);
    assert.equal((await outbox.listDue()).length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

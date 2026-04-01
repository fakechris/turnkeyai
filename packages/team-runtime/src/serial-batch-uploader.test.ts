import assert from "node:assert/strict";
import test from "node:test";

import { SerialBatchUploader } from "./serial-batch-uploader";

test("serial batch uploader batches by item and byte limits and drops oldest overflow", async () => {
  const batches: number[][] = [];
  const dropped: number[] = [];
  let releaseFirstBatch: (() => void) | undefined;
  const firstBatchGate = new Promise<void>((resolve) => {
    releaseFirstBatch = resolve;
  });
  const uploader = new SerialBatchUploader<number>({
    maxBufferedItems: 3,
    maxBatchItems: 2,
    maxBatchBytes: 3,
    estimateBytes: () => 2,
    sink: async (items) => {
      if (batches.length === 0) {
        await firstBatchGate;
      }
      batches.push(items);
    },
    onDropped: async (count) => {
      dropped.push(count);
    },
  });

  const pending = Promise.all([
    uploader.enqueue(1),
    uploader.enqueue(2),
    uploader.enqueue(3),
    uploader.enqueue(4),
    uploader.enqueue(5),
  ]);
  releaseFirstBatch?.();
  await pending;
  await uploader.flush();

  assert.deepEqual(batches, [[3], [4], [5]]);
  assert.deepEqual(dropped, [1, 1]);
});

test("serial batch uploader retries failed batches before dropping them", async () => {
  const batches: number[][] = [];
  const retryDelays: number[] = [];
  let attempts = 0;
  const uploader = new SerialBatchUploader<number>({
    maxRetries: 2,
    retryDelayMs: 1,
    backoffMultiplier: 3,
    maxRetryDelayMs: 5,
    onRetryScheduled: async (_, _attempt, delayMs) => {
      retryDelays.push(delayMs);
    },
    sink: async (items) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("temporary sink failure");
      }
      batches.push(items);
    },
  });

  await uploader.enqueue(1);
  await uploader.flush();

  assert.equal(attempts, 3);
  assert.deepEqual(batches, [[1]]);
  assert.deepEqual(retryDelays, [1, 3]);
});

test("serial batch uploader ignores retry hook failures", async () => {
  let attempts = 0;
  const delivered: number[][] = [];
  const uploader = new SerialBatchUploader<number>({
    maxRetries: 1,
    retryDelayMs: 1,
    onRetryScheduled: async () => {
      throw new Error("retry hook unavailable");
    },
    sink: async (items) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary sink failure");
      }
      delivered.push(items);
    },
  });

  await uploader.enqueue(1);
  await uploader.flush();

  assert.equal(attempts, 2);
  assert.deepEqual(delivered, [[1]]);
});

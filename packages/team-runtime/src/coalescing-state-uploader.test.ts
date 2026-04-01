import assert from "node:assert/strict";
import test from "node:test";

import { CoalescingStateUploader } from "./coalescing-state-uploader";

test("coalescing state uploader keeps only the latest pending value per key", async () => {
  const batches: Array<Array<{ key: string; value: number }>> = [];
  let releaseFirstBatch: (() => void) | undefined;
  const firstBatchGate = new Promise<void>((resolve) => {
    releaseFirstBatch = resolve;
  });
  const uploader = new CoalescingStateUploader<string, { key: string; value: number }>({
    sink: async (items) => {
      if (batches.length === 0) {
        await firstBatchGate;
      }
      batches.push(items);
    },
  });

  const pending = Promise.all([
    uploader.upsert("chain-1", { key: "chain-1", value: 1 }),
    uploader.upsert("chain-1", { key: "chain-1", value: 2 }),
    uploader.upsert("chain-2", { key: "chain-2", value: 3 }),
    uploader.upsert("chain-1", { key: "chain-1", value: 4 }),
  ]);
  releaseFirstBatch?.();
  await pending;
  await uploader.flush();

  assert.deepEqual(batches, [[
    { key: "chain-1", value: 4 },
    { key: "chain-2", value: 3 },
  ]]);
});

test("coalescing state uploader retries and bounds pending keys", async () => {
  const dropped: number[] = [];
  let attempts = 0;
  const delivered: Array<Array<{ key: string; value: number }>> = [];
  const uploader = new CoalescingStateUploader<string, { key: string; value: number }>({
    maxPendingKeys: 2,
    maxRetries: 1,
    retryDelayMs: 1,
    onDroppedKeys: async (count) => {
      dropped.push(count);
    },
    sink: async (items) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary state sink failure");
      }
      delivered.push(items);
    },
  });

  await uploader.upsert("chain-1", { key: "chain-1", value: 1 });
  await uploader.upsert("chain-2", { key: "chain-2", value: 2 });
  await uploader.upsert("chain-3", { key: "chain-3", value: 3 });
  await uploader.flush();

  assert.ok(attempts >= 2);
  assert.ok(dropped.length <= 1);
  assert.ok(dropped.every((count) => count === 1));
  assert.deepEqual(delivered.at(-1), [
    { key: "chain-3", value: 3 },
  ]);
  assert.ok(
    delivered.every((batch) => batch.length >= 1 && batch.length <= 2),
  );
});

test("coalescing state uploader supports scheduled drains", async () => {
  const delivered: Array<Array<{ key: string; value: number }>> = [];
  const uploader = new CoalescingStateUploader<string, { key: string; value: number }>({
    drainMode: "scheduled",
    scheduleDelayMs: 25,
    sink: async (items) => {
      delivered.push(items);
    },
  });

  await uploader.upsert("chain-1", { key: "chain-1", value: 1 });
  await uploader.upsert("chain-1", { key: "chain-1", value: 2 });
  assert.equal(delivered.length, 0);

  await uploader.flush();
  assert.deepEqual(delivered, [[{ key: "chain-1", value: 2 }]]);
});

test("coalescing state uploader ignores retry hook failures", async () => {
  let attempts = 0;
  const delivered: Array<Array<{ key: string; value: number }>> = [];
  const uploader = new CoalescingStateUploader<string, { key: string; value: number }>({
    maxRetries: 1,
    retryDelayMs: 1,
    onRetryScheduled: async () => {
      throw new Error("retry hook unavailable");
    },
    sink: async (items) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary state sink failure");
      }
      delivered.push(items);
    },
  });

  await uploader.upsert("chain-1", { key: "chain-1", value: 1 });
  await uploader.flush();

  assert.equal(attempts, 2);
  assert.deepEqual(delivered, [[{ key: "chain-1", value: 1 }]]);
});

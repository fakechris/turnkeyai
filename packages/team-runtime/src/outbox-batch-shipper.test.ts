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

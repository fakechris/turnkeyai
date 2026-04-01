import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileSessionMemoryRefreshJobStore } from "@turnkeyai/team-store/context/file-session-memory-refresh-job-store";

import { DefaultSessionMemoryRefreshWorker } from "./session-memory-refresh-worker";

test("session memory refresh worker persists jobs and retries before succeeding", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "session-memory-refresh-worker-"));
  let attempts = 0;

  try {
    const jobStore = new FileSessionMemoryRefreshJobStore({
      rootDir: path.join(tempDir, "jobs"),
    });
    const completed: string[] = [];
    const worker = new DefaultSessionMemoryRefreshWorker({
      jobStore,
      scheduleDelayMs: 0,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      refresh: async (job) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary refresh failure");
        }
        completed.push(job.threadId);
      },
    });

    await worker.enqueue({
      threadId: "thread-1",
      roleScratchpad: {
        completedWork: ["done"],
        pendingWork: ["next"],
      },
    });
    await worker.flush();

    assert.equal(attempts, 2);
    assert.deepEqual(completed, ["thread-1"]);
    assert.equal(await jobStore.get("thread-1"), null);
    await worker.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session memory refresh worker close flushes pending jobs before shutdown", async () => {
  const completed: string[] = [];
  const worker = new DefaultSessionMemoryRefreshWorker({
    scheduleDelayMs: 60_000,
    refresh: async (job) => {
      completed.push(job.threadId);
    },
  });

  await worker.enqueue({ threadId: "thread-close-flush" });
  await worker.close();

  assert.deepEqual(completed, ["thread-close-flush"]);
});

test("session memory refresh worker resets retry budget on fresh enqueue", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "session-memory-refresh-worker-"));
  const completed: string[] = [];

  try {
    const jobStore = new FileSessionMemoryRefreshJobStore({
      rootDir: path.join(tempDir, "jobs"),
    });
    const worker = new DefaultSessionMemoryRefreshWorker({
      jobStore,
      scheduleDelayMs: 0,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetries: 1,
      refresh: async (job) => {
        completed.push(job.threadId);
      },
    });

    await jobStore.put({
      threadId: "thread-reset-budget",
      enqueuedAt: Date.now(),
      notBeforeAt: Date.now() + 5_000,
      attemptCount: 1,
      lastError: "temporary refresh failure",
    });

    await worker.enqueue({ threadId: "thread-reset-budget" });
    const refreshedJob = await jobStore.get("thread-reset-budget");
    assert.ok(refreshedJob);
    assert.equal(refreshedJob.attemptCount, 0);
    assert.equal(refreshedJob.lastError, "temporary refresh failure");

    await worker.flush();
    assert.equal(await jobStore.get("thread-reset-budget"), null);
    assert.deepEqual(completed, ["thread-reset-budget"]);

    await worker.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session memory refresh worker reports permanently failed jobs and accepts a fresh retry later", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "session-memory-refresh-worker-failed-"));
  const failed: string[] = [];
  let failRefresh = true;
  const completed: string[] = [];

  try {
    const jobStore = new FileSessionMemoryRefreshJobStore({
      rootDir: path.join(tempDir, "jobs"),
    });
    const worker = new DefaultSessionMemoryRefreshWorker({
      jobStore,
      scheduleDelayMs: 0,
      retryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetries: 1,
      refresh: async (job) => {
        if (failRefresh) {
          throw new Error(`refresh failed for ${job.threadId}`);
        }
        completed.push(job.threadId);
      },
      onFailedJob: async (job) => {
        failed.push(job.threadId);
      },
    });

    await worker.enqueue({ threadId: "thread-refresh-failed" });
    await worker.flush();

    assert.deepEqual(failed, ["thread-refresh-failed"]);
    assert.equal(await jobStore.get("thread-refresh-failed"), null);

    failRefresh = false;
    await worker.enqueue({ threadId: "thread-refresh-failed" });
    await worker.flush();

    assert.deepEqual(completed, ["thread-refresh-failed"]);
    assert.equal(await jobStore.get("thread-refresh-failed"), null);
    await worker.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

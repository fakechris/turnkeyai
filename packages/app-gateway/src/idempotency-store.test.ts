import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFileRouteIdempotencyStore,
  createRouteIdempotencyStore,
  readIdempotencyKey,
} from "./idempotency-store";

test("route idempotency store keeps pending entries until they settle", async () => {
  let now = 0;
  let resolveFirst: ((value: { statusCode: number; body: unknown }) => void) | undefined;
  let firstExecutions = 0;
  let secondExecutions = 0;
  const store = createRouteIdempotencyStore({
    now: () => now,
    ttlMs: 10,
    maxEntries: 2,
  });

  const first = store.execute({
    scope: "workflow:messages",
    key: "msg-1",
    fingerprint: "fingerprint-1",
    execute: async () => {
      firstExecutions += 1;
      return await new Promise((resolve) => {
        resolveFirst = resolve;
      });
    },
  });

  now = 100;
  const second = await store.execute({
    scope: "workflow:messages",
    key: "msg-2",
    fingerprint: "fingerprint-2",
    execute: async () => {
      secondExecutions += 1;
      return {
        statusCode: 202,
        body: { accepted: true, threadId: "thread-2" },
      };
    },
  });

  resolveFirst?.({
    statusCode: 202,
    body: { accepted: true, threadId: "thread-1" },
  });
  const firstResult = await first;
  const replay = await store.execute({
    scope: "workflow:messages",
    key: "msg-1",
    fingerprint: "fingerprint-1",
    execute: async () => {
      firstExecutions += 1;
      return {
        statusCode: 202,
        body: { accepted: true, threadId: "thread-1" },
      };
    },
  });

  assert.equal(firstExecutions, 1);
  assert.equal(secondExecutions, 1);
  assert.equal(firstResult.kind, "response");
  assert.equal(second.kind, "response");
  assert.equal(replay.kind, "response");
  assert.equal(replay.replayed, true);
});

test("route idempotency store starts ttl when a response settles", async () => {
  let now = 0;
  let resolvePending: ((value: { statusCode: number; body: unknown }) => void) | undefined;
  let executions = 0;
  const store = createRouteIdempotencyStore({
    now: () => now,
    ttlMs: 10,
  });

  const first = store.execute({
    scope: "workflow:messages",
    key: "msg-1",
    fingerprint: "fingerprint-1",
    execute: async () => {
      executions += 1;
      return await new Promise((resolve) => {
        resolvePending = resolve;
      });
    },
  });

  now = 100;
  resolvePending?.({
    statusCode: 202,
    body: { accepted: true, threadId: "thread-1" },
  });
  await first;

  now = 105;
  const replay = await store.execute({
    scope: "workflow:messages",
    key: "msg-1",
    fingerprint: "fingerprint-1",
    execute: async () => {
      executions += 1;
      return {
        statusCode: 202,
        body: { accepted: true, threadId: "thread-1" },
      };
    },
  });

  assert.equal(executions, 1);
  assert.equal(replay.kind, "response");
  assert.equal(replay.replayed, true);
});

test("readIdempotencyKey rejects comma-joined header values", () => {
  assert.deepEqual(
    readIdempotencyKey({
      headers: {
        "idempotency-key": "a, b",
      },
    }),
    {
      ok: false,
      error: "Idempotency-Key must be a single non-empty string",
    }
  );

  assert.deepEqual(
    readIdempotencyKey({
      headers: {
        "x-idempotency-key": ["a, b"],
      },
    }),
    {
      ok: false,
      error: "Idempotency-Key must be a single non-empty string",
    }
  );
});

test("file route idempotency store replays settled responses across store recreation", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-route-idempotency-"));
  try {
    let executions = 0;
    let now = 100;
    const firstStore = createFileRouteIdempotencyStore({
      rootDir,
      now: () => now,
      ttlMs: 10_000,
    });

    const first = await firstStore.execute({
      scope: "workflow:messages",
      key: "msg-1",
      fingerprint: "fingerprint-1",
      execute: async () => {
        executions += 1;
        return {
          statusCode: 202,
          body: { accepted: true, threadId: "thread-1" },
        };
      },
    });

    const restartedStore = createFileRouteIdempotencyStore({
      rootDir,
      now: () => now,
      ttlMs: 10_000,
    });
    const replay = await restartedStore.execute({
      scope: "workflow:messages",
      key: "msg-1",
      fingerprint: "fingerprint-1",
      execute: async () => {
        executions += 1;
        return {
          statusCode: 202,
          body: { accepted: true, threadId: "thread-1" },
        };
      },
    });

    assert.equal(executions, 1);
    assert.equal(first.kind, "response");
    assert.equal(replay.kind, "response");
    assert.equal(replay.replayed, true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

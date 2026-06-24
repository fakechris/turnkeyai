import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryHit, VectorRecord, VectorStore } from "./memory-provider";
import { createVectorMemoryProvider } from "./memory-provider";

/** Deterministic 1-D "embedding": the string length. Order is all we assert. */
const embed = async (text: string): Promise<number[]> => [text.length];

function fakeVectorStore(): VectorStore & { upserted: VectorRecord[]; lastQuery?: { namespace: string; limit: number } } {
  const upserted: VectorRecord[] = [];
  return {
    upserted,
    async upsert(items) {
      upserted.push(...items);
    },
    async query({ namespace, limit }) {
      this.lastQuery = { namespace, limit };
      const hits: MemoryHit[] = [
        { memoryId: "m1", source: "vector", score: 0.9, content: "first" },
        { memoryId: "m2", source: "vector", score: 0.5, content: "second" },
        { memoryId: "m3", source: "vector", score: 0.2, content: "third" },
      ];
      return hits.slice(0, limit);
    },
    async get({ memoryId }) {
      return { memoryId, source: "vector", score: 1, content: `body:${memoryId}` };
    },
  };
}

test("createVectorMemoryProvider embeds the query and forwards namespace + limit", async () => {
  const store = fakeVectorStore();
  const provider = createVectorMemoryProvider({ embed, store });
  const hits = await provider.retrieve({ namespace: "thread-1::role-fin", queryText: "pricing", limit: 2 });
  assert.deepEqual(store.lastQuery, { namespace: "thread-1::role-fin", limit: 2 });
  assert.deepEqual(hits.map((h) => h.memoryId), ["m1", "m2"]);
});

test("createVectorMemoryProvider applies defaultLimit when limit is omitted", async () => {
  const store = fakeVectorStore();
  const provider = createVectorMemoryProvider({ embed, store, defaultLimit: 1 });
  const hits = await provider.retrieve({ namespace: "ns", queryText: "q" });
  assert.equal(store.lastQuery?.limit, 1);
  assert.deepEqual(hits.map((h) => h.memoryId), ["m1"]);
});

test("createVectorMemoryProvider.get delegates to the store when available", async () => {
  const provider = createVectorMemoryProvider({ embed, store: fakeVectorStore() });
  const hit = await provider.get({ namespace: "ns", memoryId: "m7" });
  assert.equal(hit?.content, "body:m7");
});

test("createVectorMemoryProvider.get returns null when the store has no get()", async () => {
  const store = fakeVectorStore();
  delete (store as { get?: unknown }).get;
  const provider = createVectorMemoryProvider({ embed, store });
  assert.equal(await provider.get({ namespace: "ns", memoryId: "m7" }), null);
});

test("VectorRecord carries the namespace so a shared store can isolate scopes", async () => {
  const store = fakeVectorStore();
  const records: VectorRecord[] = [
    { memoryId: "m1", namespace: "t1::r1", vector: [1], content: "a" },
    { memoryId: "m2", namespace: "t2::r2", vector: [2], content: "b" },
  ];
  await store.upsert(records);
  assert.deepEqual(
    store.upserted.map((r) => [r.memoryId, r.namespace]),
    [["m1", "t1::r1"], ["m2", "t2::r2"]]
  );
});

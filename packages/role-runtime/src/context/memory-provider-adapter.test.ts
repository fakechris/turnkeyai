import assert from "node:assert/strict";
import test from "node:test";

import type { RoleId, ThreadId } from "@turnkeyai/core-types/team";
import type { MemoryHit, RoleMemoryResolver } from "./role-memory-resolver";
import { asMemoryProvider, memoryNamespace, parseMemoryNamespace } from "./memory-provider-adapter";

const hit = (memoryId: string, content: string): MemoryHit => ({
  memoryId,
  source: "thread-memory",
  score: 1,
  content,
});

function fakeResolver(): Pick<RoleMemoryResolver, "retrieveMemory" | "getMemory"> & {
  calls: Array<{ threadId: string; roleId: string; queryText: string }>;
} {
  const calls: Array<{ threadId: string; roleId: string; queryText: string }> = [];
  return {
    calls,
    async retrieveMemory({ threadId, roleId, queryText }) {
      calls.push({ threadId, roleId, queryText });
      return [hit("a", "first"), hit("b", "second"), hit("c", "third")];
    },
    async getMemory({ memoryId }) {
      return memoryId === "a" ? hit("a", "first") : null;
    },
  };
}

test("memoryNamespace and parseMemoryNamespace round-trip", () => {
  const ns = memoryNamespace("thread-9" as ThreadId, "role-fin" as RoleId);
  assert.equal(ns, "thread-9::role-fin");
  assert.deepEqual(parseMemoryNamespace(ns), { threadId: "thread-9", roleId: "role-fin" });
});

test("parseMemoryNamespace assigns everything after the first separator to roleId", () => {
  // role ids may themselves be plain slugs; thread ids are slugs without "::"
  assert.deepEqual(parseMemoryNamespace("t1::role::weird"), { threadId: "t1", roleId: "role::weird" });
});

test("parseMemoryNamespace throws on a malformed namespace", () => {
  assert.throws(() => parseMemoryNamespace("no-separator"), /invalid memory namespace/);
});

test("asMemoryProvider.retrieve unpacks the namespace and applies limit", async () => {
  const resolver = fakeResolver();
  const provider = asMemoryProvider(resolver);
  const hits = await provider.retrieve({
    namespace: memoryNamespace("t1" as ThreadId, "r1" as RoleId),
    queryText: "pricing",
    limit: 2,
  });
  assert.deepEqual(resolver.calls, [{ threadId: "t1", roleId: "r1", queryText: "pricing" }]);
  assert.deepEqual(hits.map((h) => h.memoryId), ["a", "b"]);
});

test("asMemoryProvider.retrieve returns all hits when limit is omitted", async () => {
  const provider = asMemoryProvider(fakeResolver());
  const hits = await provider.retrieve({
    namespace: memoryNamespace("t1" as ThreadId, "r1" as RoleId),
    queryText: "q",
  });
  assert.deepEqual(hits.map((h) => h.memoryId), ["a", "b", "c"]);
});

test("asMemoryProvider.retrieve clamps a negative limit to zero (no slice-from-end)", async () => {
  const provider = asMemoryProvider(fakeResolver());
  const hits = await provider.retrieve({
    namespace: memoryNamespace("t1" as ThreadId, "r1" as RoleId),
    queryText: "q",
    limit: -1,
  });
  assert.deepEqual(hits, []);
});

test("asMemoryProvider.get unpacks the namespace and delegates", async () => {
  const provider = asMemoryProvider(fakeResolver());
  const ns = memoryNamespace("t1" as ThreadId, "r1" as RoleId);
  assert.equal((await provider.get({ namespace: ns, memoryId: "a" }))?.content, "first");
  assert.equal(await provider.get({ namespace: ns, memoryId: "zzz" }), null);
});

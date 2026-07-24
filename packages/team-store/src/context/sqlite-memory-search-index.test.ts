import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  DurableMemoryRecord,
  MemoryEmbeddingAdapter,
} from "@turnkeyai/core-types/team";

import {
  fuseMemoryCandidates,
  SqliteMemorySearchIndex,
} from "./sqlite-memory-search-index";

function record(
  memoryId: string,
  content: string,
  threadId = "thread-1",
): DurableMemoryRecord {
  return {
    memoryId,
    plane: "workspace",
    scope: { workspaceId: "workspace-1", threadId },
    content,
    sourceRefs: [`user:${memoryId}`],
    createdBy: "user",
    confidence: "authoritative",
    createdAt: 1,
    lastConfirmedAt: 1,
    supersedes: [],
    invalidationKeys: [],
  };
}

async function index(embeddingAdapter?: MemoryEmbeddingAdapter) {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "turnkeyai-memory-index-"),
  );
  return new SqliteMemorySearchIndex({
    dbPath: path.join(rootDir, "memory.sqlite"),
    ...(embeddingAdapter ? { embeddingAdapter } : {}),
  });
}

test("sqlite memory index recalls exact identifiers with lexical fallback", async () => {
  const search = await index();
  await search.replaceWorkspace("workspace-1", [
    record("memory-budget", "Decision ALPHA-482 budget is 500 yuan."),
    record("memory-other", "Other note."),
  ]);

  const hits = await search.recall({
    scope: { workspaceId: "workspace-1", threadId: "thread-1" },
    query: "ALPHA-482",
  });

  assert.equal(hits[0]?.record.memoryId, "memory-budget");
  assert.match(hits[0]?.rationale ?? "", /fts rank/);
});

test("sqlite memory index filters scope before ranking", async () => {
  const search = await index();
  await search.replaceWorkspace("workspace-1", [
    record("allowed", "shared exact phrase", "thread-1"),
    record("blocked-by-scope", "shared exact phrase", "thread-2"),
  ]);

  const hits = await search.recall({
    scope: { workspaceId: "workspace-1", threadId: "thread-1" },
    query: "shared exact phrase",
  });

  assert.deepEqual(
    hits.map((hit) => hit.record.memoryId),
    ["allowed"],
  );
});

test("sqlite memory index uses optional vectors for Chinese synonym recall", async () => {
  const adapter: MemoryEmbeddingAdapter = {
    async embed(text) {
      return /费用|预算|开销/.test(text) ? [1, 0] : [0, 1];
    },
  };
  const search = await index(adapter);
  await search.replaceWorkspace("workspace-1", [
    record("budget", "项目费用上限是五百元"),
    record("format", "输出使用表格"),
  ]);

  const hits = await search.recall({
    scope: { workspaceId: "workspace-1", threadId: "thread-1" },
    query: "之前的预算约束是什么",
  });

  assert.equal(hits[0]?.record.memoryId, "budget");
  assert.ok(hits[0]?.channels.vector);
});

test("weighted RRF is deterministic across channel overlap", () => {
  const fused = fuseMemoryCandidates({
    fts: [
      { memoryId: "a", channel: "fts", rawScore: 1, rank: 1 },
      { memoryId: "b", channel: "fts", rawScore: 0.9, rank: 2 },
    ],
    vector: [
      { memoryId: "b", channel: "vector", rawScore: 1, rank: 1 },
      { memoryId: "a", channel: "vector", rawScore: 0.8, rank: 2 },
    ],
  });

  assert.deepEqual(
    fused.map((hit) => hit.memoryId),
    ["a", "b"],
  );
  assert.ok(fused[0]?.channels.fts);
  assert.ok(fused[0]?.channels.vector);
});

test("sqlite memory index rebuild removes stale records", async () => {
  const search = await index();
  await search.replaceWorkspace("workspace-1", [
    record("stale", "stale identifier STALE-1"),
  ]);
  await search.rebuild([
    record("fresh", "fresh identifier FRESH-2"),
  ]);

  assert.equal(await search.get("stale"), null);
  assert.equal((await search.get("fresh"))?.memoryId, "fresh");
});

test("sqlite memory index diagnostics expose the active retrieval channels and corpus counts", async () => {
  const adapter: MemoryEmbeddingAdapter = {
    async embed(text) {
      return text.includes("budget") ? [1, 0] : [0, 1];
    },
  };
  const search = await index(adapter);
  await search.replaceWorkspace("workspace-1", [
    record("budget", "budget is capped"),
    record("format", "use a table", "thread-2"),
  ]);

  const diagnostics = await search.diagnostics({
    workspaceId: "workspace-1",
    threadId: "thread-1",
  });

  assert.deepEqual(diagnostics, {
    backend: "sqlite-fts5-rrf",
    indexedRecords: 1,
    vectorRecords: 1,
    channels: ["fts", "vector"],
    defaults: {
      ftsCandidates: 20,
      vectorCandidates: 20,
      hits: 4,
      rrfK: 60,
      ftsWeight: 0.5,
      vectorWeight: 0.5,
    },
  });
});

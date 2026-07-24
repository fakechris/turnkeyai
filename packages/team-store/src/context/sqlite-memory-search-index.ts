import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  DurableMemoryRecord,
  HybridMemoryRecallHit,
  MemoryEmbeddingAdapter,
  MemoryIndexCandidate,
  MemoryScope,
  MemorySearchIndex,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

const DEFAULT_FTS_CANDIDATES = 20;
const DEFAULT_VECTOR_CANDIDATES = 20;
const DEFAULT_HITS = 4;
const RRF_K = 60;
const FTS_WEIGHT = 0.5;
const VECTOR_WEIGHT = 0.5;

export class SqliteMemorySearchIndex implements MemorySearchIndex {
  private readonly db: DatabaseSync;
  private readonly embeddingAdapter: MemoryEmbeddingAdapter | undefined;
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(options: {
    dbPath: string;
    embeddingAdapter?: MemoryEmbeddingAdapter;
  }) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.embeddingAdapter = options.embeddingAdapter;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        workspace_id UNINDEXED,
        thread_id UNINDEXED,
        role_id UNINDEXED,
        content,
        record_json UNINDEXED,
        embedding_json UNINDEXED,
        tokenize = 'unicode61'
      );
    `);
  }

  async replaceWorkspace(
    workspaceId: string,
    records: DurableMemoryRecord[],
  ): Promise<void> {
    await this.mutex.run(workspaceId, async () => {
      const embedded = await Promise.all(
        records.map(async (record) => ({
          record,
          embedding: this.embeddingAdapter
            ? await this.embeddingAdapter.embed(record.content)
            : null,
        })),
      );
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(
          "DELETE FROM memory_fts WHERE workspace_id = ?",
        ).run(workspaceId);
        const insert = this.db.prepare(`
          INSERT INTO memory_fts(
            memory_id, workspace_id, thread_id, role_id,
            content, record_json, embedding_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of embedded) {
          if (item.record.scope.workspaceId !== workspaceId) continue;
          insert.run(
            item.record.memoryId,
            workspaceId,
            item.record.scope.threadId ?? "",
            item.record.scope.roleId ?? "",
            item.record.content,
            JSON.stringify(item.record),
            item.embedding ? JSON.stringify(item.embedding) : "",
          );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async get(memoryId: string): Promise<DurableMemoryRecord | null> {
    const row = this.db.prepare(
      "SELECT record_json FROM memory_fts WHERE memory_id = ? LIMIT 1",
    ).get(memoryId) as { record_json?: unknown } | undefined;
    return typeof row?.record_json === "string"
      ? parseRecord(row.record_json)
      : null;
  }

  async recall(input: {
    scope: MemoryScope;
    query: string;
    ftsCandidates?: number;
    vectorCandidates?: number;
    limit?: number;
  }): Promise<HybridMemoryRecallHit[]> {
    const [fts, vector] = await Promise.all([
      this.ftsCandidates(
        input.scope,
        input.query,
        input.ftsCandidates ?? DEFAULT_FTS_CANDIDATES,
      ),
      this.vectorCandidates(
        input.scope,
        input.query,
        input.vectorCandidates ?? DEFAULT_VECTOR_CANDIDATES,
      ),
    ]);
    const fused = fuseMemoryCandidates({
      fts,
      vector,
      rrfK: RRF_K,
      ftsWeight: FTS_WEIGHT,
      vectorWeight: VECTOR_WEIGHT,
    }).slice(0, input.limit ?? DEFAULT_HITS);
    const hits: HybridMemoryRecallHit[] = [];
    for (const item of fused) {
      const record = await this.get(item.memoryId);
      if (!record || !withinScope(record, input.scope)) continue;
      hits.push({
        record,
        score: item.score,
        rationale: buildRationale(item.channels),
        channels: item.channels,
      });
    }
    return hits;
  }

  async rebuild(records: DurableMemoryRecord[]): Promise<void> {
    this.db.exec("DELETE FROM memory_fts");
    const byWorkspace = new Map<string, DurableMemoryRecord[]>();
    for (const record of records) {
      const values = byWorkspace.get(record.scope.workspaceId) ?? [];
      values.push(record);
      byWorkspace.set(record.scope.workspaceId, values);
    }
    for (const [workspaceId, values] of byWorkspace) {
      await this.replaceWorkspace(workspaceId, values);
    }
  }

  async diagnostics(scope?: MemoryScope): Promise<{
    backend: string;
    indexedRecords: number;
    vectorRecords: number;
    channels: Array<"fts" | "vector">;
    defaults: {
      ftsCandidates: number;
      vectorCandidates: number;
      hits: number;
      rrfK: number;
      ftsWeight: number;
      vectorWeight: number;
    };
  }> {
    const scoped = scope ? scopeClause(scope) : { where: "1 = 1", args: [] };
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS indexed_records,
        SUM(CASE WHEN embedding_json != '' THEN 1 ELSE 0 END) AS vector_records
      FROM memory_fts
      WHERE ${scoped.where}
    `).get(...scoped.args) as {
      indexed_records?: number;
      vector_records?: number | null;
    };
    return {
      backend: "sqlite-fts5-rrf",
      indexedRecords: Number(row.indexed_records ?? 0),
      vectorRecords: Number(row.vector_records ?? 0),
      channels: this.embeddingAdapter
        ? ["fts", "vector"]
        : ["fts"],
      defaults: {
        ftsCandidates: DEFAULT_FTS_CANDIDATES,
        vectorCandidates: DEFAULT_VECTOR_CANDIDATES,
        hits: DEFAULT_HITS,
        rrfK: RRF_K,
        ftsWeight: FTS_WEIGHT,
        vectorWeight: VECTOR_WEIGHT,
      },
    };
  }

  private async ftsCandidates(
    scope: MemoryScope,
    query: string,
    limit: number,
  ): Promise<MemoryIndexCandidate[]> {
    const match = ftsQuery(query);
    if (!match) return [];
    const { where, args } = scopeClause(scope);
    const rows = this.db.prepare(`
      SELECT memory_id, bm25(memory_fts) AS score
      FROM memory_fts
      WHERE memory_fts MATCH ? AND ${where}
      ORDER BY score ASC, memory_id ASC
      LIMIT ?
    `).all(match, ...args, positiveLimit(limit)) as Array<{
      memory_id: string;
      score: number;
    }>;
    return rows.map((row, index) => ({
      memoryId: row.memory_id,
      channel: "fts",
      rawScore: 1 / (1 + Math.abs(row.score)),
      rank: index + 1,
    }));
  }

  private async vectorCandidates(
    scope: MemoryScope,
    query: string,
    limit: number,
  ): Promise<MemoryIndexCandidate[]> {
    if (!this.embeddingAdapter) return [];
    const queryVector = await this.embeddingAdapter.embed(query);
    if (queryVector.length === 0) return [];
    const { where, args } = scopeClause(scope);
    const rows = this.db.prepare(`
      SELECT memory_id, embedding_json
      FROM memory_fts
      WHERE ${where} AND embedding_json != ''
    `).all(...args) as Array<{
      memory_id: string;
      embedding_json: string;
    }>;
    return rows
      .map((row) => ({
        memoryId: row.memory_id,
        channel: "vector" as const,
        rawScore: cosineSimilarity(
          queryVector,
          parseVector(row.embedding_json),
        ),
        rank: 0,
      }))
      .filter((candidate) => candidate.rawScore > 0)
      .sort((left, right) =>
        right.rawScore - left.rawScore ||
        left.memoryId.localeCompare(right.memoryId)
      )
      .slice(0, positiveLimit(limit))
      .map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
      }));
  }
}

export function fuseMemoryCandidates(input: {
  fts: MemoryIndexCandidate[];
  vector: MemoryIndexCandidate[];
  rrfK?: number;
  ftsWeight?: number;
  vectorWeight?: number;
}): Array<{
  memoryId: string;
  score: number;
  channels: HybridMemoryRecallHit["channels"];
}> {
  const rrfK = input.rrfK ?? RRF_K;
  const values = new Map<
    string,
    {
      memoryId: string;
      score: number;
      channels: HybridMemoryRecallHit["channels"];
    }
  >();
  for (const [candidates, weight] of [
    [input.fts, input.ftsWeight ?? FTS_WEIGHT],
    [input.vector, input.vectorWeight ?? VECTOR_WEIGHT],
  ] as const) {
    for (const candidate of candidates) {
      const current = values.get(candidate.memoryId) ?? {
        memoryId: candidate.memoryId,
        score: 0,
        channels: {},
      };
      current.score += weight / (rrfK + candidate.rank);
      current.channels[candidate.channel] = {
        rank: candidate.rank,
        rawScore: candidate.rawScore,
      };
      values.set(candidate.memoryId, current);
    }
  }
  return [...values.values()].sort((left, right) =>
    right.score - left.score ||
    left.memoryId.localeCompare(right.memoryId)
  );
}

function scopeClause(scope: MemoryScope): {
  where: string;
  args: string[];
} {
  const clauses = ["workspace_id = ?"];
  const args = [scope.workspaceId];
  if (scope.threadId !== undefined) {
    clauses.push("thread_id = ?");
    args.push(scope.threadId);
  }
  if (scope.roleId !== undefined) {
    clauses.push("role_id = ?");
    args.push(scope.roleId);
  }
  return { where: clauses.join(" AND "), args };
}

function ftsQuery(query: string): string {
  return [
    ...new Set(
      query
        .toLowerCase()
        .match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [],
    ),
  ]
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function parseRecord(value: string): DurableMemoryRecord | null {
  try {
    return JSON.parse(value) as DurableMemoryRecord;
  } catch {
    return null;
  }
}

function parseVector(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "number")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm === 0 || rightNorm === 0
    ? 0
    : dot / Math.sqrt(leftNorm * rightNorm);
}

function withinScope(
  record: DurableMemoryRecord,
  scope: MemoryScope,
): boolean {
  return record.scope.workspaceId === scope.workspaceId &&
    (scope.threadId === undefined ||
      record.scope.threadId === scope.threadId) &&
    (scope.roleId === undefined || record.scope.roleId === scope.roleId);
}

function buildRationale(
  channels: HybridMemoryRecallHit["channels"],
): string {
  const parts = [];
  if (channels.fts) parts.push(`fts rank ${channels.fts.rank}`);
  if (channels.vector) {
    parts.push(`vector rank ${channels.vector.rank}`);
  }
  return `weighted RRF (${parts.join(", ")})`;
}

function positiveLimit(value: number): number {
  return Math.max(1, Math.floor(value));
}

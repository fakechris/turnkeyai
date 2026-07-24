import { mkdirSync, rmSync } from "node:fs";
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
import { AsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

const DEFAULT_FTS_CANDIDATES = 20;
const DEFAULT_VECTOR_CANDIDATES = 20;
const DEFAULT_HITS = 4;
const RRF_K = 60;
const FTS_WEIGHT = 0.5;
const VECTOR_WEIGHT = 0.5;

interface IndexedRecord {
  record: DurableMemoryRecord;
  embedding: number[] | null;
}

export class SqliteMemorySearchIndex implements MemorySearchIndex {
  private readonly db: DatabaseSync;
  private readonly embeddingAdapter: MemoryEmbeddingAdapter | undefined;
  private readonly mutex = new AsyncMutex();
  private readonly fts5Available: boolean;
  private readonly tableName: "memory_fts" | "memory_records";

  constructor(options: {
    dbPath: string;
    embeddingAdapter?: MemoryEmbeddingAdapter;
    forceLexicalFallback?: boolean;
  }) {
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.embeddingAdapter = options.embeddingAdapter;
    let opened: { db: DatabaseSync; fts5Available: boolean };
    try {
      opened = openIndexDatabase(options);
    } catch (error) {
      // The index is derived state rebuilt from JSON snapshots; a corrupt
      // db file must never block startup.
      if (options.dbPath === ":memory:") throw error;
      console.error("memory search index open failed; recreating db", {
        dbPath: options.dbPath,
        error,
      });
      removeIndexDatabaseFiles(options.dbPath);
      opened = openIndexDatabase(options);
    }
    this.db = opened.db;
    this.fts5Available = opened.fts5Available;
    this.tableName = this.fts5Available
      ? "memory_fts"
      : "memory_records";
  }

  async replaceWorkspace(
    workspaceId: string,
    records: DurableMemoryRecord[],
  ): Promise<void> {
    await this.mutex.run(async () => {
      const embedded = await this.embedRecords(records);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.replaceWorkspaceInTransaction(workspaceId, embedded);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async get(memoryId: string): Promise<DurableMemoryRecord | null> {
    const row = this.db.prepare(
      `SELECT record_json FROM ${this.tableName} WHERE memory_id = ? LIMIT 1`,
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
    const now = Date.now();
    const hits: HybridMemoryRecallHit[] = [];
    for (const item of fused) {
      const record = await this.get(item.memoryId);
      // Skip expired records the derived index may still carry between the
      // authoritative store's commit-time evictions and the next reconcile.
      if (
        !record ||
        !withinScope(record, input.scope) ||
        (record.expiresAt !== undefined && record.expiresAt <= now)
      ) {
        continue;
      }
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
    await this.mutex.run(async () => {
      const embedded = await this.embedRecords(records);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`DELETE FROM ${this.tableName}`);
        const byWorkspace = new Map<string, IndexedRecord[]>();
        for (const item of embedded) {
          const workspaceId = item.record.scope.workspaceId;
          const values = byWorkspace.get(workspaceId) ?? [];
          values.push(item);
          byWorkspace.set(workspaceId, values);
        }
        for (const [workspaceId, values] of byWorkspace) {
          this.insertWorkspaceRecords(workspaceId, values);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
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
      FROM ${this.tableName}
      WHERE ${scoped.where}
    `).get(...scoped.args) as {
      indexed_records?: number;
      vector_records?: number | null;
    };
    return {
      backend: this.fts5Available
        ? "sqlite-fts5-rrf"
        : "sqlite-lexical-rrf",
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
    if (!this.fts5Available) {
      return this.lexicalCandidates(scope, query, limit);
    }
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

  private lexicalCandidates(
    scope: MemoryScope,
    query: string,
    limit: number,
  ): MemoryIndexCandidate[] {
    const terms = lexicalTerms(query);
    if (terms.length === 0) return [];
    const { where, args } = scopeClause(scope);
    const rows = this.db.prepare(`
      SELECT memory_id, content
      FROM memory_records
      WHERE ${where}
    `).all(...args) as Array<{
      memory_id: string;
      content: string;
    }>;
    return rows
      .map((row) => {
        const content = row.content.toLowerCase();
        const matched = terms.filter((term) =>
          content.includes(term)
        ).length;
        return {
          memoryId: row.memory_id,
          channel: "fts" as const,
          rawScore: matched / terms.length,
          rank: 0,
        };
      })
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
      FROM ${this.tableName}
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

  private async embedRecords(
    records: DurableMemoryRecord[],
  ): Promise<IndexedRecord[]> {
    return Promise.all(
      records.map(async (record) => ({
        record,
        embedding: this.embeddingAdapter
          ? await this.embeddingAdapter.embed(record.content)
          : null,
      })),
    );
  }

  private replaceWorkspaceInTransaction(
    workspaceId: string,
    records: IndexedRecord[],
  ): void {
    this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE workspace_id = ?`,
    ).run(workspaceId);
    this.insertWorkspaceRecords(workspaceId, records);
  }

  private insertWorkspaceRecords(
    workspaceId: string,
    records: IndexedRecord[],
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO ${this.tableName}(
        memory_id, workspace_id, thread_id, role_id,
        content, record_json, embedding_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of records) {
      if (item.record.scope.workspaceId !== workspaceId) continue;
      insert.run(
        item.record.memoryId,
        workspaceId,
        item.record.scope.threadId ?? "",
        item.record.scope.roleId ?? "",
        this.fts5Available
          ? ftsIndexText(item.record.content)
          : item.record.content,
        JSON.stringify(item.record),
        item.embedding ? JSON.stringify(item.embedding) : "",
      );
    }
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

// unicode61 tokenizes an unbroken CJK run as ONE token, so substring
// queries (the normal case for Chinese) can never match raw content. We
// therefore index CJK runs as space-separated bigrams alongside the raw
// text and expand CJK query terms into consecutive-bigram phrases.
const CJK_RANGE =
  "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af";
const TERM_PATTERN = new RegExp(
  `[a-z0-9]{2,}|[${CJK_RANGE}]{2,}`,
  "g",
);
const CJK_TERM_PATTERN = new RegExp(`^[${CJK_RANGE}]+$`);
const CJK_RUN_PATTERN = new RegExp(`[${CJK_RANGE}]{3,}`, "g");

function cjkBigrams(term: string): string[] {
  return Array.from(
    { length: term.length - 1 },
    (_, index) => term.slice(index, index + 2),
  );
}

function ftsIndexText(content: string): string {
  const bigrams = (content.match(CJK_RUN_PATTERN) ?? [])
    .flatMap((run) => cjkBigrams(run));
  return bigrams.length > 0
    ? `${content}\n${bigrams.join(" ")}`
    : content;
}

function ftsQuery(query: string): string {
  return [
    ...new Set(query.toLowerCase().match(TERM_PATTERN) ?? []),
  ]
    .flatMap((term) =>
      CJK_TERM_PATTERN.test(term) && term.length > 2
        ? [term, ...cjkBigrams(term)]
        : [term]
    )
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function lexicalTerms(query: string): string[] {
  const terms = query.toLowerCase().match(TERM_PATTERN) ?? [];
  return [
    ...new Set(
      terms.flatMap((term) =>
        CJK_TERM_PATTERN.test(term) && term.length > 2
          ? [term, ...cjkBigrams(term)]
          : [term]
      ),
    ),
  ];
}

function openIndexDatabase(options: {
  dbPath: string;
  forceLexicalFallback?: boolean;
}): { db: DatabaseSync; fts5Available: boolean } {
  const db = new DatabaseSync(options.dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // WAL is unavailable on some filesystems; the default journal works.
    }
    const fts5Available =
      !options.forceLexicalFallback && supportsFts5(db);
    if (fts5Available) {
      db.exec(`
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
      db.exec("SELECT count(*) FROM memory_fts");
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_records(
          memory_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          role_id TEXT NOT NULL,
          content TEXT NOT NULL,
          record_json TEXT NOT NULL,
          embedding_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_records_scope_idx
          ON memory_records(workspace_id, thread_id, role_id);
      `);
    }
    return { db, fts5Available };
  } catch (error) {
    try {
      db.close();
    } catch {
      // The open failure is authoritative.
    }
    throw error;
  }
}

function removeIndexDatabaseFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function supportsFts5(db: DatabaseSync): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE temp.turnkeyai_fts5_probe
        USING fts5(content);
      DROP TABLE temp.turnkeyai_fts5_probe;
    `);
    return true;
  } catch {
    try {
      db.exec("DROP TABLE IF EXISTS temp.turnkeyai_fts5_probe");
    } catch {
      // The capability probe is best-effort; fallback storage is independent.
    }
    return false;
  }
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

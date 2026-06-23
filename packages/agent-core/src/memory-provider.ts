/**
 * Generic, role-agnostic memory abstraction for the reusable agent core.
 *
 * agent-core does not know what a thread, role, or worker is. A host maps its
 * own scoping (e.g. thread + role) into an opaque `namespace` string that the
 * core threads through untouched. This keeps lexical, vector, or hosted memory
 * backends interchangeable behind one contract.
 */

/** A single recalled memory. `source` is an open string owned by the host. */
export interface MemoryHit {
  memoryId: string;
  source: string;
  score: number;
  content: string;
  rationale?: string;
}

export interface MemoryQuery {
  /** Opaque host scope key. agent-core never parses it. */
  namespace: string;
  queryText: string;
  limit?: number;
}

export interface MemoryProvider {
  retrieve(query: MemoryQuery): Promise<MemoryHit[]>;
  get(input: { namespace: string; memoryId: string }): Promise<MemoryHit | null>;
}

// --- Vector backend seam ---------------------------------------------------
// agent-core ships the orchestration only. The embedding model and vector store
// are injected by the host, so the core stays zero-dependency: no embedding
// library, no vector DB client.

export interface EmbeddingFn {
  (text: string): Promise<number[]>;
}

export interface VectorRecord {
  memoryId: string;
  vector: number[];
  content: string;
  source?: string;
}

export interface VectorStore {
  upsert(items: VectorRecord[]): Promise<void>;
  query(input: { vector: number[]; namespace: string; limit: number }): Promise<MemoryHit[]>;
  get?(input: { namespace: string; memoryId: string }): Promise<MemoryHit | null>;
}

export interface VectorMemoryProviderOptions {
  embed: EmbeddingFn;
  store: VectorStore;
  /** Hits to return when a query omits `limit`. Defaults to 4. */
  defaultLimit?: number;
}

/**
 * A MemoryProvider that embeds the query text and delegates similarity search to
 * an injected VectorStore. This is the seam a future host-side vector/Mem0
 * backend plugs into; the lexical resolver remains the default production path.
 */
export function createVectorMemoryProvider(options: VectorMemoryProviderOptions): MemoryProvider {
  const fallbackLimit = options.defaultLimit ?? 4;
  return {
    async retrieve({ namespace, queryText, limit }) {
      const vector = await options.embed(queryText);
      return options.store.query({ vector, namespace, limit: limit ?? fallbackLimit });
    },
    async get(input) {
      return options.store.get ? options.store.get(input) : null;
    },
  };
}

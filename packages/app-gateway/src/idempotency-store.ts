import { mkdir } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import {
  listJsonFiles,
  readJsonFile,
  removeFileIfExists,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

type IdempotencyResponse = {
  statusCode: number;
  body: unknown;
};

type RouteIdempotencyResult =
  | { kind: "response"; statusCode: number; body: unknown; replayed: boolean }
  | { kind: "conflict"; statusCode: 409; body: { error: string } };

type IdempotencyEntry = {
  fingerprint: string;
  expiresAt: number;
  response: IdempotencyResponse | undefined;
  pending: Promise<IdempotencyResponse> | undefined;
};

type PersistedIdempotencyEntry = {
  scope: string;
  key: string;
  fingerprint: string;
  response: IdempotencyResponse;
  createdAt: number;
  expiresAt: number;
};

export interface RouteIdempotencyStore {
  execute(input: {
    scope: string;
    key?: string;
    fingerprint: string;
    execute: () => Promise<IdempotencyResponse>;
  }): Promise<RouteIdempotencyResult>;
}

interface CreateRouteIdempotencyStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

interface CreateFileRouteIdempotencyStoreOptions extends CreateRouteIdempotencyStoreOptions {
  rootDir: string;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const IDEMPOTENCY_CONFLICT_ERROR = "idempotency key reuse does not match the original request";
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

export function createRouteIdempotencyStore(
  options: CreateRouteIdempotencyStoreOptions = {}
): RouteIdempotencyStore {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, IdempotencyEntry>();

  function pruneExpiredEntries(currentTime: number): void {
    for (const [entryKey, entry] of entries.entries()) {
      if (entry.pending) {
        continue;
      }
      if (entry.expiresAt <= currentTime) {
        entries.delete(entryKey);
      }
    }
    while (entries.size > maxEntries) {
      const oldestSettledEntry = [...entries.entries()].find(([, entry]) => !entry.pending);
      const oldestKey = oldestSettledEntry?.[0];
      if (!oldestKey) {
        break;
      }
      entries.delete(oldestKey);
    }
  }

  async function awaitEntryResponse(entryKey: string, entry: IdempotencyEntry): Promise<IdempotencyResponse> {
    if (entry.response) {
      return entry.response;
    }
    if (entry.pending) {
      const response = await entry.pending;
      const current = entries.get(entryKey);
      if (current) {
        current.response = response;
        current.pending = undefined;
      }
      return response;
    }
    throw new Error(`idempotency entry is missing a response: ${entryKey}`);
  }

  return {
    async execute(input) {
      if (!input.key) {
        const response = await input.execute();
        return {
          kind: "response",
          statusCode: response.statusCode,
          body: response.body,
          replayed: false,
        };
      }

      const currentTime = now();
      pruneExpiredEntries(currentTime);
      const entryKey = `${input.scope}:${input.key}`;
      const existing = entries.get(entryKey);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          return {
            kind: "conflict",
            statusCode: 409,
            body: { error: IDEMPOTENCY_CONFLICT_ERROR },
          };
        }

        const response = await awaitEntryResponse(entryKey, existing);
        return {
          kind: "response",
          statusCode: response.statusCode,
          body: response.body,
          replayed: true,
        };
      }

      const pending = input
        .execute()
        .then((response) => {
          const current = entries.get(entryKey);
          if (current) {
            current.response = response;
            current.pending = undefined;
            current.expiresAt = now() + ttlMs;
          }
          return response;
        })
        .catch((error) => {
          entries.delete(entryKey);
          throw error;
        });

      entries.set(entryKey, {
        fingerprint: input.fingerprint,
        expiresAt: Number.POSITIVE_INFINITY,
        response: undefined,
        pending,
      });

      const response = await pending;
      return {
        kind: "response",
        statusCode: response.statusCode,
        body: response.body,
        replayed: false,
      };
    },
  };
}

export function readIdempotencyKey(req: Pick<http.IncomingMessage, "headers">): { ok: true; key?: string } | { ok: false; error: string } {
  const preferred = readHeaderValue(req.headers["idempotency-key"]);
  const legacy = readHeaderValue(req.headers["x-idempotency-key"]);
  if (preferred.error || legacy.error) {
    return {
      ok: false,
      error: "Idempotency-Key must be a single non-empty string",
    };
  }

  const normalizedPreferred = preferred.value?.trim();
  const normalizedLegacy = legacy.value?.trim();
  if (normalizedPreferred && normalizedLegacy && normalizedPreferred !== normalizedLegacy) {
    return {
      ok: false,
      error: "Idempotency-Key headers must match when both are provided",
    };
  }

  const key = normalizedPreferred ?? normalizedLegacy;
  if (!key) {
    return { ok: true };
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return {
      ok: false,
      error: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters`,
    };
  }
  return {
    ok: true,
    key,
  };
}

function readHeaderValue(value: string | string[] | undefined): { value?: string; error?: true } {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return { error: true };
    }
    const first = value[0];
    if (typeof first !== "string") {
      return { error: true };
    }
    const trimmed = first.trim();
    return trimmed.length > 0 && !trimmed.includes(",") ? { value: first } : { error: true };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && !trimmed.includes(",") ? { value } : { error: true };
  }
  return {};
}

export function createFileRouteIdempotencyStore(
  options: CreateFileRouteIdempotencyStoreOptions
): RouteIdempotencyStore {
  return new FileRouteIdempotencyStore(options);
}

class FileRouteIdempotencyStore implements RouteIdempotencyStore {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entryMutex = new KeyedAsyncMutex<string>();
  private readonly pruneMutex = new KeyedAsyncMutex<string>();
  private readonly pendingEntries = new Map<string, { fingerprint: string; promise: Promise<IdempotencyResponse> }>();

  constructor(options: CreateFileRouteIdempotencyStoreOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async execute(input: {
    scope: string;
    key?: string;
    fingerprint: string;
    execute: () => Promise<IdempotencyResponse>;
  }): Promise<RouteIdempotencyResult> {
    if (!input.key) {
      const response = await input.execute();
      return {
        kind: "response",
        statusCode: response.statusCode,
        body: response.body,
        replayed: false,
      };
    }

    await this.pruneExpiredEntries(this.now());
    const entryKey = `${input.scope}:${input.key}`;
    const decision = await this.entryMutex.run(entryKey, async () => {
      const pending = this.pendingEntries.get(entryKey);
      if (pending) {
        if (pending.fingerprint !== input.fingerprint) {
          return this.conflict();
        }
        return { kind: "pending" as const, promise: pending.promise };
      }

      const persisted = await this.readPersistedEntry(entryKey);
      if (persisted) {
        if (persisted.fingerprint !== input.fingerprint) {
          return this.conflict();
        }
        return {
          kind: "persisted" as const,
          response: persisted.response,
        };
      }

      let promise!: Promise<IdempotencyResponse>;
      promise = input.execute()
        .then(async (response) => {
          await this.entryMutex.run(entryKey, async () => {
            const current = this.pendingEntries.get(entryKey);
            if (current?.promise !== promise) {
              return;
            }
            this.pendingEntries.delete(entryKey);
            await this.writePersistedEntry(entryKey, {
              scope: input.scope,
              key: input.key!,
              fingerprint: input.fingerprint,
              response,
              createdAt: this.now(),
              expiresAt: this.now() + this.ttlMs,
            });
          });
          return response;
        })
        .catch(async (error) => {
          await this.entryMutex.run(entryKey, async () => {
            const current = this.pendingEntries.get(entryKey);
            if (current?.promise === promise) {
              this.pendingEntries.delete(entryKey);
            }
          });
          throw error;
        });

      this.pendingEntries.set(entryKey, {
        fingerprint: input.fingerprint,
        promise,
      });
      return { kind: "created" as const, promise };
    });

    if (decision.kind === "conflict") {
      return decision.result;
    }
    if (decision.kind === "persisted") {
      return {
        kind: "response",
        statusCode: decision.response.statusCode,
        body: decision.response.body,
        replayed: true,
      };
    }

    const response = await decision.promise;
    return {
      kind: "response",
      statusCode: response.statusCode,
      body: response.body,
      replayed: decision.kind === "pending",
    };
  }

  private conflict(): { kind: "conflict"; result: RouteIdempotencyResult } {
    return {
      kind: "conflict",
      result: {
        kind: "conflict",
        statusCode: 409,
        body: { error: IDEMPOTENCY_CONFLICT_ERROR },
      },
    };
  }

  private async pruneExpiredEntries(currentTime: number): Promise<void> {
    await this.pruneMutex.run("route-idempotency", async () => {
      await mkdir(this.rootDir, { recursive: true });
      const filePaths = await listJsonFiles(this.rootDir);
      const settledEntries: Array<{ filePath: string; entry: PersistedIdempotencyEntry }> = [];

      for (const filePath of filePaths) {
        const entry = await readJsonFile<PersistedIdempotencyEntry>(filePath);
        if (!entry) {
          continue;
        }
        if (entry.expiresAt <= currentTime) {
          await removeFileIfExists(filePath);
          continue;
        }
        if (this.pendingEntries.has(this.entryKey(entry.scope, entry.key))) {
          continue;
        }
        settledEntries.push({ filePath, entry });
      }

      if (settledEntries.length <= this.maxEntries) {
        return;
      }

      settledEntries.sort((left, right) => left.entry.createdAt - right.entry.createdAt);
      for (const stale of settledEntries.slice(0, settledEntries.length - this.maxEntries)) {
        await removeFileIfExists(stale.filePath);
      }
    });
  }

  private async readPersistedEntry(entryKey: string): Promise<PersistedIdempotencyEntry | null> {
    const entry = await readJsonFile<PersistedIdempotencyEntry>(this.filePath(entryKey));
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      await removeFileIfExists(this.filePath(entryKey));
      return null;
    }
    return entry;
  }

  private async writePersistedEntry(entryKey: string, entry: PersistedIdempotencyEntry): Promise<void> {
    await writeJsonFileAtomic(this.filePath(entryKey), entry);
  }

  private filePath(entryKey: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(entryKey)}.json`);
  }

  private entryKey(scope: string, key: string): string {
    return `${scope}:${key}`;
  }
}

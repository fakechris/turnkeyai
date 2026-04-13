import type http from "node:http";

type IdempotencyResponse = {
  statusCode: number;
  body: unknown;
};

type IdempotencyEntry = {
  fingerprint: string;
  expiresAt: number;
  response: IdempotencyResponse | undefined;
  pending: Promise<IdempotencyResponse> | undefined;
};

export interface RouteIdempotencyStore {
  execute(input: {
    scope: string;
    key?: string;
    fingerprint: string;
    execute: () => Promise<IdempotencyResponse>;
  }): Promise<
    | { kind: "response"; statusCode: number; body: unknown; replayed: boolean }
    | { kind: "conflict"; statusCode: 409; body: { error: string } }
  >;
}

interface CreateRouteIdempotencyStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
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
      if (entry.expiresAt <= currentTime) {
        entries.delete(entryKey);
      }
    }
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
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
        expiresAt: currentTime + ttlMs,
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
    return typeof first === "string" && first.trim().length > 0 ? { value: first } : { error: true };
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? { value } : { error: true };
  }
  return {};
}

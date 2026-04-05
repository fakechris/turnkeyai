import type http from "node:http";

export type JsonBodyParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "Invalid JSON" };

export function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

export async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  return JSON.parse(raw) as T;
}

export async function readOptionalJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  if (raw.trim().length === 0) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}

export async function readJsonBodySafe<T>(req: http.IncomingMessage): Promise<JsonBodyParseResult<T>> {
  try {
    return {
      ok: true,
      value: await readJsonBody<T>(req),
    };
  } catch {
    return {
      ok: false,
      error: "Invalid JSON",
    };
  }
}

export async function readOptionalJsonBodySafe<T>(req: http.IncomingMessage): Promise<JsonBodyParseResult<T>> {
  try {
    return {
      ok: true,
      value: await readOptionalJsonBody<T>(req),
    };
  } catch {
    return {
      ok: false,
      error: "Invalid JSON",
    };
  }
}

export function parsePositiveLimit(value: string | null): number | null {
  if (value == null) {
    return 100;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return null;
  }

  return limit;
}

export function parsePositiveInteger(value: string | null): number | null {
  if (value == null) {
    return null;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseRequiredNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function parseOptionalNonEmptyString(value: string | null | undefined): string | undefined {
  return parseRequiredNonEmptyString(value) ?? undefined;
}

async function readRawBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

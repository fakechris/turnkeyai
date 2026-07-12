import type { WorkerKind, WorkerSessionState } from "@turnkeyai/core-types/team";

const MAX_SESSION_TOOL_TIMEOUT_SECONDS = 1800;
const DEFAULT_BROWSER_SESSION_TOOL_TIMEOUT_MS = 18 * 60 * 1_000;
const DEFAULT_EXPLORE_SESSION_TOOL_TIMEOUT_MS = 8 * 60 * 1_000;
const DEFAULT_GENERAL_SESSION_TOOL_TIMEOUT_MS = 3 * 60 * 1_000;
const DEFAULT_RESUMABLE_CONTINUATION_TOOL_TIMEOUT_MS = 45_000;

export function resolveToolTimeoutMs(
  value: unknown,
  workerKind: WorkerKind,
  maxTimeoutMs?: number,
): number {
  return parseToolTimeoutMs(value, maxTimeoutMs) ??
    boundDefaultToolTimeoutMs(defaultToolTimeoutMs(workerKind), maxTimeoutMs);
}

export function resolveContinuationToolTimeoutMs(
  value: unknown,
  workerKind: WorkerKind,
  currentStatus: WorkerSessionState["status"],
  maxTimeoutMs?: number,
): number {
  const explicitTimeoutMs = parseToolTimeoutMs(value, maxTimeoutMs);
  if (explicitTimeoutMs !== null) {
    return currentStatus === "cancelled"
      ? explicitTimeoutMs
      : Math.min(
          explicitTimeoutMs,
          boundDefaultToolTimeoutMs(
            DEFAULT_RESUMABLE_CONTINUATION_TOOL_TIMEOUT_MS,
            maxTimeoutMs,
          ),
        );
  }
  const defaultTimeoutMs = boundDefaultToolTimeoutMs(
    defaultToolTimeoutMs(workerKind),
    maxTimeoutMs,
  );
  return currentStatus === "cancelled"
    ? defaultTimeoutMs
    : Math.min(
        defaultTimeoutMs,
        boundDefaultToolTimeoutMs(
          DEFAULT_RESUMABLE_CONTINUATION_TOOL_TIMEOUT_MS,
          maxTimeoutMs,
        ),
      );
}

function parseToolTimeoutMs(value: unknown, maxTimeoutMs?: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const configuredMaxSeconds =
    typeof maxTimeoutMs === "number" && Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0
      ? maxTimeoutMs / 1_000
      : MAX_SESSION_TOOL_TIMEOUT_SECONDS;
  const boundedSeconds = Math.min(
    value,
    configuredMaxSeconds,
    MAX_SESSION_TOOL_TIMEOUT_SECONDS,
  );
  return Math.max(1, Math.round(boundedSeconds * 1_000));
}

function defaultToolTimeoutMs(workerKind: WorkerKind): number {
  if (workerKind === "browser") return DEFAULT_BROWSER_SESSION_TOOL_TIMEOUT_MS;
  if (workerKind === "explore" || workerKind === "finance") {
    return DEFAULT_EXPLORE_SESSION_TOOL_TIMEOUT_MS;
  }
  return DEFAULT_GENERAL_SESSION_TOOL_TIMEOUT_MS;
}

function boundDefaultToolTimeoutMs(
  defaultTimeoutMs: number,
  maxTimeoutMs?: number,
): number {
  const configuredMaxMs =
    typeof maxTimeoutMs === "number" && Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0
      ? maxTimeoutMs
      : MAX_SESSION_TOOL_TIMEOUT_SECONDS * 1_000;
  return Math.max(
    1,
    Math.min(
      defaultTimeoutMs,
      configuredMaxMs,
      MAX_SESSION_TOOL_TIMEOUT_SECONDS * 1_000,
    ),
  );
}

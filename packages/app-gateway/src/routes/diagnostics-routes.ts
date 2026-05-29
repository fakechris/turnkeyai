import type http from "node:http";
import { open, stat } from "node:fs/promises";

import { sendJson } from "../http-helpers";

// Diagnostics endpoints feed the Control Center's "Diagnostics" page and
// give users a one-stop view of the daemon's runtime environment plus a
// recent log tail. Read-only — no mutations here.
//
// GET /diagnostics             → environmental snapshot
// GET /diagnostics/logs?limit  → last N log lines as text/plain
//
// Both are "read"-access (see daemon-auth.ts). Sensitive secrets are
// scrubbed from the diagnostics snapshot — the response includes config
// paths but NOT the token contents.

export interface DiagnosticsRouteDeps {
  /** Daemon package version, e.g. "0.1.1". */
  daemonVersion: string;
  /** Listening port. */
  port: number;
  /** Resolved data directory. */
  dataDir: string;
  /** Resolved runtime root (~/.turnkeyai by default). */
  runtimeRoot: string;
  /** Resolved daemon log file path. */
  logFile: string;
  /** Resolved config file path. */
  configFile: string;
  /** Resolved model catalog path (may be null on a fresh install). */
  modelCatalogPath: string | null;
  /** Wall-clock timestamp when the process started, ms since epoch. */
  processStartedAtMs: number;
  /** Transport descriptor (mode + label) from the active browser bridge. */
  transport: { mode: string; label: string };
  /** Direct-CDP endpoint when configured. Used only for readiness hints. */
  directCdpEndpoint?: string | null;
  /** Whether a relay endpoint was configured at daemon startup. */
  relayEndpointConfigured?: boolean;
  /** Auth mode reported by daemon-auth. */
  authMode: "disabled" | "token" | "token-layered";
  /**
   * Tokens the daemon was configured with. /diagnostics/logs scrubs any
   * literal occurrences from log lines before sending them to the
   * dashboard, so a copy-pasted diagnostics bundle is safe to attach to a
   * bug report. Empty array when auth is disabled.
   */
  redactionTokens: readonly string[];
  /** Snapshot of session count + relay peer/target counts. */
  snapshotCounters(): Promise<{
    sessionCount: number;
    relayPeerCount: number;
    relayTargetCount: number;
  }>;
  /** Recent browser runtime health, derived from session history. */
  browserHealthSnapshot?(): Promise<DiagnosticsBrowserHealthSnapshot>;
}

export type DiagnosticsReadinessStatus = "ok" | "warn" | "error";

export interface DiagnosticsBrowserHealthSnapshot {
  inspectedSessionCount: number;
  recentHistoryCount: number;
  recentFailureCount: number;
  profileFallbackCount: number;
  latestFailureSummary?: string;
  latestProfileFallback?: {
    browserSessionId: string;
    completedAt: number;
    fallbackDir: string;
  };
}

export interface DiagnosticsReadinessCheck {
  id: string;
  label: string;
  status: DiagnosticsReadinessStatus;
  detail: string;
  action?: string;
}

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 2000;
const MAX_LOG_TAIL_BYTES = 1_024 * 1024; // 1 MiB cap on bytes we'll read from disk

export async function handleDiagnosticsRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: DiagnosticsRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  if (url.pathname === "/diagnostics") {
    return handleDiagnosticsSnapshot(req, res, deps);
  }

  if (url.pathname === "/diagnostics/logs") {
    return handleDiagnosticsLogs(req, res, url, deps);
  }

  return false;
}

async function handleDiagnosticsSnapshot(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DiagnosticsRouteDeps
): Promise<boolean> {
  let counters: { sessionCount: number; relayPeerCount: number; relayTargetCount: number };
  try {
    counters = await deps.snapshotCounters();
  } catch {
    counters = { sessionCount: 0, relayPeerCount: 0, relayTargetCount: 0 };
  }

  const logFileStat = await stat(deps.logFile).catch(() => null);
  const readiness = await buildReadinessChecks(deps, logFileStat);

  const snapshot = {
    daemon: {
      version: deps.daemonVersion,
      port: deps.port,
      startedAt: deps.processStartedAtMs,
      // Uptime is computed from process.uptime() at request time so the
      // snapshot is fresh on every poll, not frozen at startup.
      uptimeMs: Math.round(process.uptime() * 1000),
      authMode: deps.authMode,
    },
    paths: {
      runtimeRoot: deps.runtimeRoot,
      dataDir: deps.dataDir,
      configFile: deps.configFile,
      logFile: deps.logFile,
      modelCatalogPath: deps.modelCatalogPath,
      logFileBytes: logFileStat?.size ?? null,
      logFileModifiedAt: logFileStat?.mtimeMs ?? null,
    },
    transport: {
      mode: deps.transport.mode,
      label: deps.transport.label,
    },
    counters,
    node: {
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    readiness: {
      status: summarizeReadiness(readiness),
      checks: readiness,
    },
  };

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end();
    return true;
  }
  sendJson(res, 200, snapshot);
  return true;
}

async function buildReadinessChecks(
  deps: DiagnosticsRouteDeps,
  logFileStat: Awaited<ReturnType<typeof stat>> | null
): Promise<DiagnosticsReadinessCheck[]> {
  const checks: DiagnosticsReadinessCheck[] = [
    {
      id: "daemon",
      label: "Daemon",
      status: "ok",
      detail: `Listening on port ${deps.port}.`,
    },
    buildAuthReadiness(deps.authMode),
    await buildModelCatalogReadiness(deps.modelCatalogPath),
    buildBrowserTransportReadiness(deps),
    ...(await buildBrowserRuntimeReadiness(deps)),
    await buildLogFileReadiness(deps.logFile, logFileStat),
  ];
  return checks;
}

function buildAuthReadiness(authMode: DiagnosticsRouteDeps["authMode"]): DiagnosticsReadinessCheck {
  if (authMode === "disabled") {
    return {
      id: "auth",
      label: "Control Center auth",
      status: "warn",
      detail: "Daemon auth is disabled.",
      action: "Enable token auth before using this daemon beyond local development.",
    };
  }
  return {
    id: "auth",
    label: "Control Center auth",
    status: "ok",
    detail: `${authMode} auth is active.`,
    action: "Open through turnkeyai app, npx @turnkeyai/cli app, or npm run app -- --no-open so the token is injected.",
  };
}

async function buildModelCatalogReadiness(modelCatalogPath: string | null): Promise<DiagnosticsReadinessCheck> {
  if (!modelCatalogPath) {
    return {
      id: "model_catalog",
      label: "Model catalog",
      status: "warn",
      detail: "No model catalog is configured, so live LLM runs fall back to deterministic local behavior.",
      action: "Configure a model catalog before production task runs.",
    };
  }
  const catalogStat = await stat(modelCatalogPath).catch(() => null);
  if (!catalogStat) {
    return {
      id: "model_catalog",
      label: "Model catalog",
      status: "error",
      detail: `Configured model catalog is not readable: ${modelCatalogPath}.`,
      action: "Fix the path or regenerate the model catalog.",
    };
  }
  if (!catalogStat.isFile()) {
    return {
      id: "model_catalog",
      label: "Model catalog",
      status: "error",
      detail: `Configured model catalog is not a file: ${modelCatalogPath}.`,
      action: "Point the daemon at a JSON model catalog file.",
    };
  }
  const readError = await checkFileReadable(modelCatalogPath);
  if (readError) {
    return {
      id: "model_catalog",
      label: "Model catalog",
      status: "error",
      detail: `Configured model catalog cannot be read: ${readError}.`,
      action: "Fix file permissions or regenerate the model catalog.",
    };
  }
  return {
    id: "model_catalog",
    label: "Model catalog",
    status: "ok",
    detail: `Using ${modelCatalogPath}.`,
  };
}

function buildBrowserTransportReadiness(deps: DiagnosticsRouteDeps): DiagnosticsReadinessCheck {
  if (deps.transport.mode === "direct-cdp") {
    if (deps.directCdpEndpoint?.trim()) {
      return {
        id: "browser_transport",
        label: "Browser transport",
        status: "ok",
        detail: `Direct CDP endpoint configured: ${sanitizeCdpEndpointForDiagnostics(deps.directCdpEndpoint)}.`,
      };
    }
    return {
      id: "browser_transport",
      label: "Browser transport",
      status: "warn",
      detail: "Direct CDP transport is active but no endpoint is visible in diagnostics.",
      action: "Check TURNKEYAI_BROWSER_CDP_ENDPOINT if expert-lane browser work fails.",
    };
  }

  if (deps.transport.mode === "relay") {
    const check: DiagnosticsReadinessCheck = {
      id: "browser_transport",
      label: "Browser transport",
      status: deps.relayEndpointConfigured ? "ok" : "warn",
      detail: deps.relayEndpointConfigured
        ? `Relay transport configured: ${deps.transport.label}.`
        : "Relay transport is active without a configured relay endpoint.",
    };
    if (!deps.relayEndpointConfigured) {
      check.action = "Set relay configuration or switch to local/direct-CDP transport.";
    }
    return {
      ...check,
    };
  }

  return {
    id: "browser_transport",
    label: "Browser transport",
    status: "ok",
    detail: `${deps.transport.label} is active.`,
  };
}

async function buildBrowserRuntimeReadiness(
  deps: DiagnosticsRouteDeps
): Promise<DiagnosticsReadinessCheck[]> {
  if (!deps.browserHealthSnapshot) {
    return [];
  }
  let snapshot: DiagnosticsBrowserHealthSnapshot;
  try {
    snapshot = await deps.browserHealthSnapshot();
  } catch (error) {
    return [
      {
        id: "browser_runtime",
        label: "Browser runtime",
        status: "warn",
        detail: `Browser runtime history is not readable: ${errorMessageForDiagnostics(error)}.`,
        action: "Open Runtime logs if browser tasks are stuck or repeatedly respawning.",
      },
    ];
  }

  if (snapshot.profileFallbackCount > 0) {
    const latest = snapshot.latestProfileFallback;
    return [
      {
        id: "browser_runtime",
        label: "Browser runtime",
        status: "warn",
        detail: latest
          ? `Recent browser tasks used isolated runtime profiles ${snapshot.profileFallbackCount} time(s); latest session ${latest.browserSessionId}.`
          : `Recent browser tasks used isolated runtime profiles ${snapshot.profileFallbackCount} time(s).`,
        action: latest
          ? `A persistent browser profile was locked. Close the conflicting browser profile or revoke/retry the session; fallback dir: ${latest.fallbackDir}.`
          : "A persistent browser profile was locked. Close the conflicting browser profile or revoke/retry the session.",
      },
    ];
  }

  if (snapshot.recentFailureCount > 0) {
    return [
      {
        id: "browser_runtime",
        label: "Browser runtime",
        status: "warn",
        detail: `Recent browser history includes ${snapshot.recentFailureCount} failed task(s).`,
        action: snapshot.latestFailureSummary
          ? `Latest failure: ${trimDiagnosticText(snapshot.latestFailureSummary, 180)}`
          : "Open the mission timeline and runtime logs before retrying browser work.",
      },
    ];
  }

  if (snapshot.recentHistoryCount === 0) {
    return [
      {
        id: "browser_runtime",
        label: "Browser runtime",
        status: "ok",
        detail: snapshot.inspectedSessionCount === 0
          ? "No live browser sessions yet."
          : `No recent browser task history across ${snapshot.inspectedSessionCount} session(s).`,
      },
    ];
  }

  return [
    {
      id: "browser_runtime",
      label: "Browser runtime",
      status: "ok",
      detail: `Recent browser history is healthy across ${snapshot.inspectedSessionCount} session(s).`,
    },
  ];
}

function buildLogFileReadiness(
  logFile: string,
  logFileStat: Awaited<ReturnType<typeof stat>> | null
): Promise<DiagnosticsReadinessCheck> {
  if (!logFileStat) {
    return Promise.resolve({
      id: "log_file",
      label: "Daemon log",
      status: "warn",
      detail: `Log file is not readable yet: ${logFile}.`,
      action: "This is normal for foreground dev runs until the daemon emits logs.",
    });
  }
  return checkFileReadable(logFile).then((readError) => {
    if (readError) {
      return {
        id: "log_file",
        label: "Daemon log",
        status: "error",
        detail: `Log file exists but cannot be read: ${readError}.`,
        action: "Fix daemon log permissions or restart the daemon with a writable runtime root.",
      };
    }
    return {
      id: "log_file",
      label: "Daemon log",
      status: "ok",
      detail: `${Math.round(Number(logFileStat.size) / 1024)} KiB at ${logFile}.`,
    };
  });
}

async function checkFileReadable(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, "r");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function summarizeReadiness(checks: readonly DiagnosticsReadinessCheck[]): DiagnosticsReadinessStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "ok";
}

export function sanitizeCdpEndpointForDiagnostics(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "(empty)";
  const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  try {
    const url = new URL(hasProtocol ? trimmed : `http://${trimmed}`);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    url.pathname = url.pathname
      .split("/")
      .map((segment) => (shouldRedactEndpointPathSegment(segment) ? "redacted" : segment))
      .join("/");
    if (url.search) url.search = "?redacted";
    url.hash = "";
    const sanitized = url.toString();
    return hasProtocol ? sanitized : sanitized.replace(/^http:\/\//, "");
  } catch {
    return "[invalid endpoint redacted]";
  }
}

function shouldRedactEndpointPathSegment(segment: string): boolean {
  if (!segment) return false;
  const decoded = safeDecodeURIComponent(segment);
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(decoded)) {
    return true;
  }
  if (/^[a-f0-9]{24,}$/i.test(decoded)) {
    return true;
  }
  if (/^[A-Za-z0-9._~+=-]{16,}$/.test(decoded)) {
    return true;
  }
  return false;
}

function errorMessageForDiagnostics(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return trimDiagnosticText(error.message.trim(), 180);
  if (typeof error === "string" && error.trim()) return trimDiagnosticText(error.trim(), 180);
  return "unknown error";
}

function trimDiagnosticText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function handleDiagnosticsLogs(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: DiagnosticsRouteDeps
): Promise<boolean> {
  const limitParam = url.searchParams.get("limit");
  const limit = clampLogLimit(limitParam);

  const tail = await tailFile(deps.logFile, limit).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  if ("error" in tail) {
    // Daemon log might not exist on a foreground / dev run — return a clean
    // 200 with an empty payload instead of a confusing 500.
    sendJson(res, 200, {
      logFile: deps.logFile,
      limit,
      lineCount: 0,
      lines: [],
      note: `log not readable: ${tail.error}`,
    });
    return true;
  }

  const redactedLines = tail.lines.map((line) => redactLogLine(line, deps.redactionTokens));
  sendJson(res, 200, {
    logFile: deps.logFile,
    limit,
    lineCount: redactedLines.length,
    lines: redactedLines,
    truncatedFromHead: tail.truncatedFromHead,
    // Surface that redaction is happening so a user looking at the bundle
    // doesn't think the daemon is just naive about secrets.
    redacted: true,
  });
  return true;
}

/**
 * Scrubs secrets from a single log line before serving it to the dashboard.
 *
 * Defense in depth — /diagnostics/logs is `read`-scoped, so anything that
 * reads `/bridge/status` can also read the log tail. The daemon shouldn't
 * be logging raw secrets in the first place, but operational reality
 * means it sometimes does (LLM error responses include API keys, agents
 * sometimes include their token in user-agent strings, etc). This
 * scrubber is a backstop, not a substitute for not logging secrets.
 *
 * Patterns (codex PR I round-2 broadening):
 *  1. Configured tokens — exact substring replace, len >= 8 to avoid
 *     pathological short-token false positives.
 *  2. `Authorization: Bearer xxx` / `authorization: bearer xxx`
 *  3. `x-turnkeyai-token: xxx`
 *  4. `x-api-key: xxx` / `x-api-key=xxx` — generic API-key header
 *  5. `cookie: xxx` / `set-cookie: xxx` — session cookies
 *  6. `api_key=xxx` / `api-key=xxx` — query-string / config-style API keys
 *  7. `sk-...` / `sk_live_...` — OpenAI / Stripe-shaped secret tokens
 *  8. Bare `token=xxx` / `token: xxx` in arbitrary message text
 *
 * Exposed for unit testing.
 */
export function redactLogLine(line: string, configuredTokens: readonly string[]): string {
  let out = line;
  // Sort tokens descending by length so a shorter token that happens to
  // be a prefix of a longer one doesn't get redacted first and leave
  // the longer one's suffix exposed (gemini PR I round-2 catch).
  const sortedTokens = [...configuredTokens].sort((a, b) => b.length - a.length);
  for (const token of sortedTokens) {
    if (token && token.length >= 8 && out.includes(token)) {
      out = out.split(token).join("[REDACTED]");
    }
  }
  // Token-shaped value class: a-z, A-Z, 0-9, and the chars commonly seen
  // in JWTs / base64url / hex tokens. Crucially does NOT include "}" "]"
  // ";" "," or quote characters, so a "log message that happens to look
  // like {api-key: secret-thing}" gets the secret-thing redacted without
  // eating the trailing brace.
  const TOKEN_VALUE = `[A-Za-z0-9._~+/=-]+`;
  // Auth headers
  out = out.replace(new RegExp(`(authorization\\s*:\\s*bearer\\s+)${TOKEN_VALUE}`, "gi"), "$1[REDACTED]");
  out = out.replace(new RegExp(`(x-turnkeyai-token\\s*:\\s*)${TOKEN_VALUE}`, "gi"), "$1[REDACTED]");
  out = out.replace(new RegExp(`(x-api-key\\s*[:=]\\s*)${TOKEN_VALUE}`, "gi"), "$1[REDACTED]");
  // Cookies (request and response)
  out = out.replace(/((?:^|\W)(?:set-)?cookie\s*:\s*)[^\r\n;]+/gi, "$1[REDACTED]");
  // Common API-key parameter shapes
  out = out.replace(new RegExp(`(\\bapi[_-]?key\\s*[=:]\\s*)${TOKEN_VALUE}`, "gi"), "$1[REDACTED]");
  // OpenAI / Stripe / generic "sk-..." secrets (12+ chars after the prefix)
  out = out.replace(/\b(sk[-_](?:live|test)?[-_]?)[A-Za-z0-9_-]{12,}/g, "$1[REDACTED]");
  // Bare "token=xxx" / "Token: xxx" / "TOKEN: xxx" in arbitrary message text.
  // Case-insensitive to match the other patterns (gemini PR I round-2).
  out = out.replace(/(\btoken[=:\s]+)([A-Za-z0-9_-]{12,})/gi, "$1[REDACTED]");
  return out;
}

function clampLogLimit(raw: string | null): number {
  if (raw == null) return DEFAULT_LOG_LIMIT;
  if (!/^\d+$/.test(raw)) return DEFAULT_LOG_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(parsed, MAX_LOG_LIMIT);
}

/**
 * Reads the last `limit` lines from a file by streaming the tail of it.
 *
 * For a large daemon log we don't want to read the whole file into memory.
 * Instead we read up to MAX_LOG_TAIL_BYTES from the end of the file, split
 * on newlines, and return the last `limit` rows. truncatedFromHead is true
 * when there were earlier lines beyond the tail window we read.
 *
 * Exported for unit-testing. Not part of the public route surface.
 */
export async function tailFile(
  filePath: string,
  limit: number
): Promise<{ lines: string[]; truncatedFromHead: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (stats.size === 0) {
      return { lines: [], truncatedFromHead: false };
    }
    const readLength = Math.min(stats.size, MAX_LOG_TAIL_BYTES);
    const readStart = stats.size - readLength;
    const buffer = Buffer.alloc(readLength);
    // Capture bytesRead — if the file is truncated/rotated between stat()
    // and read(), the buffer can be partially filled and the trailing
    // zero-bytes would corrupt the decoded tail (codex S1). Slicing to
    // bytesRead guarantees we decode only the actually-read region.
    const { bytesRead } = await handle.read(buffer, 0, readLength, readStart);
    if (bytesRead === 0) {
      return { lines: [], truncatedFromHead: readStart > 0 };
    }
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    // If we started mid-line (because the tail window doesn't reach the
    // start of file or doesn't begin at a newline), drop the partial first
    // line so we don't return a corrupted prefix.
    let partialPrefixDropped = false;
    if (readStart > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
        partialPrefixDropped = true;
      } else {
        // The chosen window contains no newline; treat as a single huge line.
        return {
          lines: [text],
          truncatedFromHead: true,
        };
      }
    }
    const lines = text.split("\n");
    // Trailing newline → final empty string; drop it for a cleaner payload.
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const truncatedFromHead =
      partialPrefixDropped || lines.length > limit || readStart > 0;
    if (lines.length > limit) {
      return { lines: lines.slice(-limit), truncatedFromHead: true };
    }
    return { lines, truncatedFromHead };
  } finally {
    await handle.close();
  }
}

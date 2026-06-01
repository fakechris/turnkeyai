import type { ResolvedTuiToken } from "./tui-auth";
import { buildTuiRequestHeaders } from "./tui-auth";

export type TuiStartupCheckStatus = "ok" | "warn" | "fail";

export interface TuiStartupCheck {
  name: string;
  status: TuiStartupCheckStatus;
  detail: string;
}

export interface TuiStartupSnapshot {
  baseUrl: string;
  authLabel: string;
  checks: TuiStartupCheck[];
  actions: string[];
}

type FetchLike = typeof fetch;

interface DiagnosticsReadinessPayload {
  readiness?: {
    checks?: Array<{
      label?: unknown;
      status?: unknown;
      detail?: unknown;
      action?: unknown;
    }>;
  };
}

interface ModelsPayload {
  defaultSelection?: {
    ok?: boolean;
    chainId?: string;
    primaryModelId?: string;
    fallbackModelIds?: string[];
    error?: string;
  };
  models?: Array<{
    id?: string;
    configured?: boolean;
    apiKeyEnv?: string;
  }>;
}

export async function buildTuiStartupSnapshot(input: {
  baseUrl: string;
  token: ResolvedTuiToken | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<TuiStartupSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 1500;
  const checks: TuiStartupCheck[] = [];
  const actions = [
    "web workbench: npm run app -- --no-open",
    "diagnostics: npm run doctor",
  ];

  const health = await fetchText(`${input.baseUrl}/health`, null, fetchImpl, timeoutMs);
  const daemonHealthy = health.ok;
  checks.push({
    name: "daemon /health",
    status: daemonHealthy ? "ok" : "fail",
    detail: daemonHealthy ? input.baseUrl : `${input.baseUrl} unreachable`,
  });

  if (!input.token) {
    checks.push({
      name: "daemon api auth",
      status: "warn",
      detail: "no daemon token configured; commands may fail when daemon auth is enabled",
    });
    checks.push({
      name: "model readiness",
      status: "warn",
      detail: "skipped until daemon auth is available",
    });
    checks.push({
      name: "browser readiness",
      status: "warn",
      detail: "skipped until daemon auth is available",
    });
    return {
      baseUrl: input.baseUrl,
      authLabel: "none",
      checks,
      actions,
    };
  }

  const authLabel = `${input.token.scope} token from ${input.token.source}`;
  if (!daemonHealthy) {
    checks.push({
      name: "daemon api auth",
      status: "warn",
      detail: "skipped because daemon /health is unreachable",
    });
    checks.push({
      name: "model readiness",
      status: "warn",
      detail: "skipped because daemon /health is unreachable",
    });
    checks.push({
      name: "browser readiness",
      status: "warn",
      detail: "skipped because daemon /health is unreachable",
    });
    return {
      baseUrl: input.baseUrl,
      authLabel,
      checks,
      actions,
    };
  }

  const bridgeStatus = await fetchText(`${input.baseUrl}/bridge/status`, input.token, fetchImpl, timeoutMs);
  checks.push({
    name: "daemon api auth",
    status: bridgeStatus.ok ? "ok" : "fail",
    detail: bridgeStatus.ok
      ? `/bridge/status accepted ${authLabel}`
      : bridgeStatus.statusCode
        ? `/bridge/status returned HTTP ${bridgeStatus.statusCode}`
        : `/bridge/status unreachable: ${bridgeStatus.error ?? "request failed"}`,
  });

  if (!bridgeStatus.ok) {
    checks.push({
      name: "model readiness",
      status: "warn",
      detail: "skipped because daemon API auth failed",
    });
    checks.push({
      name: "browser readiness",
      status: "warn",
      detail: "skipped because daemon API auth failed",
    });
    return {
      baseUrl: input.baseUrl,
      authLabel,
      checks,
      actions,
    };
  }

  checks.push(await buildModelReadinessCheck(input.baseUrl, input.token, fetchImpl, timeoutMs));
  checks.push(await buildBrowserReadinessCheck(input.baseUrl, input.token, fetchImpl, timeoutMs));

  return {
    baseUrl: input.baseUrl,
    authLabel,
    checks,
    actions,
  };
}

export function formatTuiStartup(snapshot: TuiStartupSnapshot): string[] {
  return [
    "TurnkeyAI Mission Workbench TUI",
    `daemon: ${snapshot.baseUrl}`,
    `auth: ${snapshot.authLabel}`,
    "startup readiness:",
    ...snapshot.checks.map((check) => `[${formatStatus(check.status)}] ${check.name.padEnd(18)} ${check.detail}`),
    "quick paths:",
    ...snapshot.actions.map((action) => `  ${action}`),
  ];
}

async function buildModelReadinessCheck(
  baseUrl: string,
  token: ResolvedTuiToken,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<TuiStartupCheck> {
  const result = await fetchJson<ModelsPayload>(`${baseUrl}/models`, token, fetchImpl, timeoutMs);
  if (!result.ok) {
    return {
      name: "model readiness",
      status: "warn",
      detail: result.statusCode
        ? `/models returned HTTP ${result.statusCode}`
        : `/models unreachable: ${result.error ?? "request failed"}`,
    };
  }
  const selection = result.json.defaultSelection;
  if (!selection?.ok || !selection.primaryModelId) {
    return {
      name: "model readiness",
      status: "fail",
      detail: selection?.error ?? "no default model selection",
    };
  }
  const primary = result.json.models?.find((model) => model.id === selection.primaryModelId);
  if (primary && !primary.configured) {
    const key = typeof primary.apiKeyEnv === "string" && primary.apiKeyEnv.trim() ? primary.apiKeyEnv.trim() : "(unknown env)";
    return {
      name: "model readiness",
      status: "fail",
      detail: `primary ${selection.primaryModelId} missing key ${key}`,
    };
  }
  const missingFallbacks = (selection.fallbackModelIds ?? []).filter((id) => {
    const model = result.json.models?.find((candidate) => candidate.id === id);
    return model && !model.configured;
  });
  const chain = selection.chainId
    ? `${selection.chainId}: ${selection.primaryModelId}`
    : selection.primaryModelId;
  return {
    name: "model readiness",
    status: missingFallbacks.length > 0 ? "warn" : "ok",
    detail: missingFallbacks.length > 0
      ? `${chain} ready, ${missingFallbacks.length} fallback key(s) missing`
      : `${chain} ready`,
  };
}

async function buildBrowserReadinessCheck(
  baseUrl: string,
  token: ResolvedTuiToken,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<TuiStartupCheck> {
  const result = await fetchJson<DiagnosticsReadinessPayload>(`${baseUrl}/diagnostics`, token, fetchImpl, timeoutMs);
  if (!result.ok) {
    return {
      name: "browser readiness",
      status: "warn",
      detail: result.statusCode
        ? `/diagnostics returned HTTP ${result.statusCode}`
        : `/diagnostics unreachable: ${result.error ?? "request failed"}`,
    };
  }
  const browserChecks = (result.json.readiness?.checks ?? [])
    .filter((check) => {
      const label = typeof check.label === "string" ? check.label.toLowerCase() : "";
      return label.includes("browser") || label.includes("transport") || label.includes("cdp");
    })
    .map((check) => {
      const status = normalizeReadinessStatus(check.status);
      const label = typeof check.label === "string" && check.label.trim() ? check.label.trim() : "browser";
      const detail = typeof check.detail === "string" && check.detail.trim() ? check.detail.trim() : "no detail";
      const action = typeof check.action === "string" && check.action.trim() ? ` next=${check.action.trim()}` : "";
      return { status, label, detail: `${detail}${action}` };
    });

  if (browserChecks.length === 0) {
    return {
      name: "browser readiness",
      status: "ok",
      detail: "no browser transport warnings reported",
    };
  }

  const worst = browserChecks.some((check) => check.status === "fail")
    ? "fail"
    : browserChecks.some((check) => check.status === "warn")
      ? "warn"
      : "ok";
  const summary = browserChecks
    .filter((check) => check.status !== "ok")
    .slice(0, 2)
    .map((check) => `${check.label}: ${check.detail}`)
    .join(" | ");

  return {
    name: "browser readiness",
    status: worst,
    detail: summary || `${browserChecks.length} browser transport check(s) ok`,
  };
}

function normalizeReadinessStatus(status: unknown): TuiStartupCheckStatus {
  if (status === "ok") return "ok";
  if (status === "warn") return "warn";
  if (status === "error" || status === "fail") return "fail";
  return "warn";
}

async function fetchText(
  url: string,
  token: ResolvedTuiToken | null,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<{ ok: true; statusCode: number; text: string } | { ok: false; statusCode?: number; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: buildTuiRequestHeaders(token),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) return { ok: false, statusCode: response.status };
    return { ok: true, statusCode: response.status, text };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(
  url: string,
  token: ResolvedTuiToken,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<{ ok: true; statusCode: number; json: T } | { ok: false; statusCode?: number; error?: string }> {
  const text = await fetchText(url, token, fetchImpl, timeoutMs);
  if (!text.ok) return text;
  try {
    return { ok: true, statusCode: text.statusCode, json: JSON.parse(text.text || "{}") as T };
  } catch {
    return { ok: false, statusCode: text.statusCode, error: "invalid JSON response" };
  }
}

function formatStatus(status: TuiStartupCheckStatus): string {
  return status === "ok" ? "ok  " : status;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}

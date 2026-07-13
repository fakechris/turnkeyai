import path from "node:path";

export type DesktopTokenScope = "read" | "operator" | "admin" | "unknown";

export interface DesktopRuntimeConfig {
  port?: number;
  token?: string | null;
}

export interface DesktopConnection {
  baseUrl: string;
  token: string | null;
  scope: DesktopTokenScope | null;
  externallyManaged: boolean;
}

export function resolveDesktopToken(
  env: NodeJS.ProcessEnv,
  configToken: string | null
): { token: string; scope: DesktopTokenScope } | null {
  const operator = env.TURNKEYAI_DAEMON_OPERATOR_TOKEN?.trim();
  if (operator) return { token: operator, scope: "operator" };

  const legacy = env.TURNKEYAI_DAEMON_TOKEN?.trim();
  if (legacy) return { token: legacy, scope: "unknown" };

  const admin = env.TURNKEYAI_DAEMON_ADMIN_TOKEN?.trim();
  if (admin) return { token: admin, scope: "admin" };

  const read = env.TURNKEYAI_DAEMON_READ_TOKEN?.trim();
  if (read) return { token: read, scope: "read" };

  const config = configToken?.trim();
  return config ? { token: config, scope: "unknown" } : null;
}

export function resolveDesktopConnection(
  env: NodeJS.ProcessEnv,
  config: DesktopRuntimeConfig | null
): DesktopConnection {
  const explicitBaseUrl = env.TURNKEYAI_DAEMON_URL?.trim();
  const externallyManaged = Boolean(explicitBaseUrl);
  const baseUrl = explicitBaseUrl
    ? normalizeHttpBaseUrl(explicitBaseUrl)
    : `http://127.0.0.1:${resolvePort(env.TURNKEYAI_DAEMON_PORT, config?.port)}`;
  const resolvedToken = resolveDesktopToken(env, config?.token ?? null);

  return {
    baseUrl,
    token: resolvedToken?.token ?? null,
    scope: resolvedToken?.scope ?? null,
    externallyManaged,
  };
}

export function buildDesktopDashboardUrl(
  baseUrl: string,
  token: string,
  scope: DesktopTokenScope,
  route = "missions"
): string {
  const fragment = new URLSearchParams({ token, scope, route });
  return `${baseUrl}/app#${fragment.toString()}`;
}

export function isAllowedDesktopNavigation(targetUrl: string, baseUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const base = new URL(baseUrl);
    return (
      target.origin === base.origin &&
      (target.pathname === "/app" || target.pathname.startsWith("/app/"))
    );
  } catch {
    return false;
  }
}

export function isMatchingDaemonHealth(payload: unknown, baseUrl: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  try {
    const parsed = new URL(baseUrl);
    const expectedPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return record.ok === true && record.port === expectedPort;
  } catch {
    return false;
  }
}

export function resolveRuntimeEntry(input: {
  packaged: boolean;
  moduleDir: string;
  resourcesPath: string;
}): string {
  const runtimeDir = input.packaged
    ? path.join(input.resourcesPath, "runtime")
    : path.resolve(input.moduleDir, "..", "runtime");
  return path.join(runtimeDir, "daemon.js");
}

function resolvePort(envPort: string | undefined, configPort: number | undefined): number {
  const parsedEnvPort = envPort?.trim() ? Number(envPort.trim()) : Number.NaN;
  if (Number.isInteger(parsedEnvPort) && parsedEnvPort > 0 && parsedEnvPort <= 65_535) {
    return parsedEnvPort;
  }
  if (Number.isInteger(configPort) && (configPort ?? 0) > 0 && (configPort ?? 0) <= 65_535) {
    return configPort ?? 4_100;
  }
  return 4_100;
}

function normalizeHttpBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TURNKEYAI_DAEMON_URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("TURNKEYAI_DAEMON_URL must not include credentials");
  }
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error("TURNKEYAI_DAEMON_URL must use the daemon bind address 127.0.0.1");
  }
  if (parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("TURNKEYAI_DAEMON_URL must be an origin without a path, query, or fragment");
  }
  return parsed.origin;
}

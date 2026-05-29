import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type TuiTokenScope = "read" | "operator" | "admin" | "unknown";

export interface ResolvedTuiToken {
  token: string;
  scope: TuiTokenScope;
  source: "env" | "config";
}

interface TuiRuntimeConfig {
  token?: string | null;
}

export function resolveTuiToken(
  env: NodeJS.ProcessEnv = process.env,
  configToken: unknown = readConfigToken(env)
): ResolvedTuiToken | null {
  const operator = normalizeToken(env.TURNKEYAI_DAEMON_OPERATOR_TOKEN);
  if (operator) return { token: operator, scope: "operator", source: "env" };
  const legacy = normalizeToken(env.TURNKEYAI_DAEMON_TOKEN);
  if (legacy) return { token: legacy, scope: "unknown", source: "env" };
  const admin = normalizeToken(env.TURNKEYAI_DAEMON_ADMIN_TOKEN);
  if (admin) return { token: admin, scope: "admin", source: "env" };
  const read = normalizeToken(env.TURNKEYAI_DAEMON_READ_TOKEN);
  if (read) return { token: read, scope: "read", source: "env" };
  const config = normalizeToken(configToken);
  if (config) return { token: config, scope: "unknown", source: "config" };
  return null;
}

export function buildTuiRequestHeaders(
  token: ResolvedTuiToken | null,
  base: Record<string, string> = {}
): Record<string, string> {
  if (!token) return { ...base };
  return { ...base, authorization: `Bearer ${token.token}` };
}

function readConfigToken(env: NodeJS.ProcessEnv): unknown {
  const rootDir = env.TURNKEYAI_HOME?.trim() || path.join(homedir(), ".turnkeyai");
  const configFile = path.join(rootDir, "config.json");
  if (!existsSync(configFile)) return null;
  try {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as TuiRuntimeConfig;
    return config.token;
  } catch {
    return null;
  }
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

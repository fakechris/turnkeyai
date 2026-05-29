export type DaemonCliTokenScope = "read" | "operator" | "admin" | "unknown";

export interface ResolvedDaemonCliToken {
  token: string;
  scope: DaemonCliTokenScope;
  source: "env" | "config";
}

export function resolveDaemonCliToken(
  env: NodeJS.ProcessEnv,
  configToken: string | null | undefined
): ResolvedDaemonCliToken | null {
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

function normalizeToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

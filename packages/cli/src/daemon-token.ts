export type DaemonCliTokenScope = "read" | "operator" | "admin" | "unknown";
export type DaemonCliTokenRequiredAccess = "read" | "operator" | "admin" | "any";

export interface ResolvedDaemonCliToken {
  token: string;
  scope: DaemonCliTokenScope;
  source: "env" | "config";
}

export function resolveDaemonCliToken(
  env: NodeJS.ProcessEnv,
  configToken: unknown,
  requiredAccess: DaemonCliTokenRequiredAccess = "any"
): ResolvedDaemonCliToken | null {
  const candidates = buildCandidates(env, configToken);
  for (const candidate of selectTokenOrder(requiredAccess)) {
    const resolved = candidates[candidate];
    if (resolved) return resolved;
  }
  return null;
}

function buildCandidates(
  env: NodeJS.ProcessEnv,
  configToken: unknown
): Record<DaemonCliTokenCandidate, ResolvedDaemonCliToken | null> {
  const operator = normalizeToken(env.TURNKEYAI_DAEMON_OPERATOR_TOKEN);
  const legacy = normalizeToken(env.TURNKEYAI_DAEMON_TOKEN);
  const admin = normalizeToken(env.TURNKEYAI_DAEMON_ADMIN_TOKEN);
  const read = normalizeToken(env.TURNKEYAI_DAEMON_READ_TOKEN);
  const config = normalizeToken(configToken);

  return {
    read: read ? { token: read, scope: "read", source: "env" } : null,
    operator: operator ? { token: operator, scope: "operator", source: "env" } : null,
    admin: admin ? { token: admin, scope: "admin", source: "env" } : null,
    legacy: legacy ? { token: legacy, scope: "unknown", source: "env" } : null,
    config: config ? { token: config, scope: "unknown", source: "config" } : null,
  };
}

type DaemonCliTokenCandidate = "read" | "operator" | "legacy" | "admin" | "config";

function selectTokenOrder(requiredAccess: DaemonCliTokenRequiredAccess): DaemonCliTokenCandidate[] {
  switch (requiredAccess) {
    case "read":
      return ["read", "operator", "legacy", "admin", "config"];
    case "operator":
      return ["operator", "legacy", "admin", "config"];
    case "admin":
      return ["legacy", "admin", "config"];
    case "any":
      return ["operator", "legacy", "admin", "read", "config"];
  }
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

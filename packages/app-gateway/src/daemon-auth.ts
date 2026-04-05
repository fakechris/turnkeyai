import type http from "node:http";

export type DaemonAccessLevel = "read" | "operator" | "admin";

export interface DaemonAuthConfig {
  readToken: string | null;
  operatorToken: string | null;
  adminToken: string | null;
  authMode: "disabled" | "token" | "token-layered";
}

export interface DaemonAuthorizationResult {
  authorized: boolean;
  requiredAccess: DaemonAccessLevel | "public";
  grantedAccess?: DaemonAccessLevel;
  authMode: DaemonAuthConfig["authMode"];
}

export function resolveDaemonAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): DaemonAuthConfig {
  const legacyToken = normalizeToken(env.TURNKEYAI_DAEMON_TOKEN);
  const adminToken = normalizeToken(env.TURNKEYAI_DAEMON_ADMIN_TOKEN) ?? legacyToken;
  const operatorToken = normalizeToken(env.TURNKEYAI_DAEMON_OPERATOR_TOKEN) ?? adminToken;
  const readToken = normalizeToken(env.TURNKEYAI_DAEMON_READ_TOKEN) ?? operatorToken;

  if (!readToken && !operatorToken && !adminToken) {
    return {
      readToken: null,
      operatorToken: null,
      adminToken: null,
      authMode: "disabled",
    };
  }

  const distinctTokenCount = new Set(
    [readToken, operatorToken, adminToken].filter((value): value is string => Boolean(value))
  ).size;

  return {
    readToken,
    operatorToken,
    adminToken,
    authMode: distinctTokenCount > 1 ? "token-layered" : "token",
  };
}

export function authorizeDaemonRequest(
  req: http.IncomingMessage,
  url: URL,
  config: DaemonAuthConfig
): DaemonAuthorizationResult {
  const requiredAccess = resolveDaemonRequestAccess(req, url);
  if (requiredAccess === "public" || config.authMode === "disabled") {
    return {
      authorized: true,
      requiredAccess,
      authMode: config.authMode,
    };
  }

  const token = extractDaemonToken(req);
  const grantedAccess = token ? resolveGrantedAccess(token, config) : undefined;
  if (!grantedAccess) {
    return {
      authorized: false,
      requiredAccess,
      authMode: config.authMode,
    };
  }

  return {
    authorized: accessCovers(grantedAccess, requiredAccess),
    requiredAccess,
    grantedAccess,
    authMode: config.authMode,
  };
}

export function resolveDaemonRequestAccess(
  req: Pick<http.IncomingMessage, "method">,
  url: Pick<URL, "pathname">
): DaemonAccessLevel | "public" {
  if (req.method === "GET" && url.pathname === "/health") {
    return "public";
  }

  if (url.pathname.startsWith("/relay/")) {
    return "admin";
  }

  if (isValidationRoute(url.pathname)) {
    return "admin";
  }

  if (isBrowserRoute(url.pathname)) {
    return "operator";
  }

  if (req.method === "POST" && isWorkflowMutationRoute(url.pathname)) {
    return "operator";
  }

  if (req.method === "POST" && isRecoveryMutationRoute(url.pathname)) {
    return "operator";
  }

  if (req.method === "GET" && url.pathname === "/scheduled-tasks") {
    return "read";
  }

  return "read";
}

function isValidationRoute(pathname: string): boolean {
  return [
    "/regression-cases",
    "/regression-cases/run",
    "/failure-cases",
    "/failure-cases/run",
    "/soak-cases",
    "/soak-cases/run",
    "/acceptance-cases",
    "/acceptance-cases/run",
    "/realworld-cases",
    "/realworld-cases/run",
    "/validation-cases",
    "/validation-cases/run",
    "/validation-profiles",
    "/validation-profiles/run",
    "/validation-ops",
    "/soak-series/run",
    "/transport-soak/run",
    "/release-readiness/run",
  ].includes(pathname);
}

function isBrowserRoute(pathname: string): boolean {
  return pathname === "/browser-sessions" || pathname.startsWith("/browser-sessions/");
}

function isWorkflowMutationRoute(pathname: string): boolean {
  return pathname === "/threads/bootstrap-demo" || pathname === "/messages" || pathname === "/scheduled-tasks" || pathname === "/scheduled-tasks/trigger-due";
}

function isRecoveryMutationRoute(pathname: string): boolean {
  return pathname.startsWith("/replay-recoveries/") || pathname.match(/^\/recovery-runs\/[^/]+\/(approve|reject|retry|fallback|resume)$/) !== null;
}

function extractDaemonToken(req: http.IncomingMessage): string | null {
  const headerToken = req.headers["x-turnkeyai-token"];
  if (typeof headerToken === "string" && headerToken.trim().length > 0) {
    return headerToken.trim();
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    return token.length > 0 ? token : null;
  }

  return null;
}

function resolveGrantedAccess(token: string, config: DaemonAuthConfig): DaemonAccessLevel | undefined {
  if (config.adminToken && token === config.adminToken) {
    return "admin";
  }
  if (config.operatorToken && token === config.operatorToken) {
    return "operator";
  }
  if (config.readToken && token === config.readToken) {
    return "read";
  }
  return undefined;
}

function accessCovers(granted: DaemonAccessLevel, required: DaemonAccessLevel): boolean {
  const rank: Record<DaemonAccessLevel, number> = {
    read: 1,
    operator: 2,
    admin: 3,
  };
  return rank[granted] >= rank[required];
}

function normalizeToken(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

import type http from "node:http";

export type DaemonAccessLevel = "read" | "operator" | "relay-peer" | "admin";

export interface DaemonAuthConfig {
  readToken: string | null;
  operatorToken: string | null;
  relayPeerToken: string | null;
  adminToken: string | null;
  authMode: "disabled" | "token" | "token-layered";
}

export interface DaemonAuthorizationResult {
  authorized: boolean;
  requiredAccess: DaemonAccessLevel | "public";
  grantedAccess?: DaemonAccessLevel;
  authMode: DaemonAuthConfig["authMode"];
  token?: string;
}

export interface RelayPeerIdentityBinding {
  peerId: string;
  boundAt: number;
  lastSeenAt: number;
}

export interface RelayPeerIdentityBindingResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  binding?: RelayPeerIdentityBinding;
}

export function resolveDaemonAuthConfig(
  env: NodeJS.ProcessEnv = process.env
): DaemonAuthConfig {
  const legacyToken = normalizeToken(env.TURNKEYAI_DAEMON_TOKEN);
  const adminToken = normalizeToken(env.TURNKEYAI_DAEMON_ADMIN_TOKEN) ?? legacyToken;
  const operatorToken = normalizeToken(env.TURNKEYAI_DAEMON_OPERATOR_TOKEN) ?? adminToken;
  const readToken = normalizeToken(env.TURNKEYAI_DAEMON_READ_TOKEN) ?? operatorToken;
  const relayPeerToken = normalizeToken(env.TURNKEYAI_BROWSER_RELAY_TOKEN) ?? adminToken;

  if (!readToken && !operatorToken && !relayPeerToken && !adminToken) {
    return {
      readToken: null,
      operatorToken: null,
      relayPeerToken: null,
      adminToken: null,
      authMode: "disabled",
    };
  }

  const distinctTokenCount = new Set(
    [readToken, operatorToken, relayPeerToken, adminToken].filter(
      (value): value is string => Boolean(value)
    )
  ).size;

  return {
    readToken,
    operatorToken,
    relayPeerToken,
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
  if (!token) {
    return {
      authorized: false,
      requiredAccess,
      authMode: config.authMode,
    };
  }
  const grantedAccess = resolveGrantedAccess(token, config);
  if (!grantedAccess) {
    return {
      authorized: false,
      requiredAccess,
      authMode: config.authMode,
    };
  }

  return {
    authorized: tokenGrantsAccess(token, requiredAccess, config),
    requiredAccess,
    grantedAccess,
    authMode: config.authMode,
    token,
  };
}

export function resolveDaemonRequestAccess(
  req: Pick<http.IncomingMessage, "method">,
  url: Pick<URL, "pathname">
): DaemonAccessLevel | "public" {
  if (req.method === "GET" && url.pathname === "/health") {
    return "public";
  }

  if (isRelayReadRoute(req.method, url.pathname)) {
    return "admin";
  }

  if (isRelayPeerMutationRoute(req.method, url.pathname)) {
    return "relay-peer";
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

function isRelayReadRoute(method: string | undefined, pathname: string): boolean {
  return method === "GET" && (pathname === "/relay/peers" || pathname === "/relay/targets");
}

function isRelayPeerMutationRoute(method: string | undefined, pathname: string): boolean {
  if (method !== "POST") {
    return false;
  }
  return (
    pathname === "/relay/peers/register" ||
    /^\/relay\/peers\/[^/]+\/heartbeat$/.test(pathname) ||
    /^\/relay\/peers\/[^/]+\/targets\/report$/.test(pathname) ||
    /^\/relay\/peers\/[^/]+\/pull-actions$/.test(pathname) ||
    /^\/relay\/peers\/[^/]+\/action-results$/.test(pathname)
  );
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
  if (config.relayPeerToken && token === config.relayPeerToken) {
    return "relay-peer";
  }
  return undefined;
}

function tokenGrantsAccess(
  token: string,
  required: DaemonAccessLevel,
  config: DaemonAuthConfig
): boolean {
  switch (required) {
    case "read":
      return (
        (config.readToken !== null && token === config.readToken) ||
        (config.operatorToken !== null && token === config.operatorToken) ||
        (config.adminToken !== null && token === config.adminToken)
      );
    case "operator":
      return (
        (config.operatorToken !== null && token === config.operatorToken) ||
        (config.adminToken !== null && token === config.adminToken)
      );
    case "relay-peer":
      return (
        (config.relayPeerToken !== null && token === config.relayPeerToken) ||
        (config.adminToken !== null && token === config.adminToken)
      );
    case "admin":
      return config.adminToken !== null && token === config.adminToken;
  }
}

function normalizeToken(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function createRelayPeerIdentityBindingStore(input?: {
  now?: () => number;
}): {
  bindPeerIdentity(authorization: DaemonAuthorizationResult, peerId: string): RelayPeerIdentityBindingResult;
  authorizePeerIdentity(authorization: DaemonAuthorizationResult, peerId: string): RelayPeerIdentityBindingResult;
  getBinding(token: string, peerId?: string): RelayPeerIdentityBinding | null;
} {
  const now = input?.now ?? (() => Date.now());
  const bindings = new Map<string, Map<string, RelayPeerIdentityBinding>>();

  function authorizeOrBind(
    mode: "bind" | "authorize",
    authorization: DaemonAuthorizationResult,
    peerId: string
  ): RelayPeerIdentityBindingResult {
    const normalizedPeerId = peerId.trim();
    if (!normalizedPeerId) {
      return {
        ok: false,
        statusCode: 400,
        error: "peerId is required",
      };
    }

    if (authorization.authMode === "disabled" || authorization.grantedAccess === "admin") {
      return {
        ok: true,
      };
    }

    if (authorization.grantedAccess !== "relay-peer" || !authorization.token) {
      return {
        ok: false,
        statusCode: 403,
        error: "relay peer identity binding requires relay-peer access",
      };
    }

    const byPeerId = bindings.get(authorization.token) ?? new Map<string, RelayPeerIdentityBinding>();
    const current = byPeerId.get(normalizedPeerId);
    if (!current) {
      if (mode === "authorize") {
        return {
          ok: false,
          statusCode: 403,
          error: "relay peer token is not bound to a peerId",
        };
      }
      const binding = {
        peerId: normalizedPeerId,
        boundAt: now(),
        lastSeenAt: now(),
      };
      byPeerId.set(normalizedPeerId, binding);
      bindings.set(authorization.token, byPeerId);
      return {
        ok: true,
        binding,
      };
    }

    const updated = {
      ...current,
      lastSeenAt: now(),
    };
    byPeerId.set(normalizedPeerId, updated);
    bindings.set(authorization.token, byPeerId);
    return {
      ok: true,
      binding: updated,
    };
  }

  return {
    bindPeerIdentity(authorization, peerId) {
      return authorizeOrBind("bind", authorization, peerId);
    },
    authorizePeerIdentity(authorization, peerId) {
      return authorizeOrBind("authorize", authorization, peerId);
    },
    getBinding(token, peerId) {
      const byPeerId = bindings.get(token);
      if (!byPeerId) {
        return null;
      }
      if (peerId) {
        return byPeerId.get(peerId) ?? null;
      }
      return byPeerId.values().next().value ?? null;
    },
  };
}

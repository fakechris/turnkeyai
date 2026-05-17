import { KNOWN_ROUTES, KNOWN_SCOPES, type Route, type Scope } from "./types";

// Storage keys — must match what PR I's vanilla app.js used so an in-place
// dashboard reload after the J1 migration keeps the user signed-in.
export const TOKEN_STORAGE_KEY = "turnkeyai.controlCenter.token";
export const SCOPE_STORAGE_KEY = "turnkeyai.controlCenter.scope";

export const DEFAULT_ROUTE: Route = "setup";

export interface ParsedFragment {
  token: string | null;
  scope: string | null;
  route: Route | null;
}

/**
 * Parses the URL hash fragment shapes the CLI emits and the user types:
 *   #/setup
 *   #token=ABC
 *   #token=ABC&scope=operator&route=bridge
 *   #/bridge?token=ABC&scope=admin   (legacy mixed form)
 *
 * Unknown routes return route=null so the caller falls back to DEFAULT_ROUTE.
 */
export function parseFragment(rawHash: string): ParsedFragment {
  const hash = rawHash.replace(/^#/, "");
  if (!hash) return { token: null, scope: null, route: null };
  if (hash.startsWith("/")) {
    const [routePart, queryPart] = hash.slice(1).split("?");
    const params = new URLSearchParams(queryPart ?? "");
    return {
      token: params.get("token"),
      scope: params.get("scope"),
      route: normalizeRoute(routePart),
    };
  }
  const params = new URLSearchParams(hash);
  return {
    token: params.get("token"),
    scope: params.get("scope"),
    route: normalizeRoute(params.get("route")),
  };
}

export function normalizeRoute(value: string | null | undefined): Route | null {
  if (typeof value !== "string") return null;
  return (KNOWN_ROUTES as readonly string[]).includes(value) ? (value as Route) : null;
}

export function normalizeScope(value: string | null | undefined): Scope {
  if (typeof value === "string" && (KNOWN_SCOPES as readonly string[]).includes(value)) {
    return value as Scope;
  }
  return "unknown";
}

/**
 * Bootstrap result the App reads on mount. Side-effect: when the URL
 * fragment carries a token, the token is stashed in sessionStorage and
 * stripped from the address bar via history.replaceState (so it doesn't
 * linger in window.title / referrer / back-button history).
 */
export interface BootstrapResult {
  token: string | null;
  scope: Scope;
  route: Route;
}

export function bootstrapAuth(): BootstrapResult {
  const fragment = parseFragment(window.location.hash);
  if (fragment.token) {
    const scope = normalizeScope(fragment.scope);
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fragment.token);
    sessionStorage.setItem(SCOPE_STORAGE_KEY, scope);
    const cleanedRoute = fragment.route ?? DEFAULT_ROUTE;
    history.replaceState(null, "", `#/${cleanedRoute}`);
    return { token: fragment.token, scope, route: cleanedRoute };
  }
  const storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  const storedScope = normalizeScope(sessionStorage.getItem(SCOPE_STORAGE_KEY));
  return {
    token: storedToken,
    scope: storedScope,
    route: fragment.route ?? DEFAULT_ROUTE,
  };
}

/** Clears the persisted token + scope. Called by apiClient on 401. */
export function clearStoredAuth(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  sessionStorage.removeItem(SCOPE_STORAGE_KEY);
}

/** Persists a hand-pasted token (from the no-token form). Scope unknown. */
export function persistManualToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  sessionStorage.setItem(SCOPE_STORAGE_KEY, "unknown");
}

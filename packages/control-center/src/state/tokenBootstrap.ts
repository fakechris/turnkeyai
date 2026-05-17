import { KNOWN_ROUTES, KNOWN_SCOPES, type Route, type Scope } from "./types";

// Storage keys — must match what PR I's vanilla app.js used so an in-place
// dashboard reload after the J1 migration keeps the user signed-in.
export const TOKEN_STORAGE_KEY = "turnkeyai.controlCenter.token";
export const SCOPE_STORAGE_KEY = "turnkeyai.controlCenter.scope";

export const DEFAULT_ROUTE: Route = "missions";

export interface ParsedFragment {
  token: string | null;
  scope: string | null;
  route: Route | null;
  /**
   * Mission id, when the fragment carries `#/mission/<id>` (K1 introduces
   * deep links into Mission Detail). Null for every other route shape.
   */
  missionId: string | null;
}

/**
 * Parses the URL hash fragment shapes the CLI emits and the user types:
 *   #/missions
 *   #/mission/<missionId>        (K1: deep link into Mission Detail)
 *   #token=ABC
 *   #token=ABC&scope=operator&route=missions
 *   #/missions?token=ABC&scope=admin   (legacy mixed form)
 *
 * Unknown routes return route=null so the caller falls back to DEFAULT_ROUTE.
 * For `#/mission/<id>`, missionId is captured but not validated here — the
 * page renderer checks the id against the data layer and shows an empty
 * state when the id is stale (e.g. mission was archived).
 */
export function parseFragment(rawHash: string): ParsedFragment {
  const hash = rawHash.replace(/^#/, "");
  if (!hash) return { token: null, scope: null, route: null, missionId: null };
  if (hash.startsWith("/")) {
    const [pathPart, queryPart] = hash.slice(1).split("?");
    const params = new URLSearchParams(queryPart ?? "");
    const segments = (pathPart ?? "").split("/").filter(Boolean);
    const routeName = normalizeRoute(segments[0]);
    // `#/mission/<id>` → route=mission, missionId=<id>. We only honor the
    // second segment when the first is "mission" (singular) — every other
    // route is a leaf and any trailing path is ignored.
    const missionId =
      routeName === "mission" && typeof segments[1] === "string" && segments[1].length > 0
        ? decodeURIComponent(segments[1])
        : null;
    return {
      token: params.get("token"),
      scope: params.get("scope"),
      route: routeName,
      missionId,
    };
  }
  const params = new URLSearchParams(hash);
  return {
    token: params.get("token"),
    scope: params.get("scope"),
    route: normalizeRoute(params.get("route")),
    missionId: null,
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
 * Bootstrap result the App reads on mount. Pure — see commitBootstrap()
 * for the side-effecting half.
 *
 * Split into pure read + side-effect commit (gemini PR J1 review) so the
 * pure half can safely be called from a useReducer state initializer
 * even in React 18 Strict Mode, which intentionally double-invokes
 * initializers to surface side-effect bugs.
 */
export interface BootstrapResult {
  token: string | null;
  scope: Scope;
  route: Route;
  /** True when the token came from the URL fragment (needs commit). */
  fromFragment: boolean;
}

export function bootstrapAuth(): BootstrapResult {
  const fragment = parseFragment(window.location.hash);
  if (fragment.token) {
    const scope = normalizeScope(fragment.scope);
    return {
      token: fragment.token,
      scope,
      route: fragment.route ?? DEFAULT_ROUTE,
      fromFragment: true,
    };
  }
  const storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  const storedScope = normalizeScope(sessionStorage.getItem(SCOPE_STORAGE_KEY));
  return {
    token: storedToken,
    scope: storedScope,
    route: fragment.route ?? DEFAULT_ROUTE,
    fromFragment: false,
  };
}

/**
 * Side-effecting commit for a bootstrap result. Idempotent — safe to
 * call from a useEffect that may run after a double-invoked initializer
 * in Strict Mode. Persists the URL-fragment-supplied token to
 * sessionStorage and strips it from the URL so it doesn't linger in
 * window.title / referrer / back-button history.
 */
export function commitBootstrap(result: BootstrapResult): void {
  if (!result.fromFragment) return;
  if (result.token) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, result.token);
    sessionStorage.setItem(SCOPE_STORAGE_KEY, result.scope);
    history.replaceState(null, "", `#/${result.route}`);
  }
}

/**
 * Clears the persisted token + scope. Side-effecting; called by the
 * action-dispatching helper in AppState.tsx, NOT from inside the reducer
 * (gemini PR J1 review: reducers must be pure).
 */
export function clearStoredAuth(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  sessionStorage.removeItem(SCOPE_STORAGE_KEY);
}

/**
 * Persists a hand-pasted token (from the no-token form). Scope unknown.
 * Side-effecting; called by the action-dispatching helper, not inside
 * the reducer.
 */
export function persistManualToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  sessionStorage.setItem(SCOPE_STORAGE_KEY, "unknown");
}

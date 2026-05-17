import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import {
  bootstrapAuth,
  clearStoredAuth,
  persistManualToken,
} from "./tokenBootstrap";
import type { BridgeStatus } from "../api/types";
import type { ConnectionPill, Route, Scope } from "./types";

/**
 * Single shared store for cross-page state. Context + useReducer instead
 * of Zustand / Redux because the surface is small (six fields) and adding
 * a dependency to manage them isn't justified yet.
 *
 * State fields:
 *   - token / scope: auth resolution from URL fragment / sessionStorage /
 *     hand-pasted token form
 *   - route: hash-route the dashboard is rendering (driven by useHashRoute)
 *   - pill: connection-pill state in the top bar (updated by each polling
 *     page based on its fetch result)
 *   - lastStatus: cached /bridge/status response so non-Bridge pages (Tabs,
 *     Diagnostics) can read transport info without re-fetching
 */

export interface AppStateValue {
  token: string | null;
  scope: Scope;
  route: Route;
  pill: ConnectionPill;
  lastStatus: BridgeStatus | null;
}

export type AppAction =
  | { type: "set-route"; route: Route }
  | { type: "set-token-manual"; token: string }
  | { type: "set-token-from-fragment"; token: string; scope: Scope }
  | { type: "clear-token" }
  | { type: "set-pill"; pill: ConnectionPill }
  | { type: "set-last-status"; status: BridgeStatus | null };

function reducer(state: AppStateValue, action: AppAction): AppStateValue {
  switch (action.type) {
    case "set-route":
      return state.route === action.route ? state : { ...state, route: action.route };
    case "set-token-manual":
      persistManualToken(action.token);
      return { ...state, token: action.token, scope: "unknown" };
    case "set-token-from-fragment":
      // Bootstrap-time mutation; storage was already written by bootstrapAuth.
      return { ...state, token: action.token, scope: action.scope };
    case "clear-token":
      clearStoredAuth();
      return { ...state, token: null, scope: "unknown" };
    case "set-pill":
      return { ...state, pill: action.pill };
    case "set-last-status":
      return { ...state, lastStatus: action.status };
    default:
      return state;
  }
}

function makeInitialState(): AppStateValue {
  const boot = bootstrapAuth();
  return {
    token: boot.token,
    scope: boot.scope,
    route: boot.route,
    pill: { state: "unknown", label: "Checking…" },
    lastStatus: null,
  };
}

interface AppStateContextValue {
  state: AppStateValue;
  dispatch: (action: AppAction) => void;
  // Convenience helpers — encapsulate the {dispatch, action-object} dance
  // for the common operations so call sites read like a normal API.
  setRoute: (route: Route) => void;
  setToken: (token: string) => void;
  clearToken: () => void;
  setPill: (pill: ConnectionPill) => void;
  setLastStatus: (status: BridgeStatus | null) => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState);

  const setRoute = useCallback((route: Route) => dispatch({ type: "set-route", route }), []);
  const setToken = useCallback(
    (token: string) => dispatch({ type: "set-token-manual", token }),
    []
  );
  const clearToken = useCallback(() => dispatch({ type: "clear-token" }), []);
  const setPill = useCallback((pill: ConnectionPill) => dispatch({ type: "set-pill", pill }), []);
  const setLastStatus = useCallback(
    (status: BridgeStatus | null) => dispatch({ type: "set-last-status", status }),
    []
  );

  const value = useMemo<AppStateContextValue>(
    () => ({ state, dispatch, setRoute, setToken, clearToken, setPill, setLastStatus }),
    [state, setRoute, setToken, clearToken, setPill, setLastStatus]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error("useAppState must be called inside <AppStateProvider />");
  }
  return ctx;
}

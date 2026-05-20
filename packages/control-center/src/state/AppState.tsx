import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import {
  bootstrapAuth,
  clearStoredAuth,
  commitBootstrap,
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
  /**
   * When route === "mission", which mission to render. Selected from the
   * Missions list, persisted across hash changes so the URL can be
   * #/mission/msn.01 (or just #/mission with the most-recently-selected
   * mission as fallback).
   */
  selectedMissionId: string | null;
  pill: ConnectionPill;
  lastStatus: BridgeStatus | null;
  /**
   * Optimistic approval decisions made in the current session, keyed by
   * approvalId. The daemon is authoritative; this only avoids UI flicker
   * while /approvals refetches after a decision POST.
   */
  decisions: Record<string, "approved" | "denied">;
}

export type AppAction =
  | { type: "set-route"; route: Route }
  | { type: "set-mission"; missionId: string | null }
  | { type: "set-token-manual"; token: string }
  | { type: "set-token-from-fragment"; token: string; scope: Scope }
  | { type: "clear-token" }
  | { type: "set-pill"; pill: ConnectionPill }
  | { type: "set-last-status"; status: BridgeStatus | null }
  | { type: "decide-approval"; approvalId: string; decision: "approved" | "denied" };

// Pure reducer (gemini PR J1 review): NO side effects (no sessionStorage,
// no history.replaceState, no fetch). Side effects live in the action-
// dispatching helpers below. This makes the reducer safe to double-invoke
// under React Strict Mode without corrupting external state.
function reducer(state: AppStateValue, action: AppAction): AppStateValue {
  switch (action.type) {
    case "set-route":
      return state.route === action.route ? state : { ...state, route: action.route };
    case "set-mission":
      return state.selectedMissionId === action.missionId
        ? state
        : { ...state, selectedMissionId: action.missionId };
    case "set-token-manual":
      return { ...state, token: action.token, scope: "unknown" };
    case "set-token-from-fragment":
      return { ...state, token: action.token, scope: action.scope };
    case "clear-token":
      return { ...state, token: null, scope: "unknown" };
    case "set-pill":
      return { ...state, pill: action.pill };
    case "set-last-status":
      return { ...state, lastStatus: action.status };
    case "decide-approval":
      return {
        ...state,
        decisions: { ...state.decisions, [action.approvalId]: action.decision },
      };
    default:
      return state;
  }
}

// Pure initializer — only reads from sessionStorage / URL fragment. The
// side-effecting commit (sessionStorage WRITE + URL fragment strip)
// happens in a useEffect below so Strict Mode double-invocation doesn't
// double-write or double-strip.
function makeInitialState(): AppStateValue {
  const boot = bootstrapAuth();
  return {
    token: boot.token,
    scope: boot.scope,
    route: boot.route,
    selectedMissionId: null,
    pill: { state: "unknown", label: "Checking…" },
    lastStatus: null,
    decisions: {},
  };
}

interface AppStateContextValue {
  state: AppStateValue;
  dispatch: (action: AppAction) => void;
  // Convenience helpers — encapsulate the {dispatch, action-object} dance
  // for the common operations so call sites read like a normal API.
  setRoute: (route: Route) => void;
  openMission: (missionId: string) => void;
  setToken: (token: string) => void;
  clearToken: () => void;
  setPill: (pill: ConnectionPill) => void;
  setLastStatus: (status: BridgeStatus | null) => void;
  decideApproval: (approvalId: string, decision: "approved" | "denied") => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState);

  // One-shot side effect for the bootstrap (URL-fragment commit:
  // sessionStorage write + history.replaceState). Runs after mount. Both
  // sessionStorage and replaceState are idempotent in our usage, so it's
  // safe under Strict Mode's double-mount in dev.
  useEffect(() => {
    commitBootstrap(bootstrapAuth());
    // Intentionally empty deps — bootstrap runs once.
  }, []);

  const setRoute = useCallback((route: Route) => dispatch({ type: "set-route", route }), []);
  const openMission = useCallback((missionId: string) => {
    dispatch({ type: "set-mission", missionId });
    dispatch({ type: "set-route", route: "mission" });
    // Codex K1 should-fix: also update the URL hash so refresh/back/
    // bookmark all go back to the same mission. We encode as
    // `#/mission/<id>` — useHashRoute knows to parse that into both
    // route="mission" AND selectedMissionId=<id> on reload.
    if (typeof window !== "undefined") {
      window.location.hash = `#/mission/${missionId}`;
    }
  }, []);
  // Side effect (sessionStorage write) happens in the callback, NOT in
  // the reducer (gemini PR J1 review). Same for clearToken below.
  const setToken = useCallback((token: string) => {
    persistManualToken(token);
    dispatch({ type: "set-token-manual", token });
  }, []);
  const clearToken = useCallback(() => {
    clearStoredAuth();
    dispatch({ type: "clear-token" });
  }, []);
  const setPill = useCallback((pill: ConnectionPill) => dispatch({ type: "set-pill", pill }), []);
  const setLastStatus = useCallback(
    (status: BridgeStatus | null) => dispatch({ type: "set-last-status", status }),
    []
  );
  const decideApproval = useCallback(
    (approvalId: string, decision: "approved" | "denied") =>
      dispatch({ type: "decide-approval", approvalId, decision }),
    []
  );

  const value = useMemo<AppStateContextValue>(
    () => ({
      state,
      dispatch,
      setRoute,
      openMission,
      setToken,
      clearToken,
      setPill,
      setLastStatus,
      decideApproval,
    }),
    [
      state,
      setRoute,
      openMission,
      setToken,
      clearToken,
      setPill,
      setLastStatus,
      decideApproval,
    ]
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

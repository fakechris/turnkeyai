import { useEffect } from "react";

import { useAppState } from "../state/AppState";
import { DEFAULT_ROUTE, parseFragment } from "../state/tokenBootstrap";

/**
 * Listens to window.hashchange and keeps AppState.route in sync.
 *
 * The fragment can carry:
 *   - route (every page)
 *   - missionId (K1: `#/mission/<id>` deep links)
 *   - token + scope (handled at bootstrap, stripped from the URL before
 *     useHashRoute runs in normal flow)
 *
 * When parsed route="mission" comes back with a missionId, push it
 * through `set-mission` so the renderer picks up the right detail. When
 * the user navigates AWAY from a mission via the sidebar, we leave
 * selectedMissionId alone (the user might come back to it).
 */
export function useHashRoute() {
  const { setRoute, dispatch } = useAppState();

  useEffect(() => {
    function syncFromHash() {
      const fragment = parseFragment(window.location.hash);
      setRoute(fragment.route ?? DEFAULT_ROUTE);
      if (fragment.route === "mission" && fragment.missionId) {
        dispatch({ type: "set-mission", missionId: fragment.missionId });
      }
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [setRoute, dispatch]);
}

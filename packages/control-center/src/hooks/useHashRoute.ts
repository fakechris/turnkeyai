import { useEffect } from "react";

import { useAppState } from "../state/AppState";
import { DEFAULT_ROUTE, parseFragment } from "../state/tokenBootstrap";

/**
 * Listens to window.hashchange and keeps AppState.route in sync.
 *
 * The fragment shape is { token?, scope?, route? }. We only use `route`
 * here — token + scope are handled at bootstrap (see tokenBootstrap.ts)
 * because they should never appear in a post-bootstrap hash change in
 * normal use; the bootstrap strips them.
 */
export function useHashRoute() {
  const { setRoute } = useAppState();

  useEffect(() => {
    function syncFromHash() {
      const { route } = parseFragment(window.location.hash);
      setRoute(route ?? DEFAULT_ROUTE);
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [setRoute]);
}

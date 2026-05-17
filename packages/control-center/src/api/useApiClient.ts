import { useMemo, useRef } from "react";

import { useAppState } from "../state/AppState";
import { createApiClient } from "./client";

/**
 * Hook that returns a memoized API client wired to the current app state.
 *
 * Returns a stable object reference per-render (the client itself is
 * pure-functional; it reads `state.token` via getToken() on each call).
 * The unauthorized handler clears the token + stops polling — the
 * polling-stop is driven by the polling epoch counter in usePolling.
 */
export function useApiClient() {
  const { state, clearToken } = useAppState();
  // Keep a ref to the latest token so getToken closes over a stable ref
  // (avoids re-creating the client on every render).
  const tokenRef = useRef(state.token);
  tokenRef.current = state.token;

  return useMemo(
    () =>
      createApiClient({
        getToken: () => tokenRef.current,
        onUnauthorized: () => {
          clearToken();
        },
      }),
    [clearToken]
  );
}

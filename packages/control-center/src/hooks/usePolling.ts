import { useEffect, useRef } from "react";

/**
 * Recursive-setTimeout polling with an epoch counter. Each call to the
 * hook starts a new polling loop; the previous loop's in-flight tick will
 * see the epoch mismatch in its `.finally()` and skip its reschedule.
 *
 * This is the React port of the PR I (codex re-review #2) pattern from
 * vanilla app.js. Same invariants:
 *   1. Next tick is only scheduled AFTER the previous tick's renderer
 *      promise settles. No overlapping in-flight fetches.
 *   2. Route changes (unmounts) bump the epoch first, then clear the
 *      timer. Old ticks resolving after unmount discover the mismatch
 *      and bail out.
 *   3. The renderer can throw — we swallow because the caller owns its
 *      own error UI (e.g. unauthorized => apiClient already handled).
 *
 * `renderer` is captured at mount time and held in a ref so callers can
 * pass an inline arrow without restarting the loop on every render. To
 * force a restart, change `intervalMs` (rarely needed).
 */
export function usePolling(renderer: () => Promise<void>, intervalMs: number) {
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;

  useEffect(() => {
    let epoch = 0;
    const myEpoch = ++epoch;
    let timer: number | null = null;
    let cancelled = false;

    const tick = () => {
      void rendererRef
        .current()
        .catch(() => {
          // Renderer-owned error display; swallow so the loop continues.
        })
        .finally(() => {
          if (!cancelled && epoch === myEpoch) {
            timer = window.setTimeout(tick, intervalMs);
          }
        });
    };

    // First call is immediate, not deferred — pages should not render an
    // empty state for a whole interval before the first fetch lands.
    tick();

    return () => {
      cancelled = true;
      epoch += 1;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
  }, [intervalMs]);
}

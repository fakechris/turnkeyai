// Mission Control data hooks (PR K2 swap).
//
// Each hook does ONE fetch on mount + on token change, returns the
// most recent successful value, and falls back to a caller-supplied
// default while loading or when the fetch fails. The fallback pattern
// keeps the K1 visual rhythm intact: pages render against MOCK_DATA
// when the daemon hasn't been bootstrapped yet, and seamlessly swap
// to live data once /missions returns content.
//
// Bootstrap helper: callers can also invoke `bootstrapDemoMissions`
// imperatively (from the Missions page's "load demo" button) to POST
// /missions/bootstrap-demo and refetch — this is what an operator does
// on first launch to populate the daemon with the design fixtures.

import { useCallback, useEffect, useRef, useState } from "react";

import { useApiClient } from "./useApiClient";
import type {
  ActivityEvent,
  Agent,
  ApprovalRow,
  BootstrapDemoResult,
  ContextSource,
  Mission,
  WorkItem,
} from "./mission-api";

export interface RemoteData<T> {
  /** Most recent successful value, or the fallback while loading/failed. */
  value: T;
  /** True after the first successful fetch (vs serving the fallback). */
  isLive: boolean;
  /** Last error message, if the most recent fetch failed. */
  error: string | null;
  /** Trigger a re-fetch. */
  refetch: () => void;
}

function useRemote<T>(
  pathname: string,
  fallback: T,
  options: { dependsOn?: ReadonlyArray<unknown> } = {}
): RemoteData<T> {
  const client = useApiClient();
  const [value, setValue] = useState<T>(fallback);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchEpoch, setRefetchEpoch] = useState(0);

  // Keep the most-recent fallback in a ref so re-renders that change
  // it don't force-refetch. (Fallbacks are large static module imports
  // — passing them through deps would re-trigger.)
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deps = options.dependsOn ? [...options.dependsOn] : [];

  useEffect(() => {
    let cancelled = false;
    void client
      .get<T>(pathname)
      .then((data) => {
        if (cancelled) return;
        setValue(data);
        setIsLive(true);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // Unauthorized is handled by the API client (clears token,
        // routes to no-token page). Don't surface it as an inline
        // error here.
        if (err.message !== "unauthorized") {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pathname, refetchEpoch, ...deps]);

  const refetch = useCallback(() => setRefetchEpoch((n) => n + 1), []);
  return { value, isLive, error, refetch };
}

export function useMissions(fallback: Mission[]): RemoteData<Mission[]> {
  return useRemote<Mission[]>("/missions", fallback);
}

export function useMission(missionId: string | null, fallback: Mission | null): RemoteData<Mission | null> {
  // When missionId is null we don't fetch; just return the fallback as
  // an isLive=false RemoteData so the page can rely on `value` always
  // being defined-or-null in a known way.
  const path = missionId ? `/missions/${encodeURIComponent(missionId)}` : null;
  const client = useApiClient();
  const [value, setValue] = useState<Mission | null>(fallback);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!path) {
      setValue(fallback);
      setIsLive(false);
      return;
    }
    let cancelled = false;
    void client
      .get<Mission>(path)
      .then((data) => {
        if (cancelled) return;
        setValue(data);
        setIsLive(true);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err.message !== "unauthorized") setError(err.message);
      });
    return () => {
      cancelled = true;
    };
    // fallback is intentionally not a dep — caller passes a stable
    // mock; we don't want to refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, path, epoch]);

  return { value, isLive, error, refetch: () => setEpoch((n) => n + 1) };
}

export function useWorkItems(missionId: string, fallback: WorkItem[]): RemoteData<WorkItem[]> {
  return useRemote<WorkItem[]>(
    `/missions/${encodeURIComponent(missionId)}/work-items`,
    fallback,
    { dependsOn: [missionId] }
  );
}

export function useTimeline(missionId: string, fallback: ActivityEvent[], limit = 200): RemoteData<ActivityEvent[]> {
  return useRemote<ActivityEvent[]>(
    `/missions/${encodeURIComponent(missionId)}/timeline?limit=${limit}`,
    fallback,
    { dependsOn: [missionId, limit] }
  );
}

export function useApprovals(fallback: ApprovalRow[]): RemoteData<ApprovalRow[]> {
  return useRemote<ApprovalRow[]>("/approvals", fallback);
}

export function useAgents(fallback: Agent[]): RemoteData<Agent[]> {
  return useRemote<Agent[]>("/mission-agents", fallback);
}

export function useContextSources(fallback: ContextSource[]): RemoteData<ContextSource[]> {
  return useRemote<ContextSource[]>("/mission-context-sources", fallback);
}

/**
 * Imperatively populate the daemon with the design's fixture missions.
 * Returns a stable function the caller can invoke from a button click.
 * Throws on error — caller decides whether to retry / show a toast.
 */
export function useBootstrapDemo(): () => Promise<BootstrapDemoResult> {
  const client = useApiClient();
  return useCallback(
    () => client.post<BootstrapDemoResult>("/missions/bootstrap-demo"),
    [client]
  );
}

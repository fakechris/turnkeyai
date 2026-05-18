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
  Artifact,
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
  options: { dependsOn?: ReadonlyArray<unknown>; pollIntervalMs?: number } = {}
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
    // First fetch resets to fallback so a hook-key change (e.g. switching
    // mission ids) doesn't render stale data while the new request is
    // in flight (CodeRabbit K2 review). Subsequent poll-driven refetches
    // do NOT reset — that would cause a visible flicker every interval.
    setValue(fallbackRef.current);
    setIsLive(false);
    setError(null);

    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const issueFetch = (resetBefore: boolean) => {
      if (resetBefore) {
        setValue(fallbackRef.current);
        setIsLive(false);
        setError(null);
      }
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
    };

    issueFetch(false);
    if (options.pollIntervalMs && options.pollIntervalMs > 0) {
      pollTimer = setInterval(() => issueFetch(false), options.pollIntervalMs);
    }
    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, pathname, refetchEpoch, options.pollIntervalMs, ...deps]);

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
      // Clear stale error from a prior mission so navigating back to
      // the missions list doesn't keep showing the previous error
      // banner (CodeRabbit K2 review).
      setError(null);
      return;
    }
    let cancelled = false;
    // Reset to fallback before issuing the new request so a mission ID
    // change (e.g. opening msn.02 after msn.01) doesn't briefly render
    // msn.01's data (CodeRabbit K2 review).
    setValue(fallback);
    setIsLive(false);
    setError(null);
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

export function useTimeline(
  missionId: string,
  fallback: ActivityEvent[],
  options: { limit?: number; pollIntervalMs?: number } = {}
): RemoteData<ActivityEvent[]> {
  const limit = options.limit ?? 200;
  // K3.5: default to 2s polling so new assistant/tool replies show up
  // in the timeline without forcing the user to refresh. Caller can
  // disable by passing pollIntervalMs: 0.
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  return useRemote<ActivityEvent[]>(
    `/missions/${encodeURIComponent(missionId)}/timeline?limit=${limit}`,
    fallback,
    { dependsOn: [missionId, limit], pollIntervalMs }
  );
}

export function useApprovals(fallback: ApprovalRow[]): RemoteData<ApprovalRow[]> {
  return useRemote<ApprovalRow[]>("/approvals", fallback);
}

export function useArtifacts(missionId: string, fallback: Artifact[]): RemoteData<Artifact[]> {
  return useRemote<Artifact[]>(
    `/missions/${encodeURIComponent(missionId)}/artifacts`,
    fallback,
    { dependsOn: [missionId] }
  );
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

export interface CreateMissionInput {
  title: string;
  desc: string;
  mode?: string;
}

/**
 * Create a new mission (K3.5). The daemon spawns a linked team-runtime
 * thread atomically — the returned Mission carries `threadId` and is
 * already in `working` status. Callers should navigate to Mission
 * Detail after success; the timeline will start populating within the
 * 2-second bridge tick (sooner — the route ticks synchronously after
 * the initial user message).
 */
export function useCreateMission(): (input: CreateMissionInput) => Promise<Mission> {
  const client = useApiClient();
  return useCallback(
    (input: CreateMissionInput) =>
      client.post<Mission>("/missions", {
        title: input.title,
        desc: input.desc,
        ...(input.mode ? { mode: input.mode } : {}),
      }),
    [client]
  );
}

/**
 * Send a follow-up message to a mission's linked thread (K3.5).
 * Resolves when the daemon has accepted the message (it returns 202
 * without waiting for the agents to reply). The timeline will pick up
 * the agent response on its next poll tick.
 */
export function useSendMissionMessage(): (input: {
  missionId: string;
  content: string;
}) => Promise<void> {
  const client = useApiClient();
  return useCallback(
    async (input: { missionId: string; content: string }) => {
      await client.post(`/missions/${encodeURIComponent(input.missionId)}/messages`, {
        content: input.content,
      });
    },
    [client]
  );
}

import type {
  BrowserSession,
  BrowserSessionHistoryEntry,
} from "@turnkeyai/core-types/team";

export interface BrowserRuntimeHealthSnapshot {
  inspectedSessionCount: number;
  recentHistoryCount: number;
  recentFailureCount: number;
  profileFallbackCount: number;
  latestFailureSummary?: string;
  latestProfileFallback?: {
    browserSessionId: string;
    completedAt: number;
    fallbackDir: string;
  };
}

export interface BrowserRuntimeHealthSnapshotInput {
  sessions: BrowserSession[];
  loadHistory(input: { browserSessionId: string; limit: number }): Promise<BrowserSessionHistoryEntry[]>;
  historyLimitPerSession?: number;
  inspectedSessionLimit?: number;
}

const DEFAULT_INSPECTED_SESSION_LIMIT = 25;
const DEFAULT_HISTORY_LIMIT_PER_SESSION = 5;

export async function buildBrowserRuntimeHealthSnapshot(
  input: BrowserRuntimeHealthSnapshotInput
): Promise<BrowserRuntimeHealthSnapshot> {
  const inspectedSessions = [...input.sessions]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, input.inspectedSessionLimit ?? DEFAULT_INSPECTED_SESSION_LIMIT);
  const histories = (
    await Promise.all(
      inspectedSessions.map((session) =>
        input.loadHistory({
          browserSessionId: session.browserSessionId,
          limit: input.historyLimitPerSession ?? DEFAULT_HISTORY_LIMIT_PER_SESSION,
        }).catch(() => [])
      )
    )
  )
    .flat()
    .sort((left, right) => right.completedAt - left.completedAt);

  const latestCleanSuccessAt = histories.find((entry) => entry.status === "completed" && !entry.profileFallback)
    ?.completedAt ?? 0;
  const recentFailures = histories.filter(
    (entry) => entry.status === "failed" && entry.completedAt > latestCleanSuccessAt
  );
  const profileFallbacks = histories.filter(
    (entry) => entry.profileFallback && entry.completedAt > latestCleanSuccessAt
  );
  const latestProfileFallback = profileFallbacks[0];

  return {
    inspectedSessionCount: inspectedSessions.length,
    recentHistoryCount: histories.length,
    recentFailureCount: recentFailures.length,
    profileFallbackCount: profileFallbacks.length,
    ...(recentFailures[0]?.summary ? { latestFailureSummary: recentFailures[0].summary } : {}),
    ...(latestProfileFallback?.profileFallback
      ? {
          latestProfileFallback: {
            browserSessionId: latestProfileFallback.browserSessionId,
            completedAt: latestProfileFallback.completedAt,
            fallbackDir: latestProfileFallback.profileFallback.fallbackDir,
          },
        }
      : {}),
  };
}

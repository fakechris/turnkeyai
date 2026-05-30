import assert from "node:assert/strict";
import test from "node:test";

import type {
  BrowserSession,
  BrowserSessionHistoryEntry,
} from "@turnkeyai/core-types/team";
import { buildBrowserRuntimeHealthSnapshot } from "./browser-runtime-health";

test("browser runtime health treats newer clean success as recovery from older failures", async () => {
  const snapshot = await buildBrowserRuntimeHealthSnapshot({
    sessions: [session("browser-session-1", 3_000)],
    loadHistory: async () => [
      history("failed-1", "browser-session-1", "failed", 1_000, {
        summary: "Browser spawn failed: page.goto timed out.",
      }),
      history("ok-1", "browser-session-1", "completed", 2_000),
    ],
  });

  assert.equal(snapshot.recentHistoryCount, 2);
  assert.equal(snapshot.recentFailureCount, 0);
  assert.equal(snapshot.latestFailureSummary, undefined);
});

test("browser runtime health surfaces failures newer than the latest clean success", async () => {
  const snapshot = await buildBrowserRuntimeHealthSnapshot({
    sessions: [session("browser-session-1", 3_000)],
    loadHistory: async () => [
      history("ok-1", "browser-session-1", "completed", 1_000),
      history("failed-1", "browser-session-1", "failed", 2_000, {
        summary: "Browser send failed: target closed.",
      }),
    ],
  });

  assert.equal(snapshot.recentFailureCount, 1);
  assert.equal(snapshot.latestFailureSummary, "Browser send failed: target closed.");
});

test("browser runtime health clears old profile fallback after a newer clean success", async () => {
  const snapshot = await buildBrowserRuntimeHealthSnapshot({
    sessions: [session("browser-session-1", 3_000)],
    loadHistory: async () => [
      history("fallback-1", "browser-session-1", "completed", 1_000, {
        profileFallback: {
          reason: "profile_locked",
          persistentDir: "/profiles/main",
          fallbackDir: "/profiles/fallback",
        },
      }),
      history("ok-1", "browser-session-1", "completed", 2_000),
    ],
  });

  assert.equal(snapshot.profileFallbackCount, 0);
  assert.equal(snapshot.latestProfileFallback, undefined);
});

test("browser runtime health keeps latest profile fallback actionable until a clean success follows", async () => {
  const snapshot = await buildBrowserRuntimeHealthSnapshot({
    sessions: [session("browser-session-1", 3_000)],
    loadHistory: async () => [
      history("ok-1", "browser-session-1", "completed", 1_000),
      history("fallback-1", "browser-session-1", "completed", 2_000, {
        profileFallback: {
          reason: "profile_locked",
          persistentDir: "/profiles/main",
          fallbackDir: "/profiles/fallback",
        },
      }),
    ],
  });

  assert.equal(snapshot.profileFallbackCount, 1);
  assert.deepEqual(snapshot.latestProfileFallback, {
    browserSessionId: "browser-session-1",
    completedAt: 2_000,
    fallbackDir: "/profiles/fallback",
  });
});

function session(browserSessionId: string, updatedAt: number): BrowserSession {
  return {
    browserSessionId,
    ownerType: "thread",
    ownerId: "thread-1",
    profileId: "profile-1",
    transportMode: "local",
    status: "ready",
    createdAt: 1,
    updatedAt,
    lastActiveAt: updatedAt,
    targetIds: [],
  };
}

function history(
  entryId: string,
  browserSessionId: string,
  status: BrowserSessionHistoryEntry["status"],
  completedAt: number,
  extra: Partial<BrowserSessionHistoryEntry> = {}
): BrowserSessionHistoryEntry {
  return {
    entryId,
    browserSessionId,
    dispatchMode: "spawn",
    threadId: "thread-1",
    taskId: "task-1",
    ownerType: "thread",
    ownerId: "thread-1",
    historyCursor: completedAt - 100,
    startedAt: completedAt - 100,
    completedAt,
    status,
    actionKinds: ["open"],
    instructions: "Open the page.",
    summary: status === "completed" ? "Browser task completed." : "Browser task failed.",
    ...extra,
  };
}

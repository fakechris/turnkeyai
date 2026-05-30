import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ActivityEvent,
  Mission,
  MissionObservabilitySnapshot,
  RoleRunState,
  WorkerSessionRecord,
} from "../api/mission-api";
import { buildMissionProgressNow } from "./missionProgress";

describe("buildMissionProgressNow", () => {
  it("prioritizes stale runtime over terminal-looking mission state", () => {
    const progress = buildMissionProgressNow({
      mission: mission({ status: "done" }),
      metrics: metrics({ stale: 1 }),
      timeline: [event("ev.final", "thought", 5000, "role-lead", "Final answer")],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(progress.title, "Runtime stale");
    assert.equal(progress.tone, "danger");
    assert.match(progress.detail, /overdue/);
  });

  it("shows active tool progress while work is still running", () => {
    const progress = buildMissionProgressNow({
      mission: mission({ status: "working" }),
      metrics: metrics({ active: 1, waiting: 1 }),
      timeline: [
        event("ev.call", "tool", 1000, "role-lead", "Spawn browser worker.", {
          toolName: "sessions_spawn",
          toolPhase: "call",
        }),
        event("ev.progress", "tool", 2000, "role-lead", "Browser worker opened context.", {
          toolName: "sessions_spawn",
          toolPhase: "progress",
        }),
      ],
      roleRuns: [roleRun({ status: "running" })],
      workerSessions: [workerSession({ status: "running" })],
    });

    assert.equal(progress.title, "Working");
    assert.equal(progress.tone, "warning");
    assert.match(progress.detail, /sessions_spawn progress/);
    assert.deepEqual(progress.meta.slice(0, 2), ["1 active role", "1 active session"]);
    assert.equal(progress.latestTool?.name, "sessions_spawn");
    assert.equal(progress.latestTool?.phase, "progress");
  });

  it("keeps completed missions visible as done with last replay event", () => {
    const progress = buildMissionProgressNow({
      mission: mission({ status: "done" }),
      metrics: metrics({ qualityStatus: "passed" }),
      timeline: [event("ev.final", "thought", 5000, "role-lead", "Final answer with residual risk.")],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(progress.title, "Done");
    assert.equal(progress.tone, "ok");
    assert.equal(progress.latestEvent?.label, "thought · role-lead");
    assert.match(progress.detail, /Last event was thought/);
  });
});

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "msn.progress.1",
    shortId: "P1",
    title: "Progress mission",
    desc: "Mission progress test.",
    status: "working",
    mode: "research",
    modeLabel: "Research",
    owner: "operator",
    ownerLabel: "Operator",
    createdAt: "2026-05-31 01:00",
    createdAtMs: 1_780_160_400_000,
    agents: ["role-lead"],
    progress: 50,
    pendingApprovals: 0,
    blockers: 0,
    contextSummary: [],
    threadId: "thread.progress.1",
    ...overrides,
  };
}

function metrics(
  overrides: Partial<{
    active: number;
    waiting: number;
    stale: number;
    qualityStatus: MissionObservabilitySnapshot["qualityGate"]["status"];
  }> = {}
): MissionObservabilitySnapshot {
  return {
    missionId: "msn.progress.1",
    status: "working",
    generatedAtMs: 1_780_160_405_000,
    wallClockMs: 5000,
    timelineEventCount: 2,
    tool: {
      requested: 1,
      results: 0,
      executed: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0,
      timeouts: 0,
    },
    sessions: {
      spawned: 1,
      continued: 0,
    },
    browser: {
      profileFallbacks: 0,
    },
    approvals: {
      requested: 0,
      applied: 0,
      decided: 0,
    },
    recovery: {
      events: 0,
    },
    liveness: {
      active: overrides.active ?? 0,
      waiting: overrides.waiting ?? 0,
      stale: overrides.stale ?? 0,
      lastProgressAtMs: 1_780_160_405_000,
      staleSubjects:
        (overrides.stale ?? 0) > 0
          ? [{ subjectKind: "worker", subjectId: "wrk.1", summary: "No heartbeat", overdueMs: 60_000 }]
          : [],
    },
    qualityGate: {
      status: overrides.qualityStatus ?? "running",
      evidenceEvents: 1,
      checks: [],
    },
  };
}

function event(
  id: string,
  kind: ActivityEvent["kind"],
  tMs: number,
  actor: string,
  text: string,
  runtime?: Record<string, string>
): ActivityEvent {
  return {
    id,
    missionId: "msn.progress.1",
    t: "01:00",
    tMs,
    kind,
    actor,
    text,
    ...(runtime ? { runtime } : {}),
  };
}

function roleRun(overrides: Partial<RoleRunState> = {}): RoleRunState {
  return {
    runKey: "run.role.1",
    threadId: "thread.progress.1",
    roleId: "role-lead",
    mode: "group",
    status: "running",
    iterationCount: 1,
    maxIterations: 32,
    inbox: [],
    lastActiveAt: 1_780_160_405_000,
    ...overrides,
  };
}

function workerSession(overrides: Partial<WorkerSessionRecord["state"]> = {}): WorkerSessionRecord {
  return {
    workerRunKey: "wrk.1",
    executionToken: 1,
    state: {
      workerRunKey: "wrk.1",
      workerType: "browser",
      status: "running",
      createdAt: 1_780_160_401_000,
      updatedAt: 1_780_160_405_000,
      ...overrides,
    },
  };
}

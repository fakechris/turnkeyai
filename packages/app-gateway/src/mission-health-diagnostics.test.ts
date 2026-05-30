import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityEvent, Mission } from "@turnkeyai/core-types/mission";
import type { RuntimeProgressEvent } from "@turnkeyai/core-types/team";

import { buildDiagnosticsMissionHealthSnapshot } from "./mission-health-diagnostics";

test("buildDiagnosticsMissionHealthSnapshot aggregates mission quality, liveness, and attention", async () => {
  const nowMs = 30_000;
  const missions = [
    mission("msn.active", "Active research", "working", 1_000, { threadId: "thread.active" }),
    mission("msn.approval", "Needs approval", "needs_approval", 2_000, { pendingApprovals: 1 }),
    mission("msn.done", "Completed brief", "done", 3_000),
  ];
  const activity = new Map<string, ActivityEvent[]>([
    [
      "msn.active",
      [
        event("ev.active.user", "plan", 1_000, "user", "Research it."),
        tool("ev.active.call", 2_000, "call", "sessions_spawn", "call.active", "Calling sessions_spawn."),
        {
          ...tool("ev.active.fail", 4_000, "result", "sessions_spawn", "call.active", "sessions_spawn timed out."),
          emph: "danger" as const,
        },
      ],
    ],
    [
      "msn.approval",
      [
        event("ev.approval", "approval", 2_500, "role-lead", "permission.query requested approval"),
      ],
    ],
    [
      "msn.done",
      [
        event("ev.done.doc", "doc", 3_100, "role-lead", "Evidence gathered."),
        event("ev.done.final", "thought", 3_500, "role-lead", "Final answer with residual risk."),
      ],
    ],
  ]);
  const progress = new Map<string, RuntimeProgressEvent[]>([
    [
      "thread.active",
      [
        progressEvent({
          progressId: "progress.active",
          threadId: "thread.active",
          subjectId: "role-lead",
          phase: "heartbeat",
          summary: "Still researching",
          recordedAt: 10_000,
          responseTimeoutAt: 20_000,
        }),
      ],
    ],
  ]);

  const snapshot = await buildDiagnosticsMissionHealthSnapshot({
    missionStore: { list: async () => missions },
    activityStore: { listByMission: async (id) => activity.get(id) ?? [] },
    runtimeProgressStore: { listByThread: async (threadId) => progress.get(threadId) ?? [] },
    nowMs,
  });

  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.active, 2);
  assert.equal(snapshot.needsApproval, 1);
  assert.equal(snapshot.byStatus.working, 1);
  assert.equal(snapshot.byStatus.needs_approval, 1);
  assert.equal(snapshot.qualityGate.blocked, 1);
  assert.equal(snapshot.qualityGate.running, 1);
  assert.equal(snapshot.qualityGate.passed, 1);
  assert.equal(snapshot.tool.failed, 1);
  assert.equal(snapshot.tool.timeouts, 1);
  assert.equal(snapshot.sessions.spawned, 1);
  assert.equal(snapshot.liveness.stale, 1);
  assert.equal(snapshot.snapshotErrorCount, 0);
  assert.equal(snapshot.attentionMissions[0]?.id, "msn.active");
  assert.equal(snapshot.attentionMissions.some((item) => item.id === "msn.approval"), true);
});

test("buildDiagnosticsMissionHealthSnapshot keeps diagnostics alive when one mission snapshot fails", async () => {
  const missions = [
    mission("msn.broken", "Broken store row", "working", 1_000),
    mission("msn.done", "Completed", "done", 2_000),
  ];
  const snapshot = await buildDiagnosticsMissionHealthSnapshot({
    missionStore: { list: async () => missions },
    activityStore: {
      listByMission: async (id) => {
        if (id === "msn.broken") throw new Error("activity store unavailable");
        return [event("ev.final", "thought", 2_500, "role-lead", "Final answer with residual risk.")];
      },
    },
    nowMs: 3_000,
  });

  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.inspected, 2);
  assert.equal(snapshot.snapshotErrorCount, 1);
  assert.equal(snapshot.byStatus.working, 1);
});

function mission(
  id: string,
  title: string,
  status: Mission["status"],
  createdAtMs: number,
  overrides: Partial<Mission> = {}
): Mission {
  return {
    id,
    shortId: id.toUpperCase(),
    title,
    desc: title,
    status,
    mode: "research",
    modeLabel: "Research",
    owner: "user",
    ownerLabel: "User",
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    agents: ["role-lead"],
    progress: status === "done" ? 1 : 0.5,
    pendingApprovals: 0,
    blockers: 0,
    contextSummary: [],
    ...overrides,
  };
}

function event(
  id: string,
  kind: ActivityEvent["kind"],
  tMs: number,
  actor: string,
  text: string
): ActivityEvent {
  return {
    id,
    missionId: "msn.test",
    kind,
    tMs,
    actor,
    text,
  };
}

function tool(
  id: string,
  tMs: number,
  phase: "call" | "result",
  name: string,
  toolCallId: string,
  text: string
): ActivityEvent {
  return {
    ...event(id, "tool", tMs, "role-lead", text),
    runtime: {
      toolPhase: phase,
      toolName: name,
      toolCallId,
      route: "lead-role",
    },
  };
}

function progressEvent(input: {
  progressId: string;
  threadId: string;
  subjectId: string;
  phase: RuntimeProgressEvent["phase"];
  summary: string;
  recordedAt: number;
  responseTimeoutAt?: number;
}): RuntimeProgressEvent {
  return {
    progressId: input.progressId,
    threadId: input.threadId,
    subjectKind: "role_run",
    subjectId: input.subjectId,
    phase: input.phase,
    continuityState: "alive",
    summary: input.summary,
    recordedAt: input.recordedAt,
    ...(input.responseTimeoutAt !== undefined ? { responseTimeoutAt: input.responseTimeoutAt } : {}),
  };
}

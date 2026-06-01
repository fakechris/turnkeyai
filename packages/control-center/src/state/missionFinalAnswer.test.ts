import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityEvent, Mission, MissionObservabilitySnapshot } from "../api/mission-api";
import { selectMissionFinalAnswer } from "./missionFinalAnswer";

test("selectMissionFinalAnswer ignores a prior answer after a follow-up user plan", () => {
  const prior = event("thought.prior", "thought", 2_000, "role-lead", "Initial answer.");
  const selected = selectMissionFinalAnswer({
    mission: mission(),
    metrics: metrics({ finalAnswerEventId: prior.id }),
    events: [
      event("plan.initial", "plan", 1_000, "user", "Compare the sources."),
      prior,
      event("plan.followup", "plan", 3_000, "user", "Now check the follow-up detail."),
    ],
  });

  assert.equal(selected, null);
});

test("selectMissionFinalAnswer ignores a prior answer after later tool activity", () => {
  const prior = event("thought.prior", "thought", 2_000, "role-lead", "Initial answer.");
  const selected = selectMissionFinalAnswer({
    mission: mission(),
    metrics: metrics({ finalAnswerEventId: prior.id }),
    events: [
      event("plan.initial", "plan", 1_000, "user", "Compare the sources."),
      tool("tool.call", 1_500, "call", "sessions_spawn", "call-1", "Spawned worker."),
      tool("tool.result", 1_900, "result", "sessions_spawn", "call-1", "Worker returned evidence."),
      prior,
      tool("tool.call.followup", 3_000, "call", "sessions_send", "call-2", "Continue worker."),
    ],
  });

  assert.equal(selected, null);
});

test("selectMissionFinalAnswer trusts terminal backend metrics despite later diagnostic tool activity", () => {
  const final = event("thought.final", "thought", 2_000, "role-lead", "Terminal answer.");
  const selected = selectMissionFinalAnswer({
    mission: mission({ status: "done", progress: 1 }),
    metrics: metrics({ status: "done", finalAnswerEventId: final.id }),
    events: [
      event("plan.initial", "plan", 1_000, "user", "Compare the sources."),
      tool("tool.call", 1_500, "call", "sessions_spawn", "call-1", "Spawned worker."),
      tool("tool.result", 1_900, "result", "sessions_spawn", "call-1", "Worker returned evidence."),
      final,
      tool("tool.active", 3_000, "call", "sessions_send", "call-active", "Operator-visible active tool."),
    ],
  });

  assert.equal(selected?.id, final.id);
});

test("selectMissionFinalAnswer still ignores terminal metrics after a user follow-up", () => {
  const final = event("thought.final", "thought", 2_000, "role-lead", "Terminal answer.");
  const selected = selectMissionFinalAnswer({
    mission: mission({ status: "done", progress: 1 }),
    metrics: metrics({ status: "done", finalAnswerEventId: final.id }),
    events: [
      event("plan.initial", "plan", 1_000, "user", "Compare the sources."),
      final,
      event("plan.followup", "plan", 3_000, "user", "Continue this mission."),
    ],
  });

  assert.equal(selected, null);
});

test("selectMissionFinalAnswer uses the backend final-answer event when it is current", () => {
  const stale = event("thought.stale", "thought", 2_000, "role-lead", "Older answer.");
  const current = event("thought.current", "thought", 4_000, "role-lead", "Current answer.");
  const selected = selectMissionFinalAnswer({
    mission: mission(),
    metrics: metrics({ finalAnswerEventId: current.id }),
    events: [
      event("plan.initial", "plan", 1_000, "user", "Compare the sources."),
      stale,
      event("plan.followup", "plan", 3_000, "user", "Use the existing evidence for a follow-up."),
      current,
    ],
  });

  assert.equal(selected?.id, current.id);
});

test("selectMissionFinalAnswer falls back to the latest current lead answer", () => {
  const selected = selectMissionFinalAnswer({
    mission: mission({ agents: ["role-research-lead"] }),
    metrics: null,
    events: [
      event("plan.followup", "plan", 1_000, "user", "Summarize current evidence."),
      event("thought.worker", "thought", 1_500, "worker-browser", "Worker note."),
      event("thought.current", "thought", 2_000, "role-research-lead", "Lead answer."),
    ],
  });

  assert.equal(selected?.id, "thought.current");
});

test("selectMissionFinalAnswer fallback ignores a lead answer before a pending tool result", () => {
  const selected = selectMissionFinalAnswer({
    mission: mission({ status: "done", progress: 1 }),
    metrics: null,
    events: [
      event("plan.initial", "plan", 1_000, "user", "Check the browser page."),
      tool("tool.call", 2_000, "call", "sessions_spawn", "call-1", "Calling sessions_spawn."),
      event("thought.early", "thought", 3_000, "role-lead", "Early final answer before the tool result."),
    ],
  });

  assert.equal(selected, null);
});

test("selectMissionFinalAnswer fallback accepts a lead answer after prior tool results", () => {
  const selected = selectMissionFinalAnswer({
    mission: mission({ status: "done", progress: 1 }),
    metrics: null,
    events: [
      event("plan.initial", "plan", 1_000, "user", "Check the browser page."),
      tool("tool.call", 2_000, "call", "sessions_spawn", "call-1", "Calling sessions_spawn."),
      tool("tool.result", 3_000, "result", "sessions_spawn", "call-1", "Browser evidence returned."),
      event("thought.final", "thought", 4_000, "role-lead", "Final answer after the tool result."),
    ],
  });

  assert.equal(selected?.id, "thought.final");
});

test("selectMissionFinalAnswer fallback scans every tool call before the answer", () => {
  const selected = selectMissionFinalAnswer({
    mission: mission({ status: "done", progress: 1 }),
    metrics: null,
    events: [
      event("plan.initial", "plan", 1_000, "user", "Check two sources."),
      tool("tool.call.one", 2_000, "call", "sessions_spawn", "call-1", "Calling first worker."),
      tool("tool.result.one", 3_000, "result", "sessions_spawn", "call-1", "First worker returned."),
      tool("tool.call.two", 4_000, "call", "sessions_spawn", "call-2", "Calling second worker."),
      event("thought.early", "thought", 5_000, "role-lead", "Early final answer before the second result."),
    ],
  });

  assert.equal(selected, null);
});

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "msn.final.1",
    shortId: "F1",
    title: "Final answer selection",
    desc: "Final answer selection test.",
    status: "working",
    mode: "research",
    modeLabel: "Research",
    owner: "operator",
    ownerLabel: "Operator",
    createdAt: "2026-06-01 10:00",
    createdAtMs: 1_780_214_400_000,
    agents: ["role-lead"],
    progress: 0.5,
    pendingApprovals: 0,
    blockers: 0,
    contextSummary: [],
    threadId: "thread.final.1",
    ...overrides,
  };
}

function metrics(overrides: { status?: MissionObservabilitySnapshot["status"]; finalAnswerEventId?: string } = {}): MissionObservabilitySnapshot {
  return {
    missionId: "msn.final.1",
    status: overrides.status ?? "working",
    generatedAtMs: 1_780_214_405_000,
    wallClockMs: 5_000,
    timelineEventCount: 1,
    tool: {
      requested: 0,
      results: 0,
      executed: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0,
      timeouts: 0,
    },
    sessions: {
      spawned: 0,
      continued: 0,
    },
    browser: {
      profileFallbacks: 0,
      failureBuckets: [],
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
      active: 0,
      waiting: 0,
      stale: 0,
      staleSubjects: [],
    },
    qualityGate: {
      status: "running",
      evidenceEvents: 0,
      checks: [],
      ...(overrides.finalAnswerEventId ? { finalAnswerEventId: overrides.finalAnswerEventId } : {}),
    },
  };
}

function event(
  id: string,
  kind: ActivityEvent["kind"],
  tMs: number,
  actor: string,
  text: string,
  runtime: Record<string, string> = {}
): ActivityEvent {
  return {
    id,
    missionId: "msn.final.1",
    t: "",
    tMs,
    kind,
    actor,
    text,
    ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
  };
}

function tool(
  id: string,
  tMs: number,
  phase: "call" | "result",
  toolName: string,
  toolCallId: string,
  text: string
): ActivityEvent {
  return event(id, "tool", tMs, "role-lead", text, {
    toolPhase: phase,
    toolName,
    toolCallId,
  });
}

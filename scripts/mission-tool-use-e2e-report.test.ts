import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMissionE2eJsonReport,
  summarizeMissionScenarioResult,
  type MissionScenarioResult,
} from "./mission-tool-use-e2e";

describe("mission tool-use e2e report", () => {
  it("summarizes mission scenario evidence without final-answer text", () => {
    const summary = summarizeMissionScenarioResult(fakeResult());

    assert.deepEqual(summary, {
      scenario: "realistic-brief",
      missionId: "msn.report.1",
      status: "done",
      threadId: "thread.report.1",
      timelineEvents: 3,
      toolEvents: 2,
      qualityGate: "passed",
      metrics: {
        tools: {
          requested: 2,
          results: 2,
          failed: 0,
          cancelled: 0,
          timeouts: 0,
        },
        sessions: {
          spawned: 2,
          continued: 1,
        },
        approvals: {
          requested: 1,
          decided: 1,
          applied: 1,
        },
        liveness: {
          active: 0,
          waiting: 0,
          stale: 0,
        },
        evidenceEvents: 2,
        recoveryEvents: 0,
      },
      final: {
        bytes: 69,
        bullets: 2,
        qualityFailures: [],
      },
    });
  });

  it("builds a durable report envelope for acceptance evidence", () => {
    const report = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [fakeResult()],
    });

    assert.equal(report.kind, "turnkeyai.mission-e2e.report");
    assert.equal(report.status, "passed");
    assert.equal(report.startedAt, "2026-05-30T12:00:00.000Z");
    assert.equal(report.completedAt, "2026-05-30T12:00:03.000Z");
    assert.equal(report.durationMs, 3000);
    assert.equal(report.scenarios.length, 1);
    assert.equal(report.scenarios[0]?.missionId, "msn.report.1");
  });

  it("marks the report failed when a summarized scenario is not passing", () => {
    const result = fakeResult();
    result.mission.status = "blocked";

    const report = buildMissionE2eJsonReport({
      startedAt: Date.UTC(2026, 4, 30, 12, 0, 0),
      completedAt: Date.UTC(2026, 4, 30, 12, 0, 3),
      results: [result],
    });

    assert.equal(report.status, "failed");
  });
});

function fakeResult(): MissionScenarioResult {
  return {
    scenario: "realistic-brief",
    mission: {
      id: "msn.report.1",
      status: "done",
      threadId: "thread.report.1",
    },
    timeline: [
      { kind: "tool", text: "call", tMs: 1000, runtime: { toolPhase: "call" } },
      { kind: "tool", text: "result", tMs: 2000, runtime: { toolPhase: "result" } },
      { kind: "thought", text: "- one\n- two", tMs: 3000 },
    ],
    metrics: {
      status: "done",
      tool: {
        requested: 2,
        results: 2,
        failed: 0,
        cancelled: 0,
        timeouts: 0,
      },
      sessions: {
        spawned: 2,
        continued: 1,
      },
      approvals: {
        requested: 1,
        applied: 1,
        decided: 1,
      },
      recovery: {
        events: 0,
      },
      liveness: {
        active: 0,
        waiting: 0,
        stale: 0,
      },
      qualityGate: {
        status: "passed",
        evidenceEvents: 2,
      },
    },
    final: {
      kind: "thought",
      text: "- one evidence bullet\n- two evidence bullet with residual risk marker",
      tMs: 3000,
    },
    quality: {
      bullets: 2,
      failures: [],
    },
  };
}

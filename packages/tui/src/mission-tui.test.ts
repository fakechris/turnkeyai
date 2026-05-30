import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ActivityEvent, Mission } from "@turnkeyai/core-types/mission";

import {
  buildMissionCreatePayload,
  formatMissionDetail,
  formatMissionList,
  parseMissionSendArgs,
  parseMissionNewArgs,
  type TuiMissionMetrics,
} from "./mission-tui";

describe("mission-tui", () => {
  it("parses mission-new args with an explicit title separator", () => {
    assert.deepEqual(parseMissionNewArgs("Pricing sweep :: Compare the three vendor pages"), {
      title: "Pricing sweep",
      desc: "Compare the three vendor pages",
    });
    assert.equal(parseMissionNewArgs("Bad title ::   "), null);
  });

  it("builds a mission creation payload with safe defaults", () => {
    assert.deepEqual(buildMissionCreatePayload("Investigate slow checkout"), {
      title: "Investigate slow checkout",
      desc: "Investigate slow checkout",
      mode: "custom",
      modeLabel: "Custom",
      owner: "you",
      ownerLabel: "You",
    });
  });

  it("parses mission-send args with explicit or current mission ids", () => {
    assert.deepEqual(parseMissionSendArgs("msn.abc.1 continue with more evidence", null), {
      missionId: "msn.abc.1",
      content: "continue with more evidence",
    });
    assert.deepEqual(parseMissionSendArgs("continue from here", "msn.current.1"), {
      missionId: "msn.current.1",
      content: "continue from here",
    });
    assert.equal(parseMissionSendArgs("continue from here", null), null);
    assert.equal(parseMissionSendArgs("msn.only", null), null);
  });

  it("formats mission lists newest first with thread and progress context", () => {
    const lines = formatMissionList(
      [
        mission({ id: "msn.old", shortId: "MSN-1", title: "Old", createdAtMs: 1000, progress: 0.25 }),
        mission({
          id: "msn.new",
          shortId: "MSN-2",
          title: "New",
          createdAtMs: 2000,
          progress: 0.75,
          threadId: "thread.1",
        }),
      ],
      10
    );

    assert.match(lines.join("\n"), /^Missions: 2\n- MSN-2 msn\.new \[working\] New/m);
    assert.match(lines.join("\n"), /progress=75% thread=thread\.1/);
  });

  it("formats mission detail with quality attention, final answer, and timeline ordering", () => {
    const lines = formatMissionDetail({
      mission: mission({ id: "msn.detail", shortId: "MSN-9", title: "Detail", progress: 1, status: "done" }),
      metrics: metrics({
        missionId: "msn.detail",
        qualityGate: {
          status: "needs_attention",
          evidenceEvents: 1,
          checks: [
            { name: "final_answer", status: "pass", detail: "final answer exists" },
            { name: "tool_fallback_answer", status: "warn", detail: "answer fell back to model knowledge" },
          ],
        },
      }),
      timeline: [
        event({ id: "ev.2", tMs: 2000, kind: "thought", actor: "role-lead", text: "<b>Final</b> answer" }),
        event({ id: "ev.1", tMs: 1000, kind: "tool", actor: "role-lead", text: "tool call" }),
      ],
    });

    const output = lines.join("\n");
    assert.match(output, /quality=needs_attention/);
    assert.match(output, /tool_fallback_answer \[warn\]: answer fell back to model knowledge/);
    assert.match(output, /Latest final answer:\n  Final answer/);
    assert.match(output, /Recent timeline \(2 of 2\):\n- .* tool\/role-lead: tool call\n- .* thought\/role-lead: Final answer/);
  });
});

function mission(overrides: Partial<Mission>): Mission {
  return {
    id: "msn.test",
    shortId: "MSN-T",
    title: "Test mission",
    desc: "Test mission desc",
    status: "working",
    mode: "custom",
    modeLabel: "Custom",
    owner: "you",
    ownerLabel: "You",
    createdAt: "1970-01-01T00:00:00.000Z",
    createdAtMs: 0,
    agents: [],
    progress: 0,
    pendingApprovals: 0,
    blockers: 0,
    contextSummary: [],
    ...overrides,
  };
}

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: "ev.test",
    missionId: "msn.detail",
    tMs: 0,
    kind: "thought",
    actor: "role-lead",
    text: "event",
    ...overrides,
  };
}

function metrics(overrides: Partial<TuiMissionMetrics>): TuiMissionMetrics {
  return {
    missionId: "msn.test",
    status: "working",
    wallClockMs: 0,
    timelineEventCount: 0,
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
    },
    qualityGate: {
      status: "running",
      evidenceEvents: 0,
      checks: [],
    },
    ...overrides,
  };
}

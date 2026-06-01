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

  it("formats malformed mission list payloads as empty instead of throwing", () => {
    assert.deepEqual(formatMissionList({ not: "an array" } as unknown as Mission[]), [
      "Missions: 0",
      "  no missions found",
    ]);
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

  it("does not surface a final answer before a pending tool result", () => {
    const lines = formatMissionDetail({
      mission: mission({ id: "msn.pending", shortId: "MSN-P", title: "Pending", status: "working" }),
      metrics: metrics({
        missionId: "msn.pending",
        qualityGate: {
          status: "blocked",
          finalAnswerEventId: "ev.final",
          evidenceEvents: 0,
          checks: [{ name: "final_answer", status: "fail", detail: "waiting for tool result" }],
        },
      }),
      timeline: [
        event({ id: "ev.user", tMs: 500, kind: "plan", actor: "user", text: "Compare the dashboard sources." }),
        event({
          id: "ev.call",
          tMs: 1000,
          kind: "tool",
          actor: "role-lead",
          text: "tool call",
          runtime: { toolPhase: "call", toolCallId: "call-1" },
        }),
        event({
          id: "ev.final",
          tMs: 1500,
          kind: "thought",
          actor: "role-lead",
          text: "Premature final answer before evidence.",
        }),
      ],
    });

    const output = lines.join("\n");
    assert.doesNotMatch(output, /Latest final answer:/);
    assert.match(output, /final_answer \[fail\]: waiting for tool result/);
    assert.match(output, /thought\/role-lead: Premature final answer before evidence\./);
  });

  it("surfaces a final answer after all prior tool calls have results", () => {
    const lines = formatMissionDetail({
      mission: mission({ id: "msn.resolved", shortId: "MSN-R", title: "Resolved", status: "done" }),
      metrics: metrics({
        missionId: "msn.resolved",
        status: "done",
        qualityGate: {
          status: "passed",
          finalAnswerEventId: "ev.final",
          evidenceEvents: 1,
          checks: [{ name: "final_answer", status: "pass", detail: "final answer exists" }],
        },
      }),
      timeline: [
        event({ id: "ev.user", tMs: 500, kind: "plan", actor: "user", text: "Compare the dashboard sources." }),
        event({
          id: "ev.call",
          tMs: 1000,
          kind: "tool",
          actor: "role-lead",
          text: "tool call",
          runtime: { toolPhase: "call", toolCallId: "call-1" },
        }),
        event({
          id: "ev.result",
          tMs: 1500,
          kind: "tool",
          actor: "role-lead",
          text: "tool result",
          runtime: { toolPhase: "result", toolCallId: "call-1" },
        }),
        event({
          id: "ev.final",
          tMs: 2000,
          kind: "thought",
          actor: "role-lead",
          text: "Final answer after evidence.",
        }),
      ],
    });

    assert.match(lines.join("\n"), /Latest final answer:\n  Final answer after evidence\./);
  });

  it("formats browser recovery buckets and profile fallback context in mission detail", () => {
    const lines = formatMissionDetail({
      mission: mission({ id: "msn.browser", shortId: "MSN-B", title: "Browser mission" }),
      metrics: metrics({
        browser: {
          profileFallbacks: 1,
          latestProfileFallback: {
            sessionId: "browser.session.1",
            fallbackDir: "/tmp/turnkeyai-profile",
          },
          failureBuckets: [
            { bucket: "session_not_found", count: 1, latestAtMs: 1000 },
            { bucket: "browser_cdp_unavailable", count: 2, latestAtMs: 2000 },
          ],
        },
      }),
      timeline: [],
    });

    const output = lines.join("\n");
    assert.match(output, /browser profileFallbacks=1 failureBuckets=2/);
    assert.match(output, /Browser attention:/);
    assert.match(output, /Browser CDP unavailable \(browser_cdp_unavailable\): 2 at 1970-01-01T00:00:02.000Z/);
    assert.match(output, /Browser session unavailable \(session_not_found\): 1 at 1970-01-01T00:00:01.000Z/);
    assert.match(output, /latest profile fallback: session=browser\.session\.1 dir=\/tmp\/turnkeyai-profile/);
  });

  it("sanitizes browser-provided terminal text before formatting mission detail", () => {
    const lines = formatMissionDetail({
      mission: mission({ id: "msn.browser-safe", shortId: "MSN-BS", title: "Browser safe mission" }),
      metrics: metrics({
        browser: {
          profileFallbacks: 0,
          latestProfileFallback: {
            sessionId: "session\n\x1B[31mred\x1B[0m",
            fallbackDir: "/tmp/profile\rspoof",
          },
          failureBuckets: [{ bucket: "custom_bucket\n\x1B[31m", count: 1, latestAtMs: 1000 }],
        },
      }),
      timeline: [],
    });

    const output = lines.join("\n");
    assert.match(output, /Browser attention:/);
    assert.match(output, /Custom bucket \(custom_bucket\): 1 at 1970-01-01T00:00:01.000Z/);
    assert.match(output, /latest profile fallback: session=session red dir=\/tmp\/profile spoof/);
    assert.doesNotMatch(output, /\x1B|\r/);
  });

  it("formats malformed mission metrics and events with safe defaults", () => {
    const lines = formatMissionDetail({
      mission: mission({ id: "msn.safe", shortId: "MSN-S", title: "Safe", createdAtMs: Number.MAX_VALUE }),
      metrics: {
        wallClockMs: Number.NaN,
        tool: { requested: -1 },
        browser: {
          profileFallbacks: -1,
          latestProfileFallback: { sessionId: "", fallbackDir: "" },
          failureBuckets: [
            { bucket: "", count: 2, latestAtMs: 1000 },
            { bucket: "cdp_command_timeout", count: -1, latestAtMs: 1000 },
            { bucket: "bad", count: "2", latestAtMs: 1000 } as unknown as TuiMissionMetrics["browser"]["failureBuckets"][number],
          ],
        },
        qualityGate: {
          status: "not-real" as unknown as TuiMissionMetrics["qualityGate"]["status"],
          checks: [{ name: "bad", status: "bad" as "pass", detail: "ignored" }],
        },
      },
      timeline: [{ bad: true } as unknown as ActivityEvent],
    });

    const output = lines.join("\n");
    assert.match(output, /quality=running/);
    assert.match(output, /wallClock=0ms events=0 evidence=0/);
    assert.match(output, /tools requested\/results\/executed\/failed\/timeouts=0\/0\/0\/0\/0/);
    assert.match(output, /browser profileFallbacks=0 failureBuckets=0/);
    assert.doesNotMatch(output, /Browser attention:/);
    assert.match(output, /Recent timeline \(0 of 0\):\n  no timeline events/);
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
    browser: {
      profileFallbacks: 0,
      failureBuckets: [],
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

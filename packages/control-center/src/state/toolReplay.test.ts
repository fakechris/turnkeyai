import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityEvent } from "../api/mission-api";
import { formatDurationMs, groupTimelineForReplay } from "./toolReplay";

test("groupTimelineForReplay collapses tool chain plus final thought into one process item", () => {
  const events: ActivityEvent[] = [
    event("user-1", "plan", 1_000, "user", "Start"),
    tool("call-1", 2_000, "role-lead", "call", "sessions_spawn", "call-browser", "Tool call"),
    tool("progress-1", 2_500, "role-lead", "progress", "sessions_spawn", "call-browser", "Working"),
    tool("result-1", 4_250, "role-lead", "result", "sessions_spawn", "call-browser", "Returned"),
    event("thought-1", "thought", 5_000, "role-lead", "Final answer"),
    event("approval-1", "approval", 6_000, "operator", "Approved"),
  ];

  const grouped = groupTimelineForReplay(events);

  assert.equal(grouped.length, 3);
  assert.equal(grouped[0]?.kind, "event");
  assert.equal(grouped[1]?.kind, "tool-process");
  if (grouped[1]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.equal(grouped[1].actor, "role-lead");
  assert.equal(grouped[1].status, "completed");
  assert.equal(grouped[1].toolEvents.length, 3);
  assert.deepEqual(grouped[1].processEvents, []);
  assert.equal(grouped[1].finalThought?.id, "thought-1");
  assert.equal(formatDurationMs(grouped[1].startMs, grouped[1].endMs), "3.0s");
  assert.equal(grouped[2]?.kind, "event");
});

test("groupTimelineForReplay keeps failed tool process visible without a final thought", () => {
  const grouped = groupTimelineForReplay([
    tool("call-1", 1_000, "role-lead", "call", "sessions_spawn", "call-browser", "Tool call"),
    {
      ...tool("result-1", 1_500, "role-lead", "result", "sessions_spawn", "call-browser", "Tool failed"),
      emph: "danger",
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.equal(grouped[0].status, "failed");
  assert.equal(grouped[0].finalThought, undefined);
});

test("groupTimelineForReplay keeps one tool process when approval events interleave", () => {
  const events: ActivityEvent[] = [
    toolWithMessage("call-1", 1_000, "role-lead", "call", "sessions_spawn", "call-browser", "Tool call", "msg-1", "1"),
    {
      ...event("approval-1", "approval", 1_200, "operator", "Approved"),
      approvalId: "ap.1",
    },
    toolWithMessage("progress-1", 1_500, "role-lead", "progress", "sessions_spawn", "call-browser", "Applied", "msg-1", "1"),
    toolWithMessage("result-1", 2_000, "role-lead", "result", "sessions_spawn", "call-browser", "Returned", "msg-1", "1"),
    event("thought-1", "thought", 2_500, "role-lead", "Final answer"),
  ];

  const grouped = groupTimelineForReplay(events);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.deepEqual(grouped[0].toolEvents.map((item) => item.id), ["call-1", "progress-1", "result-1"]);
  assert.deepEqual(grouped[0].processEvents.map((item) => item.id), ["approval-1"]);
  assert.equal(grouped[0].finalThought?.id, "thought-1");
});

test("groupTimelineForReplay scopes process events to the correct round before final thought", () => {
  const events: ActivityEvent[] = [
    toolWithMessage("r1-call", 1_000, "role-lead", "call", "sessions_spawn", "call-browser", "r1 call", "msg-1", "1"),
    {
      ...event("r1-approval", "approval", 1_100, "operator", "approve r1"),
      approvalId: "ap.r1",
    },
    toolWithMessage("r1-result", 1_300, "role-lead", "result", "sessions_spawn", "call-browser", "r1 result", "msg-1", "1"),
    toolWithMessage("r2-call", 1_500, "role-lead", "call", "web_search", "call-web", "r2 call", "msg-1", "2"),
    {
      ...event("r2-approval", "approval", 1_600, "operator", "approve r2"),
      approvalId: "ap.r2",
    },
    toolWithMessage("r2-result", 1_900, "role-lead", "result", "web_search", "call-web", "r2 result", "msg-1", "2"),
    event("thought-1", "thought", 2_200, "role-lead", "Final answer"),
  ];

  const grouped = groupTimelineForReplay(events).filter(
    (item): item is Extract<ReturnType<typeof groupTimelineForReplay>[number], { kind: "tool-process" }> =>
      item.kind === "tool-process"
  );

  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0]?.toolEvents.map((item) => item.id), ["r1-call", "r1-result"]);
  assert.deepEqual(grouped[0]?.processEvents.map((item) => item.id), ["r1-approval"]);
  assert.equal(grouped[0]?.finalThought, undefined);
  assert.deepEqual(grouped[1]?.toolEvents.map((item) => item.id), ["r2-call", "r2-result"]);
  assert.deepEqual(grouped[1]?.processEvents.map((item) => item.id), ["r2-approval"]);
  assert.equal(grouped[1]?.finalThought?.id, "thought-1");
});

test("groupTimelineForReplay keeps recovery events inside the process they interrupt", () => {
  const events: ActivityEvent[] = [
    toolWithMessage("call-1", 1_000, "role-lead", "call", "sessions_spawn", "call-browser", "Tool call", "msg-1", "1"),
    {
      ...event("recovery-1", "recovery", 1_200, "runtime", "Sub-agent timeout surfaced."),
      emph: "danger" as const,
    },
    toolWithMessage("result-1", 2_000, "role-lead", "result", "sessions_spawn", "call-browser", "Timeout result", "msg-1", "1"),
  ];

  const grouped = groupTimelineForReplay(events);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.deepEqual(grouped[0].processEvents.map((item) => item.id), ["recovery-1"]);
  assert.equal(grouped[0].status, "failed");
});

test("groupTimelineForReplay treats recovery events as failed even without explicit danger emphasis", () => {
  const events: ActivityEvent[] = [
    toolWithMessage("call-1", 1_000, "role-lead", "call", "sessions_spawn", "call-browser", "Tool call", "msg-1", "1"),
    event("recovery-1", "recovery", 1_200, "runtime", "Sub-agent timeout surfaced."),
    toolWithMessage("result-1", 2_000, "role-lead", "result", "sessions_spawn", "call-browser", "Timeout result", "msg-1", "1"),
  ];

  const grouped = groupTimelineForReplay(events);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.deepEqual(grouped[0].processEvents.map((item) => item.id), ["recovery-1"]);
  assert.equal(grouped[0].status, "failed");
});

test("groupTimelineForReplay does not fail a process for budget-skipped tool calls", () => {
  const skippedCall = toolWithMessage("call-1", 1_000, "role-lead", "call", "sessions_spawn", "call-a", "Tool call", "msg-1", "1");
  const skippedResult = toolWithMessage("result-1", 1_100, "role-lead", "result", "sessions_spawn", "call-a", "Skipped", "msg-1", "1");
  const events: ActivityEvent[] = [
    {
      ...skippedCall,
      runtime: {
        ...skippedCall.runtime,
        admission: "skipped",
      },
    },
    {
      ...skippedResult,
      runtime: {
        ...skippedResult.runtime,
        admission: "skipped",
      },
      emph: "danger" as const,
    },
  ];

  const grouped = groupTimelineForReplay(events);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.equal(grouped[0].status, "completed");
});

test("groupTimelineForReplay completes a process with skipped plus successful tool results", () => {
  const skippedResult = toolWithAdmission(
    "result-skipped",
    1_100,
    "role-lead",
    "result",
    "sessions_spawn",
    "call-skipped",
    "Skipped",
    "msg-1",
    "1",
    "skipped"
  );
  const successfulResult = toolWithMessage(
    "result-success",
    1_500,
    "role-lead",
    "result",
    "sessions_send",
    "call-success",
    "Returned evidence",
    "msg-1",
    "1"
  );

  const grouped = groupTimelineForReplay([
    toolWithAdmission(
      "call-skipped",
      1_000,
      "role-lead",
      "call",
      "sessions_spawn",
      "call-skipped",
      "Tool call",
      "msg-1",
      "1",
      "skipped"
    ),
    {
      ...skippedResult,
      emph: "danger" as const,
    },
    toolWithMessage(
      "call-success",
      1_200,
      "role-lead",
      "call",
      "sessions_send",
      "call-success",
      "Tool call",
      "msg-1",
      "1"
    ),
    successfulResult,
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.equal(grouped[0].status, "completed");
});

test("groupTimelineForReplay still fails a process with a real failed result after skipped calls", () => {
  const failedResult = toolWithMessage(
    "result-failed",
    1_500,
    "role-lead",
    "result",
    "sessions_send",
    "call-failed",
    "Worker failed",
    "msg-1",
    "1"
  );

  const grouped = groupTimelineForReplay([
    toolWithAdmission(
      "call-skipped",
      1_000,
      "role-lead",
      "call",
      "sessions_spawn",
      "call-skipped",
      "Tool call",
      "msg-1",
      "1",
      "skipped"
    ),
    toolWithAdmission(
      "result-skipped",
      1_100,
      "role-lead",
      "result",
      "sessions_spawn",
      "call-skipped",
      "Skipped",
      "msg-1",
      "1",
      "skipped"
    ),
    toolWithMessage(
      "call-failed",
      1_200,
      "role-lead",
      "call",
      "sessions_send",
      "call-failed",
      "Tool call",
      "msg-1",
      "1"
    ),
    {
      ...failedResult,
      emph: "danger" as const,
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.equal(grouped[0].status, "failed");
});

test("groupTimelineForReplay completes skipped-only process without danger emphasis", () => {
  const grouped = groupTimelineForReplay([
    toolWithAdmission(
      "call-skipped",
      1_000,
      "role-lead",
      "call",
      "sessions_spawn",
      "call-skipped",
      "Tool call",
      "msg-1",
      "1",
      "skipped"
    ),
    toolWithAdmission(
      "result-skipped",
      1_100,
      "role-lead",
      "result",
      "sessions_spawn",
      "call-skipped",
      "Skipped",
      "msg-1",
      "1",
      "skipped"
    ),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.kind, "tool-process");
  if (grouped[0]?.kind !== "tool-process") {
    throw new Error("expected tool-process");
  }
  assert.equal(grouped[0].status, "completed");
});

test("formatDurationMs normalizes rounded second rollover into minutes", () => {
  assert.equal(formatDurationMs(0, 119_900), "2m");
});

function tool(
  id: string,
  tMs: number,
  actor: string,
  phase: "call" | "progress" | "result",
  toolName: string,
  toolCallId: string,
  text: string
): ActivityEvent {
  return {
    ...event(id, "tool", tMs, actor, text),
    runtime: {
      toolPhase: phase,
      toolName,
      toolCallId,
    },
  };
}

function toolWithMessage(
  id: string,
  tMs: number,
  actor: string,
  phase: "call" | "progress" | "result",
  toolName: string,
  toolCallId: string,
  text: string,
  messageId: string,
  round: string
): ActivityEvent {
  return {
    ...tool(id, tMs, actor, phase, toolName, toolCallId, text),
    runtime: {
      toolPhase: phase,
      toolName,
      toolCallId,
      messageId,
      round,
    },
  };
}

function toolWithAdmission(
  id: string,
  tMs: number,
  actor: string,
  phase: "call" | "progress" | "result",
  toolName: string,
  toolCallId: string,
  text: string,
  messageId: string,
  round: string,
  admission: "admitted" | "skipped"
): ActivityEvent {
  const item = toolWithMessage(id, tMs, actor, phase, toolName, toolCallId, text, messageId, round);
  return {
    ...item,
    runtime: {
      ...item.runtime,
      admission,
    },
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
    t: "",
    tMs,
    kind,
    actor,
    text,
  };
}

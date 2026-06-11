import assert from "node:assert/strict";
import test from "node:test";

import {
  createRelayPayload,
  getDispatchGoal,
  MAX_DISPATCH_GOAL_CHARS,
  normalizeRelayPayload,
  resolveDispatchGoal,
  toDispatchGoalMessage,
} from "./team";
import type { TeamMessage, TeamMessageSummary } from "./team";

function userMessage(id: string, content: string, createdAt: number): Pick<TeamMessage, "id" | "role" | "content" | "createdAt"> {
  return { id, role: "user", content, createdAt };
}

function summary(id: string, role: TeamMessageSummary["role"], content: string, createdAt: number): TeamMessageSummary {
  return { messageId: id, role, name: role, content, createdAt };
}

test("toDispatchGoalMessage preserves long content verbatim under the cap", () => {
  const content = "A".repeat(3_000);
  const goal = toDispatchGoalMessage({ id: "m1", content });
  assert.equal(goal.content, content);
  assert.equal(goal.truncated, undefined);
});

test("toDispatchGoalMessage marks truncation explicitly at the cap", () => {
  const content = "B".repeat(MAX_DISPATCH_GOAL_CHARS + 500);
  const goal = toDispatchGoalMessage({ id: "m1", content });
  assert.equal(goal.content.length, MAX_DISPATCH_GOAL_CHARS);
  assert.equal(goal.truncated, true);
});

test("resolveDispatchGoal uses a user root message as the origin", () => {
  const longGoal = `Research vendors and produce a table with columns: name, pricing, SSO support, SLA, citations. ${"x".repeat(400)}`;
  const goal = resolveDispatchGoal({
    rootMessage: userMessage("root", longGoal, 1),
    sourceMessage: userMessage("root", longGoal, 1),
    threadMessages: [summary("root", "user", longGoal, 1)],
  });
  assert.ok(goal);
  assert.equal(goal.origin.messageId, "root");
  assert.equal(goal.origin.content, longGoal);
  assert.equal(goal.latestDirection, undefined);
});

test("resolveDispatchGoal carries both origin and latest user direction", () => {
  const goal = resolveDispatchGoal({
    rootMessage: userMessage("root", "Original long task spec", 1),
    sourceMessage: null,
    threadMessages: [
      summary("root", "user", "Original long task spec", 1),
      summary("a1", "assistant", "working on it", 2),
      summary("u2", "user", "Also include the EU region", 3),
    ],
  });
  assert.ok(goal);
  assert.equal(goal.origin.messageId, "root");
  assert.equal(goal.latestDirection?.messageId, "u2");
  assert.equal(goal.latestDirection?.content, "Also include the EU region");
});

test("resolveDispatchGoal falls back to earliest visible user message for synthetic roots", () => {
  // Scheduled/recovery flows have a system root message; the thread's own
  // user request must still be the goal.
  const goal = resolveDispatchGoal({
    rootMessage: { id: "sched", role: "system", content: "Recovery plan for group-1", createdAt: 10 },
    sourceMessage: { id: "sched", role: "system", content: "Recovery plan for group-1", createdAt: 10 },
    threadMessages: [
      summary("u1", "user", "Compare vendor alpha and beta with evidence", 1),
      summary("a1", "assistant", "ok", 2),
      summary("u2", "user", "Prefer the official docs", 3),
    ],
  });
  assert.ok(goal);
  assert.equal(goal.origin.messageId, "u1");
  assert.equal(goal.latestDirection?.messageId, "u2");
});

test("resolveDispatchGoal anchors follow-up posts on the thread's earliest user message", () => {
  // Every user post starts a new flow whose root is the NEW post; the
  // original mission goal must still be the origin anchor.
  const followUp = userMessage("u9", "Quick follow-up: only keep vendors with EU hosting", 9);
  const goal = resolveDispatchGoal({
    rootMessage: followUp,
    sourceMessage: followUp,
    threadMessages: [
      summary("u1", "user", "Original mission goal with full table requirements", 1),
      summary("a1", "assistant", "in progress", 2),
      summary("u9", "user", "Quick follow-up: only keep vendors with EU hosting", 9),
    ],
  });
  assert.ok(goal);
  assert.equal(goal.origin.messageId, "u1");
  assert.equal(goal.origin.content, "Original mission goal with full table requirements");
  assert.equal(goal.latestDirection?.messageId, "u9");
});

test("resolveDispatchGoal returns undefined for machine-only threads", () => {
  const goal = resolveDispatchGoal({
    rootMessage: { id: "sched", role: "system", content: "scheduled", createdAt: 1 },
    sourceMessage: null,
    threadMessages: [summary("a1", "assistant", "hello", 2)],
  });
  assert.equal(goal, undefined);
});

test("resolveDispatchGoal ignores empty user messages", () => {
  const goal = resolveDispatchGoal({
    rootMessage: { id: "u0", role: "user", content: "   ", createdAt: 1 },
    sourceMessage: null,
    threadMessages: [summary("u1", "user", "Real goal", 2)],
  });
  assert.ok(goal);
  assert.equal(goal.origin.messageId, "u1");
});

test("relay payload carries the dispatch goal through normalize/create/get", () => {
  const payload = createRelayPayload({
    threadId: "thread-1",
    relayBrief: "brief",
    recentMessages: [],
    goal: {
      origin: { messageId: "u1", content: "Full task text with table columns A|B|C" },
    },
    dispatchPolicy: {
      allowParallel: false,
      allowReenter: true,
      sourceFlowMode: "serial",
    },
  });
  assert.equal(getDispatchGoal(payload)?.origin.messageId, "u1");

  const renormalized = normalizeRelayPayload({
    ...payload,
    intent: {
      ...payload.intent!,
      relayBrief: "rebuilt brief",
    },
  });
  assert.equal(getDispatchGoal(renormalized)?.origin.content, "Full task text with table columns A|B|C");
  assert.equal(renormalized.intent?.relayBrief, "rebuilt brief");
});

test("goal alone is enough to materialize the intent envelope", () => {
  const payload = normalizeRelayPayload({
    threadId: "thread-1",
    intent: {
      relayBrief: "",
      recentMessages: [],
      goal: { origin: { messageId: "u1", content: "goal text" } },
    },
    dispatchPolicy: {
      allowParallel: false,
      allowReenter: true,
      sourceFlowMode: "serial",
    },
  });
  assert.equal(getDispatchGoal(payload)?.origin.content, "goal text");
});

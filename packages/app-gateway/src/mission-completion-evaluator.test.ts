import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Mission } from "@turnkeyai/core-types/mission";
import type { RoleRunState, TeamMessage } from "@turnkeyai/core-types/team";

import { evaluateMissionCompletion } from "./mission-completion-evaluator";

const mission: Mission = {
  id: "msn.1",
  shortId: "MSN-1",
  title: "Mission",
  desc: "",
  status: "working",
  mode: "custom",
  modeLabel: "Custom",
  owner: "you",
  ownerLabel: "You",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdAtMs: 0,
  agents: ["role-lead"],
  progress: 0.4,
  pendingApprovals: 0,
  blockers: 0,
  contextSummary: [],
  threadId: "thread-1",
};

const message = (id: string, role: TeamMessage["role"], createdAt: number): TeamMessage => ({
  id,
  threadId: "thread-1",
  role,
  name: role,
  content: "",
  createdAt,
  updatedAt: createdAt,
});

const idleRun: RoleRunState = {
  runKey: "role:role-lead:thread:thread-1",
  threadId: "thread-1",
  roleId: "role-lead",
  mode: "group",
  status: "idle",
  iterationCount: 1,
  maxIterations: 12,
  inbox: [],
  lastActiveAt: 100,
};

describe("MissionCompletionEvaluator", () => {
  it("promotes pending approval missions to needs_approval", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, pendingApprovals: 2 },
      messages: [],
      roleRuns: [],
    });
    assert.deepEqual(decision, {
      action: "update",
      reason: "pending_approval",
      patch: { status: "needs_approval" },
    });
  });

  it("marks final lead answer done", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Final answer with evidence.",
        },
      ],
      roleRuns: [],
    });
    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("blocks incomplete final answer only when no role run is active", () => {
    const incomplete = {
      ...message("a-cut", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: "Partial final answer",
      metadata: { stopReason: "max_tokens" },
    };
    const active = evaluateMissionCompletion({
      mission,
      messages: [incomplete],
      roleRuns: [{ ...idleRun, status: "running" }],
    });
    assert.deepEqual(active, { action: "none", reason: "active_role_run" });

    const idle = evaluateMissionCompletion({
      mission,
      messages: [incomplete],
      roleRuns: [idleRun],
    });
    assert.equal(idle.action, "update");
    if (idle.action === "update") {
      assert.equal(idle.reason, "incomplete_final_answer");
      assert.deepEqual(idle.patch, { status: "blocked", blockers: 1 });
      assert.equal(idle.recovery?.kind, "incomplete_final_answer");
    }
  });

  it("blocks unresolved lead tool turn when no role run is active", () => {
    const stalled = {
      ...message("a-tool", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      toolStatus: "pending" as const,
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [stalled],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "stalled_tool_turn");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
    }
  });

  it("blocks skipped lead tool turn when no final answer follows", () => {
    const skipped = {
      ...message("a-skipped", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [
        { id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } },
        { id: "call-2", name: "sessions_send", arguments: { session_key: "worker:browser:1" } },
      ],
      toolStatus: "completed" as const,
      toolProgress: [
        {
          toolCallId: "call-1",
          toolName: "sessions_spawn",
          phase: "completed" as const,
          summary: "Skipped browser spawn.",
          detail: { admission: "skipped" },
          ts: 101,
        },
        {
          toolCallId: "call-2",
          toolName: "sessions_send",
          phase: "completed" as const,
          summary: "Skipped browser follow-up.",
          detail: { admission: "skipped" },
          ts: 102,
        },
      ],
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [skipped],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "skipped_tool_turn");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
      assert.equal(decision.recovery?.status, "skipped");
    }
  });

  it("blocks a completed lead tool turn when the run idles before a final answer", () => {
    const completed = {
      ...message("a-partial", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [
        { id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } },
        { id: "call-2", name: "sessions_send", arguments: { session_key: "worker:browser:1" } },
      ],
      toolStatus: "completed" as const,
      toolProgress: [
        {
          toolCallId: "call-1",
          toolName: "sessions_spawn",
          phase: "completed" as const,
          summary: "Skipped browser spawn.",
          detail: { admission: "skipped" },
          ts: 101,
        },
        {
          toolCallId: "call-2",
          toolName: "sessions_send",
          phase: "completed" as const,
          summary: "Browser follow-up completed.",
          ts: 102,
        },
      ],
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [completed],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "completed_tool_turn");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
      assert.equal(decision.recovery?.status, "completed");
    }
  });

  it("returns stale needs_approval mission to working after approvals clear", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "needs_approval", pendingApprovals: 0 },
      messages: [],
      roleRuns: [],
    });
    assert.deepEqual(decision, {
      action: "update",
      reason: "awaiting_work",
      patch: { status: "working" },
    });
  });
});

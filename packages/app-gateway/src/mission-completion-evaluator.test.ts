import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Mission } from "@turnkeyai/core-types/mission";
import type {
  RoleRunState,
  TeamMessage,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

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

const runningWorker: WorkerSessionRecord = {
  workerRunKey: "worker:browser:1",
  executionToken: 1,
  context: {
    threadId: "thread-1",
    flowId: "flow-1",
    taskId: "task-1",
    roleId: "role-lead",
    parentSpanId: "span-1",
    toolCallId: "call-1",
  },
  state: {
    workerRunKey: "worker:browser:1",
    workerType: "browser",
    status: "running",
    createdAt: 100,
    updatedAt: 200,
  },
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

  it("does not treat prematurely done missions with pending approvals as terminal", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "done", progress: 1, pendingApprovals: 1 },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Approval pending before action.",
        },
      ],
      roleRuns: [],
    });
    assert.deepEqual(decision, {
      action: "update",
      reason: "pending_approval",
      patch: { status: "needs_approval" },
    });
  });

  it("keeps archived and draft missions terminal even if approvals remain", () => {
    for (const status of ["archived", "draft"] as const) {
      const decision = evaluateMissionCompletion({
        mission: { ...mission, status, pendingApprovals: 1 },
        messages: [],
        roleRuns: [],
      });
      assert.deepEqual(decision, { action: "none", reason: "terminal" });
    }
  });

  it("marks final lead answer done", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Please answer.",
        },
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

  it("does not reuse a prior final answer after a newer user follow-up", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Initial task.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Initial final answer.",
        },
        {
          ...message("u-2", "user", 200),
          content: "Follow up with one more check.",
        },
      ],
      roleRuns: [],
    });
    assert.deepEqual(decision, { action: "none", reason: "awaiting_work" });
  });

  it("uses message order rather than timestamps to detect stale follow-up answers", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 100),
          content: "Initial task.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Initial final answer.",
        },
        {
          ...message("u-2", "user", 100),
          content: "Follow up in the same millisecond.",
        },
      ],
      roleRuns: [],
    });
    assert.deepEqual(decision, { action: "none", reason: "awaiting_work" });
  });

  it("accepts a new final answer after the latest same-timestamp follow-up", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 100),
          content: "Initial task.",
        },
        {
          ...message("a-final-old", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Initial final answer.",
        },
        {
          ...message("u-2", "user", 100),
          content: "Follow up in the same millisecond.",
        },
        {
          ...message("a-final-new", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Follow-up final answer with evidence.",
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

  it("does not let a prior final answer hide a later stalled tool turn", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Initial task.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Initial final answer.",
        },
        {
          ...message("u-2", "user", 200),
          content: "Check the browser page again.",
        },
        {
          ...message("a-tool", "assistant", 300),
          roleId: "role-lead",
          name: "Lead",
          toolCalls: [{ id: "call-1", name: "sessions_send", arguments: { session_key: "worker:browser:1" } }],
          toolStatus: "pending" as const,
        },
      ],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "stalled_tool_turn");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
      assert.equal(decision.recovery?.status, "pending");
    }
  });

  it("does not mark done when a final answer appears before a pending tool result", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Check the browser page.",
        },
        {
          ...message("a-tool", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
          toolStatus: "pending" as const,
        },
        {
          ...message("a-final-early", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "Final answer before the browser result arrived.",
        },
      ],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "stalled_tool_turn");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
      assert.equal(decision.recovery?.status, "pending");
    }
  });

  it("accepts a final answer after a pending tool call has a linked tool result", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Check the browser page.",
        },
        {
          ...message("a-tool", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
          toolStatus: "pending" as const,
        },
        {
          ...message("tool-1", "tool", 150),
          name: "sessions_spawn",
          toolCallId: "call-1",
          content: "Browser evidence collected.",
        },
        {
          ...message("a-final", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "Final answer after browser evidence.",
        },
      ],
      roleRuns: [idleRun],
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
    assert.deepEqual(active, { action: "none", reason: "active_execution" });

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

  it("accepts complete denied approval safe closeout even when the provider reports max tokens", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Submit the local form only if approval is granted.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          metadata: { stopReason: "max_tokens" },
          content: [
            "**Approval denied - task closed safely.**",
            "Safe fallback: No form submission was or will be performed.",
            "The dry-run submission is cancelled.",
            "No further browser work is queued. Flow FLOW-1 is complete.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts complete approved approval closeout even when the provider reports max tokens", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Submit the local form only after approval.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          metadata: { stopReason: "max_tokens" },
          content: [
            "**Approved action:** browser.form.submit.",
            "The approval was granted and permission was applied for the browser form submission.",
            "The dry-run form was submitted in the browser.",
            "Evidence observed after the action confirmed the local result.",
            "The task is complete; residual risk is limited to isolated local test data with no external side effects.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("blocks approved approval closeout when the final answer says the action did not complete", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Submit the local form only after approval.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          metadata: { stopReason: "max_tokens" },
          content: [
            "**Approved action:** browser.form.submit.",
            "The approval was granted and permission was applied.",
            "The form submission was not completed because the browser action was blocked.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
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

  it("classifies failed lead tool turns with timeout evidence as timeout", () => {
    const timedOut = {
      ...message("a-timeout", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "explore" } }],
      toolStatus: "failed" as const,
      toolProgress: [
        {
          toolCallId: "call-1",
          toolName: "sessions_spawn",
          phase: "failed" as const,
          summary: "sessions_spawn timed out after 0.001s",
          ts: 101,
        },
      ],
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [timedOut],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "stalled_tool_turn");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
      assert.equal(decision.recovery?.status, "timeout");
    }
  });

  it("keeps non-timeout failed lead tool turns classified as failed", () => {
    const failed = {
      ...message("a-failed", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "explore" } }],
      toolStatus: "failed" as const,
      toolProgress: [
        {
          toolCallId: "call-1",
          toolName: "sessions_spawn",
          phase: "failed" as const,
          summary: "worker handler unavailable",
          ts: 101,
        },
      ],
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [failed],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
      assert.equal(decision.recovery?.status, "failed");
    }
  });

  it("blocks cancelled lead tool turns when no role run is active", () => {
    const cancelled = {
      ...message("a-cancelled", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      toolStatus: "cancelled" as const,
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [cancelled],
      roleRuns: [idleRun],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "stalled_tool_turn");
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
      assert.equal(decision.recovery?.status, "cancelled");
    }
  });

  it("does not block unresolved lead tool turns while a role run is active", () => {
    const stalled = {
      ...message("a-tool-active", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      toolStatus: "pending" as const,
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [stalled],
      roleRuns: [{ ...idleRun, status: "waiting_worker" }],
    });
    assert.deepEqual(decision, { action: "none", reason: "active_execution" });
  });

  it("does not block unresolved lead tool turns while a worker session is active", () => {
    const stalled = {
      ...message("a-worker-active", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      toolStatus: "pending" as const,
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [stalled],
      roleRuns: [idleRun],
      workerSessions: [runningWorker],
    });
    assert.deepEqual(decision, { action: "none", reason: "active_execution" });
  });

  it("blocks unresolved lead tool turns when the linked worker is paused for continuation", () => {
    for (const status of ["resumable", "waiting_external", "waiting_input"] as const) {
      const stalled = {
        ...message(`a-worker-${status}`, "assistant", 100),
        roleId: "role-lead",
        name: "Lead",
        toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
        toolStatus: "pending" as const,
      };
      const decision = evaluateMissionCompletion({
        mission,
        messages: [stalled],
        roleRuns: [idleRun],
        workerSessions: [
          {
            ...runningWorker,
            state: {
              ...runningWorker.state,
              status,
            },
          },
        ],
      });
      assert.equal(decision.action, "update");
      if (decision.action === "update") {
        assert.equal(decision.reason, "stalled_tool_turn");
        assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
        assert.equal(decision.recovery?.kind, "stalled_tool_turn");
        assert.equal(decision.recovery?.status, status);
      }
    }
  });

  it("treats worker session lookup failure as active to avoid premature blocking", () => {
    const stalled = {
      ...message("a-worker-unknown", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
      toolStatus: "pending" as const,
    };
    const decision = evaluateMissionCompletion({
      mission,
      messages: [stalled],
      roleRuns: [idleRun],
      workerSessions: "unknown",
    });
    assert.deepEqual(decision, { action: "none", reason: "active_execution" });
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

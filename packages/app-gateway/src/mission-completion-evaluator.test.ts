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

  it("completes pending approval wait-timeout closeouts without performing the side effect", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "needs_approval", pendingApprovals: 1 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Submit the local form only after approval.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## Wait-timeout closeout",
            "The operator decision for browser.form.submit did not arrive during this attempt cycle and the approval remains pending.",
            "No form submission or browser side effect was performed.",
            "Safe fallback: keep the dry-run unsubmitted. Next action: ask the operator to approve a new request or rerun the submission attempt when ready.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    // Terminal, but NOT goal-achieved: no fake 100% progress, and the
    // closeout is tagged so UIs can distinguish it from a real "done".
    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", pendingApprovals: 0, closeout: "approval_timeout" },
    });
  });

  it("blocks stale pending-approval final answers after approvals clear", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, pendingApprovals: 0 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Submit the local form after approval.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content:
            "**Pending operator approval.** Awaiting decision before executing the dry-run browser form submission.",
        },
      ],
      roleRuns: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "stale_pending_approval");
    }
  });

  it("does not block complete approval closeouts that mention once-approved context", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, pendingApprovals: 0 },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Once approved, the form was submitted successfully. Evidence confirms completion.",
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

  it("blocks future-tense once-you-approve final answers after approvals clear", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, pendingApprovals: 0 },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Once you approve, I will proceed with the browser action.",
        },
      ],
      roleRuns: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "stale_pending_approval");
    }
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

  it("treats literal mention placeholders in a complete closeout as final text", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Summarize the browser evidence.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content:
            "Evidence is complete, residual uncertainty is noted, and no further browser work is required. @{<role_id>}",
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

  it("does not mark a real delegation mention as a final answer", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, agents: ["role-lead", "role-browser"] },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Inspect the browser page.",
        },
        {
          ...message("a-handoff", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Please inspect the page. @{role-browser}",
        },
      ],
      roleRuns: [],
    });

    assert.notDeepEqual(decision, {
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

  it("accepts awaiting-context setup closeouts even when the provider reports max tokens", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: [
          "Start a launch-planning thread for Helios-47.",
          "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          metadata: { stopReason: "max_tokens" },
          content:
            "Helios-47 launch-planning thread is initiated and ready. Mission can resume when launch context is provided; no research is required at this stage. FLOW-1 is closed.",
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

  it("accepts concise awaiting-context setup acknowledgements", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: [
          "Start a launch-planning thread for Helios-47.",
          "No research is needed yet; briefly acknowledge that the mission can continue when launch context is available.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          metadata: { stopReason: "max_tokens" },
          content:
            "Helios-47 launch-planning thread opened. Status: awaiting launch context; the mission is ready once target date, payload specs, and priorities are available.",
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

  it("clears an existing blocker after a complete browser-unavailable closeout requested by the mission", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "blocked",
        blockers: 1,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "If the browser cannot be reached, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**Browser Unavailable - CDP Connection Refused**",
            "The browser automation layer could not establish a Chrome DevTools Protocol connection; attempts returned ECONNREFUSED.",
            "What was verified: the target dashboard URL is reachable on the local network.",
            "What remains unverified: rendered dashboard content, metrics, alerts, and operational data are not verified.",
            "Next action for operator: restart the browser automation server or open the dashboard manually and share a screenshot.",
            "Flow closed; no further automated work is possible until browser automation is restored.",
            "Browser failure buckets: browser_cdp_unavailable=4.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", blockers: 0, closeout: "bounded_failure" },
    });
  });

  it("keeps an existing blocker when browser-unavailable wording lacks a mission-authorized closeout", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "blocked",
        blockers: 1,
        desc: "Review the operations dashboard as a user would see it in the browser.",
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Browser automation was unavailable.",
            "The dashboard content is not verified.",
            "Next action: operator should restart CDP.",
            "Flow closed because browser_cdp_unavailable occurred.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, { action: "none", reason: "existing_blocker" });
  });

  it("keeps an existing blocker when browser-unavailable closeout has no verified scope", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "blocked",
        blockers: 1,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "If the browser cannot be reached, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Browser automation was unavailable due to ECONNREFUSED.",
            "The dashboard content is not verified.",
            "Next action: operator should restart CDP.",
            "Flow closed.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, { action: "none", reason: "existing_blocker" });
  });

  it("clears an existing blocker after a complete browser-timeout closeout requested by the mission", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "blocked",
        blockers: 1,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "If the browser times out while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Natural Browser CDP Timeout Closeout",
            "What was verified: Page rendered with title Operations Dashboard Fixture, screenshots captured, queue depth 11, SLA breaches 3, escalation threshold, and Incident Commander ownership.",
            "What remains unverified: DOM structure beyond the visible excerpt, interactive controls, live data polling, and below-the-fold content because CDP snapshot and scroll commands timed out.",
            "Next action for operator: treat the evidence as source-bounded to the local fixture and retry with a longer CDP timeout if full DOM structure is required.",
            "The fixture scope is limited and cannot validate real-world queue depths.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", blockers: 0, closeout: "bounded_failure" },
    });
  });

  it("clears an existing blocker after a browser-runtime root-cause closeout", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "blocked",
        blockers: 1,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "If the browser cannot be reached, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Natural Browser Unavailable Closeout",
            "What was verified: Target URL was reached by the browser worker three times; root cause identified as browser runtime infrastructure issue with ECONNREFUSED from the browser internal CDP server.",
            "The target application is not the source of the failure.",
            "What remains unverified: dashboard metrics, status indicators, rendered panels, loading states, authentication requirements, and any browser-visible content.",
            "Next action for operator: restart or repair the browser runtime, verify the dashboard server is reachable, then re-submit the review task once browser runtime is healthy.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", blockers: 0, closeout: "bounded_failure" },
    });
  });

  it("keeps an existing blocker when a timeout closeout omits the unverified scope", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "blocked",
        blockers: 1,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "If the browser times out while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "CDP timeout occurred while capturing the dashboard.",
            "What was verified: queue depth 11.",
            "Next action for operator: retry with a longer timeout.",
            "The fixture scope is limited.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, { action: "none", reason: "existing_blocker" });
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

  it("accepts denied approval safe fallback closeouts that use natural no-action wording under max tokens", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Prepare the local dry-run form submission, but do not apply it if approval is denied.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          metadata: { stopReason: "max_tokens" },
          content: [
            "**Approval denied.** The browser form submission has been cancelled. No action was performed.",
            "**Safe fallback:** The approval workflow halts cleanly. The dry-run form was never submitted.",
            "If the operator wants to proceed, the safe next action is to re-initiate with a revised action or a different scope for re-review.",
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

  it("does not treat negated failure wording as an approved approval failure", () => {
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
            "The browser form submission completed and was not blocked.",
            "Evidence observed after the action confirmed the result.",
            "The task is complete with no external side effects.",
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

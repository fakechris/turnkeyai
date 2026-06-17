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

  it("blocks final answers that claim independent researchers without delegated session evidence", () => {
    const delegatedMission: Mission = {
      ...mission,
      desc: [
        "请把这个任务交给两个独立研究员并分别取证。",
        "研究员 A 只检查 https://example.com/，研究员 B 只检查 https://www.iana.org/help/example-domains。",
        "最后再给一句话结论。",
      ].join("\n"),
    };
    const final = {
      ...message("a1", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content:
        "| 研究员 | 检查的 URL | 页面标题 | 关键原文摘录 | 关系 |\n| A | https://example.com/ | Example Domain | quote | related |\n| B | https://www.iana.org/help/example-domains | Example Domains | quote | related |\n\n**结论：** 两个页面证据一致。",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: delegatedMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.patch.status, "blocked");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("allows independent researcher answers after two delegated session streams", () => {
    const delegatedMission: Mission = {
      ...mission,
      desc: "请把这个任务交给两个独立研究员并分别取证。最后再给一句话结论。",
    };
    const firstDelegation = {
      ...message("d1", "assistant", 10),
      roleId: "role-lead",
      name: "Lead",
      content: "",
      toolCalls: [{ id: "call-a", name: "sessions_spawn", arguments: { task: "研究员 A" } }],
      toolStatus: "pending",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const secondDelegation = {
      ...message("d2", "assistant", 20),
      roleId: "role-lead",
      name: "Lead",
      content: "",
      toolCalls: [{ id: "call-b", name: "sessions_spawn", arguments: { task: "研究员 B" } }],
      toolStatus: "pending",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const final = {
      ...message("a1", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content:
        "| 研究员 | 检查的 URL | 页面标题 | 关键原文摘录 | 关系 |\n| A | https://example.com/ | Example Domain | quote | related |\n| B | https://www.iana.org/help/example-domains | Example Domains | quote | related |\n\n**结论：** 两个页面证据一致。",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const firstResult = {
      ...message("r1", "tool", 30),
      name: "sessions_spawn",
      toolCallId: "call-a",
      toolStatus: "completed",
      content: "研究员 A completed.",
    } satisfies TeamMessage;
    const secondResult = {
      ...message("r2", "tool", 40),
      name: "sessions_spawn",
      toolCallId: "call-b",
      toolStatus: "completed",
      content: "研究员 B completed.",
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: delegatedMission,
      messages: [message("u1", "user", 1), firstDelegation, firstResult, secondDelegation, secondResult, final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("blocks independent researcher answers when delegated sessions did not complete", () => {
    const delegatedMission: Mission = {
      ...mission,
      desc: "请把这个任务交给两个独立研究员并分别取证。最后再给一句话结论。",
    };
    const final = {
      ...message("a1", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content:
        "| 研究员 | 检查的 URL | 页面标题 | 关键原文摘录 | 关系 |\n| A | https://example.com/ | Example Domain | quote | related |\n| B | https://www.iana.org/help/example-domains | Example Domains | quote | related |\n\n**结论：** 两个页面证据一致。",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const failedResult = {
      ...message("r1", "tool", 30),
      name: "sessions_spawn",
      toolCallId: "call-a",
      toolStatus: "failed",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:explore:a",
        agent_id: "explore",
        status: "failed",
        result: "Researcher A failed before collecting evidence.",
      }),
    } satisfies TeamMessage;
    const partialResult = {
      ...message("r2", "tool", 40),
      name: "sessions_spawn",
      toolCallId: "call-b",
      toolStatus: "completed",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:explore:b",
        agent_id: "explore",
        status: "partial",
        result: "Researcher B timed out with partial notes.",
      }),
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: delegatedMission,
      messages: [message("u1", "user", 1), failedResult, partialResult, final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.equal(decision.patch.status, "blocked");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("blocks separate evidence stream finals that leave a required route stream unverified", () => {
    const streamMission: Mission = {
      ...mission,
      desc: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Route source: http://127.0.0.1/asiawalk-route",
        "Budget source: http://127.0.0.1/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1/asiawalk-live",
        "Treat route, budget, and live readiness as separate evidence streams.",
        "Do not finalize until all three streams have returned.",
        "The final brief should cover the route shape, budget, readiness risks, go/no-go recommendation, and the next action for the product lead.",
      ].join("\n"),
    };
    const final = {
      ...message("a-stream-incomplete", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## AsiaWalk Pilot Brief",
        "Route Shape",
        "Status: Evidence was pruned before retrieval - route shape, stops, waypoints, and order are not verified.",
        "Budget: $1,280 total with a $180 contingency buffer.",
        "Rendered readiness: browser evidence shows readiness yellow, rain risk in Taipei, and metro maintenance in Tokyo.",
        "Recommendation: conditional go after route structure is verified.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: streamMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.equal(decision.patch.status, "blocked");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("accepts separate evidence stream finals when all streams are covered", () => {
    const streamMission: Mission = {
      ...mission,
      desc: [
        "Prepare a decision-ready AsiaWalk pilot brief for a travel product lead.",
        "Route source: http://127.0.0.1/asiawalk-route",
        "Budget source: http://127.0.0.1/asiawalk-budget",
        "Live readiness dashboard: http://127.0.0.1/asiawalk-live",
        "Treat route, budget, and live readiness as separate evidence streams.",
        "Do not finalize until all three streams have returned.",
        "The final brief should cover the route shape, budget, readiness risks, go/no-go recommendation, and the next action for the product lead.",
      ].join("\n"),
    };
    const final = {
      ...message("a-stream-complete", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## AsiaWalk Pilot Brief",
        "Route: Seoul orientation walk, Taipei food-and-transit loop, and Tokyo neighborhood finale.",
        "Budget: $1,280 total with a $180 contingency buffer.",
        "Rendered readiness: browser evidence shows readiness yellow, rain risk in Taipei, and metro maintenance in Tokyo.",
        "Recommendation: conditional go after confirming indoor alternates and guide availability.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const resultA = {
      ...message("r-route", "tool", 20),
      name: "sessions_spawn",
      toolCallId: "call-route",
      toolStatus: "completed",
      content: JSON.stringify({ status: "completed", result: "Route stream complete." }),
    } satisfies TeamMessage;
    const resultB = {
      ...message("r-budget", "tool", 30),
      name: "sessions_spawn",
      toolCallId: "call-budget",
      toolStatus: "completed",
      content: JSON.stringify({ status: "completed", result: "Budget stream complete." }),
    } satisfies TeamMessage;
    const resultC = {
      ...message("r-live", "tool", 40),
      name: "sessions_spawn",
      toolCallId: "call-live",
      toolStatus: "completed",
      content: JSON.stringify({ status: "completed", result: "Live readiness stream complete." }),
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: streamMission,
      messages: [message("u1", "user", 1), resultA, resultB, resultC, final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("does not complete a mission from lifecycle status text after a tool result", () => {
    const leadTool = {
      ...message("tool-call", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { task: "compare vendor pages" } }],
      toolStatus: "pending",
    } satisfies TeamMessage;
    const toolResult = {
      ...message("tool-result", "tool", 150),
      name: "sessions_spawn",
      toolCallId: "call-1",
      content: "Browser evidence collected.",
    } satisfies TeamMessage;
    const statusText = {
      ...message("status-1", "assistant", 200),
      roleId: "role-lead",
      name: "Lead",
      content: "Lead finished this turn.",
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission,
      messages: [message("u1", "user", 1), leadTool, toolResult, statusText],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "stalled_tool_turn");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "stalled_tool_turn");
    }
  });

  it("does not complete a mission from dispatch wake status text", () => {
    const statusText = {
      ...message("status-1", "assistant", 200),
      roleId: "role-lead",
      name: "Lead",
      content: "Woke role-lead to start work.",
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission,
      messages: [message("u1", "user", 1), statusText],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, { action: "none", reason: "awaiting_work" });
  });

  it("blocks singular delegated researcher answers without delegated session evidence", () => {
    const delegatedMission: Mission = {
      ...mission,
      desc: "请交给研究员 A 只检查 https://example.com/，并返回 URL、title、关键原文、取证方式。",
    };
    const final = {
      ...message("a1", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content:
        "| URL | title | 关键原文 | 证据方式 |\n|---|---|---|---|\n| https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | HTTP fetch |",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: delegatedMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.patch.status, "blocked");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("blocks follow-up answers that leave a requested risk or limitation unverified", () => {
    const followUpMission: Mission = {
      ...mission,
      title:
        "请交给研究员 A 只检查 https://example.com/，研究员 A 必须返回最终 URL、页面 title、关键原文、取证方式。",
      desc: "",
      status: "done",
      progress: 1,
    };
    const firstDelegation = {
      ...message("d1", "assistant", 10),
      roleId: "role-lead",
      name: "Lead",
      content: "",
      toolCalls: [{ id: "call-a", name: "sessions_spawn", arguments: { task: "研究员 A" } }],
      toolStatus: "pending",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const firstResult = {
      ...message("r1", "tool", 20),
      name: "sessions_spawn",
      toolCallId: "call-a",
      toolStatus: "completed",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:explore:a",
        agent_id: "explore",
        status: "completed",
        result: "Example Domain evidence.",
        final_content:
          "Example Domain. This domain is for use in documentation examples without needing permission. Avoid use in operations.",
      }),
    } satisfies TeamMessage;
    const firstFinal = {
      ...message("a1", "assistant", 30),
      roleId: "role-lead",
      name: "Lead",
      content:
        "| URL | title | 关键原文 | 证据方式 |\n|---|---|---|---|\n| https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | HTTP fetch |",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const followUp = {
      ...message("u2", "user", 40),
      content:
        "继续刚才研究员 A 的同一条研究线索。基于上一轮 evidence 写一个三点 decision note：1. 这个页面可以用于什么；2. 使用时最重要的限制或风险是什么；3. 引用上一轮研究员 A 的关键原文作为证据。",
    } satisfies TeamMessage;
    const badFinal = {
      ...message("a2", "assistant", 50),
      roleId: "role-lead",
      name: "Lead",
      content:
        "## Decision Note\n\n1. 这个页面可以用于文档示例。\n2. 使用时最重要的限制或风险：未验证（证据未说明任何使用限制或风险）。\n3. 证据：> \"This domain is for use in documentation examples without needing permission.\"",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: followUpMission,
      messages: [message("u1", "user", 1), firstDelegation, firstResult, firstFinal, followUp, badFinal],
      roleRuns: [],
      workerSessions: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1, progress: 0.95 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("accepts mission-authorized bounded timeout partial closeouts with explicit unverified scope", () => {
    const timeoutMission: Mission = {
      ...mission,
      title: "Natural timeout partial evidence closeout",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        "Slow source: http://127.0.0.1:51771/slow-fixture",
        "Use a bounded attempt. If the source does not return in time, close out with the evidence that is available, clearly separating verified facts from unverified items and explaining how to continue.",
      ].join("\n"),
    };
    const final = {
      ...message("a-timeout-partial", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "**Partial Evidence Closeout — Slow Source: `http://127.0.0.1:51771/slow-fixture`**",
        "",
        "**Verified facts**",
        "| Item | Value |",
        "|------|-------|",
        "| Target URL attempted | `http://127.0.0.1:51771/slow-fixture` |",
        "| Transport | HTTP over loopback |",
        "| Outcome after 20 s | Session timed out — no HTTP response received within the window |",
        "",
        "**Unverified / Unknown Items**",
        "- Any response body, headers, status code, or content type",
        "- Any release-risk signals",
        "",
        "**How to continue**",
        "Increase the timeout bound or check the local service behind `127.0.0.1:51771`.",
        "",
        "**Release-risk note draft:** Status is timed out; risk is undetermined until the endpoint is confirmed reachable.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: timeoutMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts verified risk facts when only mitigation resolution remains unverified", () => {
    const riskMission: Mission = {
      ...mission,
      title: "Natural timeout follow-up continuation",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        "Use a bounded attempt first. If the source does not return in time, close out with verified facts, unverified items, residual risk, and how to continue.",
      ].join("\n"),
    };
    const final = {
      ...message("a-risk-final", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Release-Risk Note",
        "### Verified Facts",
        "| Dimension | Status |",
        "|---|---|",
        "| Owner | Release Captain |",
        "| Risk | runbook gap before launch approval |",
        "| Mitigation | complete rollback rehearsal before release gate |",
        "### Not Verified",
        "- Whether the runbook gap has been resolved since fixture authorship",
        "- Whether rollback rehearsal has been executed",
        "### Residual Risk",
        "The fixture labels the open risk explicitly: runbook gap before launch approval.",
        "Timeout closeout: Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: riskMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts verified fixture risk when production runbook scope remains unverified", () => {
    const riskMission: Mission = {
      ...mission,
      title: "Natural timeout follow-up continuation",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        "Separate verified facts from unverified items, describe any residual risk, and explain whether the earlier timeout still limits the conclusion.",
      ].join("\n"),
    };
    const final = {
      ...message("a-risk-production-scope", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Release-Risk Note",
        "### Verified Facts",
        "| Field | Value |",
        "|---|---|",
        "| Verified Risk | runbook gap before launch approval |",
        "| Verified Mitigation | complete rollback rehearsal before release gate |",
        "### Unverified / Residual Risk Items",
        "| Runbook completeness | not verified — only the fixture's risk label is present; runbook content itself not inspected |",
        "| Mitigation execution readiness | not verified — rollback rehearsal is flagged as required but its completion is unconfirmed |",
        "| Production-endpoint behavior | not verified — this is fixture-level evidence, not live endpoint behavior |",
        "Timeout closeout: Continue or retry the same source-check with a bounded timeout if future release-gated evidence is missing.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: riskMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts source-evaluation bounded timeout closeouts before follow-up release", () => {
    const timeoutMission: Mission = {
      ...mission,
      title: "Natural timeout follow-up continuation",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        "Slow source: http://127.0.0.1:54581/slow-fixture",
        "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
        "A follow-up may ask you to resume that same source-check context after the initial closeout.",
      ].join("\n"),
    };
    const final = {
      ...message("a-timeout-closeout", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "**Source Evaluation — Closeout**",
        "- **Source:** http://127.0.0.1:54581/slow-fixture",
        "- **Attempted bound:** 30 s wall-clock stop, 35 s sub-agent budget",
        "- **Result:** Sub-agent session timed out before returning any HTTP status, headers, or body text. No response body was verified.",
        "- **Unverified scope:** owner, risk, mitigation, status code, headers, and source content remain unverified until the same source-check is resumed.",
        "- **How to continue:** continue or retry the same resumable source-check session after the source is available, or retry later with a longer bounded timeout.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: timeoutMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts browser-rendered dashboard answers with residual unverified production scope", () => {
    const browserMission: Mission = {
      ...mission,
      title: "Natural browser profile-lock recovery",
      desc: [
        "Review this operations dashboard through a browser-visible pass, as an operator would see it.",
        "Dashboard: http://127.0.0.1:65210/ops-dashboard",
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Raw server HTML is not enough for this review.",
        "The persistent browser profile may be temporarily unavailable; recover with a safe isolated browser context if needed and keep that recovery visible.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
      ].join("\n"),
    };
    const final = {
      ...message("a-browser-final", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "**Operations Dashboard — Browser-visible operator review**",
        "**Browser session:** isolated fallback; persistent profile was locked.",
        "**Observed via browser-rendered page:** Queue depth is 11, SLA breaches are 3, and the escalation policy is triggered when queue depth is above 5 or SLA breaches are above 0.",
        "**Owner:** Incident Commander.",
        "**Recommended next action:** page the on-call Incident Commander and investigate the SLA breaches.",
        "**Residual risk / unverified scope:** This browser check could not verify whether this is a real production incident, whether an on-call notification was actually dispatched, historical trend data, upstream services, or downstream dependencies.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: browserMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts rendered dashboard facts when only downstream controls remain unverified", () => {
    const browserMission: Mission = {
      ...mission,
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
        "Also state the residual risk or unverified scope that remains after the browser check.",
      ].join("\n"),
    };
    const final = {
      ...message("a-browser-final", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "**Operational State:** Triage status `TURNKEYAI_DASHBOARD_TRIAGE_OK`; Queue depth 11; SLA breaches 3.",
        "**Escalation Trigger:** Queue depth > 5 OR SLA breaches > 0.",
        "**Owner:** Incident Commander.",
        "**Recommended Next Action:** Page the on-call.",
        "**Residual risk / unverified scope:** No interactive control was rendered on the dashboard itself; the action must be triggered through the downstream paging workflow, and production data freshness remains unverified outside this browser check.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: browserMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts source-bounded timeout closeouts after a failed session tool turn", () => {
    const timeoutMission: Mission = {
      ...mission,
      title: "Natural timeout partial evidence closeout",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        "Slow source: http://127.0.0.1:51771/slow-fixture",
        "Use a bounded attempt. If the source does not return in time, close out with the evidence that is available, clearly separating verified facts from unverified items and explaining how to continue.",
      ].join("\n"),
    };
    const toolCall = {
      ...message("a-tool", "assistant", 20),
      roleId: "role-lead",
      name: "Lead",
      content: "",
      toolCalls: [
        {
          id: "call-slow-source",
          name: "sessions_spawn",
          arguments: {
            task: "Fetch http://127.0.0.1:51771/slow-fixture for a release-risk note with a bounded attempt.",
          },
        },
      ],
      toolStatus: "pending",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const timeoutResult = {
      ...message("r-timeout", "tool", 30),
      name: "sessions_spawn",
      toolCallId: "call-slow-source",
      toolStatus: "failed",
      content: "sessions_spawn timed out after 20 seconds before any HTTP response was received.",
    } satisfies TeamMessage;
    const final = {
      ...message("a-timeout-partial", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Release-Risk Note: Slow Source Evaluation",
        "",
        "### Closeout - Natural Timeout (Partial Evidence)",
        "The slow source `http://127.0.0.1:51771/slow-fixture` timed out during the bounded attempt; no HTTP response was received.",
        "",
        "### Verified facts",
        "- Target URL attempted: `http://127.0.0.1:51771/slow-fixture`.",
        "- The source did not return within the bounded attempt window.",
        "",
        "### Unverified items",
        "- Response body, headers, status code, content type, and release-risk signals remain unverified.",
        "",
        "### How to continue",
        "Retry or increase the timeout, then resume the same source-check context before using the result for release decisions.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: timeoutMission,
      messages: [message("u1", "user", 1), toolCall, timeoutResult, final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts natural table-shaped bounded timeout closeouts without a verified-facts heading", () => {
    const timeoutMission: Mission = {
      ...mission,
      title: "Natural timeout follow-up continuation",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        "Slow source: http://127.0.0.1:51771/slow-fixture",
        "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
        "A follow-up may ask you to resume that same source-check context after the initial closeout.",
      ].join("\n"),
    };
    const timeoutResult = {
      ...message("r-timeout", "tool", 30),
      name: "sessions_spawn",
      toolCallId: "call-slow-source",
      toolStatus: "failed",
      content: "sessions_spawn timed out after 30 seconds before any HTTP response was received.",
    } satisfies TeamMessage;
    const final = {
      ...message("a-timeout-table", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Source Evaluation - Release-Risk Note",
        "",
        "| Field | Value |",
        "|---|---|",
        "| Source | `http://127.0.0.1:51771/slow-fixture` |",
        "| Status | Timed out after a bounded 30 s attempt |",
        "| Content received | None - no headers, body, or error details captured |",
        "| Risk assessment | Source unavailable; no release-risk facts verified |",
        "| Owner | Not verified |",
        "| Mitigation | Retry the same source-check with a longer bounded timeout before release use |",
        "",
        "Residual risk: release-risk facts remain source-bounded because the endpoint did not respond.",
        "How to continue: resume this same source-check context or retry with an increased timeout.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: timeoutMission,
      messages: [message("u1", "user", 1), timeoutResult, final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts completed timeout follow-up recoveries with rendered source evidence", () => {
    const timeoutMission: Mission = {
      ...mission,
      title: "Natural timeout follow-up continuation",
      desc: [
        "Evaluate this slow source for a release-risk note.",
        "Slow source: http://127.0.0.1:58723/slow-fixture",
        "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how the mission can continue.",
        "A follow-up may ask you to resume that same source-check context after the initial closeout.",
      ].join("\n"),
    };
    const final = {
      ...message("a-timeout-recovered", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Slow-Source Release-Risk Note",
        "**Source:** `http://127.0.0.1:58723/slow-fixture`",
        "**Session:** `browser-session-1781094808320` - cold resume completed.",
        "**Probe:** 10-second browser timeout boundary; full content rendered success.",
        "",
        "### Verified facts",
        "- Browser-rendered source content was captured from the slow fixture.",
        "- Verified owner: Release Captain.",
        "- Verified risk: runbook gap before launch approval.",
        "",
        "### Unverified items and residual risk",
        "- No live production system was audited; this note is source-bounded to the fixture.",
        "- The earlier timeout no longer limits the source conclusion because the resumed source-check completed.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: timeoutMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts mission-authorized cancelled source-check closeouts before follow-up", () => {
    const cancelledMission: Mission = {
      ...mission,
      title: "Natural cancellation follow-up continuation",
      desc: [
        "Evaluate this static text source for a release-risk note.",
        "Static source: http://127.0.0.1:56429/cancel-resume-fixture",
        "Make a source-backed attempt instead of guessing from memory.",
        "If an operator cancels the active source check, close out from the cancellation evidence and explain how to continue later.",
        "A follow-up may ask you to resume the same source-check context after the initial cancellation.",
      ].join("\n"),
    };
    const final = {
      ...message("a-cancel-closeout", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "**Cancellation outcome**",
        "- Source check was cancelled by the operator before any content was fetched.",
        "- The target URL (http://127.0.0.1:56429/cancel-resume-fixture) was not retrieved.",
        "- No release-risk content was verified; those items remain unverified.",
        "- Continue later by resuming the same source-check context after the source is allowed to finish.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: cancelledMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts source-bounded residual risk tables after independent evidence streams return", () => {
    const briefMission: Mission = {
      ...mission,
      title: "Natural tool-result pruning brief",
      desc: [
        "Prepare an audit-ready product brief about the next agent workbench release.",
        "Research source: http://127.0.0.1:60866/product-orchestration",
        "Capability source: http://127.0.0.1:60866/product-bridge",
        "Live signal dashboard: http://127.0.0.1:60866/product-signals",
        "These are three independent evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
        "Keep enough source-specific evidence for an operator to trust the recommendation, but keep the final brief concise and focused on what to build next, why, what not to over-emphasize, and what risk remains.",
      ].join("\n"),
    };
    const spawnCalls = [1, 2, 3].map(
      (index) =>
        ({
          ...message(`tool-${index}`, "tool", 20 + index),
          name: "sessions_spawn",
          toolCallId: `call-${index}`,
          toolStatus: "completed",
          content: `Completed evidence stream ${index}.`,
        }) satisfies TeamMessage,
    );
    const final = {
      ...message("a-brief", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Audit-Ready Brief: Agent Workbench",
        "",
        "### Why",
        "| Evidence source | Verified fact |",
        "|---|---|",
        "| Product Orchestration | Strength: multi-agent decomposition with durable sub-session history and follow-up capability. |",
        "| Product Bridge | Browser page open, rendered DOM inspection, form actions after approval, and screenshot/artifact collection. |",
        "| Product Signals | Stuck missions: **6**. Weak answer rate: **24%**. |",
        "",
        "### Residual Risk",
        "| Risk dimension | Evidence state |",
        "|---|---|",
        "| LLM scenario quality gate | Not verified in any of the three source pages. The dashboard recommends gating release on real LLM quality. |",
        "| First-run provider configuration | Acknowledged as a blocker in the product bridge risk note; resolution path is outside the pruning brief scope. |",
        "| Signal data provenance | Product signals sourced from a local fixture — not live production telemetry. |",
        "",
        "**Source ledger:** Product Orchestration verified; Product Bridge verified; Product Signals verified as rendered browser evidence.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: briefMission,
      messages: [message("u1", "user", 1), ...spawnCalls, final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("accepts completed rendered dashboard evidence with source-bounded risk closeout", () => {
    const briefMission: Mission = {
      ...mission,
      title: "Natural long delegation brief",
      desc: [
        "Prepare a product-ready brief about the next agent workbench release.",
        "Research source: http://127.0.0.1:53192/product-orchestration",
        "Capability source: http://127.0.0.1:53192/product-bridge",
        "Live signal dashboard: http://127.0.0.1:53192/product-signals",
        "These are three independent evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
        "Do not finalize until all three evidence streams have returned. The live signal dashboard must be inspected as rendered browser evidence, not raw HTML.",
        "The final brief must explicitly include Mission Control, Stuck missions, Weak answer rate, and the signal-dashboard recommended next action when those values are present.",
        "If any child evidence mentions transport_failure, lease conflict, result truncation, snapshot truncation, or other browser transport degradation, explicitly name that bucket in the final answer and state what evidence was recovered, what remains unverified, and whether to retry or continue.",
        "The final brief should tell a product leader what to build next, why it matters, what not to over-emphasize, and what risk remains.",
      ].join("\n"),
    };
    const spawnCalls = [1, 2, 3].map(
      (index) =>
        ({
          ...message(`tool-${index}`, "tool", 20 + index),
          name: "sessions_spawn",
          toolCallId: `call-${index}`,
          toolStatus: "completed",
          content: `Completed evidence stream ${index}.`,
        }) satisfies TeamMessage,
    );
    const final = {
      ...message("a-brief", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "All three evidence streams have returned.",
        "",
        "# Agent Workbench - Next Release Product Brief",
        "",
        "## Completed Browser Evidence",
        "- product-orchestration verified Mission Control as the default release story.",
        "- product-bridge verified browser page open, rendered DOM inspection, screenshots, and artifact collection.",
        "- product-signals was inspected as rendered browser evidence, not raw HTML: Stuck missions: 6; Weak answer rate: 24%; signal-dashboard recommended next action: make Mission Control the default entry and gate release on real LLM scenario quality.",
        "",
        "## Risk and limitation",
        "- No child evidence mentioned transport_failure, lease conflict, result truncation, snapshot truncation, or other browser transport degradation.",
        "- Recovered evidence includes all three source streams and the rendered dashboard counters.",
        "- What remains unverified is source-bounded: these are local fixture pages, not live production telemetry, and future source updates could change the numbers.",
        "- Retry or continue only if production telemetry or a fresh external deployment check is required.",
      ].join("\n"),
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: briefMission,
      messages: [message("u1", "user", 1), ...spawnCalls, final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("allows follow-up answers that cover the requested risk and quote from prior evidence", () => {
    const followUpMission: Mission = {
      ...mission,
      title:
        "请交给研究员 A 只检查 https://example.com/，研究员 A 必须返回最终 URL、页面 title、关键原文、取证方式。",
      desc: "",
    };
    const firstDelegation = {
      ...message("d1", "assistant", 10),
      roleId: "role-lead",
      name: "Lead",
      content: "",
      toolCalls: [{ id: "call-a", name: "sessions_spawn", arguments: { task: "研究员 A" } }],
      toolStatus: "pending",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;
    const firstResult = {
      ...message("r1", "tool", 20),
      name: "sessions_spawn",
      toolCallId: "call-a",
      toolStatus: "completed",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:explore:a",
        agent_id: "explore",
        status: "completed",
        result: "Example Domain evidence.",
        final_content:
          "Example Domain. This domain is for use in documentation examples without needing permission. Avoid use in operations.",
      }),
    } satisfies TeamMessage;
    const followUp = {
      ...message("u2", "user", 40),
      content:
        "继续刚才研究员 A 的同一条研究线索。基于上一轮 evidence 写一个三点 decision note：1. 这个页面可以用于什么；2. 使用时最重要的限制或风险是什么；3. 引用上一轮研究员 A 的关键原文作为证据。",
    } satisfies TeamMessage;
    const goodFinal = {
      ...message("a2", "assistant", 50),
      roleId: "role-lead",
      name: "Lead",
      content:
        "## Decision Note\n\n1. 这个页面可以用于文档示例。\n2. 使用时最重要的限制或风险：避免用于 operations。\n3. 证据：> \"This domain is for use in documentation examples without needing permission. Avoid use in operations.\"",
      source: { type: "worker", chatType: "group", route: "lead-role", speakerType: "Role", speakerName: "Lead" },
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: followUpMission,
      messages: [message("u1", "user", 1), firstDelegation, firstResult, followUp, goodFinal],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("does not treat prematurely done missions with unverified goal slots as terminal", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "done",
        progress: 1,
        desc: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**Status: blocked.** The research session timed out before any provider data was gathered.",
            "No pricing, model names, or search-support details could be verified.",
          ].join("\n"),
        },
      ],
      roleRuns: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1, progress: 0.95 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("does not treat title-only missions that request a final conclusion as done when the final omits it", () => {
    const title = [
      "请把这个任务交给两个独立研究员并分别取证。",
      "研究员 A 只检查 https://example.com/，研究员 B 只检查 https://www.iana.org/help/example-domains。",
      "最后合并成一个两行表格，并最后再给一句话结论。",
    ].join("\n");
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title,
        desc: "",
        status: "done",
        progress: 1,
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: title,
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "| 研究员 | URL | 页面标题 | 关键原文摘录 | 关系 |",
            "|---|---|---|---|---|",
            "| 研究员 A | https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | 具体示例页面 |",
            "| 研究员 B | https://www.iana.org/help/example-domains | Example Domains | example.com and example.org are maintained for documentation purposes. | 权威说明页面 |",
          ].join("\n"),
        },
      ],
      roleRuns: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1, progress: 0.95 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("reopens prematurely done missions with unverified goal slots while execution is still active", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        status: "done",
        progress: 1,
        desc: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**Status: blocked.** The research session timed out before any provider data was gathered.",
            "No pricing, model names, or search-support details could be verified.",
          ].join("\n"),
        },
      ],
      roleRuns: [{ ...idleRun, status: "running" }],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "active_execution",
      patch: { status: "working", progress: 0.95 },
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

  it("completes natural approval wait-timeout closeouts with no browser navigation wording", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "needs_approval", pendingApprovals: 1 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content:
            "Open the local approval form and start a safe dry-run browser form submission attempt for operator review.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**Terminal Closeout — Natural Wait-Timeout**",
            "The operator decision on the dry-run form submission has not arrived within this attempt window.",
            "- **What ran:** Nothing. No browser navigation, no form submission, no side effects.",
            "- **Approval status:** Pending operator decision for browser.form.submit.",
            "- **Safest next action:** re-initiate the dry-run when the operator is ready to approve or deny.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", pendingApprovals: 0, closeout: "approval_timeout" },
    });
  });

  it("restores pending approval state when the pending counter was lost but tool evidence is pending", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "blocked", pendingApprovals: 0 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Start a safe dry-run browser form submission and close out if approval never arrives.",
        },
        {
          ...message("tool-result", "tool", 90),
          content: JSON.stringify({
            event_type: "permission.result",
            status: "pending",
            approvalId: "ap.thread.call",
            action: "browser.form.submit",
            message: "Permission request ap.thread.call is still pending.",
          }),
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## Terminal closeout - natural wait-timeout",
            "The operator decision for browser.form.submit is still pending after the wait boundary.",
            "No browser form submission occurred and no browser side effect was applied.",
            "Next action: ask the operator to approve a new request or rerun the submission attempt when ready.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "pending_approval",
      patch: { status: "needs_approval", pendingApprovals: 1, progress: 0.4 },
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

  it("blocks waiting-on-operator approval answers after approvals clear", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, pendingApprovals: 0 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content:
            "Actually carry the safe local dry-run through the approval gate; do not stop at a plan.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Permission request `ap.thread.call` is **pending** operator decision.",
            "**Waiting on operator approval** before the browser worker can open and submit the dry-run form.",
            "Once approved, the action will be carried through and the page evidence reported.",
          ].join("\n"),
        },
      ],
      roleRuns: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      if (decision.recovery?.kind === "incomplete_final_answer") {
        assert.equal(decision.recovery.reason, "stale_pending_approval");
      }
    }
  });

  it("blocks once-approved approval plans after the approval has already cleared", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, pendingApprovals: 0 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content:
            "Actually carry the safe local dry-run through the approval gate; do not stop at a plan.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "The approval request is now waiting for the operator's decision.",
            "Once approved, I will apply the approval, delegate to browser, and report the evidence returned by the page.",
          ].join("\n"),
        },
      ],
      roleRuns: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      if (decision.recovery?.kind === "incomplete_final_answer") {
        assert.equal(decision.recovery.reason, "stale_pending_approval");
      }
    }
  });

  it("blocks incomplete approval-loop answers that skipped the permission gate", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, pendingApprovals: 0 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content:
            "Actually carry the safe local dry-run through the approval gate before submitting the browser form.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**Status: Incomplete — Permission Loop Not Finalized**",
            "The browser task observed the approval form, but the permission loop was not finalized.",
            "The approval-gated form submission was not completed.",
          ].join("\n"),
        },
      ],
      roleRuns: [],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.deepEqual(decision.patch, { status: "blocked", blockers: 1 });
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      if (decision.recovery?.kind === "incomplete_final_answer") {
        assert.equal(decision.recovery.reason, "goal_slots_unverified");
      }
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

  it("caps blocked mission progress below complete", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "blocked", progress: 1, blockers: 1 },
      messages: [],
      roleRuns: [],
    });
    assert.deepEqual(decision, {
      action: "update",
      reason: "existing_blocker",
      patch: { progress: 0.95 },
    });
  });

  it("returns blocked missions to working while linked execution is active", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "blocked", progress: 1, blockers: 1 },
      messages: [],
      roleRuns: [{ ...idleRun, status: "running" }],
      workerSessions: [runningWorker],
    });
    assert.deepEqual(decision, {
      action: "update",
      reason: "active_execution",
      patch: { status: "working", blockers: 0, progress: 0.95 },
    });
  });

  it("clears a stale blocker when the latest lead final answer is complete", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "blocked", blockers: 1 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Fetch https://example.com and answer the three requested fields.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "1) 页面标题：**Example Domain**",
            "",
            '2) 页面最核心的一句话：**"This domain is for use in documentation examples without needing permission. Avoid use in operations."**',
            "",
            "3) 证据 URL：**https://example.com/**",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1, blockers: 0 },
    });
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

  it("blocks final answers that leave requested provider search pricing slots unverified", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "结论：DeepSeek V4 Flash API 可能可通过多个 provider 访问。",
            "| 核心项 | 状态 |",
            "|---|---|",
            "| 各 provider 具体输入/输出 token 价格 | 未验证 |",
            "| 支持 search 功能的 provider 列表 | 未验证 |",
            "| Search 专项费用或功能差异 | 未验证 |",
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
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("uses the latest substantive user goal for incomplete-final recovery instead of stale mission setup text", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: [
          "Legacy setup text from an earlier run.",
          "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样。",
        ].join("\n"),
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content:
            "Aurora-19 launch handoff: verify the owner, launch window, hard constraint, and risk from durable memory.",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Owner: verified from memory.",
            "Launch window: verified from memory.",
            "Hard constraint: verified from memory.",
            "Risk: not verified.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
      assert.match(decision.recovery?.goalText ?? "", /Aurora-19 launch handoff/);
      assert.doesNotMatch(decision.recovery?.goalText ?? "", /provider|search|价格/i);
    }
  });

  it("ignores automatic recovery prompts when selecting the active goal", () => {
    const dynamicMission: Mission = {
      ...mission,
      title: "Natural browser dynamic page",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        "Dashboard: http://127.0.0.1:51008/ops-dashboard",
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
        "Also state the residual risk or unverified scope that remains after the browser check.",
      ].join("\n"),
    };
    const decision = evaluateMissionCompletion({
      mission: dynamicMission,
      messages: [
        {
          ...message("u-original", "user", 10),
          content: dynamicMission.desc,
        },
        {
          ...message("u-recovery", "user", 90),
          content: [
            "System recovery: the previous final answer did not satisfy required goal slots.",
            "Automatic recovery attempt 1 of 2.",
            "Continue the original mission instead of closing it.",
            "Do not introduce provider/search/model-support columns unless the original mission explicitly requested provider, search/web_search, or model-support evidence.",
          ].join("\n"),
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## Ops Dashboard — Browser Review",
            "Rendering: fully rendered browser evidence was captured.",
            "Operational state: mixed. Queue depth 11 and 3 SLA breaches exceed thresholds.",
            "Escalation trigger: queue depth above 5 and SLA breaches above 0.",
            "Owner: Incident Commander.",
            "Recommended next action: page the on-call lead.",
            "Residual risk: fixture evidence only; production freshness remains unverified.",
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

  it("blocks timeout closeouts that explicitly leave requested provider search pricing slots blocked", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**DeepSeek V4 Flash - Provider/Search/Pricing Verification**",
            "| Provider | Model Name | Search Support | Input Price | Output Price | Evidence |",
            "|----------|------------|----------------|-------------|--------------|----------|",
            "| OpenRouter | - | **blocked** | **blocked** | **blocked** | - |",
            "| Together AI | - | **blocked** | **blocked** | **blocked** | - |",
            "**Status: blocked.** The research session timed out before any provider data was gathered.",
            "No pricing, model names, or search-support details could be verified.",
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
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("blocks rendered browser closeouts that explicitly leave requested visible page evidence unverified", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc:
          '请用浏览器打开 https://the-internet.herokuapp.com/dynamic_loading/1 ，点击 "Start"，等待页面显示 Hello World! 后，只回答三行：状态、最终可见文本、证据 URL。必须使用浏览器渲染后的页面证据，不要用 web_fetch 或静态抓取替代。',
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content:
            '请用浏览器打开 https://the-internet.herokuapp.com/dynamic_loading/1 ，点击 "Start"，等待页面显示 Hello World! 后，只回答三行。',
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "状态：未完成（浏览器任务超时，未获取渲染后的最终状态）",
            "最终可见文本：未验证",
            "证据 URL：https://the-internet.herokuapp.com/dynamic_loading/1",
            "",
            '浏览器子任务在120秒内未完成"Start"点击与"Hello World!"渲染等待，无法提供渲染后的最终可见文本证据。',
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
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("blocks cold browser recovery finals that leave rendered dashboard evidence unavailable", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title: "Natural browser cold recreation continuation",
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
          "A later follow-up may need to continue even if the previous browser session is unavailable; recover by reopening the same read-only dashboard when needed.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-cold-recovery-incomplete", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Recovery status: Browser failure - session_not_found.",
            "Dashboard content was not rendered during this recovery attempt.",
            "Not verified: Operational state, escalation trigger, owner, next action, any metrics, thresholds, triage status, or queue/SLA data.",
            "The rendered page content is unavailable.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
    }
  });

  it("does not infer rendered browser evidence from visible thread summary wording", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: "Natural memory pressure flush",
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: [
            "Continue from the long Aurora-19 launch handoff in this mission.",
            "Please use the workbench's durable memory lookup for Aurora-19 rather than relying on the visible thread summary.",
            "Recover the launch window, owner, hard constraint, and residual risk if they are available.",
          ].join("\n"),
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Aurora-19 durable memory result:",
            "- Launch window: Friday 14:15.",
            "- Owner: Field Ops Lead.",
            "- Hard constraint: Legal Review must confirm the data-processing addendum before external announcement.",
            "- Residual risk: vendor dry-run note remains unverified.",
          ].join("\n"),
        },
      ],
      roleRuns: [idleRun],
    });

    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "final_answer");
      assert.equal(decision.patch.status, "done");
      assert.equal(decision.patch.progress, 1);
      assert.equal(decision.recovery, undefined);
    }
  });

  it("accepts final answers that concretely cover requested provider search pricing slots", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "基于 verified source evidence，provider 结论如下：OpenRouter 支持通过 web search 参数使用，Together 不支持 search，Fireworks 未开放 search。",
            "价格：OpenRouter input $0.07/M tokens、output $0.28/M tokens；Together input $0.08/M tokens、output $0.30/M tokens。",
            "Residual risk: source updates after this run may change pricing.",
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

  it("accepts source-bounded provider pricing with live-production freshness caveats", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: [
          "A product manager needs a source-backed DeepSeek V4 Flash API provider note.",
          "Identify which providers are listed, whether each provider supports search, and the input/output token pricing for each provider.",
          "Call out the lowest-cost option, the option that supports search, and the main risk or limitation for using this data in a production decision.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: [
            "A product manager needs a source-backed DeepSeek V4 Flash API provider note.",
            "Identify which providers are listed, whether each provider supports search, and the input/output token pricing for each provider.",
            "Call out the lowest-cost option, the option that supports search, and the main risk or limitation for using this data in a production decision.",
          ].join("\n"),
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## DeepSeek V4 Flash API Provider Note",
            '**Evidence source:** http://127.0.0.1:54581/deepseek-provider-pricing (local test endpoint; page title: "DeepSeek V4 Flash Provider Evidence")',
            "**Providers listed:** OpenRouter, Together, Fireworks — all running model `deepseek-v4-flash`.",
            "| Provider | Search support | Input price | Output price |",
            "|---|---|---|---|",
            "| OpenRouter | Yes — via `web_search` option | $0.28 / 1M tokens | $0.42 / 1M tokens |",
            "| Together | No | $0.20 / 1M tokens | $0.40 / 1M tokens |",
            "| Fireworks | No | $0.25 / 1M tokens | $0.45 / 1M tokens |",
            "**Lowest-cost option:** Together — $0.20 / $0.40 per 1M tokens.",
            "**Search-capable option:** OpenRouter — the only provider on this list with explicit search capability.",
            "**Key risk for production decisions:** the evidence source is a local test endpoint; production provider pages may change.",
            "**Unverified / unresolved:** Live production pricing and current route-level search enablement status on each provider's production environment have not been independently verified from this source.",
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

  it("accepts vendor comparison pricing caveats as bounded risk rather than incomplete pricing", () => {
    const vendorMission: Mission = {
      ...mission,
      title: "Natural comparison research",
      desc: [
        "Compare Vendor Alpha and Vendor Beta for a product lead.",
        "Focus on pricing, strength, and risk, and keep source labels visible in the answer.",
      ].join("\n"),
    };
    const final = {
      ...message("a-final", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Vendor Alpha vs Vendor Beta",
        "",
        "### Pricing",
        "| | Vendor Alpha | Vendor Beta |",
        "|---|---|---|",
        "| Rate | $19 per seat | $29 per workspace |",
        "",
        "Note: seat-based pricing and workspace-based pricing are not directly comparable without team size context.",
        "",
        "### Strengths",
        "- Vendor Alpha: browser automation and traceable screenshots.",
        "- Vendor Beta: collaboration workflow and audit-friendly workspace packaging.",
        "",
        "### Risks",
        "- Vendor Alpha risk: per-seat cost can rise with individual user count.",
        "- Vendor Beta risk: workspace packaging can hide per-user economics.",
        "",
        "Recommendation: choose Vendor Alpha for small operator teams; revisit if workspace packaging better matches the rollout.",
      ].join("\n"),
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: vendorMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1 },
    });
  });

  it("clears blockers for source-bounded vendor pricing recommendations with concrete prices", () => {
    const vendorMission: Mission = {
      ...mission,
      title: "Natural comparison research",
      status: "blocked",
      progress: 0.95,
      blockers: 1,
      desc: [
        "Compare Vendor Alpha and Vendor Beta for a product lead.",
        "Focus on pricing, strength, and risk, and keep source labels visible in the answer.",
      ].join("\n"),
    };
    const final = {
      ...message("a-final", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "## Vendor Alpha vs Vendor Beta",
        "",
        "### Pricing",
        "| Source | Vendor Alpha | Vendor Beta |",
        "|---|---|---|",
        "| Local source fixture | $19 per seat | $29 per workspace |",
        "",
        "### Strengths",
        "- Vendor Alpha: browser automation and traceable screenshots.",
        "- Vendor Beta: collaboration workflow and audit-friendly workspace packaging.",
        "",
        "### Risks and tradeoffs",
        "- Vendor Alpha risk: per-seat cost can rise with individual user count.",
        "- Vendor Beta risk: workspace packaging can hide per-user economics.",
        "",
        "Recommendation: choose Vendor Alpha for small operator teams; revisit if workspace packaging better matches the rollout.",
        "",
        "Residual risk: pricing is source-bounded to the local fixture; external availability and deeper pricing tiers were not verified elsewhere.",
      ].join("\n"),
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: vendorMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1, blockers: 0 },
    });
  });

  it("clears blockers for rendered dashboard facts with source-bounded production risk", () => {
    const dashboardMission: Mission = {
      ...mission,
      title: "Natural browser dynamic page",
      status: "blocked",
      progress: 0.95,
      blockers: 1,
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        "Dashboard: http://127.0.0.1:51008/ops-dashboard",
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, and recommended next action for an operator.",
        "Also state the residual risk or unverified scope that remains after the browser check.",
      ].join("\n"),
    };
    const final = {
      ...message("a-final", "assistant", 100),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "Dashboard tag reads: Operations signal dashboard.",
        "Operational state: queue depth 11 and 3 SLA breaches require escalation.",
        "Escalation trigger: queue depth above 5 or any SLA breach.",
        "Owner: Incident Commander.",
        "Recommended next action: page the on-call lead.",
        "Residual risk: this is local fixture evidence; production freshness and whether the page was actually sent to on-call remain unverified.",
      ].join("\n"),
    } satisfies TeamMessage;

    const decision = evaluateMissionCompletion({
      mission: dashboardMission,
      messages: [message("u1", "user", 1), final],
      roleRuns: [],
      workerSessions: [],
    });

    assert.deepEqual(decision, {
      action: "update",
      reason: "final_answer",
      patch: { status: "done", progress: 1, blockers: 0 },
    });
  });

  it("accepts exact numbered answers ending with closed bold markdown", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: "请使用可用工具获取 https://example.com 的页面内容，然后只回答三项：1) 页面标题；2) 页面最核心的一句话；3) 你使用的证据 URL。必须调用工具，不要只凭常识回答。",
      },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "请使用可用工具获取 https://example.com 的页面内容，然后只回答三项。",
        },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "1) 页面标题：**Example Domain**",
            "",
            '2) 页面最核心的一句话：**"This domain is for use in documentation examples without needing permission. Avoid use in operations."**',
            "",
            "3) 证据 URL：**https://example.com/**",
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

  it("does not mark a bare role mention as a final answer", () => {
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
          content: "@role-browser",
        },
      ],
      roleRuns: [],
    });

    assert.deepEqual(decision, { action: "none", reason: "awaiting_work" });
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

  it("does not let an already answered tool turn block a newer user follow-up", () => {
    const decision = evaluateMissionCompletion({
      mission,
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Check example.com.",
        },
        {
          ...message("a-tool", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          toolCalls: [{ id: "call-1", name: "web_fetch", arguments: { url: "https://example.com/" } }],
          toolStatus: "completed" as const,
        },
        {
          ...message("tool-1", "tool", 110),
          toolCallId: "call-1",
          content: "Example Domain evidence.",
        },
        {
          ...message("a-final", "assistant", 120),
          roleId: "role-lead",
          name: "Lead",
          content: "Initial final answer with evidence.",
        },
        {
          ...message("u-2", "user", 200),
          content: "Continue from the same evidence.",
        },
      ],
      roleRuns: [],
    });
    assert.deepEqual(decision, { action: "none", reason: "awaiting_work" });
  });

  it("reopens a done mission when a newer user follow-up arrives after the final answer", () => {
    const decision = evaluateMissionCompletion({
      mission: { ...mission, status: "done", progress: 1 },
      messages: [
        {
          ...message("u-1", "user", 50),
          content: "Check example.com.",
        },
        {
          ...message("a-tool", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          toolCalls: [{ id: "call-1", name: "web_fetch", arguments: { url: "https://example.com/" } }],
          toolStatus: "completed" as const,
        },
        {
          ...message("tool-1", "tool", 110),
          toolCallId: "call-1",
          content: "Example Domain evidence.",
        },
        {
          ...message("a-final", "assistant", 120),
          roleId: "role-lead",
          name: "Lead",
          content: "Initial final answer with evidence.",
        },
        {
          ...message("u-2", "user", 200),
          content: "Continue from the same evidence.",
        },
      ],
      roleRuns: [{ ...idleRun, status: "running", lastActiveAt: 220 }],
    });
    assert.deepEqual(decision, {
      action: "update",
      reason: "active_execution",
      patch: { status: "working", blockers: 0, progress: 0.95 },
    });
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

  it("blocks incomplete final answers when the only running role run is stale before the answer", () => {
    const incomplete = {
      ...message("a-stale-final", "assistant", 200),
      roleId: "role-lead",
      name: "Lead",
      content: "Research incomplete. Pricing remains unverified.",
      metadata: { stopReason: "end_turn" },
    };
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        desc: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
      },
      messages: [incomplete],
      roleRuns: [{ ...idleRun, status: "running", lastActiveAt: 100 }],
      workerSessions: [],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
      assert.equal(decision.recovery?.reason, "goal_slots_unverified");
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

  it("tags browser-runtime closeouts as bounded failures even before a blocker is posted", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title: "Natural browser unavailable closeout",
        status: "working",
        blockers: 0,
        progress: 0,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "If the browser cannot be reached, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-browser-unavailable-closeout", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## Browser Unavailable Closeout - Operations Dashboard Review",
            "What Was Verified: Three browser attempts with escalating timeouts all failed at the CDP WebSocket layer with browser_cdp_unavailable and ECONNREFUSED, not at the HTTP level.",
            "What Remains Unverified: Dashboard URL reachable in browser, rendered metrics, screenshot, and JavaScript-rendered operational information are not verified.",
            "Next Action for Operator: verify the dashboard service with curl, then restart the browser sub-agent service to reinitialize the CDP runtime.",
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

  it("accepts mission-authorized detached target closeouts as bounded browser failure", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title: "Natural browser detached target closeout",
        status: "blocked",
        blockers: 1,
        progress: 0.95,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "Dashboard: http://127.0.0.1:61917/ops-dashboard",
          "If the browser target detaches while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-detached-closeout", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## Browser Failure Closeout Report - Ops Dashboard Review",
            "**Target URL:** http://127.0.0.1:61917/ops-dashboard",
            "**Failure bucket:** detached_target=5.",
            "What was verified: the browser automation reached the target URL and attempted rendered-page capture. The target application is not the source of the failure; the browser target detached during capture.",
            "What remains unverified: rendered dashboard content, metrics, owner, and operator next action remain unverified because every browser target detached before stable page capture.",
            "Next action for operator: restart or repair the browser runtime, then resubmit the review task; no further automated work can continue in this run.",
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

  it("accepts detached closeouts that name browser runtime connectivity as the terminal cause", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title: "Natural browser detached target closeout",
        status: "blocked",
        blockers: 1,
        progress: 0,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "Dashboard: http://127.0.0.1:61420/ops-dashboard",
          "If the browser target detaches while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-detached-runtime-closeout", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**What was verified**",
            "- Browser infrastructure failure: `detached_target` on 6/6 browser calls at `http://127.0.0.1:61420/ops-dashboard`.",
            "- Root cause is a browser runtime connectivity issue, not a page-load or endpoint content issue.",
            "",
            "**What remains unverified**",
            "- Page Title: not verified.",
            "- Verified Facts: not verified.",
            "- Page Content: not verified.",
            "",
            "**Next action for operator**",
            "Restart or repair the browser runtime, then rerun the review task. Do not rely on this run for rendered dashboard content.",
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

  it("tags natural detached target closeouts with disconnected browser wording as bounded failures", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title: "Natural browser detached target closeout",
        status: "working",
        blockers: 0,
        progress: 0,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "Dashboard: http://127.0.0.1:58779/ops-dashboard",
          "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
          "If the browser target detaches while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-natural-detached-closeout", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## Browser Target Detached - Closeout",
            "",
            "**Target:** `http://127.0.0.1:58779/ops-dashboard`",
            "**Attempts:** 6 consecutive `browser_open` failures, 1 `browser_wait_for` timeout, all `browser_snapshot` calls failed",
            "",
            "### What Was Verified",
            "- The Chromium browser target repeatedly crashed/disconnected (`detached_target` x 7) before any DOM could be captured.",
            "- The page never reached a stable render state within the wait window.",
            "",
            "### What Remains Unverified",
            "- Dashboard page content - not verified",
            "- Any tables, panels, or JavaScript-rendered elements - not verified",
            "- Server-side error responses or HTML - not verified (browser died before rendering anything)",
            "",
            "### Next Action for Operator",
            "1. Confirm the dev server is running and responsive on port `58779`: `curl -v http://127.0.0.1:58779/ops-dashboard`",
            "2. Review server logs for crashes or errors on the `/ops-dashboard` route",
            "3. Test a simpler endpoint to isolate whether the server itself is responsive or if this specific route is crashing the browser",
            "4. Re-run browser inspection once server health is confirmed",
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

  it("tags natural detached target closeouts with no rendered content as bounded failures", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title: "Natural browser detached target closeout",
        status: "working",
        blockers: 0,
        progress: 0,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "Dashboard: http://127.0.0.1:65172/ops-dashboard",
          "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
          "If the browser target detaches while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-natural-detached-empty-closeout", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "**What was verified:** None - the browser target detached before any page content could be captured.",
            "",
            "**What remains unverified:** Page title, metrics/KPIs, tables, data panels, status indicators, error messages, and layout - the entire rendered view of `http://127.0.0.1:65172/ops-dashboard` is unverified.",
            "",
            "**Root cause:** The browser automation layer (Playwright subprocess) is non-functional in this session; the `detached_target` error appears in 9 separate attempts and is not a transient network condition against the target URL.",
            "",
            "**Next action for operator:** Restart the browser sub-agent session or clear the browser automation state before retrying. The page itself may be accessible once a healthy browser subprocess is available.",
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

  it("accepts mission-authorized attach failure closeouts as bounded browser failure", () => {
    const decision = evaluateMissionCompletion({
      mission: {
        ...mission,
        title: "Natural browser attach failure closeout",
        status: "blocked",
        blockers: 1,
        progress: 0.95,
        desc: [
          "Review this operations dashboard as a user would see it in the browser.",
          "Dashboard: http://127.0.0.1:61917/ops-dashboard",
          "If the browser cannot attach to the target page, close out with what was verified, what remains unverified, and the next action an operator should take.",
        ].join("\n"),
      },
      messages: [
        {
          ...message("a-attach-closeout", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "## Browser Failure Closeout Report - Ops Dashboard Review",
            "**Target URL:** http://127.0.0.1:61917/ops-dashboard",
            "**Failure bucket:** attach_failed=4.",
            "What was verified: Browser sub-agent failed 4 consecutive times with attach_failed: browser target attach failed while resolving the browser target. The failure occurred in the browser runtime before any connection was attempted to the dashboard URL.",
            "The target application is not the source of the failure.",
            "What remains unverified: rendered dashboard content, metrics, loading states, and browser-visible warnings remain unverified because the browser could not attach to the page.",
            "Next action for operator: restart or repair the browser runtime, then resubmit the review task; no further automated work can continue in this run.",
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

describe("mission-authorized partial/blocked closeout", () => {
  // Regression for MSN-0113: a mission that explicitly asks for a
  // blocked/partial outcome ("把结论标为 blocked/partial，必须写未验证") and
  // gets an HONEST partial answer must settle to a tagged non-success
  // terminal — NOT loop goal_slots_unverified recovery, NOT hang in working,
  // NOT be dressed up as plain done.
  const partialAuthorizingMission: Mission = {
    ...mission,
    status: "working",
    progress: 0,
    desc: [
      "调研 DeepSeek V4 Flash API 的可用 provider、是否支持 web search、以及价格。",
      "如果价格或 search 支持没有被来源明确验证，必须写“未验证”，并把 mission 结论标为 blocked/partial，不要包装成完成。",
    ].join("\n"),
  };

  const honestPartialAnswer = (createdAt: number): TeamMessage => ({
    ...message("a-final", "assistant", createdAt),
    roleId: "role-lead",
    name: "Lead",
    content: [
      "**结论：blocked / partial**",
      "| provider | 是否支持 DeepSeek V4 Flash | 输入价格 | 证据 URL |",
      "| OpenRouter | 已确认 | 未验证 | https://openrouter.ai/... |",
      "搜索参数支持：未验证（官方文档 404，未能确认）。",
      "缺口：价格与 search 支持尚未验证；下一步应核对 DeepSeek 官方定价页。",
    ].join("\n"),
  });

  it("settles an honest authorized partial answer to a tagged terminal (no recovery)", () => {
    const decision = evaluateMissionCompletion({
      mission: partialAuthorizingMission,
      messages: [
        { ...message("u-1", "user", 50), content: partialAuthorizingMission.desc },
        honestPartialAnswer(100),
      ],
      roleRuns: [idleRun],
      workerSessions: [],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "final_answer");
      assert.equal(decision.patch.status, "done");
      assert.equal(decision.patch.closeout, "bounded_failure");
      assert.notEqual(decision.patch.progress, 1); // not dressed up as complete
      assert.equal(decision.recovery, undefined); // no recovery loop
    }
  });

  it("recovers the already-stuck working mission instead of leaving it hung", () => {
    // The reproduction left the mission in working/progress 0 after recovery
    // exhaustion. A subsequent tick must converge it, not hang.
    const decision = evaluateMissionCompletion({
      mission: { ...partialAuthorizingMission, status: "working", progress: 0, blockers: 0 },
      messages: [
        { ...message("u-1", "user", 50), content: partialAuthorizingMission.desc },
        honestPartialAnswer(100),
      ],
      roleRuns: [idleRun],
      workerSessions: [],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.patch.status, "done");
      assert.equal(decision.patch.closeout, "bounded_failure");
    }
  });

  it("still recovers a NON-authorizing mission whose answer leaves slots unverified", () => {
    // Guard against over-correction: a mission that did NOT authorize partial
    // must still be caught by the goal-slot guard.
    const strictMission: Mission = {
      ...mission,
      status: "working",
      desc: "Research the pricing of the Acme API and give the exact input/output price.",
    };
    const decision = evaluateMissionCompletion({
      mission: strictMission,
      messages: [
        { ...message("u-1", "user", 50), content: strictMission.desc },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Pricing is not verified; I could not load the pricing page.",
        },
      ],
      roleRuns: [idleRun],
      workerSessions: [],
    });
    assert.equal(decision.action, "update");
    if (decision.action === "update") {
      assert.equal(decision.reason, "incomplete_final_answer");
      assert.equal(decision.recovery?.kind, "incomplete_final_answer");
    }
  });

  it("does not treat a fabricated 'done' as an authorized partial (no blocked/partial declared)", () => {
    const decision = evaluateMissionCompletion({
      mission: partialAuthorizingMission,
      messages: [
        { ...message("u-1", "user", 50), content: partialAuthorizingMission.desc },
        {
          ...message("a-final", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          // Claims completion, no blocked/partial declaration, no gaps surfaced.
          content: "All providers confirmed. OpenRouter input $0.27, output $0.41. Search supported everywhere.",
        },
      ],
      roleRuns: [idleRun],
      workerSessions: [],
    });
    // Must NOT settle via the authorized-partial branch (no closeout tag).
    if (decision.action === "update") {
      assert.notEqual(decision.patch.closeout, "bounded_failure");
    }
  });
});

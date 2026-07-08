import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityEvent, Mission } from "@turnkeyai/core-types/mission";
import type { RuntimeProgressEvent } from "@turnkeyai/core-types/team";
import { buildMissionObservabilitySnapshot } from "./mission-observability";

test("buildMissionObservabilitySnapshot summarizes mission tool/session quality signals", () => {
  const mission = baseMission({ status: "done" });
  const events: ActivityEvent[] = [
    event("user-1", "plan", 1_000, "user", "Compare products."),
    tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
    tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
    event(
      "final-1",
      "thought",
      5_000,
      "role-lead",
      [
        "Final answer based on verified source evidence from the tool result.",
        "The comparison is evidence-backed, the observed claim is confirmed by the gathered result, and the residual risk is limited to any source updates after this run.",
        "No unsupported future pricing or adoption claim is included.",
      ].join(" ")
    ),
  ];

  const snapshot = buildMissionObservabilitySnapshot({ mission, events, nowMs: 6_000 });

  assert.equal(snapshot.wallClockMs, 4_000);
  assert.equal(snapshot.timelineEventCount, 4);
  assert.deepEqual(snapshot.tool, {
    requested: 1,
    results: 1,
    executed: 1,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    timeouts: 0,
  });
  assert.deepEqual(snapshot.sessions, { spawned: 1, continued: 0 });
  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.finalAnswerEventId, "final-1");
  assert.equal(snapshot.qualityGate.evidenceEvents, 1);
});

test("buildMissionObservabilitySnapshot treats mission closeout as non-clean completion", () => {
  const mission = baseMission({ status: "done", closeout: "bounded_failure" });
  const events: ActivityEvent[] = [
    event("user-1", "plan", 1_000, "user", "Check whether the local source is reachable."),
    tool("call-1", 1_200, "call", "sessions_spawn", "call-browser", "Calling sessions_spawn"),
    tool(
      "result-1",
      1_700,
      "result",
      "sessions_spawn",
      "call-browser",
      "Tool sessions_spawn returned browser runtime evidence: CDP endpoint unavailable."
    ),
    event(
      "final-1",
      "thought",
      2_000,
      "role-lead",
      [
        "The browser runtime could not be reached.",
        "What was verified: the target URL was recorded.",
        "What remains unverified: live source freshness.",
        "Next action: retry after repairing browser automation.",
      ].join(" ")
    ),
  ];

  const snapshot = buildMissionObservabilitySnapshot({ mission, events, nowMs: 3_000 });

  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "mission_closeout")?.status, "warn");
});

test("buildMissionObservabilitySnapshot surfaces skipped timeout and missing residual risk", () => {
  const mission = baseMission({ status: "done" });
  const skipped = tool("result-skipped", 2_500, "result", "sessions_spawn", "call-skip", "Skipped by budget.");
  const failed = {
    ...tool("result-timeout", 3_000, "result", "sessions_send", "call-timeout", "sessions_send timed out."),
    emph: "danger" as const,
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 4_000,
    events: [
      tool("call-skip", 1_000, "call", "sessions_spawn", "call-skip", "Calling sessions_spawn"),
      { ...skipped, runtime: { ...skipped.runtime, admission: "skipped" } },
      tool("call-timeout", 2_800, "call", "sessions_send", "call-timeout", "Calling sessions_send"),
      failed,
      event("final-1", "thought", 3_500, "role-lead", "Final answer without caveats."),
    ],
  });

  assert.equal(snapshot.tool.skipped, 1);
  assert.equal(snapshot.tool.failed, 1);
  assert.equal(snapshot.tool.timeouts, 1);
  assert.equal(snapshot.sessions.spawned, 1);
  assert.equal(snapshot.sessions.continued, 1);
  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "residual_risk")?.status, "warn");
});

test("buildMissionObservabilitySnapshot does not count completed session results as timeout from stale text", () => {
  const mission = baseMission({ status: "done" });
  const result = tool(
    "result-completed",
    3_000,
    "result",
    "sessions_spawn",
    "call-browser",
    "Tool sessions_spawn returned: completed browser result; earlier timeout wording is historical."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 5_000,
    events: [
      tool("call-browser", 1_000, "call", "sessions_spawn", "call-browser", "Calling sessions_spawn"),
      {
        ...result,
        runtime: {
          ...result.runtime,
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            agent_id: "browser",
            final_content: "Approval form page evidence was captured after approval.",
          }),
        },
      },
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        "Final answer with verified browser evidence and residual risk."
      ),
    ],
  });

  assert.equal(snapshot.tool.timeouts, 0);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "failure_free")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores recovery memory text when counting tool timeouts", () => {
  const mission = baseMission({ status: "done" });
  const result = tool(
    "result-memory",
    3_000,
    "result",
    "memory_search",
    "call-memory",
    "Tool memory_search returned (7.9 kB)."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 5_000,
    events: [
      tool("call-memory", 1_000, "call", "memory_search", "call-memory", "Calling memory_search"),
      {
        ...result,
        runtime: {
          ...result.runtime,
          resultContent: JSON.stringify({
            query: "ops-dashboard browser session session_key rendered evidence",
            total_hits: 1,
            memories: [
              {
                content:
                  "Constraint: Automatic recovery attempt 2 of 2. Missing or unverified final-answer slots: rendered browser evidence (unverified). Earlier timeout wording is only recovery context.",
              },
            ],
          }),
        },
      },
      event("final-1", "thought", 4_000, "role-lead", "Final answer with verified browser evidence and residual risk."),
    ],
  });

  assert.equal(snapshot.tool.timeouts, 0);
  assert.equal(snapshot.qualityGate.evidenceEvents, 0);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "failure_free")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores stale incomplete-final recovery after mission is done", () => {
  const mission = baseMission({
    status: "done",
    desc: "请使用可用工具获取 https://example.com 的页面内容，然后只回答三项：1) 页面标题；2) 页面最核心的一句话；3) 你使用的证据 URL。",
  });
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 7_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "1) 页面标题：**Example Domain**",
          "",
          '2) 页面最核心的一句话：**"This domain is for use in documentation examples without needing permission. Avoid use in operations."**',
          "",
          "3) 证据 URL：**https://example.com/**",
        ].join("\n")
      ),
      {
        ...event("recovery-1", "recovery", 6_000, "system", "mission.incomplete_final_answer timeout recovery"),
        emph: "danger",
        runtime: {
          eventType: "mission.incomplete_final_answer",
          reason: "truncated_markdown",
          messageId: "final-1",
        },
      },
    ],
  });

  assert.notEqual(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.recovery.events, 0);
  assert.equal(snapshot.tool.timeouts, 0);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "failure_free")?.status, "pass");
});

test("buildMissionObservabilitySnapshot does not penalize concise answers when the mission requests them", () => {
  const mission = baseMission({
    status: "done",
    desc: "请使用可用工具获取 https://example.com 的页面内容，然后只回答三项：1) 页面标题；2) 页面最核心的一句话；3) 你使用的证据 URL。必须调用工具，不要只凭常识回答。",
  });
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 6_000,
    events: [
      event("user-1", "plan", 1_000, "user", mission.desc),
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence from https://example.com."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "1) 页面标题：**Example Domain**",
          "2) 页面最核心的一句话：**This domain is for use in documentation examples without needing permission.**",
          "3) 证据 URL：**https://example.com/**",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "residual_risk")?.status, "pass");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "answer_substance")?.status, "pass");
});

test("buildMissionObservabilitySnapshot downgrades recovered timeout failures to attention", () => {
  const mission = baseMission({ status: "done" });
  const failed = {
    ...tool("result-timeout", 3_000, "result", "sessions_send", "call-timeout", "sessions_send timed out."),
    emph: "danger" as const,
  };
  const finalAnswer = event(
    "final-1",
    "thought",
    4_000,
    "role-lead",
    [
      "Verified source-bounded timeout closeout based on gathered tool evidence.",
      "The answer explains what was confirmed and what was not.",
      "Residual risk remains because the slow source timed out before a fully clean rerun.",
    ].join(" ")
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 5_000,
    events: [
      tool("call-timeout", 2_800, "call", "sessions_send", "call-timeout", "Calling sessions_send"),
      failed,
      {
        ...finalAnswer,
        runtime: {
          ...finalAnswer.runtime,
          toolLoopCloseout: "true",
          toolLoopCloseoutReason: "sub_agent_timeout",
          "toolLoopCloseout.roundCount": "3",
          "toolLoopCloseout.toolCallCount": "3",
          "toolLoopCloseout.toolName": "sessions_send",
          "toolLoopCloseout.evidenceAvailable": "true",
        },
      },
    ],
  });

  assert.equal(snapshot.tool.failed, 1);
  assert.equal(snapshot.tool.timeouts, 1);
  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "failure_free")?.status, "warn");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "failure_free")?.detail ?? "",
    /bounded timeout recovery/
  );
});

test("buildMissionObservabilitySnapshot recognizes source-bounded transport timeout finals", () => {
  const mission = baseMission({ status: "done" });
  const failed = {
    ...tool(
      "result-timeout",
      3_000,
      "result",
      "sessions_spawn",
      "call-timeout",
      "Tool sessions_spawn failed: page.goto: Timeout 10000ms exceeded"
    ),
    emph: "danger" as const,
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 5_000,
    events: [
      tool("call-timeout", 2_800, "call", "sessions_spawn", "call-timeout", "Calling sessions_spawn"),
      failed,
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "Transport failure observed: page.goto timeout before DOMContentLoaded.",
          "Verified: no HTTP response, status, body, or screenshot was captured.",
          "Unverified: final URL, page title, visible text, console errors, and network details.",
          "Residual risk: continue with a bounded retry before treating the source as healthy.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.tool.failed, 1);
  assert.equal(snapshot.tool.timeouts, 1);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "failure_free")?.status, "warn");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "failure_free")?.detail ?? "",
    /bounded timeout recovery/
  );
});

test("buildMissionObservabilitySnapshot accepts authorized bounded timeout closeout with no gathered response", () => {
  const mission = baseMission({
    status: "done",
    title: "Natural timeout follow-up continuation",
    desc: [
      "Evaluate this slow source for a release-risk note.",
      "Slow source: http://127.0.0.1:60382/slow-fixture",
      "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how to continue.",
    ].join("\n"),
  });
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", mission.desc),
      {
        ...tool("result-timeout", 3_000, "result", "sessions_spawn", "call-timeout", "sessions_spawn timed out with evidence_available=true."),
        emph: "danger" as const,
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "## Release-Risk Assessment: slow-fixture",
          "**Connection status**: Timeout — no response received within 30s bounded attempt.",
          "**Evidence gathered**: None — session paused before completing fetch or content capture.",
          "**Unverified items**: HTTP status, headers, body, and release-risk content remain unverified.",
          "**How to continue**: retry the same source-check with a longer timeout before using it for release gating.",
          "Residual risk: source-bounded timeout evidence only.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts table-shaped authorized bounded timeout closeouts", () => {
  const mission = baseMission({
    status: "done",
    title: "Natural timeout follow-up continuation",
    desc: [
      "Evaluate this slow source for a release-risk note.",
      "Slow source: http://127.0.0.1:60382/slow-fixture",
      "Use a bounded attempt first. If the source does not return in time, close out with the evidence that is available and explain how to continue.",
    ].join("\n"),
  });
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", mission.desc),
      {
        ...tool("result-timeout", 3_000, "result", "sessions_spawn", "call-timeout", "sessions_spawn timed out with evidence_available=true."),
        emph: "danger" as const,
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "## Source Evaluation - Release-Risk Note",
          "| Field | Value |",
          "|---|---|",
          "| Source | `http://127.0.0.1:60382/slow-fixture` |",
          "| Status | Timed out after a bounded 30 s attempt |",
          "| Content received | None - no headers, body, or error details captured |",
          "| Owner | Not verified |",
          "| Mitigation | Retry the same source-check with a longer bounded timeout before release use |",
          "Residual risk: release-risk facts remain source-bounded because the endpoint did not respond.",
          "How to continue: resume this same source-check context or retry with an increased timeout.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot keeps active missions running while final answer is pending", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "working" }),
    nowMs: 3_000,
    events: [event("user-1", "plan", 1_000, "user", "Run task")],
  });

  assert.equal(snapshot.qualityGate.status, "running");
  assert.equal(snapshot.wallClockMs, 2_000);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "pending");
});

test("buildMissionObservabilitySnapshot ignores a stale final answer after a follow-up", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "working" }),
    nowMs: 6_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Initial task."),
      event(
        "final-old",
        "thought",
        2_000,
        "role-lead",
        "Initial final answer based on source evidence with residual risk."
      ),
      event("user-2", "plan", 5_000, "user", "Follow up."),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "running");
  assert.equal(snapshot.qualityGate.finalAnswerEventId, undefined);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "pending");
});

test("buildMissionObservabilitySnapshot lets a later tool turn stale a prior final answer", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Initial task."),
      tool("result-1", 1_500, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      event(
        "final-old",
        "thought",
        2_000,
        "role-lead",
        "Initial final answer based on source evidence with residual risk."
      ),
      event("user-2", "plan", 3_000, "user", "Follow up."),
      tool("call-2", 4_000, "call", "sessions_send", "call-b", "Calling sessions_send"),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.finalAnswerEventId, undefined);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "fail");
});

test("buildMissionObservabilitySnapshot accepts the current final answer after a follow-up", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Initial task."),
      event(
        "final-old",
        "thought",
        2_000,
        "role-lead",
        "Initial final answer based on source evidence with residual risk."
      ),
      event("user-2", "plan", 3_000, "user", "Follow up."),
      tool("result-2", 4_000, "result", "sessions_send", "call-b", "Tool sessions_send returned evidence."),
      event(
        "final-new",
        "thought",
        5_000,
        "role-lead",
        "Follow-up final answer based on source evidence from the continuation result, with residual risk noted."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.finalAnswerEventId, "final-new");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "pass");
});

test("buildMissionObservabilitySnapshot does not accept a final answer before a pending tool result", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Check the browser page."),
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      event(
        "final-early",
        "thought",
        3_000,
        "role-lead",
        "Final answer based on source evidence from the browser, with residual risk noted."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.finalAnswerEventId, undefined);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "fail");
});

test("buildMissionObservabilitySnapshot accepts a final answer after all prior tool calls have results", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Check the browser page."),
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 3_000, "result", "sessions_spawn", "call-a", "Browser evidence collected."),
      event(
        "final-after-result",
        "thought",
        4_000,
        "role-lead",
        "Final answer based on source evidence from the browser tool result, with residual risk noted."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.finalAnswerEventId, "final-after-result");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "pass");
});

test("buildMissionObservabilitySnapshot does not treat lifecycle status text as a final answer", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare the two vendor pages and cite evidence."),
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 3_000, "result", "sessions_spawn", "call-a", "Browser evidence collected."),
      event("status-1", "thought", 4_000, "role-lead", "Lead finished this turn."),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.finalAnswerEventId, undefined);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "fail");
});

test("buildMissionObservabilitySnapshot does not treat dispatch wake text as a final answer", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare the two vendor pages and cite evidence."),
      event("status-1", "thought", 2_000, "role-lead", "Woke role-lead to start work."),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.finalAnswerEventId, undefined);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "fail");
});

test("buildMissionObservabilitySnapshot accepts final answers when a tool result is timestamped before its call", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Fetch and cite the browser page."),
      tool(
        "result-1",
        2_000,
        "result",
        "web_fetch",
        "call-1",
        "Tool web_fetch returned Example Domain evidence from https://example.com/."
      ),
      tool("call-1", 2_001, "call", "web_fetch", "call-1", "Calling web_fetch."),
      event(
        "final-after-result",
        "thought",
        3_000,
        "role-lead",
        [
          "| URL | title | key quote | evidence method |",
          "|---|---|---|---|",
          '| https://example.com/ | Example Domain | "This domain is for use in documentation examples without needing permission." | HTTP 200 page content extraction |',
          "",
          "Residual risk: the page may change after this run.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.finalAnswerEventId, "final-after-result");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "final_answer")?.status, "pass");
});

test("buildMissionObservabilitySnapshot counts multi-source session payload pages as separate evidence", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare Vendor Alpha and Vendor Beta from both source pages."),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          payload: {
            pages: [
              {
                finalUrl: "http://127.0.0.1:65210/vendor-alpha",
                title: "Vendor Alpha Evidence",
                textExcerpt: "Pricing: $19 per seat.",
              },
              {
                finalUrl: "http://127.0.0.1:65210/vendor-beta",
                title: "Vendor Beta Evidence",
                textExcerpt: "Pricing: $29 per workspace.",
              },
            ],
            sourceResults: [
              { status: "completed", label: "http://127.0.0.1:65210/vendor-alpha" },
              { status: "completed", label: "http://127.0.0.1:65210/vendor-beta" },
            ],
          },
          result: "Explore worker fetched 2 of 2 sources.",
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        "Vendor Alpha is $19 per seat and Vendor Beta is $29 per workspace. Recommendation: choose Alpha, with residual risk around source freshness."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.evidenceEvents, 2);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "evidence_backed")?.status, "pass");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot counts compacted multi-source evidence summaries", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare Vendor Alpha and Vendor Beta from both source pages."),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: [
            "Source 1:",
            "Final URL: http://127.0.0.1:65210/vendor-alpha",
            "Page title: Vendor Alpha Evidence",
            "Excerpt: Pricing: $19 per seat.",
            "Source 2:",
            "Final URL: http://127.0.0.1:65210/vendor-beta",
            "Page title: Vendor Beta Evidence",
            "Excerpt: Pricing: $29 per workspace.",
          ].join("\n"),
          result: "Explore worker fetched 2 of 2 sources.",
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        "Vendor Alpha is $19 per seat and Vendor Beta is $29 per workspace. Recommendation: choose Alpha, with residual risk around source freshness."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.evidenceEvents, 2);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot does not require quoted excerpts for generic evidence-bounded requests", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Compare Vendor Alpha and Vendor Beta.",
      desc: "Use only evidence you collected during this mission.",
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare Vendor Alpha and Vendor Beta. Use only evidence you collected during this mission."),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: [
            "Source 1:",
            "Page title: Vendor Alpha Evidence",
            "Excerpt: Pricing: $19 per seat.",
            "Source 2:",
            "Page title: Vendor Beta Evidence",
            "Excerpt: Pricing: $29 per workspace.",
          ].join("\n"),
          result: "Explore worker fetched 2 of 2 sources.",
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        "Vendor Alpha is $19 per seat and Vendor Beta is $29 per workspace. Recommendation: choose Alpha; residual risk is source freshness."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts rendered browser evidence with bounded residual risk", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Review this operations dashboard as a user would see it in the browser.",
      desc: "The useful evidence may be rendered by client-side JavaScript after the HTML loads. Summarize the operational state, escalation trigger, owner, recommended next action, and residual risk.",
    }),
    nowMs: 7_000,
    events: [
      event(
        "user-1",
        "plan",
        1_000,
        "user",
        "Review this operations dashboard as a user would see it in the browser. The useful evidence may be rendered by client-side JavaScript after the HTML loads."
      ),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: "Browser observed Operations Dashboard Fixture. Visible text excerpt: Queue depth: 11 SLA breaches: 3.",
          result: "Browser worker completed rendered dashboard review.",
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "Rendering: Client-side JavaScript confirmed via browser DOM. Screenshot captured.",
          "Operational state: queue depth 11 and 3 SLA breaches exceed thresholds.",
          "Recommended next action: page the on-call immediately. Owner: Incident Commander.",
          "Residual risk: backend health is not verified from browser view alone, and real-time data freshness is not confirmed.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts rendered facts with bounded screenshot and DOM limitations", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Natural browser CDP timeout closeout",
      desc: [
        "Review the operations dashboard at http://127.0.0.1:54581/ops-dashboard as a user would see it in the browser.",
        "Capture the rendered page content, including JavaScript-rendered metrics, status indicators, and operational data visible to a user.",
        "Take a screenshot if possible.",
      ].join("\n"),
    }),
    nowMs: 7_000,
    events: [
      tool("result-1", 2_000, "result", "sessions_spawn", "call-1", "Browser worker returned rendered dashboard evidence with cdp_command_timeout=2."),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "## Browser CDP Timeout Closeout",
          "Page Title: Operations Dashboard Fixture.",
          "What Was Verified: browser-rendered dashboard evidence captured visible text and metrics.",
          "Triage status: TURNKEYAI_DASHBOARD_TRIAGE_OK.",
          "Queue depth: 11.",
          "SLA breaches: 3.",
          "Escalation threshold: queue depth above 5 or SLA breaches above 0.",
          "Recommended owner: Incident Commander.",
          "Screenshot artifact not captured due to CDP command timeout on snapshot.",
          "Full DOM/tree traversal blocked by repeated CDP timeouts.",
          "Additional widgets, charts, drill-down tables, or lazy-loaded panels below the initial viewport cannot be confirmed.",
          "Residual risk: browser evidence is bounded to the verified visible dashboard facts.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot counts browser failure buckets from runtime progress events", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Natural browser CDP timeout closeout",
      desc: [
        "Review the operations dashboard at http://127.0.0.1:54581/ops-dashboard as a user would see it in the browser.",
        "If the browser times out while capturing the rendered page, close out with verified and unverified scope.",
      ].join("\n"),
    }),
    nowMs: 7_000,
    events: [
      tool("result-1", 2_000, "result", "sessions_spawn", "call-1", "Browser worker returned rendered dashboard evidence."),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "## Browser CDP Timeout Closeout",
          "What Was Verified: Page title Operations Dashboard Fixture; queue depth 11; SLA breaches 3; owner Incident Commander.",
          "What remains unverified: full DOM structure because the browser snapshot timed out.",
          "Next action: retry capture with a longer CDP timeout if full page structure is required.",
          "Residual risk: browser evidence is bounded to recovered visible text.",
        ].join("\n")
      ),
    ],
    progressEvents: [
      {
        progressId: "progress-browser-bucket",
        threadId: "thread-1",
        subjectKind: "worker_run",
        subjectId: "worker:browser:1",
        phase: "completed",
        summary: "Browser failure buckets: cdp_command_timeout=5. Browser rendered evidence recovered via console probe.",
        recordedAt: 3_000,
        workerType: "browser",
        metadata: { toolName: "browser_snapshot" },
      },
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, [
    { bucket: "cdp_command_timeout", count: 1, latestAtMs: 3_000 },
  ]);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "warn");
});

test("buildMissionObservabilitySnapshot accepts authorized bounded browser failure closeouts for rendered browser slots", () => {
  const desc = [
    "Review the operations dashboard at http://127.0.0.1:53117/ops-dashboard as a user would see it in the browser.",
    "Capture the rendered page content, including JavaScript-rendered metrics, status indicators, and operational data visible to a user.",
    "If the browser target detaches while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
  ].join("\n");
  const finalText = [
    "## Browser Detached Target - Closeout",
    "**Source:** `http://127.0.0.1:53117/ops-dashboard`",
    "### (1) What was verified",
    "- The URL `http://127.0.0.1:53117/ops-dashboard` was contacted three times; all attempts produced a `detached_target` error before any page content or DOM snapshot could be retrieved.",
    "### (2) What remains unverified",
    "- All operations dashboard content, metrics, tables, status indicators, UI elements, and client-side rendered JavaScript are not verified.",
    "### (3) Next action an operator should take",
    "- Diagnose why the browser target is detaching on that local endpoint, then re-run this dashboard review task once the browser runtime is stable.",
  ].join("\n");

  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      closeout: "bounded_failure",
      title: "Natural browser detached target closeout",
      desc,
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", desc),
      tool("result-1", 3_000, "result", "sessions_spawn", "call-browser", "Browser worker returned detached_target=2 failure evidence."),
      event("final-1", "thought", 5_000, "role-lead", finalText),
    ],
  });

  const goalSlotCheck = snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage");
  assert.equal(goalSlotCheck?.status, "pass");
  assert.match(
    goalSlotCheck?.detail ?? "",
    /mission-authorized bounded browser failure|All goal-critical slots inferred/u
  );
});

test("buildMissionObservabilitySnapshot accepts goal-authorized browser failure closeouts without a closeout tag", () => {
  const desc = [
    "Review this operations dashboard as a user would see it in the browser.",
    "Dashboard: http://127.0.0.1:65172/ops-dashboard",
    "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
    "If the browser target detaches while capturing the rendered page, close out with what was verified, what remains unverified, and the next action an operator should take.",
  ].join("\n");
  const finalText = [
    "**What was verified:** None - the browser target detached before any page content could be captured.",
    "",
    "**What remains unverified:** Page title, metrics/KPIs, tables, data panels, status indicators, error messages, and layout - the entire rendered view of `http://127.0.0.1:65172/ops-dashboard` is unverified.",
    "",
    "**Root cause:** The browser automation layer is non-functional in this session; the `detached_target` error appears in 9 separate attempts and is not a transient network condition against the target URL.",
    "",
    "**Next action for operator:** Restart the browser sub-agent session or clear the browser automation state before retrying. The page itself may be accessible once a healthy browser subprocess is available.",
  ].join("\n");

  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Natural browser detached target closeout",
      desc,
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", desc),
      tool("result-1", 3_000, "result", "sessions_spawn", "call-browser", "Browser worker returned detached_target=9 failure evidence."),
      event("final-1", "thought", 5_000, "role-lead", finalText),
    ],
  });

  const goalSlotCheck = snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage");
  assert.equal(goalSlotCheck?.status, "pass");
  assert.match(
    goalSlotCheck?.detail ?? "",
    /mission-authorized bounded browser failure|All goal-critical slots inferred/u
  );
});

test("buildMissionObservabilitySnapshot still blocks rendered browser failures without a bounded closeout", () => {
  const desc = [
    "Review the operations dashboard at http://127.0.0.1:53117/ops-dashboard as a user would see it in the browser.",
    "Capture the rendered page content, including JavaScript-rendered metrics, status indicators, and operational data visible to a user.",
  ].join("\n");
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Natural browser detached target closeout",
      desc,
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", desc),
      tool("result-1", 3_000, "result", "sessions_spawn", "call-browser", "Browser worker returned detached_target=2 failure evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "What was verified: the browser target detached before page content was captured.",
          "What remains unverified: rendered dashboard content is not verified.",
          "Next action: diagnose the browser target and retry.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "fail");
});

test("buildMissionObservabilitySnapshot accepts approved dry-run post-submit page evidence", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Natural approval dry-run action",
      desc: [
        "Open the local approval form and prepare a safe dry-run browser form submission for operator review.",
        "Actually carry the safe local dry-run through the approval gate.",
        "The browser task must verify the rendered post-submit page state.",
      ].join("\n"),
    }),
    nowMs: 7_000,
    events: [
      event(
        "user-1",
        "plan",
        1_000,
        "user",
        "Open the local approval form and carry the safe dry-run through the approval gate with rendered browser evidence."
      ),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary:
            "Browser observed approval form. Visible text excerpt: Dry-run submitted locally after approval; no external mutation was performed.",
          result: "Browser worker completed approval form submission evidence.",
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "| Item | Detail |",
          "|------|--------|",
          "| Approved action | `browser.form.submit` on `http://127.0.0.1:56469/approval-form` |",
          "| Pre-submit page state | `Dry-run has not been submitted.` |",
          "| Post-submit page state | `Dry-run submitted locally after approval; no external mutation was performed.` |",
          "| Fixture marker | `TURNKEYAI_APPROVAL_FIXTURE_OK` |",
          "Residual risk: this verifies only the local dry-run fixture; external mutation scope was not exercised or verified.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores automatic recovery prompts when inferring goal slots", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Natural browser dynamic page",
      desc: [
        "Review this operations dashboard as a user would see it in the browser.",
        "The useful evidence may be rendered by client-side JavaScript after the HTML loads.",
        "Summarize the operational state, escalation trigger, owner, recommended next action, and residual risk.",
      ].join("\n"),
    }),
    nowMs: 7_000,
    events: [
      event(
        "user-1",
        "plan",
        1_000,
        "user",
        "Review this operations dashboard as a user would see it in the browser. The useful evidence may be rendered by client-side JavaScript after the HTML loads."
      ),
      event(
        "user-recovery",
        "plan",
        3_000,
        "user",
        [
          "System recovery: the previous final answer did not satisfy required goal slots.",
          "Automatic recovery attempt 1 of 2.",
          "Continue the original mission instead of closing it.",
          "Do not introduce provider/search/model-support columns unless the original mission explicitly requested provider, search/web_search, or model-support evidence.",
        ].join("\n")
      ),
      tool(
        "result-1",
        4_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: "Browser observed Operations Dashboard Fixture. Visible text excerpt: Queue depth: 11 SLA breaches: 3.",
          result: "Browser worker completed rendered dashboard review.",
        })
      ),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Rendering: fully rendered browser evidence was captured.",
          "Operational state: queue depth 11 and 3 SLA breaches exceed thresholds.",
          "Escalation trigger: queue depth above 5 and SLA breaches above 0.",
          "Recommended next action: page the on-call immediately. Owner: Incident Commander.",
          "Residual risk: fixture evidence only; production freshness remains unverified.",
        ].join("\n")
      ),
    ],
  });

  const goalSlotCheck = snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage");
  assert.equal(goalSlotCheck?.status, "pass");
  assert.doesNotMatch(goalSlotCheck?.detail ?? "", /provider support|search support/i);
});

test("buildMissionObservabilitySnapshot accepts source-bounded residual risk after completed long-delegation browser evidence", () => {
  const mission = baseMission({
    status: "done",
    title: "Natural long delegation brief",
    desc: [
      "Prepare a product-ready brief about the next agent workbench release.",
      "Research source: http://127.0.0.1/product-orchestration",
      "Capability source: http://127.0.0.1/product-bridge",
      "Live signal dashboard: http://127.0.0.1/product-signals",
      "These are three independent evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
      "Do not finalize until all three evidence streams have returned. The live signal dashboard must be inspected as rendered browser evidence, not raw HTML.",
      "The final brief should tell a product leader what to build next, why it matters, what not to over-emphasize, and what risk remains.",
    ].join("\n"),
  });
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", mission.desc),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: "Product orchestration evidence: multi-agent decomposition with durable sub-session history.",
        })
      ),
      tool(
        "result-2",
        3_000,
        "result",
        "sessions_spawn",
        "call-2",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: "Product bridge evidence: browser bridge controls command-line setup, provider configuration, DOM, screenshots, and artifacts.",
        })
      ),
      tool(
        "result-3",
        4_000,
        "result",
        "sessions_spawn",
        "call-3",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: "Rendered browser evidence from live signal dashboard: Mission Control, Stuck missions: 6, Weak-answer rate: 24%.",
        })
      ),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "All three evidence streams have returned.",
          "## Completed Browser Evidence",
          "- Product orchestration: multi-agent decomposition with durable sub-session history.",
          "- Product bridge: browser bridge controls command-line setup, provider configuration, DOM, screenshots, and artifacts.",
          "- Live signal dashboard rendered in browser: Mission Control, Stuck missions: 6, Weak-answer rate: 24%.",
          "## Product recommendation",
          "Build the next release around stuck-mission recovery, weak-answer reduction, and visible browser evidence replay.",
          "## Residual risk",
          "This is source-bounded evidence from local fixture pages, not live production. Production adoption, customer impact, and post-run source updates were not audited production evidence.",
        ].join("\n")
      ),
    ],
  });

  const goalSlotCheck = snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage");
  assert.equal(goalSlotCheck?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts unverified production-only risk after completed product brief evidence", () => {
  const mission = baseMission({
    status: "done",
    title: "Natural long delegation brief",
    desc: [
      "Prepare a product-ready brief about the next agent workbench release.",
      "Research source: http://127.0.0.1/product-orchestration",
      "Capability source: http://127.0.0.1/product-bridge",
      "Live signal dashboard: http://127.0.0.1/product-signals",
      "These are three independent evidence streams. Use specialist work where it helps, and use browser-visible evidence for the live signal dashboard.",
      "The final brief should tell a product leader what to build next, why it matters, what not to over-emphasize, and what risk remains.",
    ].join("\n"),
  });
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", mission.desc),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        completedSessionResultContent("worker:explore:orchestration", "Product orchestration evidence: multi-agent decomposition.")
      ),
      tool(
        "result-2",
        3_000,
        "result",
        "sessions_spawn",
        "call-2",
        completedSessionResultContent("worker:explore:bridge", "Product bridge evidence: browser bridge controls and artifacts.")
      ),
      tool(
        "result-3",
        4_000,
        "result",
        "sessions_spawn",
        "call-3",
        completedSessionResultContent(
          "worker:browser:signals",
          "Rendered browser evidence from live signal dashboard: Mission Control, Stuck missions: 6, Weak-answer rate: 24%."
        )
      ),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "All three evidence streams have returned.",
          "Product orchestration: multi-agent decomposition.",
          "Product bridge: browser bridge controls and artifacts.",
          "Live signal dashboard rendered browser evidence: Mission Control, Stuck missions: 6, Weak-answer rate: 24%.",
          "Recommendation: make Mission Control the default entry point.",
          "Residual risk: customer adoption, production telemetry, and post-run source updates remain unverified outside this local fixture evidence.",
        ].join("\n")
      ),
    ],
  });

  const goalSlotCheck = snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage");
  assert.equal(goalSlotCheck?.status, "pass");
});

test("buildMissionObservabilitySnapshot blocks final answers that contradict numeric evidence values", () => {
  const mission = baseMission({
    status: "done",
    title: "Natural long delegation brief",
    desc: [
      "Prepare a product-ready brief about the next agent workbench release.",
      "Live signal dashboard: http://127.0.0.1/product-signals",
      "The final brief must explicitly include Mission Control, Stuck missions, Weak answer rate, and the signal-dashboard recommended next action when those values are present.",
    ].join("\n"),
  });
  const snapshot = buildMissionObservabilitySnapshot({
    mission,
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", mission.desc),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        completedSessionResultContent(
          "worker:browser:signals",
          "Rendered browser evidence from live signal dashboard: Mission Control, Stuck missions: 6, Weak answer rate: 24%, Recommended next action: make Mission Control the default entry."
        )
      ),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Mission Control should be the default entry.",
          "Signals: Stuck missions: 24, Weak answer rate: 24%.",
          "Recommended next action: make Mission Control the default entry.",
          "Residual risk: local fixture evidence only.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  const valueCheck = snapshot.qualityGate.checks.find((check) => check.name === "evidence_value_consistency");
  assert.equal(valueCheck?.status, "fail");
  assert.match(valueCheck?.detail ?? "", /Stuck missions final=24, evidence=6/);
});

test("buildMissionObservabilitySnapshot accepts verified pricing with bounded unverified sub-scope", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Review Vendor Alpha pricing, strength, and risk.",
      desc: "Focus on pricing, strength, and risk, and keep source labels visible in the answer.",
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Review Vendor Alpha pricing, strength, and risk."),
      tool(
        "result-1",
        2_000,
        "result",
        "sessions_spawn",
        "call-1",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          evidence_summary: "Source 1:\nPage title: Vendor Alpha Evidence\nExcerpt: Pricing: $19 per seat. Strength: browser automation. Risk: API integration catalog is still limited.",
          result: "Explore worker fetched Vendor Alpha.",
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "**Vendor Alpha — Source-Backed Review**",
          "Pricing: $19 per seat.",
          "Strength: browser automation and traceable screenshots.",
          "Risk: API integration catalog is still limited.",
          "Not verified: seat minimums, billing cycle, feature tiers, SLA terms, security posture, or roadmap.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts multi-source price evidence with price/pricing label variants", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Compare Vendor Alpha and Vendor Beta pricing.",
      desc: "Gather Vendor Alpha and Vendor Beta pricing, then recommend a source-bounded choice with residual risk.",
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare Vendor Alpha and Vendor Beta pricing."),
      tool(
        "result-alpha",
        2_000,
        "result",
        "sessions_spawn",
        "call-alpha",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          label: "Vendor Alpha",
          evidence_summary: "Explore worker fetched Vendor Alpha Evidence.\nPrice lines: Pricing: $19 per seat.",
        })
      ),
      tool(
        "result-beta",
        3_000,
        "result",
        "sessions_spawn",
        "call-beta",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          label: "Vendor Beta",
          evidence_summary: "Explore worker fetched Vendor Beta Evidence.\nPrice lines: Pricing: $29 per workspace.",
          final_content: "| Field | Verified Value |\n|---|---|\n| Price | $29 per workspace |",
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "source coverage",
          "- Vendor Alpha (TURNKEYAI_VENDOR_ALPHA_OK): price $19 per seat, strength browser automation and traceable screenshots, risk API integration catalog is still limited.",
          "- Vendor Beta (TURNKEYAI_VENDOR_BETA_OK): price $29 per workspace, strength approval workflow and team handoff history, risk browser control requires a separate connector.",
          "recommendation",
          "- recommendation: TURNKEYAI_MISSION_REALISTIC_BRIEF_OK - select Vendor Alpha for agent workbench effort, driven by lower price $19 per seat versus $29 per workspace and browser-native automation eliminating the separate connector risk present in Vendor Beta.",
          "residual risk",
          "- residual risk: pricing recurrence and external availability are source-bounded to local fixtures.",
        ].join("\n")
      ),
    ],
  });

  const valueCheck = snapshot.qualityGate.checks.find((check) => check.name === "evidence_value_consistency");
  assert.equal(valueCheck?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores localhost URL numbers in source evidence values", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Compare Vendor Alpha pricing.",
      desc: "Gather Vendor Alpha pricing from the local source page.",
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare Vendor Alpha pricing."),
      tool(
        "result-alpha",
        2_000,
        "result",
        "sessions_spawn",
        "call-alpha",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          label: "Vendor Alpha",
          evidence_summary: [
            "Explore worker fetched Vendor Alpha Evidence.",
            "Final URL: http://127.0.0.1:62013/vendor-alpha",
            "Price lines: Pricing: $19 per seat.",
          ].join("\n"),
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        "Vendor Alpha source coverage: price $19 per seat; residual risk is source-bounded to the local fixture."
      ),
    ],
  });

  const valueCheck = snapshot.qualityGate.checks.find((check) => check.name === "evidence_value_consistency");
  assert.equal(valueCheck?.status, "pass");
});

test("buildMissionObservabilitySnapshot blocks vendor price contradictions instead of URL digit mismatches", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Compare Vendor Alpha pricing.",
      desc: "Gather Vendor Alpha pricing from the local source page.",
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Compare Vendor Alpha pricing."),
      tool(
        "result-alpha",
        2_000,
        "result",
        "sessions_spawn",
        "call-alpha",
        JSON.stringify({
          protocol: "turnkeyai.session_tool_result.v1",
          status: "completed",
          label: "Vendor Alpha",
          evidence_summary: [
            "Explore worker fetched Vendor Alpha Evidence.",
            "Final URL: http://127.0.0.1:62013/vendor-alpha",
            "Price lines: Pricing: $19 per seat.",
          ].join("\n"),
        })
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        "Vendor Alpha source coverage: price $10 per seat; residual risk is source-bounded to the local fixture."
      ),
    ],
  });

  const valueCheck = snapshot.qualityGate.checks.find((check) => check.name === "evidence_value_consistency");
  assert.equal(valueCheck?.status, "fail");
  assert.match(valueCheck?.detail ?? "", /Price final=\$10, evidence=\$19/);
  assert.doesNotMatch(valueCheck?.detail ?? "", /Vendor alpha final=\$10, evidence=1/);
});

test("buildMissionObservabilitySnapshot accepts a concrete price with unverified pricing sub-scope notes", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Review Vendor Alpha pricing, strength, and risk.",
      desc: "Focus on pricing, strength, and risk, and keep source labels visible in the answer.",
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Review Vendor Alpha pricing, strength, and risk."),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "**Vendor Alpha — Product Lead Review**",
          "**Pricing**",
          "- $19 per seat. [Source 1]",
          "**Strengths**",
          "- Browser automation and traceable screenshots.",
          "**Risks**",
          "- API integration catalog is still limited.",
          "**Notes for comparison**",
          "- No enterprise/annual plans, usage tiers, or feature-gated tiers verified from source. Billing model (per-seat flat) is the only confirmed pricing detail.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts verified workspace pricing with unconfirmed seat equivalence", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Compare Vendor Alpha and Vendor Beta pricing, strengths, risks, and tradeoff.",
      desc: "Return a recommendation that compares pricing, strengths, risks, and the tradeoff that matters most.",
    }),
    nowMs: 7_000,
    events: [
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        [
          "### Pricing",
          "- Vendor Alpha: $19 per seat.",
          "- Vendor Beta: $29 per workspace (seat-count equivalence not confirmed).",
          "### Risks",
          "- Vendor Alpha: API integration catalog is still limited.",
          "- Vendor Beta: Browser control requires a separate connector.",
          "### Recommendation",
          "Choose Vendor Alpha when browser automation and price matter most; choose Vendor Beta when approval workflow matters more.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot still blocks explicitly unverified pricing", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      title: "Review Vendor Alpha pricing.",
      desc: "Focus on pricing.",
    }),
    nowMs: 7_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Review Vendor Alpha pricing."),
      event("final-1", "thought", 4_000, "role-lead", "Pricing: not verified."),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "fail");
});

test("buildMissionObservabilitySnapshot marks stale runtime progress as blocked", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "working" }),
    nowMs: 20_000,
    events: [event("user-1", "plan", 1_000, "user", "Run task")],
    progressEvents: [
      progress("role:lead", "role_run", "heartbeat", "alive", 10_000, 15_000, "Lead is still working."),
      progress("worker:browser:1", "worker_run", "waiting", "waiting", 18_000, 30_000, "Browser worker is waiting."),
      progress("worker:done", "worker_run", "completed", "resolved", 19_000, 19_500, "Done worker."),
    ],
  });

  assert.equal(snapshot.liveness.active, 1);
  assert.equal(snapshot.liveness.waiting, 1);
  assert.equal(snapshot.liveness.stale, 1);
  assert.equal(snapshot.liveness.lastProgressAtMs, 19_000);
  assert.equal(snapshot.liveness.staleSubjects[0]?.subjectId, "role:lead");
  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "runtime_liveness")?.status, "fail");
});

test("buildMissionObservabilitySnapshot lets terminal task progress dominate late heartbeats", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 20_000,
    events: [
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer based on source evidence, with residual risk noted for unverified follow-up scope."
      ),
    ],
    progressEvents: [
      progress("role:lead", "role_run", "started", "alive", 10_000, 15_000, "Lead started.", "task-1"),
      progress("role:lead", "role_run", "completed", "resolved", 12_000, 12_500, "Lead completed.", "task-1"),
      progress("role:lead", "role_run", "heartbeat", "alive", 13_000, 18_000, "Late heartbeat.", "task-1"),
    ],
  });

  assert.equal(snapshot.liveness.active, 0);
  assert.equal(snapshot.liveness.waiting, 0);
  assert.equal(snapshot.liveness.stale, 0);
  assert.equal(snapshot.liveness.lastProgressAtMs, 12_000);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "runtime_liveness")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats timeout close progress as non-active", () => {
  const degraded = {
    ...progress(
      "worker:explore:timeout",
      "worker_run",
      "degraded",
      "transient_failure",
      12_000,
      13_000,
      "Worker interrupted and marked resumable.",
      "task-1"
    ),
    closeKind: "timeout" as const,
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 20_000,
    events: [
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "sessions_spawn timed out."),
      event("final-1", "thought", 5_000, "role-lead", "Final answer with residual risk."),
    ],
    progressEvents: [
      progress("worker:explore:timeout", "worker_run", "started", "alive", 10_000, 15_000, "Worker started.", "task-1"),
      degraded,
    ],
  });

  assert.equal(snapshot.liveness.active, 0);
  assert.equal(snapshot.liveness.waiting, 0);
  assert.equal(snapshot.liveness.stale, 0);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "runtime_liveness")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores near-final active heartbeat after terminal mission answer", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 20_000,
    events: [
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "sessions_spawn timed out."),
      event("final-1", "thought", 10_000, "role-lead", "Final answer with residual risk."),
    ],
    progressEvents: [
      progress("role:lead", "role_run", "heartbeat", "alive", 10_001, 15_000, "Late heartbeat.", "task-1"),
    ],
  });

  assert.equal(snapshot.liveness.active, 0);
  assert.equal(snapshot.liveness.waiting, 0);
  assert.equal(snapshot.liveness.stale, 0);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "runtime_liveness")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores pre-closeout active heartbeat after terminal blocked mission without final answer", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "blocked" }),
    nowMs: 20_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Review the slow source and stop if cancelled."),
      tool("call-1", 4_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      {
        ...event("recovery-1", "recovery", 6_000, "system", "mission.cancelled: active source check was cancelled."),
        emph: "danger",
        runtime: { eventType: "mission.cancelled" },
      },
    ],
    progressEvents: [
      progress("worker:explore:cancelled", "worker_run", "started", "alive", 5_500, 30_000, "Worker started.", "task-1"),
    ],
  });

  assert.equal(snapshot.liveness.active, 0);
  assert.equal(snapshot.liveness.waiting, 0);
  assert.equal(snapshot.liveness.stale, 0);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "runtime_liveness")?.status, "pass");
});

test("buildMissionObservabilitySnapshot still treats a newer task after a terminal task as active", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "working" }),
    nowMs: 20_000,
    events: [event("user-1", "plan", 1_000, "user", "Run task")],
    progressEvents: [
      progress("role:lead", "role_run", "completed", "resolved", 12_000, 12_500, "Lead completed.", "task-1"),
      progress("role:lead", "role_run", "started", "alive", 14_000, 30_000, "Lead started next task.", "task-2"),
    ],
  });

  assert.equal(snapshot.liveness.active, 1);
  assert.equal(snapshot.liveness.waiting, 0);
  assert.equal(snapshot.liveness.stale, 0);
  assert.equal(snapshot.liveness.lastProgressAtMs, 14_000);
});

test("buildMissionObservabilitySnapshot does not let no-task terminal progress suppress newer no-task active progress", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "working" }),
    nowMs: 20_000,
    events: [event("user-1", "plan", 1_000, "user", "Run task")],
    progressEvents: [
      progress("role:lead", "role_run", "completed", "resolved", 12_000, 12_500, "Lead completed."),
      progress("role:lead", "role_run", "started", "alive", 14_000, 30_000, "Lead started without task id."),
    ],
  });

  assert.equal(snapshot.liveness.active, 1);
  assert.equal(snapshot.liveness.waiting, 0);
  assert.equal(snapshot.liveness.stale, 0);
  assert.equal(snapshot.liveness.lastProgressAtMs, 14_000);
});

test("buildMissionObservabilitySnapshot counts approval decisions without double-counting applied approvals", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...event("approval-request", "approval", 2_000, "role-lead", "Requested approval · browser.form.submit"),
        runtime: { eventType: "permission.query" },
        tags: ["needs_approval", "mutate"],
      },
      {
        ...event("approval-decision", "approval", 3_000, "operator", "Approved · browser.form.submit"),
        runtime: { eventType: "permission.result" },
        tags: ["approved"],
      },
      {
        ...event("approval-applied", "approval", 4_000, "role-lead", "Applied approval · browser.form.submit"),
        runtime: { eventType: "permission.applied" },
        tags: ["approved", "permission.applied"],
      },
      tool("result-1", 4_500, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer based on source evidence, with residual risk noted for unverified follow-up scope."
      ),
    ],
  });

  assert.deepEqual(snapshot.approvals, {
    requested: 1,
    decided: 1,
    applied: 1,
  });
  assert.equal(snapshot.qualityGate.status, "passed");
});

test("buildMissionObservabilitySnapshot flags weak tool-backed final answers", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      event("final-1", "thought", 5_000, "role-lead", "Probably useful. Details are TBD and need confirmation."),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "answer_substance")?.status, "warn");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "evidence_usage")?.status, "warn");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "unsupported_uncertainty")?.status, "warn");
});

test("buildMissionObservabilitySnapshot blocks done missions whose requested provider search pricing slots are unverified", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
    }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned partial evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "基于 source evidence，我只能给出一个部分结论。",
          "| 核心项 | 状态 |",
          "|---|---|",
          "| 各 provider 具体输入/输出 token 价格 | 未验证 |",
          "| 支持 search 功能的 provider 列表 | 未验证 |",
          "| Search 专项费用或功能差异 | 未验证 |",
          "Residual risk: core provider data remains incomplete.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "fail");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.detail ?? "",
    /provider support.*search support.*pricing/s
  );
});

test("buildMissionObservabilitySnapshot blocks timeout closeouts with blocked provider search pricing slots", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
    }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      {
        ...tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "sessions_spawn timed out."),
        emph: "danger" as const,
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "**DeepSeek V4 Flash - Provider/Search/Pricing Verification**",
          "| Provider | Model Name | Search Support | Input Price | Output Price | Evidence |",
          "|----------|------------|----------------|-------------|--------------|----------|",
          "| OpenRouter | - | **blocked** | **blocked** | **blocked** | - |",
          "| Together AI | - | **blocked** | **blocked** | **blocked** | - |",
          "**Status: blocked.** The research session timed out before any provider data was gathered.",
          "No pricing, model names, or search-support details could be verified.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "fail");
});

test("buildMissionObservabilitySnapshot passes goal slot coverage when provider search pricing are concrete", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
    }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned provider evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Based on verified source evidence, provider support is concrete: OpenRouter supports web search, Together and Fireworks do not expose search for this model.",
          "Pricing: OpenRouter input $0.07/M tokens and output $0.28/M tokens; Together input $0.08/M tokens and output $0.30/M tokens.",
          "The comparison is evidence-backed, names the providers, covers search support, and residual risk is limited to source updates after this run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts Chinese provider table with source-bounded residual scope", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
    }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned provider evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "**DeepSeek V4 Flash API Provider Note**",
          "| Provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
          "|---|---|---|---|---|",
          "| OpenRouter | 是 | 是，通过 web_search 选项 | $0.28/1M tokens | $0.42/1M tokens |",
          "| Together | 是 | 不支持 search | $0.20/1M tokens | $0.35/1M tokens |",
          "| Fireworks | 是 | 是，支持 web_search | $0.18/1M tokens | $0.30/1M tokens |",
          "Residual risk: production freshness and provider docs outside the captured source were not verified after this run.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts Chinese DeepSeek provider tables with production-doc residual scope", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: "A product manager needs a source-backed DeepSeek V4 Flash API provider note. Identify providers, search support, input/output token pricing, and the main risk or limitation for production decisions.",
    }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned provider evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "## DeepSeek V4 Flash API Provider Note",
          "**Source status:** HTTP 200, content rendered; text consistent across 3 browser snapshots",
          "| Provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL | 关键原文摘录 |",
          "|---|---|---|---|---|---|---|",
          "| OpenRouter | 是 | 是，Supported through the web_search option | $0.28 / 1M tokens | $0.42 / 1M tokens | http://127.0.0.1:58981/deepseek-provider-pricing | OpenRouter row |",
          "| Together | 是 | 不支持 search；search must be supplied externally | $0.20 / 1M tokens | $0.40 / 1M tokens | http://127.0.0.1:58981/deepseek-provider-pricing | Together row |",
          "| Fireworks | 是 | 不支持 search；search must be supplied externally | $0.25 / 1M tokens | $0.45 / 1M tokens | http://127.0.0.1:58981/deepseek-provider-pricing | Fireworks row |",
          "主要限制 / Residual risk: 这些价格和 search 支持来自本次 localhost source；生产决策前仍需到官方文档验证后续更新和文档新鲜度。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts source-backed provider search facts with cross-verification caveat", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: "A product manager needs a source-backed DeepSeek V4 Flash API provider note. Identify providers, search support, input/output token pricing, and the main risk or limitation for production decisions.",
    }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned provider evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "**DeepSeek V4 Flash API Provider Note**",
          "| Provider | Search support | Input price | Output price |",
          "|---|---|---|---|",
          "| OpenRouter | Supported via web_search option | $0.28 | $0.42 |",
          "| Together | Not supported | $0.20 | $0.40 |",
          "| Fireworks | Not supported | $0.25 | $0.45 |",
          "Main production risk: this source is a local test endpoint, so production provider pages may change.",
          "Residual unverified gap: Together's stated non-support for search and Fireworks' latency claim are taken from the same single source and have not been independently confirmed.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps DeepSeek localhost pricing label to source-backed provider note", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: "A product manager needs a source-backed DeepSeek V4 Flash API provider note.",
    }),
    nowMs: 6_000,
    events: [
      {
        ...tool("result-1", 3_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned provider evidence."),
        evidence: [
          {
            kind: "extract" as const,
            id: "ev-deepseek-pricing",
            label: "Verify DeepSeek pricing from localhost source",
          },
        ],
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "**DeepSeek V4 Flash API Provider Note**",
          "**Source**: `http://127.0.0.1:58956/deepseek-provider-pricing`.",
          "| provider | 是否明确支持 DeepSeek V4 Flash | 是否明确支持 search/web_search | 输入价格 | 输出价格 | 证据 URL |",
          "|---|---|---|---|---|---|",
          "| OpenRouter | 支持 | 支持 web_search | $0.28 / 1M tokens | $0.42 / 1M tokens | http://127.0.0.1:58956/deepseek-provider-pricing |",
          "Residual risk: production freshness outside this local source was not verified after this run.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot warns when final answer misses a visible evidence source", () => {
  const alpha = {
    ...tool("result-alpha", 3_000, "result", "sessions_spawn", "call-alpha", "Alpha source returned evidence."),
    evidence: [{ kind: "extract" as const, id: "ev-alpha", label: "Vendor Alpha" }],
  };
  const beta = {
    ...tool("result-beta", 4_000, "result", "sessions_spawn", "call-beta", "Beta source returned evidence."),
    evidence: [{ kind: "extract" as const, id: "ev-beta", label: "Vendor Beta" }],
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-alpha", 2_000, "call", "sessions_spawn", "call-alpha", "Calling sessions_spawn"),
      alpha,
      tool("call-beta", 3_500, "call", "sessions_spawn", "call-beta", "Calling sessions_spawn"),
      beta,
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Based on source evidence from Vendor Alpha, the recommendation is ready.",
          "The final answer names the evidence and residual risk, but it omits the second source.",
          "Residual risk is limited to source updates after this local run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "warn");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.detail ?? "",
    /Vendor Beta/
  );
});

test("buildMissionObservabilitySnapshot passes source coverage when all evidence labels are named", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool("result-alpha", 3_000, "result", "sessions_spawn", "call-alpha", "Alpha source returned evidence."),
        evidence: [{ kind: "extract", id: "ev-alpha", label: "Vendor Alpha" }],
      },
      {
        ...tool("result-beta", 4_000, "result", "sessions_spawn", "call-beta", "Beta source returned evidence."),
        evidence: [{ kind: "extract", id: "ev-beta", label: "Vendor Beta" }],
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Based on verified source evidence from Vendor Alpha and Vendor Beta, the recommendation is evidence-backed.",
          "The answer covers both source labels, names residual risk, and avoids unsupported future pricing or adoption claims.",
          "Residual risk is limited to source updates after this run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores internal raw-fetch labels for source coverage", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool("result-alpha", 3_000, "result", "sessions_spawn", "call-alpha", "Alpha source returned evidence."),
        evidence: [
          { kind: "extract", id: "ev-alpha", label: "Vendor Alpha" },
          { kind: "extract", id: "ev-alpha-raw", label: "Vendor Alpha Raw Fetch" },
        ],
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Based on verified source evidence from Vendor Alpha, the recommendation is evidence-backed.",
          "Pricing is $19 per seat; residual risk is limited to source updates after this run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps approved form-submit evidence label to user-facing action text", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool(
          "result-submit",
          3_000,
          "result",
          "sessions_send",
          "call-submit",
          "Browser worker executed the approved form submit."
        ),
        runtime: {
          ...tool("result-submit", 3_000, "result", "sessions_send", "call-submit", "").runtime,
          sourceLabel: "execute approved form submit",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Approved action: browser.form.submit at the approval form.",
          "Post-submission browser state was captured and the dry-run stayed local.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps approval form inspection label to form evidence", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool(
          "result-inspect",
          3_000,
          "result",
          "sessions_spawn",
          "call-inspect",
          "Browser worker inspected the approval form."
        ),
        evidence: [{ kind: "snapshot", id: "ev-inspect", label: "Inspect approval form" }],
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "The approval form was identified before submission.",
          "Form evidence: note input and Submit dry-run button were visible.",
          "Residual risk is limited to the local approval gate fixture.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps dry-run form submission execute label to approved submit evidence", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool(
          "result-submit",
          3_000,
          "result",
          "sessions_spawn",
          "call-submit",
          "Browser worker executed the approved dry-run form submit."
        ),
        evidence: [{ kind: "snapshot", id: "ev-submit", label: "dry-run form submission execute" }],
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Approved action: browser.form.submit on the approval form.",
          "Submission executed: Submit dry-run button clicked with submit=true.",
          "Dry-run submitted locally after approval; no external mutation was performed.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps search-support verification label to provider support facts", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool(
          "result-search",
          3_000,
          "result",
          "sessions_spawn",
          "call-search",
          "Provider page returned search support details."
        ),
        runtime: {
          ...tool("result-search", 3_000, "result", "sessions_spawn", "call-search", "").runtime,
          sourceLabel: "search-support-verification",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| Provider | 是否明确支持 search/web_search |",
          "|---|---|",
          "| OpenRouter | 明确支持 web_search |",
          "| Together | 明确不支持 search |",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats refine as a generic source-label task verb", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool("result-refine", 3_000, "result", "sessions_send", "call-refine", "Decision note returned."),
        evidence: [{ kind: "extract", id: "ev-refine", label: "Refine to Decision Note" }],
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Vendor Alpha decision note: pricing is $19 per seat, with source-bounded residual risk."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts natural source-label stems without generic suffixes", () => {
  const orchestrationResult = tool(
    "result-orchestration",
    2_000,
    "result",
    "sessions_spawn",
    "call-orchestration",
    "Orchestration source returned evidence."
  );
  const signalsResult = tool(
    "result-signals",
    3_000,
    "result",
    "sessions_spawn",
    "call-signals",
    "Product signals dashboard returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...orchestrationResult,
        runtime: {
          ...orchestrationResult.runtime,
          sourceLabel: "product-orchestration-research",
        },
      },
      {
        ...signalsResult,
        runtime: {
          ...signalsResult.runtime,
          sourceLabel: "product-signals-dashboard",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Based on verified source evidence from product-orchestration and product-signals, the recommendation is evidence-backed.",
          "The answer names residual risk and avoids unsupported production claims.",
          "Residual risk is limited to local signal fidelity.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores internal agent workbench collector source labels", () => {
  const collectorResult = tool(
    "result-collector",
    2_000,
    "result",
    "sessions_spawn",
    "call-collector",
    "Agent workbench collector returned product-orchestration, product-bridge, and product-signals evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...collectorResult,
        runtime: {
          ...collectorResult.runtime,
          sourceLabel: "agent-workbench-brief-collector",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "product-orchestration verified Mission Control as the default release story.",
          "product-bridge verified browser bridge setup risk.",
          "product-signals verified Stuck missions: 6 and Weak answer rate: 24%.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts independent researcher labels when final answer names role and URL", () => {
  const researcherA = tool(
    "result-researcher-a",
    2_000,
    "result",
    "sessions_spawn",
    "call-a",
    completedSessionResultContent("worker:explore:a", "Researcher A returned Example Domain evidence.")
  );
  const researcherB = tool(
    "result-researcher-b",
    3_000,
    "result",
    "sessions_spawn",
    "call-b",
    completedSessionResultContent("worker:explore:b", "Researcher B returned IANA Example Domains evidence.")
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: [
        "请把这个任务交给两个独立研究员并分别取证。",
        "研究员 A 只检查 https://example.com/，研究员 B 只检查 https://www.iana.org/help/example-domains。",
        "最后合并成一个两行表格和一句话比较这两个页面的关系。",
      ].join("\n"),
    }),
    nowMs: 6_000,
    events: [
      {
        ...researcherA,
        runtime: {
          ...researcherA.runtime,
          sourceLabel: "Researcher A - example.com",
        },
      },
      {
        ...researcherB,
        runtime: {
          ...researcherB.runtime,
          sourceLabel: "Researcher B - iana example-domains",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| 来源 | URL | title | 关键原文 | 证据方式 |",
          "| 研究员 A | https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | HTTP GET |",
          "| 研究员 B | https://www.iana.org/help/example-domains | Example Domains | a number of domains such as example.com and example.org are maintained for documentation purposes | HTTP GET |",
          "iana.org 的 Example Domains 页面是权威说明，example.com 是实际示例页面。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "residual_risk")?.status, "pass");
});

test("buildMissionObservabilitySnapshot blocks independent researcher answers when sessions did not complete", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: [
        "请把这个任务交给两个独立研究员并分别取证。",
        "研究员 A 只检查 https://example.com/，研究员 B 只检查 https://www.iana.org/help/example-domains。",
        "最后合并成一个两行表格和一句话比较这两个页面的关系。",
      ].join("\n"),
    }),
    nowMs: 6_000,
    events: [
      tool(
        "result-researcher-a",
        2_000,
        "result",
        "sessions_spawn",
        "call-a",
        sessionResultContent("worker:explore:a", "failed", "Researcher A failed before collecting evidence.")
      ),
      tool(
        "result-researcher-b",
        3_000,
        "result",
        "sessions_spawn",
        "call-b",
        sessionResultContent("worker:explore:b", "partial", "Researcher B timed out with partial notes.")
      ),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| 来源 | URL | title | 关键原文 | 证据方式 |",
          "| 研究员 A | https://example.com/ | Example Domain | quote | HTTP GET |",
          "| 研究员 B | https://www.iana.org/help/example-domains | Example Domains | quote | HTTP GET |",
          "两个页面证据一致。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "fail");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.detail ?? "",
    /delegated research.*missing/
  );
});

test("buildMissionObservabilitySnapshot fails title-only missions that request a final conclusion but omit it", () => {
  const prompt = [
    "请把这个任务交给两个独立研究员并分别取证。",
    "研究员 A 只检查 https://example.com/，研究员 B 只检查 https://www.iana.org/help/example-domains。",
    "最后合并成一个两行表格，列出研究员、URL、标题、关键原文摘录和关系。",
    "最后再给一句话结论。",
  ].join("\n");
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      title: prompt,
      desc: "",
      status: "done",
    }),
    nowMs: 6_000,
    events: [
      tool("result-researcher-a", 2_000, "result", "sessions_spawn", "call-a", completedSessionResultContent("worker:explore:a", "Researcher A returned Example Domain evidence.")),
      tool("result-researcher-b", 3_000, "result", "sessions_spawn", "call-b", completedSessionResultContent("worker:explore:b", "Researcher B returned IANA Example Domains evidence.")),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| 研究员 | URL | 页面标题 | 关键原文摘录 | 关系 |",
          "|---|---|---|---|---|",
          "| 研究员 A | https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | 具体示例页面 |",
          "| 研究员 B | https://www.iana.org/help/example-domains | Example Domains | example.com and example.org are maintained for documentation purposes. | 权威说明页面 |",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "fail");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.detail ?? "",
    /final conclusion.*missing/
  );
});

test("buildMissionObservabilitySnapshot passes title-only final-conclusion requests when conclusion is explicit", () => {
  const prompt = [
    "请把这个任务交给两个独立研究员并分别取证。",
    "研究员 A 只检查 https://example.com/，研究员 B 只检查 https://www.iana.org/help/example-domains。",
    "最后合并成一个两行表格，并最后再给一句话结论。",
  ].join("\n");
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      title: prompt,
      desc: "",
      status: "done",
    }),
    nowMs: 6_000,
    events: [
      tool("result-researcher-a", 2_000, "result", "sessions_spawn", "call-a", completedSessionResultContent("worker:explore:a", "Researcher A returned Example Domain evidence.")),
      tool("result-researcher-b", 3_000, "result", "sessions_spawn", "call-b", completedSessionResultContent("worker:explore:b", "Researcher B returned IANA Example Domains evidence.")),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| 研究员 | URL | 页面标题 | 关键原文摘录 | 关系 |",
          "|---|---|---|---|---|",
          "| 研究员 A | https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | 具体示例页面 |",
          "| 研究员 B | https://www.iana.org/help/example-domains | Example Domains | example.com and example.org are maintained for documentation purposes. | 权威说明页面 |",
          "",
          "结论：IANA 页面是权威说明，example.com 是该说明落地的具体示例域名页面。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot uses the latest follow-up goal for risk and quoted evidence coverage", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      title:
        "请交给研究员 A 只检查 https://example.com/，研究员 A 必须返回最终 URL、页面 title、关键原文、取证方式。",
      desc: "",
      status: "done",
    }),
    nowMs: 8_000,
    events: [
      event(
        "user-1",
        "plan",
        1_000,
        "user",
        "请交给研究员 A 只检查 https://example.com/，研究员 A 必须返回最终 URL、页面 title、关键原文、取证方式。"
      ),
      tool("call-a", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn for 研究员 A."),
      tool(
        "result-a",
        3_000,
        "result",
        "sessions_spawn",
        "call-a",
        "This domain is for use in documentation examples without needing permission. Avoid use in operations."
      ),
      event(
        "final-1",
        "thought",
        4_000,
        "role-lead",
        "| URL | title | 关键原文 | 证据方式 |\n|---|---|---|---|\n| https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | HTTP fetch |"
      ),
      event(
        "user-2",
        "plan",
        5_000,
        "user",
        "继续刚才研究员 A 的同一条研究线索。基于上一轮 evidence 写一个三点 decision note：1. 这个页面可以用于什么；2. 使用时最重要的限制或风险是什么；3. 引用上一轮研究员 A 的关键原文作为证据。"
      ),
      event(
        "final-2",
        "thought",
        6_000,
        "role-lead",
        [
          "## Decision Note",
          "1. 这个页面可以用于文档示例。",
          "2. 使用时最重要的限制或风险：未验证（证据未说明任何使用限制或风险）。",
          '3. 证据：> "This domain is for use in documentation examples without needing permission."',
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "fail");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.detail ?? "",
    /risk or limitation.*unverified/
  );
});

test("buildMissionObservabilitySnapshot accepts markdown-bold final-conclusion labels", () => {
  const prompt = "最后合并成一个两行表格，并最后再给一句话结论。";
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      title: prompt,
      desc: "",
      status: "done",
    }),
    nowMs: 6_000,
    events: [
      tool("result-researcher-a", 2_000, "result", "sessions_spawn", "call-a", "Researcher A returned Example Domain evidence."),
      tool("result-researcher-b", 3_000, "result", "sessions_spawn", "call-b", "Researcher B returned IANA Example Domains evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| 研究员 | URL | 页面标题 | 关键原文摘录 | 关系 |",
          "|---|---|---|---|---|",
          "| 研究员 A | https://example.com/ | Example Domain | This domain is for use in documentation examples without needing permission. | 具体示例页面 |",
          "| 研究员 B | https://www.iana.org/help/example-domains | Example Domains | example.com and example.org are maintained for documentation purposes. | 权威说明页面 |",
          "",
          "**结论：** IANA 页面是权威说明，example.com 是该说明落地的具体示例域名页面。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats review as a generic source-label suffix", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha review returned evidence."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha review",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Vendor Alpha and Vendor Beta were both verified from source evidence.",
          "The recommendation names residual risk and avoids unsupported claims.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats browser inspection as a generic source-label suffix", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha browser inspection returned evidence."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha browser inspection",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Source: http://127.0.0.1/vendor-alpha. Vendor Alpha pricing is $19 per seat.",
          "Vendor Beta was also verified, and residual risk remains source updates after this local run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats browser capture as a generic source-label suffix", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha browser capture returned evidence."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha browser capture",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Source: http://127.0.0.1/vendor-alpha. Vendor Alpha pricing is $19 per seat.",
          "Vendor Beta was also verified, and residual risk remains source updates after this local run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats browser render as a generic source-label suffix", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha browser render returned evidence."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha browser render",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Source: http://127.0.0.1/vendor-alpha. Vendor Alpha pricing is $19 per seat.",
          "Vendor Beta was also verified, and residual risk remains source updates after this local run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats rendered view as generic source-label wording", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha rendered view returned pricing, strength, and risk evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha rendered view",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Vendor Alpha decision note.",
          "Source: http://127.0.0.1/vendor-alpha - Vendor Alpha Evidence confirmed pricing ($19/seat), browser automation strength, and limited API integration catalog risk.",
          "Residual risk: governance fit and enterprise terms were not verified from this source.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats rendered page verification snapshot as generic source-label text", () => {
  const renderedSnapshot = tool(
    "result-rendered-snapshot",
    2_000,
    "result",
    "sessions_send",
    "call-rendered-snapshot",
    "Rendered page verification snapshot returned approval form evidence."
  );
  const formResult = tool(
    "result-form",
    3_000,
    "result",
    "sessions_spawn",
    "call-form",
    "Approval form source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...renderedSnapshot,
        runtime: {
          ...renderedSnapshot.runtime,
          sourceLabel: "rendered page verification snapshot",
        },
      },
      {
        ...formResult,
        runtime: {
          ...formResult.runtime,
          sourceLabel: "approval form",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "The approval form was verified after the approved dry-run submit, with residual risk limited to the local fixture."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats evidence collection as a generic source-label suffix", () => {
  const asiaWalkResult = tool(
    "result-asiawalk",
    2_000,
    "result",
    "sessions_spawn",
    "call-asiawalk",
    "AsiaWalk pilot evidence collection returned route, budget, and readiness evidence."
  );
  const budgetResult = tool(
    "result-budget",
    3_000,
    "result",
    "sessions_spawn",
    "call-budget",
    "AsiaWalk budget source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...asiaWalkResult,
        runtime: {
          ...asiaWalkResult.runtime,
          sourceLabel: "AsiaWalk pilot evidence collection",
        },
      },
      {
        ...budgetResult,
        runtime: {
          ...budgetResult.runtime,
          sourceLabel: "AsiaWalk budget",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "AsiaWalk pilot evidence supports the route and budget plan; residual risk remains guide confirmation before deposits."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats local URL fetch as a generic source label", () => {
  const fetchResult = tool(
    "result-fetch",
    2_000,
    "result",
    "sessions_spawn",
    "call-fetch",
    "Local URL fetch returned Vendor Alpha evidence."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...fetchResult,
        runtime: {
          ...fetchResult.runtime,
          sourceLabel: "local-url-fetch",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Vendor Alpha and Vendor Beta were both verified; residual risk remains source freshness."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats raw evidence as a generic source label suffix", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha raw evidence returned pricing, strength, and risk facts."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta evidence returned comparison facts."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha raw evidence",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Vendor Alpha and Vendor Beta were both verified; residual risk remains source freshness."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores bounded probe source labels", () => {
  const probeResult = tool(
    "result-probe",
    2_000,
    "result",
    "sessions_spawn",
    "call-probe",
    "Ops dashboard bounded probe returned detached_target evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...probeResult,
        runtime: {
          ...probeResult.runtime,
          sourceLabel: "ops-dashboard-bounded-probe",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Ops Dashboard Probe verified detached browser-target evidence; residual risk remains rendered dashboard content."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats stream as a generic source-label suffix", () => {
  const routeResult = tool(
    "result-route",
    2_000,
    "result",
    "sessions_spawn",
    "call-route",
    "AsiaWalk route stream returned evidence."
  );
  const budgetResult = tool(
    "result-budget",
    3_000,
    "result",
    "sessions_spawn",
    "call-budget",
    "AsiaWalk budget stream returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...routeResult,
        runtime: {
          ...routeResult.runtime,
          sourceLabel: "AsiaWalk Route Stream",
        },
      },
      {
        ...budgetResult,
        runtime: {
          ...budgetResult.runtime,
          sourceLabel: "AsiaWalk Budget Stream",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "AsiaWalk route and budget evidence support the pilot, with residual risk around guide confirmation."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps AsiaWalk three-stream label to user-facing stream evidence", () => {
  const asiaWalkResult = tool(
    "result-asiawalk",
    2_000,
    "result",
    "sessions_spawn",
    "call-asiawalk",
    "AsiaWalk three-stream inspection returned route, budget, and readiness evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...asiaWalkResult,
        runtime: {
          ...asiaWalkResult.runtime,
          sourceLabel: "AsiaWalk three-stream inspection",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "AsiaWalk route and budget evidence support a pilot recommendation; readiness risk remains rain and guide confirmation."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps AsiaWalk three-stream evidence collection label to brief evidence", () => {
  const asiaWalkResult = tool(
    "result-asiawalk-evidence",
    2_000,
    "result",
    "sessions_spawn",
    "call-asiawalk-evidence",
    "AsiaWalk three-stream evidence collection returned route, budget, and readiness evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...asiaWalkResult,
        runtime: {
          ...asiaWalkResult.runtime,
          sourceLabel: "AsiaWalk three-stream evidence collection",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "AsiaWalk Pilot Brief.",
          "Route: Seoul orientation walk, Taipei food-and-transit loop, and Tokyo neighborhood finale.",
          "Budget: $1,280 total, with a $180 contingency buffer.",
          "Rendered readiness: browser evidence shows readiness yellow, with rain risk in Taipei and metro maintenance in Tokyo.",
          "Recommendation: conditional go.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps AsiaWalk data labels to URL slug source references", () => {
  const routeResult = tool("result-route", 2_000, "result", "sessions_spawn", "call-route", completedSessionResultContent("worker:explore:asiawalk-route", "AsiaWalk Route Data returned evidence."));
  const budgetResult = tool("result-budget", 3_000, "result", "sessions_spawn", "call-budget", completedSessionResultContent("worker:explore:asiawalk-budget", "AsiaWalk Budget Data returned evidence."));
  const liveResult = tool("result-live", 4_000, "result", "sessions_spawn", "call-live", completedSessionResultContent("worker:browser:asiawalk-live", "AsiaWalk Live Readiness Data returned evidence."));
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...routeResult,
        runtime: { ...routeResult.runtime, sourceLabel: "AsiaWalk Route Data" },
      },
      {
        ...budgetResult,
        runtime: { ...budgetResult.runtime, sourceLabel: "AsiaWalk Budget Data" },
      },
      {
        ...liveResult,
        runtime: { ...liveResult.runtime, sourceLabel: "AsiaWalk Live Readiness Data" },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "# AsiaWalk Pilot Brief",
          "**Sources:** `asiawalk-route` · `asiawalk-budget` · `asiawalk-live`",
          "Route source: Seoul orientation walk, Taipei food loop, Tokyo finale.",
          "Budget source: $8,400 cap and partner deposit timing.",
          "Live readiness dashboard source: guide coverage and rain risk remain the main limitation.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts AsiaWalk rendered readiness with route-detail residual scope", () => {
  const routeResult = tool("result-route", 2_000, "result", "sessions_spawn", "call-route", completedSessionResultContent("worker:explore:asiawalk-route", "AsiaWalk Route Data returned evidence."));
  const budgetResult = tool("result-budget", 3_000, "result", "sessions_spawn", "call-budget", completedSessionResultContent("worker:explore:asiawalk-budget", "AsiaWalk Budget Data returned evidence."));
  const liveResult = tool("result-live", 4_000, "result", "sessions_spawn", "call-live", completedSessionResultContent("worker:browser:asiawalk-live", "AsiaWalk Live Readiness Data returned evidence."));
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({
      status: "done",
      desc: [
        "Prepare a decision-ready AsiaWalk pilot brief.",
        "Use route, budget, and live readiness as three separate evidence streams.",
        "Inspect the live readiness dashboard as rendered browser evidence, not raw HTML.",
        "Include source-backed risk or limitation notes and a final conclusion.",
      ].join(" "),
    }),
    nowMs: 6_000,
    events: [
      {
        ...routeResult,
        runtime: { ...routeResult.runtime, sourceLabel: "AsiaWalk Route Data" },
      },
      {
        ...budgetResult,
        runtime: { ...budgetResult.runtime, sourceLabel: "AsiaWalk Budget Data" },
      },
      {
        ...liveResult,
        runtime: { ...liveResult.runtime, sourceLabel: "AsiaWalk Live Readiness Data" },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "# AsiaWalk Pilot Brief",
          "**Sources:** `asiawalk-route` · `asiawalk-budget` · `asiawalk-live`",
          "Route source: Seoul orientation walk, Taipei food loop, Tokyo finale.",
          "Budget source: $8,400 cap and deposit timing remain feasible.",
          "Live readiness dashboard rendered browser evidence: Overall readiness yellow; rain risk in Taipei and metro maintenance in Tokyo are visible on the page with marker TURNKEYAI_ASIAWALK_LIVE_OK.",
          "Risk: guide confirmation remains the main operational limitation.",
          "Note: Distances, segment durations, and detailed waypoint steps were not visible in the rendered source.",
          "Conclusion: proceed with a limited pilot after guide confirmation.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "goal_slot_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps AsiaWalk live-readiness completion labels to asiawalk-live evidence", () => {
  const liveResult = tool("result-live", 4_000, "result", "sessions_send", "call-live", "AsiaWalk Live Readiness — complete.");
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...liveResult,
        runtime: { ...liveResult.runtime, sourceLabel: "AsiaWalk Live Readiness — complete" },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "AsiaWalk brief uses `asiawalk-live` evidence.",
          "Live readiness dashboard evidence: Overall readiness yellow, rain risk in Taipei, metro maintenance in Tokyo.",
          "Risk: guide confirmation remains the next action.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps slow-source timeout labels to final evidence facts", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool("result-timeout", 2_000, "result", "sessions_spawn", "call-timeout", "Slow source timeout test returned bounded timeout evidence."),
        runtime: {
          ...tool("result-timeout", 2_000, "result", "sessions_spawn", "call-timeout", "").runtime,
          sourceLabel: "Slow source timeout test",
        },
      },
      {
        ...tool("result-resume", 3_000, "result", "sessions_send", "call-resume", "Resume slow-source timeout test returned recovered evidence."),
        runtime: {
          ...tool("result-resume", 3_000, "result", "sessions_send", "call-resume", "").runtime,
          sourceLabel: "Resume slow-source timeout test",
        },
      },
      {
        ...tool("result-browser", 4_000, "result", "sessions_send", "call-browser", "Browser render of slow-fixture returned title and marker evidence."),
        runtime: {
          ...tool("result-browser", 4_000, "result", "sessions_send", "call-browser", "").runtime,
          sourceLabel: "Browser render of slow-fixture",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Release-risk note for slow-fixture.",
          "Initial bounded attempt timed out, then the resumed source-check recovered.",
          "Browser evidence shows HTTP status 200 OK, page title TurnkeyAI Slow Mission E2E Fixture, and marker TURNKEYAI_MISSION_FIXTURE_OK.",
          "Residual risk remains production latency outside this fixture.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats fresh recovery as generic source-label wording", () => {
  const result = tool(
    "result-dashboard",
    4_000,
    "result",
    "sessions_send",
    "call-dashboard",
    "Ops dashboard fresh recovery returned rendered dashboard facts."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...result,
        runtime: {
          ...result.runtime,
          sourceLabel: "Ops dashboard fresh recovery",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Cold-recovered by reopening http://127.0.0.1:56567/ops-dashboard.",
          "Dashboard queue depth is 11, SLA breaches are 3, and the owner is Incident Commander.",
          "Residual risk: fixture-only dashboard; production readiness is not verified.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats product capabilities as generic source-label terms", () => {
  const orchestrationResult = tool(
    "result-orchestration",
    2_000,
    "result",
    "sessions_spawn",
    "call-orchestration",
    "Product orchestration returned Mission Control evidence."
  );
  const bridgeResult = tool(
    "result-bridge",
    3_000,
    "result",
    "sessions_spawn",
    "call-bridge",
    "Product Bridge Capabilities returned browser bridge boundary evidence."
  );
  const signalsResult = tool(
    "result-signals",
    4_000,
    "result",
    "sessions_spawn",
    "call-signals",
    "Product signals returned stuck mission evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...orchestrationResult,
        runtime: {
          ...orchestrationResult.runtime,
          sourceLabel: "Product Orchestration",
        },
      },
      {
        ...bridgeResult,
        runtime: {
          ...bridgeResult.runtime,
          sourceLabel: "Product Bridge Capabilities",
        },
      },
      {
        ...signalsResult,
        runtime: {
          ...signalsResult.runtime,
          sourceLabel: "Product Signals Dashboard",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "The orchestration source says Mission Control should be the default launch surface.",
          "The bridge boundary should stay clear: browser work is an execution surface with setup risk.",
          "The signals source shows stuck missions and weak-answer rate, making completion reliability the release gate.",
          "Residual risk is local fixture evidence only.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats recheck as an internal follow-up source-label action", () => {
  const dashboardResult = tool(
    "result-dashboard",
    2_000,
    "result",
    "sessions_spawn",
    "call-dashboard",
    "Ops dashboard source returned queue depth and SLA breach evidence."
  );
  const titledDashboardResult = tool(
    "result-dashboard-title",
    2_500,
    "result",
    "sessions_spawn",
    "call-dashboard-title",
    "Ops Dashboard Review returned queue depth and SLA breach evidence."
  );
  const recheckResult = tool(
    "result-recheck",
    3_000,
    "result",
    "sessions_send",
    "call-recheck",
    "Recheck ops dashboard returned unchanged rendered evidence."
  );
  const reinspectResult = tool(
    "result-reinspect",
    4_000,
    "result",
    "sessions_send",
    "call-reinspect",
    "Re-inspect dashboard post-restart returned unchanged rendered evidence."
  );
  const recoveryResult = tool(
    "result-recovery",
    4_500,
    "result",
    "sessions_send",
    "call-recovery",
    "Ops dashboard recovery returned a cold-recreated browser session and rendered evidence."
  );
  const reconnectResult = tool(
    "result-reconnect",
    4_700,
    "result",
    "sessions_send",
    "call-reconnect",
    "Ops dashboard reconnect returned rendered evidence after daemon restart."
  );
  const restartReconnectResult = tool(
    "result-restart-reconnect",
    4_750,
    "result",
    "sessions_send",
    "call-restart-reconnect",
    "Ops dashboard restart reconnect returned rendered evidence after daemon restart."
  );
  const retryVersionResult = tool(
    "result-review-v2",
    4_800,
    "result",
    "sessions_send",
    "call-review-v2",
    "Ops dashboard review v2 returned rendered evidence after incomplete-final recovery."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...dashboardResult,
        runtime: {
          ...dashboardResult.runtime,
          sourceLabel: "ops-dashboard-review",
        },
      },
      {
        ...titledDashboardResult,
        runtime: {
          ...titledDashboardResult.runtime,
          sourceLabel: "Ops Dashboard Review",
        },
      },
      {
        ...recheckResult,
        runtime: {
          ...recheckResult.runtime,
          sourceLabel: "recheck-ops-dashboard",
        },
      },
      {
        ...reinspectResult,
        runtime: {
          ...reinspectResult.runtime,
          sourceLabel: "Re-inspect dashboard post-restart",
        },
      },
      {
        ...recoveryResult,
        runtime: {
          ...recoveryResult.runtime,
          sourceLabel: "Ops dashboard recovery re-open",
        },
      },
      {
        ...reconnectResult,
        runtime: {
          ...reconnectResult.runtime,
          sourceLabel: "ops-dashboard-reconnect",
        },
      },
      {
        ...restartReconnectResult,
        runtime: {
          ...restartReconnectResult.runtime,
          sourceLabel: "ops-dashboard-restart-reconnect",
        },
      },
      {
        ...retryVersionResult,
        runtime: {
          ...retryVersionResult.runtime,
          sourceLabel: "ops-dashboard-review-v2.",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Operational State was re-checked in the same browser session after daemon restart and cold recovery.",
          "Queue depth remains 11, SLA breaches remain 3, and Incident Commander is still the recommended owner.",
          "Residual uncertainty is that this is a local dynamic dashboard fixture.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps ops dashboard restart labels to rendered dashboard facts", () => {
  const initialResult = tool(
    "result-initial",
    2_000,
    "result",
    "sessions_spawn",
    "call-initial",
    "Ops dashboard review returned rendered queue depth and SLA breach evidence."
  );
  const restartResult = tool(
    "result-post-restart",
    4_000,
    "result",
    "sessions_send",
    "call-post-restart",
    "Ops dashboard post restart returned rendered dashboard evidence after daemon restart."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...initialResult,
        runtime: {
          ...initialResult.runtime,
          sourceLabel: "ops-dashboard-review",
        },
      },
      {
        ...restartResult,
        runtime: {
          ...restartResult.runtime,
          sourceLabel: "ops-dashboard-post-restart",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Queue depth: 11. SLA breaches: 3.",
          "Escalation trigger: both thresholds breached, so escalation is active.",
          "Recommended owner: Incident Commander.",
          "Browser continuity: the session reconnected and reloaded the page after daemon restart.",
          "Dashboard fixture status: TURNKEYAI_DASHBOARD_TRIAGE_OK.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores generic continuation task labels for source coverage", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha source returned evidence."
  );
  const continuationResult = tool(
    "result-note",
    3_000,
    "result",
    "sessions_send",
    "call-note",
    "Synthesize decision note returned a follow-up summary."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha",
        },
      },
      {
        ...continuationResult,
        runtime: {
          ...continuationResult.runtime,
          sourceLabel: "Vendor Alpha review extraction",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Vendor Alpha was verified from source evidence.",
          "The recommendation is to continue with residual risk around integration evidence.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats full extraction as a generic source-label suffix", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_send",
    "call-alpha",
    "Vendor Alpha full extraction returned evidence."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha full extraction",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Vendor Alpha and Vendor Beta were both verified from source evidence.",
          "Residual risk remains around future source changes.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats evidence pull as a generic source-label suffix", () => {
  const alphaResult = tool(
    "result-alpha",
    2_000,
    "result",
    "sessions_spawn",
    "call-alpha",
    "Vendor Alpha full evidence pull returned evidence."
  );
  const betaResult = tool(
    "result-beta",
    3_000,
    "result",
    "sessions_spawn",
    "call-beta",
    "Vendor Beta source returned evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...alphaResult,
        runtime: {
          ...alphaResult.runtime,
          sourceLabel: "Vendor Alpha Full Evidence Pull",
        },
      },
      {
        ...betaResult,
        runtime: {
          ...betaResult.runtime,
          sourceLabel: "Vendor Beta",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Vendor Alpha and Vendor Beta were both verified; residual risk remains source freshness."
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot ignores restart continuation wording while preserving restart as coverage", () => {
  const dashboardResult = tool(
    "result-dashboard",
    2_000,
    "result",
    "sessions_spawn",
    "call-dashboard",
    "Dashboard source returned evidence."
  );
  const restartResult = tool(
    "result-restart",
    3_000,
    "result",
    "sessions_send",
    "call-restart",
    "Restart continuation returned dashboard evidence."
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...dashboardResult,
        runtime: {
          ...dashboardResult.runtime,
          sourceLabel: "Operations dashboard",
        },
      },
      {
        ...restartResult,
        runtime: {
          ...restartResult.runtime,
          sourceLabel: "Continuation followup retry revisit dashboard review after restart",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "The operations dashboard evidence was rechecked after daemon restart.",
          "Incident Commander remains owner, with residual risk around page freshness.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot still warns when a distinctive source token is missing", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool("result-alpha", 3_000, "result", "sessions_spawn", "call-alpha", "Alpha source returned evidence."),
        evidence: [{ kind: "extract", id: "ev-alpha", label: "Vendor Alpha" }],
      },
      {
        ...tool("result-beta", 4_000, "result", "sessions_spawn", "call-beta", "Beta source returned evidence."),
        evidence: [{ kind: "extract", id: "ev-beta", label: "Vendor Beta" }],
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Based on verified source evidence from Vendor Alpha and a second vendor source, the recommendation is evidence-backed.",
          "The answer names residual risk, but does not name the second vendor distinctly.",
          "Residual risk is limited to source updates after this run.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.status, "warn");
  assert.match(snapshot.qualityGate.checks.find((check) => check.name === "source_coverage")?.detail ?? "", /Vendor Beta/);
});

test("buildMissionObservabilitySnapshot flags tool-unavailable fallback answers", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "我注意到搜索工具暂时无法返回结果。基于我的知识库，先给出一个概括，但需要后续验证。"
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "tool_fallback_answer")?.status, "warn");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "unsupported_uncertainty")?.status, "warn");
});

test("buildMissionObservabilitySnapshot surfaces browser profile fallback as mission attention", () => {
  const profileFallbackResult = tool(
    "result-browser-fallback",
    4_000,
    "result",
    "sessions_spawn",
    "call-browser",
    [
      "Browser worker completed session browser-session-profile-fallback.",
      "Final URL: http://127.0.0.1/dashboard.",
      "Page title: Dashboard.",
      "Trace steps: open -> snapshot.",
      "Profile fallback: profile_locked; persistent profile was unavailable, used .daemon-data/browser/_runtime-fallback/browser-session-profile-fallback/123.",
      "Screenshots: none",
    ].join("\n")
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-browser", 2_000, "call", "sessions_spawn", "call-browser", "Calling sessions_spawn"),
      {
        ...profileFallbackResult,
        runtime: {
          ...profileFallbackResult.runtime,
          resultContent: profileFallbackResult.text,
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer based on browser-rendered evidence with residual risk noted for local fixture scope."
      ),
    ],
  });

  assert.equal(snapshot.browser.profileFallbacks, 1);
  assert.equal(snapshot.browser.latestProfileFallback?.sessionId, "browser-session-profile-fallback");
  assert.equal(
    snapshot.browser.latestProfileFallback?.fallbackDir,
    ".daemon-data/browser/_runtime-fallback/browser-session-profile-fallback/123"
  );
  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_profile_fallback")?.status, "warn");
});

test("buildMissionObservabilitySnapshot surfaces browser failure buckets as mission attention", () => {
  const failedResult = {
    ...tool(
      "result-browser-failed",
      4_000,
      "result",
      "sessions_spawn",
      "call-browser",
      "browser_cdp_unavailable: connection refused before rendered dashboard evidence was captured."
    ),
    emph: "danger" as const,
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "blocked" }),
    nowMs: 6_000,
    events: [
      tool("call-browser", 2_000, "call", "sessions_spawn", "call-browser", "Calling sessions_spawn"),
      {
        ...failedResult,
        runtime: {
          ...failedResult.runtime,
          resultContent: failedResult.text,
        },
      },
      {
        ...event(
          "recovery-detach",
          "recovery",
          4_500,
          "agent.browser",
          "Browser target detached while collecting evidence."
        ),
        runtime: {
          browserDiagnosticBucket: "detached_target",
        },
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer based on verified evidence from the failed browser attempt, with residual risk noted for unverified rendered dashboard state."
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, [
    { bucket: "detached_target", count: 1, latestAtMs: 4_500 },
    { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 4_000 },
  ]);
  assert.equal(snapshot.qualityGate.status, "blocked");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "warn");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.detail ?? "",
    /detached_target=1, browser_cdp_unavailable=1/
  );
});

test("buildMissionObservabilitySnapshot surfaces browser recovery buckets from completed session tool results", () => {
  const sessionResult = {
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    agent_id: "browser",
    session_key: "worker:browser:1",
    task_id: "task-browser",
    result: "Browser failure buckets: browser_cdp_unavailable=1. The dashboard remains unverified.",
    final_content: "The browser endpoint is unavailable, so rendered dashboard facts remain unverified.",
    tool_chain: ["browser"],
    payload: {
      browserRecovery: {
        summary: "Browser failure buckets: browser_cdp_unavailable=1.",
        failureBuckets: [{ bucket: "browser_cdp_unavailable", count: 1 }],
      },
    },
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-browser", 2_000, "call", "sessions_spawn", "call-browser", "Calling sessions_spawn"),
      tool("result-browser", 4_000, "result", "sessions_spawn", "call-browser", JSON.stringify(sessionResult)),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer reports the browser endpoint as unavailable and leaves dashboard facts unverified."
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, [
    { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 4_000 },
  ]);
  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "warn");
});

test("buildMissionObservabilitySnapshot surfaces browser buckets from top-level session evidence summary", () => {
  const sessionResult = {
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    agent_id: "browser",
    session_key: "worker:browser:1",
    task_id: "task-browser",
    evidence_summary: [
      "Browser failure buckets: browser_cdp_unavailable=4.",
      "## Result: Connection Failed",
      "All connection attempts returned browser_cdp_unavailable: fetch failed.",
    ].join("\n"),
    final_content: [
      "Browser limitation: browser_cdp_unavailable occurred during browser work.",
      "Treat verified page facts as bounded; no additional browser-visible facts are claimed.",
    ].join("\n"),
    result: "Browser failure buckets: browser_cdp_unavailable=4. ## Result: Connection Failed",
    tool_chain: ["browser"],
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-browser", 2_000, "call", "sessions_spawn", "call-browser", "Calling sessions_spawn"),
      tool("result-browser", 4_000, "result", "sessions_spawn", "call-browser", JSON.stringify(sessionResult)),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer reports browser_cdp_unavailable and leaves rendered dashboard state unverified."
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, [
    { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 4_000 },
  ]);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "warn");
});

test("buildMissionObservabilitySnapshot surfaces browser failure bucket progress on completed browser events", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...event(
          "browser-progress",
          "browser",
          4_000,
          "browser",
          "Browser failure buckets: browser_cdp_unavailable=3. Browser task closed out with bounded unavailable evidence."
        ),
        emph: "success",
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer reports browser_cdp_unavailable and leaves rendered dashboard state unverified."
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, [
    { bucket: "browser_cdp_unavailable", count: 1, latestAtMs: 4_000 },
  ]);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "warn");
});

test("buildMissionObservabilitySnapshot ignores negated browser failure bucket mentions in completed browser evidence", () => {
  const sessionResult = {
    protocol: "turnkeyai.session_tool_result.v1",
    status: "completed",
    agent_id: "browser",
    session_key: "worker:browser:1",
    task_id: "task-browser",
    evidence_excerpt: [
      "Rendered dashboard evidence recovered.",
      "Stuck missions: 6.",
      "Weak answer rate: 24%.",
      "Degradation indicators:",
      "| transport_failure | not verified — not present in rendered text |",
      "| lease_conflict | not observed |",
    ].join("\n"),
  };
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-browser", 2_000, "call", "sessions_spawn", "call-browser", "Calling sessions_spawn"),
      tool("result-browser", 4_000, "result", "sessions_spawn", "call-browser", JSON.stringify(sessionResult)),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Rendered dashboard evidence recovered: Stuck missions: 6, Weak answer rate: 24%. Residual risk remains local fixture scope."
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, []);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "pass");
});

test("buildMissionObservabilitySnapshot maps cold browser recovery evidence to session_not_found", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-browser", 2_000, "call", "sessions_send", "call-browser", "Calling sessions_send"),
      tool(
        "result-browser",
        4_000,
        "result",
        "sessions_send",
        "call-browser",
        "Browser evidence recovered via cold-recovered session browser-session-new after the previous session was unavailable."
      ),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Source: browser-visible fixture verified via cold-recovered session browser-session-new. Residual risk remains local fixture scope."
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, [
    { bucket: "session_not_found", count: 2, latestAtMs: 5_000 },
  ]);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "warn");
});

test("buildMissionObservabilitySnapshot does not treat suggested browser respawn as session_not_found", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "working" }),
    nowMs: 6_000,
    events: [
      event(
        "incomplete-1",
        "thought",
        5_000,
        "role-lead",
        [
          "No session evidence has been returned to this thread.",
          "The task cannot be answered without the browser delegation returning its findings.",
          "How to continue: inspect sessions_history for the earlier delegation, or re-spawn a new browser session targeting the localhost evidence source.",
        ].join(" ")
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, []);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "pass");
});

test("buildMissionObservabilitySnapshot does not infer browser buckets from unrelated text", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      {
        ...tool(
          "result-search-failed",
          3_000,
          "result",
          "web_search",
          "call-search",
          "Tool web_search failed: connection refused while fetching a CDP documentation page."
        ),
        emph: "danger" as const,
      },
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        "Final answer notes that an unrelated CDP page said target_not_found during background research."
      ),
    ],
  });

  assert.deepEqual(snapshot.browser.failureBuckets, []);
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "browser_failure_bucket")?.status, "pass");
});

test("buildMissionObservabilitySnapshot flags budget-limited tool-loop closeout answers", () => {
  const finalAnswer = event(
    "final-1",
    "thought",
    5_000,
    "role-lead",
    [
      "Based on verified tool evidence, the partial comparison is evidence-backed and useful.",
      "The gathered source evidence supports the confirmed points, and residual risk is that the tool budget ended before every source could be checked.",
      "No unsupported future pricing or adoption claim is included.",
    ].join(" ")
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      {
        ...finalAnswer,
        runtime: {
          ...finalAnswer.runtime,
          toolLoopCloseout: "true",
          toolLoopCloseoutReason: "round_limit",
          "toolLoopCloseout.roundCount": "2",
          "toolLoopCloseout.toolCallCount": "2",
          "toolLoopCloseout.pendingToolCallCount": "1",
          "toolLoopCloseout.evidenceAvailable": "true",
        },
      },
    ],
  });

  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "tool_loop_closeout")?.status, "warn");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "tool_loop_closeout")?.detail ?? "",
    /tool-round limit/
  );
});

test("buildMissionObservabilitySnapshot flags repeated tool failure closeout answers", () => {
  const finalAnswer = event(
    "final-1",
    "thought",
    5_000,
    "role-lead",
    [
      "Verification did not complete after repeated tool failures.",
      "The answer separates gathered evidence from unverified claims and asks for the next source to check.",
      "Residual risk remains because the failing source produced no usable evidence.",
    ].join(" ")
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 3_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn failed."),
      tool("call-2", 4_000, "call", "sessions_spawn", "call-b", "Calling sessions_spawn"),
      tool("result-2", 4_500, "result", "sessions_spawn", "call-b", "Tool sessions_spawn failed."),
      {
        ...finalAnswer,
        runtime: {
          ...finalAnswer.runtime,
          toolLoopCloseout: "true",
          toolLoopCloseoutReason: "repeated_tool_failure",
          "toolLoopCloseout.roundCount": "2",
          "toolLoopCloseout.toolCallCount": "2",
          "toolLoopCloseout.pendingToolCallCount": "1",
          "toolLoopCloseout.toolName": "sessions_spawn",
          "toolLoopCloseout.evidenceAvailable": "false",
        },
      },
    ],
  });

  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "tool_loop_closeout")?.status, "warn");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "tool_loop_closeout")?.detail ?? "",
    /repeated failed attempts/
  );
});

test("buildMissionObservabilitySnapshot accepts completed sub-agent final closeout as healthy", () => {
  const finalAnswer = event(
    "final-1",
    "thought",
    5_000,
    "role-lead",
    [
      "Based on verified tool evidence, the comparison is evidence-backed and complete.",
      "The gathered source evidence supports the confirmed points, and residual risk is limited to later source updates.",
      "No unsupported future pricing or adoption claim is included.",
    ].join(" ")
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      {
        ...finalAnswer,
        runtime: {
          ...finalAnswer.runtime,
          toolLoopCloseout: "true",
          toolLoopCloseoutReason: "completed_sub_agent_final",
          "toolLoopCloseout.roundCount": "1",
          "toolLoopCloseout.toolCallCount": "1",
          "toolLoopCloseout.finalContentCount": "1",
          "toolLoopCloseout.evidenceAvailable": "true",
        },
      },
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "tool_loop_closeout")?.status, "pass");
});

test("buildMissionObservabilitySnapshot accepts bounded partial sub-agent final closeout as healthy", () => {
  const finalAnswer = event(
    "final-1",
    "thought",
    5_000,
    "role-lead",
    [
      "Based on bounded partial worker evidence, queue depth is 11 and SLA breaches are 3.",
      "Residual risk: panels outside the partial evidence remain unverified.",
      "This answer does not claim broader completion beyond the returned final content.",
    ].join(" ")
  );
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_send", "call-a", "Calling sessions_send"),
      tool("result-1", 4_000, "result", "sessions_send", "call-a", "Tool sessions_send returned bounded partial evidence."),
      {
        ...finalAnswer,
        runtime: {
          ...finalAnswer.runtime,
          toolLoopCloseout: "true",
          toolLoopCloseoutReason: "partial_sub_agent_final",
          "toolLoopCloseout.roundCount": "1",
          "toolLoopCloseout.toolCallCount": "1",
          "toolLoopCloseout.finalContentCount": "1",
          "toolLoopCloseout.evidenceAvailable": "true",
        },
      },
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "tool_loop_closeout")?.status, "pass");
  assert.match(
    snapshot.qualityGate.checks.find((check) => check.name === "tool_loop_closeout")?.detail ?? "",
    /bounded partial sub-agent final content/
  );
});

test("buildMissionObservabilitySnapshot handles long fallback phrasing without regex backtracking risk", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        `Search${" ".repeat(20_000)}tool${" ".repeat(20_000)}is${" ".repeat(20_000)}unavailable; using my knowledge instead.`
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "tool_fallback_answer")?.status, "warn");
});

test("buildMissionObservabilitySnapshot passes substantive evidence-backed final answers", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "Based on the verified browser evidence and tool result, the task is complete.",
          "The source evidence supports the main recommendation, the observed workflow completed, and the remaining residual risk is limited to any data that changed after the browser capture.",
          "The answer distinguishes confirmed observations from unverified future changes.",
        ].join(" ")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "passed");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "answer_substance")?.status, "pass");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "evidence_usage")?.status, "pass");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "unsupported_uncertainty")?.status, "pass");
});

test("buildMissionObservabilitySnapshot treats source-bound excerpt tables as evidence usage", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned page evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| 研究员 | 检查的 URL | 页面标题 | 关键原文摘录 | 与另一个页面的关系 |",
          "|---|---|---|---|---|",
          '| 研究员A | https://example.com/ | Example Domain | "This domain is for use in documentation examples without needing permission." | 具体示例页面 |',
          '| 研究员B | https://www.iana.org/help/example-domains | Example Domains | "example.com and example.org are maintained for documentation purposes." | 权威说明页面 |',
          "",
          "**结论：** 两页共同说明 example.com 的文档示例用途。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "evidence_usage")?.status, "pass");
});

test("buildMissionObservabilitySnapshot still warns when table lacks quoted source excerpts", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      tool("call-1", 2_000, "call", "sessions_spawn", "call-a", "Calling sessions_spawn"),
      tool("result-1", 4_000, "result", "sessions_spawn", "call-a", "Tool sessions_spawn returned page evidence."),
      event(
        "final-1",
        "thought",
        5_000,
        "role-lead",
        [
          "| 研究员 | 检查的 URL | 页面标题 | 关系 |",
          "|---|---|---|---|",
          "| 研究员A | https://example.com/ | Example Domain | 具体示例页面 |",
          "| 研究员B | https://www.iana.org/help/example-domains | Example Domains | 权威说明页面 |",
          "",
          "结论：两页存在关联。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "evidence_usage")?.status, "warn");
});

test("buildMissionObservabilitySnapshot does not treat placeholder domains as unresolved placeholders", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Explain the evidence from example.com."),
      tool(
        "result-1",
        2_000,
        "result",
        "web_fetch",
        "call-1",
        "Tool web_fetch returned Example Domain: This domain is for use in documentation examples without needing permission. Avoid use in operations."
      ),
      event(
        "final-1",
        "thought",
        3_000,
        "role-lead",
        [
          "Decision Note: example.com is a placeholder domain for documentation examples.",
          "It can be used as a 占位链接 in docs.",
          'Evidence: "This domain is for use in documentation examples without needing permission. Avoid use in operations."',
          "Residual risk: use is source-bounded to documentation examples and operational use remains outside the verified scope.",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "unsupported_uncertainty")?.status, "pass");
});

test("buildMissionObservabilitySnapshot warns when final upgrades avoid operations into production bans", () => {
  const snapshot = buildMissionObservabilitySnapshot({
    mission: baseMission({ status: "done" }),
    nowMs: 6_000,
    events: [
      event("user-1", "plan", 1_000, "user", "Write a source-bounded decision note for example.com."),
      tool(
        "result-1",
        2_000,
        "result",
        "web_fetch",
        "call-1",
        "Tool web_fetch returned Example Domain: This domain is for use in documentation examples without needing permission. Avoid use in operations."
      ),
      event(
        "final-1",
        "thought",
        3_000,
        "role-lead",
        [
          "Decision Note: example.com can be used in documentation examples.",
          'Evidence: "This domain is for use in documentation examples without needing permission. Avoid use in operations."',
          "Risk: 禁止用于任何生产或运营环境、真实服务，否则可能导致路由冲突或安全风险。",
        ].join("\n")
      ),
    ],
  });

  assert.equal(snapshot.qualityGate.status, "needs_attention");
  assert.equal(snapshot.qualityGate.checks.find((check) => check.name === "unsupported_uncertainty")?.status, "warn");
});

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "msn.test",
    shortId: "MSN-0001",
    title: "Test mission",
    desc: "",
    status: "working",
    mode: "research",
    modeLabel: "Research",
    owner: "you",
    ownerLabel: "You",
    createdAt: new Date(1_000).toISOString(),
    createdAtMs: 1_000,
    agents: ["role-lead"],
    progress: 0,
    pendingApprovals: 0,
    blockers: 0,
    contextSummary: [],
    threadId: "thread-1",
    ...overrides,
  };
}

function event(id: string, kind: ActivityEvent["kind"], tMs: number, actor: string, text: string): ActivityEvent {
  return {
    id,
    missionId: "msn.test",
    tMs,
    kind,
    actor,
    text,
  };
}

function tool(
  id: string,
  tMs: number,
  phase: "call" | "progress" | "result",
  toolName: string,
  toolCallId: string,
  text: string
): ActivityEvent {
  return {
    ...event(id, "tool", tMs, "role-lead", text),
    runtime: {
      toolPhase: phase,
      toolName,
      toolCallId,
      messageId: "msg-1",
      round: "1",
      ...(phase === "result" ? { resultContent: text } : {}),
    },
  };
}

function completedSessionResultContent(sessionKey: string, result: string): string {
  return sessionResultContent(sessionKey, "completed", result);
}

function sessionResultContent(sessionKey: string, status: string, result: string): string {
  return JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: sessionKey,
    agent_id: "explore",
    status,
    result,
    final_content: status === "completed" ? result : null,
  });
}

function progress(
  subjectId: string,
  subjectKind: RuntimeProgressEvent["subjectKind"],
  phase: RuntimeProgressEvent["phase"],
  continuityState: NonNullable<RuntimeProgressEvent["continuityState"]>,
  recordedAt: number,
  responseTimeoutAt: number,
  summary: string,
  taskId?: string
): RuntimeProgressEvent {
  return {
    progressId: `progress:${subjectId}:${recordedAt}`,
    threadId: "thread-1",
    subjectKind,
    subjectId,
    phase,
    continuityState,
    responseTimeoutAt,
    summary,
    recordedAt,
    ...(taskId ? { taskId } : {}),
  };
}

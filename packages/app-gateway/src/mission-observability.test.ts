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

  assert.equal(snapshot.qualityGate.status, "passed");
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
    },
  };
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

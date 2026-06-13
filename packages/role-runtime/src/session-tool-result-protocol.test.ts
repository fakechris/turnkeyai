import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionToolResult,
  buildSessionToolTimeoutResult,
  parseSessionToolResult,
  sanitizeEvidenceSummary,
  serializeSessionToolResult,
} from "./session-tool-result-protocol";

test("session tool result protocol serializes completed sub-agent evidence", () => {
  const result = buildSessionToolResult({
    taskId: "task-1",
    sessionKey: "worker:explore:task-1",
    agentId: "explore",
    missingResultMessage: "missing",
    label: "Primary source sweep",
    parentSessionKey: "role:lead:thread:1",
    toolCallId: "call-1",
    result: {
      workerType: "explore",
      status: "completed",
      summary: "Evidence gathered.",
      payload: {
        mode: "llm_sub_agent",
        workerType: "explore",
        content: "Verified: yes.",
      },
    },
  });

  assert.equal(result.protocol, "turnkeyai.session_tool_result.v1");
  assert.equal(result.status, "completed");
  assert.equal(result.label, "Primary source sweep");
  assert.equal(result.parent_session_key, "role:lead:thread:1");
  assert.equal(result.tool_call_id, "call-1");
  assert.equal(result.final_content, "Verified: yes.");
  assert.deepEqual(result.tool_chain, ["explore"]);

  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.deepEqual(parsed, result);
});

test("session tool result protocol preserves timeout evidence semantics", () => {
  const result = buildSessionToolTimeoutResult({
    taskId: "task-1",
    sessionKey: "worker:browser:task-1",
    agentId: "browser",
    label: "Checkout verification",
    parentSessionKey: "role:lead:thread:1",
    toolCallId: "call-timeout",
    timeoutSeconds: 120,
    result: "Timed out after 120s.",
    evidenceSummary: "Observed checkout page title before timeout.",
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.label, "Checkout verification");
  assert.equal(result.parent_session_key, "role:lead:thread:1");
  assert.equal(result.tool_call_id, "call-timeout");
  assert.equal(result.resumable, true);
  assert.equal(result.evidence_available, true);
  assert.equal(result.evidence_summary, "Observed checkout page title before timeout.");

  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.equal(parsed?.status, "timeout");
  assert.equal(parsed?.timeout_seconds, 120);
  assert.equal(parsed?.evidence_available, true);
});

test("session tool result protocol persists browser page evidence summary", () => {
  const result = buildSessionToolResult({
    taskId: "task-1",
    sessionKey: "worker:browser:task-1",
    agentId: "browser",
    missingResultMessage: "missing",
    result: {
      workerType: "browser",
      status: "completed",
      summary: "Browser worker summary omitted the marker.",
      payload: {
        sessionId: "browser-session-1",
        page: {
          finalUrl: "http://127.0.0.1/approval-form",
          title: "Approval Gate Fixture",
          textExcerpt: "TURNKEYAI_APPROVAL_FIXTURE_OK no external mutation was performed.",
        },
      },
    },
  });

  assert.match(result.evidence_summary ?? "", /TURNKEYAI_APPROVAL_FIXTURE_OK/);
  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.match(parsed?.evidence_summary ?? "", /Approval Gate Fixture/);
});

test("session tool result protocol preserves multi-source page evidence summaries", () => {
  const result = buildSessionToolResult({
    taskId: "task-1",
    sessionKey: "worker:explore:task-1",
    agentId: "explore",
    missingResultMessage: "missing",
    result: {
      workerType: "explore",
      status: "completed",
      summary: "Explore worker fetched 2 of 2 sources.",
      payload: {
        pages: [
          {
            finalUrl: "http://127.0.0.1:65210/vendor-alpha",
            title: "Vendor Alpha Evidence",
            textExcerpt: "Pricing: $19 per seat. Strength: browser automation.",
          },
          {
            finalUrl: "http://127.0.0.1:65210/vendor-beta",
            title: "Vendor Beta Evidence",
            textExcerpt: "Pricing: $29 per workspace. Strength: approval workflow.",
          },
        ],
      },
    },
  });

  assert.match(result.evidence_summary ?? "", /vendor-alpha/);
  assert.match(result.evidence_summary ?? "", /\$19 per seat/);
  assert.match(result.evidence_summary ?? "", /vendor-beta/);
  assert.match(result.evidence_summary ?? "", /\$29 per workspace/);
});

test("session tool result protocol lifts browser profile fallback into evidence summary", () => {
  const result = buildSessionToolResult({
    taskId: "task-1",
    sessionKey: "worker:browser:task-1",
    agentId: "browser",
    missingResultMessage: "missing",
    result: {
      workerType: "browser",
      status: "completed",
      summary: "Browser sub-agent finished.",
      payload: {
        mode: "llm_sub_agent",
        workerType: "browser",
        browserRecovery: {
          resumeMode: "warm",
          sessionId: "browser-session-1",
          profileFallback: {
            reason: "profile_locked",
            persistentDir: "/tmp/profile",
            fallbackDir: "/tmp/profile-fallback",
          },
        },
        content: "Verified dashboard queue depth 11.",
      },
    },
  });

  assert.match(result.evidence_summary ?? "", /Profile fallback: profile_locked/);
  assert.match(result.evidence_summary ?? "", /Verified dashboard queue depth 11/);
  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.match(parsed?.evidence_summary ?? "", /profile-fallback/);
});

test("session tool result protocol lifts browser recovery buckets into evidence summary", () => {
  const result = buildSessionToolResult({
    taskId: "task-1",
    sessionKey: "worker:browser:task-1",
    agentId: "browser",
    missingResultMessage: "missing",
    result: {
      workerType: "browser",
      status: "completed",
      summary: "Browser sub-agent recovered after a closed session.",
      payload: {
        mode: "llm_sub_agent",
        workerType: "browser",
        browserRecovery: {
          resumeMode: "cold",
          sessionId: "browser-session-new",
          failureBuckets: [{ bucket: "session_not_found", count: 1 }],
        },
        content: "Recovered dashboard queue depth 11.",
      },
    },
  });

  assert.match(result.evidence_summary ?? "", /Browser failure buckets: session_not_found=1/);
  assert.match(result.evidence_summary ?? "", /Recovered dashboard queue depth 11/);
  assert.deepEqual(result.browser_session, {
    session_id: "browser-session-new",
    resume_mode: "cold",
    source: "browserRecovery",
  });
  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.match(parsed?.evidence_summary ?? "", /session_not_found=1/);
  assert.deepEqual(parsed?.browser_session, result.browser_session);
});

test("session tool result protocol exposes recovered browser session over stale direct session", () => {
  const result = buildSessionToolResult({
    taskId: "task-1",
    sessionKey: "worker:browser:task-1",
    agentId: "browser",
    missingResultMessage: "missing",
    result: {
      workerType: "browser",
      status: "completed",
      summary: "Browser sub-agent recovered after the original browser session closed.",
      payload: {
        mode: "llm_sub_agent",
        workerType: "browser",
        sessionId: "browser-session-old",
        targetId: "target-old",
        resumeMode: "warm",
        browserRecovery: {
          resumeMode: "cold",
          sessionId: "browser-session-new",
          targetId: "target-new",
        },
        content: "Recovered dashboard evidence from the recreated session.",
      },
    },
  });

  assert.deepEqual(result.browser_session, {
    session_id: "browser-session-new",
    target_id: "target-new",
    resume_mode: "cold",
    source: "browserRecovery",
  });
  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.deepEqual(parsed?.browser_session, result.browser_session);
});

test("session tool result protocol lifts nested browser tool observations into evidence summary", () => {
  const result = buildSessionToolResult({
    taskId: "task-1",
    sessionKey: "worker:browser:task-1",
    agentId: "browser",
    missingResultMessage: "missing",
    result: {
      workerType: "browser",
      status: "completed",
      summary: "Browser sub-agent finished.",
      payload: {
        mode: "llm_sub_agent",
        workerType: "browser",
        content: "Sub-agent final omitted dashboard metrics.",
        metadata: {
          toolUse: {
            rounds: [
              {
                results: [
                  {
                    toolName: "browser_snapshot",
                    content: JSON.stringify({
                      status: "completed",
                      summary: "Browser snapshot captured dashboard.",
                      payload: {
                        page: {
                          finalUrl: "http://127.0.0.1/product-signals",
                          title: "Workbench product signals",
                          textExcerpt:
                            "Stuck missions: 6. Weak-answer rate: 24%. Local product signal fixture only.",
                        },
                      },
                    }),
                  },
                  {
                    toolName: "browser_act",
                    content: "Clicked Save.",
                  },
                  {
                    toolName: "browser_snapshot",
                    content: "Snapshot text without the structured tool-result envelope.",
                  },
                ],
              },
            ],
          },
        },
      },
    },
  });

  assert.match(result.evidence_summary ?? "", /browser_snapshot/);
  assert.match(result.evidence_summary ?? "", /Stuck missions: 6/);
  assert.match(result.evidence_summary ?? "", /Weak-answer rate: 24%/);
  assert.doesNotMatch(result.evidence_summary ?? "", /Clicked Save/);
  assert.doesNotMatch(result.evidence_summary ?? "", /without the structured tool-result envelope/);
  assert.ok(
    (result.evidence_summary ?? "").indexOf("Stuck missions: 6") <
      (result.evidence_summary ?? "").indexOf("Sub-agent final omitted dashboard metrics")
  );

  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.match(parsed?.evidence_summary ?? "", /Final URL: http:\/\/127\.0\.0\.1\/product-signals/);
  assert.match(parsed?.evidence_summary ?? "", /Workbench product signals/);
});

test("session tool result protocol normalizes legacy session results", () => {
  const parsed = parseSessionToolResult(
    JSON.stringify({
      task_id: "task-1",
      session_key: "worker:explore:task-1",
      agent_id: "explore",
      status: "completed",
      label: "Legacy label",
      parent_session_key: "role:lead:thread:1",
      tool_call_id: "call-legacy",
      tool_chain: ["explore"],
      result: "Legacy result.",
      final_content: "Short final.",
      payload: {
        mode: "llm_sub_agent",
        content: "Short final.",
      },
    })
  );

  assert.equal(parsed?.protocol, "turnkeyai.session_tool_result.v1");
  assert.equal(parsed?.status, "completed");
  assert.equal(parsed?.label, "Legacy label");
  assert.equal(parsed?.parent_session_key, "role:lead:thread:1");
  assert.equal(parsed?.tool_call_id, "call-legacy");
  assert.equal(parsed?.final_content, "Short final.");
});

test("session tool result protocol rejects explicit unknown protocol versions", () => {
  const parsed = parseSessionToolResult(
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v2",
      task_id: "task-1",
      session_key: "worker:explore:task-1",
      agent_id: "explore",
      status: "completed",
      result: "Future result.",
    })
  );

  assert.equal(parsed, null);
});

test("sanitizeEvidenceSummary trims long utf8 evidence without replacement characters", () => {
  const summary = sanitizeEvidenceSummary(`${"a".repeat(1599)}🙂tail`);

  assert.ok(summary);
  assert.ok(Buffer.byteLength(summary, "utf8") <= 1600);
  assert.equal(summary.includes("�"), false);
});

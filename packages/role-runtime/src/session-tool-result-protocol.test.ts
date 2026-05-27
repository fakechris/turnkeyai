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
    timeoutSeconds: 120,
    result: "Timed out after 120s.",
    evidenceSummary: "Observed checkout page title before timeout.",
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.resumable, true);
  assert.equal(result.evidence_available, true);
  assert.equal(result.evidence_summary, "Observed checkout page title before timeout.");

  const parsed = parseSessionToolResult(serializeSessionToolResult(result));
  assert.equal(parsed?.status, "timeout");
  assert.equal(parsed?.timeout_seconds, 120);
  assert.equal(parsed?.evidence_available, true);
});

test("session tool result protocol normalizes legacy session results", () => {
  const parsed = parseSessionToolResult(
    JSON.stringify({
      task_id: "task-1",
      session_key: "worker:explore:task-1",
      agent_id: "explore",
      status: "completed",
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

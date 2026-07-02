import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "./native-tool-messages";
import {
  parseSessionToolResult,
  SESSION_TOOL_RESULT_PROTOCOL,
} from "./session-tool-result-protocol";
import {
  collectToolResultContentText,
  collectToolTraceResultContent,
  findCompletedSessionEvidence,
  findSubAgentToolTimeout,
  hasUsableEvidence,
  isResumablePartialSessionResult,
  readSessionHistoryEvidence,
} from "./tool-result-evidence";
import type { RoleToolExecutionResult } from "./tool-use";

function result(input: Partial<RoleToolExecutionResult>): RoleToolExecutionResult {
  return {
    toolCallId: "call-1",
    toolName: "web_fetch",
    content: "",
    ...input,
  };
}

function sessionResult(input: Record<string, unknown>): string {
  return JSON.stringify({
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: "task-1",
    session_key: "session-1",
    agent_id: "researcher",
    status: "completed",
    tool_chain: [],
    result: "summary",
    final_content: "final evidence",
    payload: null,
    ...input,
  });
}

test("findCompletedSessionEvidence reads completed session and history evidence", () => {
  const completed = result({
    toolName: "sessions_spawn",
    content: sessionResult({
      final_content: "completed final evidence",
      evidence_summary: "inline browser recovery summary",
    }),
  });
  const history = result({
    toolName: "sessions_history",
    content: JSON.stringify({
      session_key: "session-history",
      total_messages: 1,
      messages: [{ content: "history evidence" }],
    }),
  });

  const evidence = findCompletedSessionEvidence([completed, history]);

  assert.ok(evidence);
  assert.equal(evidence.toolName, "sessions_spawn");
  assert.deepEqual(evidence.finalContents, [
    "summary\n\ninline browser recovery summary",
    "history evidence",
  ]);
});

test("findSubAgentToolTimeout returns timeout metadata and evidence availability", () => {
  const timeout = findSubAgentToolTimeout([
    result({
      toolName: "sessions_send",
      content: sessionResult({
        status: "timeout",
        timeout_seconds: 90,
        evidence_available: true,
        evidence_summary: "partial evidence",
        final_content: null,
      }),
    }),
  ]);

  assert.deepEqual(timeout, {
    toolName: "sessions_send",
    sessionKey: "session-1",
    agentId: "researcher",
    timeoutSeconds: 90,
    evidenceAvailable: true,
  });
});

test("readSessionHistoryEvidence dedupes history fields and falls back for session-looking text", () => {
  const evidence = readSessionHistoryEvidence(
    JSON.stringify({
      session_key: "session-1",
      total_messages: 2,
      messages: [
        { content: "same evidence" },
        { summary: "same evidence", final_content: "final detail" },
      ],
      result: "top-level result",
    }),
  );

  assert.equal(
    evidence,
    "same evidence\n\nsame evidence\nfinal detail\n\ntop-level result",
  );
  assert.equal(
    readSessionHistoryEvidence("sessions_history session_key total_messages"),
    "sessions_history session_key total_messages",
  );
  assert.equal(readSessionHistoryEvidence("plain text"), null);
});

test("isResumablePartialSessionResult reads resumableReason from payload", () => {
  const parsed = parseSessionToolResult(
    sessionResult({
      status: "partial",
      payload: { resumableReason: "needs more time" },
      final_content: null,
    }),
  );

  assert.ok(parsed);
  assert.equal(isResumablePartialSessionResult(parsed), true);
});

test("tool result content collectors keep non-empty text and usable evidence ignores failed/skipped results", () => {
  const results: RoleToolExecutionResult[] = [
    result({ content: "first" }),
    result({ content: "  " }),
    result({ content: "second" }),
  ];
  const rounds: NativeToolRoundTrace[] = [
    {
      round: 1,
      calls: [],
      results: [
        {
          toolCallId: "call-1",
          toolName: "web_fetch",
          isError: true,
          contentBytes: 5,
          content: "error",
        },
        {
          toolCallId: "call-2",
          toolName: "web_fetch",
          isError: false,
          skipped: true,
          contentBytes: 7,
          content: "skipped",
        },
      ],
    },
    {
      round: 2,
      calls: [],
      results: [
        {
          toolCallId: "call-3",
          toolName: "web_fetch",
          isError: false,
          contentBytes: 8,
          content: "usable",
        },
      ],
    },
  ];

  assert.equal(collectToolResultContentText(results), "first\n\nsecond");
  assert.equal(
    collectToolTraceResultContent(rounds),
    "error\n\nskipped\n\nusable",
  );
  assert.equal(hasUsableEvidence(rounds), true);
});

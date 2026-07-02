import assert from "node:assert/strict";
import test from "node:test";

import type { RoleToolExecutionResult } from "./tool-use";
import {
  canonicalizeSessionToolTraceCalls,
  countNativeToolCalls,
  type NativeToolRoundTrace,
} from "./native-tool-messages";

function sessionResult(sessionKey: string): string {
  return JSON.stringify({
    protocol: "turnkeyai.session_tool_result.v1",
    task_id: "task-1",
    session_key: sessionKey,
    agent_id: "browser",
    status: "completed",
    tool_chain: ["browser"],
    result: "done",
    final_content: "done",
    payload: null,
  });
}

test("canonicalizeSessionToolTraceCalls updates session calls from structured results", () => {
  const round: NativeToolRoundTrace = {
    round: 1,
    calls: [
      {
        id: "toolu-session",
        name: "sessions_send",
        input: { session_key: "worker:browser:old", message: "continue" },
      },
      { id: "toolu-fetch", name: "web_fetch", input: { url: "https://e.test" } },
    ],
    results: [],
  };
  const results: RoleToolExecutionResult[] = [
    {
      toolCallId: "toolu-session",
      toolName: "sessions_send",
      content: sessionResult("worker:browser:new"),
    },
    {
      toolCallId: "toolu-fetch",
      toolName: "web_fetch",
      content: sessionResult("ignored"),
    },
  ];

  assert.equal(canonicalizeSessionToolTraceCalls(round, results), true);
  assert.deepEqual(round.calls[0]?.input, {
    session_key: "worker:browser:new",
    message: "continue",
  });
  assert.deepEqual(round.calls[1]?.input, { url: "https://e.test" });
});

test("canonicalizeSessionToolTraceCalls reports unchanged when result key already matches", () => {
  const round: NativeToolRoundTrace = {
    round: 1,
    calls: [
      {
        id: "toolu-session",
        name: "sessions_history",
        input: { session_key: "worker:browser:same" },
      },
    ],
    results: [],
  };

  assert.equal(
    canonicalizeSessionToolTraceCalls(round, [
      {
        toolCallId: "toolu-session",
        toolName: "sessions_history",
        content: sessionResult("worker:browser:same"),
      },
    ]),
    false,
  );
});

test("countNativeToolCalls counts calls across trace rounds", () => {
  assert.equal(
    countNativeToolCalls([
      { round: 1, calls: [{ id: "a", name: "web_fetch", input: {} }], results: [] },
      {
        round: 2,
        calls: [
          { id: "b", name: "sessions_send", input: {} },
          { id: "c", name: "sessions_history", input: {} },
        ],
        results: [],
      },
    ]),
    3,
  );
});

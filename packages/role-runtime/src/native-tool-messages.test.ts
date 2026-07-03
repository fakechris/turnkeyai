import assert from "node:assert/strict";
import test from "node:test";

import type { RoleToolExecutionResult } from "./tool-use";
import {
  canonicalizeSessionToolTraceCalls,
  countNativeToolCalls,
  persistNativeToolTraceSafely,
  type NativeToolRoundTrace,
} from "./native-tool-messages";
import type { RoleActivationInput, TeamMessage } from "@turnkeyai/core-types/team";

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

test("persistNativeToolTraceSafely appends native tool messages", async () => {
  const appended: TeamMessage[] = [];
  const activation = buildActivation();
  const toolTrace: NativeToolRoundTrace[] = [
    {
      round: 1,
      calls: [{ id: "call-1", name: "web_fetch", input: { url: "https://e.test" } }],
      results: [
        {
          toolCallId: "call-1",
          toolName: "web_fetch",
          isError: false,
          contentBytes: 2,
          content: "ok",
        },
      ],
      progress: [
        {
          toolCallId: "call-1",
          toolName: "web_fetch",
          phase: "started",
          summary: "Tool call started: web_fetch",
          ts: 100,
        },
      ],
    },
  ];

  await persistNativeToolTraceSafely({
    activation,
    toolTrace,
    nativeToolMessageStore: {
      async append(message) {
        appended.push(message);
      },
    },
    now: () => 1000,
  });

  assert.equal(appended.length, 2);
  assert.equal(appended[0]?.id, "task-1:tool-round:1:assistant");
  assert.equal(appended[0]?.metadata?.["nativeToolUse"], true);
  assert.equal(appended[1]?.id, "task-1:tool-round:1:result:call-1");
  assert.equal(appended[1]?.toolCallId, "call-1");
});

test("persistNativeToolTraceSafely is a no-op without a store", async () => {
  await persistNativeToolTraceSafely({
    activation: buildActivation(),
    toolTrace: [],
    now: () => 1,
  });
});

test("persistNativeToolTraceSafely swallows store failures", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await persistNativeToolTraceSafely({
      activation: buildActivation(),
      toolTrace: [
        {
          round: 1,
          calls: [{ id: "call-1", name: "web_fetch", input: {} }],
          results: [],
        },
      ],
      nativeToolMessageStore: {
        async append() {
          throw new Error("store unavailable");
        },
      },
      now: () => 1,
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.[0], "native tool message persistence failed");
});

function buildActivation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      leadRoleId: "role-lead",
      roles: [{ roleId: "role-lead", name: "Lead", seat: "lead" }],
    },
    flow: { flowId: "flow-1" },
    handoff: {
      taskId: "task-1",
      activationType: "user_request",
    },
    runState: {
      runKey: "run-1",
      roleId: "role-lead",
    },
  } as unknown as RoleActivationInput;
}

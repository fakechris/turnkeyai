import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { createContinuationController } from "./continuation-controller";

const sessionKey = "worker:explore:task-source:toolu-timeout";

function taskPromptWithSession(): string {
  return [
    "Task brief:",
    "Continue from the slow-source attempt in this mission.",
    "Resume the existing source-check context if possible.",
    "",
    "Previous tool result:",
    JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      session_key: sessionKey,
      agent_id: "explore",
      status: "timeout",
      result: "slow source timed out",
    }),
    "",
    "Recent turns:",
    "[user] Continue from the slow-source attempt in this mission.",
  ].join("\n");
}

function taskPromptWithoutSessionKey(): string {
  return [
    "Task brief:",
    "Continue from the slow-source attempt in this mission.",
    "Resume the existing source-check context if possible.",
    "",
    "Recent turns:",
    "[user] Continue from the slow-source attempt in this mission.",
  ].join("\n");
}

function sentTrace(): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: [
        {
          id: "toolu-sent",
          name: "sessions_send",
          input: { session_key: sessionKey, message: "already sent" },
        },
      ],
      results: [],
    },
  ];
}

test("ContinuationController injects sessions_send for an empty continuation round", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 0,
    taskPrompt: taskPromptWithSession(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(action.kind === "inject_calls" && action.reason, "empty_round_session_continuation");
  assert.equal(action.kind === "inject_calls" && action.calls[0]?.id, "runtime-continuation-1");
  assert.equal(action.kind === "inject_calls" && action.calls[0]?.name, "sessions_send");
  assert.equal(
    action.kind === "inject_calls" &&
      action.calls[0]?.input["session_key"],
    sessionKey,
  );
  assert.match(
    String(action.kind === "inject_calls" && action.calls[0]?.input["message"]),
    /Continue from the slow-source attempt in this mission/,
  );
});

test("ContinuationController prefers sessions_send over continuation lookup", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 2,
    taskPrompt: taskPromptWithSession(),
    toolTrace: [],
    tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.name,
    "sessions_send",
  );
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.id,
    "runtime-continuation-3",
  );
});

test("ContinuationController injects sessions_list when continuation lacks a session key", () => {
  const controller = createContinuationController();

  const action = controller.onRoundEmpty({
    active: true,
    messages: [],
    round: 0,
    taskPrompt: taskPromptWithoutSessionKey(),
    toolTrace: [],
    tools: [{ name: "sessions_list" }],
  });

  assert.equal(action.kind, "inject_calls");
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.id,
    "runtime-continuation-lookup-1",
  );
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.name,
    "sessions_list",
  );
  assert.equal(
    action.kind === "inject_calls" && action.calls[0]?.input["limit"],
    5,
  );
  assert.match(
    String(action.kind === "inject_calls" && action.calls[0]?.input["reason"]),
    /^continuation lookup: Continue from the slow-source attempt in this mission/,
  );
});

test("ContinuationController does not repeat an already-sent continuation or inject unavailable tools", () => {
  const controller = createContinuationController();

  assert.deepEqual(
    controller.onRoundEmpty({
      active: true,
      messages: [],
      round: 0,
      taskPrompt: taskPromptWithSession(),
      toolTrace: sentTrace(),
      tools: [{ name: "sessions_send" }, { name: "sessions_list" }],
    }),
    { kind: "none" },
  );
  assert.deepEqual(
    controller.onRoundEmpty({
      active: true,
      messages: [],
      round: 0,
      taskPrompt: taskPromptWithSession(),
      toolTrace: [],
      tools: [],
    }),
    { kind: "none" },
  );
});

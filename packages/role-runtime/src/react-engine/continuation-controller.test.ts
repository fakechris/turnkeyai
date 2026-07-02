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

function sentTrace(sentSessionKey = sessionKey): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: [
        {
          id: "toolu-sent",
          name: "sessions_send",
          input: { session_key: sentSessionKey, message: "already sent" },
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

test("ContinuationController continues an approved browser timeout before coverage timeout", () => {
  const controller = createContinuationController();
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:browser:approved-submit:toolu-submit",
    agentId: "browser",
    timeoutSeconds: 45,
    evidenceAvailable: true,
  };

  const action = controller.onAfterExecuteTimeoutContinuation({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: [
      "Operator decision recorded for approval ap-1.",
      "Action: browser.form.submit.",
      "The operator approved it, and the runtime has already recorded permission.result and permission.applied; the runtime permission cache is already applied.",
      "Do not call permission tools again. Continue from the approved point: perform only the approved scoped action now and verify the result before the final answer.",
      "Compare provider web search pricing across https://a.example, https://b.example, and https://c.example; do not finalize until all three sources are checked.",
    ].join("\n"),
    toolTrace: [],
    timeoutSignal,
    tools: [{ name: "sessions_send" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(action.kind === "continue" && action.reason, "approved_browser_timeout_continuation");
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "sessions_send" },
  );
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    /approved browser action timed out before verification/,
  );
});

test("ContinuationController continues a coverage-critical sibling timeout", () => {
  const controller = createContinuationController();
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:explore:source-b:toolu-timeout",
    agentId: "explore",
    timeoutSeconds: 45,
    evidenceAvailable: true,
  };

  const action = controller.onAfterExecuteTimeoutContinuation({
    messages: [{ role: "user", content: "tool result history" }],
    taskPrompt: [
      "Compare providers with web search pricing evidence.",
      "Check all three sources before final: https://a.example, https://b.example, https://c.example.",
      "Do not finalize until all three sources are verified.",
    ].join("\n"),
    toolTrace: [],
    timeoutSignal,
    tools: [{ name: "sessions_send" }],
  });

  assert.equal(action.kind, "continue");
  assert.equal(action.kind === "continue" && action.reason, "coverage_timeout_continuation");
  assert.deepEqual(
    action.kind === "continue" && action.forceToolChoice,
    { name: "sessions_send" },
  );
  assert.match(
    String(action.kind === "continue" && action.messages.at(-1)?.content),
    /required delegated evidence stream timed out/,
  );
});

test("ContinuationController skips timeout continuation after marker or prior send", () => {
  const controller = createContinuationController();
  const timeoutSignal = {
    toolName: "sessions_spawn",
    sessionKey: "worker:explore:source-b:toolu-timeout",
    agentId: "explore",
    timeoutSeconds: 45,
    evidenceAvailable: true,
  };

  assert.deepEqual(
    controller.onAfterExecuteTimeoutContinuation({
      messages: [
        {
          role: "user",
          content:
            "Runtime correction: a required delegated evidence stream timed out.",
        },
      ],
      taskPrompt: [
        "Compare providers with web search pricing evidence.",
        "Check all three sources before final: https://a.example, https://b.example, https://c.example.",
        "Do not finalize until all three sources are verified.",
      ].join("\n"),
      toolTrace: [],
      timeoutSignal,
      tools: [{ name: "sessions_send" }],
    }),
    { kind: "none" },
  );
  assert.deepEqual(
    controller.onAfterExecuteTimeoutContinuation({
      messages: [{ role: "user", content: "tool result history" }],
      taskPrompt: [
        "Compare providers with web search pricing evidence.",
        "Check all three sources before final: https://a.example, https://b.example, https://c.example.",
        "Do not finalize until all three sources are verified.",
      ].join("\n"),
      toolTrace: sentTrace(timeoutSignal.sessionKey),
      timeoutSignal,
      tools: [{ name: "sessions_send" }],
    }),
    { kind: "none" },
  );
});

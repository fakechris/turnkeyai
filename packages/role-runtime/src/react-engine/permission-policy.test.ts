import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPermissionSuppressInput,
  createPermissionPolicy,
} from "./permission-policy";

test("PermissionPolicy suppresses read-only permission_query with a consumed tool-free round", () => {
  const policy = createPermissionPolicy();
  const input = {
    calls: [
      {
        id: "call-permission",
        name: "permission_query",
        input: {
          action: "browser.form.submit",
          rationale: "approval-gated browser form submission",
        },
      },
    ],
    taskPrompt:
      "Read-only provider pricing research note. Extract listed sources and evidence only.",
    sessionContext: "",
  };

  assert.equal(policy.wouldSuppressReadOnlyPermissionQuery(input), true);
  const decision = policy.suppressReadOnlyPermissionQuery(input);
  assert.equal(decision.kind, "suppress");
  if (decision.kind === "suppress") {
    assert.equal(decision.consumesRound, true);
    assert.equal(decision.forceToolChoice, "none");
    assert.match(decision.messages[0]?.content as string, /read-only browser inspection/);
    assert.deepEqual(
      policy.applySuppressDecision(decision, {
        messages: [{ role: "user", content: "Research pricing." }],
        lastText: "I need approval before continuing.",
      }),
      {
        messages: [
          { role: "user", content: "Research pricing." },
          { role: "assistant", content: "I need approval before continuing." },
          decision.messages[0],
        ],
        forceToolChoice: "none",
      },
    );
  }
  assert.equal(
    policy.applySuppressDecision(
      { kind: "none" },
      {
        messages: [{ role: "user", content: "Research pricing." }],
        lastText: "No suppression.",
      },
    ),
    null,
  );
});

test("PermissionPolicy does not suppress requested approval-gated browser actions", () => {
  const policy = createPermissionPolicy();
  const input = {
    calls: [
      {
        id: "call-permission",
        name: "permission_query",
        input: {
          action: "browser.form.submit",
          rationale: "approval-gated browser form submission",
        },
      },
    ],
    taskPrompt:
      "After operator approval, use the browser to submit the dry-run approval form and verify the result.",
    sessionContext: "",
  };

  assert.equal(policy.wouldSuppressReadOnlyPermissionQuery(input), false);
  assert.deepEqual(policy.suppressReadOnlyPermissionQuery(input), { kind: "none" });
});

test("buildPermissionSuppressInput resolves live continuation context", () => {
  const sessionKey = "worker:browser:task-permission";
  const call = {
    id: "call-permission",
    name: "permission_query",
    input: { action: "browser.form.submit" },
  };
  const input = buildPermissionSuppressInput({
    calls: [call],
    taskPrompt: "Read the current browser session before answering.",
    messages: [
      {
        role: "tool",
        toolCallId: "call-1",
        name: "sessions_spawn",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-1",
            content: JSON.stringify({
              protocol: "turnkeyai.session_tool_result.v1",
              status: "completed",
              agent_id: "browser",
              session_key: sessionKey,
              final: "browser evidence",
            }),
          },
        ],
      },
    ],
  });

  assert.deepEqual(input.calls, [call]);
  assert.equal(input.taskPrompt, "Read the current browser session before answering.");
  assert.match(input.sessionContext, new RegExp(sessionKey));
});

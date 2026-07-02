import assert from "node:assert/strict";
import test from "node:test";

import { createPermissionPolicy } from "./permission-policy";

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

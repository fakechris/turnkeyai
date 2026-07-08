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

test("PermissionPolicy suppresses permission_query invented during source-backed recovery context", () => {
  const policy = createPermissionPolicy();
  const input = {
    calls: [
      {
        id: "call-permission",
        name: "permission_query",
        input: {
          action: "browser.form.submit",
          title: "Approve local dry-run browser form submission",
          risk: "Applies an approval-gated browser form submission in an isolated local dry-run page.",
          scope: "mutate",
          rationale:
            "The user asked to carry a browser form submission through the approval gate.",
        },
      },
    ],
    taskPrompt:
      "System recovery: verify only the missing or unverified core slots requested by the original mission.",
    sessionContext:
      "Original mission: Start a source-backed review of Vendor Alpha for a product lead. Focus on pricing, strength, and risk, and keep source labels visible.",
  };

  assert.equal(policy.wouldSuppressReadOnlyPermissionQuery(input), true);
  assert.equal(policy.suppressReadOnlyPermissionQuery(input).kind, "suppress");
});

test("PermissionPolicy suppresses permission_query invented for visible approval fields in browser page reviews", () => {
  const policy = createPermissionPolicy();
  const input = {
    calls: [
      {
        id: "call-permission",
        name: "permission_query",
        input: {
          action: "browser.form.submit",
          title: "Approve local dry-run browser form submission",
          risk: "Applies an approval-gated browser form submission in an isolated local dry-run page.",
          scope: "mutate",
          rationale:
            "The page review asks for an approval requirement and a details popup.",
        },
      },
    ],
    taskPrompt: [
      "Review this complex browser page as an operator would see it.",
      "The page combines an embedded source frame, a shadow-style review component, and a details popup workflow.",
      "Locate and click the details popup trigger, then summarize the visible operational state, owner, approval requirement, and residual risk.",
      "Use only what the browser-visible page state actually shows.",
    ].join("\n"),
    sessionContext: "",
  };

  assert.equal(policy.wouldSuppressReadOnlyPermissionQuery(input), true);
  assert.equal(policy.suppressReadOnlyPermissionQuery(input).kind, "suppress");
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

test("PermissionPolicy owns suppress-tool-calls hook flow order", () => {
  const policy = createPermissionPolicy();
  const readOnlyRepairMarkers: Array<{ role: "user"; content: string }> = [];

  assert.equal(
    policy.applySuppressToolCallsHook({
      active: false,
      calls: [
        {
          id: "call-permission",
          name: "permission_query",
          input: { action: "browser.form.submit" },
        },
      ],
      taskPrompt: "Read-only browser inspection.",
      messages: [{ role: "user", content: "Research provider pricing." }],
      lastText: "I need approval before continuing.",
      repairMarkers: readOnlyRepairMarkers,
    }),
    null,
  );
  assert.equal(
    policy.applySuppressToolCallsHook({
      active: true,
      calls: [],
      taskPrompt: "Read-only browser inspection.",
      messages: [{ role: "user", content: "Research provider pricing." }],
      lastText: "I need approval before continuing.",
      repairMarkers: readOnlyRepairMarkers,
    }),
    null,
  );

  const readOnlyResult = policy.applySuppressToolCallsHook({
    active: true,
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
      "Read-only browser inspection. No form submission is needed; summarize listed provider pricing sources only.",
    messages: [{ role: "user", content: "Research provider pricing." }],
    lastText: "I need approval before continuing.",
    repairMarkers: readOnlyRepairMarkers,
  });

  assert.equal(readOnlyResult?.forceToolChoice, "none");
  assert.deepEqual(readOnlyResult?.messages.slice(0, 2), [
    { role: "user", content: "Research provider pricing." },
    { role: "assistant", content: "I need approval before continuing." },
  ]);
  assert.match(
    readOnlyResult?.messages[2]?.content as string,
    /Runtime correction: read-only browser inspection/,
  );
  assert.equal(readOnlyRepairMarkers.length, 0);

  const setupRepairMarkers: Array<{ role: "user"; content: string }> = [];
  const setupResult = policy.applySuppressToolCallsHook({
    active: true,
    calls: [
      {
        id: "call-search",
        name: "web_search",
        input: { query: "unneeded setup-only search" },
      },
    ],
    taskPrompt:
      "No research is needed. Briefly acknowledge we can continue when context is provided.",
    messages: [{ role: "user", content: "Stand by for context." }],
    lastText: "I will search first.",
    repairMarkers: setupRepairMarkers,
  });

  assert.equal(setupResult?.forceToolChoice, "none");
  assert.equal(setupResult?.messages[0]?.content, "Stand by for context.");
  assert.equal(setupResult?.messages[1]?.content, "I will search first.");
  assert.match(
    setupResult?.messages[2]?.content as string,
    /Runtime correction: this turn is setup-only/,
  );
  assert.equal(setupRepairMarkers.length, 1);
  assert.deepEqual(setupResult?.messages[2], setupRepairMarkers[0]);

  assert.equal(
    policy.applySuppressToolCallsHook({
      active: true,
      calls: [{ id: "call-search", name: "web_search", input: { query: "x" } }],
      taskPrompt: "Research current provider pricing.",
      messages: [{ role: "user", content: "Research pricing." }],
      lastText: "Searching.",
      repairMarkers: [],
    }),
    null,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { produceTaskIntentEnvelope } from "./task-intent-producer";

function makeActivation(): RoleActivationInput {
  return {
    handoff: {
      payload: {
        intent: {
          relayBrief: "table: vendor | risk",
          instructions: "表格列出：结论、证据 URL",
          recentMessages: [
            { role: "user", content: "table columns: status, owner" },
          ],
        },
      },
    },
  } as RoleActivationInput;
}

test("TaskIntentProducer emits envelope metadata and requested table columns", () => {
  const envelope = produceTaskIntentEnvelope({
    taskPrompt: "table columns: provider, support, evidence URL",
    activation: makeActivation(),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "table: source, quote" }],
      } as LLMMessage,
    ],
  });

  assert.equal(envelope.kind, "task_intent");
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.provenance.some((item) => item.source === "task_prompt"));
  assert.ok(envelope.provenance.some((item) => item.source === "activation"));
  assert.ok(envelope.provenance.some((item) => item.source === "message"));
  assert.deepEqual(envelope.facts.requestedTableColumns, [
    "provider",
    "support",
    "evidence URL",
    "vendor",
    "risk",
    "结论",
    "证据 URL",
    "owner",
    "source",
    "quote",
  ]);
});

test("TaskIntentProducer infers provider support schema requests", () => {
  const envelope = produceTaskIntentEnvelope({
    taskPrompt:
      "Research whether DeepSeek R1 API providers support search/web_search and list input/output pricing with evidence.",
    activation: undefined,
    messages: [],
  });

  assert.equal(envelope.facts.providerSupportSchemaRequested, false);
  assert.deepEqual(envelope.facts.requestedTableColumns, [
    "provider",
    "是否明确支持 DeepSeek R1",
    "是否明确支持 search/web_search",
    "输入价格",
    "输出价格",
    "证据 URL",
    "关键原文摘录",
  ]);
});

test("TaskIntentProducer detects browser-visible and product-signal intent", () => {
  const envelope = produceTaskIntentEnvelope({
    taskPrompt:
      "Inspect the browser-visible rendered product-signals live signal dashboard and report exact visible values.",
    activation: undefined,
    messages: [],
  });

  assert.equal(envelope.facts.browserVisibleEvidenceRequired, true);
  assert.equal(envelope.facts.productSignalDashboardEvidenceRequested, true);
});

test("TaskIntentProducer respects browser-rendered evidence disclaimers", () => {
  const envelope = produceTaskIntentEnvelope({
    taskPrompt:
      "Fetch the static HTML only; no browser-rendered evidence is needed.",
    activation: undefined,
    messages: [],
  });

  assert.equal(envelope.facts.browserVisibleEvidenceRequired, false);
});

test("TaskIntentProducer detects timeout recovery and awaiting-context setup intent", () => {
  const timeout = produceTaskIntentEnvelope({
    taskPrompt: "Continue the timed-out slow-source session.",
    activation: undefined,
    messages: [],
  });
  const awaiting = produceTaskIntentEnvelope({
    taskPrompt:
      "No research is needed. Briefly acknowledge and continue when context is provided.",
    activation: undefined,
    messages: [],
  });

  assert.equal(timeout.facts.timeoutRecoveryRequested, true);
  assert.equal(awaiting.facts.awaitingContextSetupOnly, true);
});

test("TaskIntentProducer infers independent evidence stream counts", () => {
  const twoSource = produceTaskIntentEnvelope({
    taskPrompt:
      "Compare two independent sources: https://a.example and https://b.example. Do not finalize until both streams complete.",
    activation: undefined,
    messages: [],
  });
  const threeStream = produceTaskIntentEnvelope({
    taskPrompt: "Gather evidence from three independent child sessions.",
    activation: undefined,
    messages: [],
  });

  assert.equal(twoSource.facts.requiredIndependentEvidenceStreams, 2);
  assert.equal(threeStream.facts.requiredIndependentEvidenceStreams, 3);
});

test("TaskIntentProducer does not count a truncated URL echo as a second source", () => {
  const envelope = produceTaskIntentEnvelope({
    taskPrompt: [
      "Review https://docs.example.test/catalog/item for comparison-ready notes.",
      "Thread summary: prior evidence came from https://docs.example.test/catalog/ite…",
      "Continue from the same research context and prepare the comparison note.",
    ].join("\n"),
    activation: undefined,
    messages: [],
  });

  assert.equal(envelope.facts.requiredIndependentEvidenceStreams, 0);
});

test("TaskIntentProducer owns approval and continuation task-language facts", () => {
  const approval = produceTaskIntentEnvelope({
    taskPrompt:
      "Use the runtime permission cache already applied for the approval-gated browser.form.submit dry-run. If the operator decision does not arrive, close out safely.",
    activation: undefined,
    messages: [],
  });
  const continuation = produceTaskIntentEnvelope({
    taskPrompt:
      "Continue the existing slow-source source-check context after the timeout and do not finalize until all three evidence streams complete for provider pricing search.",
    activation: undefined,
    messages: [],
  });

  assert.equal(approval.facts.permissionToolsAllowed, true);
  assert.equal(approval.facts.approvalAlreadyApplied, true);
  assert.equal(approval.facts.approvalGatedBrowserActionRequested, true);
  assert.equal(approval.facts.approvalWaitTimeoutCloseoutRequested, true);
  assert.equal(approval.facts.appliedApprovalBrowserContinuation, true);
  assert.equal(continuation.facts.sourceCheckContinuationRequested, true);
  assert.equal(continuation.facts.explicitSessionContinuationRequested, true);
  assert.equal(continuation.facts.coverageCriticalDelegation, true);
  assert.equal(continuation.facts.providerSearchPricingResearch, true);
});

test("TaskIntentProducer distinguishes permission and exact-shape negatives", () => {
  const envelope = produceTaskIntentEnvelope({
    taskPrompt:
      "Read-only browser inspection only; no form submission, mutation, or approval-gated action is needed.",
    activation: undefined,
    messages: [],
  });

  assert.equal(envelope.facts.permissionToolsAllowed, false);
  assert.equal(envelope.facts.approvalGatedBrowserActionRequested, false);
  assert.equal(envelope.facts.exactFinalAnswerShapeExpected, false);
});

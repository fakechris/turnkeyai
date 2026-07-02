import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { RolePromptPacket } from "../prompt-policy";
import { createTerminalCloseoutController } from "./terminal-closeout-controller";

function packet(
  taskPrompt: string,
  outputContract = "",
): RolePromptPacket {
  return {
    roleId: "role:test",
    roleName: "Test Role",
    seat: "member",
    systemPrompt: "You are testing.",
    taskPrompt,
    outputContract,
    suggestedMentions: [],
  } as RolePromptPacket;
}

function result(text: string): GenerateTextResult {
  return { text } as GenerateTextResult;
}

test("TerminalCloseoutController builds approval wait-timeout fallback closeout and redacts forbidden local URLs", () => {
  const controller = createTerminalCloseoutController();

  const fallback = controller.buildApprovalWaitTimeoutFallback({
    selection: { modelId: "model-a", modelChainId: "chain-a" },
    packet: packet("Do not include URLs in the final answer."),
    maxRounds: 4,
    toolCallCount: 3,
    roundCount: 5,
    evidenceText:
      "permission_result: pending approval_wait_timeout at http://localhost:3000/form",
    error: new Error("synthesis unavailable"),
  });

  assert.deepEqual(fallback.closeout, {
    reason: "tool_evidence_fallback",
    maxRounds: 4,
    toolCallCount: 3,
    roundCount: 5,
    evidenceAvailable: true,
  });
  assert.equal(fallback.result.modelId, "model-a");
  assert.equal(fallback.result.modelChainId, "chain-a");
  assert.match(fallback.result.text, /Approval wait-timeout closeout confirmed/);
  assert.doesNotMatch(fallback.result.text, /localhost/);
  assert.match(fallback.result.text, /local fixture source/);
  assert.equal(
    (fallback.result.raw as { message?: string } | null)?.message,
    "synthesis unavailable",
  );
});

test("TerminalCloseoutController builds generic tool-evidence fallback closeout", () => {
  const controller = createTerminalCloseoutController();

  const fallback = controller.buildToolEvidenceFallback({
    packet: packet("", "No links in the final answer."),
    maxRounds: 6,
    toolCallCount: 4,
    roundCount: 7,
    result: {
      text: "Local source: http://127.0.0.1:5173/result",
      stopReason: "stop",
    } as GenerateTextResult,
  });

  assert.deepEqual(fallback.closeout, {
    reason: "tool_evidence_fallback",
    maxRounds: 6,
    toolCallCount: 4,
    roundCount: 7,
    evidenceAvailable: true,
  });
  assert.equal(fallback.result.stopReason, "stop");
  assert.equal(fallback.result.text, "Local source: local fixture source");
});

test("TerminalCloseoutController gates and builds model-call-error local evidence fallback", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    {
      role: "tool",
      name: "web_fetch",
      content: "ACME pricing was verified at http://127.0.0.1:5173/pricing.",
    } as LLMMessage,
  ];
  const common = {
    messages,
    packet: packet("Summarize the verified source fact.", "No links."),
    selection: { modelId: "model-b" },
    error: new Error("gateway unavailable"),
    maxRounds: 5,
    toolCallCount: 1,
    roundCount: 1,
  };

  assert.equal(
    controller.buildModelCallErrorFallback({
      ...common,
      active: false,
      usableEvidence: true,
    }),
    null,
  );
  assert.equal(
    controller.buildModelCallErrorFallback({
      ...common,
      active: true,
      usableEvidence: false,
    }),
    null,
  );

  const fallback = controller.buildModelCallErrorFallback({
    ...common,
    active: true,
    usableEvidence: true,
  });
  assert.ok(fallback);
  assert.deepEqual(fallback.closeout, {
    reason: "tool_evidence_fallback",
    maxRounds: 5,
    toolCallCount: 1,
    roundCount: 1,
    evidenceAvailable: true,
  });
  assert.equal(fallback.result.modelId, "model-b");
  assert.match(fallback.result.text, /Verified:/);
  assert.doesNotMatch(fallback.result.text, /127\.0\.0\.1/);
  assert.match(fallback.result.text, /local fixture source/);
  assert.equal(
    (fallback.result.raw as { message?: string } | null)?.message,
    "gateway unavailable",
  );
});

test("TerminalCloseoutController appends current assistant text for pseudo tool-call synthesis only", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [{ role: "user", content: "Do the task." }];

  const unchanged = controller.buildSynthesisMessages({
    reason: "round_limit",
    messages,
    lastText: "malformed tool call",
  });
  assert.equal(unchanged, messages);

  const appended = controller.buildSynthesisMessages({
    reason: "pseudo_tool_call",
    messages,
    lastText: "malformed tool call",
  });
  assert.notEqual(appended, messages);
  assert.deepEqual(appended, [
    { role: "user", content: "Do the task." },
    { role: "assistant", content: "malformed tool call" },
  ]);
});

test("TerminalCloseoutController applies timeout visibility to non-completed timeout closeouts", () => {
  const controller = createTerminalCloseoutController();

  const timeout = controller.finalizeGeneratedResult({
    reason: "sub_agent_timeout",
    result: result("The delegated source timed out before enough evidence arrived."),
  });
  assert.match(timeout.text, /Continuation: this source check is resumable/);

  const roundLimit = controller.finalizeGeneratedResult({
    reason: "round_limit",
    result: result("The round limit was reached."),
  });
  assert.equal(roundLimit.text, "The round limit was reached.");
});

test("TerminalCloseoutController applies non-completed synthesis effects", () => {
  const controller = createTerminalCloseoutController();

  const applied = controller.applyNonCompletedGeneratedSynthesis({
    reason: "sub_agent_timeout",
    generated: {
      result: result("The delegated source timed out before enough evidence arrived."),
      reduction: { level: "compact" },
      reductionSnapshot: { level: "compact", omittedSections: ["history"] },
      memoryFlush: "flush-1",
    },
  });

  assert.match(applied.result.text, /Continuation: this source check is resumable/);
  assert.deepEqual(applied.memoryFlushes, ["flush-1"]);
  assert.deepEqual(applied.reduction, { level: "compact" });
  assert.deepEqual(applied.reductionSnapshot, {
    level: "compact",
    omittedSections: ["history"],
  });

  const plain = controller.applyNonCompletedGeneratedSynthesis({
    reason: "round_limit",
    generated: { result: result("The round limit was reached.") },
  });
  assert.equal(plain.result.text, "The round limit was reached.");
  assert.deepEqual(plain.memoryFlushes, []);
  assert.equal(plain.reduction, undefined);
  assert.equal(plain.reductionSnapshot, undefined);
});

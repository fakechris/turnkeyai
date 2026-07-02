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

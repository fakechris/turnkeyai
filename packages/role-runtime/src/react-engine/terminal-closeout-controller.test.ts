import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { RolePromptPacket } from "../prompt-policy";
import type { ToolLoopCloseoutMetadata } from "../runtime-derived-mission-report";
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

function recordingTarget() {
  const events: unknown[] = [];
  return {
    events,
    target: {
      recordToolLoopCloseout: (input: unknown) => {
        events.push(["overwrite", input]);
      },
      recordToolLoopCloseoutIfAbsent: (input: unknown) => {
        events.push(["if_absent", input]);
      },
      recordCloseoutResult: (input: unknown) => {
        events.push(["result", input]);
      },
      recordReduction: (input: unknown) => {
        events.push(["reduction", input]);
      },
      recordMemoryFlush: (input: unknown) => {
        events.push(["memory_flush", input]);
      },
    },
  };
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

test("TerminalCloseoutController applies approval wait-timeout fallback through a target", () => {
  const controller = createTerminalCloseoutController();
  const { events, target } = recordingTarget();

  const response = controller.applyApprovalWaitTimeoutFallback(
    {
      selection: { modelId: "model-a", modelChainId: "chain-a" },
      packet: packet("Do not include URLs in the final answer."),
      maxRounds: 4,
      toolCallCount: 3,
      roundCount: 5,
      evidenceText:
        "permission_result: pending approval_wait_timeout at http://localhost:3000/form",
      error: new Error("synthesis unavailable"),
    },
    target,
  );

  assert.match(response.text, /Approval wait-timeout closeout confirmed/);
  assert.deepEqual(events[0], [
    "overwrite",
    {
      reason: "tool_evidence_fallback",
      maxRounds: 4,
      toolCallCount: 3,
      roundCount: 5,
      evidenceAvailable: true,
    },
  ]);
  const resultEvent = events[1];
  assert.ok(Array.isArray(resultEvent));
  assert.equal(resultEvent[0], "result");
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

test("TerminalCloseoutController applies model-call-error fallback through a target", () => {
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
  const { events, target } = recordingTarget();

  assert.equal(
    controller.applyModelCallErrorFallback(
      {
        ...common,
        active: false,
        usableEvidence: true,
      },
      target,
    ),
    null,
  );
  assert.deepEqual(events, []);

  const response = controller.applyModelCallErrorFallback(
    {
      ...common,
      active: true,
      usableEvidence: true,
    },
    target,
  );

  assert.ok(response);
  assert.match(response.text, /Verified:/);
  assert.deepEqual(events[0], [
    "overwrite",
    {
      reason: "tool_evidence_fallback",
      maxRounds: 5,
      toolCallCount: 1,
      roundCount: 1,
      evidenceAvailable: true,
    },
  ]);
  const resultEvent = events[1];
  assert.ok(Array.isArray(resultEvent));
  assert.equal(resultEvent[0], "result");
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

test("TerminalCloseoutController owns terminal synthesis invocation boundaries", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [{ role: "user", content: "Do the task." }];
  let seenRequest:
    | {
        messages: LLMMessage[];
        reasonLines?: string[];
      }
    | undefined;

  const initial = await controller.synthesizeInitialCloseout({
    reason: "pseudo_tool_call",
    messages,
    lastText: "malformed tool call",
    reasonLines: ["Reason line."],
    synthesize: async (request) => {
      seenRequest = request;
      return { result: result("Initial.") };
    },
  });

  assert.deepEqual(initial.result, result("Initial."));
  assert.deepEqual(seenRequest, {
    messages: [
      { role: "user", content: "Do the task." },
      { role: "assistant", content: "malformed tool call" },
    ],
    reasonLines: ["Reason line."],
  });

  const nonCompleted = await controller.synthesizeNonCompletedCloseout({
    reason: "sub_agent_timeout",
    messages,
    lastText: "unused",
    synthesize: async () => ({
      result: result("The delegated source timed out before enough evidence arrived."),
      reduction: { level: "compact" },
      reductionSnapshot: { level: "compact", omittedSections: ["history"] },
      memoryFlush: "flush-1",
    }),
  });

  assert.match(nonCompleted.result.text, /Continuation: this source check is resumable/);
  assert.deepEqual(nonCompleted.memoryFlushes, ["flush-1"]);
  assert.deepEqual(nonCompleted.reduction, { level: "compact" });
  assert.deepEqual(nonCompleted.reductionSnapshot, {
    level: "compact",
    omittedSections: ["history"],
  });
});

test("TerminalCloseoutController owns completed terminal synthesis handoff", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [{ role: "user", content: "Summarize." }];
  const calls: string[] = [];

  const completed = await controller.synthesizeCompletedCloseout<
    string,
    string,
    string
  >({
    reason: "completed_sub_agent_final",
    messages,
    lastText: "unused",
    reasonLines: ["completed evidence"],
    synthesize: async ({ messages: synthesisMessages, reasonLines }) => {
      calls.push("initial");
      assert.equal(synthesisMessages, messages);
      assert.deepEqual(reasonLines, ["completed evidence"]);
      return {
        result: result("initial completed synthesis"),
        reduction: "initial-reduction",
        reductionSnapshot: "initial-snapshot",
        memoryFlush: "initial-flush",
      };
    },
    synthesizeCompleted: async ({ initialSynthesis }) => {
      calls.push("completed");
      assert.equal(initialSynthesis.result.text, "initial completed synthesis");
      assert.equal(initialSynthesis.reduction, "initial-reduction");
      assert.equal(initialSynthesis.reductionSnapshot, "initial-snapshot");
      assert.equal(initialSynthesis.memoryFlush, "initial-flush");
      return {
        kind: "final",
        result: result("completed final"),
        memoryFlushes: ["initial-flush", "repair-flush"],
        reduction: "repair-reduction",
        reductionSnapshot: "repair-snapshot",
      };
    },
  });

  assert.deepEqual(calls, ["initial", "completed"]);
  assert.deepEqual(completed, {
    kind: "final",
    result: result("completed final"),
    memoryFlushes: ["initial-flush", "repair-flush"],
    reduction: "repair-reduction",
    reductionSnapshot: "repair-snapshot",
  });
});

test("TerminalCloseoutController owns terminal closeout write mode and final response shape", () => {
  const controller = createTerminalCloseoutController();

  assert.equal(
    controller.closeoutRecordMode("completed_sub_agent_final"),
    "if_absent",
  );
  assert.equal(controller.closeoutRecordMode("sub_agent_timeout"), "overwrite");
  assert.equal(controller.closeoutRecordMode("round_limit"), "overwrite");

  assert.deepEqual(
    controller.buildFinalResponse({
      text: "Done.",
      stopReason: "stop",
    } as GenerateTextResult),
    { text: "Done.", stopReason: "stop" },
  );
  assert.deepEqual(controller.buildFinalResponse(result("Done.")), {
    text: "Done.",
  });
});

test("TerminalCloseoutController owns sticky terminal closeout pre-recording", () => {
  const controller = createTerminalCloseoutController();
  const { events, target } = recordingTarget();
  const closeout: ToolLoopCloseoutMetadata = {
    reason: "completed_sub_agent_final",
    maxRounds: 4,
    toolCallCount: 2,
    roundCount: 3,
    evidenceAvailable: true,
  };

  controller.recordStickyCloseoutIfNeeded(
    {
      sticky: false,
      closeout,
    },
    target,
  );
  assert.deepEqual(events, []);

  controller.recordStickyCloseoutIfNeeded(
    {
      sticky: true,
      closeout,
    },
    target,
  );
  assert.deepEqual(events, [["if_absent", closeout]]);
});

test("TerminalCloseoutController applies terminal closeout effects through a target", () => {
  const controller = createTerminalCloseoutController();
  const { events, target } = recordingTarget();
  const closeout: ToolLoopCloseoutMetadata = {
    reason: "sub_agent_timeout",
    maxRounds: 4,
    toolCallCount: 2,
    roundCount: 3,
    evidenceAvailable: true,
  };
  const terminalResult = {
    text: "Done.",
    stopReason: "stop",
  } as GenerateTextResult;

  const response = controller.applyCloseoutApplication(
    {
      reason: "sub_agent_timeout",
      closeout,
      result: terminalResult,
      memoryFlushes: ["flush-1"],
      reduction: { level: "compact" },
      reductionSnapshot: { level: "compact", omittedSections: ["history"] },
    },
    target,
  );

  assert.deepEqual(response, { text: "Done.", stopReason: "stop" });
  assert.deepEqual(events, [
    ["memory_flush", "flush-1"],
    ["overwrite", closeout],
    ["result", terminalResult],
    ["reduction", {
      reduction: { level: "compact" },
      reductionSnapshot: { level: "compact", omittedSections: ["history"] },
    }],
  ]);

  events.length = 0;
  const completedResult = result("Completed.");
  controller.applyCloseoutApplication(
    {
      reason: "completed_sub_agent_final",
      closeout: {
        ...closeout,
        reason: "completed_sub_agent_final",
      },
      result: completedResult,
    },
    target,
  );

  assert.deepEqual(events, [
    [
      "if_absent",
      {
        ...closeout,
        reason: "completed_sub_agent_final",
      },
    ],
    ["result", completedResult],
  ]);
});

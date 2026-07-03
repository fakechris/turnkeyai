import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextInput,
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

function baseGatewayInput(): GenerateTextInput {
  return {
    messages: [],
    tools: [{ name: "web_search", description: "", inputSchema: {} }],
    toolChoice: "auto",
    envelope: {
      toolCount: 1,
      toolSchemaBytes: 99,
      toolResultCount: 0,
      toolResultBytes: 0,
    },
  } as GenerateTextInput;
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

test("TerminalCloseoutController owns terminal hook fallback before synthesis", async () => {
  const controller = createTerminalCloseoutController();
  const { events, target } = recordingTarget();
  let synthesizeCalls = 0;

  const completion = await controller.handleTerminalCloseoutHook({
    reason: "tool_evidence_fallback",
    decision: {
      closeout: {
        reason: "tool_evidence_fallback",
        maxRounds: 4,
        toolCallCount: 3,
        roundCount: 5,
        evidenceAvailable: true,
      },
      reasonLines: ["unused because fallback is deterministic"],
    },
    messages: [{ role: "user", content: "Check approval." }],
    lastText: "unused",
    target,
    synthesize: async () => {
      synthesizeCalls += 1;
      return { result: result("should not be used") };
    },
    approvalWaitTimeoutFallback: {
      selection: { modelId: "model-a", modelChainId: "chain-a" },
      packet: packet("Do not include URLs in the final answer."),
      maxRounds: 4,
      toolCallCount: 3,
      roundCount: 5,
      evidenceText:
        "permission_result: pending approval_wait_timeout at http://localhost:3000/form",
      error: new Error("synthesis unavailable"),
    },
  });

  assert.equal(completion.kind, "final");
  if (completion.kind === "final") {
    assert.match(
      completion.response.text,
      /Approval wait-timeout closeout confirmed/,
    );
  }
  assert.equal(synthesizeCalls, 0);
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

test("TerminalCloseoutController builds final synthesis tool-call artifact fallback results", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    {
      role: "tool",
      name: "web_fetch",
      content: "ACME pricing was verified at http://127.0.0.1:5173/pricing.",
    } as LLMMessage,
  ];

  const localEvidence = controller.buildFinalSynthesisToolCallArtifactFallback({
    messages,
    packet: packet("Summarize the verified source fact.", "No links."),
    selection: { modelId: "model-c" },
    repairedResult: result("<tool_call>{}</tool_call>"),
  });

  assert.equal(localEvidence.modelId, "model-c");
  assert.match(localEvidence.text, /Verified:/);
  assert.doesNotMatch(localEvidence.text, /127\.0\.0\.1/);
  assert.match(localEvidence.text, /local fixture source/);
  assert.equal(
    (localEvidence.raw as { message?: string } | null)?.message,
    "final synthesis emitted a tool call after repair",
  );

  const generic = controller.buildFinalSynthesisToolCallArtifactFallback({
    messages: [],
    packet: packet("Return exactly one sentence."),
    selection: {},
    repairedResult: {
      ...result("<tool_call>{}</tool_call>"),
      stopReason: "stop",
    } as GenerateTextResult,
  });

  assert.equal(generic.stopReason, "stop");
  assert.match(generic.text, /model attempted to emit another tool call/);
});

test("TerminalCloseoutController builds final synthesis error fallback results", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    {
      role: "tool",
      name: "web_fetch",
      content: "ACME pricing was verified at http://127.0.0.1:5173/pricing.",
    } as LLMMessage,
  ];

  const fallback = controller.buildFinalSynthesisErrorFallback({
    messages,
    packet: packet("Summarize the verified source fact.", "No links."),
    selection: { modelId: "model-d" },
    error: new Error("final synthesis unavailable"),
  });

  assert.ok(fallback);
  assert.equal(fallback.modelId, "model-d");
  assert.match(fallback.text, /Verified:/);
  assert.doesNotMatch(fallback.text, /127\.0\.0\.1/);
  assert.match(fallback.text, /local fixture source/);
  assert.equal(
    (fallback.raw as { message?: string } | null)?.message,
    "final synthesis unavailable",
  );

  assert.equal(
    controller.buildFinalSynthesisErrorFallback({
      messages: [],
      packet: packet("Return exactly one sentence."),
      selection: {},
      error: new Error("no evidence"),
    }),
    null,
  );
});

test("TerminalCloseoutController builds prepared final synthesis gateway requests", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "Use existing evidence only." },
  ];

  const request = controller.buildFinalSynthesisGatewayRequest({
    packet: packet("Summarize the evidence."),
    messages,
    maxRounds: 3,
  });

  assert.equal(request.sourceMessages.at(0), messages[0]);
  assert.deepEqual(request.gatewayMessages, request.sourceMessages);
  const finalPrompt = request.sourceMessages.at(-1)?.content;
  if (typeof finalPrompt !== "string") {
    assert.fail("final synthesis request must append text guidance");
  }
  assert.match(finalPrompt, /Tool-use round limit reached \(3\)/);
});

test("TerminalCloseoutController evaluates final synthesis provider-schema repair", () => {
  const controller = createTerminalCloseoutController();

  const decision = controller.evaluateFinalSynthesisProviderSchemaRepair({
    messages: [],
    repairMarkers: [],
    resultText: [
      "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
      "| --- | --- | --- | --- |",
      "| A | 未验证 | 未验证 | 未验证 |",
    ].join("\n"),
    taskPrompt:
      "Compare pricing, strengths, risks, tradeoff, and a clear recommendation for the product lead.",
  });

  assert.equal(decision?.policyId, "extraneous_provider_table_schema");
  assert.match(
    decision?.repairPrompt ?? "",
    /introduced provider\/search\/model-support columns/i,
  );

  assert.equal(
    controller.evaluateFinalSynthesisProviderSchemaRepair({
      messages: [],
      repairMarkers: [],
      resultText: [
        "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
        "| --- | --- | --- | --- |",
        "| A | 未验证 | 未验证 | 未验证 |",
      ].join("\n"),
      taskPrompt:
        "Compare provider options for DeepSeek R1 search/web_search support, input price, and output price.",
    }),
    null,
  );
});

test("TerminalCloseoutController builds final synthesis provider-schema repair requests", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "Compare pricing and tradeoffs." },
  ];
  const resultText = [
    "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
    "| --- | --- | --- | --- |",
    "| A | 未验证 | 未验证 | 未验证 |",
  ].join("\n");

  const request = controller.buildFinalSynthesisProviderSchemaRepairRequest({
    taskPrompt:
      "Compare pricing, strengths, risks, tradeoff, and a clear recommendation for the product lead.",
    messages,
    repairMarkers: messages,
    resultText,
  });

  assert.equal(request?.policyId, "extraneous_provider_table_schema");
  assert.equal(request?.sourceMessages.at(0), messages[0]);
  assert.deepEqual(request?.gatewayMessages, request?.sourceMessages);
  const repairContent = request?.sourceMessages.at(-1)?.content;
  if (typeof repairContent !== "string") {
    assert.fail("provider schema repair request must append a text message");
  }
  assert.match(
    repairContent,
    /introduced provider\/search\/model-support columns/i,
  );
  assert.match(repairContent, /\| provider \|/);

  assert.equal(
    controller.buildFinalSynthesisProviderSchemaRepairRequest({
      taskPrompt:
        "Compare provider options for DeepSeek R1 search/web_search support, input price, and output price.",
      messages,
      repairMarkers: messages,
      resultText,
    }),
    null,
  );
});

test("TerminalCloseoutController builds final synthesis tool-call artifact cleanup requests", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "Use existing evidence only." },
  ];

  const request = controller.buildFinalSynthesisToolCallArtifactRepairRequest({
    messages,
    result: result('<tool_call name="web_search">query</tool_call>'),
  });

  assert.equal(request?.sourceMessages.at(0), messages[0]);
  assert.deepEqual(request?.gatewayMessages, request?.sourceMessages);
  assert.equal(request?.sourceMessages.at(-2)?.content, request?.resultText);
  const cleanupContent = request?.sourceMessages.at(-1)?.content;
  if (typeof cleanupContent !== "string") {
    assert.fail("tool-call cleanup request must append a text message");
  }
  assert.match(cleanupContent, /tools are disabled for final synthesis/i);

  assert.equal(
    controller.buildFinalSynthesisToolCallArtifactRepairRequest({
      messages,
      result: result("A clean final answer."),
    }),
    null,
  );
});

test("TerminalCloseoutController owns final synthesis provider repair orchestration", async () => {
  const controller = createTerminalCloseoutController();
  const phases: string[] = [];
  const pruningCalls: unknown[] = [];
  const requests: LLMMessage[][] = [];

  const synthesis = await controller.synthesizeFinalAfterToolRoundLimit({
    packet: packet(
      "Compare pricing, strengths, risks, tradeoff, and a clear recommendation for the product lead.",
    ),
    baseGatewayInput: baseGatewayInput(),
    messages: [{ role: "user", content: "Compare pricing." }],
    maxRounds: 2,
    selection: {},
    recordPruning: (snapshot) => {
      pruningCalls.push(snapshot ?? null);
    },
    synthesize: async ({ gatewayInput, request, tracePhase }) => {
      assert.equal(gatewayInput.messages, request.gatewayMessages);
      assert.equal(gatewayInput.tools, undefined);
      assert.equal(gatewayInput.toolChoice, "none");
      assert.equal(gatewayInput.envelope?.toolCount, 0);
      phases.push(tracePhase);
      requests.push(request.gatewayMessages);
      if (tracePhase === "final_synthesis") {
        return {
          result: result(
            [
              "| provider | 是否明确支持 search/web_search | 输入价格 | 输出价格 |",
              "| --- | --- | --- | --- |",
              "| A | 未验证 | 未验证 | 未验证 |",
            ].join("\n"),
          ),
          memoryFlush: "initial-memory",
        };
      }
      return { result: result("clean provider repair") };
    },
  });

  assert.deepEqual(phases, ["final_synthesis", "final_synthesis_repair"]);
  assert.equal(pruningCalls.length, 2);
  assert.match(
    requests[1]?.at(-1)?.content as string,
    /introduced provider\/search\/model-support columns/i,
  );
  assert.equal(synthesis.result.text, "clean provider repair");
  assert.equal(synthesis.memoryFlush, "initial-memory");
});

test("TerminalCloseoutController owns final synthesis tool-call cleanup orchestration", async () => {
  const controller = createTerminalCloseoutController();
  const phases: string[] = [];
  const requests: LLMMessage[][] = [];

  const synthesis = await controller.synthesizeFinalAfterToolRoundLimit({
    packet: packet("Summarize the verified evidence."),
    baseGatewayInput: baseGatewayInput(),
    messages: [{ role: "user", content: "Summarize evidence." }],
    maxRounds: 2,
    selection: {},
    recordPruning: () => {},
    synthesize: async ({ gatewayInput, request, tracePhase }) => {
      assert.equal(gatewayInput.messages, request.gatewayMessages);
      phases.push(tracePhase);
      requests.push(request.gatewayMessages);
      if (tracePhase === "final_synthesis") {
        return { result: result('<tool_call name="web_search">query</tool_call>') };
      }
      return { result: result("clean tool-call repair") };
    },
  });

  assert.deepEqual(phases, ["final_synthesis", "final_synthesis_repair"]);
  assert.match(
    requests[1]?.at(-1)?.content as string,
    /tools are disabled for final synthesis/i,
  );
  assert.equal(synthesis.result.text, "clean tool-call repair");
});

test("TerminalCloseoutController owns final synthesis gateway-error fallback", async () => {
  const controller = createTerminalCloseoutController();

  const synthesis = await controller.synthesizeFinalAfterToolRoundLimit({
    packet: packet("Summarize the verified source fact.", "No links."),
    baseGatewayInput: baseGatewayInput(),
    messages: [
      {
        role: "tool",
        name: "web_fetch",
        content: "ACME pricing was verified at http://127.0.0.1:5173/pricing.",
      } as LLMMessage,
    ],
    maxRounds: 2,
    selection: { modelId: "model-e" },
    recordPruning: () => {},
    synthesize: async () => {
      throw new Error("final synthesis unavailable");
    },
  });

  assert.equal(synthesis.result.modelId, "model-e");
  assert.match(synthesis.result.text, /Verified:/);
  assert.doesNotMatch(synthesis.result.text, /127\.0\.0\.1/);
});

test("TerminalCloseoutController completes final synthesis tool-call artifact repair", () => {
  const controller = createTerminalCloseoutController();

  const completed = controller.completeFinalSynthesisToolCallArtifactRepair({
    initial: {
      result: result("initial answer with tool markup"),
      memoryFlush: "initial-memory",
    },
    repair: {
      result: result('<tool_call name="web_search">still wrong</tool_call>'),
    },
    fallback: {
      messages: [],
      packet: packet("Return the final answer from available evidence."),
      selection: {},
    },
  });

  assert.match(
    completed.result.text,
    /attempted to emit another tool call after tools were disabled/i,
  );
  assert.equal(completed.memoryFlush, "initial-memory");

  const clean = controller.completeFinalSynthesisToolCallArtifactRepair({
    initial: { result: result("initial answer") },
    repair: { result: result("clean repair answer") },
    fallback: {
      messages: [],
      packet: packet("Return the final answer from available evidence."),
      selection: {},
    },
  });

  assert.equal(clean.result.text, "clean repair answer");
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

test("TerminalCloseoutController owns model-call-error fallback and rethrow boundary", () => {
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
  const skipped = recordingTarget();

  assert.deepEqual(
    controller.handleModelCallErrorFallback(
      {
        ...common,
        active: false,
        usableEvidence: true,
      },
      skipped.target,
    ),
    { kind: "rethrow" },
  );
  assert.deepEqual(skipped.events, []);

  const applied = recordingTarget();
  const handled = controller.handleModelCallErrorFallback(
    {
      ...common,
      active: true,
      usableEvidence: true,
    },
    applied.target,
  );

  assert.equal(handled.kind, "final");
  assert.match(handled.kind === "final" ? handled.response.text : "", /Verified:/);
  assert.deepEqual(applied.events[0], [
    "overwrite",
    {
      reason: "tool_evidence_fallback",
      maxRounds: 5,
      toolCallCount: 1,
      roundCount: 1,
      evidenceAvailable: true,
    },
  ]);
  const resultEvent = applied.events[1];
  assert.ok(Array.isArray(resultEvent));
  assert.equal(resultEvent[0], "result");
});

test("TerminalCloseoutController owns model-call-error flow selection before fallback", () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    {
      role: "tool",
      name: "web_fetch",
      content: "ACME pricing was verified at http://127.0.0.1:5173/pricing.",
    } as LLMMessage,
  ];
  const forcedRound = {
    kind: "forced_tool_round" as const,
    calls: [
      {
        id: "call-1",
        name: "permission_result",
        input: { status: "pending" },
      },
    ],
    assistantText: "Checking approval result.",
    reason: "forced_pending_approval_wait_timeout_permission_result",
  };
  const common = {
    messages,
    packet: packet("Summarize the verified source fact.", "No links."),
    selection: { modelId: "model-b" },
    error: new Error("gateway unavailable"),
    maxRounds: 5,
    toolCallCount: 1,
    roundCount: 1,
  };
  const aborted = recordingTarget();

  assert.deepEqual(
    controller.handleModelCallError(
      {
        ...common,
        aborted: true,
        active: true,
        usableEvidence: true,
        forcedPermissionResult: forcedRound,
      },
      aborted.target,
    ),
    { kind: "rethrow" },
  );
  assert.deepEqual(aborted.events, []);

  const forced = recordingTarget();
  assert.deepEqual(
    controller.handleModelCallError(
      {
        ...common,
        aborted: false,
        active: true,
        usableEvidence: true,
        forcedPermissionResult: forcedRound,
      },
      forced.target,
    ),
    forcedRound,
  );
  assert.deepEqual(forced.events, []);

  const fallback = recordingTarget();
  const handled = controller.handleModelCallError(
    {
      ...common,
      aborted: false,
      active: true,
      usableEvidence: true,
      forcedPermissionResult: { kind: "none" },
    },
    fallback.target,
  );

  assert.equal(handled.kind, "final");
  assert.match(handled.kind === "final" ? handled.response.text : "", /Verified:/);
  assert.deepEqual(fallback.events[0], [
    "overwrite",
    {
      reason: "tool_evidence_fallback",
      maxRounds: 5,
      toolCallCount: 1,
      roundCount: 1,
      evidenceAvailable: true,
    },
  ]);
});

test("TerminalCloseoutController applies model-call-error hook recovery results", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    {
      role: "tool",
      name: "web_fetch",
      content: "ACME pricing was verified at http://127.0.0.1:5173/pricing.",
    } as LLMMessage,
  ];
  const forcedRound = {
    kind: "forced_tool_round" as const,
    calls: [
      {
        id: "call-1",
        name: "permission_result",
        input: { status: "pending" },
      },
    ],
    assistantText: "Checking approval result.",
    reason: "forced_pending_approval_wait_timeout_permission_result",
  };
  const common = {
    messages,
    packet: packet("Summarize the verified source fact.", "No links."),
    selection: { modelId: "model-b" },
    error: new Error("gateway unavailable"),
    maxRounds: 5,
    toolCallCount: 1,
    roundCount: 1,
  };
  const forcedMessages = [
    ...messages,
    {
      role: "tool",
      name: "permission_result",
      content: "pending",
    } as LLMMessage,
  ];
  const executed: unknown[] = [];

  const forced = recordingTarget();
  assert.deepEqual(
    await controller.completeModelCallError(
      {
        ...common,
        aborted: false,
        active: true,
        usableEvidence: true,
        forcedPermissionResult: forcedRound,
      },
      forced.target,
      async (round) => {
        executed.push(round);
        return { messages: forcedMessages, toolResults: [] };
      },
    ),
    { messages: forcedMessages },
  );
  assert.deepEqual(executed, [forcedRound]);
  assert.deepEqual(forced.events, []);

  const aborted = recordingTarget();
  assert.equal(
    await controller.completeModelCallError(
      {
        ...common,
        aborted: true,
        active: true,
        usableEvidence: true,
        forcedPermissionResult: forcedRound,
      },
      aborted.target,
      async () => {
        throw new Error("should not execute");
      },
    ),
    "rethrow",
  );
  assert.deepEqual(aborted.events, []);

  const fallback = recordingTarget();
  const handled = await controller.completeModelCallError(
    {
      ...common,
      aborted: false,
      active: true,
      usableEvidence: true,
      forcedPermissionResult: { kind: "none" },
    },
    fallback.target,
    async () => {
      throw new Error("should not execute");
    },
  );

  assert.equal(typeof handled, "object");
  assert.match(
    typeof handled === "object" && "text" in handled ? handled.text : "",
    /Verified:/,
  );
  assert.deepEqual(fallback.events[0], [
    "overwrite",
    {
      reason: "tool_evidence_fallback",
      maxRounds: 5,
      toolCallCount: 1,
      roundCount: 1,
      evidenceAvailable: true,
    },
  ]);
});

test("TerminalCloseoutController selects model-error forced permission result internally", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    {
      role: "tool",
      name: "web_fetch",
      content: "Verified source evidence.",
    } as LLMMessage,
  ];
  const forcedRound = {
    kind: "forced_tool_round" as const,
    calls: [
      {
        id: "call-1",
        name: "permission_result",
        input: { status: "pending" },
      },
    ],
    assistantText: "Checking approval result.",
    reason: "forced_pending_approval_wait_timeout_permission_result",
  };
  const forcedMessages = [
    ...messages,
    {
      role: "tool",
      name: "permission_result",
      content: "pending",
    } as LLMMessage,
  ];
  const common = {
    active: true,
    usableEvidence: true,
    messages,
    packet: packet("Summarize the verified source fact."),
    selection: { modelId: "model-b" },
    error: new Error("gateway unavailable"),
    maxRounds: 5,
    toolCallCount: 1,
    roundCount: 1,
  };

  let builtForced = 0;
  const forced = recordingTarget();
  assert.deepEqual(
    await controller.completeModelCallErrorFlow(
      {
        ...common,
        aborted: false,
        buildForcedPermissionResult: () => {
          builtForced += 1;
          return forcedRound;
        },
      },
      forced.target,
      async (round) => {
        assert.equal(round, forcedRound);
        return { messages: forcedMessages };
      },
    ),
    { messages: forcedMessages },
  );
  assert.equal(builtForced, 1);
  assert.deepEqual(forced.events, []);

  builtForced = 0;
  const aborted = recordingTarget();
  assert.equal(
    await controller.completeModelCallErrorFlow(
      {
        ...common,
        aborted: true,
        buildForcedPermissionResult: () => {
          builtForced += 1;
          return forcedRound;
        },
      },
      aborted.target,
      async () => {
        throw new Error("should not execute");
      },
    ),
    "rethrow",
  );
  assert.equal(builtForced, 0);

  builtForced = 0;
  const inactive = recordingTarget();
  assert.equal(
    await controller.completeModelCallErrorFlow(
      {
        ...common,
        active: false,
        aborted: false,
        buildForcedPermissionResult: () => {
          builtForced += 1;
          return forcedRound;
        },
      },
      inactive.target,
      async () => {
        throw new Error("should not execute");
      },
    ),
    "rethrow",
  );
  assert.equal(builtForced, 0);

  builtForced = 0;
  const unusable = recordingTarget();
  assert.equal(
    await controller.completeModelCallErrorFlow(
      {
        ...common,
        usableEvidence: false,
        aborted: false,
        buildForcedPermissionResult: () => {
          builtForced += 1;
          return forcedRound;
        },
      },
      unusable.target,
      async () => {
        throw new Error("should not execute");
      },
    ),
    "rethrow",
  );
  assert.equal(builtForced, 0);
});

test("TerminalCloseoutController owns model-call-error hook state capture", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [
    { role: "user", content: "Summarize the approval-backed evidence." },
    {
      role: "tool",
      name: "web_fetch",
      content: "Verified source evidence.",
    } as LLMMessage,
  ];
  const toolTrace = [
    {
      round: 1,
      calls: [{ id: "call-1", name: "web_fetch", input: {} }],
      results: [],
    },
    {
      round: 2,
      calls: [{ id: "call-2", name: "permission_query", input: {} }],
      results: [],
    },
  ];
  const forcedRound = {
    kind: "forced_tool_round" as const,
    calls: [
      {
        id: "call-3",
        name: "permission_result",
        input: { status: "pending" },
      },
    ],
    assistantText: "Checking approval result.",
    reason: "forced_pending_approval_wait_timeout_permission_result",
  };
  const forcedMessages = [
    ...messages,
    {
      role: "tool",
      name: "permission_result",
      content: "pending",
    } as LLMMessage,
  ];
  const { target } = recordingTarget();
  const events: unknown[] = [];
  const recordEvent = (event: unknown) => {
    events.push(event);
  };

  const handled = await controller.completeModelCallErrorHook(
    {
      error: new Error("gateway unavailable"),
      active: true,
      messages,
      packet: packet("Summarize the verified source fact."),
      selection: { modelId: "model-b" },
      maxRounds: 5,
      toolTrace,
      target: {
        ...target,
        captureFinalMessages: (captured) => {
          recordEvent(["capture", captured]);
        },
      },
      evidence: {
        snapshot: (captured) => {
          recordEvent(["evidence", captured]);
          return { usableEvidence: true };
        },
      },
      buildForcedPermissionResult: ({ toolTrace: capturedToolTrace }) => {
        recordEvent(["forced", capturedToolTrace]);
        return forcedRound;
      },
    },
    async (round) => {
      recordEvent(["execute", round]);
      return { messages: forcedMessages };
    },
  );

  assert.deepEqual(handled, { messages: forcedMessages });
  assert.deepEqual(events, [
    ["capture", messages],
    ["evidence", messages],
    ["forced", toolTrace],
    ["execute", forcedRound],
  ]);

  events.length = 0;
  assert.equal(
    await controller.completeModelCallErrorHook(
      {
        error: Object.assign(new Error("aborted"), { name: "AbortError" }),
        active: true,
        messages,
        packet: packet("Summarize the verified source fact."),
        selection: { modelId: "model-b" },
        maxRounds: 5,
        toolTrace,
        target: {
          ...target,
          captureFinalMessages: (captured) => {
            recordEvent(["capture", captured]);
          },
        },
        evidence: {
          snapshot: (captured) => {
            recordEvent(["evidence", captured]);
            return { usableEvidence: true };
          },
        },
        buildForcedPermissionResult: () => {
          recordEvent(["forced"]);
          return forcedRound;
        },
      },
      async () => {
        throw new Error("should not execute");
      },
    ),
    "rethrow",
  );
  assert.deepEqual(events, []);
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

test("TerminalCloseoutController merges final synthesis repair effects with repair precedence", () => {
  const controller = createTerminalCloseoutController();

  const initial = {
    result: result("initial"),
    reduction: "initial-reduction",
    reductionSnapshot: "initial-snapshot",
    memoryFlush: "initial-flush",
  };

  assert.deepEqual(
    controller.mergeFinalSynthesisRepairResult({
      initial,
      repair: {
        result: result("repair"),
        reduction: "repair-reduction",
      },
    }),
    {
      result: result("repair"),
      reduction: "repair-reduction",
      reductionSnapshot: "initial-snapshot",
      memoryFlush: "initial-flush",
    },
  );

  assert.deepEqual(
    controller.mergeFinalSynthesisRepairResult({
      initial,
      repair: {
        result: result("repair with effects"),
        reductionSnapshot: "repair-snapshot",
        memoryFlush: "repair-flush",
      },
    }),
    {
      result: result("repair with effects"),
      reduction: "initial-reduction",
      reductionSnapshot: "repair-snapshot",
      memoryFlush: "repair-flush",
    },
  );
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

test("TerminalCloseoutController owns terminal synthesis path selection and application", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [{ role: "user", content: "Investigate." }];
  const closeout: ToolLoopCloseoutMetadata = {
    reason: "sub_agent_timeout",
    maxRounds: 4,
    toolCallCount: 2,
    roundCount: 3,
    evidenceAvailable: true,
  };
  const { events, target } = recordingTarget();

  const final = await controller.completeTerminalCloseout<string, string, string>({
    reason: "sub_agent_timeout",
    closeout,
    messages,
    lastText: "unused",
    target,
    synthesize: async () => ({
      result: result("The delegated source timed out before enough evidence arrived."),
      reduction: "timeout-reduction",
      reductionSnapshot: "timeout-snapshot",
      memoryFlush: "timeout-flush",
    }),
  });

  assert.equal(final.kind, "final");
  assert.match(final.response.text, /Continuation: this source check is resumable/);
  assert.deepEqual(events, [
    ["memory_flush", "timeout-flush"],
    ["overwrite", closeout],
    [
      "result",
      {
        text:
          "The delegated source timed out before enough evidence arrived.\n\n" +
          "Continuation: this source check is resumable; continue the same source check if the missing evidence is still worth waiting for.",
      },
    ],
    [
      "reduction",
      {
        reduction: "timeout-reduction",
        reductionSnapshot: "timeout-snapshot",
      },
    ],
  ]);

  const rearmEvents = recordingTarget();
  const reArm = {
    reArm: {
      messages: [...messages, { role: "user" as const, content: "Gather more." }],
      forceToolChoice: { name: "sessions_spawn" },
    },
  };

  const completed = await controller.completeTerminalCloseout<
    string,
    string,
    string
  >({
    reason: "completed_sub_agent_final",
    closeout: {
      ...closeout,
      reason: "completed_sub_agent_final",
    },
    messages,
    lastText: "unused",
    target: rearmEvents.target,
    synthesize: async () => ({
      result: result("initial completed synthesis"),
      memoryFlush: "initial-flush",
    }),
    completed: {
      synthesize: async ({ initialSynthesis }) => {
        assert.equal(initialSynthesis.memoryFlush, "initial-flush");
        return {
          kind: "rearm",
          reArm,
          memoryFlushes: ["initial-flush"],
          reduction: "completed-reduction",
          reductionSnapshot: "completed-snapshot",
        };
      },
    },
  });

  assert.deepEqual(completed, { kind: "rearm", reArm });
  assert.deepEqual(rearmEvents.events, [
    ["memory_flush", "initial-flush"],
    [
      "reduction",
      {
        reduction: "completed-reduction",
        reductionSnapshot: "completed-snapshot",
      },
    ],
  ]);
});

test("TerminalCloseoutController owns terminal closeout entrypoint from decision to completion", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [{ role: "user", content: "Investigate." }];
  const closeout: ToolLoopCloseoutMetadata = {
    reason: "completed_sub_agent_final",
    maxRounds: 4,
    toolCallCount: 2,
    roundCount: 3,
    evidenceAvailable: true,
  };
  const reArm = {
    reArm: {
      messages: [...messages, { role: "user" as const, content: "Gather more." }],
      forceToolChoice: { name: "sessions_spawn" },
    },
  };
  const { events, target } = recordingTarget();
  const initialRequests: unknown[] = [];

  const completed = await controller.handleTerminalCloseout<
    string,
    string,
    string
  >({
    reason: "completed_sub_agent_final",
    decision: {
      closeout,
      reasonLines: ["completed evidence"],
      sticky: true,
    },
    messages,
    lastText: "unused",
    target,
    synthesize: async (request) => {
      initialRequests.push(request);
      return {
        result: result("initial completed synthesis"),
        memoryFlush: "initial-flush",
      };
    },
    completed: {
      synthesize: async ({ initialSynthesis }) => {
        assert.equal(initialSynthesis.memoryFlush, "initial-flush");
        return {
          kind: "rearm",
          reArm,
          memoryFlushes: ["initial-flush"],
          reduction: "completed-reduction",
          reductionSnapshot: "completed-snapshot",
        };
      },
    },
  });

  assert.deepEqual(completed, { kind: "rearm", reArm });
  assert.deepEqual(initialRequests, [
    {
      messages,
      reasonLines: ["completed evidence"],
    },
  ]);
  assert.deepEqual(events, [
    ["if_absent", closeout],
    ["memory_flush", "initial-flush"],
    [
      "reduction",
      {
        reduction: "completed-reduction",
        reductionSnapshot: "completed-snapshot",
      },
    ],
  ]);
});

test("TerminalCloseoutController owns completed closeout synthesis callback construction", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [{ role: "user", content: "Investigate." }];
  const repairMarkers: LLMMessage[] = [];
  const closeout: ToolLoopCloseoutMetadata = {
    reason: "completed_sub_agent_final",
    maxRounds: 4,
    toolCallCount: 2,
    roundCount: 3,
    evidenceAvailable: true,
  };
  const completedSession = {
    finalContents: ["Delegated final evidence."],
    browserRecoverySummaries: ["Browser recovery metadata: warm resume."],
  };
  const completedToolResults = [
    {
      toolCallId: "call-completed",
      toolName: "sessions_spawn",
      content: "raw completed tool result",
    },
  ];
  const { events, target } = recordingTarget();
  const calls: string[] = [];

  const completion = await controller.handleTerminalCloseoutHook<
    string,
    string,
    string
  >({
    reason: "completed_sub_agent_final",
    decision: {
      closeout,
      reasonLines: ["completed evidence"],
      sticky: true,
    },
    messages,
    lastText: "unused",
    target,
    synthesize: async () => ({
      result: result("initial completed synthesis"),
      memoryFlush: "initial-flush",
    }),
    completedCloseout: {
      completedCloseout: {
        synthesizeTerminalCloseout: async (input) => {
          calls.push("completed");
          assert.equal(input.messages, messages);
          assert.equal(input.repairMarkers, repairMarkers);
          assert.equal(input.completedSession, completedSession);
          assert.equal(
            input.completedSessionToolResultText,
            "ledger completed result text",
          );
          assert.equal(
            input.initialSynthesis.result.text,
            "initial completed synthesis",
          );
          const repair = await input.synthesizeRepair({ messages });
          assert.equal(repair.result.text, "repair synthesis");
          const cleanup = await input.synthesizeToolCallArtifactCleanup({
            messages,
          });
          assert.equal(cleanup.result.text, "cleanup synthesis");
          return {
            kind: "final" as const,
            result: result("completed final"),
            memoryFlushes: ["initial-flush", "repair-flush"],
            reduction: "completed-reduction",
            reductionSnapshot: "completed-snapshot",
          };
        },
      },
      completedSession,
      completedSessionToolResults: completedToolResults,
      evidence: {
        toolResultContentText: (results: typeof completedToolResults) => {
          calls.push("evidence");
          assert.equal(results, completedToolResults);
          return "ledger completed result text";
        },
      },
      packet: packet("Summarize completed evidence."),
      baseGatewayInput: baseGatewayInput(),
      repairMarkers,
      toolTrace: [],
      synthesizeRepair: async ({ gatewayInput }) => {
        assert.equal(gatewayInput.tools, undefined);
        assert.equal(gatewayInput.toolChoice, "none");
        assert.equal(gatewayInput.envelope?.toolCount, 0);
        calls.push("repair");
        return { result: result("repair synthesis") };
      },
      synthesizeToolCallArtifactCleanup: async () => {
        calls.push("cleanup");
        return { result: result("cleanup synthesis") };
      },
    },
  });

  assert.equal(completion.kind, "final");
  assert.deepEqual(calls, ["evidence", "completed", "repair", "cleanup"]);
  assert.deepEqual(events, [
    ["if_absent", closeout],
    ["memory_flush", "initial-flush"],
    ["memory_flush", "repair-flush"],
    ["if_absent", closeout],
    ["result", result("completed final")],
    [
      "reduction",
      {
        reduction: "completed-reduction",
        reductionSnapshot: "completed-snapshot",
      },
    ],
  ]);
});

test("TerminalCloseoutController owns completed closeout reason and session guards", async () => {
  const controller = createTerminalCloseoutController();
  const messages: LLMMessage[] = [{ role: "user", content: "Finish." }];
  const repairMarkers: LLMMessage[] = [];
  const completedSession = {
    finalContents: ["Delegated final evidence."],
    browserRecoverySummaries: [],
  };
  const guardedCompletedCloseout = {
    completedCloseout: {
      synthesizeTerminalCloseout: async () => {
        throw new Error("completed closeout should not run");
      },
    },
    baseGatewayInput: baseGatewayInput(),
    evidence: {
      toolResultContentText: () => {
        throw new Error("completed evidence should not be read");
      },
    },
    packet: packet("Finish."),
    repairMarkers,
    toolTrace: [],
    synthesizeRepair: async () => {
      throw new Error("completed repair should not run");
    },
    synthesizeToolCallArtifactCleanup: async () => {
      throw new Error("completed cleanup should not run");
    },
  };

  const roundLimitCloseout: ToolLoopCloseoutMetadata = {
    reason: "round_limit",
    maxRounds: 2,
    toolCallCount: 1,
    roundCount: 2,
    evidenceAvailable: true,
  };
  const roundLimit = await controller.handleTerminalCloseoutHook({
    reason: "round_limit",
    decision: {
      closeout: roundLimitCloseout,
      reasonLines: ["limit"],
    },
    messages,
    lastText: "unused",
    target: recordingTarget().target,
    synthesize: async () => ({ result: result("round limit final") }),
    completedCloseout: {
      ...guardedCompletedCloseout,
      completedSession,
    },
  });

  assert.deepEqual(roundLimit, {
    kind: "final",
    response: { text: "round limit final" },
  });

  const completedCloseout: ToolLoopCloseoutMetadata = {
    reason: "completed_sub_agent_final",
    maxRounds: 2,
    toolCallCount: 1,
    roundCount: 1,
    evidenceAvailable: true,
  };
  const { events, target } = recordingTarget();
  const completedWithoutSession = await controller.handleTerminalCloseoutHook({
    reason: "completed_sub_agent_final",
    decision: {
      closeout: completedCloseout,
      reasonLines: ["completed"],
    },
    messages,
    lastText: "unused",
    target,
    synthesize: async () => ({ result: result("completed fallback final") }),
    completedCloseout: {
      ...guardedCompletedCloseout,
      completedSession: null,
    },
  });

  assert.deepEqual(completedWithoutSession, {
    kind: "final",
    response: { text: "completed fallback final" },
  });
  assert.deepEqual(events, [
    ["if_absent", completedCloseout],
    ["result", result("completed fallback final")],
  ]);
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

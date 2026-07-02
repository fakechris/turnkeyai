import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextResult,
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import { createCompletedCloseoutController } from "./completed-closeout-controller";
import { createRepairPolicyRegistry } from "./repair-policy-registry";

function textResult(
  text: string,
  toolCalls?: LLMToolCall[],
): GenerateTextResult {
  return {
    text,
    ...(toolCalls ? { toolCalls } : {}),
    modelId: "test-model",
    providerId: "test-provider",
    protocol: "anthropic-compatible",
    adapterName: "test-adapter",
    raw: null,
  };
}

function messageText(message: LLMMessage | undefined): string {
  assert.ok(message);
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => JSON.stringify(block)).join("\n");
}

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

function sessionTrace(input: {
  toolName?: "sessions_spawn" | "sessions_send";
  status?: "completed" | "timeout";
  result: string;
}): NativeToolRoundTrace[] {
  const toolName = input.toolName ?? "sessions_send";
  const content = JSON.stringify({
    task_id: "task-1",
    session_key: "worker:browser:task-1",
    agent_id: "browser",
    status: input.status ?? "completed",
    result: input.result,
  });
  return [
    {
      round: 1,
      calls: [{ id: "toolu-session", name: toolName, input: {} }],
      results: [
        {
          toolCallId: "toolu-session",
          toolName,
          content,
          isError: false,
          contentBytes: content.length,
        },
      ],
    },
  ];
}

test("CompletedCloseoutController repairs completed-only synthesis and cleans up tool-call artifacts", async () => {
  const controller = createCompletedCloseoutController();
  const repairMessagesSeen: LLMMessage[][] = [];
  const cleanupMessagesSeen: LLMMessage[][] = [];
  const repairMarkers: LLMMessage[] = [];

  const result = await controller.runRepairLoop({
    taskPrompt:
      "Review the delegated session's pricing finding and tell me the next action the operator should take.",
    toolTrace: [],
    repairMessages: [],
    repairMarkers,
    completedSessionFinalContents: [
      "The delegated session verified the plan is $10 per month.",
    ],
    completedEvidenceText:
      "The delegated session verified the plan is $10 per month.",
    completedSessionEvidenceText:
      "The delegated session verified the plan is $10 per month.",
    initialResult: textResult("The plan is verified at $10 per month."),
    repairPolicy: createRepairPolicyRegistry(),
    synthesizeRepair: async ({ messages }) => {
      repairMessagesSeen.push(messages);
      return {
        result: textResult("Calling a tool.", [
          { id: "toolu-artifact", name: "sessions_spawn", input: {} },
        ]),
        memoryFlush: "repair-flush",
      };
    },
    synthesizeToolCallArtifactCleanup: async ({ messages }) => {
      cleanupMessagesSeen.push(messages);
      return {
        result: textResult(
          "The plan is verified at $10 per month. Next action: monitor the pricing page for changes.",
        ),
        memoryFlush: "cleanup-flush",
      };
    },
  });

  assert.equal(result.kind, "final");
  assert.match(result.result.text, /Next action/i);
  assert.deepEqual(result.memoryFlushes, ["repair-flush", "cleanup-flush"]);
  assert.equal(repairMarkers.length, 1);
  assert.match(messageText(repairMarkers[0]), /requested next action is missing/i);
  assert.equal(repairMessagesSeen.length, 1);
  assert.match(
    messageText(repairMessagesSeen[0]?.at(-1)),
    /requested next action is missing/i,
  );
  assert.equal(cleanupMessagesSeen.length, 1);
  assert.equal(messageText(cleanupMessagesSeen[0]?.at(-1)), "Calling a tool.");
});

test("CompletedCloseoutController re-arms through registry before round>0 table repairs and returns pending reduction", async () => {
  const controller = createCompletedCloseoutController();
  const repairMarkers: LLMMessage[] = [];
  let repairCalls = 0;

  const result = await controller.runRepairLoop({
    taskPrompt:
      "Return table: provider, evidence URL. Inspect the browser-visible rendered page and also tell me the next action the operator should take.",
    toolTrace: [],
    tools: [{ name: "sessions_spawn" }],
    repairMessages: [],
    repairMarkers,
    completedSessionFinalContents: [
      "Provider A pricing was verified from https://a.example.",
    ],
    completedEvidenceText:
      "Provider A pricing was verified from https://a.example.",
    completedSessionEvidenceText:
      "Provider A pricing was verified from https://a.example.",
    initialResult: textResult(
      ["| provider | evidence URL |", "| --- | --- |", "| A | https://a.example |"].join(
        "\n",
      ),
    ),
    repairPolicy: createRepairPolicyRegistry(),
    synthesizeRepair: async () => {
      repairCalls += 1;
      return {
        result: textResult(
          [
            "I could not verify the rendered page because browser session tools are unavailable.",
            "",
            "| provider |",
            "| --- |",
            "| A |",
          ].join("\n"),
        ),
        reduction: { level: "compact" },
        reductionSnapshot: { level: "compact", artifactIds: ["a1"] },
        memoryFlush: "repair-flush",
      };
    },
    synthesizeToolCallArtifactCleanup: async () => {
      throw new Error("cleanup should not run when the controller re-arms");
    },
  });

  assert.equal(result.kind, "rearm");
  assert.equal(repairCalls, 1);
  assert.deepEqual(result.memoryFlushes, ["repair-flush"]);
  assert.deepEqual(result.reduction, { level: "compact" });
  assert.deepEqual(result.reArm.reArm.forceToolChoice, { name: "sessions_spawn" });
  assert.match(
    messageText(result.reArm.reArm.messages.at(-1)),
    /browser-visible evidence is missing/i,
  );
  assert.equal(repairMarkers.length, 2);
});

test("CompletedCloseoutController terminal synthesis records initial flush and finalized repair", async () => {
  const controller = createCompletedCloseoutController();
  const repairMarkers: LLMMessage[] = [];
  const repairMessagesSeen: LLMMessage[][] = [];
  let cleanupCalls = 0;

  const result = await controller.synthesizeTerminalCloseout({
    packet: packet(
      "Review the delegated pricing finding and tell me the next action the operator should take.",
    ),
    toolTrace: [],
    messages: [],
    repairMarkers,
    completedSession: {
      finalContents: ["The delegated session verified the plan is $10 per month."],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: "",
    initialSynthesis: {
      result: textResult("The plan is verified at $10 per month."),
      reduction: { level: "initial" },
      reductionSnapshot: { level: "initial", artifactIds: ["r1"] },
      memoryFlush: "initial-flush",
    },
    repairPolicy: createRepairPolicyRegistry(),
    synthesizeRepair: async ({ messages }) => {
      repairMessagesSeen.push(messages);
      return {
        result: textResult(
          "The plan is verified at $10 per month. Next action: monitor the pricing page for changes.",
        ),
        memoryFlush: "repair-flush",
      };
    },
    synthesizeToolCallArtifactCleanup: async () => {
      cleanupCalls += 1;
      return { result: textResult("cleanup should not run") };
    },
  });

  assert.equal(result.kind, "final");
  assert.match(result.result.text, /Next action/i);
  assert.deepEqual(result.memoryFlushes, ["initial-flush", "repair-flush"]);
  assert.deepEqual(result.reduction, { level: "initial" });
  assert.deepEqual(result.reductionSnapshot, {
    level: "initial",
    artifactIds: ["r1"],
  });
  assert.equal(cleanupCalls, 0);
  assert.equal(repairMessagesSeen.length, 1);
  assert.equal(repairMarkers.length, 1);
  assert.match(
    messageText(repairMessagesSeen[0]?.at(-1)),
    /requested next action is missing/i,
  );
});

test("CompletedCloseoutController finalizes completed browser visibility in order", () => {
  const controller = createCompletedCloseoutController();

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      "Continue the previous browser session after it timed out and recover the dashboard.",
    ),
    result: textResult("The dashboard shows the expected marker."),
    messages: [],
    toolTrace: [],
    completedSession: {
      finalContents: ["The dashboard reopened with the expected marker."],
      browserRecoverySummaries: [
        "Browser recovery metadata: Resume mode: warm.",
      ],
    },
    completedSessionToolResultText: "cdp_command_timeout",
  });

  assert.match(result.text, /Browser continuity: browser context was recovered/i);
  assert.match(result.text, /Browser limitation: cdp_command_timeout/i);
  assert.ok(
    result.text.indexOf("Browser continuity:") <
      result.text.indexOf("Browser limitation:"),
  );
});

test("CompletedCloseoutController appends timeout closeout before final URL redaction", () => {
  const controller = createCompletedCloseoutController();

  const result = controller.finalizeCompletedVisibility({
    packet: packet(
      "Continue the same source check and say whether the earlier timeout still limits the conclusion.",
      "Do not include URLs.",
    ),
    result: textResult("Verified http://127.0.0.1:4173/status is healthy."),
    messages: [],
    toolTrace: sessionTrace({
      status: "timeout",
      result: "The previous source check timed out.",
    }),
    completedSession: {
      finalContents: [
        "Recovered after the earlier timeout with source-backed evidence.",
      ],
      browserRecoverySummaries: [],
    },
    completedSessionToolResultText: "",
  });

  assert.match(result.text, /Timeout closeout:/i);
  assert.doesNotMatch(result.text, /127\.0\.0\.1|localhost/);
  assert.match(result.text, /local fixture source/);
});

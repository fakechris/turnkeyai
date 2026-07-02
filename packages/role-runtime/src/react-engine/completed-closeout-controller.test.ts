import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextResult,
  LLMMessage,
  LLMToolCall,
} from "@turnkeyai/llm-adapter/index";

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
    findReArmRepair: () => null,
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

test("CompletedCloseoutController re-arms before round>0 table repairs and returns pending reduction", async () => {
  const controller = createCompletedCloseoutController();
  const repairMarkers: LLMMessage[] = [];
  let repairCalls = 0;

  const result = await controller.runRepairLoop({
    taskPrompt:
      "Return table: provider, evidence URL. Also tell me the next action the operator should take.",
    toolTrace: [],
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
    findReArmRepair: ({ repairRound, resultText }) =>
      repairRound === 1 && /\| provider \|/.test(resultText)
        ? {
            repairPrompt:
              "Runtime correction: final answer omitted required browser evidence.",
            forceToolChoice: { name: "sessions_spawn" },
          }
        : null,
    synthesizeRepair: async () => {
      repairCalls += 1;
      return {
        result: textResult(["| provider |", "| --- |", "| A |"].join("\n")),
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
    /omitted required browser evidence/i,
  );
  assert.equal(repairMarkers.length, 2);
});

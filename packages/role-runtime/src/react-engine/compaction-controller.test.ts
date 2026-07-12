import assert from "node:assert/strict";
import test from "node:test";

import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import {
  createCompactionController,
  readRuntimeCheckpoint,
  type RuntimeCheckpointDraft,
} from "./compaction-controller";

function assistantToolUse(id: string): LLMMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "web_fetch",
        input: { url: `https://example.com/${id}` },
      },
    ],
  };
}

function toolResult(id: string, content = `${id} evidence`): LLMMessage {
  return {
    role: "tool",
    toolCallId: id,
    name: "web_fetch",
    content,
  };
}

function buildHistory(rounds: number): LLMMessage[] {
  return [
    { role: "system", content: "stable system" },
    { role: "user", content: "stable task" },
    ...Array.from({ length: rounds }, (_, index) => {
      const id = `call-${index + 1}`;
      return [assistantToolUse(id), toolResult(id)];
    }).flat(),
  ];
}

const summaryDraft: RuntimeCheckpointDraft = {
  summary: "Compared the early sources and retained their conclusions.",
  decisions: ["Use primary-source pricing."],
  evidence: ["Source A reported an annual price."],
  artifacts: ["artifact://pricing-a"],
  openQuestions: ["Confirm regional tax treatment."],
  planState: ["Compare the remaining source."],
};

test("CompactionController leaves history unchanged below the calibrated 70 percent threshold", async () => {
  const messages = buildHistory(6);
  let summaryCalls = 0;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 690,
      estimatedInputTokens: 690,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.69,
    }),
    summarize: async () => {
      summaryCalls += 1;
      return summaryDraft;
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 6);

  assert.equal(result.messages, messages);
  assert.equal(summaryCalls, 0);
});

test("CompactionController opens a failure circuit and permits bounded recovery", async () => {
  const messages = buildHistory(7);
  let utilization = 0.9;
  let summaryCalls = 0;
  const lifecycle: Array<{
    kind: string;
    consecutiveFailures: number;
    reason?: string;
  }> = [];
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 900,
      estimatedInputTokens: 900,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization,
    }),
    summarize: async () => {
      summaryCalls += 1;
      throw new Error("summarizer unavailable");
    },
    onCompactionLifecycle: (event) => lifecycle.push(event),
  });

  await controller.applyRoundMessagesHook(messages, 1);
  await controller.applyRoundMessagesHook(messages, 2);
  await controller.applyRoundMessagesHook(messages, 3);
  const skipped = await controller.applyRoundMessagesHook(messages, 4);

  assert.equal(summaryCalls, 3);
  assert.equal(lifecycle.at(-1)?.kind, "skipped");
  assert.equal(lifecycle.at(-1)?.reason, "failure_circuit_open");
  assert.notDeepEqual(skipped.messages, messages, "open circuit must retain deterministic microcompaction");

  await controller.forceRoundMessages(messages, 5);
  assert.equal(summaryCalls, 4, "forced recovery gets exactly one summarizer attempt");

  utilization = 0.4;
  await controller.applyRoundMessagesHook(messages, 6);
  utilization = 0.9;
  await controller.applyRoundMessagesHook(messages, 7);
  assert.equal(summaryCalls, 5, "low utilization resets the failure circuit");
  assert.deepEqual(
    lifecycle.filter((event) => event.kind === "failed").map((event) => event.consecutiveFailures),
    [1, 2, 3, 4, 1],
  );
});

test("CompactionController microcompacts old plain tool bodies before summarization", async () => {
  const messages = buildHistory(7).map((message, index) =>
    message.role === "tool"
      ? { ...message, content: `EARLY_${index} ${"x".repeat(2_000)}` }
      : message,
  );
  let summarized: LLMMessage[] = [];
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 900,
      estimatedInputTokens: 900,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.9,
    }),
    summarize: async (input) => {
      summarized = input.messages;
      return summaryDraft;
    },
  });

  await controller.applyRoundMessagesHook(messages, 7);

  assert.equal(
    summarized.some(
      (message) =>
        message.role === "tool" &&
        typeof message.content === "string" &&
        message.content.includes("turnkeyai.microcompacted_tool_result.v1"),
    ),
    true,
  );
});

test("CompactionController replaces old complete protocol units with a typed checkpoint and keeps four recent units raw", async () => {
  const messages = buildHistory(7);
  let summarizedMessages: LLMMessage[] = [];
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 720,
      estimatedInputTokens: 720,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.72,
    }),
    summarize: async (input) => {
      summarizedMessages = input.messages;
      assert.equal(input.previousCheckpoint, undefined);
      return summaryDraft;
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);
  const checkpoint = readRuntimeCheckpoint(result.messages[2]);

  assert.deepEqual(result.messages.slice(0, 2), messages.slice(0, 2));
  assert.equal(summarizedMessages.length, 6);
  assert.equal(result.messages.length, 11);
  assert.ok(checkpoint);
  assert.equal(checkpoint.protocol, "turnkeyai.runtime_checkpoint.v1");
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.compactedAtRound, 7);
  assert.equal(checkpoint.sourceMessageCount, 6);
  assert.deepEqual(checkpoint.evidence, summaryDraft.evidence);
  assert.deepEqual(result.messages.slice(3), messages.slice(-8));
});

test("CompactionController passes the previous typed checkpoint into the next compaction", async () => {
  const firstMessages = buildHistory(7);
  const drafts: RuntimeCheckpointDraft[] = [
    summaryDraft,
    {
      ...summaryDraft,
      summary: "Merged the prior checkpoint with newer evidence.",
      evidence: [...summaryDraft.evidence, "Source B confirmed the monthly price."],
    },
  ];
  let call = 0;
  let observedPreviousVersion: number | undefined;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 800,
      estimatedInputTokens: 800,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.8,
    }),
    summarize: async (input) => {
      observedPreviousVersion = input.previousCheckpoint?.version;
      return drafts[call++]!;
    },
  });
  const first = await controller.applyRoundMessagesHook(firstMessages, 7);
  const extended = [
    ...first.messages,
    assistantToolUse("call-8"),
    toolResult("call-8"),
    assistantToolUse("call-9"),
    toolResult("call-9"),
  ];

  const second = await controller.applyRoundMessagesHook(extended, 9);
  const checkpoint = readRuntimeCheckpoint(second.messages[2]);

  assert.equal(observedPreviousVersion, 1);
  assert.equal(checkpoint?.version, 2);
  assert.equal(checkpoint?.summary, drafts[1]!.summary);
  assert.deepEqual(second.messages.slice(-8), extended.slice(-8));
});

test("CompactionController forces the typed task snapshot into checkpoint plan state", async () => {
  const messages = buildHistory(7);
  const authoritativePlan = [
    JSON.stringify({ id: "wi.1", status: "working", title: "Verify source" }),
  ];
  let summaryPlanState: string[] | undefined;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 800,
      estimatedInputTokens: 800,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.8,
    }),
    readPlanState: () => authoritativePlan,
    summarize: async (input) => {
      summaryPlanState = input.planStateSnapshot;
      return {
        ...summaryDraft,
        planState: ["model guessed stale plan"],
      };
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);
  const checkpoint = readRuntimeCheckpoint(result.messages[2]);

  assert.deepEqual(summaryPlanState, authoritativePlan);
  assert.deepEqual(checkpoint?.planState, authoritativePlan);
});

test("CompactionController falls back to deterministic microcompaction when checkpoint synthesis fails", async () => {
  const messages = buildHistory(7);
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 800,
      estimatedInputTokens: 800,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.8,
    }),
    summarize: async () => {
      throw new Error("summary provider unavailable");
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);

  assert.notEqual(result.messages, messages);
  assert.equal(
    result.messages.some(
      (message) =>
        message.role === "tool" &&
        typeof message.content === "string" &&
        message.content.includes("turnkeyai.microcompacted_tool_result.v1"),
    ),
    true,
  );
});

test("CompactionController refuses to compact an incomplete assistant tool-use unit", async () => {
  const messages = [...buildHistory(6), assistantToolUse("missing-result")];
  let summaryCalls = 0;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 800,
      estimatedInputTokens: 800,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.8,
    }),
    summarize: async () => {
      summaryCalls += 1;
      return summaryDraft;
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);

  assert.equal(result.messages, messages);
  assert.equal(summaryCalls, 0);
});

test("CompactionController can force a protocol-safe checkpoint below the proactive threshold", async () => {
  const messages = buildHistory(7);
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 200,
      estimatedInputTokens: 200,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.2,
    }),
    summarize: async () => summaryDraft,
  });

  const result = await controller.forceRoundMessages(messages, 7);

  assert.notEqual(result.messages, messages);
  assert.equal(readRuntimeCheckpoint(result.messages[2])?.version, 1);
  assert.deepEqual(result.messages.slice(-8), messages.slice(-8));
});

test("CompactionController emits a typed compaction event only after a checkpoint lands", async () => {
  const messages = buildHistory(7);
  const events: Array<{
    round: number;
    forced: boolean;
    messageCountBefore: number;
    messageCountAfter: number;
    sourceMessageCount: number;
  }> = [];
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 800,
      estimatedInputTokens: 800,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.8,
    }),
    summarize: async () => summaryDraft,
    onCompaction: (event) => events.push(event),
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);

  assert.deepEqual(events, [
    {
      round: 7,
      forced: false,
      messageCountBefore: messages.length,
      messageCountAfter: result.messages.length,
      sourceMessageCount: 6,
    },
  ]);
});

test("CompactionController adopts a forced checkpoint into state on the next round and keeps the new protocol unit", async () => {
  const messages = buildHistory(7);
  let summaryCalls = 0;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 200,
      estimatedInputTokens: 200,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.2,
    }),
    summarize: async () => {
      summaryCalls += 1;
      return summaryDraft;
    },
  });
  const forced = await controller.forceRoundMessages(messages, 7);
  const nextState = [
    ...messages,
    assistantToolUse("call-8"),
    toolResult("call-8", "new evidence"),
  ];

  const adopted = await controller.applyRoundMessagesHook(nextState, 8);

  assert.equal(summaryCalls, 1);
  assert.deepEqual(adopted.messages.slice(0, forced.messages.length), forced.messages);
  assert.deepEqual(adopted.messages.slice(-2), nextState.slice(-2));
  assert.equal(readRuntimeCheckpoint(adopted.messages[2])?.version, 1);
});

test("CompactionController discards a pending forced checkpoint when its source prefix changed", async () => {
  const messages = buildHistory(7);
  let summaryCalls = 0;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 200,
      estimatedInputTokens: 200,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.2,
    }),
    summarize: async () => {
      summaryCalls += 1;
      return summaryDraft;
    },
  });
  await controller.forceRoundMessages(messages, 7);
  const changed = messages.map((message, index) =>
    index === 1 ? { ...message, content: "changed task" } : message,
  );

  const result = await controller.applyRoundMessagesHook(changed, 8);

  assert.equal(summaryCalls, 1);
  assert.equal(result.messages, changed);
  assert.equal(readRuntimeCheckpoint(result.messages[2]), undefined);
});

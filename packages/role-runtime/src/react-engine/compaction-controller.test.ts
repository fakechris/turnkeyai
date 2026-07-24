import assert from "node:assert/strict";
import test from "node:test";

import {
  type ContextCheckpointRecord,
  type ContextCheckpointScope,
  type ContextCheckpointStore,
} from "@turnkeyai/core-types/context-checkpoint";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import {
  buildRuntimeCheckpointMessage,
  createCompactionController,
  readRuntimeCheckpoint,
  RUNTIME_CHECKPOINT_PROTOCOL,
  type RuntimeCheckpoint,
  type RuntimeCheckpointDraft,
} from "./compaction-controller";
import type { ContextSourceGuardSnapshot } from "./context-source-guard";

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

test("CompactionController bounds the summarizer source while preserving the raw checkpoint count", async () => {
  const messages = buildHistory(20).map((message) =>
    message.role === "tool"
      ? { ...message, content: `${message.toolCallId}:${"x".repeat(1_000)}` }
      : message,
  );
  let summarized: LLMMessage[] = [];
  let sourceGuardCompacted = false;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 900,
      estimatedInputTokens: 900,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.9,
    }),
    sourceGuard: {
      maxSourceMessages: 5,
      maxSourceBytes: 2_500,
      recentProtocolUnits: 2,
      maxSampleChars: 60,
    },
    summarize: async (input) => {
      summarized = input.messages;
      return summaryDraft;
    },
    onCompaction: (event) => {
      sourceGuardCompacted = event.sourceGuard.compacted;
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 20);
  const checkpoint = readRuntimeCheckpoint(result.messages[2]);

  assert.equal(summarized.length <= 5, true);
  assert.equal(
    Buffer.byteLength(JSON.stringify(summarized), "utf8") <= 2_500,
    true,
  );
  assert.match(String(summarized[0]?.content), /context_source_digest/);
  assert.equal(sourceGuardCompacted, true);
  assert.equal(
    checkpoint?.sourceMessageCount,
    messages.length - 2 - 8,
    "checkpoint source count describes the raw compacted history, not the bounded summarizer projection",
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
  assert.equal(checkpoint.protocol, "turnkeyai.context_checkpoint.v2");
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.compactedAtRound, 7);
  assert.equal(checkpoint.sourceMessageCount, 6);
  assert.deepEqual(checkpoint.evidence, summaryDraft.evidence);
  assert.deepEqual(result.messages.slice(3), messages.slice(-8));
});

test("CompactionController awaits the authoritative task graph snapshot", async () => {
  const messages = buildHistory(7);
  const authoritativePlan = [
    JSON.stringify({
      id: "wi.2",
      status: "planning",
      specification: {
        objective: "Write the report",
        blocked_by: ["wi.1"],
      },
    }),
  ];
  let summarizedPlan: string[] | undefined;
  const controller = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 800,
      estimatedInputTokens: 800,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.8,
    }),
    readPlanState: async () => authoritativePlan,
    summarize: async (input) => {
      summarizedPlan = input.planStateSnapshot;
      return summaryDraft;
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);
  assert.deepEqual(summarizedPlan, authoritativePlan);
  assert.deepEqual(
    readRuntimeCheckpoint(result.messages[2])?.planState,
    authoritativePlan,
  );
});

test("CompactionController fails closed when authoritative task state cannot be read", async () => {
  const messages = buildHistory(7);
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
    readPlanState: async () => {
      throw new Error("authoritative graph unavailable");
    },
    summarize: async () => {
      summaryCalls += 1;
      return summaryDraft;
    },
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);
  assert.equal(result.messages.length, messages.length);
  assert.equal(
    result.messages.some((message) => readRuntimeCheckpoint(message)),
    false,
    "a failed authoritative read must not produce a checkpoint",
  );
  assert.equal(summaryCalls, 0);
});

test("CompactionController persists checkpoint phases and activates only after the caller commits messages", async () => {
  const messages = buildHistory(7);
  const store = createMemoryCheckpointStore();
  const scope: ContextCheckpointScope = {
    threadId: "thread-1",
    roleId: "role-1",
    flowId: "flow-1",
  };
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
    checkpointStore: store,
    checkpointScope: scope,
    captureWorkingSet: () => ({
      files: [],
      skills: [],
      artifacts: ["artifact://pricing-a"],
      sessions: [
        {
          sessionKey: "worker:source-a",
          status: "timeout",
          resumable: true,
        },
      ],
      approvals: [{ approvalId: "approval-1", state: "pending" }],
      images: [],
    }),
    now: (() => {
      let value = 100;
      return () => ++value;
    })(),
  });

  const result = await controller.applyRoundMessagesHook(messages, 7);
  assert.ok(result.pendingCheckpointId);
  const persisted = await store.get(result.pendingCheckpointId);
  assert.equal(persisted?.state, "persisted");
  assert.equal(await store.getActive(scope), null);
  assert.deepEqual(
    readRuntimeCheckpoint(result.messages[2])?.workingSet?.sessions,
    [
      {
        sessionKey: "worker:source-a",
        status: "timeout",
        resumable: true,
      },
    ],
  );

  await controller.activateCheckpoint(result.pendingCheckpointId);
  assert.equal(
    (await store.getActive(scope))?.checkpointId,
    result.pendingCheckpointId,
  );
  assert.deepEqual(store.transitions, [
    "prepared",
    "summarized",
    "persisted",
    "activated",
  ]);
});

test("CompactionController reconciles a journaled persisted v2 checkpoint after restart", async () => {
  const messages = buildHistory(7);
  const store = createMemoryCheckpointStore();
  const scope: ContextCheckpointScope = {
    threadId: "thread-1",
    roleId: "role-1",
    flowId: "flow-1",
  };
  const first = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 800,
      estimatedInputTokens: 800,
      source: "provider_calibrated",
      inputTokenLimit: 1_000,
      utilization: 0.8,
    }),
    summarize: async () => summaryDraft,
    checkpointStore: store,
    checkpointScope: scope,
    now: () => 100,
  });
  const compacted = await first.applyRoundMessagesHook(messages, 7);
  assert.equal(await store.getActive(scope), null);

  const restarted = createCompactionController({
    taskPrompt: "Compare the sources.",
    estimateTokenBudget: () => ({
      rawInputTokens: 100,
      estimatedInputTokens: 100,
      source: "heuristic",
      inputTokenLimit: 1_000,
      utilization: 0.1,
    }),
    summarize: async () => summaryDraft,
    checkpointStore: store,
    checkpointScope: scope,
    now: () => 200,
  });
  await restarted.reconcileFromMessages(compacted.messages);

  assert.equal(
    (await store.getActive(scope))?.checkpointId,
    compacted.pendingCheckpointId,
  );
});

test("CompactionController rejects activation when the persisted source digest was mutated", async () => {
  const messages = buildHistory(7);
  const store = createMemoryCheckpointStore();
  const scope: ContextCheckpointScope = {
    threadId: "thread-1",
    roleId: "role-1",
    flowId: "flow-1",
  };
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
    checkpointStore: store,
    checkpointScope: scope,
    now: () => 100,
  });
  const compacted = await controller.applyRoundMessagesHook(messages, 7);
  const checkpointId = compacted.pendingCheckpointId!;
  const record = await store.get(checkpointId);
  assert.ok(record);
  await store.put({
    ...record,
    source: {
      ...record.source,
      transcriptDigest: "mutated",
    },
  });

  await assert.rejects(
    controller.activateCheckpoint(checkpointId),
    /source identity mismatch/,
  );
  assert.equal(await store.getActive(scope), null);
});

test("CompactionController rejects restart adoption when the journaled projection was mutated", async () => {
  const messages = buildHistory(7);
  const store = createMemoryCheckpointStore();
  const scope: ContextCheckpointScope = {
    threadId: "thread-1",
    roleId: "role-1",
    flowId: "flow-1",
  };
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
    checkpointStore: store,
    checkpointScope: scope,
    now: () => 100,
  });
  const compacted = await controller.applyRoundMessagesHook(messages, 7);
  const mutated = compacted.messages.map((message) => {
    const checkpoint = readRuntimeCheckpoint(message);
    return checkpoint?.checkpointId === compacted.pendingCheckpointId
      ? {
          ...message,
          content: String(message.content).replace(
            checkpoint?.summary ?? "",
            "tampered projection",
          ),
        }
      : message;
  });

  await assert.rejects(
    controller.reconcileFromMessages(mutated),
    /projection mismatch/,
  );
  assert.equal(await store.getActive(scope), null);
});

test("readRuntimeCheckpoint remains backward-compatible with v1 messages", () => {
  const legacy: RuntimeCheckpoint = {
    protocol: RUNTIME_CHECKPOINT_PROTOCOL,
    version: 3,
    compactedAtRound: 9,
    sourceMessageCount: 20,
    task: "Legacy task",
    summary: "Legacy summary",
    decisions: [],
    evidence: [],
    artifacts: [],
    openQuestions: [],
    planState: [],
  };

  assert.deepEqual(
    readRuntimeCheckpoint(buildRuntimeCheckpointMessage(legacy)),
    legacy,
  );
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
    sourceGuard: ContextSourceGuardSnapshot;
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

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.deepEqual({
    round: event.round,
    forced: event.forced,
    messageCountBefore: event.messageCountBefore,
    messageCountAfter: event.messageCountAfter,
    sourceMessageCount: event.sourceMessageCount,
  }, {
    round: 7,
    forced: false,
    messageCountBefore: messages.length,
    messageCountAfter: result.messages.length,
    sourceMessageCount: 6,
  });
  assert.equal(event.sourceGuard.protocolSafe, true);
  assert.equal(event.sourceGuard.compacted, false);
  assert.equal(event.sourceGuard.sourceMessageCount, 6);
  assert.equal(event.sourceGuard.guardedMessageCount, 6);
  assert.equal(event.sourceGuard.guardedBytes, event.sourceGuard.sourceBytes);
  assert.equal(event.sourceGuard.guardedTokens, event.sourceGuard.sourceTokens);
  assert.equal(event.sourceGuard.retainedProtocolUnitCount, 3);
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

function createMemoryCheckpointStore(): ContextCheckpointStore & {
  transitions: string[];
} {
  const records = new Map<string, ContextCheckpointRecord>();
  const active = new Map<string, string>();
  const transitions: string[] = [];
  const scopeKey = (scope: ContextCheckpointScope) =>
    `${scope.threadId}:${scope.roleId}:${scope.flowId}`;
  return {
    transitions,
    async get(checkpointId) {
      return records.get(checkpointId) ?? null;
    },
    async put(record) {
      records.set(record.checkpointId, structuredClone(record));
      transitions.push(record.state);
    },
    async getActive(scope) {
      const checkpointId = active.get(scopeKey(scope));
      return checkpointId ? records.get(checkpointId) ?? null : null;
    },
    async activate(input) {
      const record = records.get(input.checkpointId);
      if (!record) throw new Error("missing checkpoint");
      const current = active.get(scopeKey(input.scope)) ?? null;
      if (
        input.expectedActiveCheckpointId !== undefined &&
        current !== input.expectedActiveCheckpointId
      ) {
        throw new Error("active pointer conflict");
      }
      const activated = {
        ...record,
        state: "activated" as const,
        updatedAt: input.activatedAt,
      };
      records.set(record.checkpointId, activated);
      active.set(scopeKey(input.scope), record.checkpointId);
      transitions.push("activated");
      return activated;
    },
    async listByScope(scope) {
      return [...records.values()].filter(
        (record) => scopeKey(record.scope) === scopeKey(scope),
      );
    },
  };
}

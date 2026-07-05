import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadMemoryRecord, ThreadMemoryStore } from "@turnkeyai/core-types/team";
import type { GenerateTextInput } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import {
  DefaultPreCompactionMemoryFlusher,
  flushPreCompactionMemorySafely,
  type PreCompactionMemoryFlusher,
} from "./pre-compaction-memory-flusher";
import type { RolePromptPacket } from "./prompt-policy";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

test("flushPreCompactionMemorySafely invokes configured flusher with selection and diagnostics", async () => {
  const calls: Array<Parameters<PreCompactionMemoryFlusher["flush"]>[0]> = [];
  const result = await flushPreCompactionMemorySafely({
    flusher: {
      async flush(input) {
        calls.push(input);
        return {
          status: "written",
          preferences: ["Prefer terse updates."],
          constraints: [],
          longTermNotes: [],
        };
      },
    },
    activation: buildActivation(),
    packet: buildPacket(),
    selection: {
      modelId: "model-1",
      modelChainId: "chain-1",
    },
    diagnostics: {
      messageCount: 1,
      promptChars: 2,
      promptBytes: 3,
      metadataBytes: 4,
      artifactCount: 5,
      toolCount: 6,
      toolSchemaBytes: 7,
      toolResultCount: 8,
      toolResultBytes: 9,
      inlineAttachmentBytes: 10,
      inlineImageCount: 11,
      inlineImageBytes: 12,
      inlinePdfCount: 13,
      inlinePdfBytes: 14,
      multimodalPartCount: 15,
      totalSerializedBytes: 16,
      overLimitKeys: ["promptBytes"],
    },
  });

  assert.deepEqual(result, {
    status: "written",
    preferences: ["Prefer terse updates."],
    constraints: [],
    longTermNotes: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.modelId, "model-1");
  assert.equal(calls[0]!.modelChainId, "chain-1");
  assert.equal(calls[0]!.reason, "request_envelope_overflow");
  assert.equal(calls[0]!.diagnostics?.promptBytes, 3);
});

test("flushPreCompactionMemorySafely swallows flusher failures", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const result = await flushPreCompactionMemorySafely({
      flusher: {
        async flush() {
          throw new Error("memory backend unavailable");
        },
      },
      activation: buildActivation(),
      packet: buildPacket(),
      selection: {},
    });

    assert.equal(result, undefined);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.[0], "pre-compaction memory flush failed");
  } finally {
    console.error = originalError;
  }
});

test("pre-compaction memory flusher asks the model and writes durable thread memory", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: [
        "```json",
        JSON.stringify({
          preferences: ["Prefer concise operator summaries."],
          constraints: ["Never auto-submit forms without approval."],
          longTermNotes: ["Decision: use direct provider APIs before browser fallback."],
        }),
        "```",
      ].join("\n"),
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const memoryStore = new InMemoryThreadMemoryStore({
    threadId: "thread-1",
    updatedAt: 1,
    preferences: ["Prefer concise operator summaries."],
    constraints: [],
    longTermNotes: [],
  });
  const flusher = new DefaultPreCompactionMemoryFlusher({
    gateway,
    threadMemoryStore: memoryStore,
    now: () => 42,
  });

  const result = await flusher.flush({
    activation: buildActivation(),
    packet: buildPacket(),
    modelId: "claude-test",
    reason: "request_envelope_overflow",
  });

  assert.equal(result.status, "written");
  assert.equal(gatewayInputs.length, 1);
  assert.equal(gatewayInputs[0]?.modelId, "claude-test");
  assert.equal(gatewayInputs[0]?.tools, undefined);
  assert.equal(gatewayInputs[0]?.metadata?.["purpose"], "pre_compaction_memory_flush");
  const stored = await memoryStore.get("thread-1");
  assert.deepEqual(stored, {
    threadId: "thread-1",
    updatedAt: 42,
    preferences: ["Prefer concise operator summaries."],
    constraints: ["Never auto-submit forms without approval."],
    longTermNotes: ["Decision: use direct provider APIs before browser fallback."],
  });
});

test("pre-compaction memory flusher keeps task facts ahead of long system prompt text", async () => {
  const gatewayInputs: GenerateTextInput[] = [];
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (input: GenerateTextInput) => {
    gatewayInputs.push(input);
    return {
      text: JSON.stringify({
        preferences: [],
        constraints: [],
        longTermNotes: ["Project Aurora-19 launches Friday 14:15 with Field Ops Lead as owner."],
      }),
      modelId: "claude-test",
      providerId: "anthropic",
      protocol: "anthropic-compatible",
      adapterName: "test",
      raw: {},
    };
  };
  const packet = buildPacket();
  packet.systemPrompt = "system filler ".repeat(1_000);
  packet.taskPrompt = [
    "Important durable facts near the top of the handoff:",
    "Project codename: Aurora-19.",
    "Launch window: Friday 14:15.",
    "Owner: Field Ops Lead.",
    "Residual risk: vendor dry-run remains unverified.",
    "background ".repeat(1_000),
  ].join("\n");
  const flusher = new DefaultPreCompactionMemoryFlusher({
    gateway,
    threadMemoryStore: new InMemoryThreadMemoryStore(),
    maxPromptChars: 2_000,
  });

  const result = await flusher.flush({
    activation: buildActivation(),
    packet,
    modelId: "claude-test",
    reason: "request_envelope_overflow",
  });

  assert.equal(result.status, "written");
  const userContent = String(gatewayInputs[0]?.messages.find((message) => message.role === "user")?.content ?? "");
  assert.match(userContent, /Task excerpt before compaction:/);
  assert.match(userContent, /Aurora-19/);
  assert.match(userContent, /Friday 14:15/);
  assert.match(userContent, /Field Ops Lead/);
});

test("pre-compaction memory flusher preserves structured task facts when model extraction is sparse", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text: JSON.stringify({
      preferences: [],
      constraints: [],
      longTermNotes: [],
    }),
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible",
    adapterName: "test",
    raw: {},
  });
  const memoryStore = new InMemoryThreadMemoryStore();
  const packet = buildPacket();
  packet.taskPrompt = [
    "Important durable facts near the top of the handoff:",
    "Project codename: Aurora-19.",
    "Launch window: Friday 14:15.",
    "Owner: Field Ops Lead.",
    "Hard constraint: keep the external announcement conditional until Legal Review has confirmed the data-processing addendum.",
    "Residual risk: the vendor dry-run note is still unverified, so external commitments should stay conditional.",
  ].join("\n");
  const flusher = new DefaultPreCompactionMemoryFlusher({
    gateway,
    threadMemoryStore: memoryStore,
    now: () => 99,
  });

  const result = await flusher.flush({
    activation: buildActivation(),
    packet,
    modelId: "claude-test",
    reason: "request_envelope_overflow",
  });

  assert.equal(result.status, "written");
  const stored = await memoryStore.get("thread-1");
  const text = [...(stored?.constraints ?? []), ...(stored?.longTermNotes ?? [])].join("\n");
  assert.match(text, /Aurora-19/);
  assert.match(text, /Friday 14:15/);
  assert.match(text, /Field Ops Lead/);
  assert.match(text, /Legal Review/);
  assert.match(text, /Aurora-19 hard constraint/i);
  assert.match(text, /Aurora-19 residual risk/i);
  assert.match(text, /vendor dry-run/);
});

test("pre-compaction memory flusher invalidates stale structured task facts during correction flush", async () => {
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async () => ({
    text: JSON.stringify({
      preferences: [],
      constraints: [],
      longTermNotes: [
        "Corrected Borealis-23 launch context is Thursday 16:45 with Ops Captain as owner. The previous Monday 10:15 Launch Manager note is stale and must not be used.",
      ],
    }),
    modelId: "claude-test",
    providerId: "anthropic",
    protocol: "anthropic-compatible",
    adapterName: "test",
    raw: {},
  });
  const memoryStore = new InMemoryThreadMemoryStore({
    threadId: "thread-1",
    updatedAt: 1,
    preferences: [],
    constraints: [
      "Borealis-23 launch window is Monday 10:15; owner is Launch Manager; residual risk is staging checklist pending.",
    ],
    longTermNotes: ["Keep unrelated Vega-12 planning facts for next week."],
  });
  const packet = buildPacket();
  packet.taskPrompt = [
    "Update the launch handoff.",
    "Remember this correction for Borealis-23 going forward.",
    "Project codename: Borealis-23.",
    "Launch window: Thursday 16:45.",
    "Owner: Ops Captain.",
    "Residual risk: payment processor signoff pending.",
    "The previous Borealis-23 note is stale and must not be used going forward.",
  ].join("\n");
  const flusher = new DefaultPreCompactionMemoryFlusher({
    gateway,
    threadMemoryStore: memoryStore,
    now: () => 123,
  });

  const result = await flusher.flush({
    activation: buildActivation(),
    packet,
    modelId: "claude-test",
    reason: "request_envelope_overflow",
  });

  assert.equal(result.status, "written");
  const stored = await memoryStore.get("thread-1");
  assert.ok(stored);
  const text = [...(stored?.constraints ?? []), ...(stored?.longTermNotes ?? [])].join("\n");
  assert.match(text, /Borealis-23/);
  assert.match(text, /Thursday 16:45/);
  assert.match(text, /Ops Captain/);
  assert.match(text, /payment processor signoff/);
  assert.match(text, /Borealis-23 residual risk/i);
  assert.match(text, /Vega-12/);
  assert.doesNotMatch(text, /Monday 10:15/);
  assert.doesNotMatch(text, /Launch Manager/);
  assert.doesNotMatch(text, /staging checklist/);
});

class InMemoryThreadMemoryStore implements ThreadMemoryStore {
  private records = new Map<string, ThreadMemoryRecord>();

  constructor(initial?: ThreadMemoryRecord) {
    if (initial) {
      this.records.set(initial.threadId, initial);
    }
  }

  async get(threadId: string): Promise<ThreadMemoryRecord | null> {
    return this.records.get(threadId) ?? null;
  }

  async put(record: ThreadMemoryRecord): Promise<void> {
    this.records.set(record.threadId, record);
  }
}

function buildActivation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Team",
      leadRoleId: "role-lead",
      roles: [{ roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" }],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "msg-root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 4,
      edges: [],
      createdAt: 1,
      updatedAt: 1,
    },
    runState: {
      runKey: "role:role-lead:thread:thread-1",
      threadId: "thread-1",
      roleId: "role-lead",
      mode: "group",
      status: "running",
      iterationCount: 0,
      maxIterations: 4,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-1",
      flowId: "flow-1",
      sourceMessageId: "msg-root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-1",
      payload: { threadId: "thread-1", intent: { relayBrief: "Handle task.", recentMessages: [] } },
      createdAt: 1,
    },
  };
}

function buildPacket(): RolePromptPacket {
  return {
    roleId: "role-lead",
    roleName: "Lead",
    seat: "lead",
    systemPrompt: "Lead role.",
    taskPrompt: [
      "Task brief:\nFinish the answer.",
      "Recent turns:\n[user] Please remember: never auto-submit forms without approval.",
      "Thread summary:\nDecision: use direct provider APIs before browser fallback.",
    ].join("\n\n"),
    outputContract: "Return a concise answer.",
    suggestedMentions: [],
  };
}

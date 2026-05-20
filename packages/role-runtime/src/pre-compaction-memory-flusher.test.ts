import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadMemoryRecord, ThreadMemoryStore } from "@turnkeyai/core-types/team";
import type { GenerateTextInput } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { DefaultPreCompactionMemoryFlusher } from "./pre-compaction-memory-flusher";
import type { RolePromptPacket } from "./prompt-policy";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

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

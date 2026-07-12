import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  RoleActivationInput,
  TeamMessage,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import type { LLMMessage } from "@turnkeyai/llm-adapter/index";
import { FileTeamMessageStore } from "@turnkeyai/team-store/file-team-message-store";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  RUN_EFFECT_INDETERMINATE_PROTOCOL,
  RUN_EFFECT_NOT_DISPATCHED_PROTOCOL,
  createRunJournal,
  fingerprintRunJournalTask,
} from "./run-journal";

test("run journal task fingerprint is stable across retry task ids", () => {
  const activation = buildActivation();
  const retry = {
    ...activation,
    handoff: { ...activation.handoff, taskId: "task-retry" },
  };
  const nextTask = {
    ...activation,
    handoff: { ...activation.handoff, sourceMessageId: "next-user-message" },
  };

  assert.equal(
    fingerprintRunJournalTask(activation),
    fingerprintRunJournalTask(retry),
  );
  assert.notEqual(
    fingerprintRunJournalTask(activation),
    fingerprintRunJournalTask(nextTask),
  );
});

test("RunJournal persists and restores a safe round boundary", async () => {
  const store = new MemoryTeamMessageStore();
  const journal = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  const messages: LLMMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    { role: "assistant", content: "prior work" },
  ];
  const repairMarkers: LLMMessage[] = [
    { role: "user", content: "repair marker" },
  ];
  const toolTrace: NativeToolRoundTrace[] = [
    {
      round: 3,
      calls: [{ id: "call-3", name: "web_fetch", input: {} }],
      results: [
        {
          toolCallId: "call-3",
          toolName: "web_fetch",
          isError: false,
          contentBytes: 4,
          content: "fact",
        },
      ],
    },
  ];

  await journal.checkpoint({
    messages,
    nextRound: 3,
    repairMarkers,
    toolTrace,
    planState: ["task-a: working"],
  });
  const restored = await journal.load();

  assert.deepEqual(restored, {
    messages,
    nextRound: 3,
    repairMarkers,
    toolTrace,
    planState: ["task-a: working"],
    resumedAfterCrash: true,
  });
});

test("RunJournal restores an in-flight boundary after recreating the file store", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-run-journal-"));
  const activation = buildActivation();
  const state = {
    messages: [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "durable task" },
    ],
    nextRound: 7,
    repairMarkers: [],
    toolTrace: [],
    planState: ["task-a: working"],
  };
  try {
    await createRunJournal({
      store: new FileTeamMessageStore({ rootDir }),
      activation,
      taskFingerprint: "file-backed-task",
      now: () => 100,
    }).checkpoint(state);

    const restored = await createRunJournal({
      store: new FileTeamMessageStore({ rootDir }),
      activation,
      taskFingerprint: "file-backed-task",
      now: () => 101,
    }).load();

    assert.deepEqual(restored, { ...state, resumedAfterCrash: true });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("RunJournal does not restore a terminal run", async () => {
  const store = new MemoryTeamMessageStore();
  const journal = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  const state = {
    messages: [{ role: "user" as const, content: "done" }],
    nextRound: 4,
    repairMarkers: [],
    toolTrace: [],
    planState: [],
  };

  await journal.checkpoint(state);
  await journal.complete(state);

  assert.equal(await journal.load(), null);
});

test("RunJournal marks a legacy started call indeterminate without automatic reissue", async () => {
  let now = 100;
  const store = new MemoryTeamMessageStore();
  const activation = buildActivation();
  const journal = createRunJournal({
    store,
    activation,
    taskFingerprint: "task-fingerprint",
    now: () => now,
  });
  await journal.checkpoint({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
    ],
    nextRound: 3,
    repairMarkers: [],
    toolTrace: [],
    planState: [],
  });
  now = 101;
  await store.append({
    id: "task-1:tool-round:4:assistant",
    threadId: "thread-1",
    role: "assistant",
    roleId: "role-lead",
    name: "Lead",
    content: "",
    createdAt: now,
    updatedAt: now,
    toolCalls: [
      { id: "call-pending", name: "web_fetch", arguments: { url: "https://example.com" } },
    ],
    toolStatus: "pending",
    metadata: {
      nativeToolUse: true,
      flowId: "flow-1",
      toolRound: 4,
      runtimeMode: "policy-driven",
    },
  });

  const restored = await journal.load();

  assert.ok(restored);
  assert.equal(restored.nextRound, 4);
  assert.equal(restored.toolTrace.length, 1);
  assert.equal(restored.toolTrace[0]?.results[0]?.isError, true);
  assert.match(
    restored.toolTrace[0]?.results[0]?.content ?? "",
    /turnkeyai\.effect_indeterminate\.v1/,
  );
  assert.doesNotMatch(
    restored.toolTrace[0]?.results[0]?.content ?? "",
    /reissue the call/i,
  );
  const interruptedMessage = restored.messages.at(-1);
  assert.equal(interruptedMessage?.role, "tool");
  assert.match(JSON.stringify(interruptedMessage?.content), /call-pending/);
});

test("RunJournal records an admitted effect before dispatch and restores it as not dispatched", async () => {
  const store = new MemoryTeamMessageStore();
  const journal = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());
  await journal.effectLedger.admit({
    round: 4,
    call: {
      id: "call-admitted",
      name: "web_fetch",
      input: { url: "https://example.com" },
    },
  });

  const restored = await journal.load();

  assert.ok(restored);
  assert.equal(restored.toolTrace[0]?.results[0]?.isError, true);
  assert.match(
    restored.toolTrace[0]?.results[0]?.content ?? "",
    new RegExp(RUN_EFFECT_NOT_DISPATCHED_PROTOCOL.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(
    restored.toolTrace[0]?.results[0]?.content ?? "",
    /already executed|reissue only if/i,
  );
});

test("RunJournal marks a started effect without a receipt indeterminate and forbids automatic reissue", async () => {
  const store = new MemoryTeamMessageStore();
  const journal = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());
  const call = {
    id: "call-started",
    name: "publish_release",
    input: { releaseId: "release-42" },
  };
  await journal.effectLedger.admit({ round: 4, call });
  await journal.effectLedger.start(call.id);

  const restored = await journal.load();
  const content = restored?.toolTrace[0]?.results[0]?.content ?? "";

  assert.match(
    content,
    new RegExp(RUN_EFFECT_INDETERMINATE_PROTOCOL.replaceAll(".", "\\.")),
  );
  assert.match(content, /must not be dispatched again automatically/i);
  assert.doesNotMatch(content, /reissue the call/i);
});

test("RunJournal restores a durable effect receipt without re-executing the tool", async () => {
  const store = new MemoryTeamMessageStore();
  const journal = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());
  const call = {
    id: "call-committed",
    name: "web_fetch",
    input: { url: "https://example.com" },
  };
  await journal.effectLedger.admit({ round: 4, call });
  await journal.effectLedger.start(call.id);
  await journal.effectLedger.recordResult({
    toolCallId: call.id,
    toolName: call.name,
    content: "durable receipt",
  });

  const restored = await journal.load();

  assert.equal(restored?.toolTrace[0]?.results[0]?.content, "durable receipt");
  assert.equal(restored?.toolTrace[0]?.results[0]?.isError, false);
});

test("RunJournal reconciles a started effect through a read-only adapter lookup", async () => {
  const store = new MemoryTeamMessageStore();
  let lookups = 0;
  const create = () => createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
    async reconcileEffect(effect) {
      lookups += 1;
      return {
        toolCallId: effect.effectId,
        toolName: effect.call.name,
        content: "reconciled external receipt",
      };
    },
  });
  const journal = create();
  await journal.checkpoint(emptyRunState());
  await journal.effectLedger.admit({
    round: 4,
    call: { id: "call-reconciled", name: "publish", input: {} },
  });
  await journal.effectLedger.start("call-reconciled");

  const restored = await create().load();

  assert.equal(lookups, 1);
  assert.equal(
    restored?.toolTrace[0]?.results[0]?.content,
    "reconciled external receipt",
  );
  assert.doesNotMatch(
    restored?.toolTrace[0]?.results[0]?.content ?? "",
    /indeterminate/,
  );
});

test("RunJournal restores a matching durable native receipt", async () => {
  let now = 100;
  const store = new MemoryTeamMessageStore();
  const activation = buildActivation();
  const journal = createRunJournal({
    store,
    activation,
    taskFingerprint: "task-fingerprint",
    now: () => now,
  });
  await journal.checkpoint(emptyRunState());
  const call = { id: "native-call", name: "publish", input: {} };
  await journal.effectLedger.admit({ round: 4, call });
  await journal.effectLedger.start(call.id);
  now = 101;
  await store.append({
    id: "task-1:tool-round:4:result:native-call",
    threadId: activation.thread.threadId,
    role: "tool",
    roleId: activation.runState.roleId,
    name: call.name,
    content: "native durable receipt",
    createdAt: now,
    updatedAt: now,
    toolCallId: call.id,
    toolStatus: "completed",
    metadata: {
      nativeToolUse: true,
      flowId: activation.flow.flowId,
      toolRound: 4,
    },
  });

  const restored = await journal.load();

  assert.equal(
    restored?.toolTrace[0]?.results[0]?.content,
    "native durable receipt",
  );
});

test("RunJournal ignores a same-id native receipt from another flow", async () => {
  let now = 100;
  const store = new MemoryTeamMessageStore();
  const activation = buildActivation();
  const journal = createRunJournal({
    store,
    activation,
    taskFingerprint: "task-fingerprint",
    now: () => now,
  });
  await journal.checkpoint(emptyRunState());
  const call = { id: "shared-call-id", name: "publish", input: {} };
  await journal.effectLedger.admit({ round: 4, call });
  await journal.effectLedger.start(call.id);
  now = 101;
  await store.append({
    id: "foreign-tool-result",
    threadId: activation.thread.threadId,
    role: "tool",
    roleId: activation.runState.roleId,
    name: call.name,
    content: "foreign receipt",
    createdAt: now,
    updatedAt: now,
    toolCallId: call.id,
    toolStatus: "completed",
    metadata: {
      nativeToolUse: true,
      flowId: "different-flow",
      toolRound: 4,
    },
  });

  const restored = await journal.load();
  const content = restored?.toolTrace[0]?.results[0]?.content ?? "";

  assert.match(content, /turnkeyai\.effect_indeterminate\.v1/);
  assert.doesNotMatch(content, /foreign receipt/);
});

test("RunJournal rejects effect-id reuse with a different proposal", async () => {
  const journal = createRunJournal({
    store: new MemoryTeamMessageStore(),
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());
  await journal.effectLedger.admit({
    round: 1,
    call: { id: "stable-id", name: "tool_a", input: { value: 1 } },
  });

  await assert.rejects(
    journal.effectLedger.admit({
      round: 1,
      call: { id: "stable-id", name: "tool_b", input: { value: 2 } },
    }),
    /effect id reused with a different proposal/,
  );
});

test("RunJournal returns the prior receipt for a re-proposed terminal effect", async () => {
  const journal = createRunJournal({
    store: new MemoryTeamMessageStore(),
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());
  const call = { id: "stable-id", name: "publish", input: { value: 1 } };
  await journal.effectLedger.admit({ round: 1, call });
  await journal.effectLedger.start(call.id);
  await journal.effectLedger.recordResult({
    toolCallId: call.id,
    toolName: call.name,
    content: "prior receipt",
  });
  await journal.checkpoint({
    ...emptyRunState(),
    messages: [
      ...emptyRunState().messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          },
        ],
      },
      {
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: [
          {
            type: "tool_result",
            toolUseId: call.id,
            content: "prior receipt",
          },
        ],
      },
    ],
  });

  const prior = await journal.effectLedger.admit({ round: 2, call });

  assert.deepEqual(prior, {
    toolCallId: call.id,
    toolName: call.name,
    content: "prior receipt",
  });
});

test("a rejected ledger transition does not poison later transitions", async () => {
  const store = new MemoryTeamMessageStore();
  const journal = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());
  const failedCall = { id: "failed-write", name: "publish", input: {} };
  await journal.effectLedger.admit({ round: 1, call: failedCall });
  store.failNextAppend();

  await assert.rejects(
    journal.effectLedger.start(failedCall.id),
    /injected append failure/,
  );

  const nextCall = { id: "next-effect", name: "publish", input: {} };
  assert.equal(
    await journal.effectLedger.admit({ round: 2, call: nextCall }),
    null,
  );
  await journal.effectLedger.start(nextCall.id);
  await journal.effectLedger.recordResult({
    toolCallId: nextCall.id,
    toolName: nextCall.name,
    content: "succeeded after isolated failure",
  });

  const restored = await journal.load();
  const failedReceipt = restored?.toolTrace
    .flatMap((round) => round.results)
    .find((result) => result.toolCallId === failedCall.id);
  assert.match(
    failedReceipt?.content ?? "",
    /turnkeyai\.effect_not_dispatched\.v1/,
  );
  assert.doesNotMatch(failedReceipt?.content ?? "", /indeterminate/);
});

test("RunJournal ignores an in-flight snapshot for a different task fingerprint", async () => {
  const store = new MemoryTeamMessageStore();
  await createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "old-task",
    now: () => 100,
  }).checkpoint({
    messages: [{ role: "user", content: "old task" }],
    nextRound: 5,
    repairMarkers: [],
    toolTrace: [],
    planState: [],
  });

  const current = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "new-task",
    now: () => 101,
  });

  assert.equal(await current.load(), null);
});

class MemoryTeamMessageStore implements TeamMessageStore {
  private readonly messages = new Map<string, TeamMessage>();
  private rejectNextAppend = false;

  failNextAppend(): void {
    this.rejectNextAppend = true;
  }

  async append(message: TeamMessage): Promise<void> {
    if (this.rejectNextAppend) {
      this.rejectNextAppend = false;
      throw new Error("injected append failure");
    }
    const previous = this.messages.get(message.id);
    this.messages.set(message.id, {
      ...message,
      createdAt: previous?.createdAt ?? message.createdAt,
    });
  }

  async list(threadId: string, limit?: number): Promise<TeamMessage[]> {
    const messages = [...this.messages.values()]
      .filter((message) => message.threadId === threadId)
      .sort((left, right) => left.createdAt - right.createdAt);
    return limit === undefined ? messages : messages.slice(-limit);
  }

  async get(messageId: string): Promise<TeamMessage | null> {
    return this.messages.get(messageId) ?? null;
  }
}

function emptyRunState() {
  return {
    messages: [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "task" },
    ],
    nextRound: 3,
    repairMarkers: [],
    toolTrace: [],
    planState: [],
  };
}

function buildActivation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-1",
      teamId: "team-1",
      teamName: "Team",
      leadRoleId: "role-lead",
      roles: [
        { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
      ],
      participantLinks: [],
      metadataVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    flow: {
      flowId: "flow-1",
      threadId: "thread-1",
      rootMessageId: "root",
      mode: "serial",
      status: "running",
      currentStageIndex: 0,
      activeRoleIds: ["role-lead"],
      completedRoleIds: [],
      failedRoleIds: [],
      hopCount: 1,
      maxHops: 10,
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
      maxIterations: 10,
      inbox: [],
      lastActiveAt: 1,
    },
    handoff: {
      taskId: "task-1",
      flowId: "flow-1",
      sourceMessageId: "root",
      targetRoleId: "role-lead",
      activationType: "cascade",
      threadId: "thread-1",
      payload: { threadId: "thread-1" },
      createdAt: 1,
    },
  };
}

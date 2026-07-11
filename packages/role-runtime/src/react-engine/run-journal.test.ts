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

test("RunJournal converts a pending native call into an interrupted error on resume", async () => {
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
    /turnkeyai\.run_resume_interrupted_tool\.v1/,
  );
  const interruptedMessage = restored.messages.at(-1);
  assert.equal(interruptedMessage?.role, "tool");
  assert.match(JSON.stringify(interruptedMessage?.content), /call-pending/);
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

  async append(message: TeamMessage): Promise<void> {
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

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
  RUN_JOURNAL_PROTOCOL,
  createRunJournal,
  fingerprintRunJournalTask,
  type RunJournalState,
} from "./run-journal";
import {
  InMemoryRunEffectWalStore,
  type EffectWalEntry,
} from "./effect-wal";

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

test("RunJournal rejects a checkpoint with an incomplete tool protocol unit", async () => {
  const store = new MemoryTeamMessageStore();
  const journal = createRunJournal({
    store,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  const state: RunJournalState = emptyRunState();
  state.messages.push({
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "call-open",
      name: "web_fetch",
      input: { url: "https://example.com" },
    }],
  });

  await assert.rejects(
    () => journal.checkpoint(state),
    /incomplete tool protocol unit/,
  );
  assert.equal(await journal.load(), null);
});

test("RunJournal ignores a stored snapshot with an incomplete tool protocol unit", async () => {
  const store = new MemoryTeamMessageStore();
  const activation = buildActivation();
  await store.append({
    id: `runtime-journal:${activation.runState.runKey}`,
    threadId: activation.thread.threadId,
    role: "system",
    roleId: activation.runState.roleId,
    name: "Lead",
    content: "",
    createdAt: 100,
    updatedAt: 100,
    metadata: {
      runtimeRunJournal: true,
      flowId: activation.flow.flowId,
      runJournal: {
        protocol: RUN_JOURNAL_PROTOCOL,
        status: "in_flight",
        runKey: activation.runState.runKey,
        taskId: activation.handoff.taskId,
        taskFingerprint: "task-fingerprint",
        updatedAt: 100,
        messages: [
          ...emptyRunState().messages,
          {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "call-open",
              name: "web_fetch",
              input: { url: "https://example.com" },
            }],
          },
        ],
        nextRound: 3,
        repairMarkers: [],
        toolTrace: [],
        planState: [],
      },
    },
  });
  const journal = createRunJournal({
    store,
    activation,
    taskFingerprint: "task-fingerprint",
    now: () => 101,
  });

  assert.equal(await journal.load(), null);
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

  // Same-round re-proposal (e.g. executor retry after a timeout) replays
  // the durable receipt instead of dispatching twice.
  const prior = await journal.effectLedger.admit({ round: 1, call });

  assert.deepEqual(prior, {
    toolCallId: call.id,
    toolName: call.name,
    content: "prior receipt",
  });

  // A later round reusing the id over a terminal effect (providers with
  // deterministic per-turn ids like call_0) admits fresh work — a
  // legitimate re-poll must re-execute, not spin on the stale receipt.
  const fresh = await journal.effectLedger.admit({ round: 2, call });
  assert.equal(fresh, null);
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

// A WAL store that never truncates — models a crash between the durable
// checkpoint write and the WAL truncation.
class NonTruncatingWalStore extends InMemoryRunEffectWalStore {
  override async truncate(): Promise<void> {
    // Intentionally a no-op.
  }
}

// A WAL store whose append always fails — for rollback testing.
class FailingWalStore extends InMemoryRunEffectWalStore {
  override async append(): Promise<void> {
    throw new Error("injected wal append failure");
  }
}

const PUBLISH_CALL = { id: "stable-id", name: "publish", input: { value: 1 } };

test("WAL mode appends transitions without rewriting the journal per transition", async () => {
  const store = new MemoryTeamMessageStore();
  const wal = new InMemoryRunEffectWalStore();
  const journal = createRunJournal({
    store,
    effectWalStore: wal,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());
  const appendsAfterCheckpoint = store.appendCount;

  await journal.effectLedger.admit({ round: 1, call: PUBLISH_CALL });
  await journal.effectLedger.start(PUBLISH_CALL.id);
  await journal.effectLedger.recordResult({
    toolCallId: PUBLISH_CALL.id,
    toolName: PUBLISH_CALL.name,
    content: "done",
  });

  // Three transitions rewrote the full journal zero times; they only
  // appended WAL lines.
  assert.equal(store.appendCount, appendsAfterCheckpoint);
  assert.deepEqual(
    (await wal.readAll(buildActivation().runState.runKey)).map((e) => e.op),
    ["admit", "start", "result"],
  );
});

test("WAL mode reconstructs a started-but-unfinished effect as indeterminate on resume", async () => {
  const store = new MemoryTeamMessageStore();
  const wal = new InMemoryRunEffectWalStore();
  const j1 = createRunJournal({
    store,
    effectWalStore: wal,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await j1.checkpoint(emptyRunState());
  await j1.effectLedger.admit({ round: 1, call: PUBLISH_CALL });
  await j1.effectLedger.start(PUBLISH_CALL.id);
  // Crash: no result, no further checkpoint. WAL holds admit+start.

  const j2 = createRunJournal({
    store,
    effectWalStore: wal,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 200,
    reconcileEffect: async () => null,
  });
  const resumed = await j2.load();

  const toolResult = resumed?.messages.find(
    (message) =>
      message.role === "tool" && message.toolCallId === PUBLISH_CALL.id,
  );
  assert.ok(toolResult, "resume synthesizes a result for the started effect");
  const rawContent = toolResult?.content;
  const content = typeof rawContent === "string"
    ? rawContent
    : (Array.isArray(rawContent) ? rawContent : [])
        .map((block) =>
          block.type === "tool_result" && typeof block.content === "string"
            ? block.content
            : "",
        )
        .join("");
  assert.match(content, new RegExp(RUN_EFFECT_INDETERMINATE_PROTOCOL));
});

test("WAL replay is idempotent when a crash lands before truncation", async () => {
  const store = new MemoryTeamMessageStore();
  const wal = new NonTruncatingWalStore();
  const j1 = createRunJournal({
    store,
    effectWalStore: wal,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await j1.checkpoint(emptyRunState());
  await j1.effectLedger.admit({ round: 1, call: PUBLISH_CALL });
  await j1.effectLedger.start(PUBLISH_CALL.id);
  await j1.effectLedger.recordResult({
    toolCallId: PUBLISH_CALL.id,
    toolName: PUBLISH_CALL.name,
    content: "committed receipt",
  });
  // Checkpoint folds the ledger in (watermark = 3) but the WAL is NOT
  // truncated — models a crash right after the durable snapshot write.
  await j1.checkpoint({
    ...emptyRunState(),
    messages: [
      ...emptyRunState().messages,
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: PUBLISH_CALL.id, name: PUBLISH_CALL.name, input: PUBLISH_CALL.input },
        ],
      },
      {
        role: "tool",
        name: PUBLISH_CALL.name,
        toolCallId: PUBLISH_CALL.id,
        content: [
          { type: "tool_result", toolUseId: PUBLISH_CALL.id, content: "committed receipt" },
        ],
      },
    ],
  });

  const j2 = createRunJournal({
    store,
    effectWalStore: wal,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 200,
  });
  await j2.load();
  // Re-proposing the same call in the same round replays the durable
  // receipt: recovery saw exactly one committed effect, not a double from
  // re-applying the un-truncated WAL entries.
  const receipt = await j2.effectLedger.admit({ round: 1, call: PUBLISH_CALL });
  assert.equal(receipt?.content, "committed receipt");
});

test("WAL append failure rolls back the in-memory ledger", async () => {
  const store = new MemoryTeamMessageStore();
  const wal = new FailingWalStore();
  const journal = createRunJournal({
    store,
    effectWalStore: wal,
    activation: buildActivation(),
    taskFingerprint: "task-fingerprint",
    now: () => 100,
  });
  await journal.checkpoint(emptyRunState());

  await assert.rejects(
    journal.effectLedger.admit({ round: 1, call: PUBLISH_CALL }),
    /injected wal append failure/,
  );
  // The failed admit did not durably admit anything, so the same id is free
  // to admit again once the store recovers (no phantom active admission).
  const before = await wal.readAll(buildActivation().runState.runKey);
  assert.deepEqual(before, [] as EffectWalEntry[]);
});

class MemoryTeamMessageStore implements TeamMessageStore {
  private readonly messages = new Map<string, TeamMessage>();
  private rejectNextAppend = false;
  appendCount = 0;

  failNextAppend(): void {
    this.rejectNextAppend = true;
  }

  async append(message: TeamMessage): Promise<void> {
    if (this.rejectNextAppend) {
      this.rejectNextAppend = false;
      throw new Error("injected append failure");
    }
    this.appendCount += 1;
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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeProgressRecorder, TeamMessage, TeamMessageStore } from "@turnkeyai/core-types/team";
import { DefaultContextCompressor } from "@turnkeyai/role-runtime/compression/context-compressor";
import { FileRoleScratchpadStore } from "@turnkeyai/team-store/context/file-role-scratchpad-store";
import { FileThreadJournalStore } from "@turnkeyai/team-store/context/file-thread-journal-store";
import { FileThreadMemoryStore } from "@turnkeyai/team-store/context/file-thread-memory-store";
import { FileThreadSessionMemoryStore } from "@turnkeyai/team-store/context/file-thread-session-memory-store";
import { FileThreadSummaryStore } from "@turnkeyai/team-store/context/file-thread-summary-store";

import { DefaultContextStateMaintainer } from "./context-state-maintainer";

test("context state maintainer refreshes thread summary and role scratchpad from message history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-maintainer-"));

  try {
    const messages: TeamMessage[] = [
      {
        id: "msg-user-1",
        threadId: "thread-1",
        role: "user",
        name: "Chris",
        content: "Compare vendors for next month.",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "msg-lead-1",
        threadId: "thread-1",
        role: "assistant",
        roleId: "role-lead",
        name: "Lead",
        content: "Finance should estimate cost and risk. Budget must stay under $500.",
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "msg-finance-1",
        threadId: "thread-1",
        role: "assistant",
        roleId: "role-finance",
        name: "Financial Expert",
        content: "I checked current entry pricing and documented the first-month delta. Should we lock vendor A?",
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    let visibleCount = messages.length;
    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
        visibleCount = messages.length;
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId).slice(0, visibleCount);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadMemoryStore,
      threadSessionMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      now: () => Date.parse("2026-03-29T08:00:00.000Z"),
    });

    await maintainer.onUserMessage("thread-1");
    await maintainer.onRoleReply("thread-1", "role-finance");
    await maintainer.flushBackgroundWork();

    const summary = await threadSummaryStore.get("thread-1");
    assert.ok(summary);
    assert.equal(summary?.userGoal, "Compare vendors for next month.");
    assert.equal(summary?.sourceMessageCount, 3);
    assert.ok(summary?.stableFacts.some((entry) => entry.includes("Budget must stay under $500")));
    assert.ok(summary?.openQuestions.some((entry) => entry.includes("Should we lock vendor A?")));

    const scratchpad = await roleScratchpadStore.get("thread-1", "role-finance");
    assert.ok(scratchpad);
    assert.equal(scratchpad?.roleId, "role-finance");
    assert.equal(scratchpad?.sourceMessageCount, 2);
    assert.ok(
      scratchpad?.completedWork.some((entry) => entry.includes("I checked current entry pricing and documented the first-month delta"))
    );
    assert.ok(scratchpad?.pendingWork.some((entry) => entry.includes("Compare vendors for next month")));

    const memory = await threadMemoryStore.get("thread-1");
    assert.ok(memory);
    assert.ok(memory?.constraints.some((entry) => entry.includes("Budget must stay under $500")));

    const journal = await threadJournalStore.get("thread-1", "2026-03-29");
    assert.ok(journal);
    assert.ok(journal?.entries.some((entry) => entry.includes("[Chris] Compare vendors for next month.")));
    assert.ok(journal?.entries.some((entry) => entry.includes("[Financial Expert] I checked current entry pricing")));

    const sessionMemory = await threadSessionMemoryStore.get("thread-1");
    assert.ok(sessionMemory);
    assert.equal(sessionMemory?.sourceMessageCount, 3);
    assert.equal(typeof sessionMemory?.sectionFingerprint, "string");
    assert.ok(sessionMemory?.activeTasks.some((entry) => entry.includes("Should we lock vendor A?")));
    assert.ok(sessionMemory?.constraints.some((entry) => entry.includes("Budget must stay under $500")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer compacts journal overflow and keeps recent memory entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-compaction-"));

  try {
    const messages: TeamMessage[] = Array.from({ length: 7 }, (_, index) => ({
      id: `msg-user-${index + 1}`,
      threadId: "thread-3",
      role: "user",
      name: "Chris",
      content:
        index === 0
          ? "Prefer concise summaries."
          : index === 1
            ? "Budget must stay under $500."
            : `Keep in mind follow-up item ${index + 1}.`,
      createdAt: index + 1,
      updatedAt: index + 1,
    }));

    let visibleCount = 0;
    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
        visibleCount = messages.length;
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId).slice(0, visibleCount);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };

    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      journalEntryLimit: 4,
      journalKeepRecent: 3,
      memoryListLimit: 2,
      now: () => Date.parse("2026-03-29T08:00:00.000Z"),
    });

    for (let index = 0; index < messages.length; index += 1) {
      visibleCount = index + 1;
      await maintainer.onUserMessage("thread-3");
    }

    const journal = await threadJournalStore.get("thread-3", "2026-03-29");
    assert.ok(journal);
    assert.equal(journal?.entries.length, 4);
    assert.match(journal?.entries[0] ?? "", /^\[compacted\] \d+ earlier entries summarized/);
    assert.ok(journal?.entries.some((entry) => entry.includes("follow-up item 7")));

    const memory = await threadMemoryStore.get("thread-3");
    assert.ok(memory);
    assert.equal(memory?.preferences.length, 1);
    assert.ok(memory?.preferences.includes("Prefer concise summaries."));
    assert.equal(memory?.constraints.length, 1);
    assert.ok(memory?.constraints.includes("Budget must stay under $500."));
    assert.equal(memory?.longTermNotes.length, 2);
    assert.ok(memory?.longTermNotes.at(-1)?.includes("follow-up item 7"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer carries unresolved summary questions into long-term memory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-carry-forward-"));

  try {
    const messages: TeamMessage[] = [
      {
        id: "msg-user-1",
        threadId: "thread-4",
        role: "user",
        name: "Chris",
        content: "We should follow-up on pricing after the browser run.",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "msg-role-1",
        threadId: "thread-4",
        role: "assistant",
        roleId: "role-operator",
        name: "Operator",
        content: "Open question: should we follow up with the browser pricing snapshot before finalizing?",
        createdAt: 2,
        updatedAt: 2,
      },
    ];

    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      now: () => Date.parse("2026-03-30T08:00:00.000Z"),
    });

    await maintainer.onUserMessage("thread-4");
    await maintainer.onRoleReply("thread-4", "role-operator");

    const memory = await threadMemoryStore.get("thread-4");
    assert.ok(memory);
    assert.ok(
      memory?.longTermNotes.some((entry) => entry.includes("follow up with the browser pricing snapshot"))
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer skips refresh when message delta stays below threshold", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-threshold-"));

  try {
    const messages: TeamMessage[] = [
      {
        id: "msg-user-1",
        threadId: "thread-2",
        role: "user",
        name: "Chris",
        content: "Track the pricing update.",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadJournalStore = new FileThreadJournalStore({
      rootDir: path.join(tempDir, "thread-journal"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadMemoryStore,
      threadJournalStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      threadRefreshMinDelta: 2,
      roleRefreshMinDelta: 2,
      now: () => Date.parse("2026-03-29T08:00:00.000Z"),
    });

    await maintainer.onUserMessage("thread-2");
    const firstSummary = await threadSummaryStore.get("thread-2");
    assert.ok(firstSummary);

    messages.push({
      id: "msg-role-1",
      threadId: "thread-2",
      role: "assistant",
      roleId: "role-operator",
      name: "Operator",
      content: "I checked the site once.",
      createdAt: 2,
      updatedAt: 2,
    });

    await maintainer.onRoleReply("thread-2", "role-operator");

    const secondSummary = await threadSummaryStore.get("thread-2");
    assert.equal(secondSummary?.summaryVersion, 1);
    const scratchpad = await roleScratchpadStore.get("thread-2", "role-operator");
    assert.ok(scratchpad);
    assert.equal(scratchpad?.sourceMessageCount, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer refreshes session memory in scheduled background mode", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-background-refresh-"));

  try {
    const messages: TeamMessage[] = [
      {
        id: "msg-user-1",
        threadId: "thread-bg",
        role: "user",
        name: "Chris",
        content: "Follow up with the browser capture tomorrow.",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadMemoryStore,
      threadSessionMemoryStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      sessionMemoryRefreshDelayMs: 25,
      now: () => Date.parse("2026-03-31T08:00:00.000Z"),
    });

    await maintainer.onUserMessage("thread-bg");
    assert.equal(await threadSessionMemoryStore.get("thread-bg"), null);

    await maintainer.flushBackgroundWork();
    const sessionMemory = await threadSessionMemoryStore.get("thread-bg");
    assert.ok(sessionMemory);
    assert.ok(sessionMemory?.continuityNotes.some((entry) => entry.includes("Follow up with the browser capture tomorrow")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer still schedules session memory refresh when progress recording fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-progress-failure-"));

  try {
    const messages: TeamMessage[] = [
      {
        id: "msg-user-1",
        threadId: "thread-progress-failure",
        role: "user",
        name: "Chris",
        content: "Keep the vendor decision visible.",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadMemoryStore = new FileThreadMemoryStore({
      rootDir: path.join(tempDir, "thread-memory"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });
    let progressAttempts = 0;
    const runtimeProgressRecorder: RuntimeProgressRecorder = {
      async record() {
        progressAttempts += 1;
        throw new Error("progress recorder unavailable");
      },
    };

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadMemoryStore,
      threadSessionMemoryStore,
      roleScratchpadStore,
      runtimeProgressRecorder,
      contextCompressor: new DefaultContextCompressor(),
      sessionMemoryRefreshDelayMs: 0,
      now: () => Date.parse("2026-03-31T08:00:00.000Z"),
    });

    await maintainer.onUserMessage("thread-progress-failure");
    await maintainer.flushBackgroundWork();

    const sessionMemory = await threadSessionMemoryStore.get("thread-progress-failure");
    assert.ok(sessionMemory);
    assert.ok(progressAttempts >= 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer schedules session memory refresh without thread memory store", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-session-memory-only-"));

  try {
    const messages: TeamMessage[] = [
      {
        id: "msg-user-1",
        threadId: "thread-session-only",
        role: "user",
        name: "Chris",
        content: "Remember the unresolved pricing follow-up.",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadSessionMemoryStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      sessionMemoryRefreshDelayMs: 0,
      now: () => Date.parse("2026-03-31T08:00:00.000Z"),
    });

    await maintainer.onUserMessage("thread-session-only");
    await maintainer.flushBackgroundWork();

    const sessionMemory = await threadSessionMemoryStore.get("thread-session-only");
    assert.ok(sessionMemory);
    assert.ok(sessionMemory?.continuityNotes.some((entry) => entry.includes("Remember the unresolved pricing follow-up")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer preserves existing scratchpad-derived session memory when scratchpad update is omitted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-tristate-"));

  try {
    const teamMessageStore: TeamMessageStore = {
      async append() {},
      async list() {
        return [];
      },
      async get() {
        return null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    await threadSessionMemoryStore.put({
      threadId: "thread-tristate",
      memoryVersion: 1,
      sourceMessageCount: 0,
      updatedAt: 1,
      activeTasks: ["Carry forward pending task"],
      openQuestions: [],
      recentDecisions: [],
      constraints: [],
      continuityNotes: ["Waiting on: prior dependency"],
      latestJournalEntries: [],
      sectionFingerprint: "seed",
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadSessionMemoryStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      now: () => Date.parse("2026-03-31T08:00:00.000Z"),
    });

    await (maintainer as unknown as {
      refreshSessionMemory(threadId: string, roleScratchpad?: null | {
        completedWork: string[];
        pendingWork: string[];
        waitingOn?: string;
      }): Promise<void>;
    }).refreshSessionMemory("thread-tristate");

    const sessionMemory = await threadSessionMemoryStore.get("thread-tristate");
    assert.ok(sessionMemory?.activeTasks.includes("Carry forward pending task"));
    assert.ok(sessionMemory?.continuityNotes.includes("Waiting on: prior dependency"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context state maintainer persists memoryVersion changes even when sections stay stable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-state-memory-version-"));

  try {
    const messages: TeamMessage[] = [
      {
        id: "msg-user-1",
        threadId: "thread-memory-version",
        role: "user",
        name: "Chris",
        content: "Keep the browser pricing snapshot handy.",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const teamMessageStore: TeamMessageStore = {
      async append(message) {
        messages.push(message);
      },
      async list(threadId, limit) {
        const matching = messages.filter((message) => message.threadId === threadId);
        return limit == null ? matching : matching.slice(-limit);
      },
      async get(messageId) {
        return messages.find((message) => message.id === messageId) ?? null;
      },
    };
    const threadSummaryStore = new FileThreadSummaryStore({
      rootDir: path.join(tempDir, "thread-summaries"),
    });
    const threadSessionMemoryStore = new FileThreadSessionMemoryStore({
      rootDir: path.join(tempDir, "thread-session-memory"),
    });
    const roleScratchpadStore = new FileRoleScratchpadStore({
      rootDir: path.join(tempDir, "role-scratchpads"),
    });

    await threadSummaryStore.put({
      threadId: "thread-memory-version",
      summaryVersion: 3,
      sourceMessageCount: 1,
      updatedAt: 1,
      userGoal: "Keep the browser pricing snapshot handy.",
      stableFacts: [],
      openQuestions: [],
      decisions: [],
    });
    await threadSessionMemoryStore.put({
      threadId: "thread-memory-version",
      memoryVersion: 1,
      sourceMessageCount: 1,
      updatedAt: 1,
      activeTasks: [],
      openQuestions: [],
      recentDecisions: [],
      constraints: [],
      continuityNotes: ["[Chris] Keep the browser pricing snapshot handy."],
      latestJournalEntries: [],
      sectionFingerprint: "seed",
    });

    const maintainer = new DefaultContextStateMaintainer({
      teamMessageStore,
      threadSummaryStore,
      threadSessionMemoryStore,
      roleScratchpadStore,
      contextCompressor: new DefaultContextCompressor(),
      now: () => Date.parse("2026-03-31T08:00:00.000Z"),
    });

    await (maintainer as unknown as {
      refreshSessionMemory(threadId: string, roleScratchpad?: null | {
        completedWork: string[];
        pendingWork: string[];
        waitingOn?: string;
      }): Promise<void>;
    }).refreshSessionMemory("thread-memory-version", null);

    const sessionMemory = await threadSessionMemoryStore.get("thread-memory-version");
    assert.equal(sessionMemory?.memoryVersion, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

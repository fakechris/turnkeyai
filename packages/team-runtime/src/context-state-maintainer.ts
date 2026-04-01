import { createHash } from "node:crypto";

import { hasContinuationBacklogSignal } from "@turnkeyai/core-types/continuation-semantics";
import type {
  RoleId,
  RoleScratchpadStore,
  RuntimeProgressRecorder,
  SessionMemoryRefreshJobStore,
  ThreadSessionMemoryRecord,
  ThreadSessionMemoryStore,
  TeamMessageStore,
  ThreadJournalStore,
  ThreadMemoryStore,
  ThreadId,
  ThreadSummaryStore,
} from "@turnkeyai/core-types/team";
import { toMessageSummary } from "@turnkeyai/core-types/team";
import type { ContextCompressor } from "@turnkeyai/role-runtime/compression/context-compressor";

import { DefaultSessionMemoryRefreshWorker, type SessionMemoryRefreshWorker } from "./session-memory-refresh-worker";

export interface ContextStateMaintainer {
  onUserMessage(threadId: ThreadId): Promise<void>;
  onRoleReply(threadId: ThreadId, roleId: RoleId): Promise<void>;
  drain(): Promise<void>;
}

interface DefaultContextStateMaintainerOptions {
  teamMessageStore: TeamMessageStore;
  threadSummaryStore: ThreadSummaryStore;
  roleScratchpadStore: RoleScratchpadStore;
  threadMemoryStore?: ThreadMemoryStore;
  threadSessionMemoryStore?: ThreadSessionMemoryStore;
  threadJournalStore?: ThreadJournalStore;
  sessionMemoryRefreshJobStore?: SessionMemoryRefreshJobStore;
  contextCompressor: ContextCompressor;
  runtimeProgressRecorder?: RuntimeProgressRecorder;
  threadMessageLimit?: number;
  roleMessageLimit?: number;
  threadRefreshMinDelta?: number;
  roleRefreshMinDelta?: number;
  journalEntryLimit?: number;
  journalKeepRecent?: number;
  memoryListLimit?: number;
  sessionMemoryRefreshDelayMs?: number;
  now?: () => number;
  dateKey?: (timestamp: number) => string;
}

export class DefaultContextStateMaintainer implements ContextStateMaintainer {
  private readonly teamMessageStore: TeamMessageStore;
  private readonly threadSummaryStore: ThreadSummaryStore;
  private readonly roleScratchpadStore: RoleScratchpadStore;
  private readonly threadMemoryStore: ThreadMemoryStore | undefined;
  private readonly threadSessionMemoryStore: ThreadSessionMemoryStore | undefined;
  private readonly threadJournalStore: ThreadJournalStore | undefined;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly contextCompressor: ContextCompressor;
  private readonly threadMessageLimit: number;
  private readonly roleMessageLimit: number;
  private readonly threadRefreshMinDelta: number;
  private readonly roleRefreshMinDelta: number;
  private readonly journalEntryLimit: number;
  private readonly journalKeepRecent: number;
  private readonly memoryListLimit: number;
  private readonly sessionMemoryRefreshDelayMs: number;
  private readonly now: () => number;
  private readonly formatDateKey: (timestamp: number) => string;
  private readonly sessionMemoryRefreshWorker: SessionMemoryRefreshWorker | undefined;

  constructor(options: DefaultContextStateMaintainerOptions) {
    this.teamMessageStore = options.teamMessageStore;
    this.threadSummaryStore = options.threadSummaryStore;
    this.roleScratchpadStore = options.roleScratchpadStore;
    this.threadMemoryStore = options.threadMemoryStore;
    this.threadSessionMemoryStore = options.threadSessionMemoryStore;
    this.threadJournalStore = options.threadJournalStore;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.contextCompressor = options.contextCompressor;
    this.threadMessageLimit = options.threadMessageLimit ?? 40;
    this.roleMessageLimit = options.roleMessageLimit ?? 12;
    this.threadRefreshMinDelta = options.threadRefreshMinDelta ?? 1;
    this.roleRefreshMinDelta = options.roleRefreshMinDelta ?? 1;
    this.journalEntryLimit = options.journalEntryLimit ?? 12;
    this.journalKeepRecent = options.journalKeepRecent ?? 8;
    this.memoryListLimit = options.memoryListLimit ?? 12;
    this.sessionMemoryRefreshDelayMs = options.sessionMemoryRefreshDelayMs ?? 0;
    this.now = options.now ?? (() => Date.now());
    this.formatDateKey =
      options.dateKey ??
      ((timestamp) => new Date(timestamp).toISOString().slice(0, 10));
    this.sessionMemoryRefreshWorker =
      this.threadSessionMemoryStore
        ? new DefaultSessionMemoryRefreshWorker({
            ...(options.sessionMemoryRefreshJobStore ? { jobStore: options.sessionMemoryRefreshJobStore } : {}),
            scheduleDelayMs: this.sessionMemoryRefreshDelayMs,
            refresh: async (job) => {
              await this.refreshSessionMemory(job.threadId, job.roleScratchpad);
            },
          })
        : undefined;
  }

  async onUserMessage(threadId: ThreadId): Promise<void> {
    await this.refreshThreadSummary(threadId);
    await this.updateMemoryFiles(threadId, "user");
  }

  async onRoleReply(threadId: ThreadId, roleId: RoleId): Promise<void> {
    const allMessages = await this.teamMessageStore.list(threadId);
    const messages = allMessages.slice(-this.threadMessageLimit);
    const summaries = messages.map(toMessageSummary);
    const previousSummary = await this.threadSummaryStore.get(threadId);
    const previousScratchpad = await this.roleScratchpadStore.get(threadId, roleId);
    const roleRelevantMessages = allMessages.filter((message) => message.roleId === roleId || message.role === "user");
    const roleMessages = roleRelevantMessages.slice(-this.roleMessageLimit).map(toMessageSummary);
    const nextSummary = shouldRefresh(
      previousSummary?.sourceMessageCount,
      allMessages.length,
      this.threadRefreshMinDelta
    )
      ? await this.contextCompressor.compressThread({
          threadId,
          messages: summaries,
          sourceMessageCount: allMessages.length,
          previousSummary,
        })
      : null;
    const nextScratchpad = shouldRefresh(
      previousScratchpad?.sourceMessageCount,
      roleRelevantMessages.length,
      this.roleRefreshMinDelta
    )
      ? await this.contextCompressor.compressRoleScratchpad({
          threadId,
          roleId,
          messages: roleMessages,
          sourceMessageCount: roleRelevantMessages.length,
          previousScratchpad,
        })
      : null;

    if (nextSummary) {
      await this.threadSummaryStore.put(nextSummary);
    }

    try {
      if (nextScratchpad) {
        await this.roleScratchpadStore.put(nextScratchpad);
      }
    } catch (error) {
      if (previousSummary && nextSummary) {
        await this.threadSummaryStore.put(previousSummary);
      }
      throw error;
    }

    await this.updateMemoryFiles(threadId, roleId, nextScratchpad ?? previousScratchpad ?? null);
  }

  async drain(): Promise<void> {
    await this.sessionMemoryRefreshWorker?.flush();
  }

  async flushBackgroundWork(): Promise<void> {
    await this.drain();
  }

  private async refreshThreadSummary(threadId: ThreadId): Promise<void> {
    const allMessages = await this.teamMessageStore.list(threadId);
    const messages = allMessages.slice(-this.threadMessageLimit);
    const previousSummary = await this.threadSummaryStore.get(threadId);
    if (!shouldRefresh(previousSummary?.sourceMessageCount, allMessages.length, this.threadRefreshMinDelta)) {
      return;
    }
    const nextSummary = await this.contextCompressor.compressThread({
      threadId,
      messages: messages.map(toMessageSummary),
      sourceMessageCount: allMessages.length,
      previousSummary,
    });
    await this.threadSummaryStore.put(nextSummary);
  }

  private async updateMemoryFiles(
    threadId: ThreadId,
    roleId: RoleId | "user",
    roleScratchpad?: {
      completedWork: string[];
      pendingWork: string[];
      waitingOn?: string;
    } | null
  ): Promise<void> {
    const recentMessages = await this.teamMessageStore.list(threadId, Math.max(this.roleMessageLimit, 8));
    const latestMessage =
      roleId === "user"
        ? [...recentMessages].reverse().find((message) => message.role === "user")
        : [...recentMessages].reverse().find((message) => message.roleId === roleId);
    if (!latestMessage) {
      return;
    }

    const journalStore = this.threadJournalStore;
    if (journalStore) {
      const dateKey = this.formatDateKey(this.now());
      const existing = await journalStore.get(threadId, dateKey);
      const entry = buildJournalEntry(latestMessage.name, latestMessage.content);
      const entries = compactJournalEntries(
        [...(existing?.entries ?? []), entry],
        this.journalEntryLimit,
        this.journalKeepRecent
      );
      await journalStore.put({
        threadId,
        dateKey,
        updatedAt: this.now(),
        entries,
      });
    }

    const memoryStore = this.threadMemoryStore;
    if (memoryStore) {
      const existingMemory = await memoryStore.get(threadId);
      const latestSummary = await this.threadSummaryStore.get(threadId);
      const persistentSummaryConstraints = selectPersistentSummaryConstraints(latestSummary?.stableFacts ?? []);
      const persistentSummaryNotes = selectPersistentSummaryNotes(latestSummary?.decisions ?? []);
      const persistentSummaryCarryForward = selectPersistentSummaryCarryForward(latestSummary?.openQuestions ?? []);
      const nextMemory = {
        threadId,
        updatedAt: this.now(),
        preferences: keepRecentUniqueStrings([
          ...(existingMemory?.preferences ?? []),
          ...extractPreferenceNotes(latestMessage.content),
        ], this.memoryListLimit),
        constraints: keepRecentUniqueStrings([
          ...(existingMemory?.constraints ?? []),
          ...persistentSummaryConstraints,
          ...extractConstraintNotes(latestMessage.content),
        ], this.memoryListLimit),
        longTermNotes: keepRecentUniqueStrings([
          ...(existingMemory?.longTermNotes ?? []),
          ...persistentSummaryNotes,
          ...persistentSummaryCarryForward,
          ...extractLongTermNotes(latestMessage.content),
        ], this.memoryListLimit),
      };

      if (
        nextMemory.preferences.length > 0 ||
        nextMemory.constraints.length > 0 ||
        nextMemory.longTermNotes.length > 0
      ) {
        await memoryStore.put(nextMemory);
      }
    }

    if (this.threadSessionMemoryStore && this.sessionMemoryRefreshWorker) {
      await this.sessionMemoryRefreshWorker.enqueue({
        threadId,
        ...(roleScratchpad !== undefined ? { roleScratchpad } : {}),
      });
      await this.recordSessionMemoryRefreshProgressSafely(threadId, "scheduled", roleScratchpad);
    }
  }

  private async refreshSessionMemory(
    threadId: ThreadId,
    roleScratchpad?: {
      completedWork: string[];
      pendingWork: string[];
      waitingOn?: string;
    } | null
  ): Promise<void> {
    if (!this.threadSessionMemoryStore) {
      return;
    }
    const [recentMessages, existingMemory, existingSessionMemory, latestSummary, journalRecords] = await Promise.all([
      this.teamMessageStore.list(threadId, Math.max(this.roleMessageLimit, 8)),
      this.threadMemoryStore?.get(threadId) ?? null,
      this.threadSessionMemoryStore.get(threadId),
      this.threadSummaryStore.get(threadId),
      this.threadJournalStore?.listByThread(threadId, 1) ?? [],
    ]);
    const latestMessage = recentMessages.at(-1);
    const persistentSummaryConstraints = selectPersistentSummaryConstraints(latestSummary?.stableFacts ?? []);
    const persistentSummaryCarryForward = selectPersistentSummaryCarryForward(latestSummary?.openQuestions ?? []);
    const preservedActiveTasks =
      roleScratchpad === undefined ? existingSessionMemory?.activeTasks ?? [] : [];
    const preservedContinuityNotes =
      roleScratchpad === undefined ? existingSessionMemory?.continuityNotes ?? [] : [];
    const sessionMemory: ThreadSessionMemoryRecord = {
      threadId,
      memoryVersion: (existingMemory ? 1 : 0) + (latestSummary?.summaryVersion ?? 0),
      sourceMessageCount: latestSummary?.sourceMessageCount ?? recentMessages.length,
      updatedAt: this.now(),
      activeTasks: keepRecentUniqueStrings(
        [
          ...preservedActiveTasks,
          ...(roleScratchpad?.pendingWork ?? []),
          ...(latestSummary?.openQuestions ?? []),
        ],
        this.memoryListLimit
      ),
      openQuestions: keepRecentUniqueStrings(latestSummary?.openQuestions ?? [], this.memoryListLimit),
      recentDecisions: keepRecentUniqueStrings(latestSummary?.decisions ?? [], this.memoryListLimit),
      constraints: keepRecentUniqueStrings(
        [...persistentSummaryConstraints, ...(existingMemory?.constraints ?? [])],
        this.memoryListLimit
      ),
      continuityNotes: keepRecentUniqueStrings(
        [
          ...preservedContinuityNotes,
          ...(roleScratchpad?.waitingOn ? [`Waiting on: ${roleScratchpad.waitingOn}`] : []),
          ...persistentSummaryCarryForward,
          ...(latestMessage?.content ? [buildContinuityNote(latestMessage.name, latestMessage.content)] : []),
        ],
        this.memoryListLimit
      ),
      latestJournalEntries: keepRecentUniqueStrings(
        journalRecords.flatMap((record) => record.entries.map((entry) => truncateTo(entry, 140))),
        this.journalKeepRecent
      ),
    };
    sessionMemory.sectionFingerprint = buildSessionMemoryFingerprint(sessionMemory);
    if (
      existingSessionMemory?.sectionFingerprint !== sessionMemory.sectionFingerprint
      || existingSessionMemory?.memoryVersion !== sessionMemory.memoryVersion
      || existingSessionMemory?.sourceMessageCount !== sessionMemory.sourceMessageCount
    ) {
      await this.threadSessionMemoryStore.put(sessionMemory);
      await this.recordSessionMemoryRefreshProgressSafely(threadId, "completed", roleScratchpad, sessionMemory);
    }
  }

  private async recordSessionMemoryRefreshProgressSafely(
    threadId: ThreadId,
    phase: "scheduled" | "completed",
    roleScratchpad?: {
      completedWork: string[];
      pendingWork: string[];
      waitingOn?: string;
    } | null,
    sessionMemory?: ThreadSessionMemoryRecord
  ): Promise<void> {
    try {
      await this.recordSessionMemoryRefreshProgress(threadId, phase, roleScratchpad, sessionMemory);
    } catch (error) {
      console.error("session memory refresh progress recording failed", { threadId, phase, error });
    }
  }

  private async recordSessionMemoryRefreshProgress(
    threadId: ThreadId,
    phase: "scheduled" | "completed",
    roleScratchpad?: {
      completedWork: string[];
      pendingWork: string[];
      waitingOn?: string;
    } | null,
    sessionMemory?: ThreadSessionMemoryRecord
  ): Promise<void> {
    if (!this.runtimeProgressRecorder) {
      return;
    }
    const now = this.now();
    await this.runtimeProgressRecorder.record({
      progressId: `progress:session-memory:${threadId}:${phase}:${now}`,
      threadId,
      subjectKind: "role_run",
      subjectId: `session-memory:${threadId}`,
      phase: phase === "scheduled" ? "heartbeat" : "completed",
      progressKind: "boundary",
      heartbeatSource: phase === "scheduled" ? "control_path" : "activity_echo",
      continuityState: phase === "scheduled" ? "alive" : "resolved",
      summary:
        phase === "scheduled"
          ? `Scheduled session memory refresh${roleScratchpad ? " from role scratchpad update" : ""}.`
          : `Session memory refreshed${sessionMemory ? ` with ${sessionMemory.activeTasks.length} active task(s)` : ""}.`,
      recordedAt: now,
      metadata: {
        boundaryKind: phase === "scheduled" ? "session_memory_refresh_scheduled" : "session_memory_refresh_completed",
        ...(roleScratchpad !== undefined ? { hasRoleScratchpad: roleScratchpad !== null } : {}),
        ...(sessionMemory
          ? {
              memoryVersion: sessionMemory.memoryVersion,
              sourceMessageCount: sessionMemory.sourceMessageCount,
              sectionFingerprint: sessionMemory.sectionFingerprint,
            }
          : {}),
      },
    });
  }
}

function buildSessionMemoryFingerprint(record: ThreadSessionMemoryRecord): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        activeTasks: record.activeTasks,
        openQuestions: record.openQuestions,
        recentDecisions: record.recentDecisions,
        constraints: record.constraints,
        continuityNotes: record.continuityNotes,
        latestJournalEntries: record.latestJournalEntries,
      })
    )
    .digest("hex");
}

function shouldRefresh(previousCount: number | undefined, nextCount: number, minDelta: number): boolean {
  if (previousCount == null) {
    return true;
  }

  return nextCount - previousCount >= minDelta;
}

function buildJournalEntry(name: string, content: string): string {
  return `[${name}] ${content.trim()}`;
}

function extractPreferenceNotes(content: string): string[] {
  const normalized = content.trim();
  if (!/\b(prefer|default to|avoid|do not use|don't use|always use)\b/i.test(normalized)) {
    return [];
  }
  return [normalized];
}

function extractConstraintNotes(content: string): string[] {
  const normalized = content.trim();
  if (!/\b(must|need to|budget|deadline|under \$|within|cannot|can't)\b/i.test(normalized)) {
    return [];
  }
  return [normalized];
}

function extractLongTermNotes(content: string): string[] {
  const normalized = content.trim();
  if (!/\b(remember|long-term|ongoing preference|keep in mind)\b/i.test(normalized)) {
    return [];
  }
  return [normalized];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function keepRecentUniqueStrings(values: string[], limit: number): string[] {
  if (limit <= 0) {
    return [];
  }

  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  const recentToOldest = [...normalized].reverse();
  const deduped: string[] = [];
  for (const value of recentToOldest) {
    if (!deduped.includes(value)) {
      deduped.push(value);
    }
    if (deduped.length >= limit) {
      break;
    }
  }
  return deduped.reverse();
}

function buildContinuityNote(name: string, content: string): string {
  return truncateTo(`[${name}] ${content.trim()}`, 220);
}

function truncateTo(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(maxChars - 1, 1))}…` : value;
}

function compactJournalEntries(entries: string[], maxEntries: number, keepRecent: number): string[] {
  if (maxEntries <= 0) {
    return [];
  }

  const normalized = uniqueStrings(entries);
  if (normalized.length <= maxEntries) {
    return normalized.slice(-maxEntries);
  }

  if (maxEntries === 1) {
    return [`[compacted] ${normalized.length} earlier entries summarized.`];
  }

  const safeKeepRecent = Math.max(1, Math.min(keepRecent, maxEntries - 1));
  const overflowCount = normalized.length - safeKeepRecent;
  const retainedRecent = normalized.slice(-safeKeepRecent);
  const compactedPreview = normalized
    .slice(Math.max(0, overflowCount - 2), overflowCount)
    .map((entry) => truncate(entry, 72))
    .join(" | ");

  return [
    `[compacted] ${overflowCount} earlier entries summarized${compactedPreview ? `: ${compactedPreview}` : "."}`,
    ...retainedRecent,
  ];
}

function selectPersistentSummaryConstraints(values: string[]): string[] {
  return values.filter((value) => /\b(must|need|constraint|budget|deadline|limit|required|cannot|can't|under )\b/i.test(value));
}

function selectPersistentSummaryNotes(values: string[]): string[] {
  return values.filter((value) => /\b(decided|choose|chosen|confirmed|plan to|will use|selected)\b/i.test(value));
}

function selectPersistentSummaryCarryForward(values: string[]): string[] {
  return values.filter(
    (value) => /\b(open question|need to|should)\b/i.test(value) || hasContinuationBacklogSignal(value)
  );
}

function truncate(content: string, maxChars = 160): string {
  return content.length > maxChars ? `${content.slice(0, maxChars - 1)}…` : content;
}

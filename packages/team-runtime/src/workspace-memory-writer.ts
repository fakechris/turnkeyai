import { createHash } from "node:crypto";

import type {
  DurableMemoryRecord,
  WorkspaceMemoryAuditRecord,
  WorkspaceMemoryMutation,
  WorkspaceMemorySourceEvent,
  WorkspaceMemoryStore,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

export type WorkspaceMemoryWriterTrigger =
  WorkspaceMemoryAuditRecord["trigger"];

export interface WorkspaceMemoryWriter {
  enqueue(input: {
    workspaceId: string;
    trigger: WorkspaceMemoryWriterTrigger;
    force?: boolean;
  }): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface WriterJob {
  workspaceId: string;
  trigger: WorkspaceMemoryWriterTrigger;
  force: boolean;
  attemptCount: number;
}

export class DefaultWorkspaceMemoryWriter implements WorkspaceMemoryWriter {
  private readonly store: WorkspaceMemoryStore;
  private readonly loadEvents: (input: {
    workspaceId: string;
    afterSequence: number;
    afterEventId?: string;
    limit: number;
  }) => Promise<WorkspaceMemorySourceEvent[]>;
  private readonly propose: (input: {
    workspaceId: string;
    events: WorkspaceMemorySourceEvent[];
    existing: DurableMemoryRecord[];
    now: number;
  }) => Promise<WorkspaceMemoryMutation[]>;
  private readonly now: () => number;
  private readonly minSourceDelta: number;
  private readonly maxSourceEvents: number;
  private readonly maxMutations: number;
  private readonly maxRetries: number;
  private readonly pollIntervalMs: number;
  private readonly idleDelayMs: number;
  private readonly mutex = new KeyedAsyncMutex<string>();
  private readonly jobs = new Map<string, WriterJob>();
  private readonly idleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: {
    store: WorkspaceMemoryStore;
    loadEvents: DefaultWorkspaceMemoryWriter["loadEvents"];
    propose?: DefaultWorkspaceMemoryWriter["propose"];
    now?: () => number;
    minSourceDelta?: number;
    maxSourceEvents?: number;
    maxMutations?: number;
    maxRetries?: number;
    pollIntervalMs?: number;
    idleDelayMs?: number;
  }) {
    this.store = options.store;
    this.loadEvents = options.loadEvents;
    this.propose =
      options.propose ??
      (async (input) => deterministicWorkspaceMemoryProposals(input));
    this.now = options.now ?? (() => Date.now());
    this.minSourceDelta = options.minSourceDelta ?? 10;
    this.maxSourceEvents = options.maxSourceEvents ?? 100;
    this.maxMutations = options.maxMutations ?? 20;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.idleDelayMs = options.idleDelayMs ?? 10 * 60_000;
  }

  async enqueue(input: {
    workspaceId: string;
    trigger: WorkspaceMemoryWriterTrigger;
    force?: boolean;
  }): Promise<void> {
    const current = this.jobs.get(input.workspaceId);
    this.jobs.set(input.workspaceId, {
      workspaceId: input.workspaceId,
      trigger: strongerTrigger(current?.trigger, input.trigger),
      force: Boolean(current?.force || input.force),
      // Preserve the retry count so a steady trigger stream cannot keep a
      // failing batch retrying forever without reaching the skip path.
      attemptCount: current?.attemptCount ?? 0,
    });
    if (input.trigger !== "idle") {
      this.scheduleIdle(input.workspaceId);
    }
    this.kick();
  }

  async flush(): Promise<void> {
    await this.drain(true);
  }

  async close(): Promise<void> {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    await this.flush();
    this.closed = true;
  }

  private kick(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.drain(false).catch((error) => {
        console.error("workspace memory writer drain failed", { error });
      });
    }, this.pollIntervalMs);
    this.scheduled.unref?.();
  }

  private scheduleIdle(workspaceId: string): void {
    const previous = this.idleTimers.get(workspaceId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.idleTimers.delete(workspaceId);
      void this.enqueue({
        workspaceId,
        trigger: "idle",
        force: true,
      });
    }, this.idleDelayMs);
    timer.unref?.();
    this.idleTimers.set(workspaceId, timer);
  }

  private async drain(force: boolean): Promise<void> {
    if (this.closed) return;
    if (this.drainPromise) {
      const active = this.drainPromise;
      await active;
      if (!force) return;
      return this.drain(true);
    }
    const running = this.performDrain(force);
    this.drainPromise = running;
    try {
      await running;
    } finally {
      if (this.drainPromise === running) this.drainPromise = null;
      if (!this.closed && this.jobs.size > 0) this.kick();
    }
  }

  private async performDrain(force: boolean): Promise<void> {
    do {
      const jobs = [...this.jobs.values()];
      this.jobs.clear();
      for (const job of jobs) {
        try {
          await this.process(job, force);
        } catch (error) {
          const attemptCount = job.attemptCount + 1;
          if (attemptCount <= this.maxRetries) {
            this.jobs.set(job.workspaceId, { ...job, attemptCount });
          } else {
            console.error("workspace memory writer job failed", {
              workspaceId: job.workspaceId,
              trigger: job.trigger,
              error,
            });
          }
        }
      }
    } while (force && this.jobs.size > 0);
  }

  private async process(job: WriterJob, flush: boolean): Promise<void> {
    await this.mutex.run(job.workspaceId, async () => {
      const snapshot = await this.store.getSnapshot(job.workspaceId);
      const events = (
        await this.loadEvents({
          workspaceId: job.workspaceId,
          afterSequence: snapshot.cursor.lastSequence,
          ...(snapshot.cursor.lastEventId !== undefined
            ? { afterEventId: snapshot.cursor.lastEventId }
            : {}),
          limit: this.maxSourceEvents,
        })
      )
        .filter((event) =>
          event.workspaceId === job.workspaceId &&
          event.sequence > snapshot.cursor.lastSequence
        )
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, this.maxSourceEvents);
      if (
        events.length === 0 ||
        (!job.force && !flush && events.length < this.minSourceDelta)
      ) {
        return;
      }
      const startedAt = this.now();
      try {
        const proposed = await this.propose({
          workspaceId: job.workspaceId,
          events,
          existing: snapshot.records,
          now: startedAt,
        });
        // When proposals exceed the mutation budget, only advance the
        // cursor through events whose proposals were fully applied — the
        // remainder is re-proposed on the next drain instead of being
        // silently dropped.
        const bounded = boundProposalsToBudget(
          proposed,
          events,
          this.maxMutations,
        );
        if (bounded.deferredEventCount > 0) {
          console.warn("workspace memory writer deferring events over mutation budget", {
            workspaceId: job.workspaceId,
            deferredEvents: bounded.deferredEventCount,
            deferredMutations: bounded.deferredMutationCount,
          });
          this.jobs.set(job.workspaceId, { ...job, attemptCount: 0 });
        }
        const last = bounded.coveredEvents.at(-1)!;
        await this.store.commit({
          workspaceId: job.workspaceId,
          expectedLastSequence: snapshot.cursor.lastSequence,
          cursor: {
            workspaceId: job.workspaceId,
            lastSequence: last.sequence,
            lastEventId: last.eventId,
            updatedAt: this.now(),
          },
          audit: {
            auditId: buildAuditId(job.workspaceId, bounded.coveredEvents, startedAt),
            workspaceId: job.workspaceId,
            trigger: job.trigger,
            sourceEventIds: bounded.coveredEvents.map((event) => event.eventId),
            mutations: bounded.mutations,
            rejectedMutations: [],
            beforeDigest: memoryDigest(snapshot.records),
            afterDigest: "",
            startedAt,
            completedAt: this.now(),
            status: bounded.mutations.length > 0 ? "written" : "noop",
          },
          mutations: bounded.mutations,
        });
      } catch (error) {
        const finalAttempt = job.attemptCount >= this.maxRetries;
        const lastEvent = events.at(-1)!;
        await recordFailedAuditSafely({
          store: this.store,
          workspaceId: job.workspaceId,
          expectedLastSequence: snapshot.cursor.lastSequence,
          // A batch that keeps failing after all retries would wedge this
          // workspace's memory pipeline forever; skip past it with an
          // auditable failure record instead.
          cursor: finalAttempt
            ? {
                workspaceId: job.workspaceId,
                lastSequence: lastEvent.sequence,
                lastEventId: lastEvent.eventId,
                updatedAt: this.now(),
              }
            : snapshot.cursor,
          trigger: job.trigger,
          events,
          records: snapshot.records,
          startedAt,
          completedAt: this.now(),
          error: finalAttempt
            ? new Error(
                `skipped batch after ${job.attemptCount + 1} attempts: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            : error,
        });
        if (finalAttempt) {
          console.error("workspace memory writer skipping poison batch", {
            workspaceId: job.workspaceId,
            trigger: job.trigger,
            skippedEvents: events.length,
            error,
          });
          return;
        }
        throw error;
      }
    });
  }
}

function mutationSourceRefs(mutation: WorkspaceMemoryMutation): string[] {
  return mutation.kind === "delete"
    ? mutation.sourceRefs
    : mutation.record.sourceRefs;
}

export function boundProposalsToBudget(
  proposed: WorkspaceMemoryMutation[],
  events: WorkspaceMemorySourceEvent[],
  maxMutations: number,
): {
  mutations: WorkspaceMemoryMutation[];
  coveredEvents: WorkspaceMemorySourceEvent[];
  deferredEventCount: number;
  deferredMutationCount: number;
} {
  if (proposed.length <= maxMutations) {
    return {
      mutations: proposed,
      coveredEvents: events,
      deferredEventCount: 0,
      deferredMutationCount: 0,
    };
  }
  const eventIndex = new Map(
    events.map((event, index) => [event.eventId, index]),
  );
  const withLastEventIndex = proposed.map((mutation) => {
    const indices = mutationSourceRefs(mutation)
      .map((ref) => eventIndex.get(ref))
      .filter((index): index is number => index !== undefined);
    return {
      mutation,
      lastEventIndex: indices.length > 0 ? Math.max(...indices) : -1,
    };
  });
  const baseCount = withLastEventIndex
    .filter((item) => item.lastEventIndex === -1).length;
  let cut = events.length;
  while (cut > 1) {
    const count =
      baseCount +
      withLastEventIndex
        .filter((item) => item.lastEventIndex >= 0 && item.lastEventIndex < cut)
        .length;
    if (count <= maxMutations) break;
    cut -= 1;
  }
  // At cut === 1 the first event alone may exceed the budget; apply its
  // proposals anyway (never stall the cursor on a single event).
  const mutations = withLastEventIndex
    .filter((item) => item.lastEventIndex < cut)
    .map((item) => item.mutation);
  return {
    mutations,
    coveredEvents: events.slice(0, cut),
    deferredEventCount: events.length - cut,
    deferredMutationCount: proposed.length - mutations.length,
  };
}

export function deterministicWorkspaceMemoryProposals(input: {
  workspaceId: string;
  events: WorkspaceMemorySourceEvent[];
  existing: DurableMemoryRecord[];
  now: number;
}): WorkspaceMemoryMutation[] {
  const mutations: WorkspaceMemoryMutation[] = [];
  const working = [...input.existing];
  for (const event of input.events) {
    for (const fact of extractDurableFacts(event.content)) {
      const supersedes = working
        .filter((record) =>
          record.scope.workspaceId === input.workspaceId &&
          record.invalidationKeys.includes(fact.invalidationKey)
        )
        .map((record) => record.memoryId);
      const record: DurableMemoryRecord = {
        memoryId: `memory:${stableDigest({
          workspaceId: input.workspaceId,
          eventId: event.eventId,
          content: fact.content,
        }).slice(0, 24)}`,
        plane: "workspace",
        scope: {
          workspaceId: input.workspaceId,
          threadId: event.threadId,
        },
        content: fact.content.slice(0, 500),
        sourceRefs: [...new Set([event.eventId, ...event.sourceRefs])],
        createdBy: event.authoritative ? "user" : "memory-writer",
        confidence: event.authoritative ? "authoritative" : "inferred",
        createdAt: input.now,
        lastConfirmedAt: event.occurredAt,
        supersedes,
        invalidationKeys: [fact.invalidationKey],
      };
      mutations.push(
        supersedes.length > 0
          ? { kind: "supersede", record, supersedes }
          : { kind: "add", record },
      );
      if (event.authoritative) {
        for (const memoryId of supersedes) {
          const index = working.findIndex(
            (candidate) => candidate.memoryId === memoryId,
          );
          if (index >= 0) working.splice(index, 1);
        }
        working.push(record);
      }
    }
  }
  return mutations;
}

function extractDurableFacts(
  content: string,
): Array<{ content: string; invalidationKey: string }> {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /(?:记住|偏好|必须|不要|约束|纠正|更正|决定|待办|remember|prefer|must|constraint|correction|decision|todo)/i
        .test(line)
    )
    .slice(0, 8)
    .map((line) => ({
      content: line,
      invalidationKey: inferInvalidationKey(line),
    }));
}

function inferInvalidationKey(content: string): string {
  if (/(?:输出格式|output\s+format)/i.test(content)) {
    return "output-format";
  }
  if (/(?:语言|language)/i.test(content)) {
    return "language";
  }
  if (/(?:预算|budget)/i.test(content)) {
    return "budget";
  }
  const normalized = content
    .toLowerCase()
    .replace(/\b(?:remember|prefer|must|constraint|correction|decision|todo)\b/g, "")
    .replace(/(?:记住|偏好|必须|不要|约束|纠正|更正|决定|待办)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-");
  return normalized || `fact:${stableDigest(content).slice(0, 12)}`;
}

function strongerTrigger(
  left: WorkspaceMemoryWriterTrigger | undefined,
  right: WorkspaceMemoryWriterTrigger,
): WorkspaceMemoryWriterTrigger {
  const order: WorkspaceMemoryWriterTrigger[] = [
    "turn-interval",
    "idle",
    "high-value-event",
    "pre-compaction",
    "mission-close",
    "manual",
  ];
  return order.indexOf(right) >= order.indexOf(left ?? "turn-interval")
    ? right
    : left!;
}

function buildAuditId(
  workspaceId: string,
  events: WorkspaceMemorySourceEvent[],
  startedAt: number,
): string {
  return `memory-audit:${stableDigest({
    workspaceId,
    eventIds: events.map((event) => event.eventId),
    startedAt,
  }).slice(0, 24)}`;
}

function memoryDigest(records: DurableMemoryRecord[]): string {
  return stableDigest(
    [...records]
      .sort((left, right) => left.memoryId.localeCompare(right.memoryId))
      .map((record) => ({
        memoryId: record.memoryId,
        content: record.content,
        sourceRefs: record.sourceRefs,
        confidence: record.confidence,
        invalidationKeys: record.invalidationKeys,
      })),
  );
}

async function recordFailedAuditSafely(input: {
  store: WorkspaceMemoryStore;
  workspaceId: string;
  expectedLastSequence: number;
  cursor: {
    workspaceId: string;
    lastSequence: number;
    lastEventId?: string;
    updatedAt: number;
  };
  trigger: WorkspaceMemoryWriterTrigger;
  events: WorkspaceMemorySourceEvent[];
  records: DurableMemoryRecord[];
  startedAt: number;
  completedAt: number;
  error: unknown;
}): Promise<void> {
  try {
    await input.store.commit({
      workspaceId: input.workspaceId,
      expectedLastSequence: input.expectedLastSequence,
      cursor: input.cursor,
      audit: {
        auditId: buildAuditId(
          input.workspaceId,
          input.events,
          input.startedAt,
        ),
        workspaceId: input.workspaceId,
        trigger: input.trigger,
        sourceEventIds: input.events.map((event) => event.eventId),
        mutations: [],
        rejectedMutations: [],
        beforeDigest: memoryDigest(input.records),
        afterDigest: memoryDigest(input.records),
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        status: "failed",
        error:
          input.error instanceof Error
            ? input.error.message
            : String(input.error),
      },
      mutations: [],
    });
  } catch {
    // The original failure remains authoritative.
  }
}

function stableDigest(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

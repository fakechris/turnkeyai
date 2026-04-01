import type { SessionMemoryRefreshJobRecord, SessionMemoryRefreshJobStore } from "@turnkeyai/core-types/team";

export interface SessionMemoryRefreshWorker {
  enqueue(input: {
    threadId: string;
    roleScratchpad?: {
      completedWork: string[];
      pendingWork: string[];
      waitingOn?: string;
    } | null;
  }): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface DefaultSessionMemoryRefreshWorkerOptions {
  jobStore?: SessionMemoryRefreshJobStore;
  refresh: (
    job: Pick<SessionMemoryRefreshJobRecord, "threadId" | "roleScratchpad">
  ) => Promise<void>;
  now?: () => number;
  scheduleDelayMs?: number;
  pollIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  backoffMultiplier?: number;
  maxRetryDelayMs?: number;
  onFailedJob?: (job: SessionMemoryRefreshJobRecord, error: unknown) => Promise<void> | void;
}

class InMemorySessionMemoryRefreshJobStore implements SessionMemoryRefreshJobStore {
  private readonly jobs = new Map<string, SessionMemoryRefreshJobRecord>();

  async get(threadId: string): Promise<SessionMemoryRefreshJobRecord | null> {
    return this.jobs.get(threadId) ?? null;
  }

  async put(record: SessionMemoryRefreshJobRecord): Promise<void> {
    this.jobs.set(record.threadId, record);
  }

  async delete(threadId: string): Promise<void> {
    this.jobs.delete(threadId);
  }

  async list(limit = 128): Promise<SessionMemoryRefreshJobRecord[]> {
    return [...this.jobs.values()]
      .sort((left, right) => {
        const dueDelta = left.notBeforeAt - right.notBeforeAt;
        if (dueDelta !== 0) {
          return dueDelta;
        }
        return left.enqueuedAt - right.enqueuedAt;
      })
      .slice(0, Math.max(limit, 1));
  }
}

export class DefaultSessionMemoryRefreshWorker implements SessionMemoryRefreshWorker {
  private readonly jobStore: SessionMemoryRefreshJobStore;
  private readonly refresh: DefaultSessionMemoryRefreshWorkerOptions["refresh"];
  private readonly now: () => number;
  private readonly scheduleDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxRetryDelayMs: number;
  private readonly onFailedJob: (job: SessionMemoryRefreshJobRecord, error: unknown) => Promise<void> | void;
  private draining = false;
  private closed = false;
  private scheduled: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DefaultSessionMemoryRefreshWorkerOptions) {
    this.jobStore = options.jobStore ?? new InMemorySessionMemoryRefreshJobStore();
    this.refresh = options.refresh;
    this.now = options.now ?? (() => Date.now());
    this.scheduleDelayMs = options.scheduleDelayMs ?? 10;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.backoffMultiplier = Math.max(options.backoffMultiplier ?? 2, 1);
    this.maxRetryDelayMs = Math.max(options.maxRetryDelayMs ?? 5_000, this.retryDelayMs);
    this.onFailedJob = options.onFailedJob ?? (() => {});
  }

  async enqueue(input: {
    threadId: string;
    roleScratchpad?: {
      completedWork: string[];
      pendingWork: string[];
      waitingOn?: string;
    } | null;
  }): Promise<void> {
    const existing = await this.jobStore.get(input.threadId);
    const now = this.now();
    await this.jobStore.put({
      threadId: input.threadId,
      enqueuedAt: now,
      notBeforeAt: now + this.scheduleDelayMs,
      // A fresh enqueue replaces the old retry budget rather than inheriting it.
      attemptCount: 0,
      ...(input.roleScratchpad !== undefined ? { roleScratchpad: input.roleScratchpad } : {}),
      ...(existing?.lastError ? { lastError: existing.lastError } : {}),
    });
    this.kick();
  }

  async flush(): Promise<void> {
    await this.drain(true);
  }

  async close(): Promise<void> {
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    await this.flush();
    this.closed = true;
  }

  private kick(): void {
    if (this.closed || this.scheduled) {
      return;
    }
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.drain(false).catch((error) => {
        console.error("session memory refresh worker drain failed", { error });
      });
    }, this.pollIntervalMs);
    this.scheduled.unref?.();
  }

  private async drain(force: boolean): Promise<void> {
    if (this.draining || this.closed) {
      return;
    }
    this.draining = true;
    try {
      while (true) {
        const jobs = (await this.jobStore.list(128)).filter((job) => force || job.notBeforeAt <= this.now());
        if (jobs.length === 0) {
          break;
        }
        for (const job of jobs) {
          await this.processJob(job);
        }
      }
    } finally {
      this.draining = false;
      if (!this.closed) {
        this.kick();
      }
    }
  }

  private async processJob(job: SessionMemoryRefreshJobRecord): Promise<void> {
    try {
      await this.refresh({
        threadId: job.threadId,
        ...(job.roleScratchpad !== undefined ? { roleScratchpad: job.roleScratchpad } : {}),
      });
      await this.jobStore.delete(job.threadId);
    } catch (error) {
      const attempt = job.attemptCount + 1;
      if (attempt > this.maxRetries) {
        await this.jobStore.delete(job.threadId);
        await this.onFailedJob(job, error);
        return;
      }
      await this.jobStore.put({
        ...job,
        attemptCount: attempt,
        notBeforeAt: this.now() + this.nextDelayMs(attempt),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private nextDelayMs(attempt: number): number {
    return Math.min(
      Math.round(this.retryDelayMs * this.backoffMultiplier ** Math.max(attempt - 1, 0)),
      this.maxRetryDelayMs
    );
  }
}

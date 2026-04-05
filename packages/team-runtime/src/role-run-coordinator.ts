import {
  buildRunKey,
  type RunKey,
  type RoleId,
  type RoleRunCoordinator,
  type RoleRunState,
  type RoleRunStatus,
  type RoleRunStore,
  type RuntimeError,
  type RuntimeLimits,
  type TaskId,
  type ThreadId,
  type HandoffEnvelope,
  type WorkerKind,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

interface DefaultRoleRunCoordinatorOptions {
  roleRunStore: RoleRunStore;
  runtimeLimits: Pick<RuntimeLimits, "memberMaxIterations" | "maxQueuedHandoffsPerRole">;
  now: () => number;
}

export class DefaultRoleRunCoordinator implements RoleRunCoordinator {
  private readonly roleRunStore: RoleRunStore;
  private readonly runtimeLimits: Pick<RuntimeLimits, "memberMaxIterations" | "maxQueuedHandoffsPerRole">;
  private readonly now: () => number;
  private readonly runMutex = new KeyedAsyncMutex<RunKey>();

  constructor(options: DefaultRoleRunCoordinatorOptions) {
    this.roleRunStore = options.roleRunStore;
    this.runtimeLimits = options.runtimeLimits;
    this.now = options.now;
  }

  async getOrCreate(threadId: ThreadId, roleId: RoleId): Promise<RoleRunState> {
    const runKey = buildRunKey(threadId, roleId);
    return this.withRunLock(runKey, async () => {
      const existing = await this.roleRunStore.get(runKey);
      if (existing) {
        return existing;
      }

      const created: RoleRunState = {
        runKey,
        threadId,
        roleId,
        mode: "group",
        status: "idle",
        iterationCount: 0,
        maxIterations: this.runtimeLimits.memberMaxIterations,
        inbox: [],
        lastActiveAt: this.now(),
      };

      await this.roleRunStore.put(created);
      return created;
    });
  }

  async enqueue(runKey: RunKey, handoff: HandoffEnvelope): Promise<RoleRunState> {
    return this.mutateRun(runKey, (current) => {
      if (current.inbox.length >= this.runtimeLimits.maxQueuedHandoffsPerRole) {
        throw new Error(`handoff inbox full for ${runKey}`);
      }

      return {
        ...current,
        inbox: [...current.inbox, handoff],
        status: current.status === "running" ? "running" : "queued",
        lastActiveAt: this.now(),
      };
    });
  }

  async dequeue(runKey: RunKey): Promise<HandoffEnvelope | null> {
    return this.withRunLock(runKey, async () => {
      const current = await this.requireRun(runKey);
      if (current.inbox.length === 0) {
        return null;
      }

      const [next, ...rest] = current.inbox;
      if (!next) {
        return null;
      }

      await this.roleRunStore.put({
        ...current,
        inbox: rest,
        lastActiveAt: this.now(),
      });

      return next;
    });
  }

  async ack(runKey: RunKey, taskId: TaskId): Promise<void> {
    await this.mutateRun(runKey, (current) => ({
      ...current,
      lastDequeuedTaskId: taskId,
      lastActiveAt: this.now(),
    }));
  }

  async setStatus(runKey: RunKey, status: RoleRunStatus): Promise<void> {
    await this.mutateRun(runKey, (current) => ({
      ...current,
      status,
      lastActiveAt: this.now(),
    }));
  }

  async bindWorkerSession(runKey: RunKey, workerType: WorkerKind, workerRunKey: RunKey): Promise<void> {
    await this.mutateRun(runKey, (current) => ({
      ...current,
      workerSessions: {
        ...(current.workerSessions ?? {}),
        [workerType]: workerRunKey,
      },
      lastActiveAt: this.now(),
    }));
  }

  async clearWorkerSession(runKey: RunKey, workerType: WorkerKind): Promise<void> {
    await this.mutateRun(runKey, (current) => {
      if (!current.workerSessions?.[workerType]) {
        return current;
      }

      const nextWorkerSessions = { ...(current.workerSessions ?? {}) };
      delete nextWorkerSessions[workerType];

      return {
        ...current,
        workerSessions: nextWorkerSessions,
        lastActiveAt: this.now(),
      };
    });
  }

  async incrementIteration(runKey: RunKey): Promise<number> {
    const next = await this.mutateRun(runKey, (current) => ({
      ...current,
      iterationCount: current.iterationCount + 1,
      lastActiveAt: this.now(),
    }));

    return next.iterationCount;
  }

  async fail(runKey: RunKey, error: RuntimeError): Promise<void> {
    await this.mutateRun(runKey, (current) => {
      const next: RoleRunState = {
        ...current,
        status: "failed",
        lastActiveAt: this.now(),
      };

      if (!error.retryable) {
        next.lastUserTouchAt = this.now();
      } else if (current.lastUserTouchAt != null) {
        next.lastUserTouchAt = current.lastUserTouchAt;
      }

      return next;
    });
  }

  async finish(runKey: RunKey): Promise<void> {
    await this.mutateRun(runKey, (current) => ({
      ...current,
      status: "done",
      lastActiveAt: this.now(),
    }));
  }

  private async requireRun(runKey: RunKey): Promise<RoleRunState> {
    const current = await this.roleRunStore.get(runKey);
    if (!current) {
      throw new Error(`role run not found: ${runKey}`);
    }
    return current;
  }

  private async mutateRun(runKey: RunKey, mutate: (current: RoleRunState) => RoleRunState): Promise<RoleRunState> {
    return this.withRunLock(runKey, async () => {
      const current = await this.requireRun(runKey);
      const next = mutate(current);
      await this.roleRunStore.put(next);
      return next;
    });
  }

  private async withRunLock<T>(runKey: RunKey, work: () => Promise<T>): Promise<T> {
    return this.runMutex.run(runKey, work);
  }
}

import path from "node:path";

import { normalizeScheduledTaskRecord, type ScheduledTaskRecord, type ScheduledTaskStore } from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileScheduledTaskStoreOptions {
  rootDir: string;
}

export class FileScheduledTaskStore implements ScheduledTaskStore {
  private readonly rootDir: string;
  private readonly taskMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileScheduledTaskStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(taskId: string): Promise<ScheduledTaskRecord | null> {
    return this.readNormalizedTask(taskId);
  }

  async put(task: ScheduledTaskRecord, options?: { expectedVersion?: number | undefined }): Promise<void> {
    await this.withTaskLock(task.taskId, async () => {
      const raw = await readJsonFile<ScheduledTaskRecord>(this.filePath(task.taskId));
      const current = raw ? normalizeScheduledTaskRecord(raw) : null;
      const existingVersion = current?.version ?? 0;
      if (options?.expectedVersion != null && existingVersion !== options.expectedVersion) {
        throw new Error(
          `scheduled task version conflict for ${task.taskId}: expected ${options.expectedVersion}, found ${existingVersion}`
        );
      }

      await writeJsonFileAtomic(
        this.filePath(task.taskId),
        normalizeScheduledTaskRecord({
          ...task,
          version: existingVersion + 1,
        })
      );
    });
  }

  async listByThread(threadId: string): Promise<ScheduledTaskRecord[]> {
    const tasks = await this.listAll();
    return tasks.filter((task) => task.threadId === threadId);
  }

  async listDue(now: number): Promise<ScheduledTaskRecord[]> {
    const tasks = await this.listAll();
    return tasks.filter((task) => task.schedule.nextRunAt <= now);
  }

  async claimDue(
    taskId: string,
    expectedUpdatedAt: number,
    leaseUntil: number,
    options?: { expectedVersion?: number | undefined }
  ): Promise<ScheduledTaskRecord | null> {
    return this.withTaskLock(taskId, async () => {
      const raw = await readJsonFile<ScheduledTaskRecord>(this.filePath(taskId));
      const current = raw ? normalizeScheduledTaskRecord(raw) : null;
      if (
        !current ||
        current.updatedAt !== expectedUpdatedAt ||
        (options?.expectedVersion != null && (current.version ?? 0) !== options.expectedVersion)
      ) {
        return null;
      }

      const claimedTask = normalizeScheduledTaskRecord({
        ...current,
        version: (current.version ?? 1) + 1,
        schedule: {
          ...current.schedule,
          nextRunAt: leaseUntil,
        },
        updatedAt: leaseUntil,
      });
      await writeJsonFileAtomic(this.filePath(taskId), claimedTask);
      return current;
    });
  }

  private async listAll(): Promise<ScheduledTaskRecord[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const taskIds = filePaths.map((filePath) => path.basename(filePath, ".json")).map((basename) => decodeURIComponent(basename));
    const tasks = await Promise.all(taskIds.map((taskId) => this.readNormalizedTask(taskId)));
    return tasks.filter((task): task is ScheduledTaskRecord => task !== null);
  }

  private filePath(taskId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(taskId)}.json`);
  }

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.taskMutex.run(taskId, fn);
  }

  private async readNormalizedTask(taskId: string): Promise<ScheduledTaskRecord | null> {
    const raw = await readJsonFile<ScheduledTaskRecord>(this.filePath(taskId));
    if (!raw) {
      return null;
    }

    const normalized = normalizeScheduledTaskRecord(raw);
    if (isSameScheduledTaskShape(raw, normalized)) {
      return normalized;
    }

    return this.withTaskLock(taskId, async () => {
      const current = await readJsonFile<ScheduledTaskRecord>(this.filePath(taskId));
      if (!current) {
        return null;
      }

      const migrated = normalizeScheduledTaskRecord(current);
      if (!isSameScheduledTaskShape(current, migrated)) {
        await writeJsonFileAtomic(this.filePath(taskId), migrated);
      }
      return migrated;
    });
  }
}

function isSameScheduledTaskShape(left: ScheduledTaskRecord, right: ScheduledTaskRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

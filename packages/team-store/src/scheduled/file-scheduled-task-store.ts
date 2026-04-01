import path from "node:path";

import type { ScheduledTaskRecord, ScheduledTaskStore } from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/core-types/async-mutex";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/core-types/file-store-utils";

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
    return readJsonFile<ScheduledTaskRecord>(this.filePath(taskId));
  }

  async put(task: ScheduledTaskRecord): Promise<void> {
    await this.withTaskLock(task.taskId, async () => {
      await writeJsonFileAtomic(this.filePath(task.taskId), task);
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

  async claimDue(taskId: string, expectedUpdatedAt: number, leaseUntil: number): Promise<ScheduledTaskRecord | null> {
    return this.withTaskLock(taskId, async () => {
      const current = await this.get(taskId);
      if (!current || current.updatedAt !== expectedUpdatedAt) {
        return null;
      }

      const claimedTask: ScheduledTaskRecord = {
        ...current,
        schedule: {
          ...current.schedule,
          nextRunAt: leaseUntil,
        },
        updatedAt: leaseUntil,
      };
      await writeJsonFileAtomic(this.filePath(taskId), claimedTask);
      return current;
    });
  }

  private async listAll(): Promise<ScheduledTaskRecord[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const tasks = await Promise.all(filePaths.map((filePath) => readJsonFile<ScheduledTaskRecord>(filePath)));
    return tasks.filter((task): task is ScheduledTaskRecord => task !== null);
  }

  private filePath(taskId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(taskId)}.json`);
  }

  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.taskMutex.run(taskId, fn);
  }
}

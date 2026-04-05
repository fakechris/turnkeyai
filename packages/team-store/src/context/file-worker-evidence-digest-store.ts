import type { WorkerEvidenceDigest, WorkerEvidenceDigestStore } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileWorkerEvidenceDigestStoreOptions {
  rootDir: string;
}

export class FileWorkerEvidenceDigestStore implements WorkerEvidenceDigestStore {
  private readonly rootDir: string;

  constructor(options: FileWorkerEvidenceDigestStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(workerRunKey: string): Promise<WorkerEvidenceDigest | null> {
    return readJsonFile<WorkerEvidenceDigest>(this.filePath(workerRunKey));
  }

  async put(record: WorkerEvidenceDigest): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.workerRunKey), record);
  }

  async listByThread(threadId: string): Promise<WorkerEvidenceDigest[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const results = await Promise.allSettled(filePaths.map((filePath) => readJsonFile<WorkerEvidenceDigest>(filePath)));
    return results
      .map((result) => (result.status === "fulfilled" ? result.value : null))
      .filter((record): record is WorkerEvidenceDigest => record !== null && record.threadId === threadId);
  }

  private filePath(workerRunKey: string): string {
    return `${this.rootDir}/${encodeURIComponent(workerRunKey)}.json`;
  }
}

import path from "node:path";

import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";
import type { ValidationOpsRunRecord, ValidationOpsRunStore } from "@turnkeyai/core-types/team";

interface FileValidationOpsRunStoreOptions {
  rootDir: string;
}

export class FileValidationOpsRunStore implements ValidationOpsRunStore {
  private readonly rootDir: string;

  constructor(options: FileValidationOpsRunStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async put(record: ValidationOpsRunRecord): Promise<void> {
    await writeJsonFileAtomic(this.filePath(record.runId), record);
  }

  async list(limit?: number): Promise<ValidationOpsRunRecord[]> {
    const filePaths = await listJsonFiles(this.rootDir);
    const records = await Promise.all(filePaths.map((filePath) => readJsonFile<ValidationOpsRunRecord>(filePath)));
    const sorted = records
      .filter((record): record is ValidationOpsRunRecord => record !== null)
      .sort((left, right) => right.completedAt - left.completedAt);
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  private filePath(runId: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(runId)}.json`);
  }
}

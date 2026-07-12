import path from "node:path";

import type {
  ExplicitWorkflowRecord,
  ExplicitWorkflowStore,
} from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import {
  listJsonFiles,
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

export class FileExplicitWorkflowStore implements ExplicitWorkflowStore {
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(private readonly options: { rootDir: string }) {}

  get(workflowId: string): Promise<ExplicitWorkflowRecord | null> {
    return readJsonFile(this.filePath(workflowId));
  }

  put(
    record: ExplicitWorkflowRecord,
    options: { expectedVersion: number },
  ): Promise<ExplicitWorkflowRecord | null> {
    return this.mutex.run(record.workflowId, async () => {
      assertRecordIdentity(record);
      const existing = await this.get(record.workflowId);
      const currentVersion = existing?.version ?? 0;
      if (currentVersion !== options.expectedVersion) return null;
      if (existing && !sameDefinition(existing, record)) {
        throw new Error(`explicit workflow definition is immutable: ${record.workflowId}`);
      }
      const stored: ExplicitWorkflowRecord = {
        ...structuredClone(record),
        version: currentVersion + 1,
      };
      await writeJsonFileAtomic(this.filePath(record.workflowId), stored);
      return structuredClone(stored);
    });
  }

  async list(): Promise<ExplicitWorkflowRecord[]> {
    const files = await listJsonFiles(this.options.rootDir);
    const records = await Promise.all(
      files.map((file) => readJsonFile<ExplicitWorkflowRecord>(file)),
    );
    return records
      .filter((record): record is ExplicitWorkflowRecord => record !== null)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.workflowId.localeCompare(right.workflowId),
      );
  }

  private filePath(workflowId: string): string {
    return path.join(this.options.rootDir, `${encodeURIComponent(workflowId)}.json`);
  }
}

function assertRecordIdentity(record: ExplicitWorkflowRecord): void {
  if (
    !record.workflowId ||
    record.definition.workflowId !== record.workflowId ||
    record.definition.ownerScopeId !== record.ownerScopeId
  ) {
    throw new Error("explicit workflow identity is inconsistent");
  }
  if (!Number.isInteger(record.version) || record.version < 0) {
    throw new Error("explicit workflow version is invalid");
  }
}

function sameDefinition(
  left: ExplicitWorkflowRecord,
  right: ExplicitWorkflowRecord,
): boolean {
  return JSON.stringify(left.definition) === JSON.stringify(right.definition);
}

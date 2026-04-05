import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { FlowLedger, FlowLedgerStore, FlowId, ThreadId } from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileFlowLedgerStoreOptions {
  rootDir: string;
}

export class FileFlowLedgerStore implements FlowLedgerStore {
  private readonly rootDir: string;
  private readonly flowMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileFlowLedgerStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(flowId: FlowId): Promise<FlowLedger | null> {
    return this.flowMutex.run(flowId, async () => {
      const flow = await readJsonFile<FlowLedger>(this.filePath(flowId));
      return flow ? normalizeFlowLedgerVersion(flow) : null;
    });
  }

  async put(flow: FlowLedger, options?: { expectedVersion?: number | undefined }): Promise<void> {
    await this.flowMutex.run(flow.flowId, async () => {
      const filePath = this.filePath(flow.flowId);
      const existing = await readJsonFile<FlowLedger>(filePath);
      const existingVersion = existing?.version ?? 0;
      if (options?.expectedVersion != null && existingVersion !== options.expectedVersion) {
        throw new Error(
          `flow version conflict for ${flow.flowId}: expected ${options.expectedVersion}, found ${existingVersion}`
        );
      }
      await writeJsonFileAtomic(filePath, normalizeFlowLedgerVersion({
        ...flow,
        version: existingVersion + 1,
      }));
    });
  }

  async listByThread(threadId: ThreadId): Promise<FlowLedger[]> {
    const all = await this.listAll();
    return all.filter((flow) => flow.threadId === threadId);
  }

  async listAll(): Promise<FlowLedger[]> {
    await mkdir(this.rootDir, { recursive: true });
    const filePaths = await listJsonFiles(this.rootDir);
    const flows = await Promise.all(filePaths.map((filePath) => readJsonFile<FlowLedger>(filePath)));

    return flows
      .filter((flow): flow is FlowLedger => flow !== null)
      .map((flow) => normalizeFlowLedgerVersion(flow));
  }

  private filePath(flowId: FlowId): string {
    return path.join(this.rootDir, `${flowId}.json`);
  }
}

function normalizeFlowLedgerVersion(flow: FlowLedger): FlowLedger {
  return {
    ...flow,
    version: flow.version && flow.version > 0 ? flow.version : 1,
  };
}

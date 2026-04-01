import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { FlowLedger, FlowLedgerStore, FlowId, ThreadId } from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, writeJsonFileAtomic } from "@turnkeyai/core-types/file-store-utils";

interface FileFlowLedgerStoreOptions {
  rootDir: string;
}

export class FileFlowLedgerStore implements FlowLedgerStore {
  private readonly rootDir: string;

  constructor(options: FileFlowLedgerStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(flowId: FlowId): Promise<FlowLedger | null> {
    return readJsonFile<FlowLedger>(this.filePath(flowId));
  }

  async put(flow: FlowLedger): Promise<void> {
    await writeJsonFileAtomic(this.filePath(flow.flowId), flow);
  }

  async listByThread(threadId: ThreadId): Promise<FlowLedger[]> {
    const all = await this.listAll();
    return all.filter((flow) => flow.threadId === threadId);
  }

  private async listAll(): Promise<FlowLedger[]> {
    await mkdir(this.rootDir, { recursive: true });
    const filePaths = await listJsonFiles(this.rootDir);
    const flows = await Promise.all(filePaths.map((filePath) => readJsonFile<FlowLedger>(filePath)));

    return flows.filter((flow): flow is FlowLedger => flow !== null);
  }

  private filePath(flowId: FlowId): string {
    return path.join(this.rootDir, `${flowId}.json`);
  }
}

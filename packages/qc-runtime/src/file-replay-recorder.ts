import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  listJsonFiles,
  readJsonFile,
  removeFileIfExists,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import type { BrowserTaskRequest, BrowserTaskResult, ReplayLayer, ReplayRecord, ReplayStore } from "@turnkeyai/core-types/team";

import type { VerificationReport } from "./browser-step-verifier";

interface BrowserReplayRecord extends ReplayRecord {
  metadata: {
    request: BrowserTaskRequest;
    result: BrowserTaskResult;
    quality: {
      stepReport: VerificationReport;
      resultReport: VerificationReport;
    };
  };
}

export class FileReplayRecorder implements ReplayStore {
  private readonly rootDir: string;
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(options: { rootDir: string }) {
    this.rootDir = options.rootDir;
  }

  async recordBrowser(input: {
    request: BrowserTaskRequest;
    result: BrowserTaskResult;
    stepReport: VerificationReport;
    resultReport: VerificationReport;
  }): Promise<string> {
    return this.record(
      buildBrowserReplayRecord({
        request: input.request,
        result: input.result,
        stepReport: input.stepReport,
        resultReport: input.resultReport,
      })
    );
  }

  async record(record: ReplayRecord): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    await this.mutex.run(record.replayId, async () => {
      const byIdPath = this.byIdFilePath(record.replayId);
      await writeJsonFileAtomic(byIdPath, record);
      try {
        await writeJsonFileAtomic(this.threadFilePath(record.threadId, record.replayId), record);
      } catch (error) {
        await removeFileIfExists(byIdPath);
        throw error;
      }
    });
    return record.replayId;
  }

  async get(replayId: string): Promise<ReplayRecord | null> {
    return (
      (await readJsonFile<ReplayRecord>(this.byIdFilePath(replayId))) ??
      (await readJsonFile<ReplayRecord>(this.legacyFlatFilePath(replayId)))
    );
  }

  async list(input?: { threadId?: string; layer?: ReplayLayer; limit?: number }): Promise<ReplayRecord[]> {
    const filePaths = await this.listCandidateFiles(input?.threadId);
    const limit = input?.limit && input.limit > 0 ? input.limit : null;
    const records = (await Promise.all(filePaths.map((filePath) => readJsonFile<ReplayRecord>(filePath))))
      .filter((record): record is ReplayRecord => record !== null)
      .filter((record) => (input?.threadId ? record.threadId === input.threadId : true))
      .filter((record) => (input?.layer ? record.layer === input.layer : true))
      .sort((left, right) => left.recordedAt - right.recordedAt);
    return limit ? records.slice(-limit) : records;
  }

  private async listCandidateFiles(threadId?: string): Promise<string[]> {
    if (threadId) {
      const threadFiles = await listJsonFiles(this.threadDir(threadId));
      if (threadFiles.length > 0) {
        return threadFiles;
      }
      return listJsonFiles(this.rootDir);
    }

    const byIdFiles = await listJsonFiles(path.join(this.rootDir, "by-id"));
    if (byIdFiles.length > 0) {
      return byIdFiles;
    }
    return listJsonFiles(this.rootDir);
  }

  private byIdFilePath(replayId: string): string {
    return path.join(this.rootDir, "by-id", `${sanitizeReplayId(replayId)}.json`);
  }

  private threadDir(threadId: string): string {
    return path.join(this.rootDir, "threads", encodeURIComponent(threadId));
  }

  private threadFilePath(threadId: string, replayId: string): string {
    return path.join(this.threadDir(threadId), `${sanitizeReplayId(replayId)}.json`);
  }

  private legacyFlatFilePath(replayId: string): string {
    return path.join(this.rootDir, `${sanitizeReplayId(replayId)}.json`);
  }
}

function sanitizeReplayId(replayId: string): string {
  return replayId.replace(/[^a-z0-9._:-]+/gi, "_");
}

export function buildBrowserReplayRecord(input: {
  request: BrowserTaskRequest;
  result: BrowserTaskResult;
  stepReport: VerificationReport;
  resultReport: VerificationReport;
}): BrowserReplayRecord {
  return {
    replayId: `${input.request.taskId}:browser`,
    layer: "browser",
    status: input.result.trace.some((step) => step.status === "failed") ? "failed" : "completed",
    recordedAt: Date.now(),
    threadId: input.request.threadId,
    taskId: input.request.taskId,
    summary: input.result.page.title || input.result.page.finalUrl || input.request.instructions,
    metadata: {
      request: input.request,
      result: input.result,
      quality: {
        stepReport: input.stepReport,
        resultReport: input.resultReport,
      },
    },
  } satisfies BrowserReplayRecord;
}

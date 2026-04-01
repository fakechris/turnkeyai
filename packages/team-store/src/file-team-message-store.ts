import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import type { MessageId, TeamMessage, TeamMessageStore, ThreadId } from "@turnkeyai/core-types/team";
import { KeyedAsyncMutex } from "@turnkeyai/core-types/async-mutex";
import { readJsonFile, writeJsonFileAtomic } from "@turnkeyai/core-types/file-store-utils";

interface FileTeamMessageStoreOptions {
  rootDir: string;
}

export class FileTeamMessageStore implements TeamMessageStore {
  private readonly rootDir: string;
  private readonly threadMutex = new KeyedAsyncMutex<ThreadId>();

  constructor(options: FileTeamMessageStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async append(message: TeamMessage): Promise<void> {
    await this.withThreadLock(message.threadId, async () => {
      const messages = await this.readThreadMessages(message.threadId);
      messages.push(message);
      await this.writeThreadMessages(message.threadId, messages);
    });
  }

  async list(threadId: ThreadId, limit?: number): Promise<TeamMessage[]> {
    const messages = await this.readThreadMessages(threadId);
    if (limit == null) {
      return messages;
    }
    return messages.slice(-limit);
  }

  async get(messageId: MessageId): Promise<TeamMessage | null> {
    const threadIds = await this.listThreadIds();
    for (const threadId of threadIds) {
      const messages = await this.readThreadMessages(threadId);
      const message = messages.find((item) => item.id === messageId);
      if (message) {
        return message;
      }
    }
    return null;
  }

  private async listThreadIds(): Promise<ThreadId[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readFileList(this.rootDir);
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => decodeURIComponent(name.replace(/\.json$/, "")));
  }

  private filePath(threadId: ThreadId): string {
    return path.join(this.rootDir, `${encodeURIComponent(threadId)}.json`);
  }

  private async readThreadMessages(threadId: ThreadId): Promise<TeamMessage[]> {
    const filePath = this.filePath(threadId);
    return (await readJsonFile<TeamMessage[]>(filePath)) ?? [];
  }

  private async writeThreadMessages(threadId: ThreadId, messages: TeamMessage[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath(threadId), messages);
  }

  private async withThreadLock<T>(threadId: ThreadId, work: () => Promise<T>): Promise<T> {
    return this.threadMutex.run(threadId, work);
  }
}

async function readFileList(rootDir: string): Promise<string[]> {
  return readdir(rootDir);
}

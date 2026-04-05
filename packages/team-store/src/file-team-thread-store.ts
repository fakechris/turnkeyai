import { mkdir } from "node:fs/promises";
import path from "node:path";

import type {
  Clock,
  CreateTeamThreadInput,
  IdGenerator,
  TeamThread,
  TeamThreadStore,
  ThreadId,
  UpdateTeamThreadInput,
} from "@turnkeyai/core-types/team";
import { listJsonFiles, readJsonFile, removeFileIfExists, writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

interface FileTeamThreadStoreOptions {
  rootDir: string;
  idGenerator: Pick<IdGenerator, "teamId" | "threadId">;
  clock: Clock;
}

export class FileTeamThreadStore implements TeamThreadStore {
  private readonly rootDir: string;
  private readonly idGenerator: Pick<IdGenerator, "teamId" | "threadId">;
  private readonly clock: Clock;

  constructor(options: FileTeamThreadStoreOptions) {
    this.rootDir = options.rootDir;
    this.idGenerator = options.idGenerator;
    this.clock = options.clock;
  }

  async get(threadId: ThreadId): Promise<TeamThread | null> {
    return readJsonFile<TeamThread>(this.threadFilePath(threadId));
  }

  async list(): Promise<TeamThread[]> {
    await mkdir(this.rootDir, { recursive: true });
    const threadFiles = await listJsonFiles(this.rootDir);
    const threads = await Promise.all(threadFiles.map((filePath) => readJsonFile<TeamThread>(filePath)));

    return threads.filter((thread): thread is TeamThread => thread !== null);
  }

  async create(input: CreateTeamThreadInput): Promise<TeamThread> {
    const now = this.clock.now();
    const thread: TeamThread = {
      threadId: this.idGenerator.threadId(),
      teamId: this.idGenerator.teamId(),
      teamName: input.teamName,
      leadRoleId: input.leadRoleId,
      roles: [...input.roles],
      participantLinks: [...(input.participantLinks ?? [])],
      metadataVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    await writeJsonFileAtomic(this.threadFilePath(thread.threadId), thread);
    return thread;
  }

  async update(threadId: ThreadId, patch: UpdateTeamThreadInput): Promise<TeamThread> {
    const current = await this.get(threadId);
    if (!current) {
      throw new Error(`team thread not found: ${threadId}`);
    }

    const next: TeamThread = {
      ...current,
      teamName: patch.teamName ?? current.teamName,
      roles: patch.roles ? [...patch.roles] : current.roles,
      participantLinks: patch.participantLinks ? [...patch.participantLinks] : current.participantLinks,
      metadataVersion: current.metadataVersion + 1,
      updatedAt: this.clock.now(),
    };

    await writeJsonFileAtomic(this.threadFilePath(threadId), next);
    return next;
  }

  async delete(threadId: ThreadId): Promise<void> {
    await removeFileIfExists(this.threadFilePath(threadId));
  }

  private threadFilePath(threadId: ThreadId): string {
    return path.join(this.rootDir, `${threadId}.json`);
  }
}

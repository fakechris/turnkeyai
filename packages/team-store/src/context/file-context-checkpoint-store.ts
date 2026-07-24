import path from "node:path";

import {
  CONTEXT_CHECKPOINT_PROTOCOL,
  type ContextCheckpointActivePointer,
  type ContextCheckpointRecord,
  type ContextCheckpointScope,
  type ContextCheckpointState,
  type ContextCheckpointStore,
} from "@turnkeyai/core-types/context-checkpoint";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";
import {
  listJsonFiles,
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

interface FileContextCheckpointStoreOptions {
  rootDir: string;
}

const STATE_ORDER: Record<ContextCheckpointState, number> = {
  prepared: 0,
  summarized: 1,
  persisted: 2,
  activated: 3,
};

export class FileContextCheckpointStore implements ContextCheckpointStore {
  private readonly rootDir: string;
  private readonly checkpointMutex = new KeyedAsyncMutex<string>();
  private readonly scopeMutex = new KeyedAsyncMutex<string>();

  constructor(options: FileContextCheckpointStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async get(checkpointId: string): Promise<ContextCheckpointRecord | null> {
    const record = await readJsonFile<ContextCheckpointRecord>(
      this.recordPath(checkpointId),
    );
    return isContextCheckpointRecord(record) ? record : null;
  }

  async put(record: ContextCheckpointRecord): Promise<void> {
    assertContextCheckpointRecord(record);
    await this.checkpointMutex.run(record.checkpointId, async () => {
      const existing = await this.get(record.checkpointId);
      if (existing) {
        assertSameIdentity(existing, record);
        if (STATE_ORDER[record.state] < STATE_ORDER[existing.state]) {
          throw new Error(
            `context checkpoint state cannot regress: ${existing.state} -> ${record.state}`,
          );
        }
      }
      await writeJsonFileAtomic(this.recordPath(record.checkpointId), record);
    });
  }

  async getActive(
    scope: ContextCheckpointScope,
  ): Promise<ContextCheckpointRecord | null> {
    const pointer = await readJsonFile<ContextCheckpointActivePointer>(
      this.activePointerPath(scope),
    );
    if (!isActivePointer(pointer) || !sameScope(pointer.scope, scope)) {
      return null;
    }
    const record = await this.get(pointer.checkpointId);
    if (
      !record ||
      record.state !== "activated" ||
      record.version !== pointer.version ||
      !sameScope(record.scope, scope)
    ) {
      return null;
    }
    return record;
  }

  async activate(input: {
    scope: ContextCheckpointScope;
    checkpointId: string;
    expectedActiveCheckpointId?: string | null;
    activatedAt: number;
  }): Promise<ContextCheckpointRecord> {
    const scopeKey = contextCheckpointScopeKey(input.scope);
    return this.scopeMutex.run(scopeKey, async () => {
      const record = await this.get(input.checkpointId);
      if (!record) {
        throw new Error(`context checkpoint not found: ${input.checkpointId}`);
      }
      if (!sameScope(record.scope, input.scope)) {
        throw new Error("context checkpoint scope mismatch");
      }
      if (STATE_ORDER[record.state] < STATE_ORDER.persisted) {
        throw new Error(
          `context checkpoint is not persisted: ${record.checkpointId}:${record.state}`,
        );
      }
      const active = await this.getActive(input.scope);
      if (
        input.expectedActiveCheckpointId !== undefined &&
        (active?.checkpointId ?? null) !== input.expectedActiveCheckpointId
      ) {
        throw new Error(
          `context checkpoint active pointer conflict: expected ${input.expectedActiveCheckpointId ?? "none"}, found ${active?.checkpointId ?? "none"}`,
        );
      }
      const activated: ContextCheckpointRecord = {
        ...record,
        state: "activated",
        updatedAt: Math.max(record.updatedAt, input.activatedAt),
      };
      await this.put(activated);
      const pointer: ContextCheckpointActivePointer = {
        protocol: CONTEXT_CHECKPOINT_PROTOCOL,
        scope: structuredClone(input.scope),
        checkpointId: activated.checkpointId,
        version: activated.version,
        activatedAt: input.activatedAt,
      };
      await writeJsonFileAtomic(
        this.activePointerPath(input.scope),
        pointer,
      );
      return activated;
    });
  }

  async listByScope(
    scope: ContextCheckpointScope,
    limit?: number,
  ): Promise<ContextCheckpointRecord[]> {
    const files = await listJsonFiles(this.recordsDir());
    const records = await Promise.all(
      files.map((file) => readJsonFile<ContextCheckpointRecord>(file)),
    );
    const matching = records
      .filter(isContextCheckpointRecord)
      .filter((record) => sameScope(record.scope, scope))
      .sort((left, right) => {
        if (left.version !== right.version) {
          return right.version - left.version;
        }
        return right.updatedAt - left.updatedAt;
      });
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? matching.slice(0, Math.floor(limit))
      : matching;
  }

  private recordsDir(): string {
    return path.join(this.rootDir, "records");
  }

  private recordPath(checkpointId: string): string {
    return path.join(
      this.recordsDir(),
      `${encodeURIComponent(checkpointId)}.json`,
    );
  }

  private activePointerPath(scope: ContextCheckpointScope): string {
    return path.join(
      this.rootDir,
      "active",
      `${encodeURIComponent(contextCheckpointScopeKey(scope))}.json`,
    );
  }
}

export function contextCheckpointScopeKey(
  scope: ContextCheckpointScope,
): string {
  return `${scope.threadId}\u0000${scope.roleId}\u0000${scope.flowId}`;
}

function assertContextCheckpointRecord(
  value: ContextCheckpointRecord,
): void {
  if (!isContextCheckpointRecord(value)) {
    throw new Error("invalid context checkpoint record");
  }
}

function isContextCheckpointRecord(
  value: unknown,
): value is ContextCheckpointRecord {
  if (!isRecord(value)) return false;
  return value["protocol"] === CONTEXT_CHECKPOINT_PROTOCOL &&
    typeof value["checkpointId"] === "string" &&
    Number.isInteger(value["version"]) &&
    Number(value["version"]) > 0 &&
    isContextCheckpointState(value["state"]) &&
    isScope(value["scope"]) &&
    Number.isInteger(value["compactedAtRound"]) &&
    Number(value["compactedAtRound"]) >= 0 &&
    isRecord(value["source"]) &&
    typeof value["source"]["transcriptDigest"] === "string" &&
    isRecord(value["task"]) &&
    typeof value["task"]["rootGoal"] === "string" &&
    isRecord(value["summary"]) &&
    typeof value["summary"]["narrative"] === "string" &&
    isRecord(value["workingSet"]) &&
    typeof value["createdAt"] === "number" &&
    typeof value["updatedAt"] === "number";
}

function isActivePointer(
  value: unknown,
): value is ContextCheckpointActivePointer {
  return isRecord(value) &&
    value["protocol"] === CONTEXT_CHECKPOINT_PROTOCOL &&
    isScope(value["scope"]) &&
    typeof value["checkpointId"] === "string" &&
    Number.isInteger(value["version"]) &&
    typeof value["activatedAt"] === "number";
}

function isScope(value: unknown): value is ContextCheckpointScope {
  return isRecord(value) &&
    typeof value["threadId"] === "string" &&
    typeof value["roleId"] === "string" &&
    typeof value["flowId"] === "string";
}

function isContextCheckpointState(
  value: unknown,
): value is ContextCheckpointState {
  return value === "prepared" ||
    value === "summarized" ||
    value === "persisted" ||
    value === "activated";
}

function assertSameIdentity(
  existing: ContextCheckpointRecord,
  next: ContextCheckpointRecord,
): void {
  if (
    existing.protocol !== next.protocol ||
    existing.version !== next.version ||
    existing.compactedAtRound !== next.compactedAtRound ||
    existing.createdAt !== next.createdAt ||
    !sameScope(existing.scope, next.scope) ||
    existing.source.transcriptDigest !== next.source.transcriptDigest
  ) {
    throw new Error(
      `context checkpoint identity changed: ${existing.checkpointId}`,
    );
  }
}

function sameScope(
  left: ContextCheckpointScope,
  right: ContextCheckpointScope,
): boolean {
  return left.threadId === right.threadId &&
    left.roleId === right.roleId &&
    left.flowId === right.flowId;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

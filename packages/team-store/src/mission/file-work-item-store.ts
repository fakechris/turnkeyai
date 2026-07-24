import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  MissionId,
  WorkItem,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

interface FileWorkItemStoreOptions {
  rootDir: string;
}

/**
 * Per-mission directory of work-item JSON files:
 *   <rootDir>/<missionId>/<workItemId>.json
 *
 * Stored per-mission rather than flat because the dashboard always
 * reads "all work items for mission X" — a per-mission folder makes
 * that a single listJsonFiles call instead of a full scan.
 */
export class FileWorkItemStore implements WorkItemStore {
  private readonly rootDir: string;
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(options: FileWorkItemStoreOptions) {
    this.rootDir = options.rootDir;
  }

  async listByMission(missionId: MissionId): Promise<WorkItem[]> {
    const graph = await readJsonFile<{ items: WorkItem[] }>(
      this.graphPath(missionId),
    );
    if (Array.isArray(graph?.items)) {
      return [...graph.items].sort((left, right) => left.n - right.n);
    }
    // Read-only: do NOT mkdir here (codex K2 #1). Any read-scope token
    // can hit /missions/:id/work-items; auto-creating the dir would let
    // a caller mint arbitrary mission-id folders just by polling. Walk
    // the dir directly so the shared listJsonFiles helper (which
    // auto-mkdirs) is bypassed for this read path.
    const dir = this.missionDir(missionId);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = entries
      .filter((entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "_graph.json"
      )
      .map((entry) => path.join(dir, entry.name));
    const all = await Promise.all(files.map((file) => readJsonFile<WorkItem>(file)));
    const items = all.filter((w): w is WorkItem => w !== null);
    items.sort((a, b) => a.n - b.n);
    return items;
  }

  async put(item: WorkItem): Promise<void> {
    await this.mutex.run(item.missionId, async () => {
      const current = await this.listByMission(item.missionId);
      const next = [
        ...current.filter((candidate) => candidate.id !== item.id),
        item,
      ];
      validateWorkItemGraph(item.missionId, next);
      await this.writeGraph(item.missionId, next);
    });
  }

  async putGraph(missionId: MissionId, items: WorkItem[]): Promise<void> {
    await this.mutex.run(missionId, async () => {
      validateWorkItemGraph(missionId, items);
      await this.writeGraph(missionId, items);
    });
  }

  private missionDir(missionId: MissionId): string {
    return path.join(this.rootDir, encodeURIComponent(missionId));
  }

  private graphPath(missionId: MissionId): string {
    return path.join(this.missionDir(missionId), "_graph.json");
  }

  private async writeGraph(
    missionId: MissionId,
    items: WorkItem[],
  ): Promise<void> {
    await writeJsonFileAtomic(this.graphPath(missionId), {
      missionId,
      version: 1,
      items: [...items].sort((left, right) => left.n - right.n),
    });
  }
}

export function validateWorkItemGraph(
  missionId: MissionId,
  items: WorkItem[],
): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) {
    throw new Error("duplicate work item id");
  }
  for (const item of items) {
    if (item.missionId !== missionId) {
      throw new Error("work item mission mismatch");
    }
    const specification = item.specification;
    if (!specification) continue;
    validateSpecification(item);
    for (const dependencyId of specification.blockedBy) {
      if (dependencyId === item.id) {
        throw new Error(`work item cannot depend on itself: ${item.id}`);
      }
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`work item dependency not found: ${dependencyId}`);
      }
      if (!dependency.specification?.blocks.includes(item.id)) {
        throw new Error(
          `work item dependency edge is not bidirectional: ${dependencyId} -> ${item.id}`,
        );
      }
    }
    for (const blockedId of specification.blocks) {
      const blocked = byId.get(blockedId);
      if (!blocked?.specification?.blockedBy.includes(item.id)) {
        throw new Error(
          `work item dependency edge is not bidirectional: ${item.id} -> ${blockedId}`,
        );
      }
    }
    if (
      (item.status === "working" || item.status === "done") &&
      specification.blockedBy.some(
        (dependencyId) => byId.get(dependencyId)?.status !== "done",
      )
    ) {
      throw new Error(`blocked work item cannot be ${item.status}: ${item.id}`);
    }
    if (item.status === "done") {
      validateCompletion(item);
    }
  }
  rejectCycles(items);
}

function validateCompletion(item: WorkItem): void {
  const specification = item.specification;
  if (!specification) return;
  for (const criterion of specification.acceptanceCriteria) {
    if (
      criterion.required &&
      criterion.state !== "passed" &&
      criterion.state !== "waived"
    ) {
      throw new Error(
        `required acceptance criterion is not satisfied: ${criterion.id}`,
      );
    }
  }
}

function validateSpecification(item: WorkItem): void {
  const specification = item.specification;
  if (!specification) return;
  if (!specification.objective.trim()) {
    throw new Error(`work item objective is required: ${item.id}`);
  }
  const criterionIds = new Set<string>();
  for (const criterion of specification.acceptanceCriteria) {
    if (!criterion.id.trim() || criterionIds.has(criterion.id)) {
      throw new Error(`duplicate or empty acceptance criterion id: ${criterion.id}`);
    }
    criterionIds.add(criterion.id);
    if (!criterion.description.trim()) {
      throw new Error(`acceptance criterion description is required: ${criterion.id}`);
    }
  }
  const receiptIds = new Set<string>();
  for (const receipt of specification.verificationReceipts) {
    if (!receipt.receiptId.trim() || receiptIds.has(receipt.receiptId)) {
      throw new Error(`duplicate or empty verification receipt id: ${receipt.receiptId}`);
    }
    receiptIds.add(receipt.receiptId);
    if (!criterionIds.has(receipt.criterionId)) {
      throw new Error(
        `verification receipt criterion not found: ${receipt.criterionId}`,
      );
    }
  }
  for (const criterion of specification.acceptanceCriteria) {
    if (criterion.state === "unverified") continue;
    const receipt = [...specification.verificationReceipts]
      .reverse()
      .find(
        (candidate) =>
          candidate.criterionId === criterion.id &&
          candidate.result === criterion.state,
      );
    if (!receipt) {
      throw new Error(
        `acceptance criterion lacks verification receipt: ${criterion.id}`,
      );
    }
    if (
      criterion.state === "waived" &&
      receipt.kind !== "operator-decision"
    ) {
      throw new Error(
        `waived criterion requires operator decision: ${criterion.id}`,
      );
    }
  }
}

function rejectCycles(items: WorkItem[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`work item dependency cycle: ${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of
      byId.get(id)?.specification?.blockedBy ?? []) {
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
}

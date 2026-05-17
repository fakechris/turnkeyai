import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestId,
  ApprovalRequestStore,
  MissionId,
} from "@turnkeyai/core-types/mission";
import {
  readJsonFile,
  writeJsonFileAtomic,
} from "@turnkeyai/shared-utils/file-store-utils";

interface FileApprovalRequestStoreOptions {
  rootDir: string;
}

/**
 * Flat directory of approval JSON files (one per approval id) +
 * sibling decisions/ directory keyed by approval id.
 *
 * Approvals are cross-mission (the global Approvals queue surfaces all
 * pending ones), so a flat layout is the right shape. Per-mission
 * filtering happens in listByMission via .missionId.
 *
 *   <rootDir>/<approvalId>.json
 *   <rootDir>/decisions/<approvalId>.json
 *
 * Decisions are append-once: a denied approval can't be re-approved
 * without filing a fresh request. K4 enforces this; K2 just reads.
 */
export class FileApprovalRequestStore implements ApprovalRequestStore {
  private readonly rootDir: string;
  private readonly decisionsDir: string;

  constructor(options: FileApprovalRequestStoreOptions) {
    this.rootDir = options.rootDir;
    this.decisionsDir = path.join(options.rootDir, "decisions");
  }

  async list(): Promise<ApprovalRequest[]> {
    // Read-only: do NOT mkdir on read path (codex K2 #1). Walk the
    // top-level rootDir directly with readdir (non-recursive, so the
    // decisions/ subdir isn't included).
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.rootDir, entry.name));
    const all = await Promise.all(files.map((file) => readJsonFile<ApprovalRequest>(file)));
    return all.filter((a): a is ApprovalRequest => a !== null);
  }

  async listByMission(missionId: MissionId): Promise<ApprovalRequest[]> {
    const all = await this.list();
    return all.filter((a) => a.missionId === missionId);
  }

  async put(approval: ApprovalRequest): Promise<void> {
    await writeJsonFileAtomic(this.approvalPath(approval.id), approval);
  }

  async getDecision(id: ApprovalRequestId): Promise<ApprovalDecision | null> {
    return readJsonFile<ApprovalDecision>(this.decisionPath(id));
  }

  /**
   * Record a decision. Used by K4 — exposed here so the K2 bootstrap
   * test can pre-populate.
   */
  async putDecision(decision: ApprovalDecision): Promise<void> {
    await writeJsonFileAtomic(this.decisionPath(decision.approvalId), decision);
  }

  private approvalPath(id: ApprovalRequestId): string {
    return path.join(this.rootDir, `${encodeURIComponent(id)}.json`);
  }

  private decisionPath(id: ApprovalRequestId): string {
    return path.join(this.decisionsDir, `${encodeURIComponent(id)}.json`);
  }
}

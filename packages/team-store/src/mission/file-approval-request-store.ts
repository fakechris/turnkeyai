import path from "node:path";

import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestId,
  ApprovalRequestStore,
  MissionId,
} from "@turnkeyai/core-types/mission";
import {
  listJsonFiles,
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
    // listJsonFiles returns every .json file at the top of rootDir but
    // also reaches into subdirs in some node versions. We filter by
    // path so the decisions/ subdir doesn't leak into the approvals
    // list. (The exact-match suffix check is portable across Node versions.)
    const files = await listJsonFiles(this.rootDir);
    const topLevel = files.filter((f) => path.dirname(f) === this.rootDir);
    const all = await Promise.all(topLevel.map((file) => readJsonFile<ApprovalRequest>(file)));
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

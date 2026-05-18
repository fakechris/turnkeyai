// Composes the Mission Control stores + the deps bag the
// handleMissionRoutes consumes. Kept out of foundations.ts because the
// mission data model is a self-contained K2 addition with no cyclic
// dependencies on the rest of the daemon foundations.

import path from "node:path";

import type { Clock } from "@turnkeyai/core-types/team";
import { FileActivityEventStore } from "@turnkeyai/team-store/mission/file-activity-event-store";
import { FileAgentRegistry } from "@turnkeyai/team-store/mission/file-agent-registry";
import { FileApprovalRequestStore } from "@turnkeyai/team-store/mission/file-approval-request-store";
import { FileArtifactStore } from "@turnkeyai/team-store/mission/file-artifact-store";
import { FileContextSourceRegistry } from "@turnkeyai/team-store/mission/file-context-source-registry";
import { FileMissionStore } from "@turnkeyai/team-store/mission/file-mission-store";
import { FileWorkItemStore } from "@turnkeyai/team-store/mission/file-work-item-store";

import type { MissionRouteDeps } from "../routes/mission-routes";

export interface MissionDepsInputs {
  dataDir: string;
  clock: Clock;
  /**
   * Stable id generator for missions. Optional in tests; production
   * pulls one from the daemon's main IdGenerator.
   */
  idGenerator?: { missionId(): string; shortId(): string };
}

/**
 * Returns the deps bag the mission route handler consumes. Each store
 * roots itself under `<dataDir>/mission/<name>/` so the on-disk layout
 * is self-contained — easy to back up, easy to nuke for a clean dev
 * reset.
 */
export function composeMissionDeps(inputs: MissionDepsInputs): MissionRouteDeps {
  const root = path.join(inputs.dataDir, "mission");
  return {
    missionStore: new FileMissionStore({ rootDir: path.join(root, "missions") }),
    workItemStore: new FileWorkItemStore({ rootDir: path.join(root, "work-items") }),
    activityStore: new FileActivityEventStore({ rootDir: path.join(root, "activity") }),
    approvalStore: new FileApprovalRequestStore({ rootDir: path.join(root, "approvals") }),
    artifactStore: new FileArtifactStore({ rootDir: path.join(root, "artifacts") }),
    agentRegistry: new FileAgentRegistry({ rootDir: path.join(root, "registry") }),
    contextSourceRegistry: new FileContextSourceRegistry({ rootDir: path.join(root, "registry") }),
    clock: inputs.clock,
    // Default id generator: stable counters scoped to this process.
    // Production injects the daemon's main IdGenerator so the IDs
    // share the daemon-wide monotonic sequence.
    idGenerator: inputs.idGenerator ?? createDefaultMissionIdGenerator(),
  };
}

function createDefaultMissionIdGenerator(): {
  missionId(): string;
  shortId(): string;
} {
  let seq = 0;
  return {
    missionId: () => `msn.${Date.now().toString(36)}.${++seq}`,
    shortId: () => `MSN-${seq.toString().padStart(4, "0")}`,
  };
}

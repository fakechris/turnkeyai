// Validate mission/work-item metadata on bridge calls (PR K3).
//
// Returns a structured rejection the route handler can convert into a
// JSON response. Kept separate from the recorder so the validator can
// be reused if other agent-facing routes (workflow, validation runs)
// adopt the same mission-binding pattern.
//
// Order of checks:
//   1. missionId present → must exist in MissionStore, else 404
//   2. workItemId present → must belong to the same mission, else 400
//   3. workItemId without missionId → 400 (can't validate scope)

import type {
  MissionId,
  MissionStore,
  WorkItemId,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";

export interface BridgeMissionValidatorDeps {
  missionStore: Pick<MissionStore, "get">;
  workItemStore: Pick<WorkItemStore, "listByMission">;
}

export interface ParsedBridgeMissionContext {
  missionId: MissionId | null;
  workItemId: WorkItemId | null;
}

export type BridgeMissionValidationResult =
  | { ok: true; missionId: MissionId | null; workItemId: WorkItemId | null }
  | { ok: false; statusCode: number; body: { error: string; code: string } };

export function parseBridgeMissionContext(input: {
  missionId?: unknown;
  workItemId?: unknown;
}): ParsedBridgeMissionContext {
  const missionId = nonEmptyString(input.missionId);
  const workItemId = nonEmptyString(input.workItemId);
  return { missionId, workItemId };
}

export async function validateBridgeMissionContext(input: {
  context: ParsedBridgeMissionContext;
  deps: BridgeMissionValidatorDeps;
}): Promise<BridgeMissionValidationResult> {
  const { missionId, workItemId } = input.context;

  if (workItemId && !missionId) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "workItemId requires missionId",
        code: "invalid_mission_context",
      },
    };
  }

  if (!missionId) {
    return { ok: true, missionId: null, workItemId: null };
  }

  const mission = await input.deps.missionStore.get(missionId);
  if (!mission) {
    return {
      ok: false,
      statusCode: 404,
      body: { error: "mission not found", code: "mission_not_found" },
    };
  }

  if (workItemId) {
    const items = await input.deps.workItemStore.listByMission(missionId);
    const owned = items.some((item) => item.id === workItemId);
    if (!owned) {
      return {
        ok: false,
        statusCode: 400,
        body: {
          error: "workItemId does not belong to mission",
          code: "work_item_mission_mismatch",
        },
      };
    }
  }

  return { ok: true, missionId, workItemId: workItemId ?? null };
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

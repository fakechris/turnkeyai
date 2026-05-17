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

/**
 * Tri-state per field:
 *   - { state: "absent" }  → caller omitted the field
 *   - { state: "blank" }   → caller supplied a value but it was empty /
 *                            whitespace-only (validation MUST reject; a
 *                            mission-bound call with a typo'd mission ID
 *                            silently disabling audit recording is the
 *                            failure mode codex flagged)
 *   - { state: "value" }   → trimmed non-empty string
 */
type FieldState =
  | { state: "absent" }
  | { state: "blank" }
  | { state: "value"; value: string };

export interface ParsedBridgeMissionContext {
  mission: FieldState;
  workItem: FieldState;
}

export type BridgeMissionValidationResult =
  | { ok: true; missionId: MissionId | null; workItemId: WorkItemId | null }
  | { ok: false; statusCode: number; body: { error: string; code: string } };

export function parseBridgeMissionContext(input: {
  missionId?: unknown;
  workItemId?: unknown;
}): ParsedBridgeMissionContext {
  return {
    mission: parseField(input.missionId),
    workItem: parseField(input.workItemId),
  };
}

export async function validateBridgeMissionContext(input: {
  context: ParsedBridgeMissionContext;
  deps: BridgeMissionValidatorDeps;
}): Promise<BridgeMissionValidationResult> {
  const { mission, workItem } = input.context;

  if (mission.state === "blank") {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "missionId must be a non-empty string",
        code: "invalid_mission_context",
      },
    };
  }
  if (workItem.state === "blank") {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "workItemId must be a non-empty string",
        code: "invalid_mission_context",
      },
    };
  }

  if (workItem.state === "value" && mission.state !== "value") {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "workItemId requires missionId",
        code: "invalid_mission_context",
      },
    };
  }

  if (mission.state !== "value") {
    return { ok: true, missionId: null, workItemId: null };
  }

  const missionId = mission.value;
  const missionRecord = await input.deps.missionStore.get(missionId);
  if (!missionRecord) {
    return {
      ok: false,
      statusCode: 404,
      body: { error: "mission not found", code: "mission_not_found" },
    };
  }

  if (workItem.state === "value") {
    // listByMission instead of get(id): WorkItemStore has no by-id
    // accessor today (gemini flagged the O(N) here). Per-mission work
    // item count is bounded by design (demo: 8). When K4 adds
    // mutations and the count grows, add WorkItemStore.get and switch.
    const items = await input.deps.workItemStore.listByMission(missionId);
    const owned = items.some((item) => item.id === workItem.value);
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

  return {
    ok: true,
    missionId,
    workItemId: workItem.state === "value" ? workItem.value : null,
  };
}

function parseField(value: unknown): FieldState {
  if (value === undefined || value === null) return { state: "absent" };
  if (typeof value !== "string") return { state: "blank" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { state: "blank" };
  return { state: "value", value: trimmed };
}

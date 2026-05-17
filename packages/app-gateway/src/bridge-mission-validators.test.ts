import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  Mission,
  MissionStore,
  WorkItem,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";

import {
  parseBridgeMissionContext,
  validateBridgeMissionContext,
} from "./bridge-mission-validators";

function memMissionStore(missions: Mission[]): Pick<MissionStore, "get"> {
  return {
    async get(id) {
      return missions.find((m) => m.id === id) ?? null;
    },
  };
}

function memWorkItemStore(items: WorkItem[]): Pick<WorkItemStore, "listByMission"> {
  return {
    async listByMission(missionId) {
      return items.filter((w) => w.missionId === missionId);
    },
  };
}

const fixtureMission: Mission = {
  id: "msn.1",
  shortId: "MSN-1",
  title: "t",
  desc: "",
  status: "working",
  mode: "research",
  modeLabel: "Research",
  owner: "you",
  ownerLabel: "You",
  createdAt: "today",
  createdAtMs: 0,
  agents: [],
  progress: 0,
  pendingApprovals: 0,
  blockers: 0,
  contextSummary: [],
};

const fixtureWorkItem: WorkItem = {
  id: "wi.1",
  missionId: "msn.1",
  n: 1,
  title: "t",
  agent: "agent.a",
  status: "working",
  started: "—",
  duration: "—",
  contextRefs: [],
  output: "—",
};

describe("parseBridgeMissionContext", () => {
  it("trims whitespace into value state", () => {
    assert.deepEqual(parseBridgeMissionContext({ missionId: "  msn.1  " }), {
      mission: { state: "value", value: "msn.1" },
      workItem: { state: "absent" },
    });
  });

  it("distinguishes absent from blank (key codex K3 finding)", () => {
    // The whole point of the tri-state: caller-omitted the field
    // (absent → no-op) MUST NOT collapse to "supplied a blank value"
    // (blank → 400). Otherwise a typo'd "   " silently disables audit.
    assert.deepEqual(parseBridgeMissionContext({}), {
      mission: { state: "absent" },
      workItem: { state: "absent" },
    });
    assert.deepEqual(parseBridgeMissionContext({ missionId: "   " }), {
      mission: { state: "blank" },
      workItem: { state: "absent" },
    });
    assert.deepEqual(parseBridgeMissionContext({ missionId: "" }), {
      mission: { state: "blank" },
      workItem: { state: "absent" },
    });
  });

  it("treats non-string values as blank (caller sent something but not a usable id)", () => {
    assert.deepEqual(parseBridgeMissionContext({ missionId: 42 }), {
      mission: { state: "blank" },
      workItem: { state: "absent" },
    });
  });
});

describe("validateBridgeMissionContext", () => {
  const deps = {
    missionStore: memMissionStore([fixtureMission]),
    workItemStore: memWorkItemStore([fixtureWorkItem]),
  };

  it("passes through when no metadata is supplied", async () => {
    const result = await validateBridgeMissionContext({
      context: { mission: { state: "absent" }, workItem: { state: "absent" } },
      deps,
    });
    assert.deepEqual(result, { ok: true, missionId: null, workItemId: null });
  });

  it("rejects blank missionId with 400 (codex K3 — must not silently disable audit)", async () => {
    const result = await validateBridgeMissionContext({
      context: { mission: { state: "blank" }, workItem: { state: "absent" } },
      deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.code, "invalid_mission_context");
    }
  });

  it("rejects blank workItemId with 400", async () => {
    const result = await validateBridgeMissionContext({
      context: {
        mission: { state: "value", value: "msn.1" },
        workItem: { state: "blank" },
      },
      deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.statusCode, 400);
  });

  it("rejects workItemId without missionId (can't validate scope)", async () => {
    const result = await validateBridgeMissionContext({
      context: {
        mission: { state: "absent" },
        workItem: { state: "value", value: "wi.1" },
      },
      deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.code, "invalid_mission_context");
    }
  });

  it("returns 404 when missionId does not exist", async () => {
    const result = await validateBridgeMissionContext({
      context: {
        mission: { state: "value", value: "msn.ghost" },
        workItem: { state: "absent" },
      },
      deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 404);
      assert.equal(result.body.code, "mission_not_found");
    }
  });

  it("returns 400 when workItemId does not belong to mission", async () => {
    const result = await validateBridgeMissionContext({
      context: {
        mission: { state: "value", value: "msn.1" },
        workItem: { state: "value", value: "wi.other" },
      },
      deps,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.code, "work_item_mission_mismatch");
    }
  });

  it("accepts a valid mission + work-item pair", async () => {
    const result = await validateBridgeMissionContext({
      context: {
        mission: { state: "value", value: "msn.1" },
        workItem: { state: "value", value: "wi.1" },
      },
      deps,
    });
    assert.deepEqual(result, { ok: true, missionId: "msn.1", workItemId: "wi.1" });
  });
});

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
  it("trims whitespace and rejects empty strings", () => {
    assert.deepEqual(
      parseBridgeMissionContext({ missionId: "  msn.1  ", workItemId: "" }),
      { missionId: "msn.1", workItemId: null }
    );
  });

  it("returns nulls for non-string input", () => {
    assert.deepEqual(parseBridgeMissionContext({ missionId: 42, workItemId: null }), {
      missionId: null,
      workItemId: null,
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
      context: { missionId: null, workItemId: null },
      deps,
    });
    assert.deepEqual(result, { ok: true, missionId: null, workItemId: null });
  });

  it("rejects workItemId without missionId (can't validate scope)", async () => {
    const result = await validateBridgeMissionContext({
      context: { missionId: null, workItemId: "wi.1" },
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
      context: { missionId: "msn.ghost", workItemId: null },
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
      context: { missionId: "msn.1", workItemId: "wi.other" },
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
      context: { missionId: "msn.1", workItemId: "wi.1" },
      deps,
    });
    assert.deepEqual(result, { ok: true, missionId: "msn.1", workItemId: "wi.1" });
  });
});

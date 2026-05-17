import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ActivityEvent,
  ActivityEventStore,
  MissionId,
} from "@turnkeyai/core-types/mission";

import {
  browserSessionContextId,
  createBridgeMissionActivityRecorder,
} from "./bridge-mission-activity-recorder";

function memActivityStore(): ActivityEventStore & { events: ActivityEvent[] } {
  const events: ActivityEvent[] = [];
  return {
    events,
    async listByMission(missionId: MissionId) {
      return events.filter((e) => e.missionId === missionId);
    },
    async append(event: ActivityEvent) {
      events.push(event);
    },
  };
}

function alwaysFailingStore(): ActivityEventStore {
  return {
    async listByMission() {
      return [];
    },
    async append() {
      throw new Error("disk full");
    },
  };
}

const clock = { now: () => 1_700_000_000_000 };
let counter = 0;
const newEventId = () => `evt.${++counter}`;

describe("createBridgeMissionActivityRecorder", () => {
  it("recordSuccess appends a tool event with browser/bridge tags and session target", async () => {
    counter = 0;
    const store = memActivityStore();
    const recorder = createBridgeMissionActivityRecorder({
      activityStore: store,
      newEventId,
      clock,
    });
    const result = await recorder.recordSuccess({
      context: { missionId: "msn.1" },
      replayed: false,
      tool: "snapshot",
      sessionId: "sess_a",
      transportLabel: "direct-cdp",
    });
    assert.equal(result.kind, "appended");
    assert.equal(store.events.length, 1);
    const event = store.events[0]!;
    assert.equal(event.missionId, "msn.1");
    assert.equal(event.kind, "tool");
    assert.equal(event.actor, "agent.browser");
    assert.equal(event.target, browserSessionContextId("sess_a"));
    assert.deepEqual(event.tags, ["browser", "bridge", "snapshot"]);
    assert.equal(event.runtime?.tool, "snapshot");
    assert.equal(event.runtime?.sessionId, "sess_a");
    assert.equal(event.runtime?.transport, "direct-cdp");
    assert.equal(event.tMs, clock.now());
  });

  it("recordFailure appends a recovery event with bucket runtime + danger emph", async () => {
    counter = 0;
    const store = memActivityStore();
    const recorder = createBridgeMissionActivityRecorder({
      activityStore: store,
      newEventId,
      clock,
    });
    const result = await recorder.recordFailure({
      context: { missionId: "msn.1", workItemId: "wi.1" },
      replayed: false,
      tool: "click",
      sessionId: "sess_b",
      bucket: "transport_unavailable",
      message: "relay peer disconnected",
    });
    assert.equal(result.kind, "appended");
    assert.equal(store.events.length, 1);
    const event = store.events[0]!;
    assert.equal(event.kind, "recovery");
    assert.equal(event.emph, "danger");
    assert.equal(event.text, "relay peer disconnected");
    assert.equal(event.runtime?.bucket, "transport_unavailable");
    assert.equal(event.runtime?.workItemId, "wi.1");
    // Tags include the bucket so the timeline filter can group failures
    // by transport/timeout/etc. without re-parsing runtime.
    assert.deepEqual(event.tags, ["browser", "bridge", "click", "transport_unavailable"]);
  });

  it("recordSuccess returns skipped without appending when context is null", async () => {
    const store = memActivityStore();
    const recorder = createBridgeMissionActivityRecorder({
      activityStore: store,
      newEventId,
      clock,
    });
    const result = await recorder.recordSuccess({
      context: null,
      replayed: false,
      tool: "snapshot",
      sessionId: "sess_a",
    });
    assert.equal(result.kind, "skipped");
    assert.equal(store.events.length, 0);
  });

  it("recordSuccess returns skipped without appending when replayed=true", async () => {
    // Crucial property: a retried POST with the same Idempotency-Key
    // must not double-write the timeline. The route always passes
    // replayed:false from inside the execute fn — replays short-circuit
    // before reaching the recorder — but we still defend the recorder
    // against a buggy caller.
    const store = memActivityStore();
    const recorder = createBridgeMissionActivityRecorder({
      activityStore: store,
      newEventId,
      clock,
    });
    const result = await recorder.recordSuccess({
      context: { missionId: "msn.1" },
      replayed: true,
      tool: "snapshot",
      sessionId: null,
    });
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") assert.equal(result.reason, "replayed");
    assert.equal(store.events.length, 0);
  });

  it("recordSuccess returns failed (with error) when the store throws", async () => {
    const recorder = createBridgeMissionActivityRecorder({
      activityStore: alwaysFailingStore(),
      newEventId,
      clock,
    });
    const result = await recorder.recordSuccess({
      context: { missionId: "msn.1" },
      replayed: false,
      tool: "snapshot",
      sessionId: "sess_a",
    });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.equal(result.error, "disk full");
  });
});

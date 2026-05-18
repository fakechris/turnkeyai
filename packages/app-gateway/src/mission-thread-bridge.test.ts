import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ActivityEvent,
  Mission,
} from "@turnkeyai/core-types/mission";
import type { TeamMessage } from "@turnkeyai/core-types/team";

import { createMissionThreadBridge } from "./mission-thread-bridge";

function memActivityStore() {
  const events: ActivityEvent[] = [];
  return {
    events,
    async listByMission(missionId: string): Promise<ActivityEvent[]> {
      return events.filter((e) => e.missionId === missionId);
    },
    async append(event: ActivityEvent): Promise<void> {
      events.push(event);
    },
  };
}

function memMissionStore(missions: Mission[]) {
  return {
    async list(): Promise<Mission[]> {
      return missions;
    },
    async get(id: string): Promise<Mission | null> {
      return missions.find((m) => m.id === id) ?? null;
    },
  };
}

function memTeamMessageStore(messages: TeamMessage[]) {
  return {
    async list(threadId: string, limit?: number): Promise<TeamMessage[]> {
      const out = messages.filter((m) => m.threadId === threadId);
      out.sort((a, b) => a.createdAt - b.createdAt);
      return typeof limit === "number" ? out.slice(0, limit) : out;
    },
  };
}

const baseMission: Mission = {
  id: "msn.1",
  shortId: "MSN-1",
  title: "t",
  desc: "",
  status: "working",
  mode: "custom",
  modeLabel: "Custom",
  owner: "you",
  ownerLabel: "You",
  createdAt: "today",
  createdAtMs: 0,
  agents: [],
  progress: 0,
  pendingApprovals: 0,
  blockers: 0,
  contextSummary: [],
  threadId: "thread-1",
};

const baseMessage = (id: string, role: TeamMessage["role"], createdAt = 0): TeamMessage => ({
  id,
  threadId: "thread-1",
  role,
  name: role,
  content: `${role} says ${id}`,
  createdAt,
  updatedAt: createdAt,
});

const clock = { now: () => 1_700_000_000_000 };
let counter = 0;
const newEventId = () => `evt.${++counter}`;

describe("MissionThreadBridge", () => {
  it("tickMission mirrors user/assistant/tool messages onto the activity log", async () => {
    counter = 0;
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("m1", "user", 100),
        baseMessage("m2", "assistant", 200),
        baseMessage("m3", "tool", 300),
        baseMessage("m4", "system", 400),
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });
    const appended = await bridge.tickMission("msn.1");
    // user → plan, assistant → thought, tool → tool. system is filtered.
    assert.equal(appended, 3);
    assert.deepEqual(
      activity.events.map((e) => e.kind),
      ["plan", "thought", "tool"]
    );
    // Source messageId is stamped on each event for dedupe.
    assert.deepEqual(
      activity.events.map((e) => e.runtime?.messageId),
      ["m1", "m2", "m3"]
    );
    // Authoritative ordering uses message.createdAt (tMs).
    assert.deepEqual(
      activity.events.map((e) => e.tMs),
      [100, 200, 300]
    );
  });

  it("is idempotent — a re-tick with the same messages appends nothing", async () => {
    counter = 0;
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("m1", "user", 100),
        baseMessage("m2", "assistant", 200),
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });
    assert.equal(await bridge.tickMission("msn.1"), 2);
    assert.equal(await bridge.tickMission("msn.1"), 0, "second tick must dedupe by messageId");
    assert.equal(activity.events.length, 2);
  });

  it("appends only new messages on incremental tick", async () => {
    counter = 0;
    const activity = memActivityStore();
    const messages = [baseMessage("m1", "user", 100)];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore(messages),
      activityStore: activity,
      newEventId,
      clock,
    });
    await bridge.tickMission("msn.1");
    messages.push(baseMessage("m2", "assistant", 200));
    const appended = await bridge.tickMission("msn.1");
    assert.equal(appended, 1);
    assert.equal(activity.events.length, 2);
    assert.equal(activity.events[1]!.runtime?.messageId, "m2");
  });

  it("skips missions without a threadId", async () => {
    const { threadId: _omitted, ...unlinked } = baseMission;
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([unlinked as Mission]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 100)]),
      activityStore: activity,
      newEventId,
      clock,
    });
    assert.equal(await bridge.tickMission("msn.1"), 0);
    assert.equal(activity.events.length, 0);
  });

  it("tickAll mirrors every linked mission and reports per-mission counts", async () => {
    counter = 0;
    const m2: Mission = { ...baseMission, id: "msn.2", threadId: "thread-2" };
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission, m2]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("a", "assistant", 100),
        { ...baseMessage("b", "tool", 200), threadId: "thread-2" },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });
    const result = await bridge.tickAll();
    assert.deepEqual(result, [
      { missionId: "msn.1", appended: 1 },
      { missionId: "msn.2", appended: 1 },
    ]);
  });

  it("uses roleId as actor when available, falls back to message name", async () => {
    counter = 0;
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([
        { ...baseMessage("m1", "assistant", 100), roleId: "role-lead", name: "Lead" },
        { ...baseMessage("m2", "tool", 200), name: "browser-snapshot" },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });
    await bridge.tickMission("msn.1");
    assert.equal(activity.events[0]!.actor, "role-lead");
    assert.equal(activity.events[1]!.actor, "browser-snapshot");
  });

  it("expands assistant tool-use trace into per-call timeline events (K3.5 §8)", async () => {
    // Real LLM path: the assistant turn that called sessions_spawn
    // and got a result back. `metadata.toolUse.rounds` is what
    // LLMRoleResponseGenerator persists; expandMessage should
    // surface each call + result as its own `kind: "tool"` event
    // BEFORE the final answer, so the timeline shows the actual
    // tool-use chain instead of a single black-box thought.
    counter = 0;
    const activity = memActivityStore();
    const finalAnswerMessage: TeamMessage = {
      ...baseMessage("a-final", "assistant", 5_000),
      roleId: "role-lead",
      name: "Lead",
      content: "The page title is Example Domain.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [
                {
                  id: "call_1",
                  name: "sessions_spawn",
                  input: { task: "Open https://example.com", agent_id: "browser" },
                },
              ],
              results: [
                {
                  toolCallId: "call_1",
                  toolName: "sessions_spawn",
                  isError: false,
                  contentBytes: 142,
                },
              ],
            },
          ],
        },
      },
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("u", "user", 1_000),
        finalAnswerMessage,
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });
    const appended = await bridge.tickMission("msn.1");
    assert.equal(appended, 4, "user plan + tool call + tool result + final thought");
    const ordered = [...activity.events].sort((a, b) => a.tMs - b.tMs);
    assert.deepEqual(
      ordered.map((e) => ({ kind: e.kind, phase: e.runtime?.toolPhase ?? null })),
      [
        { kind: "plan", phase: null },
        { kind: "tool", phase: "call" },
        { kind: "tool", phase: "result" },
        { kind: "thought", phase: null },
      ]
    );
    // The tool-call event shows the args summary.
    const callEvent = ordered[1]!;
    assert.match(callEvent.text, /sessions_spawn/);
    assert.match(callEvent.text, /task=/);
    // The result event shows byte count and links back to the call id.
    const resultEvent = ordered[2]!;
    assert.match(resultEvent.text, /sessions_spawn/);
    assert.match(resultEvent.text, /142 B|kB/);
    assert.equal(resultEvent.runtime?.toolCallId, "call_1");
    // Final answer carries the assistant content.
    assert.equal(ordered[3]!.text, "The page title is Example Domain.");
  });

  it("tool-use expansion is idempotent — re-ticking does not duplicate events", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "browser" } }],
              results: [
                { toolCallId: "c1", toolName: "sessions_spawn", isError: false, contentBytes: 10 },
              ],
            },
          ],
        },
      },
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([message]),
      activityStore: activity,
      newEventId,
      clock,
    });
    assert.equal(await bridge.tickMission("msn.1"), 3); // call + result + thought
    assert.equal(await bridge.tickMission("msn.1"), 0, "re-tick must dedupe on activitySourceId");
    assert.equal(activity.events.length, 3);
  });

  it("tool-result event picks up emph=danger when isError", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a", "assistant", 5_000),
      roleId: "role-lead",
      content: "Tool failed.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [{ id: "c1", name: "sessions_spawn", input: {} }],
              results: [
                { toolCallId: "c1", toolName: "sessions_spawn", isError: true, contentBytes: 50 },
              ],
            },
          ],
        },
      },
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([message]),
      activityStore: activity,
      newEventId,
      clock,
    });
    await bridge.tickMission("msn.1");
    const result = activity.events.find((e) => e.runtime?.toolPhase === "result");
    assert.ok(result, "expected a tool-result event");
    assert.equal(result?.emph, "danger");
    assert.match(result!.text, /failed/);
  });

  it("never throws on activity append failure — logs and continues", async () => {
    // The bridge ticks against many missions on a timer. One failing
    // mission must not halt mirroring of others (or future ticks).
    const failing = {
      events: [] as ActivityEvent[],
      async listByMission() {
        return [];
      },
      async append() {
        throw new Error("disk full");
      },
    };
    const warnings: string[] = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 100)]),
      activityStore: failing,
      newEventId,
      clock,
      logger: { warn: (m) => warnings.push(m) },
    });
    // tickMission returns 0 (nothing appended) but does not throw.
    assert.equal(await bridge.tickMission("msn.1"), 0);
    assert.ok(warnings.some((w) => w.includes("activity append failed")));
  });
});

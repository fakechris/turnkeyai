import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ActivityEvent,
  Mission,
} from "@turnkeyai/core-types/mission";
import type { RoleRunState, TeamMessage } from "@turnkeyai/core-types/team";

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
    async putRaw(mission: Mission): Promise<void> {
      const index = missions.findIndex((m) => m.id === mission.id);
      if (index >= 0) {
        missions[index] = mission;
      } else {
        missions.push(mission);
      }
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

function memRoleRunStore(runs: RoleRunState[]) {
  return {
    async listByThread(threadId: string): Promise<RoleRunState[]> {
      return runs.filter((run) => run.threadId === threadId);
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

  it("marks a working mission done after the lead final answer is mirrored", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      progress: 0.4,
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore,
      teamMessageStore: memTeamMessageStore([
        baseMessage("m1", "user", 100),
        {
          ...baseMessage("m2", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "Final report is ready.",
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
        },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });

    assert.equal(await bridge.tickMission("msn.1"), 2);
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "done");
    assert.equal(updated?.progress, 1);
  });

  it("blocks a mission when the lead final answer was truncated by max_tokens", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      progress: 0.8,
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore,
      roleRunStore: memRoleRunStore([
        {
          runKey: "role:role-lead:thread:thread-1",
          threadId: "thread-1",
          roleId: "role-lead",
          mode: "group",
          status: "idle",
          iterationCount: 1,
          maxIterations: 6,
          inbox: [],
          lastActiveAt: 200,
        },
      ]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("m1", "user", 100),
        {
          ...baseMessage("m2", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "Final report starts, but the provider stopped before the report completed",
          metadata: { stopReason: "max_tokens" },
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
        },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });

    assert.equal(await bridge.tickMission("msn.1"), 2);
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "blocked");
    assert.equal(updated?.progress, 0.8);
    assert.equal(updated?.blockers, 1);
    const incomplete = activity.events.find(
      (event) => event.runtime?.eventType === "mission.incomplete_final_answer"
    );
    assert.equal(incomplete?.kind, "recovery");
    assert.equal(incomplete?.runtime?.reason, "max_tokens");
    assert.equal(incomplete?.runtime?.stopReason, "max_tokens");
  });

  it("does not block a truncated lead final answer while a role run is still active", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      progress: 0.8,
    };
    const missionStore = memMissionStore([mission]);
    const bridge = createMissionThreadBridge({
      missionStore,
      roleRunStore: memRoleRunStore([
        {
          runKey: "role:role-lead:thread:thread-1",
          threadId: "thread-1",
          roleId: "role-lead",
          mode: "group",
          status: "running",
          iterationCount: 1,
          maxIterations: 6,
          inbox: [],
          lastActiveAt: 200,
        },
      ]),
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "Partial report",
          metadata: { stopReason: "length" },
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
        },
      ]),
      activityStore: memActivityStore(),
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "working");
    assert.equal(updated?.blockers, 0);
  });

  it("blocks a mission when the lead final answer looks structurally truncated", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore,
      roleRunStore: memRoleRunStore([
        {
          runKey: "role:role-lead:thread:thread-1",
          threadId: "thread-1",
          roleId: "role-lead",
          mode: "group",
          status: "idle",
          iterationCount: 1,
          maxIterations: 6,
          inbox: [],
          lastActiveAt: 200,
        },
      ]),
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "## Pricing\n\n| Platform | Pricing |\n|---|---|\n| Multica",
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
        },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "blocked");
    const incomplete = activity.events.find(
      (event) => event.runtime?.eventType === "mission.incomplete_final_answer"
    );
    assert.equal(incomplete?.runtime?.reason, "truncated_markdown");
  });

  it("does not complete missions that still have approvals or blockers", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      pendingApprovals: 1,
    };
    const missionStore = memMissionStore([mission]);
    const bridge = createMissionThreadBridge({
      missionStore,
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "Final report is ready after approval.",
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
        },
      ]),
      activityStore: memActivityStore(),
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "working");
    assert.equal(updated?.pendingApprovals, 1);
  });

  it("does not complete a lead handoff turn that mentions another role", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const missionStore = memMissionStore([mission]);
    const bridge = createMissionThreadBridge({
      missionStore,
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "Please investigate pricing next. @{role-analyst}",
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
        },
      ]),
      activityStore: memActivityStore(),
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "working");
  });

  it("marks a mission blocked when the latest lead tool turn is unresolved and no role run is active", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore,
      roleRunStore: memRoleRunStore([
        {
          runKey: "role:role-lead:thread:thread-1",
          threadId: "thread-1",
          roleId: "role-lead",
          mode: "group",
          status: "idle",
          iterationCount: 1,
          maxIterations: 6,
          inbox: [],
          lastActiveAt: 200,
        },
      ]),
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "",
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
          toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
          toolStatus: "pending",
        },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "blocked");
    assert.equal(updated?.blockers, 1);
    const stalled = activity.events.find((event) => event.runtime?.eventType === "mission.stalled_no_final_answer");
    assert.equal(stalled?.kind, "recovery");
    assert.equal(stalled?.runtime?.toolStatus, "pending");
  });

  it("does not block an unresolved tool turn while a role run is still active", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const missionStore = memMissionStore([mission]);
    const bridge = createMissionThreadBridge({
      missionStore,
      roleRunStore: memRoleRunStore([
        {
          runKey: "role:role-lead:thread:thread-1",
          threadId: "thread-1",
          roleId: "role-lead",
          mode: "group",
          status: "waiting_worker",
          iterationCount: 1,
          maxIterations: 6,
          inbox: [],
          lastActiveAt: 200,
        },
      ]),
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: "",
          source: {
            type: "worker",
            chatType: "group",
            route: "lead-role",
            speakerType: "Role",
            speakerName: "Lead",
          },
          toolCalls: [{ id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } }],
          toolStatus: "pending",
        },
      ]),
      activityStore: memActivityStore(),
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "working");
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
    // The tool-call event shows the args summary AND stashes the
    // full structured input on runtime.callInput so the UI can
    // expand to see the un-truncated JSON (K3.6).
    const callEvent = ordered[1]!;
    assert.match(callEvent.text, /sessions_spawn/);
    assert.match(callEvent.text, /task=/);
    assert.ok(callEvent.runtime?.callInput, "callInput JSON must be persisted");
    const parsedCallInput = JSON.parse(callEvent.runtime!.callInput!);
    assert.equal(parsedCallInput.task, "Open https://example.com");
    assert.equal(parsedCallInput.agent_id, "browser");
    // The result event shows byte count and links back to the call id.
    const resultEvent = ordered[2]!;
    assert.match(resultEvent.text, /sessions_spawn/);
    assert.match(resultEvent.text, /142 B|kB/);
    assert.equal(resultEvent.runtime?.toolCallId, "call_1");
    // Final answer carries the assistant content.
    assert.equal(ordered[3]!.text, "The page title is Example Domain.");
  });

  it("tool-result event carries full content on runtime.resultContent (K3.6)", async () => {
    counter = 0;
    const activity = memActivityStore();
    const fullResult = "Page title: Example Domain.\nFirst paragraph: This domain is for use in documentation examples...";
    const message: TeamMessage = {
      ...baseMessage("a", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore" } }],
              results: [
                {
                  toolCallId: "c1",
                  toolName: "sessions_spawn",
                  isError: false,
                  contentBytes: 105,
                  content: fullResult,
                },
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
    // Full content on runtime so the UI can expand it.
    assert.equal(result.runtime?.resultContent, fullResult);
    // Inline text includes a head slice (not just byte count).
    assert.match(result.text, /Page title: Example Domain/);
  });

  it("expands native assistant toolCalls/toolProgress without metadata trace", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-native", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      toolCalls: [
        {
          id: "c-native",
          name: "sessions_send",
          arguments: { session_key: "worker:browser:1", message: "continue" },
        },
      ],
      toolProgress: [
        {
          toolCallId: "c-native",
          toolName: "sessions_send",
          phase: "progress",
          summary: "Browser worker captured a snapshot.",
          detail: { eventType: "browser.snapshot", targetId: "target-1" },
          ts: 4_850,
        },
        {
          toolCallId: "c-native",
          toolName: "sessions_send",
          phase: "completed",
          summary: "Browser follow-up completed.",
          ts: 4_900,
        },
      ],
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([message]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const ordered = [...activity.events].sort((a, b) => a.tMs - b.tMs);
    assert.deepEqual(
      ordered.map((event) => ({ kind: event.kind, phase: event.runtime?.toolPhase ?? null })),
      [
        { kind: "tool", phase: "call" },
        { kind: "tool", phase: "progress" },
        { kind: "tool", phase: "result" },
        { kind: "thought", phase: null },
      ]
    );
    assert.match(ordered[0]!.text, /sessions_send/);
    assert.match(ordered[1]!.text, /captured a snapshot/);
    assert.equal(ordered[1]!.runtime?.progressDetail, '{"eventType":"browser.snapshot","targetId":"target-1"}');
    assert.match(ordered[2]!.text, /Browser follow-up completed/);
    assert.equal(ordered[2]!.runtime?.toolCallId, "c-native");
  });

  it("marks split native budget-skipped tool calls from progress admission", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-native-skipped-progress", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      metadata: { nativeToolUse: true },
      toolCalls: [
        {
          id: "c-skipped",
          name: "sessions_spawn",
          arguments: { agent_id: "browser", prompt: "open the dashboard" },
        },
      ],
      toolProgress: [
        {
          toolCallId: "c-skipped",
          toolName: "sessions_spawn",
          phase: "progress",
          summary: "Skipped sessions_spawn: per-turn tool call limit exceeded.",
          detail: {
            admission: "skipped",
            reason: "max_tool_calls_per_round",
            max_tool_calls_per_round: 2,
            requested_tool_calls: 20,
          },
          ts: 4_900,
        },
      ],
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([message]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const call = activity.events.find((event) => event.runtime?.toolPhase === "call");
    const progress = activity.events.find((event) => event.runtime?.toolPhase === "progress");
    const result = activity.events.find((event) => event.runtime?.toolPhase === "result");
    assert.equal(call?.runtime?.admission, "skipped");
    assert.equal(progress?.runtime?.admission, "skipped");
    assert.equal(result, undefined);
    assert.equal(progress?.emph, undefined);
  });

  it("does not expand native progress events with blank summaries", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-native-blank-progress", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      toolCalls: [
        {
          id: "c-native",
          name: "sessions_send",
          arguments: { session_key: "worker:browser:1", message: "continue" },
        },
      ],
      toolProgress: [
        {
          toolCallId: "c-native",
          toolName: "sessions_send",
          phase: "progress",
          summary: "   ",
          detail: { eventType: "browser.snapshot", targetId: "target-1" },
          ts: 4_850,
        },
        {
          toolCallId: "c-native",
          toolName: "sessions_send",
          phase: "completed",
          summary: "Browser follow-up completed.",
          ts: 4_900,
        },
      ],
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([message]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    assert.equal(activity.events.some((event) => event.runtime?.toolPhase === "progress"), false);
    assert.equal(activity.events.some((event) => event.runtime?.toolPhase === "call"), true);
    assert.equal(activity.events.some((event) => event.runtime?.toolPhase === "result"), true);
  });

  it("marks oversized progress detail as truncated without inline suffix", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-native-large-progress", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      toolCalls: [
        {
          id: "c-native",
          name: "sessions_send",
          arguments: { session_key: "worker:browser:1", message: "continue" },
        },
      ],
      toolProgress: [
        {
          toolCallId: "c-native",
          toolName: "sessions_send",
          phase: "progress",
          summary: "Browser worker captured a large snapshot.",
          detail: { html: "x".repeat(20 * 1024) },
          ts: 4_850,
        },
        {
          toolCallId: "c-native",
          toolName: "sessions_send",
          phase: "completed",
          summary: "Browser follow-up completed.",
          ts: 4_900,
        },
      ],
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([message]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const progress = activity.events.find((event) => event.runtime?.toolPhase === "progress");
    assert.ok(progress);
    assert.equal(progress.runtime?.progressTruncated, "true");
    assert.ok(progress.runtime?.progressDetail);
    assert.ok(Buffer.byteLength(progress.runtime.progressDetail, "utf8") <= 16 * 1024);
    assert.equal(progress.runtime.progressDetail.includes("…[truncated]"), false);
  });

  it("expands metadata tool progress into replayable timeline events", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-progress", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [{ id: "c1", name: "permission_query", input: { action: "browser.form.submit" } }],
              progress: [
                {
                  toolCallId: "c1",
                  toolName: "permission_query",
                  phase: "progress",
                  summary: "Permission requested for browser.form.submit.",
                  detail: { eventType: "permission.query", approval_id: "ap.1" },
                  ts: 4_900,
                },
              ],
              results: [
                {
                  toolCallId: "c1",
                  toolName: "permission_query",
                  isError: false,
                  contentBytes: 15,
                  content: '{"status":"pending"}',
                },
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

    const progress = activity.events.find((event) => event.runtime?.toolPhase === "progress");
    assert.ok(progress);
    assert.match(progress.text, /Permission requested/);
    assert.equal(progress.runtime?.toolName, "permission_query");
    assert.equal(progress.runtime?.progressPhase, "progress");
    assert.equal(progress.runtime?.progressDetail, '{"eventType":"permission.query","approval_id":"ap.1"}');
  });

  it("uses split role=tool result for native tool-use envelopes without duplicating assistant progress", async () => {
    counter = 0;
    const activity = memActivityStore();
    const assistantMessage: TeamMessage = {
      ...baseMessage("a-native", "assistant", 5_000),
      roleId: "role-lead",
      content: "",
      toolCalls: [
        {
          id: "c-native",
          name: "sessions_send",
          arguments: { session_key: "worker:browser:1", message: "continue" },
        },
      ],
      toolProgress: [
        {
          toolCallId: "c-native",
          toolName: "sessions_send",
          phase: "completed",
          summary: "Assistant-side progress summary.",
          ts: 4_900,
        },
      ],
      metadata: { nativeToolUse: true, toolRound: 1 },
    };
    const toolMessage: TeamMessage = {
      ...baseMessage("t-native", "tool", 5_001),
      name: "sessions_send",
      content: "Durable tool result content.",
      toolCallId: "c-native",
      toolStatus: "completed",
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([assistantMessage, toolMessage]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const resultEvents = activity.events.filter(
      (event) => event.runtime?.toolPhase === "result" && event.runtime.toolCallId === "c-native"
    );
    assert.equal(resultEvents.length, 1);
    assert.equal(resultEvents[0]?.runtime?.messageId, "t-native");
    assert.equal(resultEvents[0]?.runtime?.resultContent, "Durable tool result content.");
    assert.ok(
      activity.events.some((event) => event.runtime?.toolPhase === "call" && event.runtime.toolCallId === "c-native")
    );
  });

  it("tool-result with isError uses the error message as text (K3.6)", async () => {
    counter = 0;
    const activity = memActivityStore();
    const errorMessage = "No worker handler available for browser";
    const message: TeamMessage = {
      ...baseMessage("a", "assistant", 5_000),
      roleId: "role-lead",
      content: "Cannot complete.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "browser" } }],
              results: [
                {
                  toolCallId: "c1",
                  toolName: "sessions_spawn",
                  isError: true,
                  contentBytes: errorMessage.length,
                  content: errorMessage,
                },
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
    assert.ok(result);
    assert.equal(result.emph, "danger");
    // The actual reason appears inline, not just byte count.
    assert.match(result.text, /No worker handler available for browser/);
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

  it("tool-result event marks budget-skipped calls without danger emphasis", async () => {
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
              calls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore" } }],
              results: [
                {
                  toolCallId: "c1",
                  toolName: "sessions_spawn",
                  isError: true,
                  skipped: true,
                  contentBytes: 42,
                  content: "tool_call_limit_exceeded: skipped sessions_spawn",
                },
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
    const call = activity.events.find((e) => e.runtime?.toolPhase === "call");
    const result = activity.events.find((e) => e.runtime?.toolPhase === "result");
    assert.equal(call?.runtime?.admission, "skipped");
    assert.equal(result?.runtime?.admission, "skipped");
    assert.equal(result?.emph, undefined);
    assert.match(result!.text, /skipped by runtime budget/);
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

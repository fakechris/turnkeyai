import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ActivityEvent,
  Artifact,
  Mission,
} from "@turnkeyai/core-types/mission";
import type {
  BrowserArtifactRecord,
  RoleRunState,
  TeamMessage,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

import { createMissionThreadBridge } from "./mission-thread-bridge";

function memActivityStore(initialEvents: ActivityEvent[] = []) {
  const events: ActivityEvent[] = [...initialEvents];
  return {
    events,
    async listByMission(missionId: string): Promise<ActivityEvent[]> {
      return events.filter((e) => e.missionId === missionId);
    },
    async append(event: ActivityEvent): Promise<void> {
      events.push(event);
    },
    async replaceAll(missionId: string, nextEvents: ActivityEvent[]): Promise<void> {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.missionId === missionId) {
          events.splice(index, 1);
        }
      }
      events.push(...nextEvents);
    },
  };
}

function memArtifactStore(artifacts: Artifact[] = []) {
  return {
    artifacts,
    async listByMission(missionId: string): Promise<Artifact[]> {
      return artifacts.filter((artifact) => artifact.missionId === missionId);
    },
    async put(artifact: Artifact): Promise<void> {
      artifacts.push(artifact);
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

function memWorkerSessionStore(
  sessions: WorkerSessionRecord[],
  counters?: { list?: number; listByThread?: number }
) {
  return {
    async list(): Promise<WorkerSessionRecord[]> {
      if (counters) counters.list = (counters.list ?? 0) + 1;
      return sessions;
    },
    async listByThread(threadId: string): Promise<WorkerSessionRecord[]> {
      if (counters) counters.listByThread = (counters.listByThread ?? 0) + 1;
      return sessions.filter((session) => session.context?.threadId === threadId);
    },
  };
}

function backgroundWorkerSession(input: {
  workerRunKey: string;
  workerType?: WorkerSessionRecord["state"]["workerType"];
  status?: WorkerSessionRecord["state"]["status"];
  updatedAt: number;
  summary: string;
}): WorkerSessionRecord {
  const workerType = input.workerType ?? "explore";
  const status = input.status ?? "done";
  return {
    workerRunKey: input.workerRunKey,
    executionToken: 1,
    context: {
      threadId: "thread-1",
      flowId: "flow-background",
      taskId: `task-${workerType}`,
      roleId: "role-lead",
      parentSpanId: "span-background",
      toolCallId: `call-${workerType}`,
      label: `${workerType} source`,
      background: true,
      deadlineAt: 10_000,
    },
    state: {
      workerRunKey: input.workerRunKey,
      workerType,
      status,
      createdAt: 100,
      updatedAt: input.updatedAt,
      ...(status === "done"
        ? {
            lastResult: {
              workerType,
              status: "completed" as const,
              summary: input.summary,
              payload: { content: input.summary },
            },
          }
        : {}),
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

  it("registers browser worker artifacts on the mission artifact surface", async () => {
    counter = 0;
    const activity = memActivityStore();
    const artifacts = memArtifactStore();
    const browserArtifact: BrowserArtifactRecord = {
      artifactId: "artifact-browser-1",
      browserSessionId: "browser-session-1",
      targetId: "target-1",
      type: "screenshot",
      path: "/tmp/browser-artifacts/browser-session-1/final.png",
      createdAt: 1_700_000_000_123,
      sizeBytes: 12_345,
      lifecycle: {
        storageBackend: "file",
        refType: "local-path",
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        expiresAt: 1_700_604_800_123,
        maxArtifactBytes: 25 * 1024 * 1024,
        sessionBudgetBytes: 100 * 1024 * 1024,
        cleanupOnSessionClose: false,
        orphanReconciliation: "delete_expired",
      },
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 200),
          metadata: {
            workerPayload: {
              artifactIds: ["artifact-browser-1"],
            },
          },
        },
      ]),
      activityStore: activity,
      artifactStore: artifacts,
      browserArtifactStore: {
        async get(artifactId: string) {
          return artifactId === browserArtifact.artifactId ? browserArtifact : null;
        },
      },
      newEventId,
      clock,
    });

    assert.equal(await bridge.tickMission("msn.1"), 1);
    assert.equal(await bridge.tickMission("msn.1"), 0);
    assert.equal(artifacts.artifacts.length, 1);
    assert.deepEqual(artifacts.artifacts[0], {
      id: "artifact-browser-1",
      missionId: "msn.1",
      label: "final.png",
      kind: "screenshot",
      path: "/tmp/browser-artifacts/browser-session-1/final.png",
      sizeBytes: 12_345,
      createdAtMs: 1_700_000_000_123,
      lifecycle: {
        storageBackend: "file",
        refType: "local-path",
        retentionMs: 7 * 24 * 60 * 60 * 1000,
        expiresAtMs: 1_700_604_800_123,
        maxArtifactBytes: 25 * 1024 * 1024,
        sessionBudgetBytes: 100 * 1024 * 1024,
        cleanupOnSessionClose: false,
        orphanReconciliation: "delete_expired",
      },
    });
  });

  it("registers browser artifacts from split native tool result messages", async () => {
    counter = 0;
    const activity = memActivityStore();
    const artifacts = memArtifactStore();
    const browserArtifact: BrowserArtifactRecord = {
      artifactId: "artifact-browser-snapshot",
      browserSessionId: "browser-session-1",
      targetId: "target-1",
      type: "snapshot",
      path: "/tmp/browser-artifacts/browser-session-1/snapshot.json",
      createdAt: 1_700_000_000_456,
    };
    const assistant = {
      ...baseMessage("m1", "assistant", 200),
      content: "",
      metadata: { nativeToolUse: true },
      toolCalls: [
        {
          id: "call-1",
          name: "sessions_spawn",
          arguments: { agent_id: "browser", prompt: "inspect dashboard" },
        },
      ],
    } satisfies TeamMessage;
    const tool = {
      ...baseMessage("m2", "tool", 201),
      name: "sessions_spawn",
      toolCallId: "call-1",
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:browser:task:task-1",
        agent_id: "browser",
        status: "completed",
        tool_chain: ["browser"],
        result: "Browser captured snapshot evidence.",
        final_content: null,
        payload: {
          artifactIds: ["artifact-browser-snapshot"],
        },
      }),
    } satisfies TeamMessage;
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([assistant, tool]),
      activityStore: activity,
      artifactStore: artifacts,
      browserArtifactStore: {
        async get(artifactId: string) {
          return artifactId === browserArtifact.artifactId ? browserArtifact : null;
        },
      },
      newEventId,
      clock,
    });

    assert.equal(await bridge.tickMission("msn.1"), 2);
    assert.equal(artifacts.artifacts.length, 1);
    assert.equal(artifacts.artifacts[0]?.id, "artifact-browser-snapshot");
    assert.equal(artifacts.artifacts[0]?.kind, "snapshot");
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
        {
          ...baseMessage("m1", "user", 100),
          content: mission.desc,
        },
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

  it("records goal-slot coverage blockers for superficially final answers", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      desc: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
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
          content: [
            "结论：DeepSeek V4 Flash API 可能可通过多个 provider 访问。",
            "各 provider 具体输入/输出 token 价格：未验证。",
            "支持 search 功能的 provider 列表：未验证。",
          ].join("\n"),
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
    assert.equal(updated?.blockers, 1);
    const incomplete = activity.events.find(
      (event) => event.runtime?.eventType === "mission.incomplete_final_answer"
    );
    assert.equal(incomplete?.runtime?.reason, "goal_slots_unverified");

    await bridge.tickMission("msn.1");
    const duplicateRecoveryEvents = activity.events.filter(
      (event) =>
        event.runtime?.eventType === "mission.incomplete_final_answer" &&
        event.runtime?.messageId === "m2" &&
        event.runtime?.reason === "goal_slots_unverified"
    );
    assert.equal(duplicateRecoveryEvents.length, 1);
  });

  it("posts one continuation when goal-slot coverage blocks an incomplete final answer", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      desc: "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样",
      progress: 0.8,
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const followUps: Array<{ threadId: string; content: string }> = [];
    const messages: TeamMessage[] = [
      baseMessage("m1", "user", 100),
      {
        ...baseMessage("m2", "assistant", 200),
        roleId: "role-lead",
        name: "Lead",
        content: [
          "结论：DeepSeek V4 Flash API 可能可通过多个 provider 访问。",
          "各 provider 具体输入/输出 token 价格：未验证。",
          "支持 search 功能的 provider 列表：未验证。",
        ].join("\n"),
        source: {
          type: "worker",
          chatType: "group",
          route: "lead-role",
          speakerType: "Role",
          speakerName: "Lead",
        },
      },
    ];
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
      teamMessageStore: memTeamMessageStore(messages),
      activityStore: activity,
      newEventId,
      clock,
      async postIncompleteFinalFollowUp(input) {
        followUps.push({ threadId: input.threadId, content: input.content });
        messages.push({ ...baseMessage("m3", "user", 300), content: input.content });
      },
    });

    await bridge.tickMission("msn.1");
    await bridge.tickMission("msn.1");

    assert.equal(followUps.length, 1);
    assert.equal(followUps[0]?.threadId, "thread-1");
    assert.match(followUps[0]?.content ?? "", /Continue the original mission/);
    assert.match(followUps[0]?.content ?? "", /provider support.*search support.*pricing/s);
    assert.match(followUps[0]?.content ?? "", /Do not search for placeholder words/);
    assert.match(followUps[0]?.content ?? "", /Previous incomplete answer signals/);
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "working");
    assert.equal(updated?.blockers, 0);
  });

  it("builds incomplete-final follow-ups from the active user goal, not stale setup text", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      desc: [
        "Legacy setup text from a previous run.",
        "调研 deepseek v4 flash api，有哪些 provider 支持 search，价格怎么样。",
      ].join("\n"),
      progress: 0.8,
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const followUps: Array<{ threadId: string; content: string }> = [];
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
          ...baseMessage("m1", "user", 100),
          content:
            "Aurora-19 launch handoff: verify the owner, launch window, hard constraint, and risk from durable memory.",
        },
        {
          ...baseMessage("m2", "assistant", 200),
          roleId: "role-lead",
          name: "Lead",
          content: [
            "Owner: verified from durable memory.",
            "Launch window: verified from durable memory.",
            "Hard constraint: verified from durable memory.",
            "Risk: not verified.",
          ].join("\n"),
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
      async postIncompleteFinalFollowUp(input) {
        followUps.push({ threadId: input.threadId, content: input.content });
      },
    });

    await bridge.tickMission("msn.1");

    const content = followUps[0]?.content ?? "";
    assert.match(content, /risk or limitation/);
    const slotLine =
      content
        .split(/\r?\n/)
        .find((line) => line.includes("missing or unverified core slots")) ?? "";
    assert.doesNotMatch(slotLine, /provider support|search support|pricing/i);
    assert.match(content, /Do not introduce provider\/search\/model-support columns/);
  });

  it("does not inject provider search recovery slots into ordinary vendor comparisons", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      desc: [
        "A product lead is deciding between Vendor Alpha and Vendor Beta.",
        "Return a concise recommendation that compares pricing, strengths, risks, and the tradeoff that matters most.",
      ].join("\n"),
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const followUps: Array<{ threadId: string; content: string }> = [];
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
          content: [
            "Vendor Alpha costs $19 per seat.",
            "Vendor Beta pricing: 未验证。",
            "Risks: 未验证。",
          ].join("\n"),
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
      async postIncompleteFinalFollowUp(input) {
        followUps.push({ threadId: input.threadId, content: input.content });
      },
    });

    await bridge.tickMission("msn.1");

    const content = followUps[0]?.content ?? "";
    assert.match(content, /pricing.*risk or limitation/s);
    const slotLine =
      content
        .split(/\r?\n/)
        .find((line) => line.includes("missing or unverified core slots")) ?? "";
    assert.doesNotMatch(slotLine, /provider support|search\/web_search support|search support|model-support/i);
    assert.match(content, /Do not introduce provider\/search\/model-support columns/);
    assert.doesNotMatch(content, /Source\/provider labels/i);
  });

  it("does not echo unverified placeholder tables into incomplete-final recovery prompts", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      desc: "调研 DeepSeek V4 Flash API：provider、search/web_search 支持、价格和关键原文摘录。",
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const followUps: Array<{ threadId: string; content: string }> = [];
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
          content: [
            "## 调研结果：blocked / partial",
            "| Provider | 支持 | search | 价格 | 证据 URL |",
            "|---|---|---|---|---|",
            "| DeepSeek 官方 (api.deepseek.com) | 未验证 | 未验证 | 未验证 | https://api-docs.deepseek.com/ |",
            "| OpenRouter | 未验证 | 未验证 | 未验证 | https://openrouter.ai/models/deepseek-v4-flash |",
            "DuckDuckGo 搜索 \"未验证\" 结果（与目标研究无关）。",
          ].join("\n"),
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
      async postIncompleteFinalFollowUp(input) {
        followUps.push({ threadId: input.threadId, content: input.content });
      },
    });

    await bridge.tickMission("msn.1");

    const content = followUps[0]?.content ?? "";
    assert.match(content, /Previous incomplete answer signals/);
    assert.match(content, /URLs already mentioned: https:\/\/api-docs\.deepseek\.com\/, https:\/\/openrouter\.ai\/models\/deepseek-v4-flash/);
    assert.match(content, /Source labels already mentioned: DeepSeek 官方 \(api\.deepseek\.com\), OpenRouter/);
    assert.doesNotMatch(content, /Source\/provider labels/);
    assert.doesNotMatch(content, /DuckDuckGo 搜索 "未验证"/);
    assert.doesNotMatch(content, /\| Provider \| 支持 \| search \| 价格 \|/);
  });

  it("caps repeated incomplete-final automatic continuations per mission", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      desc: "调研 DeepSeek V4 Flash API：provider、search/web_search 支持、价格和关键原文摘录。",
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore();
    const followUps: Array<{ threadId: string; content: string }> = [];
    const messages: TeamMessage[] = [baseMessage("m1", "user", 100)];
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
      teamMessageStore: memTeamMessageStore(messages),
      activityStore: activity,
      newEventId,
      clock,
      async postIncompleteFinalFollowUp(input) {
        followUps.push({ threadId: input.threadId, content: input.content });
      },
    });
    const leadIncomplete = (id: string, createdAt: number): TeamMessage => ({
      ...baseMessage(id, "assistant", createdAt),
      roleId: "role-lead",
      name: "Lead",
      content: [
        "结论：DeepSeek V4 Flash API 可能可通过多个 provider 访问。",
        "provider 支持：未验证。",
        "search/web_search 支持：未验证。",
        "输入/输出价格：未验证。",
        "关键原文摘录：未验证。",
      ].join("\n"),
      source: {
        type: "worker",
        chatType: "group",
        route: "lead-role",
        speakerType: "Role",
        speakerName: "Lead",
      },
    });
    const reviveMission = async () => {
      const latest = await missionStore.get("msn.1");
      await missionStore.putRaw({
        ...latest!,
        status: "working",
        blockers: 0,
      });
    };

    messages.push(leadIncomplete("m2", 200));
    await bridge.tickMission("msn.1");
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.content ?? "", /Automatic recovery attempt 1 of 2/);

    await reviveMission();
    messages.push({ ...baseMessage("m3", "user", 300), content: followUps[0]!.content });
    messages.push(leadIncomplete("m4", 400));
    await bridge.tickMission("msn.1");
    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.content ?? "", /Automatic recovery attempt 2 of 2/);
    assert.match(followUps[1]?.content ?? "", /last automatic recovery attempt/);
    assert.match(followUps[1]?.content ?? "", /at most five additional tool calls total/);

    await reviveMission();
    messages.push({ ...baseMessage("m5", "user", 500), content: followUps[1]!.content });
    messages.push(leadIncomplete("m6", 600));
    await bridge.tickMission("msn.1");

    assert.equal(followUps.length, 2);
    const incompleteEvents = activity.events.filter(
      (event) =>
        event.runtime?.eventType === "mission.incomplete_final_answer" &&
        event.runtime?.reason === "goal_slots_unverified"
    );
    assert.equal(incompleteEvents.length, 3);
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "blocked");
    assert.equal(updated?.blockers, 1);
  });

  it("reopens a prematurely done mission when goal-slot coverage later fails", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      status: "done",
      progress: 1,
      desc: "调研 DeepSeek V4 Flash API：有哪些 provider 支持 search，价格怎么样。",
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
          content: [
            "**Status: blocked.** The research session timed out before any provider data was gathered.",
            "No pricing, model names, or search-support details could be verified.",
          ].join("\n"),
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
    assert.equal(updated?.blockers, 1);
    const incomplete = activity.events.find(
      (event) => event.runtime?.eventType === "mission.incomplete_final_answer"
    );
    assert.equal(incomplete?.runtime?.reason, "goal_slots_unverified");
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

  it("promotes missions with pending approvals to needs_approval instead of completing", async () => {
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
    assert.equal(updated?.status, "needs_approval");
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

  it("does not block an unresolved tool turn while a worker session is still active", async () => {
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
          status: "idle",
          iterationCount: 1,
          maxIterations: 6,
          inbox: [],
          lastActiveAt: 200,
        },
      ]),
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:browser:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-1",
          },
          state: {
            workerRunKey: "worker:browser:1",
            workerType: "browser",
            status: "running",
            createdAt: 100,
            updatedAt: 200,
          },
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

  it("marks a mission blocked when the linked worker paused as resumable", async () => {
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
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:browser:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-1",
          },
          state: {
            workerRunKey: "worker:browser:1",
            workerType: "browser",
            status: "resumable",
            createdAt: 100,
            updatedAt: 200,
          },
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
    assert.equal(stalled?.runtime?.toolStatus, "resumable");
    assert.deepEqual(stalled?.tags, ["mission_stalled", "resumable"]);
  });

  it("recovers a late completed worker after a prior session timeout and posts one continuation", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      status: "blocked",
      blockers: 1,
      progress: 0.95,
    };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore([
      {
        id: "existing-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_send",
        tags: ["thread", "tool-call", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send",
          callInput: JSON.stringify({ session_key: "worker:explore:1" }),
        },
      },
      {
        id: "existing-result",
        missionId: mission.id,
        tMs: 200,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_send failed: Sub-agent session timed out after 45s.",
        emph: "danger",
        tags: ["thread", "tool-result", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send",
          resultContent: "Sub-agent session timed out after 45s.",
        },
      },
    ]);
    const followUps: Array<{ threadId: string; content: string }> = [];
    const bridge = createMissionThreadBridge({
      missionStore,
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:explore:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-spawn",
            label: "provider search",
          },
          state: {
            workerRunKey: "worker:explore:1",
            workerType: "explore",
            status: "done",
            createdAt: 100,
            updatedAt: 300,
            lastResult: {
              workerType: "explore",
              status: "completed",
              summary: "Found provider evidence after timeout.",
              payload: { mode: "llm_sub_agent", content: "Found provider evidence after timeout." },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        followUps.push({ threadId: input.threadId, content: input.content });
      },
    });

    await bridge.tickMission("msn.1");
    await bridge.tickMission("msn.1");

    const recoveredEvents = activity.events.filter(
      (event) => event.runtime?.eventType === "mission.worker_late_completion"
    );
    assert.equal(recoveredEvents.length, 1);
    assert.match(recoveredEvents[0]!.text, /Found provider evidence after timeout/);
    assert.equal(followUps.length, 1);
    assert.equal(followUps[0]!.threadId, "thread-1");
    assert.match(followUps[0]!.content, /Continue the original mission/);
    const updated = await missionStore.get("msn.1");
    assert.equal(updated?.status, "working");
    assert.equal(updated?.blockers, 0);
    assert.equal(updated?.progress, 0.95);
  });

  it("delivers a completed background worker exactly once without a prior timeout", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      status: "working",
      progress: 0.8,
    };
    const activity = memActivityStore([
      {
        id: "background-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_spawn",
        tags: ["thread", "tool-call", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-background",
          callInput: JSON.stringify({
            agent_id: "explore",
            run_in_background: true,
          }),
        },
      },
      {
        id: "background-accepted",
        missionId: mission.id,
        tMs: 110,
        kind: "tool",
        actor: "Lead",
        text: "Background worker accepted",
        tags: ["thread", "tool-result", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-background",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.background_worker_session.v1",
            version: 1,
            status: "running",
            session_key: "worker:explore:background:1",
          }),
        },
      },
    ]);
    const followUps: Array<{ deliveryId?: string; content: string }> = [];
    let deliveryAttempts = 0;
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:explore:background:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-background",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-background",
            label: "source research",
            background: true,
            deadlineAt: 10_000,
          },
          state: {
            workerRunKey: "worker:explore:background:1",
            workerType: "explore",
            status: "done",
            createdAt: 100,
            updatedAt: 300,
            lastResult: {
              workerType: "explore",
              status: "completed",
              summary: "Background source evidence completed.",
              payload: { content: "Background source evidence completed." },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) {
          throw new Error("temporary ingress failure");
        }
        followUps.push({
          deliveryId: input.deliveryId,
          content: input.content,
        });
      },
      logger: { warn() {} },
    });

    await bridge.tickMission(mission.id);
    await bridge.tickMission(mission.id);

    const delivered = activity.events.filter(
      (event) => event.runtime?.eventType === "mission.worker_late_completion",
    );
    assert.equal(delivered.length, 1);
    assert.equal(deliveryAttempts, 2);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.deliveryId ?? "", /^worker-completion-batch:[a-f0-9]{24}$/);
    assert.match(followUps[0]?.content ?? "", /Background source evidence completed/);
  });

  it("fans in same-tick background completions and retries one stable batch after ingress failure", async () => {
    counter = 0;
    const mission: Mission = {
      ...baseMission,
      agents: ["role-lead"],
      status: "working",
      progress: 0.8,
    };
    const activity = memActivityStore([
      {
        id: "background-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_spawn",
        tags: ["thread", "tool-call", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-background",
        },
      },
    ]);
    const workerSessions: WorkerSessionRecord[] = [
      backgroundWorkerSession({
        workerRunKey: "worker:explore:background:alpha",
        updatedAt: 300,
        summary: "Alpha source evidence completed.",
      }),
      backgroundWorkerSession({
        workerRunKey: "worker:browser:background:beta",
        workerType: "browser",
        updatedAt: 310,
        summary: "Beta browser evidence completed.",
      }),
    ];
    const deliveryAttempts: Array<{
      deliveryId: string;
      workerRunKeys: string[];
      content: string;
    }> = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
      workerSessionStore: memWorkerSessionStore(workerSessions),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        deliveryAttempts.push({
          deliveryId: input.deliveryId,
          workerRunKeys: input.workerSessions.map((session) => session.workerRunKey),
          content: input.content,
        });
        if (deliveryAttempts.length === 1) {
          throw new Error("temporary batch ingress failure");
        }
      },
      logger: { warn() {} },
    });

    await bridge.tickMission(mission.id);
    assert.equal(
      activity.events.some((event) => event.runtime?.eventType === "mission.worker_late_completion"),
      false,
      "a failed batch ingress must not be marked delivered",
    );

    await bridge.tickMission(mission.id);
    await bridge.tickMission(mission.id);

    assert.equal(deliveryAttempts.length, 2);
    assert.equal(deliveryAttempts[0]?.deliveryId, deliveryAttempts[1]?.deliveryId);
    assert.deepEqual(deliveryAttempts[1]?.workerRunKeys, [
      "worker:browser:background:beta",
      "worker:explore:background:alpha",
    ]);
    assert.match(deliveryAttempts[1]?.content ?? "", /Alpha source evidence completed/);
    assert.match(deliveryAttempts[1]?.content ?? "", /Beta browser evidence completed/);
    const delivered = activity.events.filter(
      (event) => event.runtime?.eventType === "mission.worker_late_completion",
    );
    assert.equal(delivered.length, 1, "one durable batch marker must cover both workers");
    assert.deepEqual(JSON.parse(delivered[0]?.runtime?.workerRunKeys ?? "[]"), [
      "worker:browser:background:beta",
      "worker:explore:background:alpha",
    ]);
  });

  it("delivers a later background completion in a new batch without replaying prior workers", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"], progress: 0.8 };
    const activity = memActivityStore([
      {
        id: "background-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_spawn",
        tags: ["thread", "tool-call", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-background",
        },
      },
    ]);
    const workerSessions: WorkerSessionRecord[] = [
      backgroundWorkerSession({
        workerRunKey: "worker:explore:background:first",
        updatedAt: 300,
        summary: "First source completed.",
      }),
      backgroundWorkerSession({
        workerRunKey: "worker:browser:background:later",
        workerType: "browser",
        status: "running",
        updatedAt: 200,
        summary: "Later browser source completed.",
      }),
    ];
    const batches: string[][] = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
      workerSessionStore: memWorkerSessionStore(workerSessions),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        batches.push(input.workerSessions.map((session) => session.workerRunKey));
      },
    });

    await bridge.tickMission(mission.id);
    workerSessions[1] = backgroundWorkerSession({
      workerRunKey: "worker:browser:background:later",
      workerType: "browser",
      updatedAt: 400,
      summary: "Later browser source completed.",
    });
    await bridge.tickMission(mission.id);

    assert.deepEqual(batches, [
      ["worker:explore:background:first"],
      ["worker:browser:background:later"],
    ]);
  });

  it("does not repost late worker recovery when a successful follow-up discusses the earlier timeout", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"], progress: 0.95 };
    const missionStore = memMissionStore([mission]);
    const activity = memActivityStore([
      {
        id: "original-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_send",
        tags: ["thread", "tool-call", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send-original",
          callInput: JSON.stringify({ session_key: "worker:browser:1" }),
        },
      },
      {
        id: "original-timeout",
        missionId: mission.id,
        tMs: 200,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_send failed: Sub-agent session timed out.",
        emph: "danger",
        tags: ["thread", "tool-result", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send-original",
          resultContent: "Sub-agent session timed out.",
        },
      },
      {
        id: "late-recovery",
        missionId: mission.id,
        tMs: 300,
        kind: "recovery",
        actor: "system",
        text: "mission.worker_late_completion: Browser failure buckets: attach_failed=2.",
        tags: ["worker_late_completion", "browser"],
        runtime: {
          eventType: "mission.worker_late_completion",
          threadId: "thread-1",
          workerRunKey: "worker:browser:1",
          workerType: "browser",
          workerUpdatedAt: "300",
        },
      },
      {
        id: "follow-up-call",
        missionId: mission.id,
        tMs: 400,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_send",
        tags: ["thread", "tool-call", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send-follow-up",
          callInput: JSON.stringify({ session_key: "worker:browser:1" }),
        },
      },
      {
        id: "follow-up-result",
        missionId: mission.id,
        tMs: 500,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_send returned: completed",
        tags: ["thread", "tool-result", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send-follow-up",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            final_content: "Browser evidence completed; the earlier timeout remains part of the audit trail.",
          }),
        },
      },
    ]);
    const followUps: string[] = [];
    const bridge = createMissionThreadBridge({
      missionStore,
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:browser:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-send-original",
            label: "ops dashboard browser review",
          },
          state: {
            workerRunKey: "worker:browser:1",
            workerType: "browser",
            status: "done",
            createdAt: 100,
            updatedAt: 600,
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "Browser failure buckets: attach_failed=2.",
              payload: { mode: "llm_sub_agent", content: "Browser failure buckets: attach_failed=2." },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        followUps.push(input.content);
      },
    });

    await bridge.tickMission("msn.1");

    const recoveredEvents = activity.events.filter(
      (event) => event.runtime?.eventType === "mission.worker_late_completion"
    );
    assert.equal(recoveredEvents.length, 1);
    assert.equal(followUps.length, 0);
  });

  it("does not recover a completed worker when no prior session tool failed or timed out", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const activity = memActivityStore([
      {
        id: "existing-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_send",
        tags: ["thread", "tool-call", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send",
          callInput: JSON.stringify({ session_key: "worker:explore:1" }),
        },
      },
      {
        id: "existing-result",
        missionId: mission.id,
        tMs: 200,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_send returned: completed within timeout",
        tags: ["thread", "tool-result", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            final_content: "Completed within timeout.",
          }),
        },
      },
    ]);
    const followUps: string[] = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:explore:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
          },
          state: {
            workerRunKey: "worker:explore:1",
            workerType: "explore",
            status: "done",
            createdAt: 100,
            updatedAt: 300,
            lastResult: {
              workerType: "explore",
              status: "completed",
              summary: "Normal completion.",
              payload: { mode: "llm_sub_agent", content: "Normal completion." },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        followUps.push(input.content);
      },
    });

    await bridge.tickMission("msn.1");

    assert.equal(activity.events.some((event) => event.runtime?.eventType === "mission.worker_late_completion"), false);
    assert.equal(followUps.length, 0);
  });

  it("treats a canonical completed result as consuming an abbreviated session continuation", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const fullWorkerRunKey = "worker:browser:task:task-source:call-spawn";
    const activity = memActivityStore([
      {
        id: "spawn-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_spawn",
        tags: ["thread", "tool-call", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-spawn",
        },
      },
      {
        id: "spawn-timeout",
        missionId: mission.id,
        tMs: 200,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_spawn timed out.",
        emph: "danger",
        tags: ["thread", "tool-result", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-spawn",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "timeout",
            session_key: fullWorkerRunKey,
          }),
        },
      },
      {
        id: "continuation-call",
        missionId: mission.id,
        tMs: 300,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_send",
        tags: ["thread", "tool-call", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send",
          callInput: JSON.stringify({
            session_key: "worker:browser:task:task-source",
          }),
        },
      },
      {
        id: "continuation-result",
        missionId: mission.id,
        tMs: 400,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_send returned completed evidence.",
        tags: ["thread", "tool-result", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "result",
          toolCallId: "call-send",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            session_key: fullWorkerRunKey,
            final_content: "The continued source check completed.",
          }),
        },
      },
    ]);
    const followUps: string[] = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: fullWorkerRunKey,
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-original",
            taskId: "task-source",
            roleId: "role-lead",
            parentSpanId: "span-original",
            toolCallId: "call-spawn",
          },
          state: {
            workerRunKey: fullWorkerRunKey,
            workerType: "browser",
            status: "done",
            createdAt: 100,
            updatedAt: 500,
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "The continued source check completed.",
              payload: { content: "The continued source check completed." },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        followUps.push(input.content);
      },
    });

    await bridge.tickMission(mission.id);

    assert.equal(
      activity.events.some(
        (event) =>
          event.runtime?.eventType === "mission.worker_late_completion",
      ),
      false,
    );
    assert.equal(followUps.length, 0);
  });

  it("does not recover a worker whose earlier timeout was superseded by a completed parent result", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const activity = memActivityStore([
      {
        id: "spawn-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_spawn",
        tags: ["thread", "tool-call", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-spawn",
        },
      },
      {
        id: "spawn-timeout",
        missionId: mission.id,
        tMs: 200,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_spawn timed out.",
        emph: "danger",
        tags: ["thread", "tool-result", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-spawn",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "timeout",
            session_key: "worker:browser:1",
          }),
        },
      },
      {
        id: "spawn-completed",
        missionId: mission.id,
        tMs: 300,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_spawn returned completed evidence.",
        tags: ["thread", "tool-result", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-spawn",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            session_key: "worker:browser:1",
            final_content: "Rendered evidence reached the parent after the earlier timeout.",
          }),
        },
      },
    ]);
    const followUps: string[] = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:browser:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-spawn",
          },
          state: {
            workerRunKey: "worker:browser:1",
            workerType: "browser",
            status: "done",
            createdAt: 100,
            updatedAt: 300,
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "Rendered evidence reached the parent.",
              payload: {
                mode: "llm_sub_agent",
                content: "Rendered evidence reached the parent.",
              },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        followUps.push(input.content);
      },
    });

    await bridge.tickMission("msn.1");

    assert.equal(
      activity.events.some(
        (event) =>
          event.runtime?.eventType === "mission.worker_late_completion",
      ),
      false,
    );
    assert.equal(followUps.length, 0);
  });

  it("waits for an in-flight parent session result before recovering a done worker", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const activity = memActivityStore([
      {
        id: "spawn-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_spawn",
        tags: ["thread", "tool-call", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-spawn",
        },
      },
      {
        id: "spawn-timeout",
        missionId: mission.id,
        tMs: 200,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_spawn timed out.",
        emph: "danger",
        tags: ["thread", "tool-result", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-spawn",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "timeout",
            session_key: "worker:browser:1",
          }),
        },
      },
      {
        id: "send-call",
        missionId: mission.id,
        tMs: 300,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_send",
        tags: ["thread", "tool-call", "sessions_send"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_send",
          toolPhase: "call",
          toolCallId: "call-send",
          callInput: JSON.stringify({
            session_key: "worker:browser:1",
            message: "Continue the existing source check.",
          }),
        },
      },
    ]);
    const followUps: string[] = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:browser:1",
          executionToken: 2,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-spawn",
          },
          state: {
            workerRunKey: "worker:browser:1",
            workerType: "browser",
            status: "done",
            createdAt: 100,
            updatedAt: 400,
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "Continuation completed before its parent result was mirrored.",
              payload: {
                mode: "llm_sub_agent",
                content: "Continuation completed before its parent result was mirrored.",
              },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        followUps.push(input.content);
      },
    });

    await bridge.tickMission("msn.1");

    assert.equal(
      activity.events.some(
        (event) =>
          event.runtime?.eventType === "mission.worker_late_completion",
      ),
      false,
    );
    assert.equal(followUps.length, 0);
  });

  it("does not recover a done worker while its parent role run is still active", async () => {
    counter = 0;
    const mission: Mission = { ...baseMission, agents: ["role-lead"] };
    const activity = memActivityStore([
      {
        id: "spawn-call",
        missionId: mission.id,
        tMs: 100,
        kind: "tool",
        actor: "Lead",
        text: "Calling sessions_spawn",
        tags: ["thread", "tool-call", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "call",
          toolCallId: "call-spawn",
        },
      },
      {
        id: "spawn-timeout",
        missionId: mission.id,
        tMs: 200,
        kind: "tool",
        actor: "Lead",
        text: "Tool sessions_spawn timed out.",
        emph: "danger",
        tags: ["thread", "tool-result", "sessions_spawn"],
        runtime: {
          threadId: "thread-1",
          toolName: "sessions_spawn",
          toolPhase: "result",
          toolCallId: "call-spawn",
          resultContent: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "timeout",
            session_key: "worker:browser:1",
          }),
        },
      },
    ]);
    const followUps: string[] = [];
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([mission]),
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
          lastActiveAt: 300,
        },
      ]),
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:browser:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-spawn",
          },
          state: {
            workerRunKey: "worker:browser:1",
            workerType: "browser",
            status: "done",
            createdAt: 100,
            updatedAt: 300,
            lastResult: {
              workerType: "browser",
              status: "completed",
              summary: "Worker finished while the lead was still synthesizing.",
              payload: {
                mode: "llm_sub_agent",
                content: "Worker finished while the lead was still synthesizing.",
              },
            },
          },
        },
      ]),
      teamMessageStore: memTeamMessageStore([baseMessage("m1", "user", 50)]),
      activityStore: activity,
      newEventId,
      clock,
      async postLateWorkerCompletionFollowUp(input) {
        followUps.push(input.content);
      },
    });

    await bridge.tickMission("msn.1");

    assert.equal(
      activity.events.some(
        (event) =>
          event.runtime?.eventType === "mission.worker_late_completion",
      ),
      false,
    );
    assert.equal(followUps.length, 0);
  });

  it("marks a mission blocked when the latest lead tool turn was skipped without a final answer", async () => {
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
          toolCalls: [
            { id: "call-1", name: "sessions_spawn", arguments: { agent_id: "browser" } },
          ],
          toolProgress: [
            {
              toolCallId: "call-1",
              toolName: "sessions_spawn",
              phase: "completed",
              summary: "Browser spawn skipped by policy.",
              detail: { admission: "skipped" },
              ts: 201,
            },
          ],
          toolStatus: "completed",
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
    assert.equal(stalled?.runtime?.toolStatus, "skipped");
  });

  it("marks a mission blocked when a completed lead tool turn never produces a final answer", async () => {
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
          toolCalls: [
            { id: "call-1", name: "sessions_spawn", arguments: { agent_id: "explore" } },
          ],
          toolProgress: [
            {
              toolCallId: "call-1",
              toolName: "sessions_spawn",
              phase: "completed",
              summary: "Explore session returned source evidence.",
              ts: 201,
            },
          ],
          toolStatus: "completed",
        },
        {
          ...baseMessage("m2", "tool", 201),
          name: "sessions_spawn",
          content: "Evidence from the child session.",
          toolCallId: "call-1",
          toolStatus: "completed",
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
    assert.equal(stalled?.runtime?.toolStatus, "completed");
  });

  it("records timeout recovery status for failed tool turns with timeout evidence", async () => {
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
          toolCalls: [
            { id: "call-1", name: "sessions_spawn", arguments: { agent_id: "explore" } },
          ],
          toolProgress: [
            {
              toolCallId: "call-1",
              toolName: "sessions_spawn",
              phase: "failed",
              summary: "sessions_spawn timed out after 0.001s.",
              ts: 201,
            },
          ],
          toolStatus: "failed",
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
    assert.equal(stalled?.runtime?.toolStatus, "timeout");
    assert.deepEqual(stalled?.tags, ["mission_stalled", "timeout"]);
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

  it("does not scan worker sessions when the thread has no session tool activity", async () => {
    counter = 0;
    const counters: { list?: number; listByThread?: number } = {};
    const missionStore = memMissionStore([baseMission]);
    const bridge = createMissionThreadBridge({
      missionStore,
      workerSessionStore: memWorkerSessionStore([], counters),
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("m1", "assistant", 100),
          roleId: "role-lead",
          name: "Lead",
          content: "Done.",
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

    assert.equal(counters.listByThread ?? 0, 0);
    assert.equal(counters.list ?? 0, 0);
    assert.equal((await missionStore.get("msn.1"))?.status, "done");
  });

  it("uses one thread-scoped worker session read for recovery and completion reconciliation", async () => {
    counter = 0;
    const counters: { list?: number; listByThread?: number } = {};
    const missionStore = memMissionStore([baseMission]);
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
      workerSessionStore: memWorkerSessionStore([
        {
          workerRunKey: "worker:browser:1",
          executionToken: 1,
          context: {
            threadId: "thread-1",
            flowId: "flow-1",
            taskId: "task-1",
            roleId: "role-lead",
            parentSpanId: "span-1",
            toolCallId: "call-1",
          },
          state: {
            workerRunKey: "worker:browser:1",
            workerType: "browser",
            status: "running",
            createdAt: 100,
            updatedAt: 200,
          },
        },
      ], counters),
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

    assert.equal(counters.listByThread, 1);
    assert.equal(counters.list ?? 0, 0);
    assert.equal((await missionStore.get("msn.1"))?.status, "working");
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

  it("tickThread mirrors only missions linked to the updated thread", async () => {
    counter = 0;
    const m2: Mission = { ...baseMission, id: "msn.2", threadId: "thread-2" };
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission, m2]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("a", "assistant", 100),
        { ...baseMessage("b", "assistant", 200), threadId: "thread-2" },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });

    const result = await bridge.tickThread!("thread-2");

    assert.deepEqual(result, [{ missionId: "msn.2", appended: 1 }]);
    assert.deepEqual(activity.events.map((event) => event.missionId), ["msn.2"]);
  });

  it("tickAll prioritizes active recent missions before applying the per-tick cap", async () => {
    counter = 0;
    const oldDone: Mission = {
      ...baseMission,
      id: "msn.old",
      threadId: "thread-old",
      status: "done",
      createdAtMs: 10,
    };
    const activeRecent: Mission = {
      ...baseMission,
      id: "msn.active",
      threadId: "thread-active",
      status: "working",
      createdAtMs: 20,
    };
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([oldDone, activeRecent]),
      teamMessageStore: memTeamMessageStore([
        { ...baseMessage("old-msg", "assistant", 100), threadId: "thread-old" },
        { ...baseMessage("active-msg", "assistant", 200), threadId: "thread-active" },
      ]),
      activityStore: activity,
      newEventId,
      clock,
      maxMissionsPerTick: 1,
    });

    const result = await bridge.tickAll();

    assert.deepEqual(result, [{ missionId: "msn.active", appended: 1 }]);
    assert.deepEqual(activity.events.map((event) => event.missionId), ["msn.active"]);
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

  it("exposes model-use boundaries on final thought runtime", async () => {
    counter = 0;
    const activity = memActivityStore();
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([
        {
          ...baseMessage("a-model", "assistant", 1_000),
          roleId: "role-lead",
          content: "Final answer.",
          metadata: {
            missionReport: {
              status: "completed",
              reason: "completed_sub_agent_final",
              coverageVerified: true,
              source: "runtime_derived",
            },
            modelUse: {
              source: "turnkeyai-role-runtime",
              callCount: 2,
              totalInputTokens: 30,
              totalOutputTokens: 12,
              calls: [
                { index: 1, phase: "tool_round", round: 0, modelId: "m1", providerId: "p", durationMs: 10 },
                { index: 2, phase: "final_synthesis", modelId: "m1", providerId: "p", durationMs: 20 },
              ],
            },
          },
        },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    assert.equal(activity.events.length, 1);
    assert.equal(activity.events[0]?.runtime?.modelCallSource, "turnkeyai-role-runtime");
    assert.equal(activity.events[0]?.runtime?.modelCallCount, "2");
    assert.equal(activity.events[0]?.runtime?.modelInputTokens, "30");
    assert.equal(activity.events[0]?.runtime?.modelOutputTokens, "12");
    assert.match(activity.events[0]?.runtime?.modelCallBoundaries ?? "", /final_synthesis/);
    assert.equal(activity.events[0]?.runtime?.missionReportStatus, "completed");
    assert.equal(activity.events[0]?.runtime?.missionReportSource, "runtime_derived");
    assert.equal(activity.events[0]?.runtime?.missionReportReason, "completed_sub_agent_final");
    assert.equal(activity.events[0]?.runtime?.missionReportCoverageVerified, "true");
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
        toolLoopCloseout: {
          reason: "round_limit",
          toolCallCount: 1,
          roundCount: 1,
          maxRounds: 1,
          pendingToolCallCount: 1,
          evidenceAvailable: true,
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
    assert.equal(ordered[3]!.runtime?.toolLoopCloseout, "true");
    assert.equal(ordered[3]!.runtime?.toolLoopCloseoutReason, "round_limit");
    assert.equal(ordered[3]!.runtime?.["toolLoopCloseout.maxRounds"], "1");
    assert.equal(ordered[3]!.runtime?.["toolLoopCloseout.pendingToolCallCount"], "1");
    assert.equal(ordered[3]!.runtime?.["toolLoopCloseout.evidenceAvailable"], "true");
  });

  it("tool-result event carries full content on runtime.resultContent (K3.6)", async () => {
    counter = 0;
    const activity = memActivityStore();
    const fullResult = JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: "task-1",
      session_key: "worker:explore:1",
      agent_id: "explore",
      label: "Vendor Alpha",
      status: "completed",
      tool_chain: ["explore"],
      result: "Page title: Example Domain.",
      final_content: "Page title: Example Domain.\nFirst paragraph: This domain is for use in documentation examples...",
      payload: null,
    }, null, 2);
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
    assert.equal(result.runtime?.sourceLabel, "Vendor Alpha");
    // Inline text includes a head slice (not just byte count).
    assert.match(result.text, /Page title: Example Domain/);
  });

  it("dedupes split and metadata tool-result events by tool call while keeping full result content", async () => {
    counter = 0;
    const activity = memActivityStore();
    const fullResult = JSON.stringify({
      protocol: "turnkeyai.session_tool_result.v1",
      task_id: "task-1",
      session_key: "worker:explore:1",
      agent_id: "explore",
      label: "DeepSeek provider research",
      status: "timeout",
      resumable: true,
      timeout_seconds: 45,
      evidence_available: true,
      result: "Sub-agent session timed out after 45s. The session is resumable.",
      final_content: null,
    }, null, 2);
    const splitResult: TeamMessage = {
      ...baseMessage("tool-split-result", "tool", 4_900),
      name: "sessions_send",
      content: fullResult,
      toolCallId: "call-send",
      toolStatus: "failed",
    };
    const finalMessage: TeamMessage = {
      ...baseMessage("a-final", "assistant", 5_000),
      roleId: "role-lead",
      content: "Blocked: provider/search/pricing remain unverified.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [
                {
                  id: "call-send",
                  name: "sessions_send",
                  input: { session_key: "worker:explore:1", message: "continue provider research" },
                },
              ],
              results: [
                {
                  toolCallId: "call-send",
                  toolName: "sessions_send",
                  isError: true,
                  contentBytes: 43,
                  content: "Sub-agent session timed out after 45s.",
                },
              ],
            },
          ],
        },
      },
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([splitResult, finalMessage]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");
    await bridge.tickMission("msn.1");

    const results = activity.events.filter(
      (event) =>
        event.runtime?.toolPhase === "result" &&
        event.runtime.toolName === "sessions_send" &&
        event.runtime.toolCallId === "call-send",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]?.runtime?.resultContent, fullResult);
    assert.equal(results[0]?.runtime?.sourceLabel, "DeepSeek provider research");
    assert.equal(results[0]?.emph, "danger");
  });

  it("tool-result event falls back to call label for source coverage", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-source-label", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [{ id: "c1", name: "sessions_spawn", input: { agent_id: "explore", label: "Vendor Beta" } }],
              results: [
                {
                  toolCallId: "c1",
                  toolName: "sessions_spawn",
                  isError: false,
                  contentBytes: 24,
                  content: "Beta source returned evidence.",
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
    assert.equal(result.runtime?.sourceLabel, "Vendor Beta");
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

  it("shows canonical session_key on sessions_send call events when the result resolved it", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-session-canonical", "assistant", 5_000),
      roleId: "role-lead",
      content: "Done.",
      metadata: {
        toolUse: {
          rounds: [
            {
              round: 1,
              calls: [
                {
                  id: "c-send",
                  name: "sessions_send",
                  input: {
                    session_key: "worker:explore:task:TASK-1:call_function_jf…",
                    message: "continue",
                  },
                },
              ],
              results: [
                {
                  toolCallId: "c-send",
                  toolName: "sessions_send",
                  isError: false,
                  contentBytes: 120,
                  content: JSON.stringify({
                    protocol: "turnkeyai.session_tool_result.v1",
                    status: "completed",
                    session_key: "worker:explore:task:TASK-1:call_function_jfz0s4dlftej_1",
                    result: "continued",
                  }),
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

    const call = activity.events.find((event) => event.runtime?.toolPhase === "call");
    assert.ok(call);
    const input = JSON.parse(String(call.runtime?.callInput)) as { session_key?: string };
    assert.equal(input.session_key, "worker:explore:task:TASK-1:call_function_jfz0s4dlftej_1");
  });

  it("delays ellipsized sessions_send call events until a result can resolve the session_key", async () => {
    counter = 0;
    const activity = memActivityStore();
    const assistant: TeamMessage = {
      ...baseMessage("a-session-pending", "assistant", 5_000),
      roleId: "role-lead",
      content: "",
      metadata: { nativeToolUse: true },
      toolCalls: [
        {
          id: "c-send",
          name: "sessions_send",
          arguments: {
            session_key: "worker:explore:task:TASK-1:call_function_jf…",
            message: "continue",
          },
        },
      ],
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([assistant]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    assert.equal(activity.events.some((event) => event.runtime?.toolPhase === "call"), false);

    const resolvedBridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([
        assistant,
        {
          ...baseMessage("tool-session-resolved", "tool", 5_001),
          name: "sessions_send",
          toolCallId: "c-send",
          content: JSON.stringify({
            protocol: "turnkeyai.session_tool_result.v1",
            status: "completed",
            session_key: "worker:explore:task:TASK-1:call_function_jfz0s4dlftej_1",
            result: "continued",
          }),
          metadata: { nativeToolUse: true },
        },
      ]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await resolvedBridge.tickMission("msn.1");

    const call = activity.events.find((event) => event.runtime?.toolPhase === "call");
    assert.ok(call);
    const input = JSON.parse(String(call.runtime?.callInput)) as { session_key?: string };
    assert.equal(input.session_key, "worker:explore:task:TASK-1:call_function_jfz0s4dlftej_1");
  });

  it("emits clean unresolved sessions_send call events without waiting for a result", async () => {
    counter = 0;
    const activity = memActivityStore();
    const assistant: TeamMessage = {
      ...baseMessage("a-session-clean-pending", "assistant", 5_000),
      roleId: "role-lead",
      content: "",
      metadata: { nativeToolUse: true },
      toolCalls: [
        {
          id: "c-send-clean",
          name: "sessions_send",
          arguments: {
            session_key: "worker:browser:existing",
            message: "continue",
          },
        },
      ],
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([assistant]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const call = activity.events.find((event) => event.runtime?.toolPhase === "call");
    assert.ok(call);
    const input = JSON.parse(String(call.runtime?.callInput)) as { session_key?: string };
    assert.equal(input.session_key, "worker:browser:existing");
  });

  it("interleaves same-round dependent tool calls with their results on the timeline", async () => {
    counter = 0;
    const activity = memActivityStore();
    const message: TeamMessage = {
      ...baseMessage("a-native-memory", "assistant", 5_000),
      roleId: "role-lead",
      content: "Memory answer.",
      toolCalls: [
        {
          id: "c-search",
          name: "memory_search",
          arguments: { query: "Helios-47" },
        },
        {
          id: "c-get",
          name: "memory_get",
          arguments: { memory_id: "thread-1:note:1" },
        },
      ],
      toolProgress: [
        {
          toolCallId: "c-search",
          toolName: "memory_search",
          phase: "completed",
          summary: "Memory search returned 1 hit.",
          ts: 4_800,
        },
        {
          toolCallId: "c-get",
          toolName: "memory_get",
          phase: "completed",
          summary: "Read memory thread-1:note:1.",
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
      ordered.map((event) => ({
        toolName: event.runtime?.toolName ?? null,
        phase: event.runtime?.toolPhase ?? null,
      })),
      [
        { toolName: "memory_search", phase: "call" },
        { toolName: "memory_search", phase: "result" },
        { toolName: "memory_get", phase: "call" },
        { toolName: "memory_get", phase: "result" },
        { toolName: null, phase: null },
      ]
    );
  });

  it("orders native split tool results at their real completion times", async () => {
    counter = 0;
    const activity = memActivityStore();
    const assistant: TeamMessage = {
      ...baseMessage("a-native-tasks", "assistant", 5_000),
      roleId: "role-lead",
      content: "Task tracking complete.",
      metadata: { nativeToolUse: true },
      toolCalls: [
        {
          id: "c-list",
          name: "tasks_list",
          arguments: { status: "open" },
        },
        {
          id: "c-create",
          name: "tasks_create",
          arguments: { title: "Follow up with support" },
        },
      ],
    };
    const listResult: TeamMessage = {
      ...baseMessage("tool-list", "tool", 5_100),
      name: "tasks_list",
      content: '{"tasks":[]}',
      toolCallId: "c-list",
      toolStatus: "completed",
    };
    const createResult: TeamMessage = {
      ...baseMessage("tool-create", "tool", 5_200),
      name: "tasks_create",
      content: '{"task":{"id":"tsk.1","title":"Follow up with support"}}',
      toolCallId: "c-create",
      toolStatus: "completed",
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([assistant, listResult, createResult]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const ordered = [...activity.events].sort((a, b) => a.tMs - b.tMs);
    assert.deepEqual(
      ordered.map((event) => ({
        messageId: event.runtime?.messageId ?? null,
        toolName: event.runtime?.toolName ?? null,
        phase: event.runtime?.toolPhase ?? null,
      })),
      [
        { messageId: "a-native-tasks", toolName: "tasks_list", phase: "call" },
        { messageId: "a-native-tasks", toolName: "tasks_create", phase: "call" },
        { messageId: "tool-list", toolName: "tasks_list", phase: "result" },
        { messageId: "tool-create", toolName: "tasks_create", phase: "result" },
        { messageId: "a-native-tasks", toolName: null, phase: null },
      ]
    );
    assert.equal(ordered.length, 5);
    assert.equal(ordered[2]!.tMs, 5_100);
    assert.equal(ordered[3]!.tMs, 5_200);
    assert.ok(
      ordered[4]!.tMs > 5_200,
      "assistant thought should not appear before split tool results complete"
    );
    assert.equal(ordered[2]!.runtime?.resultContent, '{"tasks":[]}');
    assert.match(ordered[3]!.text, /Follow up with support/);
  });

  it("replaces an existing native tool result summary when split result content arrives later", async () => {
    counter = 0;
    const fullResult = JSON.stringify(
      {
        status: "ok",
        requested_url: "https://example.com/",
        final_url: "https://example.com/",
        status_code: 200,
        title: "Example Domain",
        text_excerpt:
          "This domain is for use in documentation examples without needing permission.",
      },
      null,
      2
    );
    const activity = memActivityStore([
      {
        id: "existing-result",
        missionId: "msn.1",
        tMs: 4_950,
        kind: "tool",
        actor: "role-lead",
        text: "Tool web_fetch returned (0 B):\nTool call completed: web_fetch",
        tags: ["thread", "tool-result", "web_fetch"],
        runtime: {
          threadId: "thread-1",
          messageId: "a-web-fetch",
          activitySourceId: "a-web-fetch:tool-result:c-web-fetch",
          toolName: "web_fetch",
          toolCallId: "c-web-fetch",
          toolPhase: "result",
          round: "1",
          contentBytes: "0",
          resultContent: "Tool call completed: web_fetch",
        },
      },
    ]);
    const assistant: TeamMessage = {
      ...baseMessage("a-web-fetch", "assistant", 5_000),
      roleId: "role-lead",
      content: "",
      metadata: { nativeToolUse: true, toolRound: 1 },
      toolCalls: [
        {
          id: "c-web-fetch",
          name: "web_fetch",
          arguments: { url: "https://example.com", max_chars: 1500 },
        },
      ],
      toolProgress: [
        {
          toolCallId: "c-web-fetch",
          toolName: "web_fetch",
          phase: "completed",
          summary: "Tool call completed: web_fetch",
          ts: 5_000,
        },
      ],
    };
    const splitResult: TeamMessage = {
      ...baseMessage("tool-web-fetch", "tool", 5_001),
      name: "web_fetch",
      content: fullResult,
      toolCallId: "c-web-fetch",
      toolStatus: "completed",
    };
    const bridge = createMissionThreadBridge({
      missionStore: memMissionStore([baseMission]),
      teamMessageStore: memTeamMessageStore([assistant, splitResult]),
      activityStore: activity,
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const results = activity.events.filter(
      (event) => event.runtime?.toolPhase === "result" && event.runtime.toolCallId === "c-web-fetch"
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "existing-result");
    assert.equal(results[0]?.runtime?.messageId, "tool-web-fetch");
    assert.equal(results[0]?.tMs, 5_001);
    assert.equal(results[0]?.runtime?.resultContent, fullResult);
    assert.match(results[0]?.text ?? "", /Example Domain/);
    assert.match(results[0]?.text ?? "", /documentation examples/);
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
      content: JSON.stringify({
        protocol: "turnkeyai.session_tool_result.v1",
        task_id: "task-1",
        session_key: "worker:browser:1",
        agent_id: "browser",
        label: "Ops dashboard",
        status: "completed",
        tool_chain: ["browser"],
        result: "Durable tool result content.",
        final_content: "Durable tool result content.",
        payload: null,
      }, null, 2),
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
    assert.equal(resultEvents[0]?.runtime?.resultContent, toolMessage.content);
    assert.equal(resultEvents[0]?.runtime?.sourceLabel, "Ops dashboard");
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

describe("MissionThreadBridge stale closeout clearing", () => {
  it("clears a stale closeout tag when a reopened mission completes for real", async () => {
    counter = 0;
    // A mission that was once closed via approval timeout, got reopened, went
    // back to working, and now produces a genuine lead final answer. The old
    // closeout tag must not survive onto the fresh "done" — otherwise the UI
    // renders a real completion as "Closed · no approval".
    const missions: Mission[] = [
      {
        ...baseMission,
        status: "working",
        closeout: "approval_timeout",
      },
    ];
    const store = memMissionStore(missions);
    const bridge = createMissionThreadBridge({
      missionStore: store,
      roleRunStore: memRoleRunStore([]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("m1", "user", 100),
        {
          ...baseMessage("m2", "assistant", 200),
          name: "Lead",
          content: "Final answer: the vendor table is complete with all requested columns and citations.",
        },
      ]),
      activityStore: memActivityStore(),
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const updated = await store.get("msn.1");
    assert.equal(updated?.status, "done");
    assert.equal(updated?.progress, 1);
    assert.equal(updated?.closeout, undefined);
  });

  it("keeps the closeout tag written by the same lifecycle patch", async () => {
    counter = 0;
    const missions: Mission[] = [
      {
        ...baseMission,
        status: "needs_approval",
        pendingApprovals: 1,
        desc: "Submit the local form only after approval.",
      },
    ];
    const store = memMissionStore(missions);
    const bridge = createMissionThreadBridge({
      missionStore: store,
      roleRunStore: memRoleRunStore([]),
      teamMessageStore: memTeamMessageStore([
        baseMessage("m1", "user", 100),
        {
          ...baseMessage("m2", "assistant", 200),
          name: "Lead",
          content: [
            "## Wait-timeout closeout",
            "The operator decision for browser.form.submit did not arrive during this attempt cycle and the approval remains pending.",
            "No form submission or browser side effect was performed.",
            "Safe fallback: keep the dry-run unsubmitted. Next action: ask the operator to approve a new request or rerun the submission attempt when ready.",
          ].join("\n"),
        },
      ]),
      activityStore: memActivityStore(),
      newEventId,
      clock,
    });

    await bridge.tickMission("msn.1");

    const updated = await store.get("msn.1");
    assert.equal(updated?.status, "done");
    assert.equal(updated?.closeout, "approval_timeout");
    // Honest progress: the gated action never ran, so no fake 100%.
    assert.equal(updated?.progress, 0);
  });
});

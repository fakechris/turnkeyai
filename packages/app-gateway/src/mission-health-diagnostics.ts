import type {
  ActivityEventStore,
  Mission,
  MissionStatus,
  MissionStore,
} from "@turnkeyai/core-types/mission";
import type { RuntimeProgressStore } from "@turnkeyai/core-types/team";

import {
  buildMissionObservabilitySnapshot,
  type MissionObservabilitySnapshot,
} from "./mission-observability";

const MISSION_STATUSES: MissionStatus[] = [
  "draft",
  "planning",
  "working",
  "needs_approval",
  "blocked",
  "done",
  "archived",
];

const ACTIVE_STATUSES = new Set<MissionStatus>(["draft", "planning", "working", "needs_approval"]);

export interface DiagnosticsMissionHealthSnapshot {
  total: number;
  inspected: number;
  byStatus: Record<MissionStatus, number>;
  active: number;
  terminal: number;
  needsApproval: number;
  withBlockers: number;
  snapshotErrorCount: number;
  duration: {
    longestActiveMs: number;
    longestActiveMissionId?: string;
    longestActiveMissionTitle?: string;
    oldestActiveCreatedAtMs?: number;
  };
  latestMission?: {
    id: string;
    title: string;
    status: MissionStatus;
    createdAtMs: number;
  };
  qualityGate: {
    running: number;
    passed: number;
    needsAttention: number;
    blocked: number;
  };
  tool: {
    requested: number;
    executed: number;
    failed: number;
    cancelled: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
  };
  browser: {
    profileFallbacks: number;
    failureBuckets: Array<{
      bucket: string;
      count: number;
      latestAtMs: number;
    }>;
  };
  liveness: {
    active: number;
    waiting: number;
    stale: number;
  };
  recoveryEvents: number;
  attentionMissions: Array<{
    id: string;
    title: string;
    status: MissionStatus;
    qualityGateStatus: MissionObservabilitySnapshot["qualityGate"]["status"];
    pendingApprovals: number;
    blockers: number;
    toolFailures: number;
    toolTimeouts: number;
    browserProfileFallbacks: number;
    browserFailureBuckets: Array<{
      bucket: string;
      count: number;
      latestAtMs: number;
    }>;
    recoveryEvents: number;
    staleRuntimeSubjects: number;
    wallClockMs: number;
    lastProgressAtMs?: number;
  }>;
}

export interface BuildDiagnosticsMissionHealthInput {
  missionStore: Pick<MissionStore, "list">;
  activityStore: Pick<ActivityEventStore, "listByMission">;
  runtimeProgressStore?: Pick<RuntimeProgressStore, "listByThread">;
  nowMs: number;
  inspectLimit?: number;
}

export async function buildDiagnosticsMissionHealthSnapshot(
  input: BuildDiagnosticsMissionHealthInput
): Promise<DiagnosticsMissionHealthSnapshot> {
  const missions = [...(await input.missionStore.list())].sort(compareMissionNewestFirst);
  const byStatus = emptyStatusCounts();
  for (const mission of missions) {
    byStatus[mission.status] += 1;
  }

  const inspectedMissions = chooseMissionsToInspect(missions, input.inspectLimit ?? 24);
  let snapshotErrorCount = 0;
  const snapshots = (
    await Promise.all(
      inspectedMissions.map(async (mission) => {
        try {
          const events = await input.activityStore.listByMission(mission.id);
          const progressEvents =
            mission.threadId && input.runtimeProgressStore
              ? await input.runtimeProgressStore.listByThread(mission.threadId, 500)
              : [];
          return buildMissionObservabilitySnapshot({
            mission,
            events,
            progressEvents,
            nowMs: input.nowMs,
          });
        } catch {
          snapshotErrorCount += 1;
          return null;
        }
      })
    )
  ).filter((snapshot): snapshot is MissionObservabilitySnapshot => snapshot != null);

  const qualityGate = { running: 0, passed: 0, needsAttention: 0, blocked: 0 };
  const tool = { requested: 0, executed: 0, failed: 0, cancelled: 0, timeouts: 0 };
  const sessions = { spawned: 0, continued: 0 };
  const browser: DiagnosticsMissionHealthSnapshot["browser"] = { profileFallbacks: 0, failureBuckets: [] };
  const liveness = { active: 0, waiting: 0, stale: 0 };
  let recoveryEvents = 0;

  const missionById = new Map(missions.map((mission) => [mission.id, mission]));
  const attentionMissions: DiagnosticsMissionHealthSnapshot["attentionMissions"] = [];
  for (const snapshot of snapshots) {
    qualityGate[qualityKey(snapshot.qualityGate.status)] += 1;
    tool.requested += snapshot.tool.requested;
    tool.executed += snapshot.tool.executed;
    tool.failed += snapshot.tool.failed;
    tool.cancelled += snapshot.tool.cancelled;
    tool.timeouts += snapshot.tool.timeouts;
    sessions.spawned += snapshot.sessions.spawned;
    sessions.continued += snapshot.sessions.continued;
    browser.profileFallbacks += snapshot.browser.profileFallbacks;
    browser.failureBuckets = mergeBrowserFailureBuckets(browser.failureBuckets, snapshot.browser.failureBuckets);
    liveness.active += snapshot.liveness.active;
    liveness.waiting += snapshot.liveness.waiting;
    liveness.stale += snapshot.liveness.stale;
    recoveryEvents += snapshot.recovery.events;

    const mission = missionById.get(snapshot.missionId);
    if (mission && shouldSurfaceMissionAttention(mission, snapshot)) {
      attentionMissions.push({
        id: mission.id,
        title: mission.title,
        status: mission.status,
        qualityGateStatus: snapshot.qualityGate.status,
        pendingApprovals: mission.pendingApprovals,
        blockers: mission.blockers,
        toolFailures: snapshot.tool.failed,
        toolTimeouts: snapshot.tool.timeouts,
        browserProfileFallbacks: snapshot.browser.profileFallbacks,
        browserFailureBuckets: snapshot.browser.failureBuckets,
        recoveryEvents: snapshot.recovery.events,
        staleRuntimeSubjects: snapshot.liveness.stale,
        wallClockMs: snapshot.wallClockMs,
        ...(snapshot.liveness.lastProgressAtMs !== undefined
          ? { lastProgressAtMs: snapshot.liveness.lastProgressAtMs }
          : {}),
      });
    }
  }

  attentionMissions.sort((left, right) => attentionRank(right) - attentionRank(left));
  const latestMission = missions[0];
  const longestActive = longestActiveMission(missions, input.nowMs);
  return {
    total: missions.length,
    inspected: inspectedMissions.length,
    byStatus,
    active: missions.filter((mission) => ACTIVE_STATUSES.has(mission.status)).length,
    terminal: missions.filter((mission) => mission.status === "done" || mission.status === "blocked").length,
    needsApproval: missions.filter((mission) => mission.status === "needs_approval" || mission.pendingApprovals > 0).length,
    withBlockers: missions.filter((mission) =>
      mission.status !== "archived" && (mission.blockers > 0 || mission.status === "blocked")
    ).length,
    snapshotErrorCount,
    duration: {
      longestActiveMs: longestActive ? Math.max(0, input.nowMs - longestActive.createdAtMs) : 0,
      ...(longestActive
        ? {
            longestActiveMissionId: longestActive.id,
            longestActiveMissionTitle: longestActive.title,
            oldestActiveCreatedAtMs: longestActive.createdAtMs,
          }
        : {}),
    },
    ...(latestMission
      ? {
          latestMission: {
            id: latestMission.id,
            title: latestMission.title,
            status: latestMission.status,
            createdAtMs: latestMission.createdAtMs,
          },
        }
      : {}),
    qualityGate,
    tool,
    sessions,
    browser,
    liveness,
    recoveryEvents,
    attentionMissions: attentionMissions.slice(0, 6),
  };
}

function mergeBrowserFailureBuckets(
  left: DiagnosticsMissionHealthSnapshot["browser"]["failureBuckets"],
  right: DiagnosticsMissionHealthSnapshot["browser"]["failureBuckets"]
): DiagnosticsMissionHealthSnapshot["browser"]["failureBuckets"] {
  const merged = new Map<string, DiagnosticsMissionHealthSnapshot["browser"]["failureBuckets"][number]>();
  for (const item of [...left, ...right]) {
    const existing = merged.get(item.bucket);
    if (existing) {
      merged.set(item.bucket, {
        bucket: item.bucket,
        count: existing.count + item.count,
        latestAtMs: Math.max(existing.latestAtMs, item.latestAtMs),
      });
    } else {
      merged.set(item.bucket, { ...item });
    }
  }
  return [...merged.values()].sort((a, b) => b.latestAtMs - a.latestAtMs || a.bucket.localeCompare(b.bucket));
}

function emptyStatusCounts(): Record<MissionStatus, number> {
  return Object.fromEntries(MISSION_STATUSES.map((status) => [status, 0])) as Record<MissionStatus, number>;
}

function compareMissionNewestFirst(left: Mission, right: Mission): number {
  return right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id);
}

function chooseMissionsToInspect(missions: Mission[], limit: number): Mission[] {
  const chosen = new Map<string, Mission>();
  const boundedLimit = Math.max(1, limit);
  for (const mission of missions) {
    if (mission.status === "archived") continue;
    if (ACTIVE_STATUSES.has(mission.status) || mission.status === "blocked" || mission.pendingApprovals > 0 || mission.blockers > 0) {
      chosen.set(mission.id, mission);
    }
  }
  for (const mission of missions) {
    if (chosen.size >= boundedLimit) break;
    if (mission.status === "archived") continue;
    chosen.set(mission.id, mission);
  }
  return [...chosen.values()].slice(0, boundedLimit);
}

function longestActiveMission(missions: Mission[], nowMs: number): Mission | null {
  let chosen: Mission | null = null;
  let chosenAge = -1;
  for (const mission of missions) {
    if (!ACTIVE_STATUSES.has(mission.status)) continue;
    const age = Math.max(0, nowMs - mission.createdAtMs);
    if (age > chosenAge || (age === chosenAge && mission.id.localeCompare(chosen?.id ?? "") > 0)) {
      chosen = mission;
      chosenAge = age;
    }
  }
  return chosen;
}

function qualityKey(status: MissionObservabilitySnapshot["qualityGate"]["status"]): keyof DiagnosticsMissionHealthSnapshot["qualityGate"] {
  if (status === "needs_attention") return "needsAttention";
  return status;
}

function shouldSurfaceMissionAttention(mission: Mission, snapshot: MissionObservabilitySnapshot): boolean {
  if (mission.status === "archived") return false;
  if (mission.status === "needs_approval" || mission.pendingApprovals > 0) return true;
  if (mission.status === "blocked" || mission.blockers > 0) return true;
  if (snapshot.qualityGate.status === "blocked" || snapshot.qualityGate.status === "needs_attention") return true;
  if (snapshot.liveness.stale > 0) return true;
  if (snapshot.browser.profileFallbacks > 0) return true;
  if (snapshot.browser.failureBuckets.length > 0) return true;
  if (snapshot.tool.failed > 0 || snapshot.tool.timeouts > 0 || snapshot.recovery.events > 0) return true;
  return false;
}

function attentionRank(mission: DiagnosticsMissionHealthSnapshot["attentionMissions"][number]): number {
  return (
    mission.staleRuntimeSubjects * 100 +
    mission.toolTimeouts * 50 +
    mission.toolFailures * 40 +
    mission.browserProfileFallbacks * 35 +
    mission.browserFailureBuckets.reduce((sum, item) => sum + item.count, 0) * 32 +
    mission.recoveryEvents * 30 +
    mission.blockers * 25 +
    mission.pendingApprovals * 20 +
    (mission.qualityGateStatus === "blocked" ? 15 : mission.qualityGateStatus === "needs_attention" ? 10 : 0) +
    (mission.status === "blocked" ? 8 : mission.status === "needs_approval" ? 6 : 0)
  );
}

import type {
  ActivityEvent,
  Mission,
  MissionObservabilitySnapshot,
  RoleRunState,
  WorkerSessionRecord,
} from "../api/mission-api";

export interface MissionProgressNow {
  title: string;
  detail: string;
  tone: "ok" | "warning" | "danger" | "muted";
  meta: string[];
  latestEvent?: {
    label: string;
    text: string;
    tMs: number;
  };
  latestTool?: {
    name: string;
    phase: string;
    text: string;
    tMs: number;
  };
}

export function buildMissionProgressNow(input: {
  mission: Mission;
  metrics: MissionObservabilitySnapshot | null;
  timeline: ActivityEvent[];
  roleRuns: RoleRunState[];
  workerSessions: WorkerSessionRecord[];
}): MissionProgressNow {
  const activeRoleRuns = input.roleRuns.filter((run) => !isTerminalRoleRun(run)).length;
  const activeWorkerSessions = input.workerSessions.filter((session) => !isTerminalWorkerSession(session)).length;
  const latestEvent = latestTimelineEvent(input.timeline);
  const latestTool = latestToolEvent(input.timeline);
  const liveness = input.metrics?.liveness;
  const qualityStatus = input.metrics?.qualityGate.status;

  const meta = [
    `${activeRoleRuns} active role${activeRoleRuns === 1 ? "" : "s"}`,
    `${activeWorkerSessions} active session${activeWorkerSessions === 1 ? "" : "s"}`,
  ];
  if (input.metrics) {
    meta.push(`${input.metrics.tool.requested}/${input.metrics.tool.results} tools`);
    meta.push(`${liveness?.active ?? 0} active · ${liveness?.waiting ?? 0} waiting`);
  } else {
    meta.push("metrics loading");
  }

  if ((liveness?.stale ?? 0) > 0) {
    return {
      title: "Runtime stale",
      detail: `${liveness!.stale} runtime subject${liveness!.stale === 1 ? "" : "s"} overdue. Inspect active runs or recover before trusting the result.`,
      tone: "danger",
      meta,
      ...(latestEvent ? { latestEvent: formatLatestEvent(latestEvent) } : {}),
      ...(latestTool ? { latestTool: formatLatestTool(latestTool) } : {}),
    };
  }

  if (input.mission.status === "needs_approval" || input.mission.pendingApprovals > 0) {
    return {
      title: "Waiting for approval",
      detail: `${input.mission.pendingApprovals || input.metrics?.approvals.requested || 1} approval decision${(input.mission.pendingApprovals || input.metrics?.approvals.requested || 1) === 1 ? "" : "s"} may be blocking the next action.`,
      tone: "warning",
      meta,
      ...(latestEvent ? { latestEvent: formatLatestEvent(latestEvent) } : {}),
      ...(latestTool ? { latestTool: formatLatestTool(latestTool) } : {}),
    };
  }

  if (activeRoleRuns > 0 || activeWorkerSessions > 0 || (liveness?.active ?? 0) > 0 || (liveness?.waiting ?? 0) > 0) {
    return {
      title: "Working",
      detail: latestTool
        ? `Latest tool step is ${latestTool.runtime?.toolName ?? "unknown tool"} ${latestTool.runtime?.toolPhase ?? "in progress"}.`
        : latestEvent
          ? `Latest event is ${latestEvent.kind} from ${latestEvent.actor}.`
          : "Runtime reports active work but no timeline event has arrived yet.",
      tone: "warning",
      meta,
      ...(latestEvent ? { latestEvent: formatLatestEvent(latestEvent) } : {}),
      ...(latestTool ? { latestTool: formatLatestTool(latestTool) } : {}),
    };
  }

  if (input.mission.status === "done") {
    return {
      title: qualityStatus === "passed" ? "Done" : qualityStatus === "needs_attention" ? "Done, needs attention" : "Done",
      detail: latestEvent ? `Last event was ${latestEvent.kind} from ${latestEvent.actor}.` : "Mission is terminal with no replay event loaded yet.",
      tone: qualityStatus === "passed" ? "ok" : qualityStatus === "needs_attention" ? "warning" : "muted",
      meta,
      ...(latestEvent ? { latestEvent: formatLatestEvent(latestEvent) } : {}),
      ...(latestTool ? { latestTool: formatLatestTool(latestTool) } : {}),
    };
  }

  if (input.mission.status === "blocked") {
    return {
      title: "Blocked",
      detail: latestEvent ? `Last event was ${latestEvent.kind} from ${latestEvent.actor}.` : "Mission is blocked before timeline replay loaded.",
      tone: "danger",
      meta,
      ...(latestEvent ? { latestEvent: formatLatestEvent(latestEvent) } : {}),
      ...(latestTool ? { latestTool: formatLatestTool(latestTool) } : {}),
    };
  }

  return {
    title: statusLabel(input.mission.status),
    detail: latestEvent ? `Last event was ${latestEvent.kind} from ${latestEvent.actor}.` : "Waiting for mission activity.",
    tone: "muted",
    meta,
    ...(latestEvent ? { latestEvent: formatLatestEvent(latestEvent) } : {}),
    ...(latestTool ? { latestTool: formatLatestTool(latestTool) } : {}),
  };
}

function latestTimelineEvent(events: ActivityEvent[]): ActivityEvent | undefined {
  return [...events].sort((left, right) => left.tMs - right.tMs || left.id.localeCompare(right.id)).at(-1);
}

function latestToolEvent(events: ActivityEvent[]): ActivityEvent | undefined {
  return [...events]
    .filter((event) => event.kind === "tool")
    .sort((left, right) => left.tMs - right.tMs || left.id.localeCompare(right.id))
    .at(-1);
}

function formatLatestEvent(event: ActivityEvent): MissionProgressNow["latestEvent"] {
  return {
    label: `${statusLabel(event.kind)} · ${event.actor}`,
    text: event.text,
    tMs: event.tMs,
  };
}

function formatLatestTool(event: ActivityEvent): MissionProgressNow["latestTool"] {
  return {
    name: event.runtime?.toolName ?? "unknown tool",
    phase: event.runtime?.toolPhase ?? "unknown",
    text: event.text,
    tMs: event.tMs,
  };
}

function isTerminalRoleRun(run: RoleRunState): boolean {
  return run.status === "done" || run.status === "failed" || run.status === "idle";
}

function isTerminalWorkerSession(session: WorkerSessionRecord): boolean {
  return session.state.status === "done" || session.state.status === "failed" || session.state.status === "cancelled";
}

function statusLabel(value: string): string {
  return value.replace(/_/g, " ");
}

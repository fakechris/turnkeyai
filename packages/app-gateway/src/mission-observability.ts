import type { ActivityEvent, Mission } from "@turnkeyai/core-types/mission";
import type { RuntimeProgressEvent } from "@turnkeyai/core-types/team";

export interface MissionObservabilitySnapshot {
  missionId: string;
  status: Mission["status"];
  generatedAtMs: number;
  wallClockMs: number;
  timelineEventCount: number;
  tool: {
    requested: number;
    results: number;
    executed: number;
    skipped: number;
    failed: number;
    cancelled: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
  };
  approvals: {
    requested: number;
    applied: number;
    decided: number;
  };
  recovery: {
    events: number;
  };
  liveness: {
    active: number;
    waiting: number;
    stale: number;
    lastProgressAtMs?: number;
    staleSubjects: Array<{
      subjectKind: RuntimeProgressEvent["subjectKind"];
      subjectId: string;
      summary: string;
      overdueMs: number;
    }>;
  };
  qualityGate: {
    status: "running" | "passed" | "needs_attention" | "blocked";
    finalAnswerEventId?: string;
    evidenceEvents: number;
    checks: Array<{
      name: string;
      status: "pass" | "warn" | "fail" | "pending";
      detail: string;
    }>;
  };
}

export function buildMissionObservabilitySnapshot(input: {
  mission: Mission;
  events: ActivityEvent[];
  progressEvents?: RuntimeProgressEvent[];
  nowMs: number;
}): MissionObservabilitySnapshot {
  const events = [...input.events].sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id));
  const firstMs = events[0]?.tMs ?? input.mission.createdAtMs;
  const terminal = input.mission.status === "done" || input.mission.status === "blocked";
  const lastMs = terminal ? (events.at(-1)?.tMs ?? input.nowMs) : input.nowMs;
  const toolCalls = events.filter((event) => event.kind === "tool" && event.runtime?.toolPhase === "call");
  const toolResults = events.filter((event) => event.kind === "tool" && event.runtime?.toolPhase === "result");
  const toolFailures = toolResults.filter((event) => event.emph === "danger" && event.runtime?.admission !== "skipped");
  const outcomeEvents = events.filter(
    (event) => event.kind === "recovery" || (event.kind === "tool" && event.runtime?.toolPhase === "result")
  );
  const cancelled = outcomeEvents.filter((event) => /\bcancel(?:led|ed)?\b/i.test(eventTextBlob(event)));
  const timeouts = outcomeEvents.filter((event) => /\btime(?:d)?\s*out|timeout\b/i.test(eventTextBlob(event)));
  const sessionSpawnCalls = distinctRuntimeValues(
    toolCalls.filter((event) => event.runtime?.toolName === "sessions_spawn"),
    "toolCallId"
  );
  const sessionSendCalls = distinctRuntimeValues(
    toolCalls.filter((event) => event.runtime?.toolName === "sessions_send"),
    "toolCallId"
  );
  const approvalEvents = events.filter((event) => event.kind === "approval");
  const finalAnswer = latestFinalAnswer(input.mission, events);
  const evidenceEvents = countEvidenceEvents(events);
  const recoveryEvents = events.filter((event) => event.kind === "recovery");
  const liveness = summarizeRuntimeLiveness(input.progressEvents ?? [], input.nowMs);
  const checks = buildQualityChecks({
    mission: input.mission,
    finalAnswer,
    evidenceEvents,
    failureEvents: recoveryEvents.length + toolFailures.length,
    staleRuntimeSubjects: liveness.stale,
  });

  return {
    missionId: input.mission.id,
    status: input.mission.status,
    generatedAtMs: input.nowMs,
    wallClockMs: Math.max(0, Math.round(lastMs - firstMs)),
    timelineEventCount: events.length,
    tool: {
      requested: toolCalls.length,
      results: toolResults.length,
      executed: toolResults.filter((event) => event.runtime?.admission !== "skipped").length,
      skipped: toolResults.filter((event) => event.runtime?.admission === "skipped").length,
      failed: toolFailures.length,
      cancelled: cancelled.length,
      timeouts: timeouts.length,
    },
    sessions: {
      spawned: sessionSpawnCalls.size,
      continued: sessionSendCalls.size,
    },
    approvals: {
      requested: approvalEvents.filter((event) => /requested approval|permission\.query/i.test(eventTextBlob(event))).length,
      applied: approvalEvents.filter((event) => /applied approval|permission\.applied/i.test(eventTextBlob(event))).length,
      decided: approvalEvents.filter(isApprovalDecisionEvent).length,
    },
    recovery: {
      events: recoveryEvents.length,
    },
    liveness,
    qualityGate: {
      status: deriveQualityStatus(input.mission, checks),
      ...(finalAnswer ? { finalAnswerEventId: finalAnswer.id } : {}),
      evidenceEvents,
      checks,
    },
  };
}

function buildQualityChecks(input: {
  mission: Mission;
  finalAnswer: ActivityEvent | null;
  evidenceEvents: number;
  failureEvents: number;
  staleRuntimeSubjects: number;
}): MissionObservabilitySnapshot["qualityGate"]["checks"] {
  const terminal = input.mission.status === "done" || input.mission.status === "blocked";
  const finalText = input.finalAnswer?.text ?? "";
  return [
    {
      name: "final_answer",
      status: input.finalAnswer ? "pass" : terminal ? "fail" : "pending",
      detail: input.finalAnswer ? "Lead final answer is present." : "No lead final answer has been mirrored yet.",
    },
    {
      name: "evidence_backed",
      status: input.evidenceEvents > 0 ? "pass" : terminal ? "fail" : "pending",
      detail:
        input.evidenceEvents > 0
          ? `${input.evidenceEvents} evidence-bearing event(s) are attached to the mission.`
          : "No tool/browser/doc/artifact evidence event is visible yet.",
    },
    {
      name: "residual_risk",
      status: !input.finalAnswer ? "pending" : mentionsResidualRisk(finalText) ? "pass" : "warn",
      detail: input.finalAnswer
        ? mentionsResidualRisk(finalText)
          ? "Final answer names residual risk or unverified scope."
          : "Final answer does not explicitly name residual risk."
        : "Waiting for the final answer.",
    },
    {
      name: "runtime_liveness",
      status: input.staleRuntimeSubjects === 0 ? "pass" : "fail",
      detail:
        input.staleRuntimeSubjects === 0
          ? "No active role or worker span has exceeded its response timeout."
          : `${input.staleRuntimeSubjects} active role/worker span(s) exceeded their response timeout.`,
    },
    {
      name: "failure_free",
      status: input.failureEvents === 0 ? "pass" : "fail",
      detail:
        input.failureEvents === 0
          ? "No recovery or failed tool-result event is present."
          : `${input.failureEvents} recovery/failed tool event(s) require attention.`,
    },
  ];
}

function summarizeRuntimeLiveness(
  progressEvents: RuntimeProgressEvent[],
  nowMs: number
): MissionObservabilitySnapshot["liveness"] {
  const bySubjectTask = new Map<string, RuntimeProgressEvent[]>();
  for (const event of progressEvents) {
    const taskKey = event.taskId ? `task:${event.taskId}` : `progress:${event.progressId}`;
    const key = `${event.subjectKind}:${event.subjectId}:${taskKey}`;
    const eventsForTask = bySubjectTask.get(key);
    if (eventsForTask) {
      eventsForTask.push(event);
    } else {
      bySubjectTask.set(key, [event]);
    }
  }

  const latestBySubject = new Map<string, RuntimeProgressEvent>();
  for (const eventsForTask of bySubjectTask.values()) {
    const candidate = summarizeTaskProgress(eventsForTask);
    const subjectKey = `${candidate.subjectKind}:${candidate.subjectId}`;
    const current = latestBySubject.get(subjectKey);
    if (!current || compareProgress(candidate, current) > 0) {
      latestBySubject.set(subjectKey, candidate);
    }
  }

  let active = 0;
  let waiting = 0;
  let lastProgressAtMs: number | undefined;
  const staleSubjects: MissionObservabilitySnapshot["liveness"]["staleSubjects"] = [];
  for (const event of latestBySubject.values()) {
    lastProgressAtMs = Math.max(lastProgressAtMs ?? event.recordedAt, event.recordedAt);
    if (isTerminalProgress(event)) {
      continue;
    }
    if (event.continuityState === "waiting" || event.phase === "waiting") {
      waiting += 1;
    } else {
      active += 1;
    }
    if (event.responseTimeoutAt && nowMs > event.responseTimeoutAt) {
      staleSubjects.push({
        subjectKind: event.subjectKind,
        subjectId: event.subjectId,
        summary: event.summary,
        overdueMs: Math.max(0, nowMs - event.responseTimeoutAt),
      });
    }
  }

  return {
    active,
    waiting,
    stale: staleSubjects.length,
    ...(lastProgressAtMs !== undefined ? { lastProgressAtMs } : {}),
    staleSubjects,
  };
}

function summarizeTaskProgress(events: RuntimeProgressEvent[]): RuntimeProgressEvent {
  const terminalEvents = events.filter(isTerminalProgress);
  const candidates = terminalEvents.length > 0 ? terminalEvents : events;
  return candidates.reduce((latest, event) => (compareProgress(event, latest) > 0 ? event : latest));
}

function compareProgress(left: RuntimeProgressEvent, right: RuntimeProgressEvent): number {
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt - right.recordedAt;
  }
  return left.progressId.localeCompare(right.progressId);
}

function isTerminalProgress(event: RuntimeProgressEvent): boolean {
  if (event.continuityState === "terminal" || event.continuityState === "resolved") {
    return true;
  }
  return event.phase === "completed" || event.phase === "failed" || event.phase === "cancelled";
}

function deriveQualityStatus(
  mission: Mission,
  checks: MissionObservabilitySnapshot["qualityGate"]["checks"]
): MissionObservabilitySnapshot["qualityGate"]["status"] {
  if (mission.status === "blocked" || checks.some((check) => check.status === "fail")) {
    return "blocked";
  }
  if (mission.status !== "done") {
    return "running";
  }
  if (checks.some((check) => check.status === "warn" || check.status === "pending")) {
    return "needs_attention";
  }
  return "passed";
}

function latestFinalAnswer(mission: Mission, events: ActivityEvent[]): ActivityEvent | null {
  const candidates = events.filter((event) => {
    if (event.kind !== "thought" || event.text.trim().length === 0) return false;
    if (event.runtime?.route === "lead-role") return true;
    if (event.actor === "role-lead") return true;
    return mission.agents[0] === event.actor;
  });
  return candidates.at(-1) ?? null;
}

function countEvidenceEvents(events: ActivityEvent[]): number {
  return events.filter((event) => {
    if (event.evidence?.length) return true;
    if (event.kind === "browser" || event.kind === "doc" || event.kind === "artifact") return true;
    if (event.kind !== "tool") return false;
    if (event.runtime?.toolPhase !== "result") return false;
    return event.runtime.admission !== "skipped";
  }).length;
}

function distinctRuntimeValues(events: ActivityEvent[], key: string): Set<string> {
  const values = new Set<string>();
  for (const event of events) {
    const value = event.runtime?.[key];
    if (typeof value === "string" && value.trim()) {
      values.add(value);
    }
  }
  return values;
}

function eventTextBlob(event: ActivityEvent): string {
  return [event.text, event.tags?.join(" ") ?? "", event.runtime ? Object.values(event.runtime).join(" ") : ""].join(" ");
}

function isApprovalDecisionEvent(event: ActivityEvent): boolean {
  const runtimeEventType = event.runtime?.eventType;
  if (runtimeEventType === "permission.result") {
    return true;
  }
  return /^(approved|denied)\b/i.test(event.text.trim());
}

function mentionsResidualRisk(text: string): boolean {
  return /\b(residual risk|risk|not verified|unverified|limitation|unknown)\b|风险|未验证|待确认/i.test(text);
}

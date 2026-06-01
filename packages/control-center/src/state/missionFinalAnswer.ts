import type { ActivityEvent, Mission, MissionObservabilitySnapshot } from "../api/mission-api";

export function selectMissionFinalAnswer(input: {
  mission: Mission;
  events: ActivityEvent[];
  metrics: MissionObservabilitySnapshot | null;
}): ActivityEvent | null {
  const latestUserIndex = latestUserPlanIndex(input.events);
  const staleBeforeIndex = Math.max(
    latestUserIndex,
    latestToolActivityIndex(input.events)
  );
  const metricsFinalAnswerId = input.metrics?.qualityGate.finalAnswerEventId;
  if (metricsFinalAnswerId) {
    const metricsCandidateIndex = input.events.findIndex((event) => event.id === metricsFinalAnswerId);
    const metricsCandidate = input.events[metricsCandidateIndex];
    const boundaryIndex = isTerminalMetrics(input.mission, input.metrics) ? latestUserIndex : staleBeforeIndex;
    if (
      metricsCandidate &&
      metricsCandidateIndex > boundaryIndex &&
      !hasUnresolvedToolCallBeforeAnswer(input.events, latestUserIndex, metricsCandidateIndex) &&
      isLeadThought(input.mission, metricsCandidate)
    ) {
      return metricsCandidate;
    }
  }

  for (let index = input.events.length - 1; index > staleBeforeIndex; index -= 1) {
    const event = input.events[index]!;
    if (
      isLeadThought(input.mission, event) &&
      !hasUnresolvedToolCallBeforeAnswer(input.events, latestUserIndex, index)
    ) {
      return event;
    }
  }
  return null;
}

function latestUserPlanIndex(events: ActivityEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "plan" && (event.actor === "user" || event.runtime?.teamRole === "user")) {
      return index;
    }
  }
  return -1;
}

function latestToolActivityIndex(events: ActivityEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.kind === "tool") {
      return index;
    }
  }
  return -1;
}

function hasUnresolvedToolCallBeforeAnswer(
  events: ActivityEvent[],
  afterIndex: number,
  answerIndex: number
): boolean {
  const pendingCallIds = new Set<string>();
  for (let index = afterIndex + 1; index < answerIndex; index += 1) {
    const event = events[index];
    if (event?.kind !== "tool") continue;
    const toolCallId = event.runtime?.toolCallId;
    if (!toolCallId) continue;
    if (event.runtime?.toolPhase === "call") {
      pendingCallIds.add(toolCallId);
    } else if (event.runtime?.toolPhase === "result") {
      pendingCallIds.delete(toolCallId);
    }
  }
  return pendingCallIds.size > 0;
}

function isLeadThought(mission: Mission, event: ActivityEvent): boolean {
  if (event.kind !== "thought") return false;
  if (event.text.trim().length === 0) return false;
  if (event.runtime?.route === "lead-role") return true;
  if (event.actor === "role-lead") return true;
  return mission.agents[0] === event.actor;
}

function isTerminalMetrics(mission: Mission, metrics: MissionObservabilitySnapshot | null): boolean {
  if (!metrics) return false;
  return (
    (mission.status === "done" || mission.status === "blocked") &&
    metrics.status === mission.status
  );
}

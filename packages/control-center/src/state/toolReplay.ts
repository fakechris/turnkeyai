import type { ActivityEvent } from "../api/mission-api";

export type TimelineReplayItem =
  | {
      kind: "event";
      event: ActivityEvent;
    }
  | ToolProcessItem;

export type ToolProcessItem = {
  kind: "tool-process";
  id: string;
  actor: string;
  startMs: number;
  endMs: number;
  toolEvents: ActivityEvent[];
  processEvents: ActivityEvent[];
  finalThought?: ActivityEvent;
  status: "running" | "completed" | "failed";
};

export function groupTimelineForReplay(events: ActivityEvent[]): TimelineReplayItem[] {
  const items: TimelineReplayItem[] = [];
  const groups = new Map<string, { actor: string; toolEvents: ActivityEvent[]; firstIndex: number; lastIndex: number }>();
  const thoughtIndexesByActor = new Map<string, Array<{ index: number; event: ActivityEvent }>>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.kind === "thought") {
      const thoughts = thoughtIndexesByActor.get(event.actor) ?? [];
      thoughts.push({ index, event });
      thoughtIndexesByActor.set(event.actor, thoughts);
      continue;
    }
    if (event.kind !== "tool") {
      continue;
    }
    const key = toolProcessKey(event);
    const group = groups.get(key);
    if (group) {
      group.toolEvents.push(event);
      group.lastIndex = index;
    } else {
      groups.set(key, { actor: event.actor, toolEvents: [event], firstIndex: index, lastIndex: index });
    }
  }

  const emittedGroups = new Set<string>();
  const consumedThoughtIds = new Set<string>();
  const consumedProcessEventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (consumedThoughtIds.has(event.id) || consumedProcessEventIds.has(event.id)) {
      continue;
    }
    if (event.kind !== "tool") {
      items.push({ kind: "event", event });
      continue;
    }

    const key = toolProcessKey(event);
    if (emittedGroups.has(key)) {
      continue;
    }
    const group = groups.get(key)!;
    emittedGroups.add(key);

    const toolEvents = [...group.toolEvents].sort(
      (left, right) => left.tMs - right.tMs || left.id.localeCompare(right.id)
    );
    const finalThought = findNextUnconsumedThought(
      thoughtIndexesByActor.get(group.actor),
      group.lastIndex,
      consumedThoughtIds
    );
    if (finalThought) {
      consumedThoughtIds.add(finalThought.id);
    }
    const finalThoughtIndex = finalThought ? events.findIndex((item) => item.id === finalThought.id) : -1;
    const processEvents = collectProcessContextEvents({
      events,
      group,
      untilIndex: finalThoughtIndex >= 0 ? finalThoughtIndex : group.lastIndex,
      consumedProcessEventIds,
    });
    for (const processEvent of processEvents) {
      consumedProcessEventIds.add(processEvent.id);
    }

    const startMs = toolEvents[0]!.tMs;
    const lastProcessEventMs = processEvents.at(-1)?.tMs;
    const endMs = finalThought?.tMs ?? lastProcessEventMs ?? toolEvents[toolEvents.length - 1]!.tMs;
    items.push({
      kind: "tool-process",
      id: `tool-process:${toolEvents[0]!.id}`,
      actor: group.actor,
      startMs,
      endMs,
      toolEvents,
      processEvents,
      ...(finalThought ? { finalThought } : {}),
      status: deriveToolProcessStatus(toolEvents, processEvents, finalThought),
    });
  }

  return items;
}

function collectProcessContextEvents(input: {
  events: ActivityEvent[];
  group: { firstIndex: number; lastIndex: number };
  untilIndex: number;
  consumedProcessEventIds: Set<string>;
}): ActivityEvent[] {
  const endIndex = Math.max(input.group.lastIndex, input.untilIndex);
  const processEvents: ActivityEvent[] = [];
  for (let index = input.group.firstIndex + 1; index <= endIndex; index += 1) {
    const event = input.events[index];
    if (!event || input.consumedProcessEventIds.has(event.id)) {
      continue;
    }
    if (event.kind === "tool" || event.kind === "thought") {
      continue;
    }
    if (isToolProcessContextEvent(event)) {
      processEvents.push(event);
    }
  }
  return processEvents.sort((left, right) => left.tMs - right.tMs || left.id.localeCompare(right.id));
}

function isToolProcessContextEvent(event: ActivityEvent): boolean {
  return event.kind === "approval" || event.kind === "recovery" || event.kind === "artifact";
}

function toolProcessKey(event: ActivityEvent): string {
  const messageId = event.runtime?.messageId;
  const round = event.runtime?.round;
  if (messageId && round) {
    return `${event.actor}:${messageId}:${round}`;
  }
  return `${event.actor}:tool-call:${event.runtime?.toolCallId ?? event.id}`;
}

function findNextUnconsumedThought(
  thoughts: Array<{ index: number; event: ActivityEvent }> | undefined,
  afterIndex: number,
  consumedThoughtIds: Set<string>
): ActivityEvent | undefined {
  if (!thoughts?.length) {
    return undefined;
  }
  let low = 0;
  let high = thoughts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (thoughts[middle]!.index <= afterIndex) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (let index = low; index < thoughts.length; index += 1) {
    const thought = thoughts[index]!.event;
    if (!consumedThoughtIds.has(thought.id)) {
      return thought;
    }
  }
  return undefined;
}

export function formatDurationMs(startMs: number, endMs: number): string {
  const durationMs = Math.max(0, Math.round(endMs - startMs));
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  let minutes = Math.floor(seconds / 60);
  let remainder = Math.round(seconds % 60);
  if (remainder === 60) {
    minutes += 1;
    remainder = 0;
  }
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function deriveToolProcessStatus(
  toolEvents: ActivityEvent[],
  processEvents: ActivityEvent[],
  finalThought: ActivityEvent | undefined
): "running" | "completed" | "failed" {
  if (toolEvents.some((event) => event.emph === "danger") || processEvents.some((event) => event.emph === "danger")) {
    return "failed";
  }
  if (finalThought || toolEvents.some((event) => event.runtime?.toolPhase === "result")) {
    return "completed";
  }
  return "running";
}

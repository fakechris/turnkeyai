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
  finalThought?: ActivityEvent;
  status: "running" | "completed" | "failed";
};

export function groupTimelineForReplay(events: ActivityEvent[]): TimelineReplayItem[] {
  const items: TimelineReplayItem[] = [];
  const groups = new Map<string, { actor: string; toolEvents: ActivityEvent[]; lastIndex: number }>();
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
      groups.set(key, { actor: event.actor, toolEvents: [event], lastIndex: index });
    }
  }

  const emittedGroups = new Set<string>();
  const consumedThoughtIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (consumedThoughtIds.has(event.id)) {
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

    const startMs = toolEvents[0]!.tMs;
    const endMs = finalThought?.tMs ?? toolEvents[toolEvents.length - 1]!.tMs;
    items.push({
      kind: "tool-process",
      id: `tool-process:${toolEvents[0]!.id}`,
      actor: group.actor,
      startMs,
      endMs,
      toolEvents,
      ...(finalThought ? { finalThought } : {}),
      status: deriveToolProcessStatus(toolEvents, finalThought),
    });
  }

  return items;
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
  finalThought: ActivityEvent | undefined
): "running" | "completed" | "failed" {
  if (toolEvents.some((event) => event.emph === "danger")) {
    return "failed";
  }
  if (finalThought || toolEvents.some((event) => event.runtime?.toolPhase === "result")) {
    return "completed";
  }
  return "running";
}

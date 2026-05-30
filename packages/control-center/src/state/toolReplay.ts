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

export type CancellableToolCalls = {
  messageId: string;
  toolCallIds: string[];
};

type ToolProcessGroup = {
  actor: string;
  toolEvents: ActivityEvent[];
  firstIndex: number;
  lastIndex: number;
};

export function groupTimelineForReplay(events: ActivityEvent[]): TimelineReplayItem[] {
  const items: TimelineReplayItem[] = [];
  const groups = new Map<string, ToolProcessGroup>();
  const thoughtIndexesByActor = new Map<string, Array<{ index: number; event: ActivityEvent }>>();
  const eventIndexById = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    eventIndexById.set(event.id, index);
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
  const groupEntries = [...groups.entries()]
    .map(([key, group]) => ({ key, group }))
    .sort((left, right) => left.group.firstIndex - right.group.firstIndex || left.key.localeCompare(right.key));
  const nextGroupStartByKey = new Map<string, number>();
  const nextSameActorGroupStartByKey = new Map<string, number>();
  const nextSeenByActor = new Map<string, number>();
  let nextGroupStart: number | undefined;
  for (let index = groupEntries.length - 1; index >= 0; index -= 1) {
    const entry = groupEntries[index]!;
    if (nextGroupStart !== undefined) {
      nextGroupStartByKey.set(entry.key, nextGroupStart);
    }
    const nextSameActorGroupStart = nextSeenByActor.get(entry.group.actor);
    if (nextSameActorGroupStart !== undefined) {
      nextSameActorGroupStartByKey.set(entry.key, nextSameActorGroupStart);
    }
    nextSeenByActor.set(entry.group.actor, entry.group.firstIndex);
    nextGroupStart = entry.group.firstIndex;
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
    const nextThought = findNextUnconsumedThought(
      thoughtIndexesByActor.get(group.actor),
      group.lastIndex,
      consumedThoughtIds
    );
    const nextSameActorGroupStart = nextSameActorGroupStartByKey.get(key);
    const finalThought =
      nextThought && (nextSameActorGroupStart === undefined || nextThought.index < nextSameActorGroupStart)
        ? nextThought.event
        : undefined;
    if (finalThought) {
      consumedThoughtIds.add(finalThought.id);
    }
    const finalThoughtIndex = finalThought ? eventIndexById.get(finalThought.id) : undefined;
    const nextGroupStartIndex = nextGroupStartByKey.get(key);
    const contextBoundary = Math.min(
      nextGroupStartIndex === undefined ? Number.POSITIVE_INFINITY : nextGroupStartIndex - 1,
      nextThought === undefined ? Number.POSITIVE_INFINITY : nextThought.index - 1,
      finalThoughtIndex === undefined ? Number.POSITIVE_INFINITY : finalThoughtIndex - 1
    );
    const processEvents = collectProcessContextEvents({
      events,
      group,
      untilIndex: Number.isFinite(contextBoundary) ? contextBoundary : group.lastIndex,
      consumedProcessEventIds,
    });
    for (const processEvent of processEvents) {
      consumedProcessEventIds.add(processEvent.id);
    }

    const startMs = toolEvents[0]!.tMs;
    const lastProcessEventMs = processEvents.at(-1)?.tMs;
    const endMs = Math.max(toolEvents[toolEvents.length - 1]!.tMs, lastProcessEventMs ?? 0, finalThought?.tMs ?? 0);
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
  group: ToolProcessGroup;
  untilIndex: number;
  consumedProcessEventIds: Set<string>;
}): ActivityEvent[] {
  const endIndex = Math.max(input.group.firstIndex, input.untilIndex);
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
): { index: number; event: ActivityEvent } | undefined {
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
    const thought = thoughts[index]!;
    if (!consumedThoughtIds.has(thought.event.id)) {
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

export function getCancellableToolCallsForProcess(process: ToolProcessItem): CancellableToolCalls | null {
  if (process.status !== "running") {
    return null;
  }
  const resultIds = new Set<string>();
  for (const event of process.toolEvents) {
    if (event.runtime?.toolPhase !== "result") {
      continue;
    }
    const toolCallId = event.runtime.toolCallId?.trim();
    if (toolCallId) {
      resultIds.add(toolCallId);
    }
  }

  const messageIds = new Set<string>();
  const activeCallIds: string[] = [];
  const seenCallIds = new Set<string>();
  for (const event of process.toolEvents) {
    if (event.runtime?.toolPhase !== "call" || event.runtime.admission === "skipped") {
      continue;
    }
    const messageId = event.runtime.messageId?.trim();
    const toolCallId = event.runtime.toolCallId?.trim();
    if (!messageId || !toolCallId || resultIds.has(toolCallId) || seenCallIds.has(toolCallId)) {
      continue;
    }
    messageIds.add(messageId);
    activeCallIds.push(toolCallId);
    seenCallIds.add(toolCallId);
  }

  if (messageIds.size !== 1 || activeCallIds.length === 0) {
    return null;
  }
  return {
    messageId: [...messageIds][0]!,
    toolCallIds: activeCallIds,
  };
}

function deriveToolProcessStatus(
  toolEvents: ActivityEvent[],
  processEvents: ActivityEvent[],
  finalThought: ActivityEvent | undefined
): "running" | "completed" | "failed" {
  if (toolEvents.some(isFailureEvent) || processEvents.some(isFailureEvent)) {
    return "failed";
  }
  if (finalThought) {
    return "completed";
  }
  const callIds = toolEvents
    .filter((event) => event.runtime?.toolPhase === "call" && event.runtime.admission !== "skipped")
    .map((event) => event.runtime?.toolCallId?.trim())
    .filter((toolCallId): toolCallId is string => Boolean(toolCallId));
  const resultIds = new Set(
    toolEvents
      .filter((event) => event.runtime?.toolPhase === "result")
      .map((event) => event.runtime?.toolCallId?.trim())
      .filter((toolCallId): toolCallId is string => Boolean(toolCallId))
  );
  if (callIds.length > 0) {
    return callIds.every((toolCallId) => resultIds.has(toolCallId)) ? "completed" : "running";
  }
  if (toolEvents.some((event) => event.runtime?.toolPhase === "result")) {
    return "completed";
  }
  return "running";
}

function isFailureEvent(event: ActivityEvent): boolean {
  if (event.runtime?.admission === "skipped") {
    return false;
  }
  return event.emph === "danger" || event.kind === "recovery";
}

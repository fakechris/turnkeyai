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
  let index = 0;

  while (index < events.length) {
    const event = events[index]!;
    if (event.kind !== "tool") {
      items.push({ kind: "event", event });
      index += 1;
      continue;
    }

    const toolEvents: ActivityEvent[] = [];
    const actor = event.actor;
    while (index < events.length && events[index]?.kind === "tool" && events[index]?.actor === actor) {
      toolEvents.push(events[index]!);
      index += 1;
    }

    const next = events[index];
    const finalThought = next?.kind === "thought" && next.actor === actor ? next : undefined;
    if (finalThought) {
      index += 1;
    }

    const startMs = toolEvents[0]!.tMs;
    const endMs = finalThought?.tMs ?? toolEvents[toolEvents.length - 1]!.tMs;
    items.push({
      kind: "tool-process",
      id: `tool-process:${toolEvents[0]!.id}`,
      actor,
      startMs,
      endMs,
      toolEvents,
      ...(finalThought ? { finalThought } : {}),
      status: deriveToolProcessStatus(toolEvents, finalThought),
    });
  }

  return items;
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

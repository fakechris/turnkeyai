// Translate team-runtime thread messages into mission ActivityEvents
// (PR K3.5). Polling-based: every tick, scan each mission-linked
// thread for messages that haven't been mirrored onto the mission
// timeline yet, append the missing ones.
//
// Why polling instead of an event subscription: the team-runtime
// engine persists assistant/tool messages directly via teamMessageStore
// (see CoordinationEngine.ensureMessagePersisted) without firing a
// rich message.posted event that carries the messageId. Subscribing to
// TeamEventBus alone would miss the agent replies — which is exactly
// the thing the user wants to watch. Polling is simple, complete, and
// resilient to daemon restarts (the cursor is the activity log
// itself).
//
// Idempotency: each ActivityEvent records `runtime.messageId`. On
// every tick we read the existing activity events and skip any source
// messageId we've already mirrored. Restarting the daemon never
// duplicates events, and a missed tick just means the next tick picks
// up the backlog.
//
// Cost: O(M × (T + A)) per tick where M = missions with threadId,
// T = messages per thread, A = activity events per mission. K3.5 demo
// workloads keep all three small (single-digit missions, ~dozens of
// messages each). Revisit with a per-thread cursor file when missions
// run long-form.

import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityEventStore,
  Mission,
  MissionStore,
} from "@turnkeyai/core-types/mission";
import type {
  Clock,
  TeamMessage,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";

export interface MissionThreadBridgeOptions {
  missionStore: Pick<MissionStore, "list" | "findByThreadId">;
  teamMessageStore: Pick<TeamMessageStore, "list">;
  activityStore: Pick<ActivityEventStore, "append" | "listByMission">;
  newEventId: () => string;
  clock: Clock;
  /** Max messages to scan per thread per tick. K3.5 demo threads stay
   *  small; this guards against pathologically long backlogs. */
  perThreadLimit?: number;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

export interface MissionThreadBridge {
  /**
   * Scan every mission with a linked thread, mirror new messages.
   * Returns a per-mission summary of how many events were appended —
   * mostly useful for tests; the daemon ignores the return value.
   */
  tickAll(): Promise<Array<{ missionId: string; appended: number }>>;
  /**
   * Scan a single mission. Routes call this right after posting a
   * user message so the new "plan"-kind event shows up immediately
   * instead of waiting for the next interval tick.
   */
  tickMission(missionId: string): Promise<number>;
  /**
   * Begin the background interval. Returns an unsubscribe handle.
   * Safe to call multiple times — first call wins; subsequent calls
   * return no-op stops to avoid timer fan-out on accidental
   * re-composition.
   */
  start(intervalMs?: number): () => void;
}

export function createMissionThreadBridge(
  options: MissionThreadBridgeOptions
): MissionThreadBridge {
  const logger = options.logger ?? defaultLogger;
  const perThreadLimit = options.perThreadLimit ?? 500;
  let interval: NodeJS.Timeout | null = null;

  async function mirror(mission: Mission, threadId: string): Promise<number> {
    let messages: TeamMessage[];
    try {
      messages = await options.teamMessageStore.list(threadId, perThreadLimit);
    } catch (error) {
      logger.warn("thread message list failed", {
        threadId,
        error: errorMessage(error),
      });
      return 0;
    }
    if (messages.length === 0) return 0;

    let existing: ActivityEvent[];
    try {
      existing = await options.activityStore.listByMission(mission.id);
    } catch (error) {
      logger.warn("activity list failed for mission", {
        missionId: mission.id,
        error: errorMessage(error),
      });
      return 0;
    }
    // Dedupe is keyed on the synthetic event ID we stamp into
    // runtime.activitySourceId — this composite id is unique per
    // (messageId, kind, subindex), so an assistant message that
    // expanded into N tool events + 1 final answer doesn't collide
    // with itself on the next tick.
    const mirroredSourceIds = new Set<string>();
    for (const event of existing) {
      const sourceId = event.runtime?.activitySourceId;
      if (typeof sourceId === "string" && sourceId.length > 0) {
        mirroredSourceIds.add(sourceId);
      }
    }

    let appended = 0;
    for (const message of messages) {
      const expanded = expandMessage({
        missionId: mission.id,
        message,
        newEventId: options.newEventId,
      });
      for (const event of expanded) {
        const sourceId = event.runtime?.activitySourceId;
        if (typeof sourceId === "string" && mirroredSourceIds.has(sourceId)) {
          continue;
        }
        try {
          await options.activityStore.append(event);
          if (sourceId) mirroredSourceIds.add(sourceId);
          appended += 1;
        } catch (error) {
          logger.warn("activity append failed", {
            missionId: mission.id,
            messageId: message.id,
            error: errorMessage(error),
          });
        }
      }
    }
    return appended;
  }

  async function tickMission(missionId: string): Promise<number> {
    const mission = await safeFindMission(missionId);
    if (!mission || !mission.threadId) return 0;
    return mirror(mission, mission.threadId);
  }

  async function safeFindMission(missionId: string): Promise<Mission | null> {
    try {
      const all = await options.missionStore.list();
      return all.find((m) => m.id === missionId) ?? null;
    } catch (error) {
      logger.warn("mission lookup failed", {
        missionId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  async function tickAll(): Promise<Array<{ missionId: string; appended: number }>> {
    let missions: Mission[];
    try {
      missions = await options.missionStore.list();
    } catch (error) {
      logger.warn("mission list failed", { error: errorMessage(error) });
      return [];
    }
    const linked = missions.filter((m): m is Mission & { threadId: string } =>
      typeof m.threadId === "string" && m.threadId.length > 0
    );
    const results: Array<{ missionId: string; appended: number }> = [];
    // Sequential — these are small. Parallel would race on the activity
    // log append per mission, which is JSONL-append-safe today but the
    // bridge has bigger fish to fry than micro-optimizing tick latency.
    for (const mission of linked) {
      const appended = await mirror(mission, mission.threadId);
      results.push({ missionId: mission.id, appended });
    }
    return results;
  }

  function start(intervalMs = 2000): () => void {
    if (interval) return () => undefined;
    interval = setInterval(() => {
      void tickAll().catch((error) => {
        logger.warn("tickAll rejected", { error: errorMessage(error) });
      });
    }, intervalMs);
    // unref so a stuck timer doesn't keep the process alive on
    // shutdown — daemon shutdown path explicitly stop()s anyway.
    interval.unref();
    return () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
  }

  return { tickAll, tickMission, start };
}

interface ExpandMessageInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
}

/**
 * Translate one team-runtime message into one OR MORE ActivityEvents.
 *
 * Plain messages (user prompt, system, plain assistant reply, tool
 * result) map 1:1. Assistant messages with a `metadata.toolUse.rounds`
 * trace expand into a tool-call event + tool-result event per (round,
 * call) BEFORE the final answer — so the timeline shows
 *   "user → tool call → tool result → tool call → tool result → final answer"
 * instead of "user → black-box thought".
 *
 * Dedupe IDs are composite (messageId + kind + sub-index) so the next
 * tick can recognise each emitted event and skip duplicates.
 */
function expandMessage(input: ExpandMessageInput): ActivityEvent[] {
  const { message } = input;
  if (message.role === "user") {
    return [
      buildPlainEvent({
        ...input,
        kind: "plan",
        text: message.content,
        sourceSuffix: "user",
        tags: ["thread", "user"],
      }),
    ];
  }
  if (message.role === "tool") {
    return [
      buildPlainEvent({
        ...input,
        kind: "tool",
        text: message.content,
        sourceSuffix: "tool",
        tags: ["thread", "tool"],
      }),
    ];
  }
  if (message.role !== "assistant") {
    // system: silent — internal scaffolding doesn't belong on the user timeline.
    return [];
  }

  const events: ActivityEvent[] = [];
  const toolUse = extractToolUseTrace(message.metadata);
  if (toolUse && toolUse.rounds.length > 0) {
    // The final answer is timestamped at message.createdAt. Push the
    // tool events backwards in time using small fractional offsets so
    // the timeline order is preserved when sorting by tMs (the
    // dashboard's primary sort). Steps further back than total
    // rounds*2 events would never land before the previous message;
    // in practice 8 rounds × 2 events ≪ a single second, so the math
    // works out to sub-second offsets.
    const totalSubEvents = toolUse.rounds.reduce(
      (sum, round) => sum + round.calls.length + round.results.length,
      0
    );
    let stepIndex = 0;
    for (const round of toolUse.rounds) {
      for (const call of round.calls) {
        events.push(
          buildToolCallEvent({
            ...input,
            tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
            call,
            roundNumber: round.round,
          })
        );
        stepIndex += 1;
      }
      for (const result of round.results) {
        const matchingCall = round.calls.find(
          (call) => call.id === result.toolCallId
        );
        events.push(
          buildToolResultEvent({
            ...input,
            tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
            result,
            roundNumber: round.round,
            callName: matchingCall?.name ?? result.toolName,
          })
        );
        stepIndex += 1;
      }
    }
  }

  // Final answer (only if non-empty — pure tool-only assistant turns
  // can have empty text content).
  if (message.content && message.content.trim().length > 0) {
    events.push(
      buildPlainEvent({
        ...input,
        kind: "thought",
        text: message.content,
        sourceSuffix: "assistant",
        tags: ["thread", "assistant"],
      })
    );
  }
  return events;
}

function tMsForStep(baseMs: number, stepIndex: number, totalSteps: number): number {
  // Place all tool steps in a ~100ms window just before the final
  // answer (baseMs). stepIndex 0 lands furthest back, last step lands
  // ~1ms before baseMs. Avoids ties with the same baseMs and preserves
  // ordering relative to the final answer.
  const windowMs = Math.max(2, Math.min(200, totalSteps * 2));
  const offsetMs = windowMs - Math.floor((windowMs - 1) * stepIndex / Math.max(1, totalSteps));
  return baseMs - offsetMs;
}

interface ToolUseTrace {
  rounds: Array<{
    round: number;
    calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    results: Array<{
      toolCallId: string;
      toolName: string;
      isError: boolean;
      contentBytes: number;
    }>;
  }>;
}

function extractToolUseTrace(metadata: unknown): ToolUseTrace | null {
  if (!isRecord(metadata)) return null;
  const toolUse = metadata.toolUse;
  if (!isRecord(toolUse) || !Array.isArray(toolUse.rounds)) return null;
  const rounds = toolUse.rounds
    .map((round) => {
      if (!isRecord(round)) return null;
      const calls = Array.isArray(round.calls)
        ? round.calls.filter(isRecord).map((call) => ({
            id: typeof call.id === "string" ? call.id : "",
            name: typeof call.name === "string" ? call.name : "",
            input: isRecord(call.input) ? call.input : {},
          }))
        : [];
      const results = Array.isArray(round.results)
        ? round.results.filter(isRecord).map((result) => ({
            toolCallId: typeof result.toolCallId === "string" ? result.toolCallId : "",
            toolName: typeof result.toolName === "string" ? result.toolName : "",
            isError: result.isError === true,
            contentBytes:
              typeof result.contentBytes === "number" ? result.contentBytes : 0,
          }))
        : [];
      return {
        round: typeof round.round === "number" ? round.round : 0,
        calls,
        results,
      };
    })
    .filter((round): round is NonNullable<typeof round> => round !== null);
  return { rounds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface BuildPlainEventInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
  kind: ActivityEventKind;
  text: string;
  sourceSuffix: string;
  tags: string[];
}

function buildPlainEvent(input: BuildPlainEventInput): ActivityEvent {
  const actor = resolveActor(input.message);
  const sourceId = `${input.message.id}:${input.sourceSuffix}`;
  const runtime: Record<string, string> = {
    threadId: input.message.threadId,
    messageId: input.message.id,
    teamRole: input.message.role,
    activitySourceId: sourceId,
  };
  if (input.message.source?.route) runtime.route = input.message.source.route;
  return {
    id: input.newEventId(),
    missionId: input.missionId,
    tMs: input.message.createdAt,
    kind: input.kind,
    actor,
    text: input.text,
    tags: input.tags,
    runtime,
  };
}

interface BuildToolCallEventInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
  tMs: number;
  call: { id: string; name: string; input: Record<string, unknown> };
  roundNumber: number;
}

function buildToolCallEvent(input: BuildToolCallEventInput): ActivityEvent {
  const actor = resolveActor(input.message);
  const sourceId = `${input.message.id}:tool-call:${input.call.id}`;
  const text = formatToolCallText(input.call);
  return {
    id: input.newEventId(),
    missionId: input.missionId,
    tMs: input.tMs,
    kind: "tool",
    actor,
    text,
    tags: ["thread", "tool-call", input.call.name],
    runtime: {
      threadId: input.message.threadId,
      messageId: input.message.id,
      activitySourceId: sourceId,
      toolName: input.call.name,
      toolCallId: input.call.id,
      toolPhase: "call",
      round: String(input.roundNumber),
    },
  };
}

interface BuildToolResultEventInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
  tMs: number;
  result: {
    toolCallId: string;
    toolName: string;
    isError: boolean;
    contentBytes: number;
  };
  roundNumber: number;
  callName: string;
}

function buildToolResultEvent(input: BuildToolResultEventInput): ActivityEvent {
  const actor = resolveActor(input.message);
  const sourceId = `${input.message.id}:tool-result:${input.result.toolCallId}`;
  const text = input.result.isError
    ? `Tool ${input.callName} failed (${formatBytes(input.result.contentBytes)}).`
    : `Tool ${input.callName} returned (${formatBytes(input.result.contentBytes)}).`;
  const event: ActivityEvent = {
    id: input.newEventId(),
    missionId: input.missionId,
    tMs: input.tMs,
    kind: "tool",
    actor,
    text,
    tags: ["thread", "tool-result", input.result.toolName],
    runtime: {
      threadId: input.message.threadId,
      messageId: input.message.id,
      activitySourceId: sourceId,
      toolName: input.result.toolName,
      toolCallId: input.result.toolCallId,
      toolPhase: "result",
      round: String(input.roundNumber),
      contentBytes: String(input.result.contentBytes),
    },
  };
  if (input.result.isError) event.emph = "danger";
  return event;
}

function formatToolCallText(call: {
  name: string;
  input: Record<string, unknown>;
}): string {
  const argsPreview = formatToolArgs(call.input);
  return argsPreview
    ? `Calling ${call.name}(${argsPreview})`
    : `Calling ${call.name}()`;
}

function formatToolArgs(args: Record<string, unknown>): string {
  // Show one-line argument summary (truncated) — full args live in
  // metadata.toolUse on the source message if a K4 inspector wants
  // them. Goal here: enough for the user to recognise WHAT the agent
  // asked for.
  const entries = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${truncate(JSON.stringify(value), 80)}`);
  if (Object.keys(args).length > 3) entries.push(`… +${Object.keys(args).length - 3}`);
  return entries.join(", ");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveActor(message: TeamMessage): string {
  if (message.role === "user") return "user";
  if (message.roleId && message.roleId.length > 0) return message.roleId;
  if (message.name && message.name.length > 0) return message.name;
  return "agent.unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultLogger = {
  warn(message: string, context?: Record<string, unknown>): void {
    if (context) console.warn(`mission-thread-bridge: ${message}`, context);
    else console.warn(`mission-thread-bridge: ${message}`);
  },
};

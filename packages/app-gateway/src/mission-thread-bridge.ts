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

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

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
  // `findByThreadId` is no longer needed at this layer (we resolve
  // missions by direct id in tickMission and iterate via list() in
  // tickAll). Left out of the Pick to avoid pulling it implicitly
  // into mocks for no benefit.
  missionStore: Pick<MissionStore, "get" | "list">;
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

  // codex K3.5: per-mission serialization of mirror() runs. Two
  // calls for the same mission can otherwise overlap (the background
  // interval fires while a route handler also calls tickMission),
  // each snapshots the same existing-events set, and both go on to
  // append the same sourceIds — duplicating tool events on the
  // timeline. The keyed mutex makes concurrent callers queue
  // sequentially per mission, so the second pass observes the first
  // pass's appends and dedupes correctly. Different missions are
  // still parallel.
  const mirrorMutex = new KeyedAsyncMutex<string>();
  async function mirror(mission: Mission, threadId: string): Promise<number> {
    return mirrorMutex.run(mission.id, () => mirrorInner(mission, threadId));
  }

  async function mirrorInner(mission: Mission, threadId: string): Promise<number> {
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

    // gemini K3.5: collect every event to append in this tick into
    // a single list, then write them concurrently. The activity log
    // is a JSONL append per event so independent appends are safe to
    // parallelize; this cuts a tick that has N new events from
    // O(N * file-flush-latency) to ~one file-flush worth of latency.
    const toAppend: ActivityEvent[] = [];
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
        toAppend.push(event);
        if (sourceId) mirroredSourceIds.add(sourceId);
      }
    }
    if (toAppend.length === 0) return 0;
    const results = await Promise.allSettled(
      toAppend.map((event) => options.activityStore.append(event))
    );
    let appended = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        appended += 1;
      } else {
        logger.warn("activity append failed", {
          missionId: mission.id,
          eventId: toAppend[index]?.id,
          error: errorMessage(result.reason),
        });
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
    // gemini K3.5: direct by-id read instead of list().find — O(1)
    // file open vs O(N) directory scan + read of every mission JSON.
    try {
      return await options.missionStore.get(missionId);
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
      content?: string;
      contentTruncated?: boolean;
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
            ...(typeof result.content === "string" ? { content: result.content } : {}),
            ...(result.contentTruncated === true ? { contentTruncated: true } : {}),
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
  // PR K3.6: surface the inline summary (1-line, capped) AND stash
  // the full JSON args on runtime.callInput so the UI can expand
  // and show what the agent actually asked for. Without this, args
  // longer than ~80 chars (e.g. "task=Open https://example.com and
  // extract the page title and the first paragraph…") got truncated
  // on the timeline and there was no way to recover them.
  const inputJson = stableStringify(input.call.input);
  const text = formatToolCallText(input.call.name, input.call.input);
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
      callInput: inputJson,
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
    content?: string;
    contentTruncated?: boolean;
  };
  roundNumber: number;
  callName: string;
}

function buildToolResultEvent(input: BuildToolResultEventInput): ActivityEvent {
  const actor = resolveActor(input.message);
  const sourceId = `${input.message.id}:tool-result:${input.result.toolCallId}`;
  // PR K3.6: surface the actual tool result inline. Error path
  // shows the error message verbatim (the dispatcher's user-facing
  // string), success path shows a head slice big enough that the
  // user can usually see "yes the page title says X". Full result
  // (capped by the role generator at 8 kB) lives on
  // runtime.resultContent so the UI can offer an "expand" view.
  const trimmed = input.result.content?.trim() ?? "";
  const head = sliceForDisplay(trimmed, ACTIVITY_EVENT_TEXT_CAP);
  const sizeLabel = formatBytes(input.result.contentBytes);
  const text = input.result.isError
    ? trimmed
      ? `Tool ${input.callName} failed: ${head}`
      : `Tool ${input.callName} failed (${sizeLabel}).`
    : trimmed
      ? `Tool ${input.callName} returned (${sizeLabel}):\n${head}`
      : `Tool ${input.callName} returned (${sizeLabel}).`;
  const runtime: Record<string, string> = {
    threadId: input.message.threadId,
    messageId: input.message.id,
    activitySourceId: sourceId,
    toolName: input.result.toolName,
    toolCallId: input.result.toolCallId,
    toolPhase: "result",
    round: String(input.roundNumber),
    contentBytes: String(input.result.contentBytes),
  };
  if (input.result.content !== undefined) {
    runtime.resultContent = input.result.content;
  }
  if (input.result.contentTruncated) {
    runtime.resultTruncated = "true";
  }
  const event: ActivityEvent = {
    id: input.newEventId(),
    missionId: input.missionId,
    tMs: input.tMs,
    kind: "tool",
    actor,
    text,
    tags: ["thread", "tool-result", input.result.toolName],
    runtime,
  };
  if (input.result.isError) event.emph = "danger";
  return event;
}

// PR K3.6: cap for the inline `text` of any single tool event. Long
// enough to show "task=Open https://… and extract the title" or the
// first paragraph of a fetched page, short enough that the timeline
// stays readable. The UI offers an expand-for-full view via
// runtime.callInput / runtime.resultContent.
const ACTIVITY_EVENT_TEXT_CAP = 600;

function formatToolCallText(
  name: string,
  args: Record<string, unknown>
): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return `Calling ${name}()`;
  // First pass: try the pretty multi-arg single-line.
  const oneLiner = entries
    .map(([key, value]) => `${key}=${formatToolArgValue(value)}`)
    .join(", ");
  const inline = `Calling ${name}(${oneLiner})`;
  if (inline.length <= ACTIVITY_EVENT_TEXT_CAP) return inline;
  // Long-arg fallback: drop to a multi-line key=value list. The full
  // structured args live on runtime.callInput for an UI inspector.
  const lines = entries.map(
    ([key, value]) => `  ${key} = ${formatToolArgValue(value)}`
  );
  return `Calling ${name}(\n${sliceForDisplay(
    lines.join("\n"),
    ACTIVITY_EVENT_TEXT_CAP - name.length - 16
  )}\n)`;
}

function formatToolArgValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sliceForDisplay(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
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

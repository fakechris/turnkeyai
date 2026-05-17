// Bridge → Mission timeline recorder (PR K3).
//
// Kept as a thin wrapper around ActivityEventStore so the
// bridge-command-dispatcher stays a pure bridge facade. The route handler
// owns the orchestration: parse + validate mission metadata, dispatch
// the bridge command, then ask this recorder to append the resulting
// timeline event. The recorder never throws — it returns an explicit
// result so the route can surface a 502 when the browser action ran but
// the timeline write didn't.
//
// Why a separate module: the dispatcher already has too many
// responsibilities (tool whitelist, action building, transport routing,
// error classification). Adding mission orchestration inside it would
// turn it into a mission engine. Keeping the recorder beside the route
// preserves the "dispatcher executes, route records" split.

import type {
  ActivityEvent,
  ActivityEventStore,
  MissionId,
  WorkItemId,
} from "@turnkeyai/core-types/mission";
import type { Clock } from "@turnkeyai/core-types/team";

export interface BridgeMissionContext {
  missionId: MissionId;
  workItemId?: WorkItemId;
}

export type BridgeRecordResult =
  | { kind: "appended"; eventId: string }
  | { kind: "skipped"; reason: "no-mission" | "replayed" }
  | { kind: "failed"; error: string };

export interface BridgeRecordSuccessInput {
  context: BridgeMissionContext | null;
  /** True when the response was served from the idempotency cache. */
  replayed: boolean;
  tool: string;
  sessionId: string | null;
  /** Optional transport label from the dispatcher response (e.g. "direct-cdp"). */
  transportLabel?: string | null;
}

export interface BridgeRecordFailureInput {
  context: BridgeMissionContext | null;
  replayed: boolean;
  tool: string;
  sessionId: string | null;
  /**
   * Bucket name derived from the dispatcher's error code
   * (e.g. "action_timeout", "transport_unavailable", "target_missing",
   * "action_failed"). Pass `null` if the code is unknown.
   */
  bucket: string | null;
  /** Human-safe explanation copied from the dispatcher error message. */
  message: string;
}

export interface BridgeMissionActivityRecorder {
  recordSuccess(input: BridgeRecordSuccessInput): Promise<BridgeRecordResult>;
  recordFailure(input: BridgeRecordFailureInput): Promise<BridgeRecordResult>;
}

export interface BridgeMissionActivityRecorderOptions {
  activityStore: ActivityEventStore;
  /** Returns the next ActivityEvent.id. Caller can pass a daemon-wide
   *  generator or a per-test stub. */
  newEventId: () => string;
  clock: Clock;
}

export function createBridgeMissionActivityRecorder(
  options: BridgeMissionActivityRecorderOptions
): BridgeMissionActivityRecorder {
  return {
    async recordSuccess(input) {
      if (!input.context) return { kind: "skipped", reason: "no-mission" };
      if (input.replayed) return { kind: "skipped", reason: "replayed" };
      const nowMs = options.clock.now();
      const event: ActivityEvent = buildBaseEvent({
        eventId: options.newEventId(),
        missionId: input.context.missionId,
        workItemId: input.context.workItemId ?? null,
        nowMs,
        kind: "tool",
        text: `Browser ${input.tool} completed.`,
        sessionId: input.sessionId,
        tool: input.tool,
        extraRuntime: input.transportLabel
          ? { transport: input.transportLabel }
          : {},
        extraTags: [input.tool],
      });
      return safeAppend(options.activityStore, event);
    },
    async recordFailure(input) {
      if (!input.context) return { kind: "skipped", reason: "no-mission" };
      if (input.replayed) return { kind: "skipped", reason: "replayed" };
      const nowMs = options.clock.now();
      const bucket = input.bucket ?? "action_failed";
      const event: ActivityEvent = buildBaseEvent({
        eventId: options.newEventId(),
        missionId: input.context.missionId,
        workItemId: input.context.workItemId ?? null,
        nowMs,
        kind: "recovery",
        text: input.message || `Browser ${input.tool} failed.`,
        sessionId: input.sessionId,
        tool: input.tool,
        emph: "danger",
        extraRuntime: { bucket },
        extraTags: [input.tool, bucket],
      });
      return safeAppend(options.activityStore, event);
    },
  };
}

interface BuildBaseEventInput {
  eventId: string;
  missionId: MissionId;
  workItemId: WorkItemId | null;
  nowMs: number;
  kind: ActivityEvent["kind"];
  text: string;
  sessionId: string | null;
  tool: string;
  emph?: ActivityEvent["emph"];
  extraRuntime: Record<string, string>;
  extraTags: string[];
}

function buildBaseEvent(input: BuildBaseEventInput): ActivityEvent {
  const runtime: Record<string, string> = {
    tool: input.tool,
    ...input.extraRuntime,
  };
  if (input.sessionId) runtime.sessionId = input.sessionId;
  if (input.workItemId) runtime.workItemId = input.workItemId;
  const event: ActivityEvent = {
    id: input.eventId,
    missionId: input.missionId,
    t: formatDisplayTime(input.nowMs),
    tMs: input.nowMs,
    kind: input.kind,
    actor: "agent.browser",
    text: input.text,
    tags: ["browser", "bridge", ...input.extraTags],
    runtime,
  };
  if (input.sessionId) {
    event.target = browserSessionContextId(input.sessionId);
  }
  if (input.emph) event.emph = input.emph;
  return event;
}

/**
 * Synthesize a stable ContextSourceId for the browser session. We don't
 * yet have a durable ContextSource record per session — K3 only enumerates
 * live sessions on read. Using a deterministic id here means a future
 * registry can adopt the same scheme without rewriting historical events.
 */
export function browserSessionContextId(sessionId: string): string {
  return `ctx.browser.session.${sessionId}`;
}

function formatDisplayTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

async function safeAppend(
  store: ActivityEventStore,
  event: ActivityEvent
): Promise<BridgeRecordResult> {
  try {
    await store.append(event);
    return { kind: "appended", eventId: event.id };
  } catch (error) {
    return {
      kind: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

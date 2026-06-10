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
// Cost: O(M × (T + A + W)) per tick where M = missions with threadId,
// T = messages per thread, A = activity events per mission, and W =
// worker sessions when lifecycle reconciliation is enabled. K3.5 demo
// workloads keep these small. Revisit with per-thread indexes/cursors
// when missions run long-form.

import path from "node:path";

import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

import type {
  ActivityEvent,
  ActivityEventKind,
  ActivityEventStore,
  Artifact,
  ArtifactStore,
  Mission,
  MissionStore,
} from "@turnkeyai/core-types/mission";
import type {
  BrowserArtifactRecord,
  BrowserArtifactStore,
  Clock,
  RoleRunStore,
  TeamMessage,
  TeamMessageStore,
  WorkerSessionRecord,
  WorkerSessionStore,
} from "@turnkeyai/core-types/team";
import {
  evaluateMissionCompletion,
  type MissionCompletionRecovery,
} from "./mission-completion-evaluator";

export interface MissionThreadBridgeOptions {
  // `findByThreadId` is no longer needed at this layer (we resolve
  // missions by direct id in tickMission and iterate via list() in
  // tickAll). Left out of the Pick to avoid pulling it implicitly
  // into mocks for no benefit.
  missionStore: MissionThreadBridgeMissionStore;
  roleRunStore?: Pick<RoleRunStore, "listByThread">;
  workerSessionStore?: Pick<WorkerSessionStore, "list">;
  teamMessageStore: Pick<TeamMessageStore, "list">;
  activityStore: Pick<ActivityEventStore, "append" | "listByMission">;
  artifactStore?: Pick<ArtifactStore, "put" | "listByMission">;
  browserArtifactStore?: Pick<BrowserArtifactStore, "get">;
  newEventId: () => string;
  clock: Clock;
  /** Max messages to scan per thread per tick. K3.5 demo threads stay
   *  small; this guards against pathologically long backlogs. */
  perThreadLimit?: number;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

type MissionThreadBridgeMissionStore = Pick<MissionStore, "get" | "list"> & {
  putRaw(mission: Mission): Promise<void>;
};

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
    const consumedMessageIds = new Set<string>();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (consumedMessageIds.has(message.id)) continue;
      const splitToolResults =
        isNativeSplitToolEnvelope(message)
          ? collectNativeSplitToolResults(messages, index, message)
          : new Map<string, TeamMessage>();
      for (const resultMessage of splitToolResults.values()) {
        consumedMessageIds.add(resultMessage.id);
      }
      const expanded = expandMessage({
        missionId: mission.id,
        message,
        newEventId: options.newEventId,
        splitToolResults,
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
    let appended = 0;
    if (toAppend.length > 0) {
      const results = await Promise.allSettled(
        toAppend.map((event) => options.activityStore.append(event))
      );
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
    }
    await registerMissionArtifacts(mission, messages);
    await reconcileMissionLifecycle(mission, threadId, messages);
    return appended;
  }

  async function registerMissionArtifacts(
    mission: Mission,
    messages: TeamMessage[]
  ): Promise<void> {
    if (!options.artifactStore || !options.browserArtifactStore) {
      return;
    }
    const artifactIds = collectBrowserArtifactIds(messages);
    if (artifactIds.length === 0) {
      return;
    }
    let existing: Artifact[];
    try {
      existing = await options.artifactStore.listByMission(mission.id);
    } catch (error) {
      logger.warn("mission artifact list failed", {
        missionId: mission.id,
        error: errorMessage(error),
      });
      return;
    }
    const existingIds = new Set(existing.map((artifact) => artifact.id));
    await Promise.allSettled(
      artifactIds
        .filter((artifactId) => !existingIds.has(artifactId))
        .map(async (artifactId) => {
          const record = await options.browserArtifactStore!.get(artifactId);
          if (!record) {
            return;
          }
          await options.artifactStore!.put(toMissionArtifact(mission.id, record));
        })
    ).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          logger.warn("mission artifact registration failed", {
            missionId: mission.id,
            error: errorMessage(result.reason),
          });
        }
      }
    });
  }

  async function reconcileMissionLifecycle(
    mission: Mission,
    threadId: string,
    messages: TeamMessage[]
  ): Promise<void> {
    const roleRuns = await listRoleRuns(threadId);
    const decision = evaluateMissionCompletion({
      mission,
      messages,
      roleRuns,
      workerSessions: await listWorkerSessions(threadId),
    });
    if (decision.action !== "update") return;
    await updateMissionLifecycle(mission, decision.patch);
    if (decision.recovery) {
      await appendMissionRecoveryEvent(mission.id, threadId, decision.recovery);
    }
  }

  async function updateMissionLifecycle(
    mission: Mission,
    patch: Partial<Pick<Mission, "status" | "progress" | "blockers" | "pendingApprovals" | "closeout">>
  ): Promise<void> {
    try {
      const latest = (await options.missionStore.get(mission.id)) ?? mission;
      const canReopenDoneForPendingApproval =
        latest.status === "done" && patch.status === "needs_approval" && latest.pendingApprovals > 0;
      if (
        !canReopenDoneForPendingApproval &&
        (latest.status === "done" || latest.status === "archived" || latest.status === "draft")
      ) {
        return;
      }
      await options.missionStore.putRaw({
        ...latest,
        ...patch,
      });
    } catch (error) {
      logger.warn("mission lifecycle update failed", {
        missionId: mission.id,
        error: errorMessage(error),
      });
    }
  }

  async function listRoleRuns(threadId: string) {
    if (!options.roleRunStore) return "unknown" as const;
    try {
      return await options.roleRunStore.listByThread(threadId);
    } catch (error) {
      logger.warn("role run list failed for mission lifecycle reconciliation", {
        threadId,
        error: errorMessage(error),
      });
      return "unknown" as const;
    }
  }

  async function listWorkerSessions(threadId: string): Promise<WorkerSessionRecord[] | "unknown" | undefined> {
    if (!options.workerSessionStore) return undefined;
    try {
      const sessions = await options.workerSessionStore.list();
      return sessions.filter((session) => session.context?.threadId === threadId);
    } catch (error) {
      logger.warn("worker session list failed for mission lifecycle reconciliation", {
        threadId,
        error: errorMessage(error),
      });
      return "unknown" as const;
    }
  }

  async function appendMissionRecoveryEvent(
    missionId: string,
    threadId: string,
    recovery: MissionCompletionRecovery
  ): Promise<void> {
    if (recovery.kind === "incomplete_final_answer") {
      await appendMissionIncompleteFinalEvent(missionId, threadId, recovery);
      return;
    }
    await appendMissionStalledEvent(missionId, threadId, recovery);
  }

  async function appendMissionStalledEvent(
    missionId: string,
    threadId: string,
    stalled: Extract<MissionCompletionRecovery, { kind: "stalled_tool_turn" }>
  ): Promise<void> {
    try {
      await options.activityStore.append({
        id: `mission-stalled:${missionId}:${stalled.message.id}:${options.clock.now()}`,
        missionId,
        tMs: options.clock.now(),
        kind: "recovery",
        actor: "system",
        text: "mission.stalled_no_final_answer",
        emph: "danger",
        tags: ["mission_stalled", stalled.status],
        runtime: {
          eventType: "mission.stalled_no_final_answer",
          threadId,
          messageId: stalled.message.id,
          toolStatus: stalled.status,
        },
      });
    } catch (error) {
      logger.warn("mission stalled event append failed", {
        missionId,
        messageId: stalled.message.id,
        error: errorMessage(error),
      });
    }
  }

  async function appendMissionIncompleteFinalEvent(
    missionId: string,
    threadId: string,
    incomplete: Extract<MissionCompletionRecovery, { kind: "incomplete_final_answer" }>
  ): Promise<void> {
    try {
      const runtime: Record<string, string> = {
        eventType: "mission.incomplete_final_answer",
        threadId,
        messageId: incomplete.message.id,
        reason: incomplete.reason,
      };
      const stopReason = readStringMetadata(incomplete.message.metadata, "stopReason");
      if (stopReason) {
        runtime.stopReason = stopReason;
      }
      await options.activityStore.append({
        id: `mission-incomplete-final:${missionId}:${incomplete.message.id}:${options.clock.now()}`,
        missionId,
        tMs: options.clock.now(),
        kind: "recovery",
        actor: "system",
        text: "mission.incomplete_final_answer",
        emph: "danger",
        tags: ["mission_incomplete_final", incomplete.reason],
        runtime,
      });
    } catch (error) {
      logger.warn("mission incomplete final event append failed", {
        missionId,
        messageId: incomplete.message.id,
        error: errorMessage(error),
      });
    }
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

function readStringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function readRecordMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toolLoopCloseoutRuntime(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const closeout = readRecordMetadata(metadata, "toolLoopCloseout");
  const reason = typeof closeout?.reason === "string" ? closeout.reason : undefined;
  if (!closeout || !reason) {
    return {};
  }
  const runtime: Record<string, string> = {
    toolLoopCloseout: "true",
    toolLoopCloseoutReason: reason,
  };
  for (const key of [
    "toolCallCount",
    "roundCount",
    "maxRounds",
    "maxWallClockMs",
    "pendingToolCallCount",
    "toolName",
    "timeoutSeconds",
    "evidenceAvailable",
    "finalContentCount",
  ]) {
    const value = closeout[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      runtime[`toolLoopCloseout.${key}`] = String(value);
    }
  }
  return runtime;
}

interface ExpandMessageInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
  splitToolResults?: Map<string, TeamMessage>;
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
    const admission = readStringMetadata(message.metadata, "admission");
    const event = buildPlainEvent({
      ...input,
      kind: "tool",
      text: message.content,
      sourceSuffix: "tool",
      tags: ["thread", "tool"],
    });
    if (message.toolCallId) {
      event.runtime = {
        ...(event.runtime ?? {}),
        toolName: message.name,
        toolCallId: message.toolCallId,
        toolPhase: "result",
        resultContent: message.content,
        ...sessionToolSourceRuntime(message.content),
        ...(admission ? { admission } : {}),
      };
      if (admission !== "skipped" && (message.toolStatus === "failed" || message.toolStatus === "cancelled")) {
        event.emph = "danger";
      }
    }
    return [event];
  }
  if (message.role !== "assistant") {
    // system: silent — internal scaffolding doesn't belong on the user timeline.
    return [];
  }

  const events: ActivityEvent[] = [];
  const splitToolResults = input.splitToolResults ?? new Map<string, TeamMessage>();
  const toolUse =
    extractNativeToolUseTrace(message, {
      includeResults: !isNativeSplitToolEnvelope(message) || splitToolResults.size === 0,
    }) ?? extractToolUseTrace(message.metadata);
  if (toolUse && toolUse.rounds.length > 0) {
    // The final answer is timestamped at message.createdAt. Push the
    // tool events backwards in time using small fractional offsets so
    // the timeline order is preserved when sorting by tMs (the
    // dashboard's primary sort). Steps further back than total
    // rounds*2 events would never land before the previous message;
    // in practice 8 rounds × 2 events ≪ a single second, so the math
    // works out to sub-second offsets.
    const totalSubEvents = toolUse.rounds.reduce(
      (sum, round) =>
        sum +
        round.calls.length +
        round.progress.length +
        round.results.length +
        round.calls.filter((call) => splitToolResults.has(call.id)).length,
      0
    );
    let stepIndex = 0;
    for (const round of toolUse.rounds) {
      const resultsByCallId = new Map(round.results.map((result) => [result.toolCallId, result]));
      const emittedResultCallIds = new Set<string>();
      const progressByCallId = new Map<string, typeof round.progress>();
      const emittedProgress = new Set<(typeof round.progress)[number]>();
      for (const progress of round.progress) {
        const existing = progressByCallId.get(progress.toolCallId) ?? [];
        existing.push(progress);
        progressByCallId.set(progress.toolCallId, existing);
      }
      for (const entries of progressByCallId.values()) {
        entries.sort((left, right) => left.ts - right.ts);
      }
      const skippedProgressCallIds = new Set(
        round.progress
          .filter((progress) => progress.detail?.["admission"] === "skipped")
          .map((progress) => progress.toolCallId)
      );
      for (const call of round.calls) {
        const matchingResult = resultsByCallId.get(call.id);
        const splitResultMessage = splitToolResults.get(call.id);
        const skippedByAdmission = matchingResult?.skipped === true || skippedProgressCallIds.has(call.id);
        if (!shouldDelaySessionCallUntilResolved(call, matchingResult, splitResultMessage)) {
          events.push(
            buildToolCallEvent({
              ...input,
              tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
              call,
              ...(matchingResult ? { result: matchingResult } : {}),
              ...(splitResultMessage?.content ? { resultContent: splitResultMessage.content } : {}),
              roundNumber: round.round,
              ...(skippedByAdmission ? { admission: "skipped" } : matchingResult ? { admission: "admitted" } : {}),
            })
          );
          stepIndex += 1;
        }
        for (const progress of progressByCallId.get(call.id) ?? []) {
          events.push(
            buildToolProgressEvent({
              ...input,
              tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
              progress,
              roundNumber: round.round,
              progressOrdinal: stepIndex,
            })
          );
          emittedProgress.add(progress);
          stepIndex += 1;
        }
        if (matchingResult) {
          events.push(
            buildToolResultEvent({
              ...input,
              tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
              result: matchingResult,
              roundNumber: round.round,
              callName: call.name,
              sourceLabel: readToolCallSourceLabel(call.input),
            })
          );
          emittedResultCallIds.add(matchingResult.toolCallId);
          stepIndex += 1;
        } else if (splitResultMessage) {
          events.push(
            buildSplitToolResultEvent({
              ...input,
              message: splitResultMessage,
              tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
              call,
              roundNumber: round.round,
              sourceLabel: readToolCallSourceLabel(call.input),
            })
          );
          stepIndex += 1;
        }
      }
      for (const progress of round.progress) {
        if (emittedProgress.has(progress)) continue;
        events.push(
          buildToolProgressEvent({
            ...input,
            tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
            progress,
            roundNumber: round.round,
            progressOrdinal: stepIndex,
          })
        );
        stepIndex += 1;
      }
      for (const result of round.results) {
        if (emittedResultCallIds.has(result.toolCallId)) continue;
        const matchingCall = round.calls.find((call) => call.id === result.toolCallId);
        events.push(
          buildToolResultEvent({
            ...input,
            tMs: tMsForStep(message.createdAt, stepIndex, totalSubEvents),
            result,
            roundNumber: round.round,
            callName: matchingCall?.name ?? result.toolName,
            sourceLabel: readToolCallSourceLabel(matchingCall?.input),
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
      skipped?: boolean;
    }>;
    progress: Array<{
      toolCallId: string;
      toolName: string;
      phase: "started" | "progress" | "completed" | "failed" | "cancelled";
      summary: string;
      detail?: Record<string, unknown>;
      ts: number;
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
            ...(result.skipped === true ? { skipped: true } : {}),
          }))
        : [];
      const progress = Array.isArray(round.progress)
        ? round.progress.filter(isRecord).map((event) => ({
            toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
            toolName: typeof event.toolName === "string" ? event.toolName : "",
            phase: parseToolProgressPhase(event.phase),
            summary: typeof event.summary === "string" ? event.summary : "",
            ...(isRecord(event.detail) ? { detail: event.detail } : {}),
            ts: typeof event.ts === "number" ? event.ts : 0,
          }))
        : [];
      return {
        round: typeof round.round === "number" ? round.round : 0,
        calls,
        results,
        progress: progress.filter((event) => event.toolCallId && event.toolName && event.summary),
      };
    })
    .filter((round): round is NonNullable<typeof round> => round !== null);
  return { rounds };
}

function extractNativeToolUseTrace(
  message: TeamMessage,
  options: { includeResults?: boolean } = {}
): ToolUseTrace | null {
  if (!message.toolCalls?.length) return null;
  const calls = message.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    input: call.arguments,
  }));
  const results =
    options.includeResults === false
      ? []
      : (message.toolProgress ?? [])
          .filter((progress) => progress.phase === "completed" || progress.phase === "failed" || progress.phase === "cancelled")
          .map((progress) => ({
            toolCallId: progress.toolCallId,
            toolName: progress.toolName,
            isError: progress.phase === "failed" || progress.phase === "cancelled",
            contentBytes: typeof progress.detail?.contentBytes === "number" ? progress.detail.contentBytes : 0,
            ...(progress.summary ? { content: progress.summary } : {}),
            ...(progress.detail?.contentTruncated === true ? { contentTruncated: true } : {}),
            ...(progress.detail?.["admission"] === "skipped" ? { skipped: true } : {}),
          }));
  const progress = (message.toolProgress ?? [])
    .filter(isUserVisibleToolProgress)
    .map((event) => ({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      phase: event.phase,
      summary: event.summary,
      ...(event.detail ? { detail: event.detail } : {}),
      ts: event.ts,
    }));
  return {
    rounds: [
      {
        round: readNumber(message.metadata, "toolRound") ?? 1,
        calls,
        results,
        progress,
      },
    ],
  };
}

function parseToolProgressPhase(value: unknown): ToolUseTrace["rounds"][number]["progress"][number]["phase"] {
  switch (value) {
    case "started":
    case "progress":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "progress";
  }
}

function isUserVisibleToolProgress(event: NonNullable<TeamMessage["toolProgress"]>[number]): boolean {
  return event.phase === "progress" && typeof event.summary === "string" && event.summary.trim().length > 0;
}

function sessionToolSourceRuntime(content: string | undefined): Record<string, string> {
  const label = readSessionToolSourceLabel(content);
  return label ? { sourceLabel: label } : {};
}

function readToolCallSourceLabel(input: Record<string, unknown> | undefined): string | null {
  const label = input?.label;
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

function readSessionToolSourceLabel(content: string | undefined): string | null {
  if (!content?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.protocol !== "turnkeyai.session_tool_result.v1") {
    return null;
  }
  const label = parsed.label;
  return typeof label === "string" && label.trim() ? label.trim() : null;
}

function isNativeSplitToolEnvelope(message: TeamMessage): boolean {
  return isRecord(message.metadata) && message.metadata.nativeToolUse === true;
}

function collectNativeSplitToolResults(
  messages: TeamMessage[],
  assistantIndex: number,
  assistantMessage: TeamMessage
): Map<string, TeamMessage> {
  const remaining = new Set((assistantMessage.toolCalls ?? []).map((call) => call.id));
  const results = new Map<string, TeamMessage>();
  if (remaining.size === 0) return results;
  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "tool") break;
    const toolCallId = message.toolCallId;
    if (!toolCallId || !remaining.has(toolCallId)) continue;
    results.set(toolCallId, message);
    remaining.delete(toolCallId);
    if (remaining.size === 0) break;
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
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
  Object.assign(runtime, toolLoopCloseoutRuntime(input.message.metadata));
  Object.assign(runtime, modelUseRuntime(input.message.metadata));
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

function modelUseRuntime(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const modelUse = readRecordMetadata(metadata, "modelUse");
  if (!modelUse) return {};
  const calls = Array.isArray(modelUse.calls) ? modelUse.calls : [];
  const runtime: Record<string, string> = {
    modelCallSource: "turnkeyai-role-runtime",
    modelCallCount: String(readNumber(modelUse, "callCount") ?? calls.length),
  };
  const totalInputTokens = readNumber(modelUse, "totalInputTokens");
  const totalOutputTokens = readNumber(modelUse, "totalOutputTokens");
  if (totalInputTokens !== null) runtime.modelInputTokens = String(totalInputTokens);
  if (totalOutputTokens !== null) runtime.modelOutputTokens = String(totalOutputTokens);
  if (calls.length > 0) {
    runtime.modelCallBoundaries = JSON.stringify(calls);
  }
  return runtime;
}

interface BuildToolCallEventInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
  tMs: number;
  call: { id: string; name: string; input: Record<string, unknown> };
  result?: ToolUseTrace["rounds"][number]["results"][number];
  resultContent?: string;
  roundNumber: number;
  admission?: "admitted" | "skipped";
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
  // gemini K3.6: cap callInput at 16 kB so a pathological agent
  // sending a multi-MB blob doesn't bloat the activity log (which
  // is read whole into memory on the dashboard's polling tick).
  // 16 kB is generous enough for real-world tool args.
  const callInput = canonicalizeDisplayedToolCallInput(input.call, input.result?.content ?? input.resultContent);
  const inputJson = capJsonString(safeStringify(callInput), CALL_INPUT_CAP_BYTES);
  const text = formatToolCallText(input.call.name, callInput);
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
      ...(input.admission ? { admission: input.admission } : {}),
    },
  };
}

function shouldDelaySessionCallUntilResolved(
  call: { id: string; name: string; input: Record<string, unknown> },
  result: ToolUseTrace["rounds"][number]["results"][number] | undefined,
  splitResultMessage: TeamMessage | undefined
): boolean {
  if (result || splitResultMessage || (call.name !== "sessions_send" && call.name !== "sessions_history")) {
    return false;
  }
  const sessionKey = call.input.session_key;
  return typeof sessionKey === "string" && isNoisyContinuationKey(sessionKey);
}

function canonicalizeDisplayedToolCallInput(
  call: { id: string; name: string; input: Record<string, unknown> },
  resultContent: string | undefined
): Record<string, unknown> {
  if (call.name !== "sessions_send" && call.name !== "sessions_history") {
    return call.input;
  }
  const sessionKey = readSessionKeyFromToolResult(resultContent);
  if (!sessionKey || call.input.session_key === sessionKey) {
    return call.input;
  }
  return {
    ...call.input,
    session_key: sessionKey,
  };
}

function isNoisyContinuationKey(sessionKey: string): boolean {
  return /…|\.{3}|\n|\|/.test(sessionKey) || /\bcall_func(?:t(?:ion)?)?(?=…|\.{3})/.test(sessionKey);
}

function readSessionKeyFromToolResult(content: string | undefined): string | null {
  if (!content?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const sessionKey = parsed["session_key"];
  return typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
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
    skipped?: boolean;
  };
  roundNumber: number;
  callName: string;
  sourceLabel?: string | null;
}

interface BuildToolProgressEventInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
  tMs: number;
  progress: {
    toolCallId: string;
    toolName: string;
    phase: "started" | "progress" | "completed" | "failed" | "cancelled";
    summary: string;
    detail?: Record<string, unknown>;
    ts: number;
  };
  roundNumber: number;
  progressOrdinal: number;
}

interface BuildSplitToolResultEventInput {
  missionId: string;
  message: TeamMessage;
  newEventId: () => string;
  tMs: number;
  call: { id: string; name: string; input: Record<string, unknown> };
  roundNumber: number;
  sourceLabel?: string | null;
}

function buildToolProgressEvent(input: BuildToolProgressEventInput): ActivityEvent {
  const actor = resolveActor(input.message);
  const sourceId = `${input.message.id}:tool-progress:${input.progress.toolCallId}:${input.progressOrdinal}`;
  const runtime: Record<string, string> = {
    threadId: input.message.threadId,
    messageId: input.message.id,
    activitySourceId: sourceId,
    toolName: input.progress.toolName,
    toolCallId: input.progress.toolCallId,
    toolPhase: "progress",
    progressPhase: input.progress.phase,
    round: String(input.roundNumber),
  };
  if (input.progress.detail) {
    const detail = capUtf8String(safeStringify(input.progress.detail), CALL_INPUT_CAP_BYTES);
    runtime.progressDetail = detail.value;
    if (detail.truncated) {
      runtime.progressTruncated = "true";
    }
    if (input.progress.detail["admission"] === "skipped") {
      runtime.admission = "skipped";
    }
  }
  const event: ActivityEvent = {
    id: input.newEventId(),
    missionId: input.missionId,
    tMs: input.tMs,
    kind: "tool",
    actor,
    text: `Tool ${input.progress.toolName} progress: ${sliceForDisplay(input.progress.summary, ACTIVITY_EVENT_TEXT_CAP)}`,
    tags: ["thread", "tool-progress", input.progress.toolName, input.progress.phase],
    runtime,
  };
  if (
    input.progress.detail?.["admission"] !== "skipped" &&
    (input.progress.phase === "failed" || input.progress.phase === "cancelled")
  ) {
    event.emph = "danger";
  }
  return event;
}

function buildSplitToolResultEvent(input: BuildSplitToolResultEventInput): ActivityEvent {
  const actor = resolveActor(input.message);
  const toolName = input.message.name || input.call.name;
  const toolCallId = input.message.toolCallId ?? input.call.id;
  const admission = readStringMetadata(input.message.metadata, "admission");
  const contentBytes = Buffer.byteLength(input.message.content, "utf8");
  const failed = input.message.toolStatus === "failed" || input.message.toolStatus === "cancelled";
  const trimmed = input.message.content.trim();
  const head = sliceForDisplay(trimmed, ACTIVITY_EVENT_TEXT_CAP);
  const sizeLabel = formatBytes(contentBytes);
  const text =
    admission === "skipped"
      ? trimmed
        ? `Tool ${toolName} skipped by runtime budget: ${head}`
        : `Tool ${toolName} skipped by runtime budget.`
      : failed
        ? trimmed
          ? `Tool ${toolName} failed: ${head}`
          : `Tool ${toolName} failed (${sizeLabel}).`
        : trimmed
          ? `Tool ${toolName} returned (${sizeLabel}):\n${head}`
          : `Tool ${toolName} returned (${sizeLabel}).`;
  const sourceId = `${input.message.id}:tool`;
  const runtime: Record<string, string> = {
    threadId: input.message.threadId,
    messageId: input.message.id,
    teamRole: input.message.role,
    activitySourceId: sourceId,
    toolName,
    toolCallId,
    toolPhase: "result",
    resultContent: input.message.content,
    ...sessionToolSourceRuntime(input.message.content),
    round: String(input.roundNumber),
    contentBytes: String(contentBytes),
    ...(admission ? { admission } : {}),
  };
  if (input.message.source?.route) runtime.route = input.message.source.route;
  if (input.sourceLabel && !runtime.sourceLabel) runtime.sourceLabel = input.sourceLabel;
  const event: ActivityEvent = {
    id: input.newEventId(),
    missionId: input.missionId,
    tMs: input.tMs,
    kind: "tool",
    actor,
    text,
    tags: ["thread", "tool-result", toolName],
    runtime,
  };
  if (admission !== "skipped" && failed) {
    event.emph = "danger";
  }
  return event;
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
  const text = input.result.skipped
    ? trimmed
      ? `Tool ${input.callName} skipped by runtime budget: ${head}`
      : `Tool ${input.callName} skipped by runtime budget.`
    : input.result.isError
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
    ...(input.result.skipped ? { admission: "skipped" } : {}),
  };
  if (input.result.content !== undefined) {
    runtime.resultContent = input.result.content;
    Object.assign(runtime, sessionToolSourceRuntime(input.result.content));
  }
  if (input.sourceLabel && !runtime.sourceLabel) runtime.sourceLabel = input.sourceLabel;
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
  if (input.result.isError && !input.result.skipped) event.emph = "danger";
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
    // gemini K3.6: guard against negative max when a tool name is
    // unusually long — `value.slice(0, -N)` would slice from the
    // END and return garbage. Clamp to 0 as the safe floor.
    Math.max(0, ACTIVITY_EVENT_TEXT_CAP - name.length - 16)
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

// gemini K3.6: previously named `stableStringify` but did NOT
// actually order keys deterministically. Renamed to `safeStringify`
// to match its real behavior (catch-and-return-empty-object on
// circular-reference failure).
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

// PR K3.6: 16 kB ceiling for the persisted call args JSON. Matches
// the spirit of ROLE_TOOL_RESULT_TRACE_CAP_BYTES upstream — keeps
// the activity log bounded so the dashboard's polling read of
// listByMission stays cheap.
const CALL_INPUT_CAP_BYTES = 16 * 1024;

// Truncation suffix appended to over-budget JSON strings. Same byte
// width is reserved BEFORE slicing so the returned value still
// honors `maxBytes` strictly (coderabbit + gemini K3.6).
const CAP_SUFFIX = "…[truncated]";
const CAP_SUFFIX_BYTES = Buffer.byteLength(CAP_SUFFIX, "utf8");

function capJsonString(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  // Reserve room for the suffix so total bytes stay <= maxBytes.
  const sliceBudget = Math.max(0, maxBytes - CAP_SUFFIX_BYTES);
  let end = sliceBudget;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  // The slice is no longer valid JSON, but the UI inspector parses
  // defensively and falls through to a raw text view when JSON
  // parsing fails — that's preferable to truncating silently.
  return `${buffer.subarray(0, end).toString("utf8")}${CAP_SUFFIX}`;
}

function capUtf8String(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { value, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { value: buffer.subarray(0, end).toString("utf8"), truncated: true };
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

function collectBrowserArtifactIds(messages: TeamMessage[]): string[] {
  const artifactIds = new Set<string>();
  for (const message of messages) {
    addArtifactIds(artifactIds, readRecordMetadata(message.metadata, "workerPayload"));
    addArtifactIds(artifactIds, readSessionToolPayload(message.content));
    const toolUse = readRecordMetadata(message.metadata, "toolUse");
    const rounds = Array.isArray(toolUse?.rounds) ? toolUse.rounds : [];
    for (const round of rounds) {
      if (!isRecord(round) || !Array.isArray(round.results)) {
        continue;
      }
      for (const result of round.results) {
        if (!isRecord(result) || typeof result.content !== "string") {
          continue;
        }
        addArtifactIds(artifactIds, readSessionToolPayload(result.content));
      }
    }
  }
  return [...artifactIds];
}

function addArtifactIds(target: Set<string>, payload: Record<string, unknown> | null | undefined): void {
  if (!payload || !Array.isArray(payload.artifactIds)) {
    return;
  }
  for (const artifactId of payload.artifactIds) {
    if (typeof artifactId === "string" && artifactId.trim()) {
      target.add(artifactId.trim());
    }
  }
}

function readSessionToolPayload(content: string | undefined): Record<string, unknown> | null {
  if (!content?.trim()) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.protocol !== "turnkeyai.session_tool_result.v1") {
    return null;
  }
  return isRecord(parsed.payload) ? parsed.payload : null;
}

function toMissionArtifact(missionId: string, record: BrowserArtifactRecord): Artifact {
  return {
    id: record.artifactId,
    missionId,
    label: buildBrowserArtifactLabel(record),
    kind: missionArtifactKind(record.type),
    path: record.path,
    ...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
    createdAtMs: record.createdAt,
    ...(record.lifecycle
      ? {
          lifecycle: {
            storageBackend: record.lifecycle.storageBackend,
            refType: record.lifecycle.refType,
            retentionMs: record.lifecycle.retentionMs,
            expiresAtMs: record.lifecycle.expiresAt,
            maxArtifactBytes: record.lifecycle.maxArtifactBytes,
            sessionBudgetBytes: record.lifecycle.sessionBudgetBytes,
            cleanupOnSessionClose: record.lifecycle.cleanupOnSessionClose,
            orphanReconciliation: record.lifecycle.orphanReconciliation,
          },
        }
      : {}),
  };
}

function buildBrowserArtifactLabel(record: BrowserArtifactRecord): string {
  const label = readString(record.metadata?.label);
  if (label) {
    return label;
  }
  const filename = path.basename(record.path);
  return filename || record.artifactId;
}

function missionArtifactKind(recordType: BrowserArtifactRecord["type"]): Artifact["kind"] {
  switch (recordType) {
    case "snapshot":
      return "snapshot";
    case "screenshot":
      return "screenshot";
    case "console-result":
    case "trace":
      return "json";
    default:
      return "other";
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

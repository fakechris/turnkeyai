// Translate team-runtime thread messages into mission ActivityEvents
// (PR K3.5). Polling-based: every tick, scan each mission-linked
// thread for messages that haven't been mirrored onto the mission
// timeline yet, append the missing ones.
//
// Runtime role replies now publish message.posted events, so daemon event
// subscribers can call tickThread for fast UI/lifecycle convergence. Polling
// remains the durable catch-up path across daemon restarts and missed events.
//
// Idempotency: each ActivityEvent records `runtime.messageId`. On
// every tick we read the existing activity events and skip any source
// messageId we've already mirrored. Restarting the daemon never
// duplicates events, and a missed tick just means the next tick picks
// up the backlog.
//
// Cost: O(M × (T + A + W)) per tick where M = missions selected for the
// pass, T = messages per thread, A = activity events per mission, and W =
// worker sessions when lifecycle reconciliation is enabled. The pass
// prioritizes active/recent missions so a large backlog of old mission files
// cannot starve the mission the user is watching.

import { createHash } from "node:crypto";
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
  RoleRunState,
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
import { evaluateMissionGoalSlotCoverage } from "./mission-goal-slot-coverage";

export interface MissionThreadBridgeOptions {
  // `findByThreadId` is no longer needed at this layer (we resolve
  // missions by direct id in tickMission and iterate via list() in
  // tickAll). Left out of the Pick to avoid pulling it implicitly
  // into mocks for no benefit.
  missionStore: MissionThreadBridgeMissionStore;
  roleRunStore?: Pick<RoleRunStore, "listByThread">;
  workerSessionStore?: Pick<WorkerSessionStore, "list" | "listByThread">;
  teamMessageStore: Pick<TeamMessageStore, "list">;
  activityStore: Pick<ActivityEventStore, "append" | "listByMission" | "replaceAll">;
  artifactStore?: Pick<ArtifactStore, "put" | "listByMission">;
  browserArtifactStore?: Pick<BrowserArtifactStore, "get">;
  newEventId: () => string;
  clock: Clock;
  /** Max messages to scan per thread per tick. K3.5 demo threads stay
   *  small; this guards against pathologically long backlogs. */
  perThreadLimit?: number;
  /** Max linked missions to scan per interval tick. Active/recent missions
   *  are prioritized before this cap is applied. */
  maxMissionsPerTick?: number;
  /** Max automatic continuations after a lead final answer fails goal-slot coverage. */
  maxIncompleteFinalFollowUps?: number;
  postLateWorkerCompletionFollowUp?: (input: {
    mission: Mission;
    threadId: string;
    workerSessions: readonly WorkerSessionRecord[];
    deliveryId: string;
    content: string;
  }) => Promise<void>;
  postIncompleteFinalFollowUp?: (input: {
    mission: Mission;
    threadId: string;
    recovery: Extract<MissionCompletionRecovery, { kind: "incomplete_final_answer" }>;
    content: string;
  }) => Promise<void>;
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
   * Scan missions linked to a specific team-runtime thread. Daemon event
   * subscribers use this to mirror fresh role/tool output immediately without
   * polling every mission.
   */
  tickThread?(threadId: string): Promise<Array<{ missionId: string; appended: number }>>;
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
  const maxMissionsPerTick =
    typeof options.maxMissionsPerTick === "number" &&
    Number.isFinite(options.maxMissionsPerTick) &&
    options.maxMissionsPerTick > 0
      ? Math.floor(options.maxMissionsPerTick)
      : DEFAULT_MAX_MISSIONS_PER_TICK;
  const maxIncompleteFinalFollowUps =
    typeof options.maxIncompleteFinalFollowUps === "number" &&
    Number.isFinite(options.maxIncompleteFinalFollowUps) &&
    options.maxIncompleteFinalFollowUps >= 0
      ? Math.floor(options.maxIncompleteFinalFollowUps)
      : DEFAULT_MAX_INCOMPLETE_FINAL_FOLLOW_UPS;
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
    const mirroredToolResultEvents = new Map<string, ActivityEvent>();
    for (const event of existing) {
      const sourceId = event.runtime?.activitySourceId;
      if (typeof sourceId === "string" && sourceId.length > 0) {
        mirroredSourceIds.add(sourceId);
      }
      const toolResultKey = toolResultSemanticKey(event);
      if (toolResultKey) {
        mirroredToolResultEvents.set(toolResultKey, event);
      }
    }

    // gemini K3.5: collect every event to append in this tick into
    // a single list, then write them concurrently. The activity log
    // is a JSONL append per event so independent appends are safe to
    // parallelize; this cuts a tick that has N new events from
    // O(N * file-flush-latency) to ~one file-flush worth of latency.
    const toAppend: ActivityEvent[] = [];
    const pendingToolResultKeyIndexes = new Map<string, number>();
    const toolResultReplacements = new Map<string, ActivityEvent>();
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
        const toolResultKey = toolResultSemanticKey(event);
        const mirroredToolResultEvent = toolResultKey ? mirroredToolResultEvents.get(toolResultKey) : undefined;
        if (toolResultKey && mirroredToolResultEvent) {
          if (
            options.activityStore.replaceAll &&
            shouldPreferToolResultEvent(event, mirroredToolResultEvent)
          ) {
            toolResultReplacements.set(toolResultKey, {
              ...event,
              id: mirroredToolResultEvent.id,
            });
          }
          if (sourceId) mirroredSourceIds.add(sourceId);
          continue;
        }
        if (toolResultKey && pendingToolResultKeyIndexes.has(toolResultKey)) {
          const existingIndex = pendingToolResultKeyIndexes.get(toolResultKey)!;
          const existingEvent = toAppend[existingIndex];
          if (existingEvent && shouldPreferToolResultEvent(event, existingEvent)) {
            toAppend[existingIndex] = event;
          }
          if (sourceId) mirroredSourceIds.add(sourceId);
          continue;
        }
        toAppend.push(event);
        if (sourceId) mirroredSourceIds.add(sourceId);
        if (toolResultKey) {
          pendingToolResultKeyIndexes.set(toolResultKey, toAppend.length - 1);
        }
      }
    }
    if (toolResultReplacements.size > 0 && options.activityStore.replaceAll) {
      const replaced = existing.map((event) => {
        const key = toolResultSemanticKey(event);
        return key ? toolResultReplacements.get(key) ?? event : event;
      });
      await options.activityStore.replaceAll(mission.id, replaced);
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
    const events = [...existing, ...toAppend];
    const workerSessions = await listWorkerSessions(threadId, messages, events);
    const roleRuns = await listRoleRuns(threadId);
    await recoverLateWorkerCompletions(
      mission,
      threadId,
      events,
      workerSessions,
      roleRuns,
    );
    await reconcileMissionLifecycle(
      mission,
      threadId,
      messages,
      workerSessions,
      roleRuns,
    );
    return appended;
  }

  function toolResultSemanticKey(event: ActivityEvent): string | null {
    const runtime = event.runtime;
    if (!runtime || event.kind !== "tool" || runtime.toolPhase !== "result") {
      return null;
    }
    const threadId = runtime.threadId;
    const toolName = runtime.toolName;
    const toolCallId = runtime.toolCallId;
    if (!threadId || !toolName || !toolCallId) {
      return null;
    }
    return `${threadId}:${toolName}:${toolCallId}:result`;
  }

  function shouldPreferToolResultEvent(candidate: ActivityEvent, current: ActivityEvent): boolean {
    return toolResultCompletenessScore(candidate) > toolResultCompletenessScore(current);
  }

  function toolResultCompletenessScore(event: ActivityEvent): number {
    const resultContent = event.runtime?.resultContent ?? "";
    let score = Buffer.byteLength(resultContent || event.text, "utf8");
    if (resultContent.includes("\"protocol\"") && resultContent.includes("turnkeyai.session_tool_result.v1")) {
      score += 100_000;
    }
    if (event.runtime?.sourceLabel) {
      score += 1_000;
    }
    if (event.emph === "danger") {
      score += 100;
    }
    return score;
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
    messages: TeamMessage[],
    workerSessions: WorkerSessionRecord[] | "unknown" | undefined,
    roleRuns: RoleRunState[] | "unknown",
  ): Promise<void> {
    const decision = evaluateMissionCompletion({
      mission,
      messages,
      roleRuns,
      workerSessions,
    });
    if (decision.action !== "update") return;
    await updateMissionLifecycle(mission, decision.patch, {
      allowDoneReopen:
        decision.reason === "incomplete_final_answer" ||
        decision.reason === "active_execution" ||
        decision.reason === "awaiting_work",
    });
    if (decision.recovery) {
      const recoveryAppended = await appendMissionRecoveryEvent(mission.id, threadId, decision.recovery);
      if (
        recoveryAppended &&
        decision.recovery.kind === "incomplete_final_answer" &&
        (await shouldPostIncompleteFinalFollowUp(mission.id, decision.recovery)) &&
        options.postIncompleteFinalFollowUp
      ) {
        const posted = await postIncompleteFinalFollowUp(mission, threadId, decision.recovery);
        if (posted) {
          await updateMissionLifecycle(
            mission,
            {
              status: "working",
              blockers: 0,
              progress: Math.min(mission.progress, 0.95),
            },
            { allowDoneReopen: true }
          );
        }
      }
    }
  }

  async function updateMissionLifecycle(
    mission: Mission,
    patch: Partial<Pick<Mission, "status" | "progress" | "blockers" | "pendingApprovals" | "closeout" | "terminalReason">>,
    lifecycleOptions: { allowDoneReopen?: boolean } = {}
  ): Promise<void> {
    try {
      const latest = (await options.missionStore.get(mission.id)) ?? mission;
      const canReopenDoneForPendingApproval =
        latest.status === "done" && patch.status === "needs_approval" && latest.pendingApprovals > 0;
      if (
        !canReopenDoneForPendingApproval &&
        !(lifecycleOptions.allowDoneReopen && latest.status === "done") &&
        (latest.status === "done" || latest.status === "archived" || latest.status === "draft")
      ) {
        return;
      }
      const next: Mission = {
        ...latest,
        ...patch,
      };
      // A closeout tag describes how THIS terminal state was reached. Any
      // status transition that doesn't set one (reopen for approval, back to
      // working, or a genuine final-answer done) must clear a stale tag —
      // otherwise a reopened mission that later completes for real would
      // still render as "Closed · blocked".
      if (patch.status && patch.status !== latest.status && !patch.closeout) {
        delete next.closeout;
      }
      await options.missionStore.putRaw(next);
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

  async function listWorkerSessions(
    threadId: string,
    messages: TeamMessage[],
    events: ActivityEvent[]
  ): Promise<WorkerSessionRecord[] | "unknown" | undefined> {
    if (!options.workerSessionStore) return undefined;
    if (!hasSessionToolActivity(messages) && !hasSessionActivityEvent(events)) return [];
    try {
      if (typeof options.workerSessionStore.listByThread === "function") {
        return await options.workerSessionStore.listByThread(threadId);
      }
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

  function hasSessionToolActivity(messages: TeamMessage[]): boolean {
    return messages.some((message) => {
      if (isSessionToolName(message.name)) return true;
      if (message.toolCalls?.some((call) => isSessionToolName(call.name))) return true;
      if (message.toolProgress?.some((progress) => isSessionToolName(progress.toolName))) return true;
      return false;
    });
  }

  function isSessionToolName(toolName: string | undefined): boolean {
    return toolName === "sessions_spawn" || toolName === "sessions_send" || toolName === "sessions_history";
  }

  function hasSessionActivityEvent(events: ActivityEvent[]): boolean {
    return events.some((event) => {
      if (event.kind !== "tool") return false;
      if (isSessionToolName(event.runtime?.toolName)) return true;
      return event.tags?.some((tag) => isSessionToolName(tag)) ?? false;
    });
  }

  async function recoverLateWorkerCompletions(
    mission: Mission,
    threadId: string,
    events: ActivityEvent[],
    workerSessions: WorkerSessionRecord[] | "unknown" | undefined,
    roleRuns: RoleRunState[] | "unknown",
  ): Promise<void> {
    if (!workerSessions || workerSessions === "unknown") return;
    if (roleRuns !== "unknown" && roleRuns.some(isActiveRoleRun)) return;

    const completedBatch = workerSessions
      .filter((workerSession) => isLateCompletedWorkerSession(workerSession, events))
      .filter((workerSession) => !hasLateWorkerCompletionRecovery(events, workerSession))
      .sort((left, right) =>
        left.workerRunKey < right.workerRunKey
          ? -1
          : left.workerRunKey > right.workerRunKey
            ? 1
            : 0,
      );
    if (completedBatch.length === 0) return;

    const deliveryId = workerCompletionBatchDeliveryId(mission.id, threadId, completedBatch);
    if (
      options.postLateWorkerCompletionFollowUp &&
      !(await postLateWorkerCompletionFollowUp(
        mission,
        threadId,
        completedBatch,
        deliveryId,
      ))
    ) {
      return;
    }
    if (!(await appendLateWorkerCompletionEvent(mission.id, threadId, completedBatch, deliveryId))) {
      return;
    }
    await reopenMissionForLateWorkerCompletion(mission);
  }

  function isActiveRoleRun(run: RoleRunState): boolean {
    return (
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "waiting_worker" ||
      run.status === "resuming"
    );
  }

  function isLateCompletedWorkerSession(
    workerSession: WorkerSessionRecord,
    events: ActivityEvent[]
  ): boolean {
    if (workerSession.state.status !== "done" || !workerSession.state.lastResult) {
      return false;
    }
    if (workerSession.context?.background === true) return true;
    return hasFailedOrTimedOutSessionToolResult(events, workerSession);
  }

  function hasFailedOrTimedOutSessionToolResult(
    events: ActivityEvent[],
    workerSession: WorkerSessionRecord,
    afterMs = Number.NEGATIVE_INFINITY
  ): boolean {
    const linkedToolCallIds = new Set<string>();
    const contextToolCallId = workerSession.context?.toolCallId;
    if (contextToolCallId) {
      linkedToolCallIds.add(contextToolCallId);
    }
    for (const event of events) {
      const runtime = event.runtime;
      if (event.kind !== "tool") continue;
      if (
        runtime?.toolPhase === "call" &&
        (runtime.toolName === "sessions_send" || runtime.toolName === "sessions_history") &&
        sessionPayloadTargetsWorker(runtime.callInput, workerSession.workerRunKey)
      ) {
        if (runtime.toolCallId) linkedToolCallIds.add(runtime.toolCallId);
      }
      if (
        runtime?.toolPhase === "result" &&
        isSessionToolName(runtime.toolName) &&
        sessionPayloadTargetsWorker(runtime.resultContent, workerSession.workerRunKey)
      ) {
        if (runtime.toolCallId) linkedToolCallIds.add(runtime.toolCallId);
      }
    }
    if (linkedToolCallIds.size === 0) return false;

    const resolvedToolCallIds = new Set(
      events
        .filter(
          (event) =>
            event.kind === "tool" &&
            event.runtime?.toolPhase === "result" &&
            typeof event.runtime.toolCallId === "string" &&
            linkedToolCallIds.has(event.runtime.toolCallId),
        )
        .map((event) => event.runtime!.toolCallId!),
    );
    const hasUnresolvedParentCall = events.some(
      (event) =>
        event.kind === "tool" &&
        event.runtime?.toolPhase === "call" &&
        typeof event.runtime.toolCallId === "string" &&
        linkedToolCallIds.has(event.runtime.toolCallId) &&
        !resolvedToolCallIds.has(event.runtime.toolCallId),
    );
    if (hasUnresolvedParentCall) return false;

    let latestResult: ActivityEvent | null = null;
    for (const event of events) {
      const runtime = event.runtime;
      if (event.tMs <= afterMs) continue;
      if (event.kind !== "tool" || runtime?.toolPhase !== "result") continue;
      if (!runtime.toolCallId || !linkedToolCallIds.has(runtime.toolCallId)) continue;
      if (
        runtime.toolName !== "sessions_spawn" &&
        runtime.toolName !== "sessions_send" &&
        runtime.toolName !== "sessions_history"
      ) {
        continue;
      }
      if (!latestResult || event.tMs >= latestResult.tMs) {
        latestResult = event;
      }
    }
    return latestResult
      ? isFailedOrTimedOutSessionToolResult(latestResult)
      : false;
  }

  function sessionPayloadTargetsWorker(payload: string | undefined, workerRunKey: string): boolean {
    if (!payload) return false;
    const parsed = safeJsonParse(payload);
    if (!isRecord(parsed)) return payload.includes(workerRunKey);
    return parsed["session_key"] === workerRunKey || parsed["worker_run_key"] === workerRunKey;
  }

  function isFailedOrTimedOutSessionToolResult(event: ActivityEvent): boolean {
    if (event.emph === "danger") return true;
    const resultContent = event.runtime?.resultContent ?? "";
    const structuredStatus = readSessionToolResultStatus(resultContent);
    if (structuredStatus) {
      return structuredStatus !== "completed";
    }
    const result = `${resultContent}\n${event.text ?? ""}`;
    return /\b(?:timed out|failed|cancelled|canceled|Tool call failed)\b/i.test(result) ||
      /\btimeout\b/i.test(result) && !/\b(?:within|before|no|none|without)\s+(?:the\s+)?timeout\b/i.test(result);
  }

  function readSessionToolResultStatus(result: string): string | null {
    const parsed = safeJsonParse(result);
    if (!isRecord(parsed)) return null;
    if (parsed["protocol"] !== "turnkeyai.session_tool_result.v1") return null;
    const status = parsed["status"];
    return typeof status === "string" ? status : null;
  }

  function hasLateWorkerCompletionRecovery(events: ActivityEvent[], workerSession: WorkerSessionRecord): boolean {
    const recoveryEvents = events.filter((event) => recoveryEventCoversWorker(event, workerSession));
    if (recoveryEvents.length === 0) return false;
    const latestRecoveryMs = Math.max(...recoveryEvents.map((event) => event.tMs));
    const latestRecovery = recoveryEvents.find((event) => event.tMs === latestRecoveryMs);
    if (latestRecovery?.runtime?.workerVersions) {
      return true;
    }
    return !hasFailedOrTimedOutSessionToolResult(events, workerSession, latestRecoveryMs);
  }

  function recoveryEventCoversWorker(
    event: ActivityEvent,
    workerSession: WorkerSessionRecord,
  ): boolean {
    if (event.kind !== "recovery" || event.runtime?.eventType !== "mission.worker_late_completion") {
      return false;
    }
    const versions = event.runtime.workerVersions
      ? safeJsonParse(event.runtime.workerVersions)
      : null;
    if (isRecord(versions)) {
      return versions[workerSession.workerRunKey] === String(workerSession.state.updatedAt);
    }
    if (event.runtime.workerRunKey === workerSession.workerRunKey) {
      return true;
    }
    const workerRunKeys = event.runtime.workerRunKeys
      ? safeJsonParse(event.runtime.workerRunKeys)
      : null;
    return Array.isArray(workerRunKeys) && workerRunKeys.includes(workerSession.workerRunKey);
  }

  async function appendLateWorkerCompletionEvent(
    missionId: string,
    threadId: string,
    workerSessions: readonly WorkerSessionRecord[],
    deliveryId: string,
  ): Promise<boolean> {
    const summaries = workerSessions.map(
      (workerSession) => `${workerSession.workerRunKey}: ${summarizeLateWorkerCompletion(workerSession)}`,
    );
    const workerRunKeys = workerSessions.map((workerSession) => workerSession.workerRunKey);
    const workerVersions = Object.fromEntries(
      workerSessions.map((workerSession) => [
        workerSession.workerRunKey,
        String(workerSession.state.updatedAt),
      ]),
    );
    const singleWorker = workerSessions.length === 1 ? workerSessions[0] : undefined;
    try {
      await options.activityStore.append({
        id: `mission-worker-late-completion:${missionId}:${deliveryId}`,
        missionId,
        tMs: options.clock.now(),
        kind: "recovery",
        actor: "system",
        text: `mission.worker_late_completion: ${summaries.join(" | ")}`,
        tags: [
          "worker_late_completion",
          ...new Set(workerSessions.map((workerSession) => workerSession.state.workerType)),
        ],
        runtime: {
          eventType: "mission.worker_late_completion",
          threadId,
          deliveryId,
          workerRunKeys: JSON.stringify(workerRunKeys),
          workerVersions: JSON.stringify(workerVersions),
          ...(singleWorker
            ? {
                workerRunKey: singleWorker.workerRunKey,
                workerType: singleWorker.state.workerType,
                workerUpdatedAt: String(singleWorker.state.updatedAt),
                ...(singleWorker.context?.toolCallId ? { toolCallId: singleWorker.context.toolCallId } : {}),
                ...(singleWorker.context?.label ? { label: singleWorker.context.label } : {}),
              }
            : {}),
        },
      });
      return true;
    } catch (error) {
      logger.warn("late worker completion event append failed", {
        missionId,
        workerRunKeys,
        error: errorMessage(error),
      });
      return false;
    }
  }

  async function reopenMissionForLateWorkerCompletion(mission: Mission): Promise<void> {
    try {
      const latest = (await options.missionStore.get(mission.id)) ?? mission;
      if (latest.status === "archived" || latest.status === "draft") return;
      if (latest.status === "working" && latest.blockers === 0) return;
      await options.missionStore.putRaw({
        ...latest,
        status: "working",
        blockers: 0,
        progress: Math.min(latest.progress, 0.95),
      });
    } catch (error) {
      logger.warn("late worker completion mission reopen failed", {
        missionId: mission.id,
        error: errorMessage(error),
      });
    }
  }

  async function postLateWorkerCompletionFollowUp(
    mission: Mission,
    threadId: string,
    workerSessions: readonly WorkerSessionRecord[],
    deliveryId: string,
  ): Promise<boolean> {
    try {
      await options.postLateWorkerCompletionFollowUp!({
        mission,
        threadId,
        workerSessions,
        deliveryId,
        content: buildLateWorkerCompletionFollowUp(workerSessions),
      });
      return true;
    } catch (error) {
      logger.warn("late worker completion follow-up post failed", {
        missionId: mission.id,
        workerRunKeys: workerSessions.map((workerSession) => workerSession.workerRunKey),
        error: errorMessage(error),
      });
      return false;
    }
  }

  function workerCompletionBatchDeliveryId(
    missionId: string,
    threadId: string,
    workerSessions: readonly WorkerSessionRecord[],
  ): string {
    const versionSet = [
      missionId,
      threadId,
      ...workerSessions.map(
        (workerSession) => `${workerSession.workerRunKey}:${workerSession.state.updatedAt}`,
      ),
    ].join("\n");
    const digest = createHash("sha256").update(versionSet).digest("hex").slice(0, 24);
    return `worker-completion-batch:${digest}`;
  }

  function buildLateWorkerCompletionFollowUp(workerSessions: readonly WorkerSessionRecord[]): string {
    const summaries = workerSessions.map((workerSession) => {
      const label = workerSession.context?.label ? ` (${workerSession.context.label})` : "";
      return `- ${workerSession.workerRunKey}${label}: ${summarizeLateWorkerCompletion(workerSession)}`;
    });
    return [
      `System recovery: ${workerSessions.length} sub-agent session(s) completed after the parent turn moved on.`,
      "Continue the original mission using this completed evidence. Incorporate the results into the answer, verify any still-missing goal slots, and do not mark the mission complete until the required slots are answered or explicitly blocked.",
      "Completed worker summaries:",
      ...summaries,
      "Use sessions_history for a listed session if its summary is not enough.",
    ].join("\n");
  }

  function summarizeLateWorkerCompletion(workerSession: WorkerSessionRecord): string {
    const summary =
      workerSession.state.lastResult?.summary ??
      workerSession.state.continuationDigest?.summary ??
      stringifyUnknown(workerSession.state.lastResult?.payload);
    return capText(typeof summary === "string" && summary.trim() ? summary.trim() : "Worker completed with no summary.", 1_200);
  }

  async function appendMissionRecoveryEvent(
    missionId: string,
    threadId: string,
    recovery: MissionCompletionRecovery
  ): Promise<boolean> {
    if (recovery.kind === "incomplete_final_answer") {
      return appendMissionIncompleteFinalEvent(missionId, threadId, recovery);
    }
    return appendMissionStalledEvent(missionId, threadId, recovery);
  }

  async function appendMissionStalledEvent(
    missionId: string,
    threadId: string,
    stalled: Extract<MissionCompletionRecovery, { kind: "stalled_tool_turn" }>
  ): Promise<boolean> {
    try {
      if (
        await hasExistingRecoveryEvent(missionId, {
          eventType: "mission.stalled_no_final_answer",
          messageId: stalled.message.id,
          status: stalled.status,
        })
      ) {
        return false;
      }
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
      return true;
    } catch (error) {
      logger.warn("mission stalled event append failed", {
        missionId,
        messageId: stalled.message.id,
        error: errorMessage(error),
      });
      return false;
    }
  }

  async function appendMissionIncompleteFinalEvent(
    missionId: string,
    threadId: string,
    incomplete: Extract<MissionCompletionRecovery, { kind: "incomplete_final_answer" }>
  ): Promise<boolean> {
    try {
      if (
        await hasExistingRecoveryEvent(missionId, {
          eventType: "mission.incomplete_final_answer",
          messageId: incomplete.message.id,
          reason: incomplete.reason,
        })
      ) {
        return false;
      }
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
      return true;
    } catch (error) {
      logger.warn("mission incomplete final event append failed", {
        missionId,
        messageId: incomplete.message.id,
        error: errorMessage(error),
      });
      return false;
    }
  }

  async function shouldPostIncompleteFinalFollowUp(
    missionId: string,
    recovery: Extract<MissionCompletionRecovery, { kind: "incomplete_final_answer" }>
  ): Promise<boolean> {
    if (recovery.reason !== "goal_slots_unverified") return false;
    if (maxIncompleteFinalFollowUps <= 0) return false;
    const attempt = await countIncompleteFinalRecoveryEvents(missionId, recovery.reason);
    return attempt <= maxIncompleteFinalFollowUps;
  }

  async function postIncompleteFinalFollowUp(
    mission: Mission,
    threadId: string,
    recovery: Extract<MissionCompletionRecovery, { kind: "incomplete_final_answer" }>
  ): Promise<boolean> {
    try {
      const attempt = await countIncompleteFinalRecoveryEvents(mission.id, recovery.reason);
      await options.postIncompleteFinalFollowUp!({
        mission,
        threadId,
        recovery,
        content: buildIncompleteFinalFollowUp(mission, recovery, attempt, maxIncompleteFinalFollowUps),
      });
      return true;
    } catch (error) {
      logger.warn("incomplete final follow-up post failed", {
        missionId: mission.id,
        messageId: recovery.message.id,
        reason: recovery.reason,
        error: errorMessage(error),
      });
      return false;
    }
  }

  function buildIncompleteFinalFollowUp(
    mission: Mission,
    recovery: Extract<MissionCompletionRecovery, { kind: "incomplete_final_answer" }>,
    attempt: number,
    maxAttempts: number
  ): string {
    const slotGuidance = summarizeRecoverySlotGuidance(recovery.goalText, recovery.message.content);
    const approvalRewriteOnly = isApprovalGatedBrowserRewriteOnlyRecovery(recovery.goalText, recovery.message.content);
    const lines = [
      "System recovery: the previous final answer did not satisfy required goal slots.",
      `Automatic recovery attempt ${attempt} of ${maxAttempts}.`,
      approvalRewriteOnly
        ? slotGuidance
          ? `Continue the original mission by rewriting the final answer from existing permission and browser evidence only; missing or unverified final-answer slots: ${slotGuidance}.`
          : "Continue the original mission by rewriting the final answer from existing permission and browser evidence only."
        : slotGuidance
          ? `Continue the original mission instead of closing it. Use available tools to verify only the missing or unverified core slots requested by the original mission: ${slotGuidance}.`
          : "Continue the original mission instead of closing it. Use available tools to verify only the missing or unverified core slots requested by the original mission.",
      "Do not introduce provider/search/model-support columns unless the original mission explicitly requested provider, search/web_search, or model-support evidence.",
      "Do not search for placeholder words from the failed answer such as '未验证', 'not verified', 'unknown', or 'missing'. Search the original entity/provider names and official domains instead.",
      "Do not repeat the same partial answer as final. If accessible sources are genuinely exhausted, provide a blocked closeout that lists the exact pages/tools attempted, what each proved, and what remains missing.",
    ];
    if (approvalRewriteOnly) {
      lines.push(
        "This recovery is for approval-gated browser closeout wording. The previous answer already described native permission.query/permission.result/permission.applied and browser evidence.",
        "Do not call sessions_spawn, sessions_send, permission tools, or browser tools again just to repair the final wording. Do not repeat browser.form.submit or any browser side effect.",
        "Use the existing timeline/tool evidence and return the missing required marker/slots, or mark blocked if that native evidence is genuinely absent."
      );
    }
    if (isSlowSourceReleaseRiskRecovery(recovery.goalText)) {
      lines.push(
        "This recovery is for a slow-source release-risk note, not a provider comparison. Do not use pricing, strengths, provider-support, model-support, or vendor-comparison table columns.",
        "Resume or retry the same slow source-check context. The required release-risk slots are: verified source/status, owner, risk, mitigation, what remains unverified, residual risk, and how to continue or retry.",
        "If the released source still cannot be read within the remaining budget, close out as blocked/partial with timeout evidence instead of inventing pricing or strengths."
      );
    }
    if (attempt >= maxAttempts) {
      lines.push(
        "This is the last automatic recovery attempt for this mission. Use at most five additional tool calls total. Pick the highest-value official/source pages for the missing slots; do not broaden to new providers unless the original prompt explicitly required them. If the missing slots still cannot be verified within that budget, stop with a bounded blocked closeout instead of producing another incomplete final answer."
      );
    }
    lines.push(`Previous incomplete answer signals: ${summarizeIncompleteFinalForRecovery(recovery.message.content)}`);
    return lines.join("\n");
  }

  function isApprovalGatedBrowserRewriteOnlyRecovery(goalText: string, finalText: string): boolean {
    const combined = `${goalText}\n${finalText}`;
    return (
      /\b(?:browser\.form\.submit|form submission|approval[- ]gated|approval gate|permission\.query|permission\.result|permission\.applied)\b/i.test(
        combined
      ) &&
      /\b(?:permission\.query|permission\.result|permission\.applied|approval request|approval decision|browser fixture evidence|sessions_spawn|browser\.form\.submit)\b/i.test(
        finalText
      )
    );
  }

  function isSlowSourceReleaseRiskRecovery(goalText: string): boolean {
    return (
      /\b(?:slow source|slow-source|slow fixture|slow-fixture|source-check|source check)\b/i.test(goalText) &&
      /\b(?:release-risk|release risk|risk note|bounded attempt|timeout|timed out|resume|continue|follow-up|followup)\b/i.test(goalText)
    );
  }

  function summarizeRecoverySlotGuidance(goalText: string, finalText: string): string {
    const coverage = evaluateMissionGoalSlotCoverage({ goalText, finalText });
    if (coverage.issues.length === 0) return "";
    return coverage.issues
      .map((issue) => `${issue.label} (${issue.reason})`)
      .join(", ");
  }

  function summarizeIncompleteFinalForRecovery(content: string): string {
    const signals: string[] = [];
    const normalized = content.replace(/\s+/g, " ").trim();
    if (/\b(?:not verified|unverified|unknown|missing)\b/i.test(normalized) || /未验证|无法验证|缺少|未访问/.test(normalized)) {
      signals.push("The answer contained unverified placeholders; treat them as missing slots, not search terms.");
    }
    const urls = extractUrls(normalized).slice(0, 8);
    if (urls.length > 0) {
      signals.push(`URLs already mentioned: ${urls.join(", ")}`);
    }
    const sourceLabels = extractSourceLabels(content).slice(0, 6);
    if (sourceLabels.length > 0) {
      signals.push(`Source labels already mentioned: ${sourceLabels.join(", ")}`);
    }
    if (signals.length === 0) {
      signals.push(capText(normalized, 500));
    }
    return capText(signals.join(" "), 900);
  }

  function extractUrls(content: string): string[] {
    const matches = content.match(/https?:\/\/[^\s)\]}>"'`]+/g) ?? [];
    return uniqueStrings(matches.map((url) => url.replace(/[.,;:]+$/, "")));
  }

  function extractSourceLabels(content: string): string[] {
    const labels: string[] = [];
    const tableRows = content.split(/\n+/).filter((line) => /^\s*\|/.test(line) && /\|\s*$/.test(line));
    for (const row of tableRows) {
      const firstCell = row.split("|").map((cell) => cell.trim()).filter(Boolean)[0];
      if (
        firstCell &&
        !/^[-:]+$/.test(firstCell) &&
        !/provider|source|证据|来源|维度/i.test(firstCell) &&
        !/^https?:\/\//i.test(firstCell) &&
        !/^(?:✅|❌|not verified|未验证|unknown|—|-)/i.test(firstCell)
      ) {
        labels.push(firstCell);
      }
    }
    return uniqueStrings(labels);
  }

  function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }

  async function hasExistingRecoveryEvent(
    missionId: string,
    expected: { eventType: string; messageId: string; reason?: string; status?: string }
  ): Promise<boolean> {
    try {
      const events = await options.activityStore.listByMission(missionId);
      return events.some((event) => {
        if (event.kind !== "recovery") return false;
        if (event.runtime?.eventType !== expected.eventType) return false;
        if (event.runtime?.messageId !== expected.messageId) return false;
        if (expected.reason !== undefined && event.runtime?.reason !== expected.reason) return false;
        if (expected.status !== undefined && event.runtime?.toolStatus !== expected.status) return false;
        return true;
      });
    } catch (error) {
      logger.warn("mission recovery dedupe scan failed", {
        missionId,
        error: errorMessage(error),
      });
      return false;
    }
  }

  async function countIncompleteFinalRecoveryEvents(
    missionId: string,
    reason: string
  ): Promise<number> {
    try {
      const events = await options.activityStore.listByMission(missionId);
      return events.filter((event) => {
        if (event.kind !== "recovery") return false;
        if (event.runtime?.eventType !== "mission.incomplete_final_answer") return false;
        return event.runtime?.reason === reason;
      }).length;
    } catch (error) {
      logger.warn("mission incomplete final recovery count failed", {
        missionId,
        reason,
        error: errorMessage(error),
      });
      return maxIncompleteFinalFollowUps;
    }
  }

  async function tickMission(missionId: string): Promise<number> {
    const mission = await safeFindMission(missionId);
    if (!mission || !mission.threadId) return 0;
    return mirror(mission, mission.threadId);
  }

  async function tickThread(threadId: string): Promise<Array<{ missionId: string; appended: number }>> {
    let missions: Mission[];
    try {
      missions = await options.missionStore.list();
    } catch (error) {
      logger.warn("mission list failed for thread mirror", {
        threadId,
        error: errorMessage(error),
      });
      return [];
    }
    const linked = missions.filter((mission): mission is Mission & { threadId: string } => mission.threadId === threadId);
    const results: Array<{ missionId: string; appended: number }> = [];
    for (const mission of linked) {
      const appended = await mirror(mission, threadId);
      results.push({ missionId: mission.id, appended });
    }
    return results;
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
    const linked = missions
      .filter((m): m is Mission & { threadId: string } =>
        typeof m.threadId === "string" && m.threadId.length > 0
      )
      .sort(compareMissionTickPriority)
      .slice(0, maxMissionsPerTick);
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

  return { tickAll, tickMission, tickThread, start };
}

const DEFAULT_MAX_MISSIONS_PER_TICK = 50;
const DEFAULT_MAX_INCOMPLETE_FINAL_FOLLOW_UPS = 2;
const ACTIVE_MISSION_STATUSES = new Set<Mission["status"]>([
  "planning",
  "working",
  "needs_approval",
  "blocked",
]);

function compareMissionTickPriority(left: Mission, right: Mission): number {
  const leftActive = ACTIVE_MISSION_STATUSES.has(left.status);
  const rightActive = ACTIVE_MISSION_STATUSES.has(right.status);
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  return missionSortTime(right) - missionSortTime(left);
}

function missionSortTime(mission: Mission): number {
  if (typeof mission.createdAtMs === "number" && Number.isFinite(mission.createdAtMs)) {
    return mission.createdAtMs;
  }
  const parsed = Date.parse(mission.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
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
  let latestSplitToolResultAt: number | null = null;
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
          latestSplitToolResultAt = Math.max(
            latestSplitToolResultAt ?? splitResultMessage.createdAt,
            splitResultMessage.createdAt,
          );
          events.push(
            buildSplitToolResultEvent({
              ...input,
              message: splitResultMessage,
              tMs: splitResultMessage.createdAt,
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
        ...(latestSplitToolResultAt !== null
          ? { tMs: Math.max(message.createdAt, latestSplitToolResultAt + 1) }
          : {}),
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

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringifyUnknown(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function capText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
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
  tMs?: number;
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
  Object.assign(runtime, missionReportRuntime(input.message.metadata));
  Object.assign(runtime, modelUseRuntime(input.message.metadata));
  return {
    id: input.newEventId(),
    missionId: input.missionId,
    tMs: input.tMs ?? input.message.createdAt,
    kind: input.kind,
    actor,
    text: input.text,
    tags: input.tags,
    runtime,
  };
}

function missionReportRuntime(metadata: Record<string, unknown> | undefined): Record<string, string> {
  const report = readRecordMetadata(metadata, "missionReport");
  if (!report) return {};
  const runtime: Record<string, string> = {};
  if (
    report.status === "completed" ||
    report.status === "partial" ||
    report.status === "blocked"
  ) {
    runtime.missionReportStatus = report.status;
  }
  if (report.source === "runtime_derived" || report.source === "model_report") {
    runtime.missionReportSource = report.source;
  }
  if (typeof report.coverageVerified === "boolean") {
    runtime.missionReportCoverageVerified = String(report.coverageVerified);
  }
  if (typeof report.reason === "string" && report.reason.trim()) {
    runtime.missionReportReason = report.reason;
  }
  return runtime;
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

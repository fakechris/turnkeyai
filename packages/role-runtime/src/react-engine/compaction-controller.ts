import { createHash } from "node:crypto";

import {
  CONTEXT_CHECKPOINT_PROTOCOL,
  emptyContextCheckpointWorkingSet,
  type ContextCheckpointRecord,
  type ContextCheckpointDynamicContext,
  type ContextCheckpointScope,
  type ContextCheckpointStore,
  type ContextCheckpointWorkingSet,
} from "@turnkeyai/core-types/context-checkpoint";
import type {
  GenerateTextInput,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import { buildHistoryProtocolUnits } from "../tool-history-pruning";
import { microcompactOldToolResults } from "../tool-result-microcompactor";
import {
  guardContextCheckpointSource,
  type ContextSourceGuardLimits,
  type ContextSourceGuardSnapshot,
} from "./context-source-guard";
import type { ContextWorkingSetProvider } from "./context-working-set";
import type { EngineModelTokenBudgetEstimate } from "./engine-model-client";

export const RUNTIME_CHECKPOINT_PROTOCOL =
  "turnkeyai.runtime_checkpoint.v1" as const;
const RUNTIME_CHECKPOINT_PREFIX = "TurnkeyAI runtime checkpoint v1";
const CONTEXT_CHECKPOINT_PREFIX = "TurnkeyAI context checkpoint v2";
const DEFAULT_COMPACTION_THRESHOLD = 0.7;
const DEFAULT_RECENT_PROTOCOL_UNITS = 4;
const MAX_CHECKPOINT_ITEMS = 20;
const MAX_CHECKPOINT_ITEM_CHARS = 1_000;
const MAX_CHECKPOINT_SUMMARY_CHARS = 4_000;
const MAX_CHECKPOINT_TASK_CHARS = 2_000;

export interface RuntimeCheckpointDraft {
  task?: string;
  summary: string;
  decisions: string[];
  evidence: string[];
  artifacts: string[];
  openQuestions: string[];
  planState: string[];
  errorsAndFixes?: string[];
}

export interface RuntimeCheckpoint extends RuntimeCheckpointDraft {
  protocol:
    | typeof RUNTIME_CHECKPOINT_PROTOCOL
    | typeof CONTEXT_CHECKPOINT_PROTOCOL;
  checkpointId?: string;
  version: number;
  compactedAtRound: number;
  sourceMessageCount: number;
  task: string;
  workingSet?: ContextCheckpointWorkingSet;
  dynamicContext?: ContextCheckpointDynamicContext;
  errorsAndFixes?: string[];
}

export interface RuntimeCheckpointSummaryInput {
  taskPrompt: string;
  previousCheckpoint?: RuntimeCheckpoint;
  messages: LLMMessage[];
  round: number;
  planStateSnapshot?: string[];
  signal?: AbortSignal;
}

export interface CompactionController {
  applyRoundMessagesHook(
    messages: LLMMessage[],
    round: number,
    signal?: AbortSignal,
  ): Promise<CompactionMessagesResult>;
  forceRoundMessages(
    messages: LLMMessage[],
    round: number,
    signal?: AbortSignal,
  ): Promise<CompactionMessagesResult>;
  activateCheckpoint(checkpointId: string): Promise<void>;
  reconcileFromMessages(messages: LLMMessage[]): Promise<void>;
}

export interface CompactionMessagesResult {
  messages: LLMMessage[];
  pendingCheckpointId?: string;
}

export interface CreateCompactionControllerInput {
  taskPrompt: string;
  estimateTokenBudget(
    input: Pick<GenerateTextInput, "messages" | "tools" | "toolChoice">,
  ): EngineModelTokenBudgetEstimate;
  summarize(
    input: RuntimeCheckpointSummaryInput,
  ): Promise<RuntimeCheckpointDraft>;
  readPlanState?(
    messages: LLMMessage[],
    previousPlanState: string[],
  ): string[] | Promise<string[]>;
  tools?: GenerateTextInput["tools"];
  threshold?: number;
  recentProtocolUnits?: number;
  sourceGuard?: Partial<ContextSourceGuardLimits>;
  checkpointStore?: ContextCheckpointStore;
  checkpointScope?: ContextCheckpointScope;
  captureWorkingSet?: ContextWorkingSetProvider;
  dynamicContext?: ContextCheckpointDynamicContext;
  postCompactionMessages?: LLMMessage[];
  now?: () => number;
  enabled?: boolean;
  onCompaction?: (event: {
    round: number;
    forced: boolean;
    messageCountBefore: number;
    messageCountAfter: number;
    messageBytesBefore: number;
    messageBytesAfter: number;
    sourceMessageCount: number;
    sourceGuard: ContextSourceGuardSnapshot;
    checkpointId: string;
    checkpointProtocol: typeof CONTEXT_CHECKPOINT_PROTOCOL;
  }) => void;
  onError?: (error: unknown) => void;
  onCompactionLifecycle?: (event: CompactionLifecycleEvent) => void;
}

export interface CompactionLifecycleEvent {
  kind: "skipped" | "failed" | "succeeded";
  round: number;
  forced: boolean;
  consecutiveFailures: number;
  microcompactedToolResults: number;
  reason?:
    | "disabled"
    | "below_threshold"
    | "failure_circuit_open"
    | "protocol_unsafe"
    | "insufficient_history"
    | "summarizer_failed";
}

export function createCompactionController(
  input: CreateCompactionControllerInput,
): CompactionController {
  if (Boolean(input.checkpointStore) !== Boolean(input.checkpointScope)) {
    throw new Error(
      "context checkpoint store and scope must be configured together",
    );
  }
  const threshold = input.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const recentProtocolUnits =
    input.recentProtocolUnits ?? DEFAULT_RECENT_PROTOCOL_UNITS;
  const now = input.now ?? (() => Date.now());
  let pendingForcedCompaction:
    | {
        sourceMessageCount: number;
        sourceDigest: string;
        messages: LLMMessage[];
        checkpointId?: string;
      }
    | undefined;
  let consecutiveFailures = 0;
  let failureCircuitOpen = false;

  const compact = async (
    messages: LLMMessage[],
    round: number,
    signal: AbortSignal | undefined,
    force: boolean,
  ): Promise<CompactionMessagesResult> => {
    if (input.enabled === false) {
      input.onCompactionLifecycle?.({
        kind: "skipped",
        round,
        forced: force,
        consecutiveFailures,
        microcompactedToolResults: 0,
        reason: "disabled",
      });
      return { messages };
    }
    if (!force && pendingForcedCompaction) {
      const pending = pendingForcedCompaction;
      pendingForcedCompaction = undefined;
      if (
        messages.length >= pending.sourceMessageCount &&
        transcriptDigest(messages.slice(0, pending.sourceMessageCount)) ===
          pending.sourceDigest
      ) {
        return {
          messages: [
            ...pending.messages,
            ...messages.slice(pending.sourceMessageCount),
          ],
          ...(pending.checkpointId
            ? { pendingCheckpointId: pending.checkpointId }
            : {}),
        };
      }
    }
    const budget = input.estimateTokenBudget({
      messages,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.tools === undefined ? {} : { toolChoice: "auto" as const }),
    });
    if (!force) {
      if (budget.utilization === undefined || budget.utilization < threshold) {
        consecutiveFailures = 0;
        failureCircuitOpen = false;
        input.onCompactionLifecycle?.({
          kind: "skipped",
          round,
          forced: false,
          consecutiveFailures,
          microcompactedToolResults: 0,
          reason: "below_threshold",
        });
        return { messages };
      }
    }

    const originalHistoryUnits = buildHistoryProtocolUnits(messages.slice(2));
    if (originalHistoryUnits.some((unit) => !unit.protocolSafe)) {
      input.onCompactionLifecycle?.({
        kind: "skipped",
        round,
        forced: force,
        consecutiveFailures,
        microcompactedToolResults: 0,
        reason: "protocol_unsafe",
      });
      return { messages };
    }

    const microcompaction = microcompactOldToolResults(messages, {
      recentProtocolUnits,
    });
    const workingMessages = microcompaction.messages;
    if (!force && failureCircuitOpen) {
      input.onCompactionLifecycle?.({
        kind: "skipped",
        round,
        forced: false,
        consecutiveFailures,
        microcompactedToolResults: microcompaction.compactedToolResults,
        reason: "failure_circuit_open",
      });
      return { messages: workingMessages };
    }

    const prefix = workingMessages.slice(0, 2);
    const historyUnits = buildHistoryProtocolUnits(workingMessages.slice(2));
    let previousCheckpoint: RuntimeCheckpoint | undefined;
    const rawUnits = historyUnits.filter((unit) => {
      if (unit.messages.length !== 1) {
        return true;
      }
      const parsed = readRuntimeCheckpoint(unit.messages[0]);
      if (!parsed) {
        return true;
      }
      previousCheckpoint = parsed;
      return false;
    });
    if (rawUnits.length <= recentProtocolUnits) {
      input.onCompactionLifecycle?.({
        kind: "skipped",
        round,
        forced: force,
        consecutiveFailures,
        microcompactedToolResults: microcompaction.compactedToolResults,
        reason: "insufficient_history",
      });
      return { messages: workingMessages };
    }

    const droppedUnits = rawUnits.slice(0, -recentProtocolUnits);
    const keptUnits = rawUnits.slice(-recentProtocolUnits);
    const droppedMessages = droppedUnits.flatMap((unit) => unit.messages);
    if (droppedMessages.length === 0) {
      return { messages: workingMessages };
    }

    try {
      const sourceGuard = guardContextCheckpointSource(droppedMessages, {
        ...input.sourceGuard,
        ...(budget.inputTokenLimit === undefined
          ? {}
          : {
              maxSourceTokens: Math.max(
                1,
                Math.floor(budget.inputTokenLimit * 0.75),
              ),
            }),
      });
      if (!sourceGuard.snapshot.protocolSafe) {
        input.onCompactionLifecycle?.({
          kind: "skipped",
          round,
          forced: force,
          consecutiveFailures,
          microcompactedToolResults: microcompaction.compactedToolResults,
          reason: "protocol_unsafe",
        });
        return { messages: workingMessages };
      }
      const planStateSnapshot = input.readPlanState
        ? await input.readPlanState(
            messages,
            previousCheckpoint?.planState ?? [],
          )
        : previousCheckpoint?.planState ?? [];
      const checkpointVersion = (previousCheckpoint?.version ?? 0) + 1;
      const checkpointId = buildCheckpointId({
        ...(input.checkpointScope ? { scope: input.checkpointScope } : {}),
        sourceDigest: transcriptDigest(droppedMessages),
        round,
        version: checkpointVersion,
      });
      const createdAt = now();
      const workingSet = input.captureWorkingSet
        ? await input.captureWorkingSet(messages)
        : emptyContextCheckpointWorkingSet();
      const prepared = buildContextCheckpointRecord({
        checkpointId,
        state: "prepared",
        version: checkpointVersion,
        scope: input.checkpointScope ?? fallbackCheckpointScope(checkpointId),
        compactedAtRound: round,
        sourceGuard: sourceGuard.snapshot,
        sourceDigest: transcriptDigest(droppedMessages),
        ...(previousCheckpoint?.checkpointId
          ? { previousCheckpointId: previousCheckpoint.checkpointId }
          : {}),
        taskPrompt: input.taskPrompt,
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
        planState: planStateSnapshot,
        workingSet,
        ...(input.dynamicContext
          ? { dynamicContext: input.dynamicContext }
          : {}),
        createdAt,
        updatedAt: createdAt,
      });
      await input.checkpointStore?.put(prepared);
      const draft = await input.summarize({
        taskPrompt: input.taskPrompt,
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
        messages: sourceGuard.messages,
        round,
        ...(planStateSnapshot.length > 0 ? { planStateSnapshot } : {}),
        ...(signal ? { signal } : {}),
      });
      const summarized = buildContextCheckpointRecord({
        checkpointId,
        state: "summarized",
        version: checkpointVersion,
        scope: prepared.scope,
        compactedAtRound: round,
        sourceGuard: sourceGuard.snapshot,
        sourceDigest: prepared.source.transcriptDigest,
        ...(previousCheckpoint?.checkpointId
          ? { previousCheckpointId: previousCheckpoint.checkpointId }
          : {}),
        draft:
          planStateSnapshot.length > 0
            ? { ...draft, planState: planStateSnapshot }
            : draft,
        taskPrompt: input.taskPrompt,
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
        planState: planStateSnapshot,
        workingSet,
        ...(input.dynamicContext
          ? { dynamicContext: input.dynamicContext }
          : {}),
        createdAt,
        updatedAt: now(),
      });
      await input.checkpointStore?.put(summarized);
      const persisted: ContextCheckpointRecord = {
        ...summarized,
        state: input.checkpointStore ? "persisted" : "activated",
        updatedAt: now(),
      };
      await input.checkpointStore?.put(persisted);
      const compacted = {
        messages: [
          ...prefix,
          buildRuntimeCheckpointMessage(persisted),
          ...(input.postCompactionMessages ?? []),
          ...keptUnits.flatMap((unit) => unit.messages),
        ],
        ...(input.checkpointStore
          ? { pendingCheckpointId: checkpointId }
          : {}),
      };
      if (force) {
        pendingForcedCompaction = {
          sourceMessageCount: messages.length,
          sourceDigest: transcriptDigest(messages),
          messages: compacted.messages,
          ...(input.checkpointStore ? { checkpointId } : {}),
        };
      }
      input.onCompaction?.({
        round,
        forced: force,
        messageCountBefore: messages.length,
        messageCountAfter: compacted.messages.length,
        messageBytesBefore: Buffer.byteLength(
          JSON.stringify(messages),
          "utf8",
        ),
        messageBytesAfter: Buffer.byteLength(
          JSON.stringify(compacted.messages),
          "utf8",
        ),
        sourceMessageCount: droppedMessages.length,
        sourceGuard: sourceGuard.snapshot,
        checkpointId,
        checkpointProtocol: CONTEXT_CHECKPOINT_PROTOCOL,
      });
      consecutiveFailures = 0;
      failureCircuitOpen = false;
      input.onCompactionLifecycle?.({
        kind: "succeeded",
        round,
        forced: force,
        consecutiveFailures,
        microcompactedToolResults: microcompaction.compactedToolResults,
      });
      return compacted;
    } catch (error) {
      consecutiveFailures += 1;
      failureCircuitOpen = consecutiveFailures >= 3;
      input.onError?.(error);
      input.onCompactionLifecycle?.({
        kind: "failed",
        round,
        forced: force,
        consecutiveFailures,
        microcompactedToolResults: microcompaction.compactedToolResults,
        reason: "summarizer_failed",
      });
      return { messages: workingMessages };
    }
  };

  return {
    applyRoundMessagesHook: (messages, round, signal) =>
      compact(messages, round, signal, false),
    forceRoundMessages: (messages, round, signal) =>
      compact(messages, round, signal, true),
    async activateCheckpoint(checkpointId) {
      if (!input.checkpointStore || !input.checkpointScope) return;
      const active = await input.checkpointStore.getActive(
        input.checkpointScope,
      );
      if (active?.checkpointId === checkpointId) return;
      const record = await input.checkpointStore.get(checkpointId);
      if (!record) {
        throw new Error(`context checkpoint not found: ${checkpointId}`);
      }
      assertStoredCheckpointIdentity(record);
      await input.checkpointStore.activate({
        scope: input.checkpointScope,
        checkpointId,
        expectedActiveCheckpointId:
          record.source.previousCheckpointId ?? null,
        activatedAt: now(),
      });
    },
    async reconcileFromMessages(messages) {
      if (!input.checkpointStore || !input.checkpointScope) return;
      const checkpoint = [...messages]
        .reverse()
        .map((message) => readRuntimeCheckpoint(message))
        .find(
          (candidate) =>
            candidate?.protocol === CONTEXT_CHECKPOINT_PROTOCOL &&
            Boolean(candidate.checkpointId),
        );
      if (!checkpoint?.checkpointId) return;
      const active = await input.checkpointStore.getActive(
        input.checkpointScope,
      );
      if (active?.checkpointId === checkpoint.checkpointId) return;
      const record = await input.checkpointStore.get(checkpoint.checkpointId);
      if (
        !record ||
        (record.state !== "persisted" && record.state !== "activated")
      ) {
        return;
      }
      assertStoredCheckpointIdentity(record);
      const canonicalProjection = buildRuntimeCheckpointMessage(record);
      const journaledProjection = [...messages]
        .reverse()
        .find((message) =>
          readRuntimeCheckpoint(message)?.checkpointId === record.checkpointId
        );
      if (
        !journaledProjection ||
        JSON.stringify(journaledProjection) !==
          JSON.stringify(canonicalProjection)
      ) {
        throw new Error(
          `context checkpoint projection mismatch: ${record.checkpointId}`,
        );
      }
      await input.checkpointStore.activate({
        scope: input.checkpointScope,
        checkpointId: record.checkpointId,
        expectedActiveCheckpointId:
          record.source.previousCheckpointId ?? null,
        activatedAt: now(),
      });
    },
  };
}

function transcriptDigest(messages: LLMMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export function buildRuntimeCheckpointMessage(
  checkpoint: RuntimeCheckpoint | ContextCheckpointRecord,
): LLMMessage {
  if (isStoredContextCheckpoint(checkpoint)) {
    const projection = {
      protocol: CONTEXT_CHECKPOINT_PROTOCOL,
      checkpointId: checkpoint.checkpointId,
      version: checkpoint.version,
      compactedAtRound: checkpoint.compactedAtRound,
      sourceMessageCount: checkpoint.source.sourceMessageCount,
      task: checkpoint.task.rootGoal,
      summary: checkpoint.summary.narrative,
      decisions: checkpoint.summary.decisions,
      evidence: checkpoint.summary.evidence,
      artifacts: checkpoint.workingSet.artifacts,
      openQuestions: checkpoint.task.openQuestions,
      planState: checkpoint.task.planState,
      errorsAndFixes: checkpoint.summary.errorsAndFixes,
      workingSet: checkpoint.workingSet,
      ...(checkpoint.dynamicContext
        ? { dynamicContext: checkpoint.dynamicContext }
        : {}),
    };
    return {
      role: "user",
      content: `${CONTEXT_CHECKPOINT_PREFIX}\n${JSON.stringify(projection)}`,
    };
  }
  return {
    role: "user",
    content: `${RUNTIME_CHECKPOINT_PREFIX}\n${JSON.stringify(checkpoint)}`,
  };
}

export function readRuntimeCheckpoint(
  message: LLMMessage | undefined,
): RuntimeCheckpoint | undefined {
  if (
    message?.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(`${CONTEXT_CHECKPOINT_PREFIX}\n`)
  ) {
    return readContextCheckpointProjection(
      message.content.slice(CONTEXT_CHECKPOINT_PREFIX.length + 1),
    );
  }
  if (
    message?.role !== "user" ||
    typeof message.content !== "string" ||
    !message.content.startsWith(`${RUNTIME_CHECKPOINT_PREFIX}\n`)
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      message.content.slice(RUNTIME_CHECKPOINT_PREFIX.length + 1),
    ) as Partial<RuntimeCheckpoint>;
    if (
      parsed.protocol !== RUNTIME_CHECKPOINT_PROTOCOL ||
      typeof parsed.version !== "number" ||
      typeof parsed.compactedAtRound !== "number" ||
      typeof parsed.sourceMessageCount !== "number" ||
      typeof parsed.task !== "string" ||
      typeof parsed.summary !== "string"
    ) {
      return undefined;
    }
    return {
      protocol: RUNTIME_CHECKPOINT_PROTOCOL,
      version: parsed.version,
      compactedAtRound: parsed.compactedAtRound,
      sourceMessageCount: parsed.sourceMessageCount,
      task: parsed.task,
      summary: parsed.summary,
      decisions: normalizeItems(parsed.decisions),
      evidence: normalizeItems(parsed.evidence),
      artifacts: normalizeItems(parsed.artifacts),
      openQuestions: normalizeItems(parsed.openQuestions),
      planState: normalizeItems(parsed.planState),
    };
  } catch {
    return undefined;
  }
}

function readContextCheckpointProjection(
  content: string,
): RuntimeCheckpoint | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed["protocol"] !== CONTEXT_CHECKPOINT_PROTOCOL ||
      typeof parsed["checkpointId"] !== "string" ||
      typeof parsed["version"] !== "number" ||
      typeof parsed["compactedAtRound"] !== "number" ||
      typeof parsed["sourceMessageCount"] !== "number" ||
      typeof parsed["task"] !== "string" ||
      typeof parsed["summary"] !== "string"
    ) {
      return undefined;
    }
    return {
      protocol: CONTEXT_CHECKPOINT_PROTOCOL,
      checkpointId: parsed["checkpointId"],
      version: parsed["version"],
      compactedAtRound: parsed["compactedAtRound"],
      sourceMessageCount: parsed["sourceMessageCount"],
      task: parsed["task"],
      summary: parsed["summary"],
      decisions: normalizeItems(parsed["decisions"]),
      evidence: normalizeItems(parsed["evidence"]),
      artifacts: normalizeItems(parsed["artifacts"]),
      openQuestions: normalizeItems(parsed["openQuestions"]),
      planState: normalizeItems(parsed["planState"]),
      errorsAndFixes: normalizeItems(parsed["errorsAndFixes"]),
      ...(isContextCheckpointWorkingSet(parsed["workingSet"])
        ? {
            workingSet:
              parsed["workingSet"] as unknown as ContextCheckpointWorkingSet,
          }
        : {}),
      ...(isContextCheckpointDynamicContext(parsed["dynamicContext"])
        ? {
            dynamicContext:
              parsed["dynamicContext"] as ContextCheckpointDynamicContext,
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function buildContextCheckpointRecord(input: {
  checkpointId: string;
  state: ContextCheckpointRecord["state"];
  version: number;
  scope: ContextCheckpointScope;
  compactedAtRound: number;
  sourceGuard: ContextSourceGuardSnapshot;
  sourceDigest: string;
  previousCheckpointId?: string;
  draft?: RuntimeCheckpointDraft;
  taskPrompt: string;
  previousCheckpoint?: RuntimeCheckpoint;
  planState: string[];
  workingSet: ContextCheckpointWorkingSet;
  dynamicContext?: ContextCheckpointDynamicContext;
  createdAt: number;
  updatedAt: number;
}): ContextCheckpointRecord {
  const normalizedDraft = input.draft;
  const planState =
    input.planState.length > 0
      ? normalizeItems(input.planState)
      : normalizeItems(
          normalizedDraft?.planState ??
            input.previousCheckpoint?.planState ??
            [],
        );
  const workingSet = {
    ...input.workingSet,
    artifacts: [
      ...new Set([
        ...input.workingSet.artifacts,
        ...normalizeItems(normalizedDraft?.artifacts),
      ]),
    ].slice(0, MAX_CHECKPOINT_ITEMS),
  };
  return {
    protocol: CONTEXT_CHECKPOINT_PROTOCOL,
    checkpointId: input.checkpointId,
    version: input.version,
    state: input.state,
    scope: structuredClone(input.scope),
    compactedAtRound: input.compactedAtRound,
    source: {
      transcriptDigest: input.sourceDigest,
      sourceMessageCount:
        (input.previousCheckpoint?.sourceMessageCount ?? 0) +
        input.sourceGuard.sourceMessageCount,
      sourceBytes: input.sourceGuard.sourceBytes,
      sourceTokensEstimate: input.sourceGuard.sourceTokens,
      guard: {
        protocolSafe: input.sourceGuard.protocolSafe,
        compacted: input.sourceGuard.compacted,
        guardedMessageCount: input.sourceGuard.guardedMessageCount,
        guardedBytes: input.sourceGuard.guardedBytes,
        guardedTokens: input.sourceGuard.guardedTokens,
        digestedMessageCount: input.sourceGuard.digestedMessageCount,
        digestedProtocolUnitCount:
          input.sourceGuard.digestedProtocolUnitCount,
        retainedProtocolUnitCount:
          input.sourceGuard.retainedProtocolUnitCount,
        digestGroupCount: input.sourceGuard.digestGroupCount,
      },
      ...(input.previousCheckpointId
        ? { previousCheckpointId: input.previousCheckpointId }
        : {}),
    },
    task: {
      rootGoal: truncate(
        normalizedDraft?.task?.trim() ||
          input.previousCheckpoint?.task ||
          input.taskPrompt,
        MAX_CHECKPOINT_TASK_CHARS,
      ),
      planState,
      openQuestions: normalizeItems(
        normalizedDraft?.openQuestions ??
          input.previousCheckpoint?.openQuestions ??
          [],
      ),
      nextActions: planState.filter(isNonterminalPlanItem),
    },
    summary: {
      narrative: truncate(
        normalizedDraft?.summary ??
          input.previousCheckpoint?.summary ??
          "",
        MAX_CHECKPOINT_SUMMARY_CHARS,
      ),
      decisions: normalizeItems(
        normalizedDraft?.decisions ??
          input.previousCheckpoint?.decisions ??
          [],
      ),
      evidence: normalizeItems(
        normalizedDraft?.evidence ??
          input.previousCheckpoint?.evidence ??
          [],
      ),
      errorsAndFixes: normalizeItems(
        normalizedDraft?.errorsAndFixes ??
          input.previousCheckpoint?.errorsAndFixes ??
          [],
      ),
    },
    workingSet,
    ...(input.dynamicContext
      ? { dynamicContext: structuredClone(input.dynamicContext) }
      : {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function buildCheckpointId(input: {
  scope?: ContextCheckpointScope;
  sourceDigest: string;
  round: number;
  version: number;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        scope: input.scope ?? null,
        sourceDigest: input.sourceDigest,
        round: input.round,
        version: input.version,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `context-checkpoint:${digest}`;
}

function assertStoredCheckpointIdentity(
  record: ContextCheckpointRecord,
): void {
  const expected = buildCheckpointId({
    scope: record.scope,
    sourceDigest: record.source.transcriptDigest,
    round: record.compactedAtRound,
    version: record.version,
  });
  if (record.checkpointId !== expected) {
    throw new Error(
      `context checkpoint source identity mismatch: ${record.checkpointId}`,
    );
  }
}

function fallbackCheckpointScope(
  checkpointId: string,
): ContextCheckpointScope {
  return {
    threadId: "ephemeral",
    roleId: "ephemeral",
    flowId: checkpointId,
  };
}

function isContextCheckpointWorkingSet(
  value: unknown,
): value is ContextCheckpointWorkingSet {
  return isRecord(value) &&
    Array.isArray(value["files"]) &&
    Array.isArray(value["skills"]) &&
    Array.isArray(value["artifacts"]) &&
    Array.isArray(value["sessions"]) &&
    Array.isArray(value["approvals"]) &&
    Array.isArray(value["images"]);
}

function isStoredContextCheckpoint(
  value: RuntimeCheckpoint | ContextCheckpointRecord,
): value is ContextCheckpointRecord {
  return value.protocol === CONTEXT_CHECKPOINT_PROTOCOL &&
    "source" in value &&
    "scope" in value &&
    "state" in value;
}

function isContextCheckpointDynamicContext(
  value: unknown,
): value is ContextCheckpointDynamicContext {
  return isRecord(value) &&
    typeof value["baselineId"] === "string" &&
    isRecord(value["sectionDigests"]) &&
    Object.values(value["sectionDigests"]).every(
      (digest) => typeof digest === "string",
    );
}

function isNonterminalPlanItem(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed["status"] !== "done" &&
      parsed["status"] !== "completed" &&
      parsed["status"] !== "archived";
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => truncate(item.trim(), MAX_CHECKPOINT_ITEM_CHARS))
    .filter((item) => item.length > 0)
    .slice(0, MAX_CHECKPOINT_ITEMS);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

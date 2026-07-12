import { createHash } from "node:crypto";

import type {
  GenerateTextInput,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import { buildHistoryProtocolUnits } from "../tool-history-pruning";
import { microcompactOldToolResults } from "../tool-result-microcompactor";
import type { EngineModelTokenBudgetEstimate } from "./engine-model-client";

export const RUNTIME_CHECKPOINT_PROTOCOL =
  "turnkeyai.runtime_checkpoint.v1" as const;
const RUNTIME_CHECKPOINT_PREFIX = "TurnkeyAI runtime checkpoint v1";
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
}

export interface RuntimeCheckpoint extends RuntimeCheckpointDraft {
  protocol: typeof RUNTIME_CHECKPOINT_PROTOCOL;
  version: number;
  compactedAtRound: number;
  sourceMessageCount: number;
  task: string;
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
  ): Promise<{ messages: LLMMessage[] }>;
  forceRoundMessages(
    messages: LLMMessage[],
    round: number,
    signal?: AbortSignal,
  ): Promise<{ messages: LLMMessage[] }>;
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
  ): string[];
  tools?: GenerateTextInput["tools"];
  threshold?: number;
  recentProtocolUnits?: number;
  enabled?: boolean;
  onCompaction?: (event: {
    round: number;
    forced: boolean;
    messageCountBefore: number;
    messageCountAfter: number;
    sourceMessageCount: number;
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
  const threshold = input.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const recentProtocolUnits =
    input.recentProtocolUnits ?? DEFAULT_RECENT_PROTOCOL_UNITS;
  let pendingForcedCompaction:
    | {
        sourceMessageCount: number;
        sourceDigest: string;
        messages: LLMMessage[];
      }
    | undefined;
  let consecutiveFailures = 0;
  let failureCircuitOpen = false;

  const compact = async (
    messages: LLMMessage[],
    round: number,
    signal: AbortSignal | undefined,
    force: boolean,
  ): Promise<{ messages: LLMMessage[] }> => {
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
        };
      }
    }
    if (!force) {
      const budget = input.estimateTokenBudget({
        messages,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        ...(input.tools === undefined ? {} : { toolChoice: "auto" as const }),
      });
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
      const planStateSnapshot = input.readPlanState?.(
        messages,
        previousCheckpoint?.planState ?? [],
      ) ?? previousCheckpoint?.planState ?? [];
      const draft = await input.summarize({
        taskPrompt: input.taskPrompt,
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
        messages: droppedMessages,
        round,
        ...(planStateSnapshot.length > 0 ? { planStateSnapshot } : {}),
        ...(signal ? { signal } : {}),
      });
      const checkpoint = normalizeRuntimeCheckpoint({
        draft:
          planStateSnapshot.length > 0
            ? { ...draft, planState: planStateSnapshot }
            : draft,
        taskPrompt: input.taskPrompt,
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
        compactedAtRound: round,
        newlyCompactedMessageCount: droppedMessages.length,
      });
      const compacted = {
        messages: [
          ...prefix,
          buildRuntimeCheckpointMessage(checkpoint),
          ...keptUnits.flatMap((unit) => unit.messages),
        ],
      };
      if (force) {
        pendingForcedCompaction = {
          sourceMessageCount: messages.length,
          sourceDigest: transcriptDigest(messages),
          messages: compacted.messages,
        };
      }
      input.onCompaction?.({
        round,
        forced: force,
        messageCountBefore: messages.length,
        messageCountAfter: compacted.messages.length,
        sourceMessageCount: droppedMessages.length,
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
  };
}

function transcriptDigest(messages: LLMMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export function buildRuntimeCheckpointMessage(
  checkpoint: RuntimeCheckpoint,
): LLMMessage {
  return {
    role: "user",
    content: `${RUNTIME_CHECKPOINT_PREFIX}\n${JSON.stringify(checkpoint)}`,
  };
}

export function readRuntimeCheckpoint(
  message: LLMMessage | undefined,
): RuntimeCheckpoint | undefined {
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

function normalizeRuntimeCheckpoint(input: {
  draft: RuntimeCheckpointDraft;
  taskPrompt: string;
  previousCheckpoint?: RuntimeCheckpoint;
  compactedAtRound: number;
  newlyCompactedMessageCount: number;
}): RuntimeCheckpoint {
  return {
    protocol: RUNTIME_CHECKPOINT_PROTOCOL,
    version: (input.previousCheckpoint?.version ?? 0) + 1,
    compactedAtRound: input.compactedAtRound,
    sourceMessageCount:
      (input.previousCheckpoint?.sourceMessageCount ?? 0) +
      input.newlyCompactedMessageCount,
    task: truncate(
      input.draft.task?.trim() ||
        input.previousCheckpoint?.task ||
        input.taskPrompt,
      MAX_CHECKPOINT_TASK_CHARS,
    ),
    summary: truncate(input.draft.summary, MAX_CHECKPOINT_SUMMARY_CHARS),
    decisions: normalizeItems(input.draft.decisions),
    evidence: normalizeItems(input.draft.evidence),
    artifacts: normalizeItems(input.draft.artifacts),
    openQuestions: normalizeItems(input.draft.openQuestions),
    planState: normalizeItems(input.draft.planState),
  };
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

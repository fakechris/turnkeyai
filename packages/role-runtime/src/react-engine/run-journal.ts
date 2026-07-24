import { createHash } from "node:crypto";
import type {
  RoleActivationInput,
  TeamMessage,
  TeamMessageStore,
} from "@turnkeyai/core-types/team";
import {
  appendAssistantToolCallMessage,
  appendToolResultMessages,
} from "@turnkeyai/agent-core/tool-messages";
import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { buildHistoryProtocolUnits } from "../tool-history-pruning";
import {
  RUN_EFFECT_INDETERMINATE_PROTOCOL,
  RunEffectLedger,
  restoreRunEffectLedger,
  type RunEffectRecord,
  type RunEffectLedgerSnapshot,
} from "./effect-ledger";

export {
  RUN_EFFECT_INDETERMINATE_PROTOCOL,
  RUN_EFFECT_NOT_DISPATCHED_PROTOCOL,
} from "./effect-ledger";

export const RUN_JOURNAL_PROTOCOL = "turnkeyai.run_journal.v1" as const;
export const RUN_RESUME_INTERRUPTED_TOOL_PROTOCOL =
  "turnkeyai.run_resume_interrupted_tool.v1" as const;

export interface RunJournalState {
  messages: LLMMessage[];
  nextRound: number;
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  planState: string[];
}

export interface RunJournalResumeState extends RunJournalState {
  resumedAfterCrash: true;
}

export interface RunJournal {
  load(): Promise<RunJournalResumeState | null>;
  checkpoint(state: RunJournalState): Promise<void>;
  complete(state: RunJournalState): Promise<void>;
  effectLedger: {
    admit(input: {
      round: number;
      call: LLMToolCall;
    }): Promise<ToolResult | null>;
    start(effectId: string): Promise<void>;
    recordResult(result: ToolResult): Promise<void>;
  };
}

export function fingerprintRunJournalTask(
  activation: RoleActivationInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        threadId: activation.thread.threadId,
        flowId: activation.flow.flowId,
        sourceMessageId: activation.handoff.sourceMessageId,
        roleId: activation.runState.roleId,
      }),
    )
    .digest("hex");
}

interface StoredRunJournal extends RunJournalState {
  protocol: typeof RUN_JOURNAL_PROTOCOL;
  status: "in_flight" | "completed";
  runKey: string;
  taskId: string;
  taskFingerprint: string;
  updatedAt: number;
  effectLedger?: RunEffectLedgerSnapshot | undefined;
}

export function createRunJournal(input: {
  store: Pick<TeamMessageStore, "append" | "get" | "list">;
  activation: RoleActivationInput;
  taskFingerprint: string;
  now: () => number;
  reconcileEffect?: (
    effect: RunEffectRecord,
  ) => Promise<ToolResult | null>;
}): RunJournal {
  const journalId = `runtime-journal:${input.activation.runState.runKey}`;
  let effectLedger = new RunEffectLedger();
  let latestState: RunJournalState | null = null;
  let effectTransitionQueue: Promise<void> = Promise.resolve();

  const writeAt = async (
    status: StoredRunJournal["status"],
    state: RunJournalState,
    now: number,
  ): Promise<void> => {
    assertProtocolSafeJournalState(state);
    latestState = cloneState(state);
    effectLedger.releaseDurableResults(readTranscriptResultIds(state.messages));
    const stored: StoredRunJournal = {
      protocol: RUN_JOURNAL_PROTOCOL,
      status,
      runKey: input.activation.runState.runKey,
      taskId: input.activation.handoff.taskId,
      taskFingerprint: input.taskFingerprint,
      updatedAt: now,
      ...cloneState(state),
      effectLedger: effectLedger.snapshot(),
    };
    const role = input.activation.thread.roles.find(
      (candidate) => candidate.roleId === input.activation.runState.roleId,
    );
    await input.store.append({
      id: journalId,
      threadId: input.activation.thread.threadId,
      role: "system",
      roleId: input.activation.runState.roleId,
      name: role?.name ?? input.activation.runState.roleId,
      content: "",
      createdAt: now,
      updatedAt: now,
      source: {
        type: "worker",
        chatType: "group",
        route: role?.seat === "lead" ? "lead-role" : "member-worker",
        speakerType: "Role",
        speakerName: role?.name ?? input.activation.runState.roleId,
      },
      metadata: {
        runtimeRunJournal: true,
        flowId: input.activation.flow.flowId,
        runJournal: stored,
      },
    });
  };
  const write = (
    status: StoredRunJournal["status"],
    state: RunJournalState,
  ): Promise<void> => writeAt(status, state, input.now());

  const persistEffectLedger = async (): Promise<void> => {
    if (!latestState) {
      throw new Error("run journal checkpoint required before effect admission");
    }
    await write("in_flight", latestState);
  };

  const enqueueEffectTransition = <T>(
    transition: () => Promise<T>,
  ): Promise<T> => {
    const queued = effectTransitionQueue.then(transition);
    effectTransitionQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  const persistLedgerTransition = async <T>(
    transition: () => T,
  ): Promise<T> => {
    const before = effectLedger.snapshot();
    try {
      const value = transition();
      await persistEffectLedger();
      return value;
    } catch (error) {
      const restored = restoreRunEffectLedger(before);
      if (!restored) {
        throw new Error("internal effect-ledger rollback failed");
      }
      effectLedger = restored;
      throw error;
    }
  };

  return {
    async load() {
      const message = await input.store.get(journalId);
      const stored = readStoredRunJournal(message);
      if (
        !stored ||
        stored.status !== "in_flight" ||
        stored.runKey !== input.activation.runState.runKey ||
        stored.taskFingerprint !== input.taskFingerprint
      ) {
        return null;
      }
      if (stored.effectLedger !== undefined) {
        const restoredLedger = restoreRunEffectLedger(stored.effectLedger);
        if (!restoredLedger) return null;
        effectLedger = restoredLedger;
      } else {
        effectLedger = new RunEffectLedger();
      }
      const state = cloneState(stored);
      latestState = cloneState(state);
      const threadMessages = await input.store.list(
        input.activation.thread.threadId,
      );
      await appendEffectLedgerResumeRound({
        threadMessages,
        activation: input.activation,
        journalUpdatedAt: message?.updatedAt ?? stored.updatedAt,
        state,
        effectLedger,
        ...(input.reconcileEffect
          ? { reconcileEffect: input.reconcileEffect }
          : {}),
      });
      await appendInterruptedNativeRound({
        threadMessages,
        activation: input.activation,
        journalUpdatedAt: message?.updatedAt ?? stored.updatedAt,
        state,
      });
      latestState = cloneState(state);
      if (effectLedger.snapshot().records.length > 0) {
        await writeAt(
          "in_flight",
          state,
          message?.updatedAt ?? stored.updatedAt,
        );
      }
      return {
        ...state,
        resumedAfterCrash: true,
      };
    },
    checkpoint: (state) => write("in_flight", state),
    complete: (state) => write("completed", state),
    effectLedger: {
      admit: (effect) =>
        enqueueEffectTransition(async () => {
          const disposition = effectLedger.admitDisposition(effect);
          if (disposition === "replay") {
            const record = effectLedger.admit(effect);
            return readDurableEffectReceipt(record, latestState);
          }
          if (disposition === "active") {
            const record = effectLedger.get(effect.call.id);
            throw new Error(
              `effect already has an active admission: ${effect.call.id}:${record?.status ?? "unknown"}`,
            );
          }
          return persistLedgerTransition(() => {
            effectLedger.admit(effect);
            return null;
          });
        }),
      start: (effectId) =>
        enqueueEffectTransition(() =>
          persistLedgerTransition(() => {
            effectLedger.start(effectId);
          }),
        ),
      recordResult: (result) =>
        enqueueEffectTransition(async () => {
          const existing = effectLedger.get(result.toolCallId);
          if (!existing) return;
          if (
            existing.status === "committed" ||
            existing.status === "failed" ||
            existing.status === "indeterminate"
          ) {
            effectLedger.recordResult(result);
            return;
          }
          await persistLedgerTransition(() => {
            effectLedger.recordResult(result);
          });
        }),
    },
  };
}

function readDurableEffectReceipt(
  record: RunEffectRecord,
  state: RunJournalState | null,
): ToolResult {
  if (record.result) return structuredClone(record.result);
  const message = [...(state?.messages ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.role === "tool" &&
        candidate.toolCallId === record.effectId,
    );
  if (!message) {
    throw new Error(`durable effect receipt is missing: ${record.effectId}`);
  }
  const resultBlock = Array.isArray(message.content)
    ? message.content.find(
        (block) =>
          block.type === "tool_result" && block.toolUseId === record.effectId,
      )
    : undefined;
  const content = typeof message.content === "string"
    ? message.content
    : resultBlock?.type === "tool_result"
      ? resultBlock.content
      : null;
  if (content === null) {
    throw new Error(`durable effect receipt content is missing: ${record.effectId}`);
  }
  const traceResult = [...(state?.toolTrace ?? [])]
    .reverse()
    .flatMap((round) => [...round.results].reverse())
    .find((result) => result.toolCallId === record.effectId);
  return {
    toolCallId: record.effectId,
    toolName: record.call.name,
    content,
    ...(record.status === "committed" && traceResult?.isError !== true
      ? {}
      : { isError: true }),
    ...(traceResult?.cancelled ? { cancelled: true } : {}),
  };
}

function readStoredRunJournal(
  message: TeamMessage | null,
): StoredRunJournal | null {
  const value = message?.metadata?.["runJournal"];
  if (!isRecord(value)) return null;
  if (
    value["protocol"] !== RUN_JOURNAL_PROTOCOL ||
    (value["status"] !== "in_flight" && value["status"] !== "completed") ||
    typeof value["runKey"] !== "string" ||
    typeof value["taskId"] !== "string" ||
    typeof value["taskFingerprint"] !== "string" ||
    typeof value["updatedAt"] !== "number" ||
    typeof value["nextRound"] !== "number" ||
    !Array.isArray(value["messages"]) ||
    !Array.isArray(value["repairMarkers"]) ||
    !Array.isArray(value["toolTrace"]) ||
    !Array.isArray(value["planState"])
  ) {
    return null;
  }
  if (!messagesAreProtocolSafe(value["messages"] as LLMMessage[])) return null;
  return value as unknown as StoredRunJournal;
}

function assertProtocolSafeJournalState(state: RunJournalState): void {
  if (!messagesAreProtocolSafe(state.messages)) {
    throw new Error("run journal checkpoint contains an incomplete tool protocol unit");
  }
}

function messagesAreProtocolSafe(messages: LLMMessage[]): boolean {
  return buildHistoryProtocolUnits(messages).every((unit) => unit.protocolSafe);
}

async function appendInterruptedNativeRound(input: {
  threadMessages: TeamMessage[];
  activation: RoleActivationInput;
  journalUpdatedAt: number;
  state: RunJournalState;
}): Promise<void> {
  const threadMessages = input.threadMessages;
  const existingResultIds = new Set(
    input.state.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
  const pendingRounds = threadMessages.filter(
    (message) =>
      message.role === "assistant" &&
      message.roleId === input.activation.runState.roleId &&
      message.toolStatus === "pending" &&
      message.metadata?.["nativeToolUse"] === true &&
      message.metadata?.["flowId"] === input.activation.flow.flowId &&
      message.updatedAt >= input.journalUpdatedAt &&
      (message.toolCalls?.length ?? 0) > 0,
  );

  for (const pending of pendingRounds) {
    const calls: LLMToolCall[] = (pending.toolCalls ?? [])
      .filter((call) => !existingResultIds.has(call.id))
      .map((call) => ({
        id: call.id,
        name: call.name,
        input: call.arguments,
      }));
    if (calls.length === 0) continue;
    const persistedResults = new Map(
      threadMessages
        .filter(
          (message) =>
            message.role === "tool" &&
            typeof message.toolCallId === "string" &&
            calls.some((call) => call.id === message.toolCallId),
        )
        .map((message) => [message.toolCallId!, message]),
    );
    const results: ToolResult[] = calls.map((call) => {
      const persisted = persistedResults.get(call.id);
      if (persisted) {
        return {
          toolCallId: call.id,
          toolName: call.name,
          content: persisted.content,
          ...(persisted.toolStatus === "failed" ? { isError: true } : {}),
          ...(persisted.toolStatus === "cancelled" ? { cancelled: true } : {}),
        };
      }
      return interruptedToolResult(call);
    });
    input.state.messages = appendAssistantToolCallMessage(
      input.state.messages,
      { text: "", toolCalls: calls },
    );
    input.state.messages = appendToolResultMessages(
      input.state.messages,
      results,
    );
    const round = readPositiveInteger(pending.metadata?.["toolRound"])
      ?? input.state.nextRound + 1;
    input.state.toolTrace.push({
      round,
      calls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      })),
      results: results.map((result) => ({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        isError: result.isError === true,
        contentBytes: Buffer.byteLength(result.content, "utf8"),
        content: result.content,
        ...(result.cancelled ? { cancelled: true } : {}),
      })),
    });
    for (const call of calls) existingResultIds.add(call.id);
    input.state.nextRound = Math.max(input.state.nextRound, round);
  }
}

function interruptedToolResult(call: LLMToolCall): ToolResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    isError: true,
    content: JSON.stringify({
      protocol: RUN_EFFECT_INDETERMINATE_PROTOCOL,
      legacy_protocol: RUN_RESUME_INTERRUPTED_TOOL_PROTOCOL,
      code: "effect_outcome_indeterminate_after_restart",
      tool_call_id: call.id,
      tool_name: call.name,
      instruction:
        "The effect may have executed, so it must not be dispatched again automatically. Reconcile by the stable tool call id or request explicit operator action.",
    }),
  };
}

async function appendEffectLedgerResumeRound(input: {
  threadMessages: TeamMessage[];
  activation: RoleActivationInput;
  journalUpdatedAt: number;
  state: RunJournalState;
  effectLedger: RunEffectLedger;
  reconcileEffect?: (
    effect: RunEffectRecord,
  ) => Promise<ToolResult | null>;
}): Promise<void> {
  const existingResultIds = new Set(
    input.state.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
  const persistedResults = new Map(
    input.threadMessages
      .filter(
        (message) =>
          message.role === "tool" &&
          message.roleId === input.activation.runState.roleId &&
          message.metadata?.["nativeToolUse"] === true &&
          message.metadata?.["flowId"] === input.activation.flow.flowId &&
          message.updatedAt >= input.journalUpdatedAt &&
          typeof message.toolCallId === "string",
      )
      .map((message) => [message.toolCallId!, toPersistedToolResult(message)]),
  );
  for (const record of input.effectLedger.snapshot().records) {
    if (record.status !== "started") continue;
    const persisted = persistedResults.get(record.effectId);
    if (persisted) {
      input.effectLedger.recordResult(persisted);
      continue;
    }
    if (input.reconcileEffect) {
      try {
        const reconciled = await input.reconcileEffect(record);
        if (reconciled) input.effectLedger.recordResult(reconciled);
      } catch {
        // A failed lookup cannot prove success or failure. The ledger converts
        // this started effect to indeterminate below and never redispatches it.
      }
    }
  }

  const resumeResults = input.effectLedger.reconcileForResume(existingResultIds);
  const byRound = new Map<number, typeof resumeResults>();
  for (const item of resumeResults) {
    const round = byRound.get(item.round) ?? [];
    round.push(item);
    byRound.set(item.round, round);
  }
  for (const [round, items] of [...byRound.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    input.state.messages = appendAssistantToolCallMessage(input.state.messages, {
      text: "",
      toolCalls: items.map((item) => item.call),
    });
    input.state.messages = appendToolResultMessages(
      input.state.messages,
      items.map((item) => item.result),
    );
    input.state.toolTrace.push({
      round,
      calls: items.map((item) => ({
        id: item.call.id,
        name: item.call.name,
        input: item.call.input,
      })),
      results: items.map((item) => ({
        toolCallId: item.result.toolCallId,
        toolName: item.result.toolName,
        isError: item.result.isError === true,
        contentBytes: Buffer.byteLength(item.result.content, "utf8"),
        content: item.result.content,
        ...(item.result.cancelled ? { cancelled: true } : {}),
      })),
    });
    input.state.nextRound = Math.max(input.state.nextRound, round);
    for (const item of items) existingResultIds.add(item.result.toolCallId);
  }
}

function toPersistedToolResult(message: TeamMessage): ToolResult {
  return {
    toolCallId: message.toolCallId!,
    toolName: message.name ?? "unknown_tool",
    content: message.content,
    ...(message.toolStatus === "failed" ? { isError: true } : {}),
    ...(message.toolStatus === "cancelled" ? { cancelled: true } : {}),
  };
}

function cloneState(state: RunJournalState): RunJournalState {
  return structuredClone({
    messages: state.messages,
    nextRound: Math.max(0, Math.floor(state.nextRound)),
    repairMarkers: state.repairMarkers,
    toolTrace: state.toolTrace,
    planState: state.planState,
  });
}

function readTranscriptResultIds(messages: readonly LLMMessage[]): Set<string> {
  return new Set(
    messages
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId)
      .filter((id): id is string => Boolean(id)),
  );
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

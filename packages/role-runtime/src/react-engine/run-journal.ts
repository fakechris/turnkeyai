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
}

export function createRunJournal(input: {
  store: Pick<TeamMessageStore, "append" | "get" | "list">;
  activation: RoleActivationInput;
  taskFingerprint: string;
  now: () => number;
}): RunJournal {
  const journalId = `runtime-journal:${input.activation.runState.runKey}`;

  const write = async (
    status: StoredRunJournal["status"],
    state: RunJournalState,
  ): Promise<void> => {
    const now = input.now();
    const stored: StoredRunJournal = {
      protocol: RUN_JOURNAL_PROTOCOL,
      status,
      runKey: input.activation.runState.runKey,
      taskId: input.activation.handoff.taskId,
      taskFingerprint: input.taskFingerprint,
      updatedAt: now,
      ...cloneState(state),
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
      const state = cloneState(stored);
      await appendInterruptedNativeRound({
        store: input.store,
        activation: input.activation,
        journalUpdatedAt: message?.updatedAt ?? stored.updatedAt,
        state,
      });
      return {
        ...state,
        resumedAfterCrash: true,
      };
    },
    checkpoint: (state) => write("in_flight", state),
    complete: (state) => write("completed", state),
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
  return value as unknown as StoredRunJournal;
}

async function appendInterruptedNativeRound(input: {
  store: Pick<TeamMessageStore, "list">;
  activation: RoleActivationInput;
  journalUpdatedAt: number;
  state: RunJournalState;
}): Promise<void> {
  const threadMessages = await input.store.list(
    input.activation.thread.threadId,
  );
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
      protocol: RUN_RESUME_INTERRUPTED_TOOL_PROTOCOL,
      code: "tool_round_interrupted_by_restart",
      tool_call_id: call.id,
      tool_name: call.name,
      instruction:
        "The previous process stopped before this tool result was durably recorded. Reissue the call only if the task still requires it.",
    }),
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

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

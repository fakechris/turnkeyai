import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type {
  ReplayRecord,
  RoleActivationInput,
  TeamMessage,
} from "@turnkeyai/core-types/team";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import type {
  GenerateTextInput,
  GenerateTextResult,
  LLMToolCall,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { NativeToolProgressTrace } from "./native-tool-messages";
import type { RolePromptPacket } from "./prompt-policy";
import {
  ENGINE_RUN_REPLAY_PROTOCOL,
  type EngineRunReplaySeed,
} from "./react-engine/run-trace";
import {
  RUN_JOURNAL_PROTOCOL,
  fingerprintRunJournalTask,
} from "./react-engine/run-journal";
import type { EnginePolicyTraceEntry } from "./react-engine/types";
import type {
  RoleToolExecutionResult,
  RoleToolExecutor,
} from "./tool-use";
import {
  TOOL_RESULT_ARTIFACT_PROTOCOL,
  type ToolResultArtifactPage,
  type ToolResultArtifactRecord,
  type ToolResultArtifactStore,
} from "./tool-result-artifact-store";

export interface EngineRunReplayResult {
  finalText: string;
  toolCalls: LLMToolCall[];
  policy: EnginePolicyTraceEntry[];
}

interface PersistedEngineRunReplay extends EngineRunReplaySeed {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  toolUse?: {
    rounds?: Array<{
      calls?: LLMToolCall[];
      results?: PersistedReplayToolResult[];
      progress?: NativeToolProgressTrace[];
    }>;
  };
}

type PersistedReplayToolResult = RoleToolExecutionResult & {
  contentBytes?: number;
  contentTruncated?: boolean;
};

export async function replayEngineRunRecord(
  record: ReplayRecord,
): Promise<EngineRunReplayResult> {
  const seed = readPersistedEngineRunReplay(record);
  let modelIndex = 0;
  let unexpectedModelCall: string | undefined;
  const gateway = Object.create(LLMGateway.prototype) as LLMGateway;
  gateway.generate = async (_input: GenerateTextInput) => {
    const scripted = seed.modelResponses[modelIndex++];
    if (!scripted) {
      const lastMessage = _input.messages.at(-1);
      const lastContent =
        typeof lastMessage?.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage?.content ?? null);
      unexpectedModelCall = [
          `run trace replay requested unexpected model call ${modelIndex}`,
          `messageCount=${_input.messages.length}`,
          `toolChoice=${JSON.stringify(_input.toolChoice ?? null)}`,
          `lastRole=${lastMessage?.role ?? "none"}`,
          `lastContent=${lastContent.slice(0, 1_000)}`,
        ].join("; ");
      throw new Error(unexpectedModelCall);
    }
    return {
      ...structuredClone(scripted.response),
      raw: { replay: true, sourceReplayId: record.replayId },
    } satisfies GenerateTextResult;
  };

  const recordedResults = new Map<string, RoleToolExecutionResult>();
  if (Array.isArray(seed.toolResults)) {
    for (const result of seed.toolResults) {
      recordedResults.set(result.toolCallId, structuredClone(result));
    }
  } else {
    for (const round of seed.toolUse?.rounds ?? []) {
      for (const result of round.results ?? []) {
      if (typeof result.content !== "string") {
        throw new Error(
          `run trace replay is missing tool result content for ${result.toolCallId}`,
        );
      }
      const replayProgress = (round.progress ?? [])
        .filter(
          (progress) =>
            progress.toolCallId === result.toolCallId &&
            !isObserverBoundaryProgress(progress),
        )
        .map(({ phase, toolName, summary, detail }) => ({
          phase,
          toolName,
          summary,
          ...(detail === undefined ? {} : { detail: structuredClone(detail) }),
        }));
      const restoredResult = restorePersistedToolResult(result);
      recordedResults.set(result.toolCallId, {
        ...restoredResult,
        ...(result.progress?.length
          ? { progress: structuredClone(result.progress) }
          : replayProgress.length > 0
            ? { progress: replayProgress }
            : {}),
      });
      }
    }
  }
  const executor: RoleToolExecutor = {
    definitions: () => structuredClone(seed.toolDefinitions),
    async execute({ call }) {
      const result = recordedResults.get(call.id);
      if (!result) {
        throw new Error(
          `run trace replay is missing tool result for ${call.name}:${call.id}`,
        );
      }
      return structuredClone(result);
    },
  };
  const runtimeTopology = readReplayRuntimeTopology(seed);
  const runJournalStore = runtimeTopology.runJournalStore
    ? createReplayRunJournalStore(seed)
    : undefined;
  let clockIndex = 0;
  const generator = new LLMRoleResponseGenerator({
    gateway,
    ...(runtimeTopology.runtimeProgressRecorder
      ? {
          runtimeProgressRecorder: {
            async record() {},
          },
        }
      : {}),
    ...(runtimeTopology.nativeToolMessageStore
      ? {
          nativeToolMessageStore: {
            async append() {},
          },
        }
      : {}),
    clock: {
      now: () => {
        const value = seed.clockValues[clockIndex++];
        if (value === undefined) {
          throw new Error(
            `run trace replay requested unexpected clock read ${clockIndex}`,
          );
        }
        return value;
      },
    },
    ...(seed.toolDefinitions.length > 0
      ? {
          toolLoop: {
            executor,
            ...seed.toolLoop,
          },
        }
      : {}),
    ...(seed.artifactExternalizationEnabled
      ? { toolResultArtifactStore: createReplayArtifactStore() }
      : {}),
    ...(runJournalStore ? { runJournalStore } : {}),
    deferToolObservability: runtimeTopology.deferToolObservability,
  });

  const reply = await generator.generate({
    activation: structuredClone(seed.activation),
    packet: structuredClone(seed.packet),
  });
  if (modelIndex !== seed.modelResponses.length) {
    const diagnosticTrace = readRecord(reply.metadata?.["runTrace"]);
    const diagnosticPolicy = readPolicyEntries(diagnosticTrace?.["policy"]);
    throw new Error(
      [
        `run trace replay consumed ${modelIndex}/${seed.modelResponses.length} model responses`,
        `clockReads=${clockIndex}/${seed.clockValues.length}`,
        `policyTail=${JSON.stringify(diagnosticPolicy.slice(-6))}`,
        unexpectedModelCall,
      ].filter(Boolean).join("; "),
    );
  }
  if (clockIndex !== seed.clockValues.length) {
    throw new Error(
      `run trace replay consumed ${clockIndex}/${seed.clockValues.length} clock values`,
    );
  }
  const trace = readRecord(reply.metadata?.["runTrace"]);
  const policy = readPolicyEntries(trace?.["policy"]);
  const toolCalls = readToolCalls(reply.metadata?.["toolUse"]);
  const expectedToolCalls = readToolCalls(seed.toolUse);

  assert.equal(
    reply.content,
    seed.expected.finalText,
    "run trace replay final text diverged",
  );
  assert.deepEqual(
    toolCalls,
    expectedToolCalls,
    "run trace replay tool-call sequence diverged",
  );
  assert.deepEqual(
    policy,
    seed.expected.policy,
    "run trace replay policy sequence diverged",
  );

  return {
    finalText: reply.content,
    toolCalls,
    policy,
  };
}

function restorePersistedToolResult(
  result: PersistedReplayToolResult,
): RoleToolExecutionResult {
  const restored = structuredClone(result);
  const currentBytes = Buffer.byteLength(restored.content, "utf8");
  const originalBytes = result.contentBytes;
  if (
    result.contentTruncated === true &&
    typeof originalBytes === "number" &&
    Number.isFinite(originalBytes) &&
    originalBytes > currentBytes
  ) {
    restored.content += " ".repeat(Math.trunc(originalBytes) - currentBytes);
  }
  return restored;
}

function isObserverBoundaryProgress(progress: NativeToolProgressTrace): boolean {
  const expectedSummary =
    progress.phase === "started"
      ? `Tool call started: ${progress.toolName}`
      : progress.phase === "completed"
        ? `Tool call completed: ${progress.toolName}`
        : progress.phase === "failed"
          ? `Tool call failed: ${progress.toolName}`
          : progress.phase === "cancelled"
            ? `Tool call cancelled: ${progress.toolName}`
            : null;
  return expectedSummary !== null && progress.summary === expectedSummary;
}

function createReplayRunJournalStore(seed: PersistedEngineRunReplay): {
  append(message: TeamMessage): Promise<void>;
  get(messageId: string): Promise<TeamMessage | null>;
  list(threadId: string): Promise<TeamMessage[]>;
} {
  const journalId = `runtime-journal:${seed.activation.runState.runKey}`;
  const timestamp = seed.clockValues[0] ?? 0;
  const role = seed.activation.thread.roles.find(
    (candidate) => candidate.roleId === seed.activation.runState.roleId,
  );
  const messages = new Map<string, TeamMessage>();
  if (seed.resumeState) {
    messages.set(journalId, {
      id: journalId,
      threadId: seed.activation.thread.threadId,
      role: "system",
      roleId: seed.activation.runState.roleId,
      name: role?.name ?? seed.activation.runState.roleId,
      content: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      source: {
        type: "worker",
        chatType: "group",
        route: role?.seat === "lead" ? "lead-role" : "member-worker",
        speakerType: "Role",
        speakerName: role?.name ?? seed.activation.runState.roleId,
      },
      metadata: {
        runtimeRunJournal: true,
        flowId: seed.activation.flow.flowId,
        runJournal: {
          protocol: RUN_JOURNAL_PROTOCOL,
          status: "in_flight",
          runKey: seed.activation.runState.runKey,
          taskId: seed.activation.handoff.taskId,
          taskFingerprint: fingerprintRunJournalTask(seed.activation),
          updatedAt: timestamp,
          ...structuredClone(seed.resumeState),
        },
      },
    });
  }
  return {
    async append(message) {
      messages.set(message.id, structuredClone(message));
    },
    async get(messageId) {
      const message = messages.get(messageId);
      return message ? structuredClone(message) : null;
    },
    async list(threadId) {
      return [...messages.values()]
        .filter((message) => message.threadId === threadId)
        .map((message) => structuredClone(message));
    },
  };
}

function readReplayRuntimeTopology(
  seed: PersistedEngineRunReplay,
): EngineRunReplaySeed["runtimeTopology"] {
  const topology = readRecord(seed.runtimeTopology);
  if (
    typeof topology?.["runtimeProgressRecorder"] === "boolean" &&
    typeof topology["nativeToolMessageStore"] === "boolean" &&
    typeof topology["runJournalStore"] === "boolean" &&
    typeof topology["deferToolObservability"] === "boolean"
  ) {
    return topology as unknown as EngineRunReplaySeed["runtimeTopology"];
  }
  // Replay records created before runtime topology was persisted came from the
  // production composition root, where all three observability sinks are on.
  return {
    runtimeProgressRecorder: true,
    nativeToolMessageStore: true,
    runJournalStore: true,
    deferToolObservability: true,
  };
}

function readPersistedEngineRunReplay(
  record: ReplayRecord,
): PersistedEngineRunReplay {
  const value = readRecord(record.metadata?.["engineRunReplay"]);
  if (
    value?.["protocol"] !== ENGINE_RUN_REPLAY_PROTOCOL ||
    !Array.isArray(value["toolDefinitions"]) ||
    !readRecord(value["toolLoop"]) ||
    typeof value["artifactExternalizationEnabled"] !== "boolean" ||
    !Array.isArray(value["modelResponses"]) ||
    !readRecord(value["expected"]) ||
    !readRecord(value["activation"]) ||
    !readRecord(value["packet"])
  ) {
    throw new Error(
      `replay ${record.replayId} does not contain a valid ${ENGINE_RUN_REPLAY_PROTOCOL} seed`,
    );
  }
  return value as unknown as PersistedEngineRunReplay;
}

function createReplayArtifactStore(): ToolResultArtifactStore {
  const artifacts = new Map<
    string,
    { record: ToolResultArtifactRecord; content: Buffer }
  >();
  return {
    async put(input) {
      const content = Buffer.from(input.content, "utf8");
      const sha256 = createHash("sha256").update(content).digest("hex");
      const artifactId = `tool-result-${createHash("sha256")
        .update(
          [
            input.threadId,
            input.runKey,
            input.toolCallId,
            input.toolName,
            sha256,
          ].join("\0"),
        )
        .digest("hex")
        .slice(0, 32)}`;
      const record: ToolResultArtifactRecord = {
        protocol: TOOL_RESULT_ARTIFACT_PROTOCOL,
        artifactId,
        threadId: input.threadId,
        runKey: input.runKey,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        sizeBytes: content.length,
        sha256,
        createdAt: input.createdAt,
      };
      artifacts.set(artifactId, { record, content });
      return record;
    },
    async read(input): Promise<ToolResultArtifactPage | null> {
      const artifact = artifacts.get(input.artifactId);
      if (!artifact) return null;
      const offsetBytes = Math.max(
        0,
        Math.min(artifact.content.length, Math.floor(input.offsetBytes)),
      );
      const nextOffsetBytes = Math.min(
        artifact.content.length,
        offsetBytes + Math.max(1, Math.floor(input.limitBytes)),
      );
      return {
        record: artifact.record,
        content: artifact.content
          .subarray(offsetBytes, nextOffsetBytes)
          .toString("utf8"),
        offsetBytes,
        nextOffsetBytes,
        eof: nextOffsetBytes >= artifact.content.length,
      };
    },
  };
}

function readToolCalls(value: unknown): LLMToolCall[] {
  const toolUse = readRecord(value);
  if (!Array.isArray(toolUse?.["rounds"])) return [];
  return toolUse["rounds"].flatMap((round) => {
    const record = readRecord(round);
    if (!Array.isArray(record?.["calls"])) return [];
    return record["calls"].filter(isToolCall).map((call) => structuredClone(call));
  });
}

function readPolicyEntries(value: unknown): EnginePolicyTraceEntry[] {
  return Array.isArray(value)
    ? value.filter(isPolicyTraceEntry).map((entry) => ({ ...entry }))
    : [];
}

function isToolCall(value: unknown): value is LLMToolCall {
  const call = readRecord(value);
  return (
    typeof call?.["id"] === "string" &&
    typeof call["name"] === "string" &&
    readRecord(call["input"]) !== null
  );
}

function isPolicyTraceEntry(value: unknown): value is EnginePolicyTraceEntry {
  const entry = readRecord(value);
  return (
    typeof entry?.["phase"] === "string" &&
    typeof entry["policyId"] === "string" &&
    (entry["outcome"] === "skipped" ||
      entry["outcome"] === "matched" ||
      entry["outcome"] === "applied") &&
    typeof entry["reason"] === "string"
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

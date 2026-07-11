import { createHash } from "node:crypto";

import {
  ProviderRequestError,
  RequestEnvelopeOverflowError,
  type ProviderRequestErrorCode,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";

import type { ModelCallBoundaryTrace } from "../model-call-trace";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import { isRunDeadlineExceeded } from "../run-deadline";
import type { EngineCloseoutReason, EnginePolicyTraceEntry } from "./types";
import type { RunJournalState } from "./run-journal";
import type { RunLifecycleSnapshot } from "./run-lifecycle";
import { TOOL_ARGUMENT_ERROR_PROTOCOL } from "./tool-argument-validator";

export const RUN_TRACE_PROTOCOL = "turnkeyai.run_trace.v1" as const;
export const ENGINE_RUN_REPLAY_PROTOCOL =
  "turnkeyai.engine_run_replay.v1" as const;
export const RUN_TRACE_MAX_BYTES = 256 * 1024;

export const RUN_INCIDENT_CATEGORIES = [
  "provider_authentication",
  "provider_not_found",
  "provider_rate_limit",
  "provider_5xx",
  "provider_network",
  "provider_timeout",
  "envelope_overflow_terminal",
  "tool_arg_invalid",
  "round_limit",
  "repair_non_convergence",
  "resume_after_crash",
  "operator_cancelled",
  "wall_clock_budget",
  "recovery_tool_budget",
  "repeated_session_inspection",
  "excessive_session_continuation",
  "sub_agent_timeout",
  "pseudo_tool_call",
  "model_error_unknown",
] as const;

export type RunIncidentCategory = (typeof RUN_INCIDENT_CATEGORIES)[number];

export interface RunTraceCompactionEvent {
  round: number;
  forced: boolean;
  messageCountBefore: number;
  messageCountAfter: number;
  sourceMessageCount: number;
}

export interface RunTracePruningEvent {
  round: number;
  prunedToolResults: number;
  toolResultBytesBefore: number;
  toolResultBytesAfter: number;
  messageCountBefore: number;
  messageCountAfter: number;
  reasons: string[];
}

export interface RunTraceExternalizationEvent {
  round: number;
  toolCallId: string;
  toolName: string;
  bytes: number;
  artifactId: string;
  sha256: string;
}

export interface RunTrace {
  protocol: typeof RUN_TRACE_PROTOCOL;
  version: 1;
  wallClock: {
    startedAt: number;
    completedAt: number;
    durationMs: number;
  };
  resumedAfterCrash: boolean;
  modelCalls: RunTraceModelCall[];
  lifecycle: RunTraceLifecycleSummary;
  toolRounds: RunTraceToolRound[];
  policy: EnginePolicyTraceEntry[];
  compactions: RunTraceCompactionEvent[];
  pruning: RunTracePruningEvent[];
  externalizations: RunTraceExternalizationEvent[];
  outcome: {
    status: "completed" | "partial" | "failed";
    closeoutReason?: EngineCloseoutReason;
    finalTextBytes: number;
    finalTextSha256: string;
  };
  incidents: Partial<Record<RunIncidentCategory, number>>;
  totals: {
    modelCalls: number;
    toolRounds: number;
    toolCalls: number;
    policyEntries: number;
    compactions: number;
    pruningEvents: number;
    externalizations: number;
  };
  diagnosticsTruncated?: boolean;
}

export interface RunTraceLifecycleSummary {
  startedModelAttempts: number;
  completedModelAttempts: number;
  failedModelAttempts: number;
  retryWaits: number;
  providerActivityEvents: number;
  inFlightAttemptIds: string[];
  lastProviderActivityAt?: number;
  terminalStatus?: RunLifecycleSnapshot["terminalStatus"];
}

export interface EngineRunDiagnostics {
  runTrace: RunTrace;
}

const ENGINE_RUN_DIAGNOSTICS_PROPERTY = "turnkeyaiEngineRunDiagnostics";

export interface RunTraceModelCall {
  index: number;
  phase: ModelCallBoundaryTrace["phase"];
  round?: number;
  durationMs: number;
  modelId: string;
  providerId: string;
  stopReason?: string;
  messageCount: number;
  toolSchemaCount: number;
  toolCallsReturned: number;
  reductionLevel?: ModelCallBoundaryTrace["reductionLevel"];
  tokens: {
    estimatedInput?: number;
    actualInput?: number;
    uncachedInput?: number;
    cacheRead?: number;
    cacheCreation?: number;
    output?: number;
    inputLimit?: number;
  };
  retryDiagnostics?: ModelCallBoundaryTrace["retryDiagnostics"];
}

export interface RunTraceToolRound {
  round: number;
  calls: Array<{ id: string; name: string }>;
  results: Array<{
    toolCallId: string;
    toolName: string;
    isError: boolean;
    cancelled?: boolean;
    skipped?: boolean;
    contentBytes: number;
    contentSha256?: string;
  }>;
}

export interface BuildRunTraceInput {
  startedAt: number;
  completedAt: number;
  resumedAfterCrash: boolean;
  modelCalls: ModelCallBoundaryTrace[];
  lifecycle?: RunLifecycleSnapshot | undefined;
  toolRounds: NativeToolRoundTrace[];
  policyEntries: EnginePolicyTraceEntry[];
  compactions: RunTraceCompactionEvent[];
  pruning: RunTracePruningEvent[];
  externalizations: RunTraceExternalizationEvent[];
  closeoutReason?: EngineCloseoutReason;
  finalText: string;
  failureCategory?: RunIncidentCategory;
}

export interface EngineRunReplaySeed {
  protocol: typeof ENGINE_RUN_REPLAY_PROTOCOL;
  runtimeTopology: {
    runtimeProgressRecorder: boolean;
    nativeToolMessageStore: boolean;
    runJournalStore: boolean;
    deferToolObservability: boolean;
  };
  toolDefinitions: LLMToolDefinition[];
  toolLoop: {
    maxRounds: number;
    maxWallClockMs?: number;
    maxParallelToolCalls?: number;
    maxToolCallsPerRound?: number;
  };
  artifactExternalizationEnabled: boolean;
  resumeState?: RunJournalState;
  clockValues: number[];
  modelResponses: Array<{
    phase: ModelCallBoundaryTrace["phase"];
    round?: number;
    response: NonNullable<ModelCallBoundaryTrace["replayResponse"]>;
  }>;
  expected: {
    finalText: string;
    policy: EnginePolicyTraceEntry[];
  };
}

export function buildEngineRunReplaySeed(input: {
  runtimeTopology: EngineRunReplaySeed["runtimeTopology"];
  toolDefinitions: LLMToolDefinition[];
  toolLoop: EngineRunReplaySeed["toolLoop"];
  artifactExternalizationEnabled: boolean;
  resumeState?: RunJournalState;
  clockValues: number[];
  modelCalls: ModelCallBoundaryTrace[];
  policyEntries: EnginePolicyTraceEntry[];
  finalText: string;
}): EngineRunReplaySeed {
  return {
    protocol: ENGINE_RUN_REPLAY_PROTOCOL,
    runtimeTopology: { ...input.runtimeTopology },
    toolDefinitions: structuredClone(input.toolDefinitions),
    toolLoop: { ...input.toolLoop },
    artifactExternalizationEnabled: input.artifactExternalizationEnabled,
    ...(input.resumeState
      ? { resumeState: structuredClone(input.resumeState) }
      : {}),
    clockValues: [...input.clockValues],
    modelResponses: input.modelCalls.flatMap((call) =>
      call.replayResponse
        ? [
            {
              phase: call.phase,
              ...(call.round === undefined ? {} : { round: call.round }),
              response: structuredClone(call.replayResponse),
            },
          ]
        : [],
    ),
    expected: {
      finalText: input.finalText,
      policy: input.policyEntries.map((entry) => ({ ...entry })),
    },
  };
}

const PROVIDER_ERROR_INCIDENT: Record<
  ProviderRequestErrorCode,
  RunIncidentCategory
> = {
  authentication: "provider_authentication",
  not_found: "provider_not_found",
  rate_limit: "provider_rate_limit",
  server_error: "provider_5xx",
  network_error: "provider_network",
  timeout: "provider_timeout",
  deadline_exceeded: "provider_timeout",
  provider_error: "model_error_unknown",
};

export const CLOSEOUT_INCIDENT_CATEGORY: Record<
  EngineCloseoutReason,
  RunIncidentCategory | null
> = {
  recovery_tool_budget: "recovery_tool_budget",
  operator_cancelled: "operator_cancelled",
  pseudo_tool_call: "pseudo_tool_call",
  wall_clock_budget: "wall_clock_budget",
  round_limit: "round_limit",
  repeated_tool_failure: "repair_non_convergence",
  repeated_session_inspection: "repeated_session_inspection",
  excessive_session_continuation: "excessive_session_continuation",
  sub_agent_timeout: "sub_agent_timeout",
  completed_sub_agent_final: null,
  tool_evidence_fallback: null,
  model_error: "model_error_unknown",
};

export function buildRunTrace(input: BuildRunTraceInput): RunTrace {
  const incidents: Partial<Record<RunIncidentCategory, number>> = {};
  if (input.resumedAfterCrash) increment(incidents, "resume_after_crash");
  if (input.failureCategory) increment(incidents, input.failureCategory);
  if (input.closeoutReason) {
    const category = CLOSEOUT_INCIDENT_CATEGORY[input.closeoutReason];
    if (category) increment(incidents, category);
  }
  for (const call of input.modelCalls) {
    for (const model of call.retryDiagnostics?.models ?? []) {
      for (const code of model.errors) {
        if (isProviderErrorCode(code)) {
          increment(incidents, PROVIDER_ERROR_INCIDENT[code]);
        }
      }
    }
  }
  for (const round of input.toolRounds) {
    for (const result of round.results) {
      if (result.content?.includes(TOOL_ARGUMENT_ERROR_PROTOCOL)) {
        increment(incidents, "tool_arg_invalid");
      }
    }
  }

  const trace: RunTrace = {
    protocol: RUN_TRACE_PROTOCOL,
    version: 1,
    wallClock: {
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: Math.max(0, input.completedAt - input.startedAt),
    },
    resumedAfterCrash: input.resumedAfterCrash,
    modelCalls: input.modelCalls.slice(-128).map(toRunTraceModelCall),
    lifecycle: summarizeRunLifecycle(input.lifecycle),
    toolRounds: input.toolRounds.slice(-64).map(toRunTraceToolRound),
    policy: input.policyEntries.slice(-512).map((entry) => ({
      ...entry,
      policyId: truncate(entry.policyId, 256),
      reason: truncate(entry.reason, 512),
    })),
    compactions: input.compactions.slice(-128),
    pruning: input.pruning.slice(-128).map((event) => ({
      ...event,
      reasons: event.reasons.slice(0, 16).map((reason) => truncate(reason, 128)),
    })),
    externalizations: input.externalizations.slice(-256),
    outcome: {
      status: input.failureCategory
        ? "failed"
        : input.closeoutReason &&
            input.closeoutReason !== "completed_sub_agent_final"
          ? "partial"
          : "completed",
      ...(input.closeoutReason ? { closeoutReason: input.closeoutReason } : {}),
      finalTextBytes: Buffer.byteLength(input.finalText, "utf8"),
      finalTextSha256: sha256(input.finalText),
    },
    incidents,
    totals: {
      modelCalls: input.modelCalls.length,
      toolRounds: input.toolRounds.length,
      toolCalls: input.toolRounds.reduce(
        (sum, round) => sum + round.calls.length,
        0,
      ),
      policyEntries: input.policyEntries.length,
      compactions: input.compactions.length,
      pruningEvents: input.pruning.length,
      externalizations: input.externalizations.length,
    },
  };
  return enforceTraceBudget(trace);
}

function summarizeRunLifecycle(
  lifecycle: RunLifecycleSnapshot | undefined,
): RunTraceLifecycleSummary {
  return {
    startedModelAttempts: lifecycle?.totals.startedModelAttempts ?? 0,
    completedModelAttempts: lifecycle?.totals.completedModelAttempts ?? 0,
    failedModelAttempts: lifecycle?.totals.failedModelAttempts ?? 0,
    retryWaits: lifecycle?.totals.retryWaits ?? 0,
    providerActivityEvents: lifecycle?.totals.providerActivityEvents ?? 0,
    inFlightAttemptIds: [...(lifecycle?.inFlightAttemptIds ?? [])].slice(-128),
    ...(lifecycle?.lastProviderActivityAt === undefined
      ? {}
      : { lastProviderActivityAt: lifecycle.lastProviderActivityAt }),
    ...(lifecycle?.terminalStatus === undefined
      ? {}
      : { terminalStatus: lifecycle.terminalStatus }),
  };
}

export function classifyRunFailure(error: unknown): RunIncidentCategory {
  if (isRunDeadlineExceeded(error)) {
    return "wall_clock_budget";
  }
  if (error instanceof RequestEnvelopeOverflowError) {
    return "envelope_overflow_terminal";
  }
  if (error instanceof ProviderRequestError) {
    return PROVIDER_ERROR_INCIDENT[error.code];
  }
  return "model_error_unknown";
}

export function attachEngineRunDiagnostics(
  error: unknown,
  diagnostics: EngineRunDiagnostics,
): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(target, ENGINE_RUN_DIAGNOSTICS_PROPERTY, {
    value: diagnostics,
    configurable: true,
  });
  return target;
}

export function readEngineRunDiagnostics(
  error: unknown,
): EngineRunDiagnostics | null {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  const diagnostics = record?.[ENGINE_RUN_DIAGNOSTICS_PROPERTY];
  if (
    typeof diagnostics !== "object" ||
    diagnostics === null ||
    Array.isArray(diagnostics)
  ) {
    return null;
  }
  const runTrace = (diagnostics as Record<string, unknown>)["runTrace"];
  return isRunTrace(runTrace) ? { runTrace } : null;
}

export function runTraceSerializedBytes(trace: RunTrace): number {
  return Buffer.byteLength(JSON.stringify(trace), "utf8");
}

function toRunTraceModelCall(call: ModelCallBoundaryTrace): RunTraceModelCall {
  return {
    index: call.index,
    phase: call.phase,
    ...(call.round === undefined ? {} : { round: call.round }),
    durationMs: call.durationMs,
    modelId: truncate(call.modelId, 256),
    providerId: truncate(call.providerId, 256),
    ...(call.stopReason ? { stopReason: truncate(call.stopReason, 128) } : {}),
    messageCount: call.messageCount,
    toolSchemaCount: call.toolSchemaCount,
    toolCallsReturned: call.toolCallsReturned,
    ...(call.reductionLevel ? { reductionLevel: call.reductionLevel } : {}),
    tokens: {
      ...(finite(call.requestEnvelope?.estimatedInputTokens)
        ? { estimatedInput: call.requestEnvelope!.estimatedInputTokens }
        : {}),
      ...(finite(call.usage?.inputTokens)
        ? { actualInput: call.usage!.inputTokens }
        : {}),
      ...(finite(call.usage?.uncachedInputTokens)
        ? { uncachedInput: call.usage!.uncachedInputTokens }
        : {}),
      ...(finite(call.usage?.cacheReadInputTokens)
        ? { cacheRead: call.usage!.cacheReadInputTokens }
        : {}),
      ...(finite(call.usage?.cacheCreationInputTokens)
        ? { cacheCreation: call.usage!.cacheCreationInputTokens }
        : {}),
      ...(finite(call.usage?.outputTokens)
        ? { output: call.usage!.outputTokens }
        : {}),
      ...(finite(call.requestEnvelope?.inputTokenLimit)
        ? { inputLimit: call.requestEnvelope!.inputTokenLimit }
        : {}),
    },
    ...(call.retryDiagnostics
      ? { retryDiagnostics: structuredClone(call.retryDiagnostics) }
      : {}),
  };
}

function toRunTraceToolRound(round: NativeToolRoundTrace): RunTraceToolRound {
  return {
    round: round.round,
    calls: round.calls.slice(0, 64).map((call) => ({
      id: truncate(call.id, 256),
      name: truncate(call.name, 256),
    })),
    results: round.results.slice(0, 64).map((result) => ({
      toolCallId: truncate(result.toolCallId, 256),
      toolName: truncate(result.toolName, 256),
      isError: result.isError,
      ...(result.cancelled ? { cancelled: true } : {}),
      ...(result.skipped ? { skipped: true } : {}),
      contentBytes: result.contentBytes,
      ...(result.content === undefined
        ? {}
        : { contentSha256: sha256(result.content) }),
    })),
  };
}

function enforceTraceBudget(trace: RunTrace): RunTrace {
  if (runTraceSerializedBytes(trace) <= RUN_TRACE_MAX_BYTES) return trace;
  const reduced: RunTrace = {
    ...trace,
    diagnosticsTruncated: true,
    modelCalls: trace.modelCalls.slice(-32),
    toolRounds: trace.toolRounds.slice(-32).map((round) => ({
      ...round,
      calls: round.calls.slice(0, 16),
      results: round.results.slice(0, 16),
    })),
    policy: trace.policy.slice(-128),
    compactions: trace.compactions.slice(-32),
    pruning: trace.pruning.slice(-32),
    externalizations: trace.externalizations.slice(-64),
  };
  if (runTraceSerializedBytes(reduced) <= RUN_TRACE_MAX_BYTES) return reduced;
  const minimal: RunTrace = {
    ...reduced,
    modelCalls: [],
    toolRounds: [],
    policy: [],
    compactions: [],
    pruning: [],
    externalizations: [],
  };
  return minimal;
}

function increment(
  counters: Partial<Record<RunIncidentCategory, number>>,
  category: RunIncidentCategory,
): void {
  counters[category] = (counters[category] ?? 0) + 1;
}

function isProviderErrorCode(value: string): value is ProviderRequestErrorCode {
  return value in PROVIDER_ERROR_INCIDENT;
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function isRunTrace(value: unknown): value is RunTrace {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["protocol"] === RUN_TRACE_PROTOCOL
  );
}

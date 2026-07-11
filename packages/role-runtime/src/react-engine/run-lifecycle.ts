import { randomUUID } from "node:crypto";

import type {
  RoleActivationInput,
  RuntimeChainPhase,
  RuntimeProgressEvent,
  RuntimeProgressRecorder,
} from "@turnkeyai/core-types/team";

import type { ModelCallBoundaryTrace } from "../model-call-trace";

export type RunLifecycleTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "deadline";

export type RunLifecycleEvent =
  | { kind: "run_started"; at: number }
  | {
      kind: "model_attempt_started";
      at: number;
      attemptId: string;
      phase: ModelCallBoundaryTrace["phase"];
      round?: number;
    }
  | {
      kind: "provider_activity";
      at: number;
      attemptId: string;
      activity: "headers" | "body" | "event";
    }
  | {
      kind: "model_retry_wait";
      at: number;
      attemptId: string;
      retry: number;
      delayMs: number;
      code: string;
    }
  | {
      kind: "model_attempt_completed";
      at: number;
      attemptId: string;
    }
  | {
      kind: "model_attempt_failed";
      at: number;
      attemptId: string;
      code: string;
      message: string;
    }
  | {
      kind: "compaction_skipped" | "compaction_failed" | "compaction_succeeded";
      at: number;
      round: number;
      forced: boolean;
      consecutiveFailures: number;
      microcompactedToolResults: number;
      reason?: string;
    }
  | {
      kind: "run_terminal";
      at: number;
      status: RunLifecycleTerminalStatus;
      message?: string;
    };

export interface RunLifecycleSnapshot {
  events: RunLifecycleEvent[];
  totals: RunLifecycleTotals;
  lastProviderActivityAt?: number;
  inFlightAttemptIds: string[];
  terminalStatus?: RunLifecycleTerminalStatus;
}

export interface RunLifecycleTotals {
  startedModelAttempts: number;
  completedModelAttempts: number;
  failedModelAttempts: number;
  retryWaits: number;
  providerActivityEvents: number;
}

export interface RunLifecycleRecorder {
  allocateModelCall(
    phase: ModelCallBoundaryTrace["phase"],
    round?: number,
  ): string;
  record(event: RunLifecycleEvent): Promise<void>;
  snapshot(): RunLifecycleSnapshot;
}

const DEFAULT_ACTIVITY_HEARTBEAT_MS = 5_000;
const DEFAULT_BLOCKING_WRITE_MS = 25;
const MAX_SNAPSHOT_EVENTS = 512;

export function createRunLifecycleRecorder(input: {
  activation: RoleActivationInput;
  recorder?: RuntimeProgressRecorder | undefined;
  activityHeartbeatMs?: number;
  blockingWriteMs?: number;
  onError?: (error: unknown) => void;
}): RunLifecycleRecorder {
  const events: RunLifecycleEvent[] = [];
  const inFlightAttemptIds = new Set<string>();
  const lastPersistedActivity = new Map<string, number>();
  const totals: RunLifecycleTotals = {
    startedModelAttempts: 0,
    completedModelAttempts: 0,
    failedModelAttempts: 0,
    retryWaits: 0,
    providerActivityEvents: 0,
  };
  const activityHeartbeatMs = Math.max(
    0,
    input.activityHeartbeatMs ?? DEFAULT_ACTIVITY_HEARTBEAT_MS,
  );
  const blockingWriteMs = Math.max(
    0,
    input.blockingWriteMs ?? DEFAULT_BLOCKING_WRITE_MS,
  );
  let lastProviderActivityAt: number | undefined;
  let terminalStatus: RunLifecycleTerminalStatus | undefined;
  let sequence = 0;
  let modelCallSequence = 0;
  const instanceId = randomUUID();

  return {
    allocateModelCall(phase, round) {
      modelCallSequence += 1;
      return `${phase}:${round ?? "none"}:${modelCallSequence}`;
    },
    async record(event) {
      events.push(event);
      if (events.length > MAX_SNAPSHOT_EVENTS) events.shift();
      updateSnapshotState(event);

      if (!input.recorder || !shouldPersist(event)) return;
      const progress = toRuntimeProgressEvent({
        activation: input.activation,
        event,
        instanceId,
        sequence: ++sequence,
      });
      const pending = input.recorder.record(progress).catch((error) => {
        if (input.onError) {
          input.onError(error);
        } else {
          console.error("runtime lifecycle progress recording failed", {
            runKey: input.activation.runState.runKey,
            taskId: input.activation.handoff.taskId,
            lifecycleKind: event.kind,
            error,
          });
        }
      });
      if (blockingWriteMs === 0) {
        void pending;
        return;
      }
      await waitAtMost(pending, blockingWriteMs);
    },
    snapshot() {
      return {
        events: events.map(cloneEvent),
        totals: { ...totals },
        ...(lastProviderActivityAt === undefined
          ? {}
          : { lastProviderActivityAt }),
        inFlightAttemptIds: [...inFlightAttemptIds],
        ...(terminalStatus === undefined ? {} : { terminalStatus }),
      };
    },
  };

  function updateSnapshotState(event: RunLifecycleEvent): void {
    if (event.kind === "model_attempt_started") {
      totals.startedModelAttempts += 1;
      inFlightAttemptIds.add(event.attemptId);
      return;
    }
    if (event.kind === "provider_activity") {
      totals.providerActivityEvents += 1;
      lastProviderActivityAt = event.at;
      return;
    }
    if (event.kind === "model_retry_wait") {
      totals.retryWaits += 1;
      return;
    }
    if (
      event.kind === "model_attempt_completed" ||
      event.kind === "model_attempt_failed"
    ) {
      if (event.kind === "model_attempt_completed") {
        totals.completedModelAttempts += 1;
      } else {
        totals.failedModelAttempts += 1;
      }
      inFlightAttemptIds.delete(event.attemptId);
      return;
    }
    if (event.kind === "run_terminal") terminalStatus = event.status;
  }

  function shouldPersist(event: RunLifecycleEvent): boolean {
    if (event.kind !== "provider_activity") return true;
    const previous = lastPersistedActivity.get(event.attemptId);
    if (previous !== undefined && event.at - previous < activityHeartbeatMs) {
      return false;
    }
    lastPersistedActivity.set(event.attemptId, event.at);
    return true;
  }
}

async function waitAtMost(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toRuntimeProgressEvent(input: {
  activation: RoleActivationInput;
  event: RunLifecycleEvent;
  instanceId: string;
  sequence: number;
}): RuntimeProgressEvent {
  const { activation, event } = input;
  const terminal = event.kind === "run_terminal";
  const phase = progressPhase(event);
  return {
    progressId: `progress:run-lifecycle:${activation.handoff.taskId}:${input.instanceId}:${input.sequence}`,
    threadId: activation.thread.threadId,
    chainId: `flow:${activation.flow.flowId}`,
    spanId: `role:${activation.runState.runKey}`,
    ...(activation.runState.lastDequeuedTaskId
      ? { parentSpanId: `dispatch:${activation.runState.lastDequeuedTaskId}` }
      : {}),
    subjectKind: "role_run",
    subjectId: activation.runState.runKey,
    phase,
    progressKind:
      event.kind === "provider_activity" ? "heartbeat" : "boundary",
    heartbeatSource:
      event.kind === "provider_activity" ? "activity_echo" : "control_path",
    continuityState: terminal
      ? event.status === "completed"
        ? "resolved"
        : "terminal"
      : event.kind === "model_retry_wait"
        ? "waiting"
        : event.kind === "model_attempt_failed" || event.kind === "compaction_failed"
          ? "transient_failure"
          : event.kind === "compaction_skipped"
            ? "waiting"
          : "alive",
    ...(terminal
      ? {
          closeKind:
            event.status === "completed"
              ? ("completed" as const)
              : event.status === "cancelled"
                ? ("cancelled" as const)
                : event.status === "deadline"
                  ? ("timeout" as const)
                  : ("worker_failed" as const),
        }
      : {}),
    summary: summarize(event),
    recordedAt: event.at,
    flowId: activation.flow.flowId,
    taskId: activation.handoff.taskId,
    roleId: activation.runState.roleId,
    metadata: {
      eventType: "run.lifecycle",
      lifecycleKind: event.kind,
      ...eventMetadata(event),
    },
  };
}

function progressPhase(event: RunLifecycleEvent): RuntimeChainPhase {
  if (event.kind === "provider_activity") return "heartbeat";
  if (event.kind === "model_retry_wait") return "waiting";
  if (event.kind === "model_attempt_failed") return "failed";
  if (event.kind === "compaction_failed") return "failed";
  if (event.kind === "compaction_skipped") return "waiting";
  if (event.kind === "compaction_succeeded") return "completed";
  if (event.kind === "run_terminal") {
    if (event.status === "completed") return "completed";
    if (event.status === "cancelled") return "cancelled";
    return "failed";
  }
  return "started";
}

function summarize(event: RunLifecycleEvent): string {
  switch (event.kind) {
    case "run_started":
      return "Role run started.";
    case "model_attempt_started":
      return `Model attempt ${event.attemptId} started.`;
    case "provider_activity":
      return `Provider activity received for ${event.attemptId}.`;
    case "model_retry_wait":
      return `Model attempt ${event.attemptId} is waiting for retry ${event.retry}.`;
    case "model_attempt_completed":
      return `Model attempt ${event.attemptId} completed.`;
    case "model_attempt_failed":
      return `Model attempt ${event.attemptId} failed: ${event.message}`;
    case "compaction_skipped":
      return `Context compaction skipped at round ${event.round}: ${event.reason ?? "not required"}.`;
    case "compaction_failed":
      return `Context compaction failed at round ${event.round}.`;
    case "compaction_succeeded":
      return `Context compaction succeeded at round ${event.round}.`;
    case "run_terminal":
      return event.message ?? `Role run ended with status ${event.status}.`;
  }
}

function eventMetadata(event: RunLifecycleEvent): Record<string, unknown> {
  if (event.kind === "run_started") return {};
  if (event.kind === "run_terminal") {
    return {
      status: event.status,
      ...(event.message ? { message: event.message } : {}),
    };
  }
  if (
    event.kind === "compaction_skipped" ||
    event.kind === "compaction_failed" ||
    event.kind === "compaction_succeeded"
  ) {
    return {
      round: event.round,
      forced: event.forced,
      consecutiveFailures: event.consecutiveFailures,
      microcompactedToolResults: event.microcompactedToolResults,
      ...(event.reason ? { reason: event.reason } : {}),
    };
  }
  if (!("attemptId" in event)) return {};
  const common = { attemptId: event.attemptId };
  if (event.kind === "model_attempt_started") {
    return {
      ...common,
      phase: event.phase,
      ...(event.round === undefined ? {} : { round: event.round }),
    };
  }
  if (event.kind === "provider_activity") {
    return { ...common, activity: event.activity };
  }
  if (event.kind === "model_retry_wait") {
    return {
      ...common,
      retry: event.retry,
      delayMs: event.delayMs,
      code: event.code,
    };
  }
  if (event.kind === "model_attempt_failed") {
    return { ...common, code: event.code, message: event.message };
  }
  return common;
}

function cloneEvent(event: RunLifecycleEvent): RunLifecycleEvent {
  return { ...event };
}

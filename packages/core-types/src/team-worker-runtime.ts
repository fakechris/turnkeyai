import type {
  ContinuityMode,
  FlowId,
  RuntimeError,
  RoleActivationInput,
  RoleId,
  RunKey,
  SpawnedWorker,
  TaskId,
  TeamMessage,
  ThreadId,
  WorkerKind,
} from "./team-core";
import type { RolePromptPacketLike } from "./team-orchestration";
import type { WorkerStartupReconcileResult } from "./team-startup-reconcile";

export interface WorkerInvocationInput {
  activation: RoleActivationInput;
  packet: RolePromptPacketLike;
  sessionState?: WorkerSessionState;
}

export interface WorkerHandler {
  kind: WorkerKind;
  canHandle(input: WorkerInvocationInput): boolean | Promise<boolean>;
  run(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null>;
}

export interface WorkerRegistry {
  selectHandler(input: WorkerInvocationInput): Promise<WorkerHandler | null>;
  getHandler?(kind: WorkerKind): WorkerHandler | null | Promise<WorkerHandler | null>;
}

export interface WorkerExecutionResult {
  workerType: WorkerKind;
  status: "completed" | "partial" | "failed";
  summary: string;
  payload: unknown;
}

export interface WorkerSessionState {
  workerRunKey: RunKey;
  workerType: WorkerKind;
  status: "idle" | "running" | "waiting_input" | "waiting_external" | "resumable" | "done" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  currentTaskId?: TaskId;
  lastResult?: WorkerExecutionResult;
  lastError?: RuntimeError;
  continuationDigest?: {
    reason: "follow_up" | "timeout_summary" | "user_resume" | "supervisor_retry";
    summary: string;
    createdAt: number;
  };
}

export interface WorkerContinuationOutcome {
  state: "resumed_existing" | "cold_recreated" | "spawned_fresh";
  requestedMode?: ContinuityMode | null;
  requestedWorkerType?: WorkerKind;
  requestedWorkerRunKey?: RunKey;
  resolvedWorkerType?: WorkerKind;
  resolvedWorkerRunKey?: RunKey;
  reason?:
    | "fresh_requested"
    | "no_bound_session"
    | "session_missing"
    | "session_terminal"
    | "capability_unavailable"
    | "reuse_disallowed";
  summary: string;
}

export const WORKER_CONTINUATION_REASONS = [
  "fresh_requested",
  "no_bound_session",
  "session_missing",
  "session_terminal",
  "capability_unavailable",
  "reuse_disallowed",
] as const;

export interface WorkerSessionContextRecord {
  threadId: ThreadId;
  flowId: FlowId;
  taskId: TaskId;
  roleId: RoleId;
  parentSpanId: string;
}

export interface WorkerSessionRecord {
  workerRunKey: RunKey;
  state: WorkerSessionState;
  executionToken: number;
  context?: WorkerSessionContextRecord;
}

export interface WorkerMessageInput {
  workerRunKey: RunKey;
  activation: RoleActivationInput;
  packet: RolePromptPacketLike;
}

export interface WorkerResumeInput {
  workerRunKey: RunKey;
  activation: RoleActivationInput;
  packet: RolePromptPacketLike;
}

export interface WorkerInterruptInput {
  workerRunKey: RunKey;
  reason?: string;
}

export interface WorkerCancelInput {
  workerRunKey: RunKey;
  reason?: string;
}

export interface RoleRuntimeResult {
  status: "ok" | "failed" | "delegated";
  message?: TeamMessage;
  mentions?: RoleId[];
  spawnedWorkers?: SpawnedWorker[];
  workerBindings?: Array<{ workerType: WorkerKind; workerRunKey: RunKey }>;
  error?: RuntimeError;
}

export interface RoleRuntime {
  runActivation(input: RoleActivationInput): Promise<RoleRuntimeResult>;
}

export interface WorkerRuntime {
  spawn(input: WorkerInvocationInput): Promise<SpawnedWorker | null>;
  send(input: WorkerMessageInput): Promise<WorkerExecutionResult | null>;
  resume(input: WorkerResumeInput): Promise<WorkerExecutionResult | null>;
  interrupt(input: WorkerInterruptInput): Promise<WorkerSessionState | null>;
  cancel(input: WorkerCancelInput): Promise<WorkerSessionState | null>;
  getState(workerRunKey: RunKey): Promise<WorkerSessionState | null>;
  maybeRunForRole(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null>;
  reconcileStartup?(): Promise<WorkerStartupReconcileResult>;
  listSessions?(): Promise<WorkerSessionRecord[]>;
}

export interface WorkerSessionStore {
  get(workerRunKey: RunKey): Promise<WorkerSessionRecord | null>;
  put(record: WorkerSessionRecord): Promise<void>;
  list(limit?: number): Promise<WorkerSessionRecord[]>;
}

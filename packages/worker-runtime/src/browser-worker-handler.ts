import type {
  BrowserBridge,
  FailureSummary,
  ReplayStore,
  RuntimeProgressRecorder,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
} from "@turnkeyai/core-types/team";
import { BrowserResultVerifier } from "@turnkeyai/qc-runtime/browser-result-verifier";
import { BrowserStepVerifier } from "@turnkeyai/qc-runtime/browser-step-verifier";
import { classifyFailureFromStatus, classifyRuntimeError } from "@turnkeyai/qc-runtime/failure-taxonomy";
import { buildBrowserReplayRecord } from "@turnkeyai/qc-runtime/file-replay-recorder";

import { DefaultBrowserTaskPlanner } from "./browser-task-planner";

const ACTIVE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;
const RECONNECT_WINDOW_MS = 60 * 1000;
const LONG_RUNNING_HEARTBEAT_MS = 15 * 1000;

export class BrowserWorkerHandler implements WorkerHandler {
  readonly kind = "browser" as const;
  private readonly browserBridge: BrowserBridge;
  private readonly planner: DefaultBrowserTaskPlanner;
  private readonly stepVerifier: BrowserStepVerifier;
  private readonly resultVerifier: BrowserResultVerifier;
  private readonly replayRecorder: ReplayStore | undefined;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly heartbeatIntervalMs: number;

  constructor(options: {
    browserBridge: BrowserBridge;
    planner?: DefaultBrowserTaskPlanner;
    stepVerifier?: BrowserStepVerifier;
    resultVerifier?: BrowserResultVerifier;
    replayRecorder?: ReplayStore;
    runtimeProgressRecorder?: RuntimeProgressRecorder;
    heartbeatIntervalMs?: number;
  }) {
    this.browserBridge = options.browserBridge;
    this.planner = options.planner ?? new DefaultBrowserTaskPlanner();
    this.stepVerifier = options.stepVerifier ?? new BrowserStepVerifier();
    this.resultVerifier = options.resultVerifier ?? new BrowserResultVerifier();
    this.replayRecorder = options.replayRecorder;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? LONG_RUNNING_HEARTBEAT_MS;
  }

  async canHandle(input: WorkerInvocationInput): Promise<boolean> {
    const role = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
    if (!role) {
      return false;
    }

    const capabilities = new Set(role.capabilities ?? []);
    return capabilities.has("browser") || /operator|browser/i.test(role.name);
  }

  async run(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null> {
    const request = this.planner.buildRequest(input);
    if (!request) {
      return null;
    }

    try {
      await this.recordBrowserProgress(input, {
        phase: "started",
        continuityState: request.browserSessionId ? "alive" : "waiting",
        heartbeatSource: "phase_transition",
        summary: request.browserSessionId
          ? `Browser session ${request.browserSessionId} handling task ${request.taskId}`
          : `Browser session spawn requested for task ${request.taskId}`,
        ...(request.browserSessionId ? { browserSessionId: request.browserSessionId } : {}),
        ...(request.targetId ? { targetId: request.targetId } : {}),
      });
      const stopHeartbeat = this.startBrowserHeartbeat(input, request);
      const result = await this.executeBrowserDispatch(input, request).finally(() => {
        stopHeartbeat();
      });
      await this.recordBrowserProgress(input, {
        browserSessionId: result.sessionId,
        phase: "completed",
        continuityState: result.resumeMode === "cold" ? "reconnecting" : "resolved",
        heartbeatSource: result.resumeMode === "cold" ? "reconnect_window" : "activity_echo",
        ...(result.resumeMode === "cold" ? { reconnectWindowUntil: Date.now() + RECONNECT_WINDOW_MS } : {}),
        summary: summarizeBrowserTask(result),
        ...(result.targetId ? { targetId: result.targetId } : {}),
      });
      const quality = await this.collectQuality(request, result);
      const failure = classifyFailureFromStatus({
        layer: "browser",
        status: "completed",
        summary: summarizeBrowserTask(result),
        payload: {
          ...result,
          quality,
        },
      });

      return {
        workerType: this.kind,
        status: "completed",
        summary: summarizeBrowserTask(result),
        payload: {
          ...result,
          quality,
          ...(failure ? { failure } : {}),
        },
      };
    } catch (error) {
      const failedResult = buildFailedBrowserTaskResult(request, error);
      const continuityFailure = classifyBrowserContinuityFailure(error);
      await this.recordBrowserProgress(input, {
        browserSessionId: failedResult.sessionId,
        phase: "failed",
        continuityState: continuityFailure.continuityState,
        ...(continuityFailure.heartbeatSource ? { heartbeatSource: continuityFailure.heartbeatSource } : {}),
        ...(continuityFailure.reconnectWindowUntil
          ? { reconnectWindowUntil: continuityFailure.reconnectWindowUntil }
          : {}),
        summary: summarizeBrowserFailure(failedResult, error),
        statusReason: error instanceof Error ? error.message : "browser worker failed",
        closeKind: continuityFailure.closeKind,
        ...(failedResult.targetId ? { targetId: failedResult.targetId } : {}),
      });
      const quality = await this.collectQuality(request, failedResult);
      const failure = classifyRuntimeError({
        layer: "browser",
        error,
        fallbackMessage: "browser worker failed",
      });

      return {
        workerType: this.kind,
        status: "failed",
        summary: summarizeBrowserFailure(failedResult, error),
        payload: {
          ...failedResult,
          quality,
          error: error instanceof Error ? error.message : "browser worker failed",
          failure,
        },
      };
    }
  }

  private async executeBrowserDispatch(
    input: WorkerInvocationInput,
    request: Parameters<BrowserBridge["runTask"]>[0]
  ): Promise<Awaited<ReturnType<BrowserBridge["runTask"]>>> {
    if (!request.browserSessionId) {
      return this.browserBridge.spawnSession(request);
    }

    if (input.packet.continuityMode === "resume-existing") {
      return this.browserBridge.resumeSession({ ...request, browserSessionId: request.browserSessionId });
    }

    return this.browserBridge.sendSession({ ...request, browserSessionId: request.browserSessionId });
  }

  private async collectQuality(
    request: Parameters<BrowserBridge["runTask"]>[0],
    result: Awaited<ReturnType<BrowserBridge["runTask"]>>
  ): Promise<{
    stepReport: ReturnType<BrowserStepVerifier["verify"]> | null;
    resultReport: ReturnType<BrowserResultVerifier["verify"]> | null;
    replayPath: string | null;
    failure?: FailureSummary;
    errors?: string[];
  }> {
    const quality: {
      stepReport: ReturnType<BrowserStepVerifier["verify"]> | null;
      resultReport: ReturnType<BrowserResultVerifier["verify"]> | null;
      replayPath: string | null;
      errors: string[];
    } = {
      stepReport: null,
      resultReport: null,
      replayPath: null,
      errors: [],
    };

    try {
      quality.stepReport = this.stepVerifier.verify({ request, trace: result.trace });
    } catch (error) {
      quality.errors.push(`step verification failed: ${toErrorMessage(error)}`);
    }

    try {
      quality.resultReport = this.resultVerifier.verify(result);
    } catch (error) {
      quality.errors.push(`result verification failed: ${toErrorMessage(error)}`);
    }

    try {
      if (this.replayRecorder && quality.stepReport && quality.resultReport) {
        quality.replayPath = await this.replayRecorder.record(
          buildBrowserReplayRecord({
            request,
            result,
            stepReport: quality.stepReport,
            resultReport: quality.resultReport,
          })
        );
      }
    } catch (error) {
      quality.errors.push(`replay recording failed: ${toErrorMessage(error)}`);
    }

    if (quality.errors.length > 0) {
      return quality;
    }

    return {
      stepReport: quality.stepReport,
      resultReport: quality.resultReport,
      replayPath: quality.replayPath,
    };
  }

  private async recordBrowserProgress(
    input: WorkerInvocationInput,
    event: {
      browserSessionId?: string;
      targetId?: string;
      phase: "started" | "heartbeat" | "completed" | "failed";
      continuityState: "alive" | "waiting" | "reconnecting" | "resolved" | "terminal" | "transient_failure";
      heartbeatSource?: "phase_transition" | "activity_echo" | "reconnect_window" | "long_running_tick";
      summary: string;
      statusReason?: string;
      reconnectWindowUntil?: number;
      closeKind?: "completed" | "session_not_found" | "detached_target" | "lease_conflict" | "owner_mismatch" | "transport_failure" | "unknown";
    }
  ): Promise<void> {
    if (!this.runtimeProgressRecorder) {
      return;
    }
    await this.runtimeProgressRecorder.record({
      progressId: `progress:browser:${input.activation.handoff.taskId}:${event.phase}:${Date.now()}`,
      threadId: input.activation.thread.threadId,
      chainId: `flow:${input.activation.flow.flowId}`,
      spanId: `browser:task:${input.activation.handoff.taskId}`,
      parentSpanId: `worker:worker:browser:task:${input.activation.handoff.taskId}`,
      subjectKind: "browser_session",
      subjectId: `pending:${input.activation.handoff.taskId}`,
      phase: event.phase,
      progressKind:
        event.phase === "started" || event.phase === "heartbeat" || event.continuityState === "reconnecting"
          ? "heartbeat"
          : "transition",
      ...(event.heartbeatSource ? { heartbeatSource: event.heartbeatSource } : {}),
      continuityState: event.continuityState,
      ...(event.phase === "started" || event.phase === "heartbeat"
        ? { responseTimeoutAt: Date.now() + ACTIVE_RESPONSE_TIMEOUT_MS }
        : {}),
      ...(event.reconnectWindowUntil ? { reconnectWindowUntil: event.reconnectWindowUntil } : {}),
      ...(event.closeKind ? { closeKind: event.closeKind } : {}),
      summary: event.summary,
      recordedAt: Date.now(),
      flowId: input.activation.flow.flowId,
      taskId: input.activation.handoff.taskId,
      roleId: input.activation.runState.roleId,
      workerType: this.kind,
      ...(event.statusReason ? { statusReason: event.statusReason } : {}),
      artifacts: {
        ...(event.browserSessionId ? { browserSessionId: event.browserSessionId } : {}),
        ...(event.targetId ? { browserTargetId: event.targetId } : {}),
        dispatchTaskId: input.activation.handoff.taskId,
      },
    });
  }

  private startBrowserHeartbeat(
    input: WorkerInvocationInput,
    request: Parameters<BrowserBridge["runTask"]>[0]
  ): () => void {
    if (!this.runtimeProgressRecorder || this.heartbeatIntervalMs <= 0) {
      return () => {};
    }
    const timer = setInterval(() => {
      void this.recordBrowserProgress(input, {
        phase: "heartbeat",
        continuityState: request.browserSessionId ? "alive" : "waiting",
        heartbeatSource: "long_running_tick",
        summary: request.browserSessionId
          ? `Browser session ${request.browserSessionId} is still processing task ${request.taskId}.`
          : `Browser session spawn is still processing task ${request.taskId}.`,
        ...(request.browserSessionId ? { browserSessionId: request.browserSessionId } : {}),
        ...(request.targetId ? { targetId: request.targetId } : {}),
      }).catch((error) => {
        console.error("browser heartbeat progress recording failed", {
          taskId: input.activation.handoff.taskId,
          browserSessionId: request.browserSessionId,
          error,
        });
      });
    }, this.heartbeatIntervalMs);
    return () => clearInterval(timer);
  }
}

function summarizeBrowserTask(result: Awaited<ReturnType<BrowserBridge["runTask"]>>): string {
  return [
    `Browser worker completed session ${result.sessionId}.`,
    `Final URL: ${result.page.finalUrl}.`,
    `Page title: ${result.page.title}.`,
    `Excerpt: ${result.page.textExcerpt}`,
    `Trace steps: ${result.trace.map((step) => step.kind).join(" -> ")}.`,
    result.screenshotPaths.length > 0 ? `Screenshots: ${result.screenshotPaths.join(", ")}` : "Screenshots: none",
  ].join("\n");
}

function summarizeBrowserFailure(
  result: Awaited<ReturnType<BrowserBridge["runTask"]>>,
  error: unknown
): string {
  return [
    `Browser worker failed for session ${result.sessionId}.`,
    `Requested URL: ${result.page.requestedUrl}.`,
    `Error: ${error instanceof Error ? error.message : "browser worker failed"}.`,
  ].join("\n");
}

function classifyBrowserContinuityFailure(error: unknown): {
  continuityState: "terminal" | "transient_failure" | "reconnecting";
  heartbeatSource?: "reconnect_window";
  closeKind: "session_not_found" | "detached_target" | "lease_conflict" | "owner_mismatch" | "transport_failure" | "unknown";
  reconnectWindowUntil?: number;
} {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/session not found/i.test(message)) {
    return {
      continuityState: "reconnecting",
      heartbeatSource: "reconnect_window",
      closeKind: "session_not_found",
      reconnectWindowUntil: Date.now() + RECONNECT_WINDOW_MS,
    };
  }
  if (/detached target|invalid resume/i.test(message)) {
    return {
      continuityState: "reconnecting",
      heartbeatSource: "reconnect_window",
      closeKind: "detached_target",
      reconnectWindowUntil: Date.now() + RECONNECT_WINDOW_MS,
    };
  }
  if (/lease conflict/i.test(message)) {
    return {
      continuityState: "transient_failure",
      closeKind: "lease_conflict",
    };
  }
  if (/owner mismatch|browser session owner mismatch/i.test(message)) {
    return {
      continuityState: "terminal",
      closeKind: "owner_mismatch",
    };
  }
  if (/transport|cdp|playwright|websocket|timed out|timeout/i.test(message)) {
    return {
      continuityState: "transient_failure",
      closeKind: "transport_failure",
    };
  }
  return {
    continuityState: "terminal",
    closeKind: "unknown",
  };
}

function buildFailedBrowserTaskResult(
  request: { taskId: string; threadId: string; instructions: string },
  error: unknown
): Awaited<ReturnType<BrowserBridge["runTask"]>> {
  return {
    sessionId: `failed-${request.taskId}`,
    page: {
      requestedUrl: extractRequestedUrl(request.instructions),
      finalUrl: "",
      title: "",
      textExcerpt: "",
      statusCode: 0,
      interactives: [],
    },
    screenshotPaths: [],
    artifactIds: [],
    trace: [
      {
        stepId: `${request.taskId}:browser-step:failed`,
        kind: "open",
        startedAt: Date.now(),
        completedAt: Date.now(),
        status: "failed",
        input: {
          instructions: request.instructions,
        },
        errorMessage: error instanceof Error ? error.message : "browser worker failed",
      },
    ],
  };
}

function extractRequestedUrl(instructions: string): string {
  const match = instructions.match(/https?:\/\/[^\s)]+/i);
  const raw = match?.[0];
  if (!raw) {
    return "";
  }

  return raw.replace(/["'`,;。，“”‘’]+$/g, "");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

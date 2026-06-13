import type {
  BrowserBridge,
  BrowserSideEffectApprovalContext,
  BrowserSessionOwnerType,
  BrowserTaskAction,
  BrowserTaskResult,
  Clock,
  RoleActivationInput,
  RuntimeProgressRecorder,
  WorkerSessionHistoryEntry,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
  WorkerKind,
  WorkerSessionState,
} from "@turnkeyai/core-types/team";
import { MAX_BROWSER_OPEN_TIMEOUT_MS } from "@turnkeyai/core-types/team";
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import type { LLMToolDefinition } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { NativeToolRoundTrace } from "./native-tool-messages";
import type { RolePromptPacket } from "./prompt-policy";
import { SESSION_TOOL_NAMES } from "./tool-capability-registry";
import type { RoleToolExecutionInput, RoleToolExecutionResult, RoleToolExecutor } from "./tool-use";
import { summarizeWorkerSessionEvidence } from "./worker-session-transcript";

const DEFAULT_BROWSER_SUB_AGENT_MAX_ROUNDS = 15;
const DEFAULT_EXPLORE_SUB_AGENT_MAX_ROUNDS = 8;
const DEFAULT_GENERAL_SUB_AGENT_MAX_ROUNDS = 10;
const DEFAULT_BROWSER_WALL_CLOCK_MS = 18 * 60 * 1000;
const DEFAULT_EXPLORE_WALL_CLOCK_MS = 90 * 1000;
const DEFAULT_GENERAL_WALL_CLOCK_MS = 3 * 60 * 1000;
const SESSION_TOOL_NAME_SET = new Set<string>(SESSION_TOOL_NAMES);
const BROWSER_FAILURE_BUCKETS = [
  "target_not_found",
  "attach_failed",
  "expert_session_detached",
  "cdp_command_timeout",
  "browser_cdp_unavailable",
  "detached_target",
  "session_not_found",
  "transport_failure",
  "owner_mismatch",
  "lease_conflict",
] as const;
let fallbackWorkerRunKeyCounter = 0;

export interface LLMSubAgentWorkerHandlerOptions {
  kind: WorkerKind;
  innerHandler: WorkerHandler;
  gateway: LLMGateway;
  browserBridge?: BrowserBridge;
  runtimeProgressRecorder?: RuntimeProgressRecorder;
  clock?: Clock;
  maxRounds?: number;
  maxWallClockMs?: number;
}

export class LLMSubAgentWorkerHandler implements WorkerHandler {
  readonly kind: WorkerKind;
  private readonly innerHandler: WorkerHandler;
  private readonly gateway: LLMGateway;
  private readonly browserBridge: BrowserBridge | undefined;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly clock: Clock;
  private readonly maxRounds: number;
  private readonly maxWallClockMs: number;

  constructor(options: LLMSubAgentWorkerHandlerOptions) {
    this.kind = options.kind;
    this.innerHandler = options.innerHandler;
    this.gateway = options.gateway;
    this.browserBridge = options.browserBridge;
    this.runtimeProgressRecorder = options.runtimeProgressRecorder;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxRounds =
      options.maxRounds ??
      (options.kind === "browser"
        ? DEFAULT_BROWSER_SUB_AGENT_MAX_ROUNDS
        : options.kind === "explore"
          ? DEFAULT_EXPLORE_SUB_AGENT_MAX_ROUNDS
          : DEFAULT_GENERAL_SUB_AGENT_MAX_ROUNDS);
    this.maxWallClockMs =
      options.maxWallClockMs ??
      (options.kind === "browser"
        ? DEFAULT_BROWSER_WALL_CLOCK_MS
        : options.kind === "explore"
          ? DEFAULT_EXPLORE_WALL_CLOCK_MS
          : DEFAULT_GENERAL_WALL_CLOCK_MS);
  }

  async canHandle(input: WorkerInvocationInput): Promise<boolean> {
    if (!prefersWorkerKind(input, this.kind)) {
      return false;
    }
    return this.innerHandler.canHandle(input);
  }

  async run(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null> {
    if (input.signal?.aborted) {
      return abortedResult(this.kind);
    }

    const executor = new SubAgentToolExecutor({
      kind: this.kind,
      innerHandler: this.innerHandler,
      parentInput: input,
      ...(this.browserBridge ? { browserBridge: this.browserBridge } : {}),
    });
    const generator = new LLMRoleResponseGenerator({
      gateway: this.gateway,
      ...(this.runtimeProgressRecorder ? { runtimeProgressRecorder: this.runtimeProgressRecorder } : {}),
      clock: this.clock,
      toolLoop: {
        executor,
        maxRounds: this.maxRounds,
        maxWallClockMs: this.maxWallClockMs,
        maxParallelToolCalls: 1,
        ...(this.runtimeProgressRecorder ? { runtimeProgressRecorder: this.runtimeProgressRecorder } : {}),
      },
    });

    try {
      const reply = await generator.generate({
        activation: input.activation,
        packet: buildSubAgentPromptPacket({
          kind: this.kind,
          activation: input.activation,
          input,
          maxRounds: this.maxRounds,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const browserRecovery =
        this.kind === "browser" ? summarizeBrowserPrivateToolRecovery(reply.metadata ?? {}) : null;
      const browserArtifacts =
        this.kind === "browser" ? collectBrowserPrivateToolArtifacts(reply.metadata ?? {}) : null;
      const summary = browserRecovery
        ? `${browserRecovery.summary} ${summarizeReply(reply.content)}`
        : summarizeReply(reply.content);
      // Run-level status must reflect how the inner tool loop ended, not just
      // that it produced text. Exhaustion closeouts (round/wall-clock budget,
      // repeated tool failure, local evidence fallback, cancellation) mean the
      // final text was forced from incomplete work — reporting "completed"
      // would let the parent loop treat it as authoritative completion
      // evidence (findCompletedSessionEvidence keys on status === "completed").
      const exhaustionReason = readExhaustionCloseoutReason(reply.metadata);
      const resumableReason = isTimeoutSummaryInvocation(input)
        ? "timeout_summary"
        : exhaustionReason;
      const status = resumableReason ? "partial" : "completed";
      return {
        workerType: this.kind,
        status,
        summary,
        payload: {
          mode: "llm_sub_agent",
          workerType: this.kind,
          ...(resumableReason ? { resumableReason } : {}),
          ...(browserRecovery ? { browserRecovery } : {}),
          content: reply.content,
          metadata: reply.metadata ?? {},
          ...(browserArtifacts?.artifactIds.length ? { artifactIds: browserArtifacts.artifactIds } : {}),
          ...(browserArtifacts?.screenshotPaths.length ? { screenshotPaths: browserArtifacts.screenshotPaths } : {}),
        },
        sessionHistoryEntries: buildSubAgentTranscriptEntries({
          kind: this.kind,
          taskId: input.activation.handoff.taskId,
          metadata: reply.metadata ?? {},
          finalContent: reply.content,
          baseTimestamp: this.clock.now(),
        }),
      };
    } catch (error) {
      if (input.signal?.aborted) {
        return executor.interruptedResult();
      }
      const fallback =
        this.kind === "browser" && this.browserBridge && executor.executedToolCount() === 0 && isPlannerBootstrapFailure(error)
          ? await runReadOnlyBrowserPlannerFallback({
              input,
              browserBridge: this.browserBridge,
              error,
              now: this.clock.now(),
              workerRunKey: executor.workerRunKey(),
            })
          : null;
      if (fallback) {
        return fallback;
      }
      return {
        workerType: this.kind,
        status: "failed",
        summary: `Sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
        payload: {
          mode: "llm_sub_agent",
          workerType: this.kind,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

function isTimeoutSummaryInvocation(input: WorkerInvocationInput): boolean {
  return (
    input.packet.toolUseMode === "disabled" &&
    input.packet.continuityMode === "resume-existing" &&
    /\bprevious sub-agent run reached its timeout boundary\b/i.test(input.packet.taskPrompt)
  );
}

/** Closeout reasons that mean the inner loop was cut off rather than allowed
 *  to finish: the synthesized text is best-effort partial evidence, and the
 *  session stays resumable. A plain model-chosen final (no closeout) and a
 *  completed-sub-agent closeout still count as completed. */
const SUB_AGENT_EXHAUSTION_CLOSEOUT_REASONS = new Set([
  "round_limit",
  "wall_clock_budget",
  "repeated_tool_failure",
  "tool_evidence_fallback",
  "operator_cancelled",
  "sub_agent_timeout",
]);

function readExhaustionCloseoutReason(metadata: Record<string, unknown> | undefined): string | null {
  const closeout = metadata?.["toolLoopCloseout"];
  if (!closeout || typeof closeout !== "object" || Array.isArray(closeout)) {
    return null;
  }
  const reason = (closeout as Record<string, unknown>)["reason"];
  return typeof reason === "string" && SUB_AGENT_EXHAUSTION_CLOSEOUT_REASONS.has(reason) ? reason : null;
}

class SubAgentToolExecutor implements RoleToolExecutor {
  private readonly kind: WorkerKind;
  private readonly innerHandler: WorkerHandler;
  private readonly parentInput: WorkerInvocationInput;
  private readonly browserBridge: BrowserBridge | undefined;
  private readonly fallbackWorkerRunKey: string;
  private innerSessionState: WorkerSessionState | undefined;
  private toolExecutionCount = 0;

  constructor(options: {
    kind: WorkerKind;
    innerHandler: WorkerHandler;
    parentInput: WorkerInvocationInput;
    browserBridge?: BrowserBridge;
  }) {
    this.kind = options.kind;
    this.innerHandler = options.innerHandler;
    this.parentInput = options.parentInput;
    this.browserBridge = options.browserBridge;
    this.fallbackWorkerRunKey =
      options.parentInput.sessionState?.workerRunKey ??
      `sub-agent:${options.kind}:${options.parentInput.activation.handoff.taskId}:${++fallbackWorkerRunKeyCounter}`;
  }

  executedToolCount(): number {
    return this.toolExecutionCount;
  }

  workerRunKey(): string {
    return this.innerSessionState?.workerRunKey ?? this.parentInput.sessionState?.workerRunKey ?? this.fallbackWorkerRunKey;
  }

  interruptedResult(): WorkerExecutionResult {
    const state = this.innerSessionState ?? this.parentInput.sessionState ?? null;
    const evidence = summarizeWorkerSessionEvidence(state);
    if (!evidence) {
      return abortedResult(this.kind);
    }
    const payload = state?.lastResult?.payload;
    return {
      workerType: this.kind,
      status: "partial",
      summary: `Sub-agent interrupted before completion. Partial evidence: ${truncatePartialEvidenceSummary(evidence)}`,
      payload: {
        ...(isRecord(payload) ? payload : {}),
        mode: "llm_sub_agent",
        workerType: this.kind,
        interrupted: true,
        content: evidence,
      },
    };
  }

  definitions(): LLMToolDefinition[] {
    if (this.kind === "browser" && this.browserBridge) {
      return buildBrowserPrivateToolDefinitions();
    }
    return [
      {
        name: this.toolName(),
        description: buildInnerToolDescription(this.kind),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            instruction: {
              type: "string",
              description: "A focused instruction for this worker operation. Keep it specific and evidence-seeking.",
            },
          },
          required: ["instruction"],
        },
      },
    ];
  }

  async execute(input: RoleToolExecutionInput): Promise<RoleToolExecutionResult> {
    this.toolExecutionCount += 1;
    if (SESSION_TOOL_NAME_SET.has(input.call.name)) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: `recursive_session_tool_blocked: Sub-agents cannot call session coordination tool ${input.call.name}. Return the current evidence to the parent agent instead.`,
        isError: true,
        raw: {
          error: "recursive_session_tool_blocked",
          toolName: input.call.name,
        },
      };
    }

    if (this.kind === "browser" && this.browserBridge) {
      return this.executeBrowserTool(input, this.browserBridge);
    }

    const rawInput = input.call.input as unknown;
    const instruction =
      rawInput &&
      typeof rawInput === "object" &&
      typeof (rawInput as Record<string, unknown>)["instruction"] === "string"
        ? ((rawInput as Record<string, unknown>)["instruction"] as string).trim()
        : "";
    if (!instruction) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: "Missing required string field: instruction.",
        isError: true,
        raw: { error: "missing_instruction" },
      };
    }

    const sessionState = this.innerSessionState ?? this.parentInput.sessionState;
    const result = await this.innerHandler.run({
      ...this.parentInput,
      packet: {
        ...this.parentInput.packet,
        taskPrompt: instruction,
        preferredWorkerKinds: [this.kind],
        toolUseMode: "disabled",
        ...(this.innerSessionState ? { continuityMode: "resume-existing" as const } : {}),
      },
      ...(sessionState ? { sessionState } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!result) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: `${this.kind} worker did not return a result.`,
        isError: true,
        raw: { status: "missing_result" },
      };
    }
    this.innerSessionState = buildInnerSessionState({
      parentInput: this.parentInput,
      kind: this.kind,
      previous: this.innerSessionState,
      result,
      workerRunKey: this.workerRunKey(),
    });
    const content = JSON.stringify(
      {
        status: result.status,
        summary: result.summary,
        payload: result.payload,
      },
      null,
      2
    );
    return {
      toolCallId: input.call.id,
      toolName: input.call.name,
      content,
      ...(result.status === "failed" ? { isError: true } : {}),
      raw: result,
      progress: [
        {
          phase: result.status === "failed" ? "failed" : "completed",
          toolName: input.call.name,
          summary: result.summary,
          detail: {
            workerType: result.workerType,
            status: result.status,
          },
        },
      ],
    };
  }

  private toolName(): string {
    return `${this.kind}_run`;
  }

  private async executeBrowserTool(
    input: RoleToolExecutionInput,
    browserBridge: BrowserBridge
  ): Promise<RoleToolExecutionResult> {
    const previousPayload =
      this.innerSessionState?.lastResult?.payload ??
      this.parentInput.sessionState?.lastResult?.payload;
    const previous = decodeBrowserSessionPayload(previousPayload);
    const actionPlan = buildBrowserPrivateActionPlan(input, {
      refVisibleText: (refId) => readBrowserRefVisibleText(previousPayload, refId),
    });
    if ("error" in actionPlan) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: actionPlan.error,
        isError: true,
        raw: { error: actionPlan.error },
      };
    }

    const workerRunKey = this.workerRunKey();
    const useWorkerOwnedBrowserSession =
      Boolean(this.innerSessionState) || !previous?.sessionId || previous?.source === "browserRecovery";
    const ownerType: BrowserSessionOwnerType = useWorkerOwnedBrowserSession ? "worker" : "thread";
    const ownerId = useWorkerOwnedBrowserSession ? workerRunKey : this.parentInput.activation.thread.threadId;
    const baseRequest = {
      taskId: `${this.parentInput.activation.handoff.taskId}:${input.call.id}`,
      threadId: this.parentInput.activation.thread.threadId,
      instructions: actionPlan.instructions,
      actions: actionPlan.actions,
      ownerType,
      ownerId,
      profileOwnerType: "thread" as const,
      profileOwnerId: this.parentInput.activation.thread.threadId,
      leaseHolderRunKey: workerRunKey,
    };
    const request = {
      ...baseRequest,
      ...(previous?.sessionId ? { browserSessionId: previous.sessionId } : {}),
      ...(previous?.targetId ? { targetId: previous.targetId } : {}),
    };

    let result: BrowserTaskResult;
    let recoveredBrowserFailureBuckets: Array<{ bucket: string; count: number }> = [];
    try {
      result = await raceAbort(
        previous?.sessionId
          ? browserBridge.sendSession({ ...request, browserSessionId: previous.sessionId })
          : browserBridge.spawnSession(request),
        input.signal,
        "browser private tool cancelled"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        previous?.sessionId &&
        actionPlan.actions.length > 0 &&
        actionPlan.actions.every(isReadOnlyBrowserPrivateAction) &&
        isRecoverableMissingBrowserSessionFailure(message)
      ) {
        try {
          recoveredBrowserFailureBuckets = [{ bucket: "session_not_found", count: 1 }];
          result = await raceAbort(
            browserBridge.spawnSession({
              ...baseRequest,
              taskId: `${baseRequest.taskId}:cold-recreate-1`,
              ownerType: "worker",
              ownerId: workerRunKey,
              leaseHolderRunKey: workerRunKey,
            }),
            input.signal,
            "browser private tool cancelled"
          );
        } catch (coldError) {
          const coldMessage = coldError instanceof Error ? coldError.message : String(coldError);
          const bucket = classifyBrowserPrivateToolFailureBucket(coldMessage);
          const content = `${bucket}: ${coldMessage}`;
          const failureBuckets = reportableBrowserFailureBuckets(bucket);
          return {
            toolCallId: input.call.id,
            toolName: input.call.name,
            content,
            isError: true,
            raw: {
              status: "failed",
              error: coldMessage,
              priorError: message,
              ...(failureBuckets.length ? { failureBuckets } : {}),
            },
            progress: [
              {
                phase: "failed",
                toolName: input.call.name,
                summary: content,
                detail: {
                  priorError: message,
                  ...(failureBuckets.length ? { failureBuckets } : {}),
                  actionKinds: actionPlan.actions.map((action) => action.kind),
                },
              },
            ],
          };
        }
      } else {
        const bucket = classifyBrowserPrivateToolFailureBucket(message);
        const content = `${bucket}: ${message}`;
        const failureBuckets = reportableBrowserFailureBuckets(bucket);
        return {
          toolCallId: input.call.id,
          toolName: input.call.name,
          content,
          isError: true,
          raw: {
            status: "failed",
            error: message,
            ...(failureBuckets.length ? { failureBuckets } : {}),
          },
          progress: [
            {
              phase: "failed",
              toolName: input.call.name,
              summary: content,
              detail: {
                ...(failureBuckets.length ? { failureBuckets } : {}),
                actionKinds: actionPlan.actions.map((action) => action.kind),
              },
            },
          ],
        };
      }
    }
    let workerResult = browserToolWorkerResult(result);
    if (recoveredBrowserFailureBuckets.length > 0) {
      workerResult = withAdditionalBrowserFailureBuckets(workerResult, recoveredBrowserFailureBuckets);
    }
    if (shouldRetryReadOnlyBrowserPartial(actionPlan.actions, workerResult)) {
      try {
        result = await browserBridge.spawnSession({
          ...request,
          taskId: `${request.taskId}:retry-1`,
          ownerType: "worker",
          ownerId: workerRunKey,
          leaseHolderRunKey: workerRunKey,
        });
        workerResult = browserToolWorkerResult(result);
      } catch {
        // Keep the original partial evidence. The retry is a best-effort
        // recovery for read-only transient transport failures only.
      }
    }
    this.innerSessionState = buildInnerSessionState({
      parentInput: this.parentInput,
      kind: this.kind,
      previous: this.innerSessionState,
      result: workerResult,
      workerRunKey,
    });

    return {
      toolCallId: input.call.id,
      toolName: input.call.name,
      content: JSON.stringify(
        {
          status: workerResult.status,
          summary: workerResult.summary,
          payload: workerResult.payload,
        },
        null,
        2
      ),
      ...(workerResult.status === "failed" ? { isError: true } : {}),
      raw: workerResult,
      progress: [
        {
          phase:
            workerResult.status === "failed"
              ? "failed"
              : workerResult.status === "partial"
                ? "progress"
                : "completed",
          toolName: input.call.name,
          summary: workerResult.summary,
          detail: {
            sessionId: result.sessionId,
            ...(result.targetId ? { targetId: result.targetId } : {}),
            actionKinds: actionPlan.actions.map((action) => action.kind),
            ...(readBrowserFailureBucketNames(workerResult.payload).length
              ? {
                  failureBuckets: readBrowserFailureBucketNames(workerResult.payload).map((bucket) => ({
                    bucket,
                    count: 1,
                  })),
                }
              : {}),
            ...(result.artifactIds.length ? { artifactIds: result.artifactIds } : {}),
            ...(result.screenshotPaths.length ? { screenshotPaths: result.screenshotPaths } : {}),
          },
        },
      ],
    };
  }
}

function buildBrowserPrivateToolDefinitions(): LLMToolDefinition[] {
  return [
    {
      name: "browser_open",
      description: "Open a URL in the browser sub-agent session, then capture a DOM snapshot.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to open." },
          note: { type: "string", description: "Optional short note for the resulting snapshot." },
          timeout_ms: {
            type: "number",
            minimum: 1,
            maximum: MAX_BROWSER_OPEN_TIMEOUT_MS,
            description:
              "Optional page-open timeout in milliseconds. Use an extended value for explicitly slow local/loopback diagnostics; defaults to the runtime browser open timeout.",
          },
          screenshot: { type: "boolean", description: "Capture a screenshot after the page opens. Defaults to true; set false only when the parent explicitly does not need visual evidence." },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_snapshot",
      description: "Capture the current page state and interactive element refs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: { type: "string", description: "Optional short snapshot note." },
        },
      },
    },
    {
      name: "browser_wait_for",
      description: "Wait until a URL, title, body text, or visible element condition is met, then capture a DOM snapshot.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Literal visible body text to wait for." },
          body_text_pattern: { type: "string", description: "Regular expression pattern to match against page body text." },
          url_pattern: { type: "string", description: "Regular expression pattern to match against the current URL." },
          title_pattern: { type: "string", description: "Regular expression pattern to match against the page title." },
          timeout_ms: { type: "number", minimum: 1, maximum: 60_000, description: "Maximum wait in milliseconds. Defaults to 30000." },
          note: { type: "string", description: "Optional short snapshot note after the wait." },
        },
      },
    },
    {
      name: "browser_act",
      description:
        "Perform one targeted browser interaction, optionally wait for expected text, then snapshot the result. For an approved form submission, click the submit control with submit=true so the runtime can enforce the browser.form.submit approval boundary.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["click", "type", "key", "hover"] },
          refId: { type: "string", description: "Preferred element ref from a prior snapshot." },
          text: { type: "string", description: "Visible target text for click/hover, text to type, or key name." },
          selector: { type: "string", description: "CSS selector fallback when no refId is available." },
          wait_for_text: { type: "string", description: "Literal text expected after the action. Use for click-and-wait dynamic UI." },
          wait_timeout_ms: { type: "number", minimum: 1, maximum: 60_000, description: "Maximum wait for wait_for_text in milliseconds. Defaults to 30000." },
          submit: {
            type: "boolean",
            description:
              "Set true only when this click submits a form. Requires parent runtime approval for browser.form.submit.",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "browser_scroll",
      description: "Scroll the current page and capture a follow-up snapshot.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "number", minimum: 1, maximum: 5000 },
          note: { type: "string" },
        },
        required: ["direction"],
      },
    },
    {
      name: "browser_console",
      description: "Run a bounded page console probe for metadata or interactive summary.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          probe: { type: "string", enum: ["page-metadata", "interactive-summary"] },
        },
        required: ["probe"],
      },
    },
    {
      name: "browser_screenshot",
      description: "Capture a screenshot artifact for the current browser target.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "Optional short artifact label." },
        },
      },
    },
  ];
}

function buildBrowserPrivateActionPlan(
  input: RoleToolExecutionInput,
  options: { refVisibleText?: (refId: string) => string | null } = {}
):
  | { instructions: string; actions: BrowserTaskAction[] }
  | { error: string } {
  const rawInput = input.call.input as unknown;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { error: `${input.call.name} requires an object input.` };
  }
  const raw = rawInput as Record<string, unknown>;
  switch (input.call.name) {
    case "browser_open": {
      const url = requiredString(raw.url);
      if (!url || !isHttpUrl(url)) {
        return { error: "browser_open requires an absolute http(s) url." };
      }
      const timeoutMs = resolveBrowserOpenTimeoutMs(raw.timeout_ms, input.packet.taskPrompt, url);
      const actions: BrowserTaskAction[] = [
        { kind: "open", url, ...(timeoutMs ? { timeoutMs } : {}) },
        { kind: "snapshot", note: requiredString(raw.note) ?? "after-open" },
      ];
      if (raw.screenshot !== false) {
        actions.push({ kind: "screenshot", label: "after-open" });
      }
      return { instructions: `Open ${url} and observe the page.`, actions };
    }
    case "browser_snapshot":
      return {
        instructions: "Capture the current browser page state.",
        actions: [{ kind: "snapshot", note: requiredString(raw.note) ?? "current-page" }],
      };
    case "browser_wait_for": {
      const actions = buildBrowserWaitForActions(raw);
      if ("error" in actions) return actions;
      return {
        instructions: "Wait for the requested browser condition and observe the result.",
        actions,
      };
    }
    case "browser_scroll": {
      const direction = raw.direction === "up" || raw.direction === "down" ? raw.direction : null;
      if (!direction) return { error: "browser_scroll requires direction up or down." };
      const amount = typeof raw.amount === "number" && Number.isFinite(raw.amount)
        ? Math.min(Math.max(Math.floor(raw.amount), 1), 5000)
        : 900;
      return {
        instructions: `Scroll ${direction} and observe the next page state.`,
        actions: [
          { kind: "scroll", direction, amount },
          { kind: "snapshot", note: requiredString(raw.note) ?? `after-scroll-${direction}` },
        ],
      };
    }
    case "browser_console": {
      const probe = raw.probe === "interactive-summary" ? "interactive-summary" : raw.probe === "page-metadata" ? "page-metadata" : null;
      if (!probe) return { error: "browser_console requires probe page-metadata or interactive-summary." };
      return {
        instructions: `Run browser console probe ${probe}.`,
        actions: [{ kind: "console", probe }],
      };
    }
    case "browser_screenshot":
      return {
        instructions: "Capture a screenshot of the current browser target.",
        actions: [{ kind: "screenshot", label: requiredString(raw.label) ?? "browser-sub-agent" }],
      };
    case "browser_act": {
      const planOptions: {
        approvalContext: BrowserSideEffectApprovalContext[];
        taskPrompt: string;
        refVisibleText?: (refId: string) => string | null;
      } = {
        approvalContext: input.packet.runtimeApprovalContext?.browserSideEffects ?? [],
        taskPrompt: input.packet.taskPrompt,
      };
      if (options.refVisibleText) {
        planOptions.refVisibleText = options.refVisibleText;
      }
      return buildBrowserActPlan(raw, planOptions);
    }
    default:
      return { error: `Unknown browser sub-agent tool: ${input.call.name}` };
  }
}

function buildBrowserActPlan(
  raw: Record<string, unknown>,
  options: {
    approvalContext: BrowserSideEffectApprovalContext[];
    taskPrompt: string;
    refVisibleText?: (refId: string) => string | null;
  }
):
  | { instructions: string; actions: BrowserTaskAction[] }
  | { error: string } {
  const action = requiredString(raw.action);
  const target = buildBrowserActionTarget(raw);
  const submitRequest = raw.submit === true
    ? { action: "browser.form.submit", scope: "mutate" as const, label: "form submit" }
    : null;
  if (submitRequest && !isBrowserPrivateSideEffectApproved(submitRequest, options.approvalContext)) {
    return { error: "browser_act does not submit forms. Ask the parent agent to request approval for side-effectful browser work." };
  }
  if (action === "click") {
    if (!target) return { error: "browser_act click requires refId, text, or selector." };
    const visibleText = requiredString(raw.text) ?? ("refId" in target ? options.refVisibleText?.(target.refId) ?? null : null);
    if ("refId" in target && !visibleText) {
      return {
        error: "browser_act click with refId requires visible text so side effects can be screened.",
      };
    }
    const sideEffect = classifyBrowserPrivateSideEffectTarget(target, visibleText);
    const sideEffectRequest = sideEffect ? classifyBrowserPrivateSideEffectRequest(sideEffect) : null;
    if (sideEffectRequest && !isBrowserPrivateSideEffectApproved(sideEffectRequest, options.approvalContext)) {
      return {
        error: `browser_act refused likely side-effectful click target "${sideEffect}". Ask the parent agent to request approval first.`,
      };
    }
    const actions: BrowserTaskAction[] = [{ kind: "click", ...target }];
    const waitForText = requiredString(raw.wait_for_text) ?? extractBrowserWaitForText(options.taskPrompt);
    if (waitForText) {
      actions.push({
        kind: "waitFor",
        bodyTextPattern: escapeRegExp(waitForText),
        timeoutMs: resolveBrowserWaitTimeoutMs(raw.wait_timeout_ms),
      });
    }
    actions.push({ kind: "snapshot", note: waitForText ? `after-wait-${slugifyBrowserNote(waitForText)}` : "after-click" });
    return {
      instructions: sideEffectRequest
        ? "Click the approved scoped browser element and observe the result."
        : "Click the requested browser element and observe the result.",
      actions,
    };
  }
  if (action === "hover") {
    if (!target) return { error: "browser_act hover requires refId, text, or selector." };
    return {
      instructions: "Hover the requested browser element and observe the result.",
      actions: [{ kind: "hover", ...target }, { kind: "snapshot", note: "after-hover" }],
    };
  }
  if (action === "type") {
    const text = requiredString(raw.text);
    if (!text || !target) return { error: "browser_act type requires text plus refId or selector." };
    if ("text" in target) return { error: "browser_act type cannot target visible text; use refId or selector." };
    return {
      instructions: "Type into the requested browser element and observe the result.",
      actions: [
        { kind: "type", ...target, text },
        { kind: "snapshot", note: "after-type" },
      ],
    };
  }
  if (action === "key") {
    const key = requiredString(raw.text);
    if (!key) return { error: "browser_act key requires text containing the key name." };
    return {
      instructions: `Press browser key ${key}.`,
      actions: [{ kind: "key", key }, { kind: "snapshot", note: "after-key" }],
    };
  }
  return { error: "browser_act action must be click, type, key, or hover." };
}

function readBrowserRefVisibleText(payload: unknown, refId: string): string | null {
  if (!isRecord(payload) || !isRecord(payload.page) || !Array.isArray(payload.page.interactives)) {
    return null;
  }
  for (const interactive of payload.page.interactives) {
    if (!isRecord(interactive) || interactive.refId !== refId) {
      continue;
    }
    const label = requiredString(interactive.label);
    const role = requiredString(interactive.role);
    const tagName = requiredString(interactive.tagName);
    return label ?? role ?? tagName;
  }
  return null;
}

function buildBrowserWaitForActions(raw: Record<string, unknown>):
  | BrowserTaskAction[]
  | { error: string } {
  const timeoutMs = resolveBrowserWaitTimeoutMs(raw.timeout_ms);
  const text = requiredString(raw.text);
  const bodyTextPattern = requiredString(raw.body_text_pattern);
  const urlPattern = requiredString(raw.url_pattern);
  const titlePattern = requiredString(raw.title_pattern);
  const conditions = [text, bodyTextPattern, urlPattern, titlePattern].filter(Boolean);
  if (conditions.length !== 1) {
    return { error: "browser_wait_for requires exactly one of text, body_text_pattern, url_pattern, or title_pattern." };
  }
  const waitAction: BrowserTaskAction = text
    ? { kind: "waitFor", bodyTextPattern: escapeRegExp(text), timeoutMs }
    : bodyTextPattern
      ? { kind: "waitFor", bodyTextPattern, timeoutMs }
      : urlPattern
        ? { kind: "waitFor", urlPattern, timeoutMs }
        : { kind: "waitFor", titlePattern: titlePattern!, timeoutMs };
  return [waitAction, { kind: "snapshot", note: requiredString(raw.note) ?? "after-wait" }];
}

function resolveBrowserWaitTimeoutMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(Math.floor(value), 1), 60_000);
  }
  return 30_000;
}

function extractBrowserWaitForText(taskPrompt: string): string | null {
  const patterns = [
    /wait(?:\s+for)?[\s\S]{0,120}?(?:display|show|appear|visible|contains?)[\s\S]{0,40}?["“](.+?)["”]/i,
    /(?:display|show|appear|visible|contains?)[\s\S]{0,40}?["“](.+?)["”]/i,
    /等待[\s\S]{0,80}?(?:显示|出现|可见)[\s\S]{0,20}?["“](.+?)["”]/,
    /(?:显示|出现|可见)\s*["“](.+?)["”]/,
  ];
  for (const pattern of patterns) {
    const value = taskPrompt.match(pattern)?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugifyBrowserNote(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "text"
  );
}

function isBrowserPrivateSideEffectApproved(
  request: { action: string; scope: BrowserSideEffectApprovalContext["scope"] },
  approvalContext: BrowserSideEffectApprovalContext[]
): boolean {
  return approvalContext.some((approval) => approval.action === request.action && approval.scope === request.scope);
}

function classifyBrowserPrivateSideEffectRequest(
  label: string
): { action: string; scope: BrowserSideEffectApprovalContext["scope"]; label: string } {
  if (/\b(password|2fa|mfa|otp|credential|api key|secret|token)\b/i.test(label)) {
    return { action: "browser.credential.access", scope: "credential", label };
  }
  if (/\b(publish|deploy|go live|release)\b/i.test(label)) {
    return { action: "browser.publish", scope: "publish", label };
  }
  if (/\bsubmit\b/i.test(label)) {
    return { action: "browser.form.submit", scope: "mutate", label };
  }
  return { action: "browser.mutate", scope: "mutate", label };
}

function buildBrowserActionTarget(raw: Record<string, unknown>):
  | { refId: string }
  | { text: string }
  | { selectors: string[] }
  | null {
  const refId = requiredString(raw.refId);
  if (refId) return { refId };
  const selector = requiredString(raw.selector);
  if (selector) return { selectors: [selector] };
  const text = requiredString(raw.text);
  if (text) return { text };
  return null;
}

function classifyBrowserPrivateSideEffectTarget(
  target: { refId: string } | { text: string } | { selectors: string[] },
  fallbackText: string | null = null
): string | null {
  const text =
    ("text" in target ? target.text : "selectors" in target ? target.selectors.join(" ") : "") ||
    fallbackText ||
    "";
  if (!text) return null;
  return /\b(submit|send|save|publish|delete|remove|checkout|purchase|buy|order|book|reserve|approve|accept|reject|cancel)\b/i.test(text)
    ? text
    : null;
}

function browserToolWorkerResult(result: BrowserTaskResult): WorkerExecutionResult {
  const failedCount = result.trace.filter((step) => step.status === "failed").length;
  const failureBuckets = collectBrowserFailureBucketsFromTrace(result.trace);
  const status =
    result.trace.length > 0 && failedCount === result.trace.length
      ? "failed"
      : failedCount > 0
        ? "partial"
        : "completed";
  return {
    workerType: "browser",
    status,
    summary: summarizeBrowserToolResult(result),
    payload: {
      sessionId: result.sessionId,
      ...(result.targetId ? { targetId: result.targetId } : {}),
      ...(result.resumeMode ? { resumeMode: result.resumeMode } : {}),
      transportMode: result.transportMode,
      transportLabel: result.transportLabel,
      ...(result.profileFallback ? { profileFallback: result.profileFallback } : {}),
      ...(failureBuckets.length > 0 ? { failureBuckets } : {}),
      page: {
        finalUrl: result.page.finalUrl,
        title: result.page.title,
        textExcerpt: result.page.textExcerpt,
        interactives: result.page.interactives.slice(0, 25),
      },
      screenshotPaths: result.screenshotPaths,
      artifactIds: result.artifactIds,
      trace: result.trace.map((step) => ({
        kind: step.kind,
        status: step.status,
        ...(step.errorMessage ? { errorMessage: step.errorMessage } : {}),
      })),
    },
  };
}

function withAdditionalBrowserFailureBuckets(
  result: WorkerExecutionResult,
  buckets: Array<{ bucket: string; count: number }>
): WorkerExecutionResult {
  if (buckets.length === 0) {
    return result;
  }
  const payload = isRecord(result.payload) ? result.payload : {};
  const merged = new Map<string, number>();
  for (const bucket of readBrowserFailureBucketRecords(payload)) {
    merged.set(bucket.bucket, (merged.get(bucket.bucket) ?? 0) + bucket.count);
  }
  for (const bucket of buckets) {
    merged.set(bucket.bucket, (merged.get(bucket.bucket) ?? 0) + bucket.count);
  }
  const failureBuckets = [...merged.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket));
  return {
    ...result,
    summary: [
      result.summary,
      `Browser failure buckets: ${formatBrowserFailureBuckets(failureBuckets)}.`,
    ].filter(Boolean).join("\n"),
    payload: {
      ...payload,
      failureBuckets,
    },
  };
}

function shouldRetryReadOnlyBrowserPartial(actions: BrowserTaskAction[], result: WorkerExecutionResult): boolean {
  if (result.status !== "partial") {
    return false;
  }
  if (!actions.length || !actions.every(isReadOnlyBrowserPrivateAction)) {
    return false;
  }
  return readBrowserFailureBucketNames(result.payload).some((bucket) =>
    bucket === "transport_failure" || bucket === "browser_cdp_unavailable"
  );
}

function isReadOnlyBrowserPrivateAction(action: BrowserTaskAction): boolean {
  return (
    action.kind === "open" ||
    action.kind === "snapshot" ||
    action.kind === "scroll" ||
    action.kind === "console" ||
    action.kind === "screenshot"
  );
}

function isRecoverableMissingBrowserSessionFailure(message: string): boolean {
  return /\bbrowser session not found\b|\bsession closed\b|\bsession is closed\b/i.test(message);
}

function readBrowserFailureBucketNames(payload: unknown): string[] {
  return readBrowserFailureBucketRecords(payload).map((bucket) => bucket.bucket);
}

function readBrowserFailureBucketRecords(payload: unknown): Array<{ bucket: string; count: number }> {
  if (!isRecord(payload)) {
    return [];
  }
  const buckets = payload["failureBuckets"];
  if (!Array.isArray(buckets)) {
    return [];
  }
  return buckets
    .map((entry) =>
      isRecord(entry) && typeof entry["bucket"] === "string"
        ? {
            bucket: entry["bucket"],
            count: typeof entry["count"] === "number" && Number.isFinite(entry["count"]) ? entry["count"] : 1,
          }
        : null
    )
    .filter((bucket): bucket is { bucket: string; count: number } => Boolean(bucket));
}

async function runReadOnlyBrowserPlannerFallback(input: {
  input: WorkerInvocationInput;
  browserBridge: BrowserBridge;
  error: unknown;
  now: number;
  workerRunKey: string;
}): Promise<WorkerExecutionResult | null> {
  const url = extractFirstHttpUrl(input.input.packet.taskPrompt);
  if (!url) {
    return null;
  }
  const promptWithoutUrl = input.input.packet.taskPrompt.replace(url, "");
  if (hasBrowserMutationIntent(promptWithoutUrl)) {
    return null;
  }

  let result: BrowserTaskResult;
  try {
    const timeoutMs = resolveSlowLoopbackOpenTimeoutMs(input.input.packet.taskPrompt, url);
    result = await input.browserBridge.spawnSession({
      taskId: `${input.input.activation.handoff.taskId}:browser-planner-fallback`,
      threadId: input.input.activation.thread.threadId,
      instructions: [
        "The browser sub-agent planner failed before producing a private browser tool call.",
        "Capture read-only page evidence from the delegated URL without interacting with account state.",
      ].join(" "),
      actions: [
        { kind: "open", url, ...(timeoutMs ? { timeoutMs } : {}) },
        { kind: "snapshot", note: "planner-timeout-fallback" },
        { kind: "screenshot", label: "planner-timeout-fallback" },
      ],
      ownerType: "worker",
      ownerId: input.workerRunKey,
      profileOwnerType: "thread",
      profileOwnerId: input.input.activation.thread.threadId,
      leaseHolderRunKey: input.workerRunKey,
    });
  } catch (fallbackError) {
    const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    const bucket = classifyBrowserPrivateToolFailureBucket(message);
    return {
      workerType: "browser",
      status: "failed",
      summary: `Browser planner fallback failed: ${bucket}: ${message}`,
      payload: {
        mode: "browser_planner_fallback",
        workerType: "browser",
        error: message,
        plannerError: errorMessage(input.error),
        failureBuckets: [{ bucket, count: 1 }],
      },
    };
  }

  const workerResult = browserToolWorkerResult(result);
  const content = buildBrowserPlannerFallbackContent({
    result,
    plannerError: errorMessage(input.error),
  });
  const payload = isRecord(workerResult.payload)
    ? {
        ...workerResult.payload,
        mode: "browser_planner_fallback",
        workerType: "browser",
        plannerError: errorMessage(input.error),
        content,
      }
    : {
        mode: "browser_planner_fallback",
        workerType: "browser",
        plannerError: errorMessage(input.error),
        content,
      };
  return {
    workerType: "browser",
    status: workerResult.status,
    summary: [
      "Browser planner fallback captured read-only evidence after the sub-agent planner failed.",
      workerResult.summary,
    ].join(" "),
    payload,
    sessionHistoryEntries: [
      {
        id: `sub-agent-transcript:browser:${input.input.activation.handoff.taskId}:planner-fallback-tool-result:${input.now}`,
        role: "tool",
        content,
        createdAt: input.now,
        taskId: input.input.activation.handoff.taskId,
        toolName: "browser_planner_fallback",
        status: workerResult.status,
        payload,
        metadata: {
          kind: "tool_result",
          fallback: "browser_planner_fallback",
        },
      },
      {
        id: `sub-agent-transcript:browser:${input.input.activation.handoff.taskId}:planner-fallback-final:${input.now}`,
        role: "assistant",
        content,
        createdAt: input.now + 1,
        taskId: input.input.activation.handoff.taskId,
        status: workerResult.status,
        metadata: {
          kind: "assistant_final",
          fallback: "browser_planner_fallback",
        },
      },
    ],
  };
}

function isPlannerBootstrapFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return /\b(llm_request_timeout|did not respond|request timeout|gateway timeout|planner|bootstrap)\b/i.test(message);
}

function buildBrowserPlannerFallbackContent(input: { result: BrowserTaskResult; plannerError: string }): string {
  return [
    `Browser planner fallback used after planner error: ${input.plannerError}`,
    `Final URL: ${input.result.page.finalUrl}`,
    input.result.page.title ? `Page title: ${input.result.page.title}` : null,
    input.result.page.textExcerpt ? `Visible text excerpt: ${truncateBrowserTextExcerpt(input.result.page.textExcerpt)}` : null,
    input.result.artifactIds.length ? `Artifact IDs: ${input.result.artifactIds.join(", ")}` : null,
    input.result.screenshotPaths.length ? `Screenshots: ${input.result.screenshotPaths.join(", ")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function extractFirstHttpUrl(text: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"')\]]+/i.exec(text);
  if (!match) {
    return null;
  }
  const candidate = match[0].replace(/[.,;:!?]+$/g, "");
  return isHttpUrl(candidate) ? candidate : null;
}

function hasBrowserMutationIntent(text: string): boolean {
  return /\b(submit|send|save|publish|delete|remove|checkout|purchase|buy|order|book|reserve|approve|accept|reject|cancel|sign in|login|upload|deploy|release|go live)\b/i.test(
    text
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeBrowserToolResult(result: BrowserTaskResult): string {
  const failed = result.trace.filter((step) => step.status === "failed");
  const failureBuckets = collectBrowserFailureBucketsFromTrace(result.trace);
  const title = result.page.title || result.page.finalUrl || "browser page";
  if (failed.length > 0) {
    return [
      `Browser observed ${title}; ${failed.length} action(s) failed.`,
      failureBuckets.length > 0 ? `Browser failure buckets: ${formatBrowserFailureBuckets(failureBuckets)}.` : null,
      result.profileFallback
        ? `Profile fallback: ${result.profileFallback.reason}; persistent profile was unavailable, used ${result.profileFallback.fallbackDir}.`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }
  return [
    `Browser observed ${title}.`,
    result.page?.textExcerpt ? `Visible text excerpt: ${truncateBrowserTextExcerpt(result.page.textExcerpt)}.` : null,
    result.profileFallback
      ? `Profile fallback: ${result.profileFallback.reason}; persistent profile was unavailable, used ${result.profileFallback.fallbackDir}.`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function truncateBrowserTextExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 497)}...`;
}

function truncatePartialEvidenceSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 1200) {
    return normalized;
  }
  return `${normalized.slice(0, 1197)}...`;
}

function buildInnerSessionState(input: {
  parentInput: WorkerInvocationInput;
  kind: WorkerKind;
  previous: WorkerSessionState | undefined;
  result: WorkerExecutionResult;
  workerRunKey?: string;
}): WorkerSessionState {
  const now = Date.now();
  const workerRunKey =
    input.previous?.workerRunKey ??
    input.parentInput.sessionState?.workerRunKey ??
    input.workerRunKey ??
    `sub-agent:${input.kind}:${input.parentInput.activation.handoff.taskId}`;
  return {
    workerRunKey,
    workerType: input.kind,
    status: input.result.status === "failed" ? "failed" : "resumable",
    createdAt: input.previous?.createdAt ?? input.parentInput.sessionState?.createdAt ?? now,
    updatedAt: now,
    currentTaskId: input.parentInput.activation.handoff.taskId,
    lastResult: input.result,
    continuationDigest: {
      reason: input.result.status === "failed" ? "supervisor_retry" : "follow_up",
      summary: input.result.summary,
      createdAt: now,
    },
    history: [
      ...(input.previous?.history ?? input.parentInput.sessionState?.history ?? []),
      {
        id: `sub-agent-inner:${input.kind}:${input.parentInput.activation.handoff.taskId}:${now}`,
        role: "tool",
        content: input.result.summary,
        createdAt: now,
        taskId: input.parentInput.activation.handoff.taskId,
        toolName: input.kind,
        status: input.result.status,
        payload: input.result.payload,
      },
    ],
  };
}

function buildSubAgentTranscriptEntries(input: {
  kind: WorkerKind;
  taskId: string;
  metadata: Record<string, unknown>;
  finalContent: string;
  baseTimestamp: number;
}): WorkerSessionHistoryEntry[] {
  const rounds = readNativeToolRounds(input.metadata);
  const entries: WorkerSessionHistoryEntry[] = [];
  let ordinal = 0;
  for (const round of rounds) {
    for (const call of round.calls) {
      entries.push({
        id: `sub-agent-transcript:${input.kind}:${input.taskId}:${round.round}:assistant-tool-call:${call.id}`,
        role: "assistant",
        content: `Requested ${call.name}.`,
        createdAt: input.baseTimestamp + ordinal++,
        taskId: input.taskId,
        toolCallId: call.id,
        toolName: call.name,
        metadata: {
          kind: "assistant_tool_call",
          round: round.round,
          input: call.input,
        },
      });
    }
    for (const progress of round.progress ?? []) {
      entries.push({
        id: `sub-agent-transcript:${input.kind}:${input.taskId}:${round.round}:progress:${progress.toolCallId}:${progress.ts}`,
        role: "system",
        content: progress.summary,
        createdAt: progress.ts || input.baseTimestamp + ordinal,
        taskId: input.taskId,
        toolCallId: progress.toolCallId,
        toolName: progress.toolName,
        metadata: {
          kind: "tool_progress",
          phase: progress.phase,
          ...(progress.detail ? { detail: progress.detail } : {}),
        },
      });
      ordinal += 1;
    }
    for (const result of round.results) {
      entries.push({
        id: `sub-agent-transcript:${input.kind}:${input.taskId}:${round.round}:tool-result:${result.toolCallId}`,
        role: "tool",
        content: result.content ?? `${result.toolName} result omitted (${result.contentBytes} bytes).`,
        createdAt: input.baseTimestamp + ordinal++,
        taskId: input.taskId,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        status: result.isError ? "failed" : "completed",
        metadata: {
          kind: "tool_result",
          contentBytes: result.contentBytes,
          ...(result.contentTruncated ? { contentTruncated: true } : {}),
          ...(result.cancelled ? { cancelled: true } : {}),
        },
      });
    }
  }
  entries.push({
    id: `sub-agent-transcript:${input.kind}:${input.taskId}:assistant-final:${input.baseTimestamp}`,
    role: "assistant",
    content: input.finalContent,
    createdAt: input.baseTimestamp + ordinal,
    taskId: input.taskId,
    status: "completed",
    metadata: {
      kind: "assistant_final",
    },
  });
  return entries;
}

function readNativeToolRounds(metadata: Record<string, unknown>): NativeToolRoundTrace[] {
  const toolUse = metadata.toolUse;
  if (!toolUse || typeof toolUse !== "object") return [];
  const rounds = (toolUse as { rounds?: unknown }).rounds;
  return Array.isArray(rounds) ? (rounds as NativeToolRoundTrace[]) : [];
}

function collectBrowserPrivateToolArtifacts(metadata: Record<string, unknown>):
  | { artifactIds: string[]; screenshotPaths: string[] }
  | null {
  const artifactIds = new Set<string>();
  const screenshotPaths = new Set<string>();
  for (const round of readNativeToolRounds(metadata)) {
    for (const progress of round.progress ?? []) {
      if (!progress.toolName.startsWith("browser_") || !isRecord(progress.detail)) {
        continue;
      }
      addStringArray(artifactIds, progress.detail.artifactIds);
      addStringArray(screenshotPaths, progress.detail.screenshotPaths);
    }
    for (const result of round.results) {
      if (!result.toolName.startsWith("browser_") || !result.content) {
        continue;
      }
      const parsed = parseBrowserPrivateToolPayload(result.content);
      if (!parsed) {
        continue;
      }
      addStringArray(artifactIds, parsed.artifactIds);
      addStringArray(screenshotPaths, parsed.screenshotPaths);
    }
  }
  if (artifactIds.size === 0 && screenshotPaths.size === 0) {
    return null;
  }
  return {
    artifactIds: [...artifactIds],
    screenshotPaths: [...screenshotPaths],
  };
}

function summarizeBrowserPrivateToolRecovery(metadata: Record<string, unknown>):
  | {
      resumeMode?: NonNullable<BrowserTaskResult["resumeMode"]>;
      sessionId?: string;
      summary: string;
      profileFallback?: NonNullable<BrowserTaskResult["profileFallback"]>;
      targetId?: string;
      failureBuckets?: Array<{ bucket: string; count: number }>;
    }
  | null {
  const rounds = readNativeToolRounds(metadata);
  let latest:
    | {
        resumeMode: NonNullable<BrowserTaskResult["resumeMode"]>;
        sessionId: string;
        profileFallback?: NonNullable<BrowserTaskResult["profileFallback"]>;
        targetId?: string;
      }
    | null = null;
  const failureBucketCounts = new Map<string, number>();
  const countedFailureBucketKeys = new Set<string>();
  for (const [roundIndex, round] of rounds.entries()) {
    for (const progress of round.progress ?? []) {
      if (!progress.toolName.startsWith("browser_") || !isRecord(progress.detail)) {
        continue;
      }
      for (const bucket of readBrowserFailureBucketRecords(progress.detail)) {
        addBrowserFailureBucketCount(failureBucketCounts, countedFailureBucketKeys, bucket, {
          roundIndex,
          toolCallId: progress.toolCallId,
        });
      }
    }
    for (const result of round.results) {
      if (!result.toolName.startsWith("browser_") || !result.content) {
        continue;
      }
      for (const bucket of collectBrowserFailureBucketsFromText(result.content)) {
        addBrowserFailureBucketCount(
          failureBucketCounts,
          countedFailureBucketKeys,
          { bucket, count: 1 },
          { roundIndex, toolCallId: result.toolCallId }
        );
      }
      const parsed = parseBrowserPrivateToolPayload(result.content);
      if (!parsed || parsed.resumeMode === "hot") {
        continue;
      }
      latest = parsed;
    }
  }
  const failureBuckets = [...failureBucketCounts.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket));
  if (!latest && failureBuckets.length === 0) {
    return null;
  }
  return {
    ...(latest ?? {}),
    ...(failureBuckets.length > 0 ? { failureBuckets } : {}),
    summary: [
      latest
        ? `Browser recovery metadata: Resume mode: ${latest.resumeMode}. Session ID: ${latest.sessionId}.`
        : null,
      failureBuckets.length > 0 ? `Browser failure buckets: ${formatBrowserFailureBuckets(failureBuckets)}.` : null,
      latest?.profileFallback
        ? `Profile fallback: ${latest.profileFallback.reason}; persistent profile was unavailable, used ${latest.profileFallback.fallbackDir}.`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join(" "),
  };
}

function addBrowserFailureBucketCount(
  counts: Map<string, number>,
  countedKeys: Set<string>,
  bucket: { bucket: string; count: number },
  source: { roundIndex: number; toolCallId?: string | null }
): void {
  const key = `${source.toolCallId ?? `round-${source.roundIndex}`}:${bucket.bucket}`;
  if (countedKeys.has(key)) {
    return;
  }
  countedKeys.add(key);
  counts.set(bucket.bucket, (counts.get(bucket.bucket) ?? 0) + bucket.count);
}

function parseBrowserPrivateToolPayload(content: string):
  | {
      resumeMode: NonNullable<BrowserTaskResult["resumeMode"]>;
      sessionId: string;
      profileFallback?: NonNullable<BrowserTaskResult["profileFallback"]>;
      targetId?: string;
      artifactIds?: string[];
      screenshotPaths?: string[];
    }
  | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed["payload"])) {
    return null;
  }
  const payload = parsed["payload"];
  const resumeMode = payload["resumeMode"];
  const sessionId = payload["sessionId"];
  const targetId = payload["targetId"];
  const profileFallback = parseBrowserPrivateProfileFallback(payload["profileFallback"]);
  const artifactIds = readStringArray(payload["artifactIds"]);
  const screenshotPaths = readStringArray(payload["screenshotPaths"]);
  if ((resumeMode !== "hot" && resumeMode !== "warm" && resumeMode !== "cold") || typeof sessionId !== "string") {
    return null;
  }
  return {
    resumeMode,
    sessionId,
    ...(profileFallback ? { profileFallback } : {}),
    ...(typeof targetId === "string" ? { targetId } : {}),
    ...(artifactIds.length ? { artifactIds } : {}),
    ...(screenshotPaths.length ? { screenshotPaths } : {}),
  };
}

function addStringArray(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      target.add(item.trim());
    }
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function parseBrowserPrivateProfileFallback(value: unknown): NonNullable<BrowserTaskResult["profileFallback"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const reason = value["reason"];
  const persistentDir = value["persistentDir"];
  const fallbackDir = value["fallbackDir"];
  if (reason !== "profile_locked" || typeof persistentDir !== "string" || typeof fallbackDir !== "string") {
    return null;
  }
  return { reason, persistentDir, fallbackDir };
}

function collectBrowserFailureBucketsFromTrace(
  trace: BrowserTaskResult["trace"]
): Array<{ bucket: string; count: number }> {
  const counts = new Map<string, number>();
  for (const step of trace) {
    if (step.status !== "failed" || !step.errorMessage) {
      continue;
    }
    const buckets = collectBrowserFailureBucketsFromText(step.errorMessage);
    if (buckets.length === 0) {
      buckets.push(classifyBrowserPrivateToolFailureBucket(step.errorMessage));
    }
    for (const bucket of buckets) {
      if (!BROWSER_FAILURE_BUCKETS.includes(bucket as (typeof BROWSER_FAILURE_BUCKETS)[number])) {
        continue;
      }
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((left, right) => left.bucket.localeCompare(right.bucket));
}

function collectBrowserFailureBucketsFromText(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return BROWSER_FAILURE_BUCKETS.filter((bucket) => lower.includes(bucket));
}

function classifyBrowserPrivateToolFailureBucket(message: string): string {
  if (/\bwaitFor(?:Function|URL)?\b[\s\S]{0,120}\b(?:Timeout|timed out|timeout)\b|\b(?:bodyTextPattern|titlePattern|urlPattern)\b[\s\S]{0,120}\b(?:Timeout|timed out|timeout)\b/i.test(message)) {
    return "wait_condition_timeout";
  }
  const direct = collectBrowserFailureBucketsFromText(message)[0];
  if (direct) return direct;
  if (/\b(?:unknown|stale|invalid)\s+snapshot\s+ref\b|\bref(?:erence)?\b.{0,80}\b(?:not found|stale|invalid|unknown)\b/i.test(message)) {
    return "stale_ref";
  }
  if (/\b(?:cdp|devtools|websocket|ws:\/\/|browser endpoint|connectovercdp)\b/i.test(message)) {
    return "browser_cdp_unavailable";
  }
  if (/\b(?:econnrefused|connection refused|fetch failed|network error)\b/i.test(message)) {
    return "browser_cdp_unavailable";
  }
  if (/\b(?:target not found|no target)\b/i.test(message)) {
    return "target_not_found";
  }
  if (/\b(?:attach failed|failed to attach)\b/i.test(message)) {
    return "attach_failed";
  }
  if (/\b(?:detached|session closed)\b/i.test(message)) {
    return "detached_target";
  }
  return "transport_failure";
}

function reportableBrowserFailureBuckets(bucket: string): Array<{ bucket: string; count: number }> {
  return BROWSER_FAILURE_BUCKETS.includes(bucket as (typeof BROWSER_FAILURE_BUCKETS)[number])
    ? [{ bucket, count: 1 }]
    : [];
}

function formatBrowserFailureBuckets(buckets: Array<{ bucket: string; count: number }>): string {
  return buckets.map((bucket) => `${bucket.bucket}=${bucket.count}`).join(", ");
}

function buildSubAgentPromptPacket(input: {
  kind: WorkerKind;
  activation: RoleActivationInput;
  input: WorkerInvocationInput;
  maxRounds: number;
}): RolePromptPacket {
  const currentRole = input.activation.thread.roles.find((role) => role.roleId === input.activation.runState.roleId);
  const inherited = input.input.packet;
  return {
    roleId: inherited.roleId,
    roleName: `${input.kind} sub-agent`,
    seat: currentRole?.seat ?? "member",
    systemPrompt: buildSubAgentSystemPrompt(input.kind, input.maxRounds),
    taskPrompt: buildSubAgentTaskPrompt(input.kind, inherited.taskPrompt, input.input.sessionState),
    outputContract: [
      "Return a concise evidence-based result for the parent agent.",
      "Include what you verified, what remains uncertain, and any exact IDs/URLs/data needed for follow-up.",
      "For research/comparison work, include an evidence ledger with source URL/name, source type, verified facts, and limitations.",
      "Use 'not verified' for requested metrics you could not verify. Do not infer user scale, community feedback, code quality, update frequency, or open-source status from marketing copy alone.",
      "Do not mention internal tool names unless they are directly useful to the operator.",
    ].join("\n"),
    suggestedMentions: [],
    preferredWorkerKinds: [input.kind],
    ...(inherited.toolUseMode ? { toolUseMode: inherited.toolUseMode } : {}),
    ...(inherited.continuityMode ? { continuityMode: inherited.continuityMode } : {}),
    ...(inherited.runtimeApprovalContext ? { runtimeApprovalContext: inherited.runtimeApprovalContext } : {}),
  };
}

function buildSubAgentSystemPrompt(kind: WorkerKind, maxRounds: number): string {
  const common = [
    "You are a focused sub-agent working for a parent agent.",
    "Own this delegated task independently. Do not ask the parent to do your work.",
    `You may use up to about ${maxRounds} focused tool calls, but stop earlier when the evidence is sufficient.`,
    "Do not spawn other sessions or delegate recursively.",
    "If a partial result is the best available answer, say exactly what was verified and what is still missing.",
    "On repeated failure, summarize the best evidence already gathered instead of looping.",
    "Your final answer must be complete. If space is tight, return a shorter complete evidence ledger instead of a cut-off report.",
    "After using a private tool, base factual claims only on the private tool result and the delegated task text. Do not add pricing, SLA, support, security, integration, adoption, or product claims from general knowledge.",
    "If a requested fact is absent from the tool result, write not verified instead of filling it from memory.",
  ];
  if (kind === "browser") {
    return [
      ...common,
      "You control browser work through private browser tools: browser_open, browser_snapshot, browser_wait_for, browser_act, browser_scroll, browser_console, and browser_screenshot.",
      "Use browser_open for absolute URLs, browser_snapshot before choosing element refs, browser_wait_for when the task requires a specific URL/title/body text to appear, browser_act for one targeted click/type/key/hover, browser_scroll for long pages, browser_console for bounded page probes, and browser_screenshot for visible evidence artifacts.",
      "When clicking starts dynamic loading and the delegated task names expected text, pass wait_for_text to browser_act or call browser_wait_for before the final snapshot.",
      `For explicitly slow local or loopback diagnostics, set browser_open.timeout_ms up to ${MAX_BROWSER_OPEN_TIMEOUT_MS} and stop with a bounded evidence summary if the page still does not load.`,
      "Do not submit forms, purchase, publish, delete, approve, or change account state from the browser sub-agent private tools unless the delegated task explicitly says parent runtime approval is granted or the permission cache is already applied for that scoped action. Without that explicit approval context, report that the parent must request approval first.",
      "Retry the same browser operation at most three times, changing strategy only when the observed failure justifies it.",
      "Prefer element refIds from snapshots over selectors or visible text when interacting with a page.",
      "Capture screenshots when the parent needs visual evidence or when page state is hard to summarize from text.",
      "For complex pages, preserve verified facts separately for each browser-visible surface: the main page, frames/iframes, shadow DOM or component panels, popups, and additional tabs.",
      "If any browser-visible surface explicitly provides a requested field or value, carry that field into your final result instead of marking it not verified because another surface did not contain it.",
      "Prefer stable page facts and direct observations over guesses.",
    ].join("\n");
  }
  if (kind === "explore") {
    return [
      ...common,
      "You investigate public or provided web/context sources through the private explore_run tool.",
      "Use explore_run for focused retrieval and extraction. Avoid broad repeated searches with no new angle.",
      "Prefer primary sources and cite the exact source facts in your final summary when available.",
      "Do not use placeholder words from a partial answer such as not verified, unverified, unknown, missing, or 未验证 as search queries. Search the original entity names, provider names, official domains, and requested fact labels instead.",
      "For docs/pricing/API research, if a fetched root page exposes navigation text, follow the visible nav/link target or search that exact site+label before guessing paths. After two 404/401 guesses on one host, stop guessing paths and change strategy.",
      "Preserve exact product/entity names from the delegated task. Do not append guessed categories such as smart lock, blockchain, SaaS, or library unless the task explicitly includes that category.",
      "When a name is ambiguous, search the exact name and official domain first, then report ambiguity instead of choosing a guessed interpretation.",
      "For product comparisons, verify only the dimensions the parent explicitly requested; common dimensions include official positioning, pricing, user scale, community feedback, code/repo availability, and update frequency.",
      "For most comparison tasks, 2-4 high-quality official or primary sources are enough to answer; after that, mark missing dimensions as not verified instead of continuing to search.",
      "Stop once the requested answer has enough primary-source evidence. Do not keep searching for nice-to-have metrics that were not requested.",
      "Do not label something open-source or closed-source unless you verified it from an official source or repository. Otherwise write not verified.",
      "Do not use lack of search results as evidence that a company has no users, no community, or poor quality. Mark those dimensions not verified.",
    ].join("\n");
  }
  return [...common, `Use the private ${kind}_run tool for focused work only when needed.`].join("\n");
}

function buildSubAgentTaskPrompt(kind: WorkerKind, taskPrompt: string, sessionState: WorkerInvocationInput["sessionState"]): string {
  return [
    `Delegated ${kind} task:`,
    taskPrompt,
    ...(sessionState?.continuationDigest
      ? [
          "",
          "Existing session continuation:",
          `Reason: ${sessionState.continuationDigest.reason}`,
          `Summary: ${sessionState.continuationDigest.summary}`,
        ]
      : []),
  ].join("\n");
}

function buildInnerToolDescription(kind: WorkerKind): string {
  if (kind === "browser") {
    return "Run one focused browser operation and return observed evidence, status, and any browser payload.";
  }
  if (kind === "explore") {
    return "Run one focused exploration/retrieval operation and return extracted evidence.";
  }
  return `Run one focused ${kind} worker operation and return evidence.`;
}

function prefersWorkerKind(input: WorkerInvocationInput, kind: WorkerKind): boolean {
  const preferred = input.packet.preferredWorkerKinds;
  return Array.isArray(preferred) && preferred.includes(kind);
}

function summarizeReply(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "Sub-agent completed.";
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

async function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, fallbackReason: string): Promise<T> {
  work.catch(() => {
    // If cancellation wins the race, the underlying browser transport may still
    // reject while unwinding. Observe it so late transport errors do not become
    // process-level unhandled rejections.
  });
  if (!signal) {
    return work;
  }
  throwIfAborted(signal, fallbackReason);
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(new Error(abortReason(signal, fallbackReason)));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined, fallbackReason: string): void {
  if (!signal?.aborted) {
    return;
  }
  throw new Error(abortReason(signal, fallbackReason));
}

function abortReason(signal: AbortSignal, fallback: string): string {
  return typeof signal.reason === "string" && signal.reason.trim() ? signal.reason : fallback;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveBrowserOpenTimeoutMs(rawTimeoutMs: unknown, taskPrompt: string, url: string): number | null {
  const slowLoopbackTimeoutMs = resolveSlowLoopbackOpenTimeoutMs(taskPrompt, url);
  if (typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs)) {
    const requested = Math.min(Math.max(Math.floor(rawTimeoutMs), 1), MAX_BROWSER_OPEN_TIMEOUT_MS);
    return slowLoopbackTimeoutMs ? Math.max(requested, slowLoopbackTimeoutMs) : requested;
  }
  return slowLoopbackTimeoutMs;
}

function resolveSlowLoopbackOpenTimeoutMs(taskPrompt: string, url: string): number | null {
  if (!isLoopbackUrl(url)) {
    return null;
  }
  if (isSupplementalLocalTimeoutProbeText(taskPrompt)) {
    return null;
  }
  if (!isSlowDiagnosticText(taskPrompt) && !isSlowDiagnosticText(url)) {
    return null;
  }
  return MAX_BROWSER_OPEN_TIMEOUT_MS;
}

function isSupplementalLocalTimeoutProbeText(value: string): boolean {
  return /\bsupplemental local timeout probe\b/i.test(value);
}

function isSlowDiagnosticText(value: string): boolean {
  return /\b(?:slow[-\s]?source|slow[-\s]?fixture|bounded|does not finish|doesn't finish|timeout|wait boundedly|loading in time)\b/i.test(value);
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortedResult(kind: WorkerKind): WorkerExecutionResult {
  return {
    workerType: kind,
    status: "partial",
    summary: "Sub-agent interrupted before completion.",
    payload: {
      mode: "llm_sub_agent",
      workerType: kind,
      interrupted: true,
    },
  };
}

import type {
  BrowserBridge,
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
import { decodeBrowserSessionPayload } from "@turnkeyai/core-types/browser-session-payload";
import type { LLMToolDefinition } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { NativeToolRoundTrace } from "./native-tool-messages";
import type { RolePromptPacket } from "./prompt-policy";
import type { RoleToolExecutionInput, RoleToolExecutionResult, RoleToolExecutor } from "./tool-use";

const DEFAULT_SUB_AGENT_MAX_ROUNDS = 15;
const DEFAULT_BROWSER_WALL_CLOCK_MS = 18 * 60 * 1000;
const DEFAULT_EXPLORE_WALL_CLOCK_MS = 3 * 60 * 1000;

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
    this.maxRounds = options.maxRounds ?? DEFAULT_SUB_AGENT_MAX_ROUNDS;
    this.maxWallClockMs =
      options.maxWallClockMs ?? (options.kind === "browser" ? DEFAULT_BROWSER_WALL_CLOCK_MS : DEFAULT_EXPLORE_WALL_CLOCK_MS);
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

    const generator = new LLMRoleResponseGenerator({
      gateway: this.gateway,
      ...(this.runtimeProgressRecorder ? { runtimeProgressRecorder: this.runtimeProgressRecorder } : {}),
      clock: this.clock,
      toolLoop: {
        executor: new SubAgentToolExecutor({
          kind: this.kind,
          innerHandler: this.innerHandler,
          parentInput: input,
          ...(this.browserBridge ? { browserBridge: this.browserBridge } : {}),
        }),
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
      return {
        workerType: this.kind,
        status: "completed",
        summary: summarizeReply(reply.content),
        payload: {
          mode: "llm_sub_agent",
          workerType: this.kind,
          content: reply.content,
          metadata: reply.metadata ?? {},
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
        return abortedResult(this.kind);
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

class SubAgentToolExecutor implements RoleToolExecutor {
  private readonly kind: WorkerKind;
  private readonly innerHandler: WorkerHandler;
  private readonly parentInput: WorkerInvocationInput;
  private readonly browserBridge: BrowserBridge | undefined;
  private innerSessionState: WorkerSessionState | undefined;

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
        ...(this.innerSessionState ? { continuityMode: "resume-existing" as const } : {}),
      },
      ...(sessionState ? { sessionState } : {}),
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
    const actionPlan = buildBrowserPrivateActionPlan(input);
    if ("error" in actionPlan) {
      return {
        toolCallId: input.call.id,
        toolName: input.call.name,
        content: actionPlan.error,
        isError: true,
        raw: { error: actionPlan.error },
      };
    }

    const previousPayload =
      this.innerSessionState?.lastResult?.payload ??
      this.parentInput.sessionState?.lastResult?.payload;
    const previous = decodeBrowserSessionPayload(previousPayload);
    const request = {
      taskId: `${this.parentInput.activation.handoff.taskId}:${input.call.id}`,
      threadId: this.parentInput.activation.thread.threadId,
      instructions: actionPlan.instructions,
      actions: actionPlan.actions,
      ownerType: "thread" as const,
      ownerId: this.parentInput.activation.thread.threadId,
      profileOwnerType: "thread" as const,
      profileOwnerId: this.parentInput.activation.thread.threadId,
      ...(this.innerSessionState?.workerRunKey ? { leaseHolderRunKey: this.innerSessionState.workerRunKey } : {}),
      ...(previous?.sessionId ? { browserSessionId: previous.sessionId } : {}),
      ...(previous?.targetId ? { targetId: previous.targetId } : {}),
    };

    const result = previous?.sessionId
      ? await browserBridge.sendSession({ ...request, browserSessionId: previous.sessionId })
      : await browserBridge.spawnSession(request);
    const workerResult = browserToolWorkerResult(result);
    this.innerSessionState = buildInnerSessionState({
      parentInput: this.parentInput,
      kind: this.kind,
      previous: this.innerSessionState,
      result: workerResult,
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
          screenshot: { type: "boolean", description: "Also capture a screenshot after the page opens." },
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
      name: "browser_act",
      description: "Perform one targeted browser interaction, then snapshot the result.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["click", "type", "key", "hover"] },
          refId: { type: "string", description: "Preferred element ref from a prior snapshot." },
          text: { type: "string", description: "Visible target text for click/hover, text to type, or key name." },
          selector: { type: "string", description: "CSS selector fallback when no refId is available." },
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

function buildBrowserPrivateActionPlan(input: RoleToolExecutionInput):
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
      const actions: BrowserTaskAction[] = [
        { kind: "open", url },
        { kind: "snapshot", note: requiredString(raw.note) ?? "after-open" },
      ];
      if (raw.screenshot === true) {
        actions.push({ kind: "screenshot", label: "after-open" });
      }
      return { instructions: `Open ${url} and observe the page.`, actions };
    }
    case "browser_snapshot":
      return {
        instructions: "Capture the current browser page state.",
        actions: [{ kind: "snapshot", note: requiredString(raw.note) ?? "current-page" }],
      };
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
    case "browser_act":
      return buildBrowserActPlan(raw);
    default:
      return { error: `Unknown browser sub-agent tool: ${input.call.name}` };
  }
}

function buildBrowserActPlan(raw: Record<string, unknown>):
  | { instructions: string; actions: BrowserTaskAction[] }
  | { error: string } {
  const action = requiredString(raw.action);
  const target = buildBrowserActionTarget(raw);
  if (raw.submit === true) {
    return { error: "browser_act does not submit forms. Ask the parent agent to request approval for side-effectful browser work." };
  }
  if (action === "click") {
    if (!target) return { error: "browser_act click requires refId, text, or selector." };
    const visibleText = requiredString(raw.text);
    if ("refId" in target && !visibleText) {
      return {
        error: "browser_act click with refId requires visible text so side effects can be screened.",
      };
    }
    const sideEffect = classifyBrowserPrivateSideEffectTarget(target, visibleText);
    if (sideEffect) {
      return {
        error: `browser_act refused likely side-effectful click target "${sideEffect}". Ask the parent agent to request approval first.`,
      };
    }
    return {
      instructions: "Click the requested browser element and observe the result.",
      actions: [{ kind: "click", ...target }, { kind: "snapshot", note: "after-click" }],
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

function summarizeBrowserToolResult(result: BrowserTaskResult): string {
  const failed = result.trace.filter((step) => step.status === "failed");
  const title = result.page.title || result.page.finalUrl || "browser page";
  if (failed.length > 0) {
    return `Browser observed ${title}; ${failed.length} action(s) failed.`;
  }
  return `Browser observed ${title}.`;
}

function buildInnerSessionState(input: {
  parentInput: WorkerInvocationInput;
  kind: WorkerKind;
  previous: WorkerSessionState | undefined;
  result: WorkerExecutionResult;
}): WorkerSessionState {
  const now = Date.now();
  const workerRunKey =
    input.previous?.workerRunKey ??
    input.parentInput.sessionState?.workerRunKey ??
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
    ...(inherited.continuityMode ? { continuityMode: inherited.continuityMode } : {}),
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
  ];
  if (kind === "browser") {
    return [
      ...common,
      "You control browser work through private browser tools: browser_open, browser_snapshot, browser_act, browser_scroll, browser_console, and browser_screenshot.",
      "Use browser_open for absolute URLs, browser_snapshot before choosing element refs, browser_act for one targeted click/type/key/hover, browser_scroll for long pages, browser_console for bounded page probes, and browser_screenshot for visible evidence artifacts.",
      "Do not submit forms, purchase, publish, delete, approve, or change account state from the browser sub-agent private tools; report that the parent must request approval first.",
      "Retry the same browser operation at most three times, changing strategy only when the observed failure justifies it.",
      "Prefer element refIds from snapshots over selectors or visible text when interacting with a page.",
      "Capture screenshots when the parent needs visual evidence or when page state is hard to summarize from text.",
      "Prefer stable page facts and direct observations over guesses.",
    ].join("\n");
  }
  if (kind === "explore") {
    return [
      ...common,
      "You investigate public or provided web/context sources through the private explore_run tool.",
      "Use explore_run for focused retrieval and extraction. Avoid broad repeated searches with no new angle.",
      "Prefer primary sources and cite the exact source facts in your final summary when available.",
      "For product comparisons, verify each requested dimension separately: official positioning, pricing, user scale, community feedback, code/repo availability, and update frequency.",
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

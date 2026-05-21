import type {
  Clock,
  RoleActivationInput,
  RuntimeProgressRecorder,
  WorkerExecutionResult,
  WorkerHandler,
  WorkerInvocationInput,
  WorkerKind,
} from "@turnkeyai/core-types/team";
import type { LLMToolDefinition } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import { LLMRoleResponseGenerator } from "./llm-response-generator";
import type { RolePromptPacket } from "./prompt-policy";
import type { RoleToolExecutionInput, RoleToolExecutionResult, RoleToolExecutor } from "./tool-use";

const DEFAULT_SUB_AGENT_MAX_ROUNDS = 15;
const DEFAULT_BROWSER_WALL_CLOCK_MS = 18 * 60 * 1000;
const DEFAULT_EXPLORE_WALL_CLOCK_MS = 8 * 60 * 1000;

export interface LLMSubAgentWorkerHandlerOptions {
  kind: WorkerKind;
  innerHandler: WorkerHandler;
  gateway: LLMGateway;
  runtimeProgressRecorder?: RuntimeProgressRecorder;
  clock?: Clock;
  maxRounds?: number;
  maxWallClockMs?: number;
}

export class LLMSubAgentWorkerHandler implements WorkerHandler {
  readonly kind: WorkerKind;
  private readonly innerHandler: WorkerHandler;
  private readonly gateway: LLMGateway;
  private readonly runtimeProgressRecorder: RuntimeProgressRecorder | undefined;
  private readonly clock: Clock;
  private readonly maxRounds: number;
  private readonly maxWallClockMs: number;

  constructor(options: LLMSubAgentWorkerHandlerOptions) {
    this.kind = options.kind;
    this.innerHandler = options.innerHandler;
    this.gateway = options.gateway;
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

  constructor(options: { kind: WorkerKind; innerHandler: WorkerHandler; parentInput: WorkerInvocationInput }) {
    this.kind = options.kind;
    this.innerHandler = options.innerHandler;
    this.parentInput = options.parentInput;
  }

  definitions(): LLMToolDefinition[] {
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

    const result = await this.innerHandler.run({
      ...this.parentInput,
      packet: {
        ...this.parentInput.packet,
        taskPrompt: instruction,
        preferredWorkerKinds: [this.kind],
      },
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
  ];
  if (kind === "browser") {
    return [
      ...common,
      "You control browser work through the private browser_run tool.",
      "Use browser_run for navigation, observation, screenshots, clicks, form input, or page state checks.",
      "Retry the same browser operation at most three times, changing strategy only when the observed failure justifies it.",
      "Prefer stable page facts and direct observations over guesses.",
    ].join("\n");
  }
  if (kind === "explore") {
    return [
      ...common,
      "You investigate public or provided web/context sources through the private explore_run tool.",
      "Use explore_run for focused retrieval and extraction. Avoid broad repeated searches with no new angle.",
      "Prefer primary sources and cite the exact source facts in your final summary when available.",
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

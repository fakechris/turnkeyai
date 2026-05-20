import type { RoleSlot, WorkerKind } from "@turnkeyai/core-types/team";
import type { LLMToolDefinition } from "@turnkeyai/llm-adapter/index";

export const SESSION_TOOL_NAMES = ["sessions_spawn", "sessions_send", "sessions_list", "sessions_history"] as const;
export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];
export type NativeToolName = SessionToolName;

export interface ToolCapabilityRecord {
  name: NativeToolName;
  definition: LLMToolDefinition;
  executorKind: "worker-session";
  promptGroup: "sessions";
}

export interface ToolPromptHarnessInput {
  seat: RoleSlot["seat"];
  availableWorkerKinds?: WorkerKind[];
}

export interface ToolCapabilitySummary {
  name: NativeToolName;
  executorKind: ToolCapabilityRecord["executorKind"];
  promptGroup: ToolCapabilityRecord["promptGroup"];
}

export class ToolCapabilityRegistry {
  private readonly records: ToolCapabilityRecord[];
  private readonly workerKinds: WorkerKind[];

  constructor(input: { records: ToolCapabilityRecord[]; workerKinds: WorkerKind[] }) {
    this.records = input.records;
    this.workerKinds = input.workerKinds;
  }

  definitions(): LLMToolDefinition[] {
    return this.records.map((record) => record.definition);
  }

  names(): NativeToolName[] {
    return this.records.map((record) => record.name);
  }

  summaries(): ToolCapabilitySummary[] {
    return this.records.map((record) => ({
      name: record.name,
      executorKind: record.executorKind,
      promptGroup: record.promptGroup,
    }));
  }

  availableWorkerKinds(): WorkerKind[] {
    return [...this.workerKinds];
  }

  renderPromptHarness(input: ToolPromptHarnessInput): string {
    return renderToolPromptHarness({
      enabledToolNames: this.names(),
      availableWorkerKinds: input.availableWorkerKinds ?? this.workerKinds,
      seat: input.seat,
    });
  }
}

export function createNativeToolCapabilityRegistry(input: {
  availableWorkerKinds?: WorkerKind[];
} = {}): ToolCapabilityRegistry {
  const workerKinds = normalizeWorkerKinds(input.availableWorkerKinds);
  return new ToolCapabilityRegistry({
    workerKinds,
    records: buildSessionToolDefinitions(workerKinds).map((definition) => ({
      name: definition.name as NativeToolName,
      definition,
      executorKind: "worker-session" as const,
      promptGroup: "sessions" as const,
    })),
  });
}

export function buildSessionToolDefinitions(workerKinds: WorkerKind[]): LLMToolDefinition[] {
  return [
    {
      name: "sessions_spawn",
      description:
        "Spawn a specialist sub-agent session for an isolated task. Use browser for authenticated or interactive web work; use explore for focused research; use finance for market data.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The exact self-contained task for the sub-agent." },
          agent_id: {
            type: "string",
            enum: workerKinds,
            description: "Sub-agent kind backed by an executable worker handler.",
          },
          label: { type: "string", description: "Short user-visible label." },
        },
        required: ["task", "agent_id"],
      },
    },
    {
      name: "sessions_send",
      description: "Send a follow-up message to an existing sub-agent session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_key: { type: "string", description: "Worker session key returned by sessions_spawn/list." },
          message: { type: "string", description: "Follow-up instruction." },
          label: { type: "string" },
        },
        required: ["session_key", "message"],
      },
    },
    {
      name: "sessions_list",
      description: "List local sub-agent sessions available for follow-up or inspection.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kinds: { type: "array", items: { type: "string", enum: workerKinds } },
          agent_id: { type: "string", enum: workerKinds },
          parentSessionKey: { type: "string" },
          activeMinutes: { type: "number", minimum: 1 },
          limit: { type: "number", minimum: 1 },
        },
      },
    },
    {
      name: "sessions_history",
      description: "Read a compact history summary for an existing sub-agent session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_key: { type: "string" },
          offset: { type: "number", minimum: 0 },
          limit: { type: "number", minimum: 1 },
          include_tools: { type: "boolean" },
        },
        required: ["session_key"],
      },
    },
  ];
}

function renderToolPromptHarness(input: {
  enabledToolNames: NativeToolName[];
  availableWorkerKinds: WorkerKind[];
  seat: RoleSlot["seat"];
}): string {
  const enabled = new Set(input.enabledToolNames);
  const sections = [renderGeneralToolUsageSection()];

  if (SESSION_TOOL_NAMES.some((name) => enabled.has(name))) {
    sections.push(renderDelegationSection(input.availableWorkerKinds, input.seat));
  }

  if (input.availableWorkerKinds.includes("browser")) {
    sections.push(renderBrowserWorkerSection());
  }

  return sections.filter(Boolean).join("\n\n");
}

function renderGeneralToolUsageSection(): string {
  return [
    "## Tool Usage Discipline",
    "- When action is needed and a tool is available, call the tool; do not only describe the action.",
    "- Use specialized tools before generic shell-style workarounds.",
    "- Run independent tool calls in parallel when their inputs do not depend on each other.",
    "- Do not repeat the same tool call with the same arguments. After 2-3 failed attempts, stop and report the failure and what is needed.",
    "- Every non-trivial task needs a verification step before final delivery.",
  ].join("\n");
}

function renderDelegationSection(workerKinds: WorkerKind[], seat: RoleSlot["seat"]): string {
  const agentRows = workerKinds.map((kind) => `- ${kind}: ${describeWorkerKind(kind)}`);
  return [
    "## Sub-Agent Sessions",
    "Use sessions_spawn only when delegation materially helps: parallel independent work, context isolation, specialist browser work, or verification.",
    "Each spawned task must be self-contained. Include exact URLs, paths, scope, output format, stop conditions, and constraints the child will not otherwise know.",
    "Prefer multiple focused sub-agents over one broad sub-agent when the subtasks are independent.",
    "After a sub-agent returns, validate coverage before presenting the result. If the result is partial, use sessions_send or a new focused spawn.",
    "Use sessions_history to inspect sessions you spawned or when the user explicitly asks to recall prior sub-agent work. Do not browse unrelated sessions as a fallback.",
    seat === "lead"
      ? "As lead, own the final synthesis. Sub-agents provide evidence; you decide whether the user's request is complete."
      : "As a specialist, only delegate if the assigned slice requires a worker you cannot perform directly.",
    "",
    "Executable sub-agent kinds:",
    agentRows.length > 0 ? agentRows.join("\n") : "- (none)",
  ].join("\n");
}

function renderBrowserWorkerSection(): string {
  return [
    "## Browser Worker Rules",
    "- Browser work is for authenticated pages, JS-rendered pages, visual inspection, interactive actions, and pages where direct fetch is insufficient.",
    "- For public research, find the correct URL first; use browser when interaction, login state, screenshots, or dynamic content is required.",
    "- For personal dashboards or account data, prefer the browser worker because it can use the user's active browser session.",
    "- Keep browser tasks bounded: specify target URL or search query, required fields, output format, and when to stop.",
    "- Browser results must return evidence, relevant session/target identifiers, and screenshot or artifact references when screenshots are taken.",
    "- Do not loop on browser failures. After repeated navigation, action, or extraction failures, report the failure and the next required input.",
  ].join("\n");
}

function describeWorkerKind(kind: WorkerKind): string {
  switch (kind) {
    case "browser":
      return "authenticated or interactive web work, visual inspection, snapshots, screenshots, and browser actions";
    case "explore":
      return "focused read-only research and code/content exploration";
    case "finance":
      return "market and financial-data lookups";
    case "coder":
      return "code-editing worker, only when an executable coder handler is installed";
    case "harness":
      return "verification or test harness worker, only when an executable harness handler is installed";
    default:
      return "specialist worker";
  }
}

function normalizeWorkerKinds(input: WorkerKind[] | undefined): WorkerKind[] {
  const fallback = ["browser", "explore", "finance", "coder", "harness"] satisfies WorkerKind[];
  const values = input && input.length > 0 ? input : fallback;
  return [...new Set(values)];
}

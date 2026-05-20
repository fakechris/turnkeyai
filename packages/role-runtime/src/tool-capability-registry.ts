import type { RoleSlot, WorkerKind } from "@turnkeyai/core-types/team";
import type { LLMToolDefinition } from "@turnkeyai/llm-adapter/index";

export const SESSION_TOOL_NAMES = ["sessions_spawn", "sessions_send", "sessions_list", "sessions_history"] as const;
export const PERMISSION_TOOL_NAMES = ["permission_query", "permission_result", "permission_applied"] as const;
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_get"] as const;
export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];
export type PermissionToolName = (typeof PERMISSION_TOOL_NAMES)[number];
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];
export type NativeToolName = SessionToolName | PermissionToolName | MemoryToolName;

export interface ToolCapabilityRecord {
  name: NativeToolName;
  definition: LLMToolDefinition;
  executorKind: "worker-session" | "permission" | "memory";
  promptGroup: "sessions" | "permissions" | "memory";
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
  permissionsEnabled?: boolean;
  memoryEnabled?: boolean;
} = {}): ToolCapabilityRegistry {
  const workerKinds = normalizeWorkerKinds(input.availableWorkerKinds);
  const records: ToolCapabilityRecord[] = [];
  if (workerKinds.length > 0) {
    records.push(
      ...buildSessionToolDefinitions(workerKinds).map((definition) => ({
        name: definition.name as NativeToolName,
        definition,
        executorKind: "worker-session" as const,
        promptGroup: "sessions" as const,
      }))
    );
  }
  if (input.permissionsEnabled) {
    records.push(
      ...buildPermissionToolDefinitions(workerKinds).map((definition) => ({
        name: definition.name as NativeToolName,
        definition,
        executorKind: "permission" as const,
        promptGroup: "permissions" as const,
      }))
    );
  }
  if (input.memoryEnabled) {
    records.push(
      ...buildMemoryToolDefinitions().map((definition) => ({
        name: definition.name as NativeToolName,
        definition,
        executorKind: "memory" as const,
        promptGroup: "memory" as const,
      }))
    );
  }
  return new ToolCapabilityRegistry({
    workerKinds,
    records,
  });
}

export function buildMemoryToolDefinitions(): LLMToolDefinition[] {
  return [
    {
      name: "memory_search",
      description:
        "Search durable thread memory, session memory, journal notes, and admitted worker evidence for prior decisions, preferences, constraints, open items, or evidence.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Concrete recall query. Include the decision, preference, constraint, or evidence you need." },
          limit: { type: "number", minimum: 1, maximum: 10, description: "Maximum number of memory hits to return." },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_get",
      description:
        "Fetch one durable memory hit by memory_id returned from memory_search. Use this when you need to quote or verify a specific remembered item.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          memory_id: { type: "string", description: "memory_id returned by memory_search." },
        },
        required: ["memory_id"],
      },
    },
  ];
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
          timeout_seconds: {
            type: "number",
            minimum: 0.001,
            maximum: 900,
            description:
              "Optional wall-clock timeout for this sub-agent call. On timeout the session is interrupted and remains available for sessions_send follow-up.",
          },
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
          timeout_seconds: {
            type: "number",
            minimum: 0.001,
            maximum: 900,
            description:
              "Optional wall-clock timeout for this follow-up. On timeout the session is interrupted and remains available for another sessions_send.",
          },
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

export function buildPermissionToolDefinitions(workerKinds: WorkerKind[]): LLMToolDefinition[] {
  return [
    {
      name: "permission_query",
      description:
        "Request operator permission before a side-effectful action. Use this before browser form submits, publishing, mutations, credential access, or other irreversible work.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", description: "Capability/action path, for example browser.form.submit." },
          title: { type: "string", description: "Short user-visible approval title." },
          risk: { type: "string", description: "Concrete risk or side effect the operator is approving." },
          level: { type: "string", enum: ["confirm", "approval"], description: "Use approval for writes/publish/credential access." },
          scope: { type: "string", enum: ["navigate", "mutate", "publish", "credential"], description: "Permission scope." },
          rationale: { type: "string", description: "Why this permission is necessary for the task." },
          worker_kind: workerKindSchema(workerKinds, "Worker kind that will use this permission."),
          mission_id: { type: "string", description: "Optional mission id. Omit inside Mission Control threads." },
          affects: { type: "array", items: { type: "string" }, description: "Context source ids affected by the action." },
          payload: { type: "object", additionalProperties: true, description: "Redacted structured action arguments." },
          cache_key: { type: "string", description: "Optional stable cache key. Omit to derive one from thread/worker/scope/level." },
        },
        required: ["action", "title", "risk", "level", "scope", "rationale"],
      },
    },
    {
      name: "permission_result",
      description: "Check whether a pending permission request has been approved or denied.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          approval_id: { type: "string" },
        },
        required: ["approval_id"],
      },
    },
    {
      name: "permission_applied",
      description:
        "Apply an approved permission to runtime permission cache before continuing the side-effectful action. Do not call this for denied or pending approvals.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          approval_id: { type: "string" },
        },
        required: ["approval_id"],
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

  if (PERMISSION_TOOL_NAMES.some((name) => enabled.has(name))) {
    sections.push(renderPermissionSection());
  }

  if (MEMORY_TOOL_NAMES.some((name) => enabled.has(name))) {
    sections.push(renderMemorySection());
  }

  if (input.availableWorkerKinds.includes("browser")) {
    sections.push(renderBrowserWorkerSection());
  }

  return sections.filter(Boolean).join("\n\n");
}

function renderMemorySection(): string {
  return [
    "## Memory Tools",
    "- Use memory_search when the task depends on prior decisions, user preferences, constraints, unresolved questions, or previously gathered evidence.",
    "- Do not fabricate remembered facts. If memory_search returns no relevant hit, say what is missing or continue from current context.",
    "- Use memory_get to inspect a specific memory_id returned by memory_search before relying on precise wording.",
    "- Treat browser/evidence memory according to its trust/admission metadata; do not promote weak observations into facts without verification.",
  ].join("\n");
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

function renderPermissionSection(): string {
  return [
    "## Permission Loop",
    "- Before any side-effectful action, call permission_query with the exact action, scope, risk, and redacted payload. Do not perform the action first.",
    "- If permission_query returns pending, stop and tell the user the approval is waiting. Do not invent an approval result.",
    "- After the operator decides, call permission_result with the approval_id. If denied, explain the denied path and choose a safe fallback.",
    "- If approved, call permission_applied before continuing the approved action so runtime cache and audit state match the operator decision.",
    "- Use approval for mutations, publishing, credential access, purchases, submits, or browser actions that change account state; use confirm only for lower-risk interactive navigation.",
  ].join("\n");
}

function renderDelegationSection(workerKinds: WorkerKind[], seat: RoleSlot["seat"]): string {
  const agentRows = workerKinds.map((kind) => `- ${kind}: ${describeWorkerKind(kind)}`);
  return [
    "## Sub-Agent Sessions",
    "Use sessions_spawn only when delegation materially helps: parallel independent work, context isolation, specialist browser work, or verification.",
    "Each spawned task must be self-contained. Include exact URLs, paths, scope, output format, stop conditions, and constraints the child will not otherwise know.",
    "Use timeout_seconds for bounded work. If a sub-agent times out, inspect sessions_history and continue with sessions_send only if the remaining work is still valuable.",
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
  return [...new Set(input ?? [])];
}

function workerKindSchema(workerKinds: WorkerKind[], description: string): { type: "string"; enum?: WorkerKind[]; description: string } {
  return {
    type: "string",
    ...(workerKinds.length > 0 ? { enum: workerKinds } : {}),
    description,
  };
}

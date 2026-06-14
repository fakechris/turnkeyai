import type { RoleSlot, WorkerKind } from "@turnkeyai/core-types/team";
import type { LLMToolDefinition } from "@turnkeyai/llm-adapter/index";

export const SESSION_TOOL_NAMES = ["sessions_spawn", "sessions_send", "sessions_list", "sessions_history"] as const;
export const PERMISSION_TOOL_NAMES = ["permission_query", "permission_result", "permission_applied"] as const;
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_get"] as const;
export const TASK_TOOL_NAMES = ["tasks_list", "tasks_create", "tasks_update"] as const;
export const WEB_TOOL_NAMES = ["web_fetch"] as const;
export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];
export type PermissionToolName = (typeof PERMISSION_TOOL_NAMES)[number];
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];
export type NativeToolName = SessionToolName | PermissionToolName | MemoryToolName | TaskToolName | WebToolName;

export interface ToolCapabilityRecord {
  name: NativeToolName;
  definition: LLMToolDefinition;
  executorKind: "worker-session" | "permission" | "memory" | "task" | "web";
  promptGroup: "sessions" | "permissions" | "memory" | "tasks" | "web";
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
  tasksEnabled?: boolean;
  webFetchEnabled?: boolean;
  maxSessionToolTimeoutSeconds?: number;
} = {}): ToolCapabilityRegistry {
  const workerKinds = normalizeWorkerKinds(input.availableWorkerKinds);
  const records: ToolCapabilityRecord[] = [];
  if (input.webFetchEnabled) {
    records.push(
      ...buildWebToolDefinitions().map((definition) => ({
        name: definition.name as NativeToolName,
        definition,
        executorKind: "web" as const,
        promptGroup: "web" as const,
      }))
    );
  }
  if (workerKinds.length > 0) {
    records.push(
      ...buildSessionToolDefinitions(workerKinds, {
        ...(input.maxSessionToolTimeoutSeconds
          ? { maxTimeoutSeconds: input.maxSessionToolTimeoutSeconds }
          : {}),
      }).map((definition) => ({
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
  if (input.tasksEnabled) {
    records.push(
      ...buildTaskToolDefinitions().map((definition) => ({
        name: definition.name as NativeToolName,
        definition,
        executorKind: "task" as const,
        promptGroup: "tasks" as const,
      }))
    );
  }
  return new ToolCapabilityRegistry({
    workerKinds,
    records,
  });
}

export function buildWebToolDefinitions(): LLMToolDefinition[] {
  return [
    {
      name: "web_fetch",
      description:
        "Fetch a public HTTP(S) page directly and return structured title/text evidence. Use this before spawning explore for a known public URL when rendered/browser-visible evidence is not required. Do not use for localhost, private-network, authenticated, interactive, visual, JS-rendered, or browser-session pages.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", description: "Public http or https URL to fetch." },
          max_chars: {
            type: "number",
            minimum: 200,
            maximum: 4000,
            description: "Optional maximum extracted text characters to return. Defaults to 1200.",
          },
        },
        required: ["url"],
      },
    },
  ];
}

export function buildTaskToolDefinitions(): LLMToolDefinition[] {
  const statusSchema = {
    type: "string",
    enum: ["draft", "planning", "working", "needs_approval", "blocked", "done", "archived"],
  };
  return [
    {
      name: "tasks_list",
      description: "List mission work items so the agent can inspect task state before planning follow-up work.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mission_id: { type: "string", description: "Optional mission id. Omit inside Mission Control threads." },
          status: statusSchema,
          agent_id: { type: "string", description: "Optional assigned agent id filter." },
          limit: { type: "number", minimum: 1, maximum: 50 },
        },
      },
    },
    {
      name: "tasks_create",
      description: "Create a mission work item for a concrete subtask that should be tracked and verified.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mission_id: { type: "string", description: "Optional mission id. Omit inside Mission Control threads." },
          title: { type: "string", description: "Short, concrete work-item title." },
          agent_id: { type: "string", description: "Agent expected to own the item. Defaults to the current role." },
          status: statusSchema,
          context_refs: { type: "array", items: { type: "string" } },
          output: { type: "string", description: "Optional initial expected output or note." },
        },
        required: ["title"],
      },
    },
    {
      name: "tasks_update",
      description: "Update mission work-item status, progress, output, or blocker after work or verification.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mission_id: { type: "string", description: "Optional mission id. Omit inside Mission Control threads." },
          work_item_id: { type: "string" },
          status: statusSchema,
          output: { type: "string" },
          blocker: { type: "string" },
          clear_blocker: { type: "boolean" },
          progress: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["work_item_id"],
      },
    },
  ];
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

export function buildSessionToolDefinitions(
  workerKinds: WorkerKind[],
  options: { maxTimeoutSeconds?: number } = {}
): LLMToolDefinition[] {
  const maxTimeoutSeconds =
    typeof options.maxTimeoutSeconds === "number" &&
    Number.isFinite(options.maxTimeoutSeconds) &&
    options.maxTimeoutSeconds > 0
      ? options.maxTimeoutSeconds
      : 1800;
  return [
    {
      name: "sessions_spawn",
      description:
        "Spawn a specialist sub-agent session for an isolated task. Use explore first for public source research, pricing/docs pages, and read-only URL extraction unless the task asks for browser-visible, user-visible, rendered, visual, or interactive page evidence. Use browser directly for authenticated, interactive, visual, JS-rendered, localhost, loopback, private-network, internal, dashboard, user-session, or browser-visible page-review tasks. Use finance for market data.",
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
            maximum: maxTimeoutSeconds,
            description:
              "Optional wall-clock timeout for this sub-agent call. On timeout the session is interrupted and remains available for sessions_send follow-up.",
          },
        },
        required: ["task", "agent_id"],
      },
    },
    {
      name: "sessions_send",
      description:
        "Send a follow-up message to an existing sub-agent session. Prefer this over sessions_spawn when continuing, refining, or adding evidence to prior delegated work.",
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
            maximum: maxTimeoutSeconds,
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
          // snake_case matches the field names this tool RETURNS (models copy
          // them back as filters); camelCase kept for backward compatibility.
          parent_session_key: { type: "string" },
          parentSessionKey: { type: "string" },
          active_minutes: { type: "number", minimum: 1 },
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
          cursor: {
            type: "string",
            description:
              "Opaque cursor returned by a previous sessions_history call. Prefer this over offset for long transcripts.",
          },
          offset: { type: "number", minimum: 0 },
          limit: { type: "number", minimum: 1 },
          include_tools: { type: "boolean" },
          tail: {
            type: "boolean",
            description: "Return the latest entries. Use this for completed sessions when the final answer is near the end.",
          },
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

  if (WEB_TOOL_NAMES.some((name) => enabled.has(name))) {
    sections.push(renderWebFetchSection());
  }

  if (PERMISSION_TOOL_NAMES.some((name) => enabled.has(name))) {
    sections.push(renderPermissionSection());
  }

  if (MEMORY_TOOL_NAMES.some((name) => enabled.has(name))) {
    sections.push(renderMemorySection());
  }

  if (TASK_TOOL_NAMES.some((name) => enabled.has(name))) {
    sections.push(renderTaskSection());
  }

  if (input.availableWorkerKinds.includes("browser")) {
    sections.push(renderBrowserWorkerSection());
  }

  return sections.filter(Boolean).join("\n\n");
}

function renderWebFetchSection(): string {
  return [
    "## Direct Web Fetch",
    "- For a known public HTTP(S) URL that does not require rendered, visual, authenticated, interactive, localhost, private-network, internal, dashboard, or user-session evidence, use web_fetch before spawning a sub-agent.",
    "- web_fetch is source evidence, not browser evidence. If the task asks what a user sees, requires screenshots, or depends on JavaScript-rendered content, use the browser worker instead.",
    "- Cite the returned final_url/requested_url and treat blocked, non-200, or low-content results as incomplete evidence that needs another tool path.",
    "- When a fetched root/docs page exposes navigation text, prefer following the visible nav/link target or searching that exact site+label over guessing URL paths. After two 404/401 guesses on one host, stop guessing paths and switch to site search, provider search, or browser.",
  ].join("\n");
}

function renderTaskSection(): string {
  return [
    "## Mission Task Management",
    "- Use tasks_list before changing plan state when the mission may already have work items.",
    "- Use tasks_create for concrete, trackable subtasks in multi-step work; keep each title specific and assign it to the agent that owns the outcome.",
    "- Use tasks_update when a work item starts, blocks, completes, or after verification changes the result.",
    "- Mark a task done only after its requested output has been produced or verified. Record blockers explicitly instead of hiding them in final prose.",
    "- For 3+ meaningful subtasks, keep mission work items current so the user can inspect progress without reading the whole conversation.",
  ].join("\n");
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
    "- If you approach the execution limit, stop calling tools and synthesize only from tool results already present in the conversation.",
    "- Every non-trivial task needs a verification step before final delivery.",
    "- For research or comparison tasks, maintain an evidence ledger: source URL/name, source type, exact fact verified, and remaining uncertainty.",
    "- For recovery or continuation work, never use placeholder words such as not verified, unverified, unknown, missing, or 未验证 as search queries. Search the original entity names, provider names, official domains, and requested fact labels instead.",
    "- For public docs/pricing/API research, start from official root/model/pricing pages when known; if the root page reveals a nav label such as Models & Pricing, use that label to locate the linked page instead of inventing likely paths.",
    "- Do not turn homepage or marketing copy into unsupported claims about user scale, community feedback, code quality, or update frequency. If a metric is not verified from credible sources, write not verified.",
    "- Do not add DNS/IP resolution, IANA allocation details, production-environment bans, real-service claims, security-scanner claims, or abuse-risk claims unless those exact facts appear in the gathered evidence.",
    "- If evidence states a narrow scope limit or usage caveat, preserve its exact wording (or state that wider use is outside the verified scope); do not upgrade a narrow caveat into a broader production-environment or real-service ban.",
    "- A final answer must be structurally complete. If the answer would be cut off, produce a shorter complete answer with a source ledger and explicitly mark missing details.",
    "- When the user/task specifies an exact final answer skeleton, output only that skeleton. Do not add status preambles like 'All tool calls returned' or 'Producing the final answer'.",
    "- For exact-skeleton answers, keep each requested bullet compact, usually one sentence, while preserving required markers, facts, and residual risk.",
  ].join("\n");
}

function renderPermissionSection(): string {
  return [
    "## Permission Loop",
    "- Before any side-effectful action, call permission_query with the exact action, scope, risk, and redacted payload. Do not perform the action first.",
    "- Do not call permission_query for read-only browser navigation, re-checks, inspections, snapshots, screenshots, extraction, or dashboard reviews. Use sessions_spawn or sessions_send directly for those tasks; approval is only for actions that can mutate external or account state.",
    "- If permission_query returns pending, stop and tell the user the approval is waiting. Do not invent an approval result.",
    "- After the operator decides, call permission_result with the approval_id. If denied, explain the denied path and choose a safe fallback.",
    "- If approved, call permission_applied before continuing the approved action so runtime cache and audit state match the operator decision.",
    "- Use approval for mutations, publishing, credential access, purchases, submits, or browser actions that change account state; use confirm only for lower-risk interactive navigation.",
  ].join("\n");
}

function renderDelegationSection(workerKinds: WorkerKind[], seat: RoleSlot["seat"]): string {
  const agentRows = workerKinds.map((kind) => `- ${kind}: ${describeWorkerKind(kind)}`);
  const hasBrowserWorker = workerKinds.includes("browser");
  return [
    "## Sub-Agent Sessions",
    hasBrowserWorker
      ? "Use sessions_spawn only when delegation materially helps: parallel independent work, context isolation, specialist browser work, or verification."
      : "Use sessions_spawn only when delegation materially helps: parallel independent work, context isolation, specialist research, or verification.",
    "Each spawned task must be self-contained. Include exact URLs, paths, scope, output format, stop conditions, and constraints the child will not otherwise know.",
    hasBrowserWorker
      ? "For public source research, comparison, pricing, documentation, or read-only URL extraction, spawn explore first unless the task asks for browser-visible, user-visible, rendered, visual, or interactive page evidence. For localhost, loopback, private-network, internal, authenticated, dashboard, user-session, browser-visible, or rendered/client-side URLs, spawn browser directly; explore is for public fetchable sources and may reject private hosts by policy."
      : "For public source research, comparison, pricing, documentation, or read-only URL extraction, spawn explore when it is available. If the task requires browser-visible, rendered, visual, interactive, localhost, private-network, internal, authenticated, dashboard, or user-session evidence and no browser worker is listed below, report that browser evidence is unavailable instead of pretending explore can provide it.",
    "Preserve exact user-provided entity names in delegated research. Do not append guessed categories or domains such as smart lock, blockchain, SaaS, or library unless the user supplied that category.",
    "For ambiguous product names without URLs, ask sub-agents to first search the exact name and official website/domain, then mark ambiguity explicitly instead of steering the search toward a guessed meaning.",
    "Keep each spawned task to a manageable size, roughly 10-15 tool calls. If the work is larger, split it into smaller independent sessions.",
    "Prefer multiple focused sub-agents over one broad sub-agent when the subtasks are independent; do not exceed five parallel sub-agents for one user request.",
    "For tasks with three or more independent evidence streams, split the streams into separate focused sessions instead of assigning one broad session to collect everything.",
    "In one assistant turn, emit at most five session tool calls total. For two independent subtasks, emit exactly two focused calls, then wait for results before any follow-up wave.",
    "Leave timeout_seconds unset for ordinary delegated work so the runtime applies product budgets. Set it only when the user gives an explicit wait bound or the task has a known external latency.",
    "If a sub-agent times out, inspect sessions_history and continue with sessions_send only if the remaining work is still valuable. Do not increase timeout_seconds on a timeout follow-up unless the user explicitly asks to wait longer. Do not treat a timeout as final evidence.",
    "When the user asks to continue, refine, revisit, add a source to, or follow up on prior delegated work, route that request back to the relevant existing session with sessions_send instead of answering only from parent context or spawning a duplicate. Synthesize directly only when the user asks for pure formatting and no session-owned evidence needs to be revisited.",
    "There is no sessions_update tool. Use sessions_send for any update, resume, revisit, or continuation of existing session-owned work.",
    "For sessions_send follow-ups, preserve the original task's decision criteria, required dimensions, entity names, source labels, and user terminology unless the latest user message explicitly changes scope.",
    "If you need a session key for prior delegated work, use sessions_list or the previous sessions_spawn result before deciding to spawn again.",
    "After a sub-agent returns, first read the sessions_spawn/sessions_send result and final_content. Do not page through session history when that result already contains the evidence you need.",
    "If history is needed, prefer one sessions_history call with tail=true and a small limit. Avoid repeated pagination unless the user explicitly asks for the transcript.",
    "Validate coverage before presenting the result. If the result is partial, use sessions_send or a new focused spawn; otherwise synthesize directly.",
    "When synthesizing sub-agent research, preserve the evidence quality labels. Do not promote a sub-agent's partial or unverified observation into a confirmed final claim.",
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
    "- Browser work is for authenticated pages, JS-rendered pages, visual inspection, interactive actions, localhost/private-network/internal pages, and pages where direct fetch is insufficient.",
    "- When the task says to review a page as a user would see it, inspect a JS-rendered/client-rendered page, or verify a rendered dashboard, use the browser worker. Do not substitute explore/static fetch for that browser evidence.",
    "- For public research, pricing pages, docs pages, and read-only URL extraction, use explore first. Use browser first for localhost, loopback, private-network, internal, dashboard, rendered, visual, or user-session evidence; otherwise use browser after explore/static extraction is blocked or incomplete.",
    "- For personal dashboards or account data, prefer the browser worker because it can use the user's active browser session.",
    "- Keep browser tasks bounded: specify target URL or search query, required fields, output format, and when to stop.",
    "- If the user asks to carry out an approved browser action such as submit, save, purchase, send, delete, or update, the delegated browser task must include that requested action and its approval boundary. Do not downgrade the task to read-only inspection unless the user only asked for inspection.",
    "- Browser sub-agents do not own approval tools. Parent runtime handles permission_query, permission_result, and permission_applied before dispatch. If your delegated task says approval is granted or applied, perform only that scoped browser action with browser tools; if approval is missing or pending, stop and report the approval requirement.",
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

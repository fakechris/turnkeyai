import type {
  RoleActivationInput,
  ThreadMemoryRecord,
  ThreadMemoryStore,
} from "@turnkeyai/core-types/team";
import type { GenerateTextInput, RequestEnvelopeDiagnostics } from "@turnkeyai/llm-adapter/index";
import { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import type { RolePromptPacket } from "./prompt-policy";

export interface PreCompactionMemoryFlushResult {
  status: "written" | "skipped";
  preferences: string[];
  constraints: string[];
  longTermNotes: string[];
}

export interface PreCompactionMemoryFlusher {
  flush(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    modelId?: string;
    modelChainId?: string;
    reason: "request_envelope_overflow";
    diagnostics?: RequestEnvelopeDiagnostics;
  }): Promise<PreCompactionMemoryFlushResult>;
}

export async function flushPreCompactionMemorySafely(input: {
  flusher?: PreCompactionMemoryFlusher | undefined;
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  selection: {
    modelId?: string | undefined;
    modelChainId?: string | undefined;
  };
  diagnostics?: RequestEnvelopeDiagnostics | undefined;
}): Promise<PreCompactionMemoryFlushResult | undefined> {
  if (!input.flusher) {
    return undefined;
  }
  try {
    return await input.flusher.flush({
      activation: input.activation,
      packet: input.packet,
      ...(input.selection.modelId ? { modelId: input.selection.modelId } : {}),
      ...(input.selection.modelChainId
        ? { modelChainId: input.selection.modelChainId }
        : {}),
      reason: "request_envelope_overflow",
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
  } catch (error) {
    console.error("pre-compaction memory flush failed", {
      threadId: input.activation.thread.threadId,
      flowId: input.activation.flow.flowId,
      taskId: input.activation.handoff.taskId,
      error,
    });
    return undefined;
  }
}

interface DefaultPreCompactionMemoryFlusherOptions {
  gateway: LLMGateway;
  threadMemoryStore: ThreadMemoryStore;
  now?: () => number;
  maxItemsPerBucket?: number;
  maxPromptChars?: number;
}

interface MemoryFlushPayload {
  preferences?: unknown;
  constraints?: unknown;
  longTermNotes?: unknown;
}

const DEFAULT_MAX_ITEMS_PER_BUCKET = 12;
const DEFAULT_MAX_PROMPT_CHARS = 8_000;
const MAX_MEMORY_ITEM_CHARS = 500;

export class DefaultPreCompactionMemoryFlusher implements PreCompactionMemoryFlusher {
  private readonly gateway: LLMGateway;
  private readonly threadMemoryStore: ThreadMemoryStore;
  private readonly now: () => number;
  private readonly maxItemsPerBucket: number;
  private readonly maxPromptChars: number;

  constructor(options: DefaultPreCompactionMemoryFlusherOptions) {
    this.gateway = options.gateway;
    this.threadMemoryStore = options.threadMemoryStore;
    this.now = options.now ?? (() => Date.now());
    this.maxItemsPerBucket = options.maxItemsPerBucket ?? DEFAULT_MAX_ITEMS_PER_BUCKET;
    this.maxPromptChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  }

  async flush(input: {
    activation: RoleActivationInput;
    packet: RolePromptPacket;
    modelId?: string;
    modelChainId?: string;
    reason: "request_envelope_overflow";
    diagnostics?: RequestEnvelopeDiagnostics;
  }): Promise<PreCompactionMemoryFlushResult> {
    const existing = await this.threadMemoryStore.get(input.activation.thread.threadId);
    const generated = await this.gateway.generate(this.buildGatewayInput(input, existing));
    const payload = parseMemoryFlushPayload(generated.text);
    const structured = extractStructuredDurableMemory(input.packet.taskPrompt);
    const preferences = sanitizeMemoryItems(payload.preferences);
    const constraints = sanitizeMemoryItems([...(asUnknownArray(payload.constraints)), ...structured.constraints]);
    const longTermNotes = sanitizeMemoryItems([...(asUnknownArray(payload.longTermNotes)), ...structured.longTermNotes]);
    if (preferences.length === 0 && constraints.length === 0 && longTermNotes.length === 0) {
      return { status: "skipped", preferences: [], constraints: [], longTermNotes: [] };
    }
    const invalidation = buildMemoryInvalidation(
      [...preferences, ...constraints, ...longTermNotes],
      input.packet.taskPrompt
    );
    const prunedExisting = pruneSupersededMemory(existing, invalidation);

    const next: ThreadMemoryRecord = {
      threadId: input.activation.thread.threadId,
      updatedAt: this.now(),
      preferences: keepRecentUniqueStrings([...prunedExisting.preferences, ...preferences], this.maxItemsPerBucket),
      constraints: keepRecentUniqueStrings([...prunedExisting.constraints, ...constraints], this.maxItemsPerBucket),
      longTermNotes: keepRecentUniqueStrings([...prunedExisting.longTermNotes, ...longTermNotes], this.maxItemsPerBucket),
    };
    await this.threadMemoryStore.put(next);
    return {
      status: "written",
      preferences,
      constraints,
      longTermNotes,
    };
  }

  private buildGatewayInput(
    input: {
      activation: RoleActivationInput;
      packet: RolePromptPacket;
      modelId?: string;
      modelChainId?: string;
      reason: "request_envelope_overflow";
      diagnostics?: RequestEnvelopeDiagnostics;
    },
    existing: ThreadMemoryRecord | null
  ): GenerateTextInput {
    const taskPromptBudget = Math.max(1_000, Math.floor(this.maxPromptChars * 0.8));
    const systemPromptBudget = Math.max(500, this.maxPromptChars - taskPromptBudget);
    return {
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
      temperature: 0,
      maxOutputTokens: 800,
      metadata: {
        roleId: input.activation.runState.roleId,
        threadId: input.activation.thread.threadId,
        flowId: input.activation.flow.flowId,
        purpose: "pre_compaction_memory_flush",
      },
      envelope: {
        artifactIds: [],
        toolCount: 0,
        toolSchemaBytes: 0,
        toolResultCount: 0,
        toolResultBytes: 0,
      },
      messages: [
        {
          role: "system",
          content: [
            "You extract durable memory before a prompt is compacted.",
            "Return JSON only with keys preferences, constraints, longTermNotes.",
            "Each value must be an array of concise strings.",
            "Keep only durable user preferences, hard constraints, decisions, unresolved open items, and carry-forward facts.",
            "Do not invent facts. Return empty arrays when nothing durable is present.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Thread: ${input.activation.thread.threadId}`,
            `Role: ${input.activation.runState.roleId}`,
            `Reason: ${input.reason}`,
            input.diagnostics ? `Overflow keys: ${input.diagnostics.overLimitKeys.join(", ")}` : null,
            existing ? `Existing memory:\n${JSON.stringify(existing)}` : "Existing memory: none",
            "Task excerpt before compaction:",
            sliceForPrompt(input.packet.taskPrompt, taskPromptBudget),
            "System excerpt:",
            sliceForPrompt(input.packet.systemPrompt, systemPromptBudget),
            "Output contract:",
            sliceForPrompt(input.packet.outputContract, 1_000),
          ]
            .filter((line): line is string => line != null)
            .join("\n\n"),
        },
      ],
    };
  }
}

function parseMemoryFlushPayload(text: string): MemoryFlushPayload {
  const trimmed = text.trim();
  const candidates = [trimmed, extractJsonFence(trimmed), extractFirstJsonObject(trimmed)].filter(
    (value): value is string => Boolean(value)
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as MemoryFlushPayload;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

function extractJsonFence(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function sanitizeMemoryItems(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .map(cleanSupersededMemoryItem)
    .filter((item) => item.length > 0)
    .map((item) => sliceForPrompt(item, MAX_MEMORY_ITEM_CHARS));
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractStructuredDurableMemory(taskPrompt: string): { constraints: string[]; longTermNotes: string[] } {
  const selected = sliceForPrompt(taskPrompt, 12_000)
    .split(/\r?\n/)
    .map(normalizeDurableLine)
    .filter((line) => DURABLE_LINE_RE.test(line))
    .slice(0, 16);
  if (selected.length === 0) {
    return { constraints: [], longTermNotes: [] };
  }
  const subject = extractStructuredSubject(selected);
  const constraints = selected
    .filter((line) => DURABLE_CONSTRAINT_RE.test(line))
    .map((line) => addSubjectToStructuredLine(line, subject));
  return {
    constraints,
    longTermNotes: selected.length >= 2 ? [`Structured durable task facts: ${selected.join(" ")}`] : [],
  };
}

const DURABLE_LINE_RE =
  /^(?:project(?:\s+codename)?|codename|launch window|owner|hard constraint|constraint|residual risk|risk|decision|open question|waiting on|blocked by|deadline)\s*:/i;
const DURABLE_CONSTRAINT_RE = /^(?:hard constraint|constraint|residual risk|risk|waiting on|blocked by)\s*:/i;

function normalizeDurableLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ");
}

function extractStructuredSubject(lines: string[]): string | null {
  for (const line of lines) {
    const match = line.match(/^(?:project\s+codename|codename)\s*:\s*([A-Za-z][A-Za-z0-9_-]*)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function addSubjectToStructuredLine(line: string, subject: string | null): string {
  if (!subject || line.toLowerCase().includes(subject.toLowerCase())) {
    return line;
  }
  return `${subject} ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
}

interface MemoryInvalidation {
  subjects: Set<string>;
}

function buildMemoryInvalidation(incomingItems: string[], taskPrompt: string): MemoryInvalidation {
  const subjects = new Set<string>();
  for (const item of [...incomingItems, taskPrompt]) {
    if (!hasMemorySupersessionSignal(item)) {
      continue;
    }
    for (const subject of extractMemorySubjects(item)) {
      subjects.add(subject);
    }
  }
  return { subjects };
}

function pruneSupersededMemory(
  existingMemory: ThreadMemoryRecord | null,
  invalidation: MemoryInvalidation
): Pick<ThreadMemoryRecord, "preferences" | "constraints" | "longTermNotes"> {
  return {
    preferences: filterSupersededMemoryItems(existingMemory?.preferences ?? [], invalidation),
    constraints: filterSupersededMemoryItems(existingMemory?.constraints ?? [], invalidation),
    longTermNotes: filterSupersededMemoryItems(existingMemory?.longTermNotes ?? [], invalidation),
  };
}

function filterSupersededMemoryItems(values: string[], invalidation: MemoryInvalidation): string[] {
  if (invalidation.subjects.size === 0) {
    return values;
  }
  return values.filter((value) => {
    const subjects = extractMemorySubjects(value);
    return subjects.length === 0 || subjects.every((subject) => !invalidation.subjects.has(subject));
  });
}

function cleanSupersededMemoryItem(value: string): string {
  if (!hasMemorySupersessionSignal(value)) {
    return value;
  }
  return value
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(?:previous|prior|old|stale|no longer|must not be used)\b/i.test(sentence))
    .join(" ")
    .trim();
}

function hasMemorySupersessionSignal(value: string): boolean {
  return /\b(?:correction|corrected|update|updated|revised|replace|replaces|supersede|supersedes|stale|no longer|going forward|instead)\b/i.test(
    value
  );
}

function extractMemorySubjects(value: string): string[] {
  const subjects = new Set<string>();
  for (const match of value.matchAll(/\b[A-Z][A-Za-z0-9]+-\d+\b/g)) {
    subjects.add(match[0].toLowerCase());
  }
  for (const match of value.matchAll(/\b(?:project\s+codename|codename)\s*:\s*([A-Za-z][A-Za-z0-9_-]*)/gi)) {
    subjects.add(match[1]!.toLowerCase());
  }
  return [...subjects];
}

function keepRecentUniqueStrings(values: string[], limit: number): string[] {
  const recentToOldest = [...values.map((value) => value.trim()).filter(Boolean)].reverse();
  const deduped: string[] = [];
  for (const value of recentToOldest) {
    if (!deduped.includes(value)) {
      deduped.push(value);
    }
    if (deduped.length >= Math.max(limit, 1)) {
      break;
    }
  }
  return deduped.reverse();
}

function sliceForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(maxChars - 20, 1))}\n[truncated]`;
}

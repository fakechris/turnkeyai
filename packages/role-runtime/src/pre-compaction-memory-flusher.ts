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
    const preferences = sanitizeMemoryItems(payload.preferences);
    const constraints = sanitizeMemoryItems(payload.constraints);
    const longTermNotes = sanitizeMemoryItems(payload.longTermNotes);
    if (preferences.length === 0 && constraints.length === 0 && longTermNotes.length === 0) {
      return { status: "skipped", preferences: [], constraints: [], longTermNotes: [] };
    }

    const next: ThreadMemoryRecord = {
      threadId: input.activation.thread.threadId,
      updatedAt: this.now(),
      preferences: keepRecentUniqueStrings([...(existing?.preferences ?? []), ...preferences], this.maxItemsPerBucket),
      constraints: keepRecentUniqueStrings([...(existing?.constraints ?? []), ...constraints], this.maxItemsPerBucket),
      longTermNotes: keepRecentUniqueStrings([...(existing?.longTermNotes ?? []), ...longTermNotes], this.maxItemsPerBucket),
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
            "Prompt excerpt before compaction:",
            sliceForPrompt(
              [
                "System:",
                input.packet.systemPrompt,
                "",
                "Task:",
                input.packet.taskPrompt,
                "",
                "Output contract:",
                input.packet.outputContract,
              ].join("\n"),
              this.maxPromptChars
            ),
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
    .map((item) => sliceForPrompt(item, MAX_MEMORY_ITEM_CHARS));
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

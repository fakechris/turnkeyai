import { createHash } from "node:crypto";
import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

export const RUN_EFFECT_LEDGER_PROTOCOL = "turnkeyai.effect_ledger.v1" as const;
export const RUN_EFFECT_INDETERMINATE_PROTOCOL =
  "turnkeyai.effect_indeterminate.v1" as const;
export const RUN_EFFECT_NOT_DISPATCHED_PROTOCOL =
  "turnkeyai.effect_not_dispatched.v1" as const;

export type RunEffectStatus =
  | "admitted"
  | "started"
  | "committed"
  | "failed"
  | "indeterminate";

export interface RunEffectRecord {
  effectId: string;
  signature: string;
  round: number;
  call: LLMToolCall;
  status: RunEffectStatus;
  result?: ToolResult | undefined;
}

export interface RunEffectLedgerSnapshot {
  protocol: typeof RUN_EFFECT_LEDGER_PROTOCOL;
  records: RunEffectRecord[];
}

export interface RunEffectResumeResult {
  round: number;
  call: LLMToolCall;
  result: ToolResult;
}

export class RunEffectLedger {
  private readonly records = new Map<string, RunEffectRecord>();

  constructor(records: readonly RunEffectRecord[] = []) {
    for (const record of records) {
      this.records.set(record.effectId, structuredClone(record));
    }
  }

  admit(input: { round: number; call: LLMToolCall }): RunEffectRecord {
    const signature = effectSignature(input.call);
    const existing = this.records.get(input.call.id);
    if (existing) {
      if (existing.signature !== signature) {
        throw new Error(
          `effect id reused with a different proposal: ${input.call.id}`,
        );
      }
      return structuredClone(existing);
    }
    const record: RunEffectRecord = {
      effectId: input.call.id,
      signature,
      round: Math.max(0, Math.floor(input.round)),
      call: structuredClone(input.call),
      status: "admitted",
    };
    this.records.set(record.effectId, record);
    return structuredClone(record);
  }

  start(effectId: string): RunEffectRecord {
    const record = this.required(effectId);
    if (record.status === "started") return structuredClone(record);
    if (record.status !== "admitted") {
      throw new Error(
        `only an admitted effect can start: ${effectId}:${record.status}`,
      );
    }
    record.status = "started";
    return structuredClone(record);
  }

  recordResult(result: ToolResult): RunEffectRecord | null {
    const record = this.records.get(result.toolCallId);
    if (!record) return null;
    if (result.toolName !== record.call.name) {
      throw new Error(
        `effect receipt tool does not match proposal: ${record.effectId}`,
      );
    }
    if (record.status === "committed" || record.status === "failed") {
      if (
        record.result !== undefined &&
        JSON.stringify(record.result) !== JSON.stringify(result)
      ) {
        throw new Error(`effect receipt changed after commit: ${record.effectId}`);
      }
      return structuredClone(record);
    }
    if (record.status !== "started") {
      throw new Error(
        `only a started effect can record a receipt: ${record.effectId}:${record.status}`,
      );
    }
    record.status = result.isError || result.cancelled ? "failed" : "committed";
    record.result = structuredClone(result);
    return structuredClone(record);
  }

  reconcileForResume(existingResultIds: ReadonlySet<string>): RunEffectResumeResult[] {
    const results: RunEffectResumeResult[] = [];
    for (const record of this.records.values()) {
      if (existingResultIds.has(record.effectId)) continue;
      if (record.status === "committed" || record.status === "failed") {
        if (record.result) results.push(toResumeResult(record, record.result));
        continue;
      }
      if (record.status === "admitted") {
        const result = notDispatchedResult(record);
        record.status = "failed";
        record.result = structuredClone(result);
        results.push(toResumeResult(record, result));
        continue;
      }
      if (record.status === "started") {
        const result = indeterminateResult(record);
        record.status = "indeterminate";
        record.result = structuredClone(result);
        results.push(toResumeResult(record, result));
        continue;
      }
      if (record.status === "indeterminate" && record.result) {
        results.push(toResumeResult(record, record.result));
      }
    }
    return results;
  }

  releaseDurableResults(resultIds: ReadonlySet<string>): void {
    for (const effectId of resultIds) {
      const record = this.records.get(effectId);
      if (
        record &&
        (record.status === "committed" || record.status === "failed")
      ) {
        delete record.result;
      }
    }
  }

  snapshot(): RunEffectLedgerSnapshot {
    return {
      protocol: RUN_EFFECT_LEDGER_PROTOCOL,
      records: [...this.records.values()].map((record) => structuredClone(record)),
    };
  }

  private required(effectId: string): RunEffectRecord {
    const record = this.records.get(effectId);
    if (!record) throw new Error(`effect not admitted: ${effectId}`);
    return record;
  }
}

export function restoreRunEffectLedger(value: unknown): RunEffectLedger | null {
  if (!isRecord(value) || value["protocol"] !== RUN_EFFECT_LEDGER_PROTOCOL) {
    return null;
  }
  const records = value["records"];
  if (!Array.isArray(records)) return null;
  const parsed: RunEffectRecord[] = [];
  const effectIds = new Set<string>();
  for (const valueRecord of records) {
    const record = parseEffectRecord(valueRecord);
    if (!record) return null;
    if (effectIds.has(record.effectId)) return null;
    effectIds.add(record.effectId);
    parsed.push(record);
  }
  return new RunEffectLedger(parsed);
}

function parseEffectRecord(value: unknown): RunEffectRecord | null {
  if (
    !isRecord(value) ||
    typeof value["effectId"] !== "string" ||
    typeof value["signature"] !== "string" ||
    typeof value["round"] !== "number" ||
    !Number.isInteger(value["round"]) ||
    value["round"] < 0 ||
    !isRecord(value["call"]) ||
    typeof value["call"]["id"] !== "string" ||
    typeof value["call"]["name"] !== "string" ||
    !isRecord(value["call"]["input"]) ||
    !isRunEffectStatus(value["status"])
  ) {
    return null;
  }
  if (value["call"]["id"] !== value["effectId"]) return null;
  const result = value["result"];
  if (result !== undefined && !isToolResult(result)) return null;
  if (
    result !== undefined &&
    (result.toolCallId !== value["effectId"] ||
      result.toolName !== value["call"]["name"])
  ) {
    return null;
  }
  if (
    (value["status"] === "admitted" || value["status"] === "started") &&
    result !== undefined
  ) {
    return null;
  }
  if (value["status"] === "indeterminate" && result === undefined) return null;
  const parsed = {
    effectId: value["effectId"],
    signature: value["signature"],
    round: value["round"],
    call: {
      id: value["call"]["id"],
      name: value["call"]["name"],
      input: structuredClone(value["call"]["input"]),
    },
    status: value["status"],
    ...(result === undefined ? {} : { result: structuredClone(result) }),
  };
  return parsed.signature === effectSignature(parsed.call) ? parsed : null;
}

function effectSignature(call: LLMToolCall): string {
  return createHash("sha256")
    .update(stableJson({ name: call.name, input: call.input }))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function notDispatchedResult(record: RunEffectRecord): ToolResult {
  return {
    toolCallId: record.effectId,
    toolName: record.call.name,
    isError: true,
    content: JSON.stringify({
      protocol: RUN_EFFECT_NOT_DISPATCHED_PROTOCOL,
      code: "effect_admitted_but_not_dispatched",
      effect_id: record.effectId,
      tool_name: record.call.name,
      instruction:
        "No external dispatch started. A new explicit proposal may be admitted if the task still requires this work.",
    }),
  };
}

function indeterminateResult(record: RunEffectRecord): ToolResult {
  return {
    toolCallId: record.effectId,
    toolName: record.call.name,
    isError: true,
    content: JSON.stringify({
      protocol: RUN_EFFECT_INDETERMINATE_PROTOCOL,
      code: "effect_outcome_indeterminate_after_restart",
      effect_id: record.effectId,
      tool_name: record.call.name,
      instruction:
        "The effect may have executed, so it must not be dispatched again automatically. Reconcile by the stable effect id or request explicit operator action.",
    }),
  };
}

function toResumeResult(
  record: RunEffectRecord,
  result: ToolResult,
): RunEffectResumeResult {
  return {
    round: record.round,
    call: structuredClone(record.call),
    result: structuredClone(result),
  };
}

function isRunEffectStatus(value: unknown): value is RunEffectStatus {
  return value === "admitted" ||
    value === "started" ||
    value === "committed" ||
    value === "failed" ||
    value === "indeterminate";
}

function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value) &&
    typeof value["toolCallId"] === "string" &&
    typeof value["toolName"] === "string" &&
    typeof value["content"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

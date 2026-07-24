import type { LLMMessage } from "@turnkeyai/llm-adapter/index";
import { estimateTextTokens } from "@turnkeyai/llm-adapter/token-estimator";

import {
  buildHistoryProtocolUnits,
  type HistoryProtocolUnit,
} from "../tool-history-pruning";

export const CONTEXT_SOURCE_DIGEST_PROTOCOL =
  "turnkeyai.context_source_digest.v1" as const;

export interface ContextSourceGuardLimits {
  maxSourceMessages: number;
  maxSourceBytes: number;
  maxSourceTokens: number;
  recentProtocolUnits: number;
  maxDigestGroups: number;
  maxRepresentativeSamplesPerGroup: number;
  maxSampleChars: number;
}

export interface ContextSourceGuardSnapshot {
  protocolSafe: boolean;
  compacted: boolean;
  sourceMessageCount: number;
  sourceBytes: number;
  sourceTokens: number;
  guardedMessageCount: number;
  guardedBytes: number;
  guardedTokens: number;
  digestedMessageCount: number;
  digestedProtocolUnitCount: number;
  retainedProtocolUnitCount: number;
  digestGroupCount: number;
}

export interface GuardContextSourceResult {
  messages: LLMMessage[];
  snapshot: ContextSourceGuardSnapshot;
}

export const DEFAULT_CONTEXT_SOURCE_GUARD_LIMITS: ContextSourceGuardLimits = {
  maxSourceMessages: 4_000,
  maxSourceBytes: 8 * 1024 * 1024,
  maxSourceTokens: Number.MAX_SAFE_INTEGER,
  recentProtocolUnits: 4,
  maxDigestGroups: 100,
  maxRepresentativeSamplesPerGroup: 3,
  maxSampleChars: 240,
};

interface DigestGroup {
  key: string;
  count: number;
  messageCount: number;
  bytes: number;
  firstSample: string;
  lastSamples: string[];
}

/**
 * Bounds the model-facing source used to synthesize a context checkpoint.
 *
 * The raw transcript is not mutated. Complete protocol units are either kept
 * intact or represented inside one deterministic digest message. An unsafe
 * assistant/tool boundary fails closed and is returned unchanged so the
 * caller can skip model-driven compaction.
 */
export function guardContextCheckpointSource(
  messages: LLMMessage[],
  overrides: Partial<ContextSourceGuardLimits> = {},
): GuardContextSourceResult {
  const limits = normalizeLimits({
    ...DEFAULT_CONTEXT_SOURCE_GUARD_LIMITS,
    ...overrides,
  });
  const sourceBytes = serializedBytes(messages);
  const sourceTokens = serializedTokens(messages);
  const units = buildHistoryProtocolUnits(messages);
  const protocolSafe = units.every((unit) => unit.protocolSafe);
  const baseSnapshot = {
    protocolSafe,
    sourceMessageCount: messages.length,
    sourceBytes,
    sourceTokens,
  };

  if (!protocolSafe) {
    return {
      messages,
      snapshot: {
        ...baseSnapshot,
        compacted: false,
        guardedMessageCount: messages.length,
        guardedBytes: sourceBytes,
        guardedTokens: sourceTokens,
        digestedMessageCount: 0,
        digestedProtocolUnitCount: 0,
        retainedProtocolUnitCount: units.length,
        digestGroupCount: 0,
      },
    };
  }

  if (fits(messages, limits)) {
    return {
      messages,
      snapshot: {
        ...baseSnapshot,
        compacted: false,
        guardedMessageCount: messages.length,
        guardedBytes: sourceBytes,
        guardedTokens: sourceTokens,
        digestedMessageCount: 0,
        digestedProtocolUnitCount: 0,
        retainedProtocolUnitCount: units.length,
        digestGroupCount: 0,
      },
    };
  }

  const retained: HistoryProtocolUnit[] = [];
  const preferredRecentCount = Math.min(
    limits.recentProtocolUnits,
    units.length,
  );
  for (
    let index = units.length - 1;
    index >= units.length - preferredRecentCount;
    index -= 1
  ) {
    const unit = units[index];
    if (!unit) continue;
    retained.unshift(unit);
  }

  while (retained.length > 0) {
    const digestedCount = units.length - retained.length;
    const digest = buildDigestMessage(
      units.slice(0, digestedCount),
      limits,
    );
    const candidate = [
      ...(digestedCount > 0 ? [digest] : []),
      ...retained.flatMap((unit) => unit.messages),
    ];
    if (fits(candidate, limits)) {
      return buildCompactedResult({
        source: messages,
        units,
        candidate,
        digestedUnitCount: digestedCount,
        retainedUnitCount: retained.length,
        digestGroupCount: readDigestGroupCount(digest),
      });
    }
    retained.shift();
  }

  const digest = fitDigestMessageToLimits(
    buildDigestMessage(units, limits),
    limits,
  );
  return buildCompactedResult({
    source: messages,
    units,
    candidate: [digest],
    digestedUnitCount: units.length,
    retainedUnitCount: 0,
    digestGroupCount: readDigestGroupCount(digest),
  });
}

function buildCompactedResult(input: {
  source: LLMMessage[];
  units: HistoryProtocolUnit[];
  candidate: LLMMessage[];
  digestedUnitCount: number;
  retainedUnitCount: number;
  digestGroupCount: number;
}): GuardContextSourceResult {
  const guardedBytes = serializedBytes(input.candidate);
  const guardedTokens = serializedTokens(input.candidate);
  return {
    messages: input.candidate,
    snapshot: {
      protocolSafe: true,
      compacted: true,
      sourceMessageCount: input.source.length,
      sourceBytes: serializedBytes(input.source),
      sourceTokens: serializedTokens(input.source),
      guardedMessageCount: input.candidate.length,
      guardedBytes,
      guardedTokens,
      digestedMessageCount: input.units
        .slice(0, input.digestedUnitCount)
        .reduce((total, unit) => total + unit.messages.length, 0),
      digestedProtocolUnitCount: input.digestedUnitCount,
      retainedProtocolUnitCount: input.retainedUnitCount,
      digestGroupCount: input.digestGroupCount,
    },
  };
}

function buildDigestMessage(
  units: HistoryProtocolUnit[],
  limits: ContextSourceGuardLimits,
): LLMMessage {
  const groups = groupUnits(units, limits);
  const payload = {
    protocol: CONTEXT_SOURCE_DIGEST_PROTOCOL,
    source_protocol_units: units.length,
    source_messages: units.reduce(
      (total, unit) => total + unit.messages.length,
      0,
    ),
    groups: groups.slice(0, limits.maxDigestGroups).map((group) => ({
      key: group.key,
      count: group.count,
      message_count: group.messageCount,
      bytes: group.bytes,
      samples: [
        group.firstSample,
        ...group.lastSamples.filter(
          (sample) => sample !== group.firstSample,
        ),
      ].slice(0, limits.maxRepresentativeSamplesPerGroup),
    })),
    omitted_group_count: Math.max(
      groups.length - limits.maxDigestGroups,
      0,
    ),
    instruction:
      "This is a deterministic source digest, not a new user request. Preserve it as historical evidence only.",
  };
  return {
    role: "user",
    content: JSON.stringify(payload),
  };
}

function fitDigestMessageToLimits(
  message: LLMMessage,
  limits: ContextSourceGuardLimits,
): LLMMessage {
  if (fits([message], limits)) return message;
  const content =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  let low = 1;
  let high = content.length;
  let best = "";
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate: LLMMessage = {
      role: "user",
      content: content.slice(0, midpoint),
    };
    if (fits([candidate], limits)) {
      best = candidate.content as string;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return {
    role: "user",
    content:
      best ||
      JSON.stringify({
        protocol: CONTEXT_SOURCE_DIGEST_PROTOCOL,
        truncated: true,
      }).slice(0, Math.max(limits.maxSourceBytes, 1)),
  };
}

function groupUnits(
  units: HistoryProtocolUnit[],
  limits: ContextSourceGuardLimits,
): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();
  for (const unit of units) {
    const key = unitKey(unit);
    const sample = unitSample(unit, limits.maxSampleChars);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        key,
        count: 1,
        messageCount: unit.messages.length,
        bytes: serializedBytes(unit.messages),
        firstSample: sample,
        lastSamples: [sample],
      });
      continue;
    }
    current.count += 1;
    current.messageCount += unit.messages.length;
    current.bytes += serializedBytes(unit.messages);
    current.lastSamples.push(sample);
    current.lastSamples = current.lastSamples.slice(
      -Math.max(limits.maxRepresentativeSamplesPerGroup - 1, 1),
    );
  }
  return [...groups.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function unitKey(unit: HistoryProtocolUnit): string {
  const roles = unit.messages.map((message) => message.role).join(">");
  const toolNames = unit.messages
    .flatMap((message) => {
      const names = message.name ? [message.name] : [];
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return names;
      }
      return [
        ...names,
        ...message.content
          .filter((block) => block.type === "tool_use")
          .map((block) => block.name),
      ];
    })
    .sort();
  const errorCount = unit.messages.filter((message) =>
    message.role === "tool" &&
    typeof message.content === "string" &&
    /(?:is_?error|error|failed|timeout)/i.test(message.content),
  ).length;
  return [
    `roles=${roles}`,
    `tools=${toolNames.join(",") || "none"}`,
    `errors=${errorCount}`,
  ].join(";");
}

function unitSample(unit: HistoryProtocolUnit, maxChars: number): string {
  const serialized = JSON.stringify(unit.messages);
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, Math.max(maxChars - 1, 1))}…`;
}

function readDigestGroupCount(message: LLMMessage): number {
  if (typeof message.content !== "string") return 0;
  try {
    const parsed = JSON.parse(message.content) as { groups?: unknown };
    return Array.isArray(parsed.groups) ? parsed.groups.length : 0;
  } catch {
    return 0;
  }
}

function normalizeLimits(
  limits: ContextSourceGuardLimits,
): ContextSourceGuardLimits {
  return {
    maxSourceMessages: positiveInteger(limits.maxSourceMessages),
    maxSourceBytes: positiveInteger(limits.maxSourceBytes),
    maxSourceTokens: positiveInteger(limits.maxSourceTokens),
    recentProtocolUnits: nonNegativeInteger(limits.recentProtocolUnits),
    maxDigestGroups: positiveInteger(limits.maxDigestGroups),
    maxRepresentativeSamplesPerGroup: positiveInteger(
      limits.maxRepresentativeSamplesPerGroup,
    ),
    maxSampleChars: positiveInteger(limits.maxSampleChars),
  };
}

function fits(
  messages: LLMMessage[],
  limits: ContextSourceGuardLimits,
): boolean {
  return messages.length <= limits.maxSourceMessages &&
    serializedBytes(messages) <= limits.maxSourceBytes &&
    serializedTokens(messages) <= limits.maxSourceTokens;
}

function serializedBytes(messages: LLMMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function serializedTokens(messages: LLMMessage[]): number {
  return estimateTextTokens(JSON.stringify(messages));
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value));
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

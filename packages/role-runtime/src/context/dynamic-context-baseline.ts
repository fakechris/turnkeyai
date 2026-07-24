import { createHash } from "node:crypto";

import {
  DYNAMIC_CONTEXT_BASELINE_PROTOCOL,
  type ContextSectionReceipt,
  type DynamicContextBaseline,
  type DynamicContextScope,
} from "@turnkeyai/core-types/dynamic-context-baseline";
import type {
  LLMMessage,
  LLMToolDefinition,
} from "@turnkeyai/llm-adapter/index";
import { estimateTextTokens } from "@turnkeyai/llm-adapter/token-estimator";

import type { RolePromptPacket } from "../prompt-policy";

export const DYNAMIC_CONTEXT_MESSAGE_PROTOCOL =
  "turnkeyai.dynamic_context.v1" as const;
export const ROLE_PROMPT_PACK_VERSION =
  "turnkeyai.role_prompt_pack.v2" as const;

export interface DynamicContextSnapshot {
  baseline: DynamicContextBaseline;
  sections: Array<{
    receipt: ContextSectionReceipt;
    content?: string;
  }>;
}

export interface DynamicContextPreparation {
  mode: "full" | "delta" | "unchanged";
  reason:
    | "initial"
    | "forced"
    | "baseline_incompatible"
    | "sections_changed"
    | "unchanged";
  baseline: DynamicContextBaseline;
  message?: LLMMessage;
  changedSections: string[];
  invalidatedSections: string[];
}

export function buildDynamicContextSnapshot(input: {
  scope: DynamicContextScope;
  packet: RolePromptPacket;
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  tools?: LLMToolDefinition[];
  now: number;
  promptPackVersion?: string;
}): DynamicContextSnapshot {
  const promptPackVersion =
    input.promptPackVersion ?? ROLE_PROMPT_PACK_VERSION;
  const modelFingerprint = digest({
    modelId: input.selection.modelId ?? null,
    modelChainId: input.selection.modelChainId ?? null,
  });
  const toolFingerprint = digest(
    (input.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  );
  const sourceRefs =
    input.packet.promptAssembly?.sectionReceipts
      ?.filter((receipt) => receipt.state !== "omitted")
      .map((receipt) => `${receipt.sectionId}@${receipt.version}`) ??
    input.packet.promptAssembly?.sectionOrder ??
    [];
  const sections: DynamicContextSnapshot["sections"] = [
    runtimeSection({
      name: "system-prompt",
      content: input.packet.systemPrompt,
      sourceRefs: ["role-profile", "tool-harness"],
      now: input.now,
    }),
    runtimeSection({
      name: "task-prompt",
      content: input.packet.taskPrompt,
      sourceRefs,
      now: input.now,
    }),
    runtimeSection({
      name: "output-contract",
      content: input.packet.outputContract,
      sourceRefs: ["role-output-contract"],
      now: input.now,
    }),
    ...(input.packet.promptAssembly?.omittedSegments ?? []).map(
      (omitted) => ({
        receipt: {
          name: `prompt-segment:${omitted.segment}`,
          version: "1",
          digest: digest({
            omitted: true,
            reason: omitted.reason,
          }),
          sourceRefs: [`omission:${omitted.reason}`],
          packedTokens: 0,
          omitted: true,
          updatedAt: input.now,
        },
      }),
    ),
  ].sort((left, right) =>
    left.receipt.name.localeCompare(right.receipt.name)
  );
  const receipts = sections.map((section) => section.receipt);
  const baselineId = `dynamic-context:${digest({
    scope: input.scope,
    promptPackVersion,
    modelFingerprint,
    toolFingerprint,
    sections: receipts.map((receipt) => ({
      name: receipt.name,
      version: receipt.version,
      digest: receipt.digest,
      omitted: receipt.omitted,
    })),
  }).slice(0, 24)}`;
  return {
    baseline: {
      protocol: DYNAMIC_CONTEXT_BASELINE_PROTOCOL,
      baselineId,
      scope: structuredClone(input.scope),
      promptPackVersion,
      modelFingerprint,
      toolFingerprint,
      sections: receipts,
      activatedAt: input.now,
    },
    sections,
  };
}

export function prepareDynamicContext(input: {
  previous: DynamicContextBaseline | null;
  current: DynamicContextSnapshot;
  forceFull?: boolean;
}): DynamicContextPreparation {
  const previous = input.previous;
  const incompatible = previous
    ? previous.promptPackVersion !==
        input.current.baseline.promptPackVersion ||
      previous.modelFingerprint !==
        input.current.baseline.modelFingerprint ||
      previous.toolFingerprint !==
        input.current.baseline.toolFingerprint
    : false;
  if (input.forceFull || !previous || incompatible) {
    return {
      mode: "full",
      reason: input.forceFull
        ? "forced"
        : previous
          ? "baseline_incompatible"
          : "initial",
      baseline: input.current.baseline,
      message: buildDynamicContextMessage(
        "full",
        input.current.sections,
        input.current.baseline,
      ),
      changedSections: input.current.sections
        .filter((section) => !section.receipt.omitted)
        .map((section) => section.receipt.name),
      invalidatedSections: input.current.sections
        .filter((section) => section.receipt.omitted)
        .map((section) => section.receipt.name),
    };
  }

  const previousByName = new Map(
    previous.sections.map((section) => [section.name, section]),
  );
  const changed = input.current.sections.filter((section) => {
    const prior = previousByName.get(section.receipt.name);
    return !prior ||
      prior.version !== section.receipt.version ||
      prior.digest !== section.receipt.digest ||
      prior.omitted !== section.receipt.omitted;
  });
  const currentNames = new Set(
    input.current.sections.map((section) => section.receipt.name),
  );
  const removed = previous.sections
    .filter((section) => !currentNames.has(section.name))
    .map((section) => ({
      receipt: {
        ...section,
        digest: digest({ removed: true, priorDigest: section.digest }),
        packedTokens: 0,
        omitted: true,
        updatedAt: input.current.baseline.activatedAt,
      },
    }));
  const delta = [...changed, ...removed].sort((left, right) =>
    left.receipt.name.localeCompare(right.receipt.name)
  );
  if (delta.length === 0) {
    return {
      mode: "unchanged",
      reason: "unchanged",
      baseline: input.current.baseline,
      changedSections: [],
      invalidatedSections: [],
    };
  }
  return {
    mode: "delta",
    reason: "sections_changed",
    baseline: input.current.baseline,
    message: buildDynamicContextMessage(
      "delta",
      delta,
      input.current.baseline,
    ),
    changedSections: delta
      .filter((section) => !section.receipt.omitted)
      .map((section) => section.receipt.name),
    invalidatedSections: delta
      .filter((section) => section.receipt.omitted)
      .map((section) => section.receipt.name),
  };
}

export function buildFullDynamicContextMessage(
  snapshot: DynamicContextSnapshot,
): LLMMessage {
  return buildDynamicContextMessage(
    "full",
    snapshot.sections,
    snapshot.baseline,
  );
}

function runtimeSection(input: {
  name: string;
  content: string;
  sourceRefs: string[];
  now: number;
}): DynamicContextSnapshot["sections"][number] {
  return {
    receipt: {
      name: input.name,
      version: "1",
      digest: digest(input.content),
      sourceRefs: [...input.sourceRefs],
      packedTokens: estimateTextTokens(input.content),
      omitted: false,
      updatedAt: input.now,
    },
    content: input.content,
  };
}

function buildDynamicContextMessage(
  mode: "full" | "delta",
  sections: DynamicContextSnapshot["sections"],
  baseline: DynamicContextBaseline,
): LLMMessage {
  const payload = {
    protocol: DYNAMIC_CONTEXT_MESSAGE_PROTOCOL,
    mode,
    baselineId: baseline.baselineId,
    sections: sections.map((section) => ({
      name: section.receipt.name,
      version: section.receipt.version,
      digest: section.receipt.digest,
      omitted: section.receipt.omitted,
      sourceRefs: section.receipt.sourceRefs,
      ...(section.receipt.omitted
        ? {}
        : { content: section.content ?? "" }),
    })),
    instruction:
      mode === "full"
        ? "This is the current full runtime context after a context discontinuity. It replaces older dynamic context with the same section names."
        : "This is a runtime context delta. Replace or invalidate only the named sections; retain other sections from the current conversation.",
  };
  return {
    role: "user",
    content: `TurnkeyAI dynamic context ${mode} v1\n${JSON.stringify(payload)}`,
  };
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      typeof value === "string"
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
}

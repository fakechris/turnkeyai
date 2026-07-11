import type { GenerateTextInput } from "@turnkeyai/llm-adapter/index";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";

import {
  attachRunLifecycleToGatewayInput,
} from "../gateway-envelope-retry";
import {
  appendModelCallBoundary,
  type ModelCallBoundaryTrace,
} from "../model-call-trace";

import type {
  RuntimeCheckpointDraft,
  RuntimeCheckpointSummaryInput,
} from "./compaction-controller";
import type { RunLifecycleRecorder } from "./run-lifecycle";

export interface CreateRuntimeCheckpointSummarizerInput {
  gateway: Pick<LLMGateway, "generate">;
  selection: Pick<GenerateTextInput, "modelId" | "modelChainId">;
  metadata: {
    roleId: string;
    threadId: string;
    flowId: string;
  };
  modelCallTrace?: ModelCallBoundaryTrace[];
  lifecycle?: RunLifecycleRecorder | undefined;
  now?: () => number;
}

export function createRuntimeCheckpointSummarizer(
  input: CreateRuntimeCheckpointSummarizerInput,
): (
  summaryInput: RuntimeCheckpointSummaryInput,
) => Promise<RuntimeCheckpointDraft> {
  return async (summaryInput) => {
    const gatewayInput: GenerateTextInput = {
      ...input.selection,
      ...(summaryInput.signal ? { signal: summaryInput.signal } : {}),
      temperature: 0,
      maxOutputTokens: 2_000,
      toolChoice: "none",
      metadata: {
        ...input.metadata,
        purpose: "runtime_checkpoint_compaction",
        round: summaryInput.round,
      },
      messages: [
        {
          role: "system",
          content: [
            "You compact an agent tool loop into a durable runtime checkpoint.",
            "Return one JSON object only. Do not use markdown.",
            "Required keys: task, summary, decisions, evidence, artifacts, openQuestions, planState.",
            "task and summary are strings. Every other key is an array of concise strings.",
            "Preserve concrete evidence, URLs, artifact identifiers, decisions, unresolved questions, and next actions.",
            "Merge the previous checkpoint when supplied. Do not invent or strengthen claims.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Task:\n${summaryInput.taskPrompt}`,
            summaryInput.previousCheckpoint
              ? `Previous checkpoint:\n${JSON.stringify(summaryInput.previousCheckpoint)}`
              : "Previous checkpoint: none",
            summaryInput.planStateSnapshot?.length
              ? `Authoritative task plan snapshot (copy into planState unchanged):\n${JSON.stringify(summaryInput.planStateSnapshot)}`
              : "Authoritative task plan snapshot: none",
            `Older loop history to compact:\n${JSON.stringify(summaryInput.messages)}`,
          ].join("\n\n"),
        },
      ],
    };
    const startedAt = input.now?.() ?? Date.now();
    const generated = await input.gateway.generate(
      attachRunLifecycleToGatewayInput({
        gatewayInput,
        lifecycle: input.lifecycle,
        phase: "checkpoint_compaction",
        round: summaryInput.round,
      }),
    );
    appendModelCallBoundary(input.modelCallTrace, {
      phase: "checkpoint_compaction",
      round: summaryInput.round,
      startedAt,
      completedAt: input.now?.() ?? Date.now(),
      gatewayInput,
      result: generated,
    });

    return parseRuntimeCheckpointDraft(generated.text);
  };
}

export function parseRuntimeCheckpointDraft(
  text: string,
): RuntimeCheckpointDraft {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!isRuntimeCheckpointDraft(parsed)) {
        continue;
      }
      return {
        ...(typeof parsed["task"] === "string"
          ? { task: parsed["task"] }
          : {}),
        summary: parsed["summary"],
        decisions: parsed["decisions"],
        evidence: parsed["evidence"],
        artifacts: parsed["artifacts"],
        openQuestions: parsed["openQuestions"],
        planState: parsed["planState"],
      };
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  throw new Error("invalid_runtime_checkpoint_summary");
}

function isRuntimeCheckpointDraft(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RuntimeCheckpointDraft {
  return (
    typeof value["summary"] === "string" &&
    value["summary"].trim().length > 0 &&
    isStringArray(value["decisions"]) &&
    isStringArray(value["evidence"]) &&
    isStringArray(value["artifacts"]) &&
    isStringArray(value["openQuestions"]) &&
    isStringArray(value["planState"])
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const object = start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
  return [...new Set([trimmed, fence, object].filter((value): value is string => Boolean(value)))];
}

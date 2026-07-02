import type { RoleActivationInput, RoleId } from "@turnkeyai/core-types/team";
import type {
  GenerateTextInput,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { RolePromptPacket } from "./prompt-policy";
import {
  escapeRegExp,
  inferRequiredFinalSynthesisDeliverables,
  requestsStatusVisibleTextEvidenceUrlLines,
  type SessionContinuationDirective,
} from "./tool-loop-shared";
import {
  requestedTableColumnMessageContext,
  resolveRequestedTableColumns,
} from "./task-facts-shared";

export function buildGatewayInput(input: {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  modelId?: string;
  modelChainId?: string;
  signal?: AbortSignal;
  overrideSystemPrompt?: string;
  overrideTaskPrompt?: string;
  artifactIds?: string[];
  envelopeHint?: {
    toolResultCount?: number;
    toolResultBytes?: number;
    inlineAttachmentBytes?: number;
    inlineImageCount?: number;
    inlineImageBytes?: number;
    inlinePdfCount?: number;
    inlinePdfBytes?: number;
    multimodalPartCount?: number;
  };
  tools?: GenerateTextInput["tools"];
  toolChoice?: GenerateTextInput["toolChoice"];
  sessionContinuationDirective?: SessionContinuationDirective;
}): GenerateTextInput {
  const runtimeDirective = input.sessionContinuationDirective
    ? [
        "",
        "Runtime session continuation directive:",
        `A resumable sub-agent session is available: ${input.sessionContinuationDirective.sessionKey}.`,
        "If this turn continues, resumes, retries, or revisits the same delegated work, call sessions_send with that session_key as the first and only tool call for that continuation attempt.",
        "Do not call memory_search, sessions_history, sessions_list, or sessions_spawn before that sessions_send; the runtime already selected the resumable session.",
        "Spawn a new session only on a later turn if the user asks for a new independent task or the existing session is clearly irrelevant.",
        `Continuation message hint: ${input.sessionContinuationDirective.messageHint}`,
      ].join("\n")
    : "";
  return {
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    messages: [
      {
        role: "system" as const,
        content: input.overrideSystemPrompt ?? input.packet.systemPrompt,
      },
      {
        role: "user" as const,
        content: [
          input.overrideTaskPrompt ?? input.packet.taskPrompt,
          runtimeDirective,
          "",
          "Output contract:",
          input.packet.outputContract,
        ].join("\n"),
      },
    ],
    metadata: {
      roleId: input.activation.runState.roleId,
      threadId: input.activation.thread.threadId,
      flowId: input.activation.flow.flowId,
    },
    envelope: {
      artifactIds:
        input.artifactIds ?? input.packet.promptAssembly?.usedArtifacts ?? [],
      toolCount: input.tools?.length ?? 0,
      toolSchemaBytes: input.tools
        ? Buffer.byteLength(JSON.stringify(input.tools), "utf8")
        : 0,
      toolResultCount:
        input.envelopeHint?.toolResultCount ??
        input.packet.promptAssembly?.envelopeHint?.toolResultCount ??
        0,
      toolResultBytes:
        input.envelopeHint?.toolResultBytes ??
        input.packet.promptAssembly?.envelopeHint?.toolResultBytes ??
        0,
      inlineAttachmentBytes:
        input.envelopeHint?.inlineAttachmentBytes ??
        input.packet.promptAssembly?.envelopeHint?.inlineAttachmentBytes ??
        0,
      inlineImageCount:
        input.envelopeHint?.inlineImageCount ??
        input.packet.promptAssembly?.envelopeHint?.inlineImageCount ??
        0,
      inlineImageBytes:
        input.envelopeHint?.inlineImageBytes ??
        input.packet.promptAssembly?.envelopeHint?.inlineImageBytes ??
        0,
      inlinePdfCount:
        input.envelopeHint?.inlinePdfCount ??
        input.packet.promptAssembly?.envelopeHint?.inlinePdfCount ??
        0,
      inlinePdfBytes:
        input.envelopeHint?.inlinePdfBytes ??
        input.packet.promptAssembly?.envelopeHint?.inlinePdfBytes ??
        0,
      multimodalPartCount:
        input.envelopeHint?.multimodalPartCount ??
        input.packet.promptAssembly?.envelopeHint?.multimodalPartCount ??
        0,
    },
  };
}

export function finalSynthesisFormatContract(
  taskPrompt?: string,
  messages: LLMMessage[] = [],
): string[] {
  const requiredDeliverables = inferRequiredFinalSynthesisDeliverables(
    taskPrompt ?? "",
  );
  const requestedTableColumns = resolveRequestedTableColumns([
    taskPrompt ?? "",
    ...requestedTableColumnMessageContext(messages),
  ]);
  return [
    "Final synthesis format contract:",
    "Review the original user/task request for any explicit final answer shape before writing.",
    "If the task specifies a heading, bullet count, bullet labels, order, table/no-table rule, link/no-link rule, or forbidden markup, follow those format constraints exactly.",
    "If the task says a line must start with a literal prefix such as `- recommendation:`, that exact prefix must be at the beginning of its own line.",
    "If a success marker or required phrase is assigned to a bullet, place it in that bullet only; do not move it into a paragraph, heading, preamble, or closing note.",
    "When links are forbidden, do not include Markdown links or bare http:// / https:// URLs, even if tool results contain internal fetch URLs.",
    "Do not write a preamble before a requested final shape.",
    "Do not write status preambles such as 'All tool calls returned' or 'Producing the final answer'.",
    "For exact-skeleton answers, keep each requested bullet compact, usually one sentence, while preserving required markers, facts, and residual risk.",
    "Do not collapse requested bullets into a paragraph. Do not add extra sections, summaries, notes, or prose after an exact requested shape.",
    "If any user or task message requested a table with named columns, preserve those requested columns in the table. Do not satisfy a requested table column by moving it into prose below the table; keep the column and fill missing cells with not verified/未验证.",
    ...(requestedTableColumns.length
      ? [
          `Exact requested table columns detected: ${requestedTableColumns.join(" | ")}`,
          "The final table header must include every detected column label above without renaming, merging, or moving that column into prose. Extra columns are allowed only if they do not replace the requested ones.",
        ]
      : []),
    ...(requiredDeliverables.length
      ? [
          "Required final deliverables inferred from the original task:",
          ...requiredDeliverables.map(
            (deliverable, index) => `${index + 1}. ${deliverable.instruction}`,
          ),
          "Before finalizing, verify every required deliverable above is present in the answer. If any required deliverable is missing, rewrite the answer instead of closing.",
        ]
      : []),
    "Evidence synthesis contract:",
    "Unless the original task's exact output shape forbids extra labels, include concise verified evidence, unverified scope or residual risk, and the recommendation or next action.",
    "When delegated Source N evidence blocks are provided, cover every source in the final answer. Preserve source-specific facts such as counts, rates, owners, URLs, screenshots, artifacts, approvals, and limitations.",
    "For research or comparison tasks, include a compact verified sources/evidence line unless the user explicitly forbids source labels; name each source and the exact fact(s) it verified.",
    "Source evidence may include tables or headers created by a sub-agent. Do not copy a source table's shape, headers, or unrelated dimensions unless the original user/task request asked for that table shape or those named columns.",
    "Do not promote a source's partial, missing, timed-out, blocked, or unverified observation into a confirmed claim. Mark missing dimensions as not verified.",
    "For approval-gated or mutating work, state what was approved, what was applied, what evidence changed after the action, and what residual risk or no-external-side-effect boundary remains.",
  ];
}

export function withoutToolUse(input: GenerateTextInput): GenerateTextInput {
  const { tools: _tools, toolChoice: _toolChoice, ...rest } = input;
  return {
    ...rest,
    toolChoice: "none",
  };
}

export function extractMentions(content: string): RoleId[] {
  return [...content.matchAll(/@\{(?<roleId>[^}]+)\}/g)]
    .map((match) => match.groups?.roleId)
    .filter((value): value is RoleId => Boolean(value));
}

export function enforceRequestedThreeLineLabelShape(input: {
  taskPrompt: string;
  resultText: string;
}): string {
  if (!requestsStatusVisibleTextEvidenceUrlLines(input.taskPrompt)) {
    return input.resultText;
  }
  const lines = input.resultText
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 3) {
    return input.resultText;
  }
  const labels = ["状态", "最终可见文本", "证据 URL"] as const;
  return lines
    .map((line, index) => {
      const label = labels[index]!;
      return normalizeRequestedThreeLineLabel(line, label);
    })
    .join("\n");
}

export function hasToolDefinition(
  tools: GenerateTextInput["tools"] | undefined,
  name: string,
): boolean {
  return (tools ?? []).some((tool) => tool.name === name);
}

function normalizeRequestedThreeLineLabel(line: string, label: string): string {
  const labelPattern = escapeRegExp(label).replace(/\s+/g, "\\s*");
  const leadingLabel = new RegExp(
    `^\\s*(?:\\*\\*)?\\s*${labelPattern}\\s*[:：]\\s*(?:\\*\\*)?\\s*`,
    "i",
  );
  const value = line.replace(leadingLabel, "").trim();
  return `${label}: ${value || line}`;
}

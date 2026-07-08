import type { ReActReArm } from "@turnkeyai/agent-core/react-loop";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import { dedupeStrings } from "../tool-protocol";
import {
  maybeAppendBrowserFailureBucketVisibility,
  maybeAppendBrowserRecoveryVisibility,
  maybeAppendDashboardEscalationActionVisibility,
  maybeAppendRecoveredTimeoutCloseoutVisibility,
  maybeAppendTimeoutContinuationVisibility,
  maybeRedactForbiddenLocalUrls,
  shouldAppendRecoveredTimeoutCloseoutVisibility,
  shouldAppendTimeoutContinuationVisibility,
} from "../runtime-policy/synthesis-visibility";
import { shouldPreserveRecoveredTimeoutCloseout } from "../runtime-facts/text-fallback-readers";
import { readRuntimeBrowserSummariesFromTrace } from "../runtime-facts/browser-recovery-summary-producer";
import { buildLocalEvidenceCloseout } from "../runtime-policy/prompt-renderers";
import { recordRepairPrompt } from "../task-facts-shared";
import {
  createRepairPolicyRegistry,
  type RepairPolicyRegistry,
} from "./repair-policy-registry";
import { buildEvidenceSnapshot } from "./evidence-ledger";

// Stage 8 engine cleanup — CompletedCloseoutController.
//
// Authority: own the completed-session repair loop that runs after terminal
// completed-session synthesis, including completed-only repair round gating,
// real tool-round re-arm message construction, repair marker insertion, and the
// final clean synthesis when a repair produces tool-call artifact text. It also
// owns the completed-closeout post-synthesis visibility appender chain.
//
// It does not own ordinary tool execution, the normalizer pipeline, or model
// gateway calls. Those remain injected or adapter-owned while the inline path is
// still the parity reference.
export const COMPLETED_CLOSEOUT_CONTROLLER_MODULE =
  "completed-closeout-controller" as const;

export const MAX_COMPLETED_CLOSEOUT_REPAIR_ROUNDS = 16;

const TABLE_OR_SCHEMA_REPAIR_POLICIES = [
  "missing_requested_table_columns",
  "extraneous_provider_table_schema",
] as const;

export interface CompletedCloseoutSynthesis<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  result: GenerateTextResult;
  reduction?: TReduction;
  reductionSnapshot?: TReductionSnapshot;
  memoryFlush?: TMemoryFlush;
}

export interface CompletedCloseoutRepairLoopInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  activation?: RoleActivationInput;
  packet?: RolePromptPacket;
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  repairMessages: LLMMessage[];
  repairMarkers: LLMMessage[];
  completedSessionFinalContents: readonly string[];
  completedEvidenceText: string;
  delegatedEvidenceText: string;
  initialResult: GenerateTextResult;
  initialReduction?: TReduction;
  initialReductionSnapshot?: TReductionSnapshot;
  tools?: readonly { name: string }[];
  repairPolicy?: RepairPolicyRegistry;
  synthesizeRepair(input: {
    messages: LLMMessage[];
  }): Promise<CompletedCloseoutSynthesis<TReduction, TReductionSnapshot, TMemoryFlush>>;
  synthesizeToolCallArtifactCleanup(input: {
    messages: LLMMessage[];
  }): Promise<CompletedCloseoutSynthesis<TReduction, TReductionSnapshot, TMemoryFlush>>;
}

export type CompletedCloseoutRepairLoopResult<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> =
  | ({
      kind: "final";
      result: GenerateTextResult;
      repairMessages: LLMMessage[];
      memoryFlushes: TMemoryFlush[];
    } & OptionalReduction<TReduction, TReductionSnapshot>)
  | ({
      kind: "rearm";
      reArm: ReActReArm;
      memoryFlushes: TMemoryFlush[];
    } & OptionalReduction<TReduction, TReductionSnapshot>);

export interface CompletedCloseoutVisibilitySession {
  finalContents: readonly string[];
  browserRecoverySummaries: readonly string[];
}

export interface CompletedCloseoutVisibilityInput {
  packet: RolePromptPacket;
  result: GenerateTextResult;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  completedSession?: CompletedCloseoutVisibilitySession | null;
  completedSessionToolResultText: string;
}

export interface CompletedCloseoutTerminalInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  activation?: RoleActivationInput;
  packet: RolePromptPacket;
  toolTrace: NativeToolRoundTrace[];
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  completedSession: CompletedCloseoutVisibilitySession;
  completedSessionToolResultText: string;
  initialSynthesis: CompletedCloseoutSynthesis<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  >;
  tools?: readonly { name: string }[];
  repairPolicy?: RepairPolicyRegistry;
  synthesizeRepair(input: {
    messages: LLMMessage[];
  }): Promise<CompletedCloseoutSynthesis<TReduction, TReductionSnapshot, TMemoryFlush>>;
  synthesizeToolCallArtifactCleanup(input: {
    messages: LLMMessage[];
  }): Promise<CompletedCloseoutSynthesis<TReduction, TReductionSnapshot, TMemoryFlush>>;
}

export type CompletedCloseoutTerminalResult<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> =
  | ({
      kind: "final";
      result: GenerateTextResult;
      memoryFlushes: TMemoryFlush[];
    } & OptionalReduction<TReduction, TReductionSnapshot>)
  | ({
      kind: "rearm";
      reArm: ReActReArm;
      memoryFlushes: TMemoryFlush[];
    } & OptionalReduction<TReduction, TReductionSnapshot>);

type OptionalReduction<TReduction, TReductionSnapshot> = {
  reduction?: TReduction;
  reductionSnapshot?: TReductionSnapshot;
};

export class CompletedCloseoutController {
  async synthesizeTerminalCloseout<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: CompletedCloseoutTerminalInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): Promise<
    CompletedCloseoutTerminalResult<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >
  > {
    const memoryFlushes: TMemoryFlush[] = [];
    appendMemoryFlush(memoryFlushes, input.initialSynthesis.memoryFlush);

    const delegatedEvidenceText =
      input.completedSession.finalContents.join("\n\n");
    // Inline completed closeout used the delegated final text alone for some
    // predicates, and final text plus raw completing-round tool text for source
    // carry-forward and timeout guidance. Keep that asymmetry in this owner.
    const completedEvidenceText = [
      delegatedEvidenceText,
      input.completedSessionToolResultText,
    ]
      .filter((text) => text.trim().length > 0)
      .join("\n\n");

    const repairLoopResult = await this.runRepairLoop({
      ...(input.activation ? { activation: input.activation } : {}),
      packet: input.packet,
      taskPrompt: input.packet.taskPrompt,
      toolTrace: input.toolTrace,
      repairMessages: input.messages,
      repairMarkers: input.repairMarkers,
      completedSessionFinalContents: input.completedSession.finalContents,
      completedEvidenceText,
      delegatedEvidenceText,
      initialResult: input.initialSynthesis.result,
      ...(input.initialSynthesis.reduction !== undefined
        ? { initialReduction: input.initialSynthesis.reduction }
        : {}),
      ...(input.initialSynthesis.reductionSnapshot !== undefined
        ? { initialReductionSnapshot: input.initialSynthesis.reductionSnapshot }
        : {}),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.repairPolicy === undefined
        ? {}
        : { repairPolicy: input.repairPolicy }),
      synthesizeRepair: input.synthesizeRepair,
      synthesizeToolCallArtifactCleanup: input.synthesizeToolCallArtifactCleanup,
    });

    memoryFlushes.push(...repairLoopResult.memoryFlushes);
    if (repairLoopResult.kind === "rearm") {
      return {
        kind: "rearm",
        reArm: repairLoopResult.reArm,
        memoryFlushes,
        ...(repairLoopResult.reduction !== undefined
          ? { reduction: repairLoopResult.reduction }
          : {}),
        ...(repairLoopResult.reductionSnapshot !== undefined
          ? { reductionSnapshot: repairLoopResult.reductionSnapshot }
          : {}),
      };
    }

    return {
      kind: "final",
      result: this.finalizeCompletedVisibility({
        packet: input.packet,
        result: repairLoopResult.result,
        messages: input.messages,
        toolTrace: input.toolTrace,
        completedSession: input.completedSession,
        completedSessionToolResultText: input.completedSessionToolResultText,
      }),
      memoryFlushes,
      ...(repairLoopResult.reduction !== undefined
        ? { reduction: repairLoopResult.reduction }
        : {}),
      ...(repairLoopResult.reductionSnapshot !== undefined
        ? { reductionSnapshot: repairLoopResult.reductionSnapshot }
        : {}),
    };
  }

  finalizeCompletedVisibility(
    input: CompletedCloseoutVisibilityInput,
  ): GenerateTextResult {
    const browserVisible = appendCompletedBrowserVisibility(input);
    const timeoutVisible = appendCompletedTimeoutVisibility({
      ...input,
      result: browserVisible,
    });
    const sourceLabelVisible = appendCompletedSourceLabelVisibility({
      ...input,
      result: timeoutVisible,
    });
    const approvalActionVisible = appendCompletedApprovalActionVisibility({
      ...input,
      result: sourceLabelVisible,
    });
    const approvalTargetMarkerVisible =
      appendCompletedApprovalTargetMarkerVisibility({
        ...input,
        result: approvalActionVisible,
      });
    return maybeRedactForbiddenLocalUrls({
      result: approvalTargetMarkerVisible,
      packet: input.packet,
    });
  }

  async runRepairLoop<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: CompletedCloseoutRepairLoopInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): Promise<
    CompletedCloseoutRepairLoopResult<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >
  > {
    const repairPolicy = input.repairPolicy ?? createRepairPolicyRegistry();
    const memoryFlushes: TMemoryFlush[] = [];
    let repairMessages = input.repairMessages;
    let synthesisResult = input.initialResult;
    let synthesisReduction = input.initialReduction;
    let synthesisReductionSnapshot = input.initialReductionSnapshot;

    for (
      let repairRound = 0;
      repairRound < MAX_COMPLETED_CLOSEOUT_REPAIR_ROUNDS;
      repairRound++
    ) {
      if (repairRound > 0) {
        const browserReArm = buildReArmIfNeeded({
          input,
          repairPolicy,
          repairMessages,
          synthesisResult,
        });
        if (browserReArm) {
          return {
            kind: "rearm",
            reArm: browserReArm,
            memoryFlushes,
            ...(synthesisReduction !== undefined
              ? { reduction: synthesisReduction }
              : {}),
            ...(synthesisReductionSnapshot !== undefined
              ? { reductionSnapshot: synthesisReductionSnapshot }
              : {}),
          };
        }
      }

      const synthesisEvidenceText =
        repairRound === 0
          ? input.completedEvidenceText
          : buildEvidenceSnapshot({
              taskPrompt: input.taskPrompt,
              messages: repairMessages,
              toolTrace: input.toolTrace,
            }).synthesisEvidenceText;

      let repairPrompt = evaluateTableOrSchemaRepair({
        input,
        repairPolicy,
        repairMessages,
        resultText: synthesisResult.text,
      });

      if (repairRound === 0 && !repairPrompt) {
        const browserReArm = buildReArmIfNeeded({
          input,
          repairPolicy,
          repairMessages,
          synthesisResult,
          productSignalEvidenceText: input.delegatedEvidenceText,
        });
        if (browserReArm) {
          return {
            kind: "rearm",
            reArm: browserReArm,
            memoryFlushes,
            ...(synthesisReduction !== undefined
              ? { reduction: synthesisReduction }
              : {}),
            ...(synthesisReductionSnapshot !== undefined
              ? { reductionSnapshot: synthesisReductionSnapshot }
              : {}),
          };
        }
      }

      if (!repairPrompt && synthesisEvidenceText) {
        repairPrompt = evaluateSourceEvidenceRepair({
          input,
          repairPolicy,
          repairMessages,
          resultText: synthesisResult.text,
          evidenceText: synthesisEvidenceText,
        });
      }

      if (!repairPrompt && repairRound === 0) {
        repairPrompt =
          repairPolicy.evaluateCompletedSynthesis({
            completedEvidenceText: input.completedEvidenceText,
            delegatedEvidenceText: input.delegatedEvidenceText,
            completedSessionFinalContents: input.completedSessionFinalContents,
            messages: repairMessages,
            repairMarkers: input.repairMarkers,
            resultText: synthesisResult.text,
            taskPrompt: input.taskPrompt,
          })?.repairPrompt ?? null;
      }

      if (!repairPrompt) {
        repairPrompt = evaluateWeakEvidenceRepair({
          input,
          repairPolicy,
          repairMessages,
          resultText: synthesisResult.text,
          evidenceText: synthesisEvidenceText,
        });
      }

      if (!repairPrompt) {
        break;
      }

      const localEvidenceCloseout = buildCompletedProductBriefLocalCloseout({
        input,
        repairMessages,
        repairPrompt,
      });
      if (localEvidenceCloseout) {
        recordRepairPrompt(input.repairMarkers, repairPrompt);
        return {
          kind: "final",
          result: localEvidenceCloseout,
          repairMessages,
          memoryFlushes,
          ...(synthesisReduction !== undefined
            ? { reduction: synthesisReduction }
            : {}),
          ...(synthesisReductionSnapshot !== undefined
            ? { reductionSnapshot: synthesisReductionSnapshot }
            : {}),
        };
      }

      repairMessages = [
        ...repairMessages,
        { role: "assistant", content: synthesisResult.text },
        recordRepairPrompt(input.repairMarkers, repairPrompt),
      ];

      const repaired = await input.synthesizeRepair({ messages: repairMessages });
      synthesisResult = repaired.result;
      if (repaired.reduction !== undefined) {
        synthesisReduction = repaired.reduction;
        synthesisReductionSnapshot = repaired.reductionSnapshot;
      }
      appendMemoryFlush(memoryFlushes, repaired.memoryFlush);
    }

    if (synthesisResult.toolCalls?.length) {
      const cleanup = await input.synthesizeToolCallArtifactCleanup({
        messages: [
          ...repairMessages,
          { role: "assistant", content: synthesisResult.text },
        ],
      });
      synthesisResult = cleanup.result;
      if (cleanup.reduction !== undefined) {
        synthesisReduction = cleanup.reduction;
        synthesisReductionSnapshot = cleanup.reductionSnapshot;
      }
      appendMemoryFlush(memoryFlushes, cleanup.memoryFlush);
    }

    return {
      kind: "final",
      result: synthesisResult,
      repairMessages,
      memoryFlushes,
      ...(synthesisReduction !== undefined ? { reduction: synthesisReduction } : {}),
      ...(synthesisReductionSnapshot !== undefined
        ? { reductionSnapshot: synthesisReductionSnapshot }
        : {}),
    };
  }
}

export function createCompletedCloseoutController(): CompletedCloseoutController {
  return new CompletedCloseoutController();
}

function buildCompletedProductBriefLocalCloseout(input: {
  input: CompletedCloseoutRepairLoopInput;
  repairMessages: LLMMessage[];
  repairPrompt: string;
}): GenerateTextResult | null {
  if (
    !input.repairPrompt.includes(
      "Runtime correction: final product brief dropped required source-backed workbench evidence",
    )
  ) {
    return null;
  }
  const localResult = buildLocalEvidenceCloseout({
    ...(input.input.activation ? { activation: input.input.activation } : {}),
    messages: input.repairMessages,
    packet: input.input.packet ?? repairLoopPacket(input.input.taskPrompt),
    selection: {},
    error: new Error(
      "completed product brief synthesis bypassed after source-backed evidence",
    ),
  });
  return localEvidenceCloseoutKind(localResult) === "agent_workbench_product_brief"
    ? localResult
    : null;
}

function localEvidenceCloseoutKind(result: GenerateTextResult | null): unknown {
  const raw = result?.raw;
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)["localEvidenceKind"]
    : undefined;
}

function repairLoopPacket(taskPrompt: string): RolePromptPacket {
  return {
    roleId: "role:completed-closeout",
    roleName: "Completed Closeout",
    seat: "member",
    systemPrompt: "",
    taskPrompt,
    outputContract: "",
    suggestedMentions: [],
  } as RolePromptPacket;
}

function evaluateTableOrSchemaRepair(input: {
  input: CompletedCloseoutRepairLoopInput;
  repairPolicy: RepairPolicyRegistry;
  repairMessages: LLMMessage[];
  resultText: string;
}): string | null {
  const decision = input.repairPolicy.evaluateNaturalFinish({
    ...(input.input.activation ? { activation: input.input.activation } : {}),
    enabledPolicies: TABLE_OR_SCHEMA_REPAIR_POLICIES,
    finalRecoveryBudget: null,
    messages: input.repairMessages,
    repairMarkers: input.input.repairMarkers,
    resultText: input.resultText,
    taskPrompt: input.input.taskPrompt,
    toolTrace: input.input.toolTrace,
  });
  return decision?.kind === "resynthesize" ? decision.repairPrompt : null;
}

function evaluateSourceEvidenceRepair(input: {
  input: CompletedCloseoutRepairLoopInput;
  repairPolicy: RepairPolicyRegistry;
  repairMessages: LLMMessage[];
  resultText: string;
  evidenceText: string;
}): string | null {
  const decision = input.repairPolicy.evaluateNaturalFinish({
    enabledPolicies: ["source_evidence_carry_forward"],
    finalRecoveryBudget: null,
    taskPrompt: input.input.taskPrompt,
    resultText: input.resultText,
    messages: input.repairMessages,
    repairMarkers: input.input.repairMarkers,
    toolTrace: input.input.toolTrace,
    evidenceText: input.evidenceText,
  });
  return decision?.kind === "resynthesize" ? decision.repairPrompt : null;
}

function evaluateWeakEvidenceRepair(input: {
  input: CompletedCloseoutRepairLoopInput;
  repairPolicy: RepairPolicyRegistry;
  repairMessages: LLMMessage[];
  resultText: string;
  evidenceText: string;
}): string | null {
  const decision = input.repairPolicy.evaluateNaturalFinish({
    enabledPolicies: ["weak_evidence_synthesis"],
    finalRecoveryBudget: null,
    taskPrompt: input.input.taskPrompt,
    resultText: input.resultText,
    messages: input.repairMessages,
    repairMarkers: input.input.repairMarkers,
    toolTrace: input.input.toolTrace,
    evidenceText: input.evidenceText,
  });
  return decision?.kind === "resynthesize" ? decision.repairPrompt : null;
}

function buildReArmIfNeeded(input: {
  input: CompletedCloseoutRepairLoopInput;
  repairPolicy: RepairPolicyRegistry;
  repairMessages: LLMMessage[];
  synthesisResult: GenerateTextResult;
  productSignalEvidenceText?: string;
}): ReActReArm | null {
  const repair = input.repairPolicy.evaluateNaturalFinish({
    enabledPolicies: [
      "missing_browser_evidence",
      "missing_product_signal_browser_evidence",
    ],
    finalRecoveryBudget: null,
    taskPrompt: input.input.taskPrompt,
    resultText: input.synthesisResult.text,
    messages: input.repairMessages,
    repairMarkers: input.input.repairMarkers,
    toolTrace: input.input.toolTrace,
    ...(input.input.tools === undefined ? {} : { tools: input.input.tools }),
    ...(input.productSignalEvidenceText === undefined
      ? {}
      : { evidenceText: input.productSignalEvidenceText }),
  });
  if (repair?.kind !== "force_tool_round") {
    return null;
  }
  return {
    reArm: {
      messages: [
        ...input.repairMessages,
        { role: "assistant", content: input.synthesisResult.text },
        recordRepairPrompt(input.input.repairMarkers, repair.repairPrompt),
      ],
      forceToolChoice: repair.forceToolChoice,
    },
  };
}

function appendMemoryFlush<T>(memoryFlushes: T[], memoryFlush: T | undefined): void {
  if (memoryFlush !== undefined) {
    memoryFlushes.push(memoryFlush);
  }
}

function appendCompletedBrowserVisibility(
  input: CompletedCloseoutVisibilityInput,
): GenerateTextResult {
  const completedSession = input.completedSession;
  if (!completedSession) {
    return input.result;
  }
  const browserRecoverySummaries = dedupeStrings([
    ...completedSession.browserRecoverySummaries,
    ...readRuntimeBrowserSummariesFromTrace(input.toolTrace),
  ]);
  let visible = maybeAppendBrowserRecoveryVisibility({
    result: input.result,
    taskPrompt: input.packet.taskPrompt,
    browserRecoverySummaries,
  });
  visible = maybeAppendBrowserFailureBucketVisibility({
    result: visible,
    taskPrompt: input.packet.taskPrompt,
    evidenceText: [
      input.completedSessionToolResultText,
      ...browserRecoverySummaries,
      ...completedSession.finalContents,
    ].join("\n\n"),
  });
  visible = maybeAppendDashboardEscalationActionVisibility({
    result: visible,
    taskPrompt: input.packet.taskPrompt,
    evidenceText: [
      input.completedSessionToolResultText,
      ...browserRecoverySummaries,
      ...completedSession.finalContents,
    ].join("\n\n"),
  });
  return visible;
}

function appendCompletedTimeoutVisibility(
  input: CompletedCloseoutVisibilityInput,
): GenerateTextResult {
  const completedSession = input.completedSession;
  const preserveRecoveredTimeoutCloseout = completedSession
    ? shouldPreserveRecoveredTimeoutCloseout({
        taskPrompt: input.packet.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        evidenceText: completedSession.finalContents.join("\n\n"),
      })
    : false;
  if (
    preserveRecoveredTimeoutCloseout ||
    shouldAppendRecoveredTimeoutCloseoutVisibility({
      resultText: input.result.text,
      taskPrompt: input.packet.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
    })
  ) {
    return maybeAppendRecoveredTimeoutCloseoutVisibility(input.result);
  }
  if (
    shouldAppendTimeoutContinuationVisibility({
      taskPrompt: input.packet.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
    })
  ) {
    return maybeAppendTimeoutContinuationVisibility(input.result);
  }
  return input.result;
}

function appendCompletedSourceLabelVisibility(
  input: CompletedCloseoutVisibilityInput,
): GenerateTextResult {
  if (!input.completedSession) {
    return input.result;
  }
  if (
    !completedSourceLabelsVisibleRequired(input.packet.taskPrompt) &&
    !completedBrowserActionSourceBindingRequired(input.packet.taskPrompt) &&
    !completedBrowserContinuationSourceBindingRequired(input.packet.taskPrompt)
  ) {
    return input.result;
  }
  const evidenceText = [
    input.completedSessionToolResultText,
    ...input.completedSession.finalContents,
  ].join("\n\n");
  const labels = extractCompletedSourceLabels(evidenceText);
  if (labels.length === 0) {
    return input.result;
  }
  const missingLabels = labels.filter(
    (label) => !sourceLabelVisible(input.result.text, label),
  );
  if (missingLabels.length === 0) {
    return input.result;
  }
  const line = `Evidence / Sources: ${missingLabels
    .map((label) => `${label} (completed delegated evidence)`)
    .join("; ")}.`;
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\n${line}`.trim(),
  };
}

function appendCompletedApprovalActionVisibility(
  input: CompletedCloseoutVisibilityInput,
): GenerateTextResult {
  if (!input.completedSession) {
    return input.result;
  }
  if (/\bbrowser\.form\.submit\b/i.test(input.result.text)) {
    return input.result;
  }
  if (!completedBrowserActionSourceBindingRequired(input.packet.taskPrompt)) {
    return input.result;
  }
  const evidenceText = [
    input.completedSessionToolResultText,
    ...input.completedSession.finalContents,
    input.result.text,
  ].join("\n\n");
  if (!completedApprovalGateApplied(evidenceText)) {
    return input.result;
  }
  if (!completedApprovalFixtureVerified(evidenceText)) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\nApproved action: browser.form.submit was the gated local dry-run action; the fixture evidence remains bounded to no external mutation.`.trim(),
  };
}

function appendCompletedApprovalTargetMarkerVisibility(
  input: CompletedCloseoutVisibilityInput,
): GenerateTextResult {
  if (!input.completedSession) {
    return input.result;
  }
  const marker = extractCompletedApprovalTargetMarker(input.packet);
  if (!marker || input.result.text.includes(marker)) {
    return input.result;
  }
  const evidenceText = [
    input.completedSessionToolResultText,
    ...input.completedSession.finalContents,
    input.result.text,
  ].join("\n\n");
  if (!completedApprovalGateApplied(evidenceText)) {
    return input.result;
  }
  if (!completedApprovalBrowserActionCompleted(evidenceText)) {
    return input.result;
  }
  return {
    ...input.result,
    text: `${input.result.text.trim()}\n\nTarget marker: ${marker}.`.trim(),
  };
}

function extractCompletedApprovalTargetMarker(
  packet: RolePromptPacket,
): string | null {
  const contractText = [
    packet.taskPrompt,
    packet.outputContract ?? "",
  ].join("\n\n");
  const match = contractText.match(/\bTURNKEYAI_APPROVAL_E2E_OK\b/);
  return match?.[0] ?? null;
}

function completedSourceLabelsVisibleRequired(taskPrompt: string): boolean {
  return /\b(?:source labels?|source URLs?|evidence streams?|source streams?|source checks?|sources?)\b/i.test(
    taskPrompt,
  );
}

function completedBrowserActionSourceBindingRequired(taskPrompt: string): boolean {
  return (
    /\b(?:approval|permission|approved|dry[- ]run|form submission|browser\.form\.submit|submit)\b/i.test(
      taskPrompt,
    ) &&
    /\b(?:browser|form|approval gate|permission cache|local test data)\b/i.test(
      taskPrompt,
    )
  );
}

function completedBrowserContinuationSourceBindingRequired(taskPrompt: string): boolean {
  return (
    /\b(?:continue|continuation|follow[- ]?up|re-?check|same (?:browser )?context|reuse|resume)\b/i.test(
      taskPrompt,
    ) &&
    /\b(?:browser|dashboard|rendered|page state|operations dashboard)\b/i.test(
      taskPrompt,
    )
  );
}

function completedApprovalGateApplied(evidenceText: string): boolean {
  return (
    /\bpermission[._]query\b/i.test(evidenceText) &&
    /\bpermission[._]result\b/i.test(evidenceText) &&
    /\bpermission[._]applied\b/i.test(evidenceText)
  );
}

function completedApprovalFixtureVerified(evidenceText: string): boolean {
  return /\b(?:approval-gated-browser-e2e|TURNKEYAI_APPROVAL_FIXTURE_OK|no external mutation)\b/i.test(
    evidenceText,
  );
}

function completedApprovalBrowserActionCompleted(evidenceText: string): boolean {
  return (
    /\bbrowser\.form\.submit\b/i.test(evidenceText) &&
    /\b(?:completed|executed|submitted|performed|confirmed|verified)\b/i.test(
      evidenceText,
    )
  );
}

function extractCompletedSourceLabels(evidenceText: string): string[] {
  const labels: string[] = [];
  for (const match of evidenceText.matchAll(
    /"(?:label|sourceLabel)"\s*:\s*"([^"\\]{3,120})"/g,
  )) {
    const label = match[1]?.trim();
    if (label && isMeaningfulCompletedSourceLabel(label)) {
      labels.push(label);
    }
  }
  for (const match of evidenceText.matchAll(/\blabel\s*=\s*"([^"]{3,120})"/g)) {
    const label = match[1]?.trim();
    if (label && isMeaningfulCompletedSourceLabel(label)) {
      labels.push(label);
    }
  }
  return dedupeStrings(labels).slice(0, 8);
}

function isMeaningfulCompletedSourceLabel(label: string): boolean {
  const normalized = normalizeCompletedSourceLabel(label);
  if (!normalized) {
    return false;
  }
  return !/\b(?:sessions?|tool|result|unknown|null|undefined)\b/.test(normalized);
}

function sourceLabelVisible(text: string, label: string): boolean {
  const normalizedLabel = normalizeCompletedSourceLabel(label);
  if (!normalizedLabel) {
    return true;
  }
  return normalizeCompletedSourceLabel(text).includes(normalizedLabel);
}

function normalizeCompletedSourceLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

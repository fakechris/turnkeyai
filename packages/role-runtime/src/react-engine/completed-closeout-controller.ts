import type { ReActReArm } from "@turnkeyai/agent-core/react-loop";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";
import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import {
  collectBrowserRecoverySummariesFromToolTrace,
  dedupeStrings,
  maybeAppendBrowserFailureBucketVisibility,
  maybeAppendBrowserRecoveryVisibility,
  maybeAppendRecoveredTimeoutCloseoutVisibility,
  maybeAppendTimeoutContinuationVisibility,
  maybeRedactForbiddenLocalUrls,
  shouldAppendRecoveredTimeoutCloseoutVisibility,
  shouldAppendTimeoutContinuationVisibility,
  shouldPreserveRecoveredTimeoutCloseout,
} from "../tool-loop-shared";
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
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  repairMessages: LLMMessage[];
  repairMarkers: LLMMessage[];
  completedSessionFinalContents: readonly string[];
  completedEvidenceText: string;
  completedSessionEvidenceText: string;
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

type OptionalReduction<TReduction, TReductionSnapshot> = {
  reduction?: TReduction;
  reductionSnapshot?: TReductionSnapshot;
};

export class CompletedCloseoutController {
  finalizeCompletedVisibility(
    input: CompletedCloseoutVisibilityInput,
  ): GenerateTextResult {
    const browserVisible = appendCompletedBrowserVisibility(input);
    const timeoutVisible = appendCompletedTimeoutVisibility({
      ...input,
      result: browserVisible,
    });
    return maybeRedactForbiddenLocalUrls({
      result: timeoutVisible,
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

      const naturalFinishEvidenceText =
        repairRound === 0
          ? input.completedEvidenceText
          : buildEvidenceSnapshot({
              taskPrompt: input.taskPrompt,
              messages: repairMessages,
              toolTrace: input.toolTrace,
            }).naturalFinishEvidenceText;

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
          productSignalEvidenceText: input.completedSessionEvidenceText,
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

      if (!repairPrompt && naturalFinishEvidenceText) {
        repairPrompt = evaluateSourceEvidenceRepair({
          input,
          repairPolicy,
          repairMessages,
          resultText: synthesisResult.text,
          evidenceText: naturalFinishEvidenceText,
        });
      }

      if (!repairPrompt && repairRound === 0) {
        repairPrompt =
          repairPolicy.evaluateCompletedSynthesis({
            completedEvidenceText: input.completedEvidenceText,
            completedSessionEvidenceText: input.completedSessionEvidenceText,
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
          evidenceText: naturalFinishEvidenceText,
        });
      }

      if (!repairPrompt) {
        break;
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

function recordRepairPrompt(
  repairMarkers: LLMMessage[],
  content: string,
): LLMMessage {
  const message: LLMMessage = { role: "user", content };
  repairMarkers.push(message);
  return message;
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
    ...collectBrowserRecoverySummariesFromToolTrace(input.toolTrace),
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

import type { ReActReArm } from "@turnkeyai/agent-core/react-loop";
import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { RolePromptPacket } from "../prompt-policy";
import type { ToolLoopCloseoutMetadata } from "../runtime-derived-mission-report";
import {
  buildApprovalWaitTimeoutLocalEvidenceCloseout,
  buildLocalEvidenceCloseout,
  maybeAppendTimeoutContinuationVisibility,
  maybeRedactForbiddenLocalUrls,
} from "../tool-loop-shared";
import type {
  CompletedCloseoutSynthesis,
  CompletedCloseoutTerminalInput,
  CompletedCloseoutTerminalResult,
  CompletedCloseoutVisibilitySession,
} from "./completed-closeout-controller";
import type { RepairPolicyRegistry } from "./repair-policy-registry";
import type { EngineCloseoutReason, EngineContinueAction } from "./types";

// Stage 8 engine cleanup — TerminalCloseoutController.
//
// Authority: own behavior-neutral terminal closeout assembly and explicit
// terminal state-effect application through an injected recorder. The adapter
// still owns gateway calls while inline remains the parity reference.
export const TERMINAL_CLOSEOUT_CONTROLLER_MODULE =
  "terminal-closeout-controller" as const;

export interface ApprovalWaitTimeoutFallbackInput {
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  packet: RolePromptPacket;
  maxRounds: number;
  toolCallCount: number;
  roundCount: number;
  evidenceText: string;
  error: unknown;
}

export interface ToolEvidenceFallbackInput {
  packet: RolePromptPacket;
  maxRounds: number;
  toolCallCount: number;
  roundCount: number;
  result: GenerateTextResult;
}

export interface ModelCallErrorFallbackInput {
  active: boolean;
  usableEvidence: boolean;
  activation?: RoleActivationInput;
  messages: LLMMessage[];
  packet: RolePromptPacket;
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  error: unknown;
  maxRounds: number;
  toolCallCount: number;
  roundCount: number;
}

export interface FinalSynthesisToolCallArtifactFallbackInput {
  activation?: RoleActivationInput;
  messages: LLMMessage[];
  packet: RolePromptPacket;
  selection: {
    modelId?: string;
    modelChainId?: string;
  };
  repairedResult: GenerateTextResult;
}

type ForcedModelCallErrorContinuation = Extract<
  EngineContinueAction,
  { kind: "forced_tool_round" }
>;

export interface ModelCallErrorHandlingInput
  extends ModelCallErrorFallbackInput {
  aborted: boolean;
  forcedPermissionResult:
    | ForcedModelCallErrorContinuation
    | {
        kind: "none";
      };
}

export interface ModelCallErrorFlowInput extends ModelCallErrorFallbackInput {
  aborted: boolean;
  buildForcedPermissionResult(): ForcedModelCallErrorContinuation | {
    kind: "none";
  };
}

export interface TerminalEvidenceFallback {
  closeout: ToolLoopCloseoutMetadata;
  result: GenerateTextResult;
}

export type ApprovalWaitTimeoutFallback = TerminalEvidenceFallback;

export interface TerminalSynthesisMessagesInput {
  reason: EngineCloseoutReason;
  messages: LLMMessage[];
  lastText: string;
}

export interface TerminalGeneratedResultInput {
  reason: EngineCloseoutReason;
  result: GenerateTextResult;
}

export interface NonCompletedTerminalSynthesis<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  result: GenerateTextResult;
  reduction?: TReduction;
  reductionSnapshot?: TReductionSnapshot;
  memoryFlush?: TMemoryFlush;
}

export interface NonCompletedTerminalSynthesisInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  reason: EngineCloseoutReason;
  generated: NonCompletedTerminalSynthesis<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  >;
}

export interface NonCompletedTerminalSynthesisResult<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  result: GenerateTextResult;
  memoryFlushes: TMemoryFlush[];
  reduction?: TReduction;
  reductionSnapshot?: TReductionSnapshot;
}

export interface FinalSynthesisRepairMergeInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  initial: NonCompletedTerminalSynthesis<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  >;
  repair: NonCompletedTerminalSynthesis<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  >;
}

export interface TerminalSynthesisRequest {
  messages: LLMMessage[];
  reasonLines?: string[];
}

export interface TerminalSynthesisInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  reason: EngineCloseoutReason;
  messages: LLMMessage[];
  lastText: string;
  reasonLines?: string[];
  synthesize(
    input: TerminalSynthesisRequest,
  ): Promise<
    NonCompletedTerminalSynthesis<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >
  >;
}

export interface CompletedTerminalSynthesisInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> extends TerminalSynthesisInput<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  > {
  synthesizeCompleted(input: {
    initialSynthesis: NonCompletedTerminalSynthesis<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >;
  }): Promise<
    CompletedCloseoutTerminalResult<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >
  >;
}

export interface TerminalCloseoutCompletionInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> extends TerminalSynthesisInput<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  > {
  closeout: ToolLoopCloseoutMetadata;
  target: TerminalCloseoutApplicationTarget<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  >;
  completed?: {
    synthesize(input: {
      initialSynthesis: NonCompletedTerminalSynthesis<
        TReduction,
        TReductionSnapshot,
        TMemoryFlush
      >;
    }): Promise<
      CompletedCloseoutTerminalResult<
        TReduction,
        TReductionSnapshot,
        TMemoryFlush
      >
    >;
  };
}

export interface TerminalCompletedCloseoutEvidence {
  toolResultContentText(results: ToolResult[]): string;
}

export interface TerminalCompletedCloseoutSynthesizer<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  synthesizeTerminalCloseout(
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
  >;
}

export interface TerminalCompletedCloseoutInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  completedCloseout: TerminalCompletedCloseoutSynthesizer<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  >;
  completedSession?: CompletedCloseoutVisibilitySession | null;
  completedSessionToolResults?: ToolResult[];
  evidence: TerminalCompletedCloseoutEvidence;
  packet: RolePromptPacket;
  repairMarkers: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  activation?: RoleActivationInput;
  tools?: readonly { name: string }[];
  repairPolicy?: RepairPolicyRegistry;
  synthesizeRepair(input: {
    messages: LLMMessage[];
  }): Promise<
    CompletedCloseoutSynthesis<TReduction, TReductionSnapshot, TMemoryFlush>
  >;
  synthesizeToolCallArtifactCleanup(input: {
    messages: LLMMessage[];
  }): Promise<
    CompletedCloseoutSynthesis<TReduction, TReductionSnapshot, TMemoryFlush>
  >;
}

export interface TerminalCloseoutDecisionInput {
  closeout: ToolLoopCloseoutMetadata;
  reasonLines?: string[];
  sticky?: boolean;
}

export interface TerminalCloseoutHandlingInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> extends Omit<
    TerminalCloseoutCompletionInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
    "closeout" | "reasonLines"
  > {
  decision: TerminalCloseoutDecisionInput;
}

export interface TerminalCloseoutHookInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> extends TerminalCloseoutHandlingInput<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  > {
  approvalWaitTimeoutFallback?: ApprovalWaitTimeoutFallbackInput;
  completedCloseout?: TerminalCompletedCloseoutInput<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  >;
}

export type TerminalCloseoutCompletionResult =
  | {
      kind: "final";
      response: TerminalFinalResponse;
    }
  | {
      kind: "rearm";
      reArm: ReActReArm;
    };

export interface TerminalFinalResponse {
  text: string;
  stopReason?: string;
}

export type TerminalModelCallErrorFallbackResult =
  | {
      kind: "final";
      response: TerminalFinalResponse;
    }
  | {
      kind: "rethrow";
    };

export type TerminalModelCallErrorResult =
  | TerminalModelCallErrorFallbackResult
  | ForcedModelCallErrorContinuation;

export type TerminalModelCallErrorHookResult =
  | TerminalFinalResponse
  | "rethrow"
  | {
      messages: LLMMessage[];
    };

export type ModelCallErrorForcedRoundExecutor = (
  input: ForcedModelCallErrorContinuation,
) => Promise<{
  messages: LLMMessage[];
  [key: string]: unknown;
}>;

export type TerminalCloseoutRecordMode = "if_absent" | "overwrite";

export interface TerminalCloseoutApplicationTarget<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  recordToolLoopCloseout(input: ToolLoopCloseoutMetadata): void;
  recordToolLoopCloseoutIfAbsent(input: ToolLoopCloseoutMetadata): void;
  recordCloseoutResult(input: GenerateTextResult): void;
  recordReduction(input: {
    reduction: TReduction;
    reductionSnapshot: TReductionSnapshot | undefined;
  }): void;
  recordMemoryFlush(input: TMemoryFlush): void;
}

export interface TerminalSynthesisEffectsInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> {
  memoryFlushes?: readonly TMemoryFlush[];
  reduction?: TReduction;
  reductionSnapshot?: TReductionSnapshot;
}

export interface TerminalCloseoutApplicationInput<
  TReduction = unknown,
  TReductionSnapshot = unknown,
  TMemoryFlush = unknown,
> extends TerminalSynthesisEffectsInput<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  > {
  reason: EngineCloseoutReason;
  closeout: ToolLoopCloseoutMetadata;
  result: GenerateTextResult;
}

export interface TerminalStickyCloseoutInput {
  sticky?: boolean;
  closeout: ToolLoopCloseoutMetadata;
}

export class TerminalCloseoutController {
  buildApprovalWaitTimeoutFallback(
    input: ApprovalWaitTimeoutFallbackInput,
  ): ApprovalWaitTimeoutFallback {
    return this.buildToolEvidenceFallback({
      packet: input.packet,
      maxRounds: input.maxRounds,
      toolCallCount: input.toolCallCount,
      roundCount: input.roundCount,
      result: buildApprovalWaitTimeoutLocalEvidenceCloseout({
        selection: input.selection,
        evidenceText: input.evidenceText,
        error: input.error,
      }),
    });
  }

  applyApprovalWaitTimeoutFallback<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: ApprovalWaitTimeoutFallbackInput,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): TerminalFinalResponse {
    const fallback = this.buildApprovalWaitTimeoutFallback(input);
    return this.applyCloseoutApplication(
      {
        reason: "tool_evidence_fallback",
        closeout: fallback.closeout,
        result: fallback.result,
      },
      target,
    );
  }

  buildToolEvidenceFallback(
    input: ToolEvidenceFallbackInput,
  ): TerminalEvidenceFallback {
    return {
      closeout: {
        reason: "tool_evidence_fallback",
        maxRounds: input.maxRounds,
        toolCallCount: input.toolCallCount,
        roundCount: input.roundCount,
        evidenceAvailable: true,
      },
      result: maybeRedactForbiddenLocalUrls({
        result: input.result,
        packet: input.packet,
      }),
    };
  }

  buildModelCallErrorFallback(
    input: ModelCallErrorFallbackInput,
  ): TerminalEvidenceFallback | null {
    if (!input.active || !input.usableEvidence) {
      return null;
    }
    const localResult = buildLocalEvidenceCloseout({
      ...(input.activation ? { activation: input.activation } : {}),
      messages: input.messages,
      packet: input.packet,
      selection: input.selection,
      error: input.error,
    });
    if (!localResult) {
      return null;
    }
    return this.buildToolEvidenceFallback({
      packet: input.packet,
      maxRounds: input.maxRounds,
      toolCallCount: input.toolCallCount,
      roundCount: input.roundCount,
      result: localResult,
    });
  }

  buildFinalSynthesisToolCallArtifactFallback(
    input: FinalSynthesisToolCallArtifactFallbackInput,
  ): GenerateTextResult {
    const localResult = buildLocalEvidenceCloseout({
      ...(input.activation ? { activation: input.activation } : {}),
      messages: input.messages,
      packet: input.packet,
      selection: input.selection,
      error: new Error("final synthesis emitted a tool call after repair"),
    }) ?? {
      ...input.repairedResult,
      text: [
        "I can't safely complete the final answer from the current tool results.",
        "The model attempted to emit another tool call after tools were disabled for final synthesis.",
        "Please retry or continue the mission so the runtime can collect a clean final answer.",
      ].join(" "),
    };
    return maybeRedactForbiddenLocalUrls({
      result: localResult,
      packet: input.packet,
    });
  }

  applyModelCallErrorFallback<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: ModelCallErrorFallbackInput,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): TerminalFinalResponse | null {
    const fallback = this.buildModelCallErrorFallback(input);
    if (!fallback) {
      return null;
    }
    return this.applyCloseoutApplication(
      {
        reason: "tool_evidence_fallback",
        closeout: fallback.closeout,
        result: fallback.result,
      },
      target,
    );
  }

  handleModelCallErrorFallback<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: ModelCallErrorFallbackInput,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): TerminalModelCallErrorFallbackResult {
    const response = this.applyModelCallErrorFallback(input, target);
    if (!response) {
      return { kind: "rethrow" };
    }
    return { kind: "final", response };
  }

  handleModelCallError<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: ModelCallErrorHandlingInput,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): TerminalModelCallErrorResult {
    if (input.aborted) {
      return { kind: "rethrow" };
    }
    if (input.forcedPermissionResult.kind === "forced_tool_round") {
      return input.forcedPermissionResult;
    }
    return this.handleModelCallErrorFallback(input, target);
  }

  async completeModelCallError<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: ModelCallErrorHandlingInput,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
    executeForcedRound: ModelCallErrorForcedRoundExecutor,
  ): Promise<TerminalModelCallErrorHookResult> {
    const result = this.handleModelCallError(input, target);
    if (result.kind === "forced_tool_round") {
      const forcedRound = await executeForcedRound(result);
      return { messages: forcedRound.messages };
    }
    if (result.kind === "rethrow") {
      return "rethrow";
    }
    return result.response;
  }

  async completeModelCallErrorFlow<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: ModelCallErrorFlowInput,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
    executeForcedRound: ModelCallErrorForcedRoundExecutor,
  ): Promise<TerminalModelCallErrorHookResult> {
    const forcedPermissionResult =
      !input.aborted && input.active && input.usableEvidence
        ? input.buildForcedPermissionResult()
        : { kind: "none" as const };
    return this.completeModelCallError(
      {
        ...input,
        forcedPermissionResult,
      },
      target,
      executeForcedRound,
    );
  }

  buildSynthesisMessages(input: TerminalSynthesisMessagesInput): LLMMessage[] {
    if (input.reason !== "pseudo_tool_call") {
      return input.messages;
    }
    return [
      ...input.messages,
      { role: "assistant", content: input.lastText },
    ];
  }

  async synthesizeInitialCloseout<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalSynthesisInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): Promise<
    NonCompletedTerminalSynthesis<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >
  > {
    return input.synthesize({
      messages: this.buildSynthesisMessages({
        reason: input.reason,
        messages: input.messages,
        lastText: input.lastText,
      }),
      ...(input.reasonLines === undefined
        ? {}
        : { reasonLines: input.reasonLines }),
    });
  }

  async synthesizeNonCompletedCloseout<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalSynthesisInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): Promise<
    NonCompletedTerminalSynthesisResult<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >
  > {
    const generated = await this.synthesizeInitialCloseout(input);
    return this.applyNonCompletedGeneratedSynthesis({
      reason: input.reason,
      generated,
    });
  }

  async synthesizeCompletedCloseout<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: CompletedTerminalSynthesisInput<
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
    const initialSynthesis = await this.synthesizeInitialCloseout(input);
    return input.synthesizeCompleted({ initialSynthesis });
  }

  buildCompletedCloseoutSynthesis<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: {
      completedCloseout: TerminalCompletedCloseoutInput<
        TReduction,
        TReductionSnapshot,
        TMemoryFlush
      >;
      messages: LLMMessage[];
    },
  ):
    | NonNullable<
        TerminalCloseoutCompletionInput<
          TReduction,
          TReductionSnapshot,
          TMemoryFlush
        >["completed"]
      >
    | undefined {
    const closeout = input.completedCloseout;
    const completedSession = closeout.completedSession;
    if (!completedSession) {
      return undefined;
    }
    return {
      synthesize: async ({ initialSynthesis }) =>
        closeout.completedCloseout.synthesizeTerminalCloseout({
          packet: closeout.packet,
          messages: input.messages,
          repairMarkers: closeout.repairMarkers,
          completedSession,
          completedSessionToolResultText: closeout.evidence.toolResultContentText(
            closeout.completedSessionToolResults ?? [],
          ),
          initialSynthesis,
          ...(closeout.activation === undefined
            ? {}
            : { activation: closeout.activation }),
          ...(closeout.tools === undefined ? {} : { tools: closeout.tools }),
          ...(closeout.repairPolicy === undefined
            ? {}
            : { repairPolicy: closeout.repairPolicy }),
          synthesizeRepair: closeout.synthesizeRepair,
          synthesizeToolCallArtifactCleanup:
            closeout.synthesizeToolCallArtifactCleanup,
          toolTrace: closeout.toolTrace,
        }),
    };
  }

  async completeTerminalCloseout<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalCloseoutCompletionInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): Promise<TerminalCloseoutCompletionResult> {
    if (input.reason === "completed_sub_agent_final" && input.completed) {
      const completed = await this.synthesizeCompletedCloseout({
        ...input,
        synthesizeCompleted: input.completed.synthesize,
      });
      if (completed.kind === "rearm") {
        this.recordSynthesisEffects(completed, input.target);
        return { kind: "rearm", reArm: completed.reArm };
      }
      return {
        kind: "final",
        response: this.applyCloseoutApplication(
          {
            reason: input.reason,
            closeout: input.closeout,
            result: completed.result,
            memoryFlushes: completed.memoryFlushes,
            ...(completed.reduction === undefined
              ? {}
              : { reduction: completed.reduction }),
            ...(completed.reductionSnapshot === undefined
              ? {}
              : { reductionSnapshot: completed.reductionSnapshot }),
          },
          input.target,
        ),
      };
    }

    const generated = await this.synthesizeNonCompletedCloseout(input);
    return {
      kind: "final",
      response: this.applyCloseoutApplication(
        {
          reason: input.reason,
          closeout: input.closeout,
          result: generated.result,
          memoryFlushes: generated.memoryFlushes,
          ...(generated.reduction === undefined
            ? {}
            : { reduction: generated.reduction }),
          ...(generated.reductionSnapshot === undefined
            ? {}
            : { reductionSnapshot: generated.reductionSnapshot }),
        },
        input.target,
      ),
    };
  }

  async handleTerminalCloseout<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalCloseoutHandlingInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): Promise<TerminalCloseoutCompletionResult> {
    this.recordStickyCloseoutIfNeeded(
      {
        sticky: input.decision.sticky ?? false,
        closeout: input.decision.closeout,
      },
      input.target,
    );

    return this.completeTerminalCloseout({
      reason: input.reason,
      messages: input.messages,
      lastText: input.lastText,
      closeout: input.decision.closeout,
      target: input.target,
      synthesize: input.synthesize,
      ...(input.decision.reasonLines === undefined
        ? {}
        : { reasonLines: input.decision.reasonLines }),
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    });
  }

  async handleTerminalCloseoutHook<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalCloseoutHookInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): Promise<TerminalCloseoutCompletionResult> {
    if (
      input.reason === "tool_evidence_fallback" &&
      input.approvalWaitTimeoutFallback
    ) {
      return {
        kind: "final",
        response: this.applyApprovalWaitTimeoutFallback(
          input.approvalWaitTimeoutFallback,
          input.target,
        ),
      };
    }
    const completed =
      input.completed ??
      (input.reason === "completed_sub_agent_final" && input.completedCloseout
        ? this.buildCompletedCloseoutSynthesis({
            completedCloseout: input.completedCloseout,
            messages: input.messages,
          })
        : undefined);
    return this.handleTerminalCloseout({
      ...input,
      ...(completed === undefined ? {} : { completed }),
    });
  }

  finalizeGeneratedResult(input: TerminalGeneratedResultInput): GenerateTextResult {
    if (input.reason === "sub_agent_timeout") {
      return maybeAppendTimeoutContinuationVisibility(input.result);
    }
    return input.result;
  }

  applyNonCompletedGeneratedSynthesis<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: NonCompletedTerminalSynthesisInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): NonCompletedTerminalSynthesisResult<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  > {
    return {
      result: this.finalizeGeneratedResult({
        reason: input.reason,
        result: input.generated.result,
      }),
      memoryFlushes:
        input.generated.memoryFlush === undefined
          ? []
          : [input.generated.memoryFlush],
      ...(input.generated.reduction !== undefined
        ? { reduction: input.generated.reduction }
        : {}),
      ...(input.generated.reductionSnapshot !== undefined
        ? { reductionSnapshot: input.generated.reductionSnapshot }
        : {}),
    };
  }

  mergeFinalSynthesisRepairResult<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: FinalSynthesisRepairMergeInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): NonCompletedTerminalSynthesis<
    TReduction,
    TReductionSnapshot,
    TMemoryFlush
  > {
    const reduction = input.repair.reduction ?? input.initial.reduction;
    const reductionSnapshot =
      input.repair.reductionSnapshot ?? input.initial.reductionSnapshot;
    const memoryFlush =
      input.repair.memoryFlush ?? input.initial.memoryFlush;
    return {
      result: input.repair.result,
      ...(reduction === undefined ? {} : { reduction }),
      ...(reductionSnapshot === undefined ? {} : { reductionSnapshot }),
      ...(memoryFlush === undefined ? {} : { memoryFlush }),
    };
  }

  closeoutRecordMode(reason: EngineCloseoutReason): TerminalCloseoutRecordMode {
    return reason === "completed_sub_agent_final" ? "if_absent" : "overwrite";
  }

  buildFinalResponse(result: GenerateTextResult): TerminalFinalResponse {
    return {
      text: result.text,
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    };
  }

  recordStickyCloseoutIfNeeded<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalStickyCloseoutInput,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): void {
    if (input.sticky) {
      target.recordToolLoopCloseoutIfAbsent(input.closeout);
    }
  }

  recordSynthesisEffects<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalSynthesisEffectsInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): void {
    for (const memoryFlush of input.memoryFlushes ?? []) {
      target.recordMemoryFlush(memoryFlush);
    }
    if (input.reduction !== undefined) {
      target.recordReduction({
        reduction: input.reduction,
        reductionSnapshot: input.reductionSnapshot,
      });
    }
  }

  applyCloseoutApplication<
    TReduction = unknown,
    TReductionSnapshot = unknown,
    TMemoryFlush = unknown,
  >(
    input: TerminalCloseoutApplicationInput<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
    target: TerminalCloseoutApplicationTarget<
      TReduction,
      TReductionSnapshot,
      TMemoryFlush
    >,
  ): TerminalFinalResponse {
    for (const memoryFlush of input.memoryFlushes ?? []) {
      target.recordMemoryFlush(memoryFlush);
    }

    if (this.closeoutRecordMode(input.reason) === "if_absent") {
      target.recordToolLoopCloseoutIfAbsent(input.closeout);
    } else {
      target.recordToolLoopCloseout(input.closeout);
    }
    target.recordCloseoutResult(input.result);
    if (input.reduction !== undefined) {
      target.recordReduction({
        reduction: input.reduction,
        reductionSnapshot: input.reductionSnapshot,
      });
    }
    return this.buildFinalResponse(input.result);
  }
}

export function createTerminalCloseoutController(): TerminalCloseoutController {
  return new TerminalCloseoutController();
}

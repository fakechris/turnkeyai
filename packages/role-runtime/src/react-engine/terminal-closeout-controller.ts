import type { ReActReArm } from "@turnkeyai/agent-core/react-loop";
import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";
import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import type { RolePromptPacket } from "../prompt-policy";
import type { ToolLoopCloseoutMetadata } from "../runtime-derived-mission-report";
import {
  buildApprovalWaitTimeoutLocalEvidenceCloseout,
  buildLocalEvidenceCloseout,
  maybeAppendTimeoutContinuationVisibility,
  maybeRedactForbiddenLocalUrls,
} from "../tool-loop-shared";
import type { CompletedCloseoutTerminalResult } from "./completed-closeout-controller";
import type { EngineCloseoutReason } from "./types";

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

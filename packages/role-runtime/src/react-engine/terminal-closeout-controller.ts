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
import type { EngineCloseoutReason } from "./types";

// Stage 8 engine cleanup — TerminalCloseoutController.
//
// Authority: own behavior-neutral terminal closeout assembly that does not call
// the model and does not mutate EngineRunState. The adapter still owns gateway
// calls and run-state recording while inline remains the parity reference.
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

  buildSynthesisMessages(input: TerminalSynthesisMessagesInput): LLMMessage[] {
    if (input.reason !== "pseudo_tool_call") {
      return input.messages;
    }
    return [
      ...input.messages,
      { role: "assistant", content: input.lastText },
    ];
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
}

export function createTerminalCloseoutController(): TerminalCloseoutController {
  return new TerminalCloseoutController();
}

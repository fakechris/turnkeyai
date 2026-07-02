import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { RolePromptPacket } from "../prompt-policy";
import type { ToolLoopCloseoutMetadata } from "../runtime-derived-mission-report";
import {
  buildApprovalWaitTimeoutLocalEvidenceCloseout,
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
}

export function createTerminalCloseoutController(): TerminalCloseoutController {
  return new TerminalCloseoutController();
}

import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildContinuationDirectiveContext,
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  hasLatestSupplementalLocalTimeoutProbePrompt,
  isAppliedApprovalBrowserContinuation,
  readStringInput,
} from "../tool-loop-shared";
import type { EngineContinueAction } from "./types";

// Stage 8 engine cleanup — ContinuationController.
//
// Current authority: own the first behavior-neutral continuation slice:
// empty-round sessions_send/sessions_list injection. Later Batch 2 slices move
// post-execute timeout probes, approved-browser continuation, independent
// evidence streams, and forced permission-result rounds here as typed actions.
//
// It does NOT own final-answer repairs, completed closeout synthesis, the
// normalizer order, or runtime progress recording. It returns actions; it does
// not mutate ReAct state.
export const CONTINUATION_CONTROLLER_MODULE = "continuation-controller" as const;

export interface ContinuationToolDefinition {
  name: string;
}

export interface EmptyRoundContinuationInput {
  active: boolean;
  messages: LLMMessage[];
  round: number;
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly ContinuationToolDefinition[];
}

export class ContinuationController {
  previewEmptyRoundContinuation(
    input: EmptyRoundContinuationInput,
  ): LLMToolCall | null {
    if (!input.active) {
      return null;
    }
    const probePending = hasLatestSupplementalLocalTimeoutProbePrompt(
      input.messages,
    );
    const continuationContext = buildContinuationDirectiveContext(
      input.taskPrompt,
      input.messages,
    );
    const contextualDirective = !probePending
      ? findSessionContinuationDirective(continuationContext)
      : null;
    const directive = probePending
      ? null
      : (contextualDirective ??
        findSessionContinuationDirective(input.taskPrompt));
    if (
      directive &&
      !hasExecutedSessionsSend(input.toolTrace, directive.sessionKey) &&
      hasToolDefinition(input.tools, "sessions_send")
    ) {
      return {
        id: `runtime-continuation-${input.round + 1}`,
        name: "sessions_send",
        input: {
          session_key: directive.sessionKey,
          message: directive.messageHint,
        },
      };
    }

    const lookupDirective =
      !probePending &&
      !directive &&
      !isAppliedApprovalBrowserContinuation(input.taskPrompt)
        ? findSessionContinuationLookupDirective(
            continuationContext,
            continuationContext,
          )
        : null;
    if (
      lookupDirective &&
      hasToolDefinition(input.tools, "sessions_list")
    ) {
      return {
        id: `runtime-continuation-lookup-${input.round + 1}`,
        name: "sessions_list",
        input: {
          limit: 5,
          reason: `continuation lookup: ${lookupDirective.messageHint}`,
        },
      };
    }
    return null;
  }

  onRoundEmpty(input: EmptyRoundContinuationInput): EngineContinueAction {
    const call = this.previewEmptyRoundContinuation(input);
    if (!call) {
      return { kind: "none" };
    }
    return {
      kind: "inject_calls",
      calls: [call],
      reason:
        call.name === "sessions_send"
          ? "empty_round_session_continuation"
          : "empty_round_session_lookup",
    };
  }
}

export function createContinuationController(): ContinuationController {
  return new ContinuationController();
}

function hasExecutedSessionsSend(
  toolTrace: NativeToolRoundTrace[],
  sessionKey: string,
): boolean {
  return toolTrace.some((round) =>
    round.calls.some(
      (call) =>
        call.name === "sessions_send" &&
        readStringInput(call.input, "session_key") === sessionKey,
    ),
  );
}

function hasToolDefinition(
  tools: readonly ContinuationToolDefinition[] | undefined,
  name: string,
): boolean {
  return (tools ?? []).some((tool) => tool.name === name);
}

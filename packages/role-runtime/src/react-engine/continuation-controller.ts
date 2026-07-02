import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildApprovedBrowserTimeoutContinuationPrompt,
  buildContinuationDirectiveContext,
  buildCoverageTimeoutContinuationPrompt,
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  hasExecutedSessionsSend,
  hasLatestSupplementalLocalTimeoutProbePrompt,
  isAppliedApprovalBrowserContinuation,
  shouldContinueTimedOutApprovedBrowserSession,
  shouldContinueTimedOutSiblingSession,
  type SubAgentToolTimeoutSignal,
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

export interface TimeoutContinuationInput {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  timeoutSignal: SubAgentToolTimeoutSignal | null;
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

  onAfterExecuteTimeoutContinuation(
    input: TimeoutContinuationInput,
  ): EngineContinueAction {
    const approvedBrowser = this.continueTimedOutApprovedBrowserSession(input);
    if (approvedBrowser.kind !== "none") {
      return approvedBrowser;
    }
    return this.continueTimedOutSiblingSession(input);
  }

  continueTimedOutApprovedBrowserSession(
    input: TimeoutContinuationInput,
  ): EngineContinueAction {
    if (
      !input.timeoutSignal ||
      !shouldContinueTimedOutApprovedBrowserSession({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        timeoutSignal: input.timeoutSignal,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      })
    ) {
      return { kind: "none" };
    }
    return {
      kind: "continue",
      messages: [
        ...input.messages,
        {
          role: "user",
          content: buildApprovedBrowserTimeoutContinuationPrompt(
            input.timeoutSignal,
          ),
        },
      ],
      forceToolChoice: { name: "sessions_send" },
      reason: "approved_browser_timeout_continuation",
    };
  }

  continueTimedOutSiblingSession(
    input: TimeoutContinuationInput,
  ): EngineContinueAction {
    if (
      !input.timeoutSignal ||
      !shouldContinueTimedOutSiblingSession({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        timeoutSignal: input.timeoutSignal,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      })
    ) {
      return { kind: "none" };
    }
    return {
      kind: "continue",
      messages: [
        ...input.messages,
        {
          role: "user",
          content: buildCoverageTimeoutContinuationPrompt(input.timeoutSignal),
        },
      ],
      forceToolChoice: { name: "sessions_send" },
      reason: "coverage_timeout_continuation",
    };
  }
}

export function createContinuationController(): ContinuationController {
  return new ContinuationController();
}

function hasToolDefinition(
  tools: readonly ContinuationToolDefinition[] | undefined,
  name: string,
): boolean {
  return (tools ?? []).some((tool) => tool.name === name);
}

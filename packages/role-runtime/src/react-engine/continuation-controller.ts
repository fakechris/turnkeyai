import type { ReActEmptyDecision } from "@turnkeyai/agent-core/react-loop";
import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildApprovedBrowserTimeoutContinuationPrompt,
  buildContinuationDirectiveContext,
  buildCoverageTimeoutContinuationPrompt,
  buildIncompleteApprovedBrowserSessionContinuationPrompt,
  buildIndependentEvidenceStreamContinuationPrompt,
  buildMissingApprovalGateRepairPrompt,
  buildSupplementalLocalTimeoutProbePrompt,
  buildForcedPendingApprovalWaitTimeoutPermissionResultCall,
  countCompletedSessionEvidenceResults,
  FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  findIncompleteApprovedBrowserSession,
  hasExecutedSessionsSend,
  hasLatestSupplementalLocalTimeoutProbePrompt,
  inferIndependentEvidenceStreamCount,
  isAppliedApprovalBrowserContinuation,
  shouldContinueTimedOutApprovedBrowserSession,
  shouldContinueTimedOutSiblingSession,
  shouldContinueIndependentEvidenceStreams,
  shouldRunSupplementalLocalTimeoutProbe,
  shouldRepairMissingApprovalGate,
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

export interface SupplementalLocalTimeoutProbeInput {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  evidenceText: string;
  completedSessionEvidence: boolean;
  timeoutSignal: SubAgentToolTimeoutSignal | null;
  tools?: readonly ContinuationToolDefinition[];
  browserAvailable: boolean;
}

export interface IncompleteApprovedBrowserSessionInput {
  results: readonly { toolName: string; content: string }[];
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly ContinuationToolDefinition[];
}

export interface IndependentEvidenceStreamsInput {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly ContinuationToolDefinition[];
}

export interface MissingApprovalGateRepairInput {
  messages: LLMMessage[];
  taskPrompt: string;
  resultText: string;
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly ContinuationToolDefinition[];
}

export interface ForcedPermissionResultInput {
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly ContinuationToolDefinition[];
}

export interface AfterExecuteContinuationInput {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  timeoutSignal: SubAgentToolTimeoutSignal | null;
  completedSessionFinalContents: readonly string[] | null;
  currentRoundEvidenceText: string;
  results: readonly { toolName: string; content: string }[];
  repairMarkers: LLMMessage[];
  tools?: readonly ContinuationToolDefinition[];
  browserAvailable: boolean;
}

export interface AfterExecuteContinuationEvidenceSnapshot {
  timeoutSignal: SubAgentToolTimeoutSignal | null;
  completedSessionFinalContents: readonly string[] | null;
  toolResultContentText: string;
}

export interface AfterExecuteContinuationEvidenceProvider {
  currentRound(results: ToolResult[]): AfterExecuteContinuationEvidenceSnapshot;
}

export interface AfterExecuteContinuationObserver {
  onProviderToolProtocolRound(input: {
    round: number;
    toolCalls: LLMToolCall[];
    toolResults: ToolResult[];
    messages: LLMMessage[];
  }): Promise<void>;
}

export interface AfterExecuteContinuationHookInput {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  results: ToolResult[];
  repairMarkers: LLMMessage[];
  tools?: readonly ContinuationToolDefinition[];
  browserAvailable: boolean;
  observer: AfterExecuteContinuationObserver;
  evidence: AfterExecuteContinuationEvidenceProvider;
}

type ContinueAction = Extract<EngineContinueAction, { kind: "continue" }>;

export interface ContinuationHookResult {
  messages: LLMMessage[];
  forceToolChoice?: NonNullable<ContinueAction["forceToolChoice"]>;
}

export interface ContinueActionApplicationOptions {
  recordRepairMarker?(marker: LLMMessage): void;
}

type ForcedToolRoundAction = Extract<
  EngineContinueAction,
  { kind: "forced_tool_round" }
>;

export type ForcedToolRoundExecutor = (
  input: ForcedToolRoundAction,
) => Promise<{
  messages: LLMMessage[];
}>;

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

  applyRoundEmptyAction(action: EngineContinueAction): ReActEmptyDecision {
    if (action.kind === "inject_calls") {
      return { injectedCalls: action.calls };
    }
    return "terminate";
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

  continueSupplementalLocalTimeoutProbe(
    input: SupplementalLocalTimeoutProbeInput,
  ): EngineContinueAction {
    if (
      !input.completedSessionEvidence &&
      (!input.timeoutSignal || input.timeoutSignal.agentId === "browser")
    ) {
      return { kind: "none" };
    }
    const probe = shouldRunSupplementalLocalTimeoutProbe({
      taskPrompt: input.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
      evidenceText: input.evidenceText,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      browserAvailable: input.browserAvailable,
    });
    if (!probe) {
      return { kind: "none" };
    }
    return {
      kind: "continue",
      messages: [
        ...input.messages,
        {
          role: "user",
          content: buildSupplementalLocalTimeoutProbePrompt(probe),
        },
      ],
      forceToolChoice: { name: "sessions_spawn" },
      reason: "supplemental_local_timeout_probe",
    };
  }

  continueIncompleteApprovedBrowserSession(
    input: IncompleteApprovedBrowserSessionInput,
  ): EngineContinueAction {
    const continuation = findIncompleteApprovedBrowserSession({
      results: input.results,
      taskPrompt: input.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    });
    if (!continuation) {
      return { kind: "none" };
    }
    return {
      kind: "continue",
      messages: [
        ...input.messages,
        {
          role: "user",
          content:
            buildIncompleteApprovedBrowserSessionContinuationPrompt(
              continuation,
            ),
        },
      ],
      forceToolChoice: { name: "sessions_send" },
      reason: "incomplete_approved_browser_session_continuation",
    };
  }

  continueIndependentEvidenceStreams(
    input: IndependentEvidenceStreamsInput,
  ): EngineContinueAction {
    if (
      !shouldContinueIndependentEvidenceStreams({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
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
          content: buildIndependentEvidenceStreamContinuationPrompt({
            requiredStreams: inferIndependentEvidenceStreamCount(
              input.taskPrompt,
            ),
            completedSessions: countCompletedSessionEvidenceResults(
              input.toolTrace,
            ),
          }),
        },
      ],
      forceToolChoice: { name: "sessions_spawn" },
      reason: "independent_evidence_stream_continuation",
    };
  }

  continueMissingApprovalGateRepair(
    input: MissingApprovalGateRepairInput,
  ): EngineContinueAction {
    if (
      !shouldRepairMissingApprovalGate({
        taskPrompt: input.taskPrompt,
        resultText: input.resultText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        toolTrace: input.toolTrace,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      })
    ) {
      return { kind: "none" };
    }
    const repairMarker: LLMMessage = {
      role: "user",
      content: buildMissingApprovalGateRepairPrompt(),
    };
    return {
      kind: "continue",
      messages: [...input.messages, repairMarker],
      forceToolChoice: { name: "permission_query" },
      repairMarker,
      reason: "missing_approval_gate_repair_continuation",
    };
  }

  forcePendingApprovalWaitTimeoutPermissionResult(
    input: ForcedPermissionResultInput,
  ): EngineContinueAction {
    const call = buildForcedPendingApprovalWaitTimeoutPermissionResultCall({
      taskPrompt: input.taskPrompt,
      toolTrace: input.toolTrace,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    });
    if (!call) {
      return { kind: "none" };
    }
    return {
      kind: "forced_tool_round",
      calls: [call],
      assistantText: FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
      reason: "forced_pending_approval_wait_timeout_permission_result",
    };
  }

  applyContinueAction(
    action: EngineContinueAction,
    options: ContinueActionApplicationOptions = {},
  ): ContinuationHookResult | null {
    if (action.kind !== "continue") {
      return null;
    }
    if (action.repairMarker) {
      options.recordRepairMarker?.(action.repairMarker);
    }
    return {
      messages: action.messages,
      ...(action.forceToolChoice === undefined
        ? {}
        : { forceToolChoice: action.forceToolChoice }),
    };
  }

  async applyForcedToolRoundContinuation(
    action: EngineContinueAction,
    executeForcedRound: ForcedToolRoundExecutor,
  ): Promise<{ messages: LLMMessage[] } | null> {
    if (action.kind !== "forced_tool_round") {
      return null;
    }
    return executeForcedRound(action);
  }

  async applyAfterExecuteContinuation(
    input: AfterExecuteContinuationInput,
    executeForcedRound: ForcedToolRoundExecutor,
  ): Promise<ContinuationHookResult | null> {
    const timeoutContinuation = this.onAfterExecuteTimeoutContinuation({
      messages: input.messages,
      taskPrompt: input.taskPrompt,
      toolTrace: input.toolTrace,
      timeoutSignal: input.timeoutSignal,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    });
    const timeoutContinuationResult =
      this.applyContinueAction(timeoutContinuation);
    if (timeoutContinuationResult) {
      return timeoutContinuationResult;
    }

    if (!input.completedSessionFinalContents) {
      const timeoutProbe = this.continueSupplementalLocalTimeoutProbe({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        evidenceText: input.currentRoundEvidenceText,
        completedSessionEvidence: false,
        timeoutSignal: input.timeoutSignal,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        browserAvailable: input.browserAvailable,
      });
      return this.applyContinueAction(timeoutProbe);
    }

    const completedEvidenceText =
      input.completedSessionFinalContents.join("\n\n");
    const supplementalLocalTimeoutProbe =
      this.continueSupplementalLocalTimeoutProbe({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        evidenceText: completedEvidenceText,
        completedSessionEvidence: true,
        timeoutSignal: input.timeoutSignal,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        browserAvailable: input.browserAvailable,
      });
    const supplementalLocalTimeoutProbeResult =
      this.applyContinueAction(supplementalLocalTimeoutProbe);
    if (supplementalLocalTimeoutProbeResult) {
      return supplementalLocalTimeoutProbeResult;
    }

    const incompleteApprovedBrowserSession =
      this.continueIncompleteApprovedBrowserSession({
        results: input.results,
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      });
    const incompleteApprovedBrowserSessionResult =
      this.applyContinueAction(incompleteApprovedBrowserSession);
    if (incompleteApprovedBrowserSessionResult) {
      return incompleteApprovedBrowserSessionResult;
    }

    const independentEvidenceStreams =
      this.continueIndependentEvidenceStreams({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      });
    const independentEvidenceStreamsResult =
      this.applyContinueAction(independentEvidenceStreams);
    if (independentEvidenceStreamsResult) {
      return independentEvidenceStreamsResult;
    }

    const missingApprovalGateRepair =
      this.continueMissingApprovalGateRepair({
        taskPrompt: input.taskPrompt,
        resultText: completedEvidenceText,
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        toolTrace: input.toolTrace,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      });
    const missingApprovalGateRepairResult = this.applyContinueAction(
      missingApprovalGateRepair,
      {
        recordRepairMarker: (marker) => {
          input.repairMarkers.push(marker);
        },
      },
    );
    if (missingApprovalGateRepairResult) {
      return missingApprovalGateRepairResult;
    }

    return this.applyForcedToolRoundContinuation(
      this.forcePendingApprovalWaitTimeoutPermissionResult({
        taskPrompt: input.taskPrompt,
        toolTrace: input.toolTrace,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      }),
      executeForcedRound,
    );
  }

  async applyAfterExecuteContinuationHook(
    input: AfterExecuteContinuationHookInput,
    executeForcedRound: ForcedToolRoundExecutor,
  ): Promise<ContinuationHookResult | null> {
    await input.observer.onProviderToolProtocolRound({
      round: input.toolTrace.length,
      toolCalls: input.results.map((result) => ({
        id: result.toolCallId,
        name: result.toolName,
        input: {},
      })),
      toolResults: input.results,
      messages: input.messages,
    });
    const roundEvidence = input.evidence.currentRound(input.results);
    return this.applyAfterExecuteContinuation(
      {
        messages: input.messages,
        taskPrompt: input.taskPrompt,
        toolTrace: input.toolTrace,
        timeoutSignal: roundEvidence.timeoutSignal,
        completedSessionFinalContents:
          roundEvidence.completedSessionFinalContents,
        currentRoundEvidenceText: roundEvidence.toolResultContentText,
        results: input.results,
        repairMarkers: input.repairMarkers,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        browserAvailable: input.browserAvailable,
      },
      executeForcedRound,
    );
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

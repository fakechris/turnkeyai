import type { ReActEmptyDecision } from "@turnkeyai/agent-core/react-loop";
import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildApprovedBrowserTimeoutContinuationPrompt,
  buildCoverageTimeoutContinuationPrompt,
  buildIncompleteApprovedBrowserSessionContinuationPrompt,
  buildIndependentEvidenceStreamContinuationPrompt,
  buildMissingApprovalGateRepairPrompt,
  buildRepeatedPartialSessionEvidenceCloseoutPrompt,
  buildSupplementalLocalTimeoutProbePrompt,
  buildForcedPendingApprovalWaitTimeoutPermissionResultCall,
  FORCED_PERMISSION_RESULT_ASSISTANT_TEXT,
} from "../runtime-policy/prompt-renderers";
import {
  buildContinuationDirectiveContext,
  normalizeUrlForComparison,
  readStringInput,
} from "../tool-protocol";
import { parseSessionToolResult } from "../session-tool-result-protocol";
import {
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  findIncompleteApprovedBrowserSession,
  hasExecutedSessionsSend,
  readCompletedSessionEvidence,
  shouldRunSupplementalLocalTimeoutProbe,
} from "../runtime-facts/text-fallback-readers";
import { hasLatestSupplementalLocalTimeoutProbePrompt } from "../runtime-facts/repair-marker-facts";
import type { SubAgentToolTimeoutSignal } from "../runtime-facts/text-fallback-readers";
import { produceTaskIntentEnvelope } from "../runtime-facts/task-intent-producer";
import {
  buildIndependentEvidenceStreamsPolicyFacts,
  buildMissingApprovalGateContinuationFacts,
  buildTimeoutContinuationPolicyFacts,
} from "../runtime-facts/continuation-policy-facts";
import {
  selectIndependentEvidenceStreamsPolicy,
  selectMissingApprovalGateContinuationPolicy,
  selectTimeoutContinuationPolicy,
} from "../runtime-policy/continuation-policy-core";
import type {
  CompletedSessionEvidenceFact,
  TimeoutEvidenceFact,
} from "./evidence-ledger";
import type { TaskFactsSnapshot } from "./task-facts";
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
  taskFacts?: TaskFactsSnapshot;
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
  taskFacts?: TaskFactsSnapshot;
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
  taskFacts?: TaskFactsSnapshot;
}

export interface AfterExecuteContinuationEvidenceSnapshot {
  timeoutSignals: readonly TimeoutEvidenceFact[];
  completedSessions: readonly CompletedSessionEvidenceFact[];
  roundEvidenceText: string;
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
  taskFacts?: TaskFactsSnapshot;
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

interface NamedEvidenceSourceSpec {
  label: string;
  url: string;
  agentId: "explore" | "browser";
  subject: string;
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
          ...(directive.label ? { label: directive.label } : {}),
        },
      };
    }

    const lookupDirective =
      !probePending &&
      !directive &&
      !appliedApprovalBrowserContinuationRequested(input)
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

  applyRoundEmptyHook(input: EmptyRoundContinuationInput): ReActEmptyDecision {
    return this.applyRoundEmptyAction(this.onRoundEmpty(input));
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
    const facts = buildTimeoutContinuationPolicyFacts(input);
    const decision = selectTimeoutContinuationPolicy({ facts });
    if (
      !input.timeoutSignal ||
      decision.policyId !== "approved_browser_timeout_continuation"
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
    const facts = buildTimeoutContinuationPolicyFacts(input);
    const decision = selectTimeoutContinuationPolicy({ facts });
    if (
      !input.timeoutSignal ||
      decision.policyId !== "coverage_timeout_continuation"
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
    const facts = buildIndependentEvidenceStreamsPolicyFacts(input);
    const decision = selectIndependentEvidenceStreamsPolicy({ facts });
    if (decision.kind !== "continue") {
      return { kind: "none" };
    }
    const forcedMissingSource = buildForcedMissingNamedEvidenceSourceCall(input);
    if (forcedMissingSource) {
      return {
        kind: "forced_tool_round",
        calls: [forcedMissingSource],
        assistantText:
          "Runtime correction: continuing the missing named evidence stream before final synthesis.",
        reason: "missing_named_independent_evidence_stream",
      };
    }
    return {
      kind: "continue",
      messages: [
        ...input.messages,
        {
          role: "user",
          content: buildIndependentEvidenceStreamContinuationPrompt({
            requiredStreams: facts.requiredStreams,
            completedSessions: facts.completedSessions,
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
    const decision = selectMissingApprovalGateContinuationPolicy({
      facts: buildMissingApprovalGateContinuationFacts(input),
    });
    if (decision.kind !== "continue") {
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
    const repeatedPartialEvidence =
      findPartialSessionSendCloseoutEvidence(input);
    if (repeatedPartialEvidence) {
      return {
        messages: [
          ...input.messages,
          {
            role: "user",
            content: buildRepeatedPartialSessionEvidenceCloseoutPrompt({
              evidenceText: repeatedPartialEvidence.evidenceText,
              repeated: repeatedPartialEvidence.repeated,
            }),
          },
        ],
        forceToolChoice: "none",
      };
    }

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
        ...(input.taskFacts === undefined ? {} : { taskFacts: input.taskFacts }),
      });
    const forcedIndependentEvidenceStreamsResult =
      await this.applyForcedToolRoundContinuation(
        independentEvidenceStreams,
        executeForcedRound,
      );
    if (forcedIndependentEvidenceStreamsResult) {
      return forcedIndependentEvidenceStreamsResult;
    }
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
        timeoutSignal: roundEvidence.timeoutSignals[0] ?? null,
        completedSessionFinalContents:
          collectCompletedSessionFinalContents(roundEvidence.completedSessions),
        currentRoundEvidenceText: roundEvidence.roundEvidenceText,
        results: input.results,
        repairMarkers: input.repairMarkers,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
        browserAvailable: input.browserAvailable,
        ...(input.taskFacts === undefined ? {} : { taskFacts: input.taskFacts }),
      },
      executeForcedRound,
    );
  }
}

function findPartialSessionSendCloseoutEvidence(
  input: Pick<AfterExecuteContinuationInput, "results" | "taskPrompt" | "toolTrace">,
): { evidenceText: string; repeated: boolean } | null {
  for (const result of input.results) {
    if (result.toolName !== "sessions_send") {
      continue;
    }
    const parsed = parseSessionToolResult(result.content);
    if (!parsed || parsed.status !== "partial") {
      continue;
    }
    const sessionKey = parsed.session_key;
    const currentToolCallId = readResultToolCallId(result);
    const repeated = previousSessionsSendExists(input.toolTrace, {
      sessionKey,
      ...(currentToolCallId === undefined ? {} : { currentToolCallId }),
    });
    if (!repeated && !isSessionSynthesisFollowupTask(input.taskPrompt)) {
      continue;
    }
    const evidence = readCompletedSessionEvidence(parsed);
    if (evidence) {
      return { evidenceText: evidence, repeated };
    }
  }
  return null;
}

function readResultToolCallId(result: { toolName: string; content: string }): string | undefined {
  const value = (result as { toolCallId?: unknown }).toolCallId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isSessionSynthesisFollowupTask(taskPrompt: string): boolean {
  const asksForSynthesis =
    /\b(?:decision note|synthesi[sz]e|turn (?:the )?evidence into|turn .* notes into|revisit .* notes|source[- ]bounded final|product lead)\b/i.test(
      taskPrompt,
    );
  if (!asksForSynthesis) {
    return false;
  }
  return /\b(?:same|previous|earlier|existing|prior)\b[\s\S]{0,120}\b(?:research thread|thread|session|research|notes|evidence|work)\b|\b(?:research thread|thread|session|research|notes|evidence|work)\b[\s\S]{0,120}\b(?:same|previous|earlier|existing|prior)\b/i.test(
    taskPrompt,
  );
}

function previousSessionsSendExists(
  toolTrace: readonly NativeToolRoundTrace[],
  input: { sessionKey: string; currentToolCallId?: string | null },
): boolean {
  let sendCount = 0;
  let currentRecorded = false;
  for (const round of toolTrace) {
    for (const call of round.calls) {
      if (
        call.name !== "sessions_send" ||
        readStringInput(call.input, "session_key") !== input.sessionKey
      ) {
        continue;
      }
      sendCount += 1;
      if (input.currentToolCallId && call.id === input.currentToolCallId) {
        currentRecorded = true;
      }
    }
  }
  return sendCount - (currentRecorded ? 1 : 0) > 0;
}

function buildForcedMissingNamedEvidenceSourceCall(
  input: IndependentEvidenceStreamsInput,
): LLMToolCall | null {
  if (!hasToolDefinition(input.tools, "sessions_spawn")) {
    return null;
  }
  const sources = extractNamedEvidenceSourceSpecs(input.taskPrompt);
  if (sources.length < 3) {
    return null;
  }
  const completedTexts = collectCompletedSessionResultTexts(input.toolTrace);
  const missing = sources.filter(
    (source) => !sourceEvidenceTextsMatch(completedTexts, source),
  );
  if (missing.length !== 1) {
    return null;
  }
  const [missingSource] = missing;
  if (missingSource?.agentId !== "browser" || !isLiveBrowserSource(missingSource)) {
    return null;
  }
  const matchedCount = sources.length - missing.length;
  if (matchedCount < sources.length - 1) {
    return null;
  }
  const source = missingSource;
  return {
    id: `runtime-independent-source-${input.toolTrace.length + 1}`,
    name: "sessions_spawn",
    input: {
      agent_id: source.agentId,
      label: source.label,
      task: buildNamedEvidenceSourceTask(source),
    },
  };
}

function extractNamedEvidenceSourceSpecs(taskPrompt: string): NamedEvidenceSourceSpec[] {
  const specs: NamedEvidenceSourceSpec[] = [];
  for (const line of taskPrompt.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:[-*]\s*)?([^:\n]{3,80}?(?:source|dashboard))\s*:\s*(https?:\/\/\S+)/i,
    );
    const rawLabel = match?.[1]?.trim();
    const rawUrl = match?.[2]?.replace(/[.,;]+$/, "");
    if (!rawLabel || !rawUrl) {
      continue;
    }
    const agentId: "explore" | "browser" =
      /\b(?:browser|rendered|visible|dashboard|live readiness|signal dashboard)\b/i.test(
        rawLabel,
      )
        ? "browser"
        : "explore";
    specs.push({
      label: normalizeEvidenceSourceLabel(rawLabel),
      url: rawUrl,
      agentId,
      subject: evidenceSourceSubject(rawLabel, rawUrl),
    });
  }
  return dedupeNamedEvidenceSourceSpecs(specs).slice(0, 6);
}

function normalizeEvidenceSourceLabel(rawLabel: string): string {
  const label = rawLabel
    .replace(/\bsource\b/gi, "stream")
    .replace(/\bdashboard\b/gi, "dashboard stream")
    .replace(/\s+/g, " ")
    .trim();
  return /\bstream\b/i.test(label) ? label : `${label} Stream`;
}

function evidenceSourceSubject(rawLabel: string, rawUrl: string): string {
  const labelSubject = rawLabel
    .replace(/\b(?:source|dashboard|stream)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (labelSubject) {
    return labelSubject;
  }
  try {
    return (
      new URL(rawUrl).pathname
        .split("/")
        .filter(Boolean)
        .at(-1)
        ?.replace(/[-_]+/g, " ")
        .toLowerCase() ?? ""
    );
  } catch {
    return "";
  }
}

function dedupeNamedEvidenceSourceSpecs(
  specs: NamedEvidenceSourceSpec[],
): NamedEvidenceSourceSpec[] {
  const seen = new Set<string>();
  const deduped: NamedEvidenceSourceSpec[] = [];
  for (const spec of specs) {
    const key = normalizeUrlForComparison(spec.url).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(spec);
  }
  return deduped;
}

function collectCompletedSessionResultTexts(
  toolTrace: NativeToolRoundTrace[],
): string[] {
  const texts: string[] = [];
  for (const round of toolTrace) {
    for (const result of round.results) {
      if (
        result.toolName !== "sessions_spawn" &&
        result.toolName !== "sessions_send"
      ) {
        continue;
      }
      if (!result.content) {
        continue;
      }
      const parsed = parseSessionToolResult(result.content);
      if (!parsed || parsed.status !== "completed") {
        continue;
      }
      texts.push(
        [
          parsed.label ?? "",
          parsed.evidence_summary ?? "",
          parsed.result,
          parsed.final_content ?? "",
          stringifyPayload(parsed.payload),
        ].join("\n"),
      );
    }
  }
  return texts;
}

function sourceEvidenceTextMatches(
  evidenceText: string,
  source: NamedEvidenceSourceSpec,
): boolean {
  const normalizedEvidence = evidenceText.toLowerCase();
  const normalizedUrl = normalizeUrlForComparison(source.url).toLowerCase();
  if (normalizedUrl && normalizedEvidence.includes(normalizedUrl)) {
    return true;
  }
  try {
    const pathname = new URL(source.url).pathname.toLowerCase();
    if (pathname && normalizedEvidence.includes(pathname)) {
      return true;
    }
  } catch {
    // Source specs are parsed from URL lines; ignore malformed leftovers.
  }
  return Boolean(source.subject && normalizedEvidence.includes(source.subject));
}

function sourceEvidenceTextsMatch(
  completedTexts: readonly string[],
  source: NamedEvidenceSourceSpec,
): boolean {
  return completedTexts.some((text) => sourceEvidenceTextMatches(text, source));
}

function isLiveBrowserSource(source: NamedEvidenceSourceSpec): boolean {
  return /\b(?:live|dashboard|signal|readiness|browser)\b/i.test(
    `${source.label} ${source.subject}`,
  );
}

function buildNamedEvidenceSourceTask(source: NamedEvidenceSourceSpec): string {
  const action =
    source.agentId === "browser"
      ? "Inspect the rendered page as browser-visible evidence."
      : "Collect source-backed facts from this source.";
  return [
    action,
    `Source URL: ${source.url}`,
    `Evidence stream label: ${source.label}`,
    "Return only verified facts for this source, explicit unverified scope, residual risk, and source URL.",
  ].join("\n");
}

function stringifyPayload(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return "";
  }
}

function appliedApprovalBrowserContinuationRequested(input: {
  taskFacts?: TaskFactsSnapshot;
  taskPrompt: string;
}): boolean {
  return (
    input.taskFacts?.appliedApprovalBrowserContinuation ??
    produceTaskIntentEnvelope({
      taskPrompt: input.taskPrompt,
      messages: [],
    }).facts.appliedApprovalBrowserContinuation
  );
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

function collectCompletedSessionFinalContents(
  completedSessions: readonly CompletedSessionEvidenceFact[],
): readonly string[] | null {
  const finalContents = completedSessions.flatMap((session) => session.finalContents);
  return finalContents.length > 0 ? finalContents : null;
}

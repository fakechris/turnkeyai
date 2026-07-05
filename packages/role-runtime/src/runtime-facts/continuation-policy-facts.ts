import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  countCompletedSessionEvidenceResults,
  readPolicyIndependentEvidenceStreamCount,
  readPolicyIndependentEvidenceStreamsContinuation,
  readPolicyTimedOutApprovedBrowserSessionContinuation,
  readPolicyTimedOutSiblingSessionContinuation,
  readPolicyMissingApprovalGateRepair,
} from "./text-fallback-readers";
import type { SubAgentToolTimeoutSignal } from "./text-fallback-readers";
import type { TaskIntentFacts } from "./types";

export interface ContinuationToolDefinitionFact {
  name: string;
}

export interface TimeoutContinuationFactInput {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  timeoutSignal: SubAgentToolTimeoutSignal | null;
  tools?: readonly ContinuationToolDefinitionFact[] | undefined;
}

export interface TimeoutContinuationPolicyFacts {
  timedOutApprovedBrowserSession: boolean;
  timedOutSiblingSession: boolean;
}

export interface IndependentEvidenceStreamsFactInput {
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly ContinuationToolDefinitionFact[] | undefined;
  taskFacts?: TaskIntentFacts | undefined;
}

export interface IndependentEvidenceStreamsPolicyFacts {
  independentEvidenceStreams: boolean;
  requiredStreams: number;
  completedSessions: number;
}

export interface MissingApprovalGateContinuationFactInput {
  messages: LLMMessage[];
  taskPrompt: string;
  resultText: string;
  repairMarkers: readonly LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  tools?: readonly ContinuationToolDefinitionFact[] | undefined;
}

export interface MissingApprovalGateContinuationFacts {
  missingApprovalGate: boolean;
}

export function buildTimeoutContinuationPolicyFacts(
  input: TimeoutContinuationFactInput,
): TimeoutContinuationPolicyFacts {
  if (!input.timeoutSignal) {
    return {
      timedOutApprovedBrowserSession: false,
      timedOutSiblingSession: false,
    };
  }
  return {
    timedOutApprovedBrowserSession: readPolicyTimedOutApprovedBrowserSessionContinuation(
      {
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        timeoutSignal: input.timeoutSignal,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      },
    ),
    timedOutSiblingSession: readPolicyTimedOutSiblingSessionContinuation({
      taskPrompt: input.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
      timeoutSignal: input.timeoutSignal,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    }),
  };
}

export function buildIndependentEvidenceStreamsPolicyFacts(
  input: IndependentEvidenceStreamsFactInput,
): IndependentEvidenceStreamsPolicyFacts {
  const requiredStreams =
    input.taskFacts?.requiredIndependentEvidenceStreams ??
    readPolicyIndependentEvidenceStreamCount(input.taskPrompt);
  return {
    independentEvidenceStreams:
      requiredStreams >= 2 &&
      readPolicyIndependentEvidenceStreamsContinuation({
        taskPrompt: input.taskPrompt,
        messages: input.messages,
        toolTrace: input.toolTrace,
        ...(input.tools === undefined ? {} : { tools: input.tools }),
      }),
    requiredStreams,
    completedSessions: countCompletedSessionEvidenceResults(input.toolTrace),
  };
}

export function buildMissingApprovalGateContinuationFacts(
  input: MissingApprovalGateContinuationFactInput,
): MissingApprovalGateContinuationFacts {
  return {
    missingApprovalGate: readPolicyMissingApprovalGateRepair({
      taskPrompt: input.taskPrompt,
      resultText: input.resultText,
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      toolTrace: input.toolTrace,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    }),
  };
}

import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import {
  countNativeToolCalls,
  type NativeToolRoundTrace,
} from "../native-tool-messages";
import { buildContinuationDirectiveContext } from "../tool-protocol";
import {
  applySessionContinuationDirective,
  applySessionContinuationLookupDirective,
} from "../runtime-policy/prompt-renderers";
import { normalizeSessionToolAliasCalls, normalizeSessionToolCalls } from "../tool-protocol";
import {
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  limitIndependentEvidenceSpawnCalls,
  normalizeBoundedTimeoutDuplicateSourceSpawns,
  normalizeBoundedTimeoutSourceSpawnAgents,
  normalizeExplicitContinuationHistoryCalls,
  normalizeLocalUrlWebFetchCalls,
  normalizePrivateUrlResearchSpawnCalls,
  type SessionContinuationDirective,
  type SessionContinuationLookupDirective,
} from "../runtime-facts/text-fallback-readers";
import { hasLatestSupplementalLocalTimeoutProbePrompt } from "../runtime-facts/repair-marker-facts";
import { produceTaskIntentEnvelope } from "../runtime-facts/task-intent-producer";
import type { PermissionPolicy } from "./permission-policy";
import type { TaskFactsSnapshot } from "./task-facts";
import type {
  ExecutionBudgetController,
  RecoveryToolBudget,
} from "./execution-budget-controller";

// Stage 8 engine cleanup — ToolCallNormalizer.
//
// Authority: syntactic aliases and stable session-handle/schema translation.
// Business routing, permission substitution, continuation injection, and
// evidence-topology rewrites are proposals owned by the model or an explicit
// workflow, not normalizer authority.
export const TOOL_CALL_NORMALIZER_MODULE = "tool-call-normalizer" as const;

/**
 * Context a tool-call normalization step may read. Built once per round by the
 * engine's onToolCalls hook so every step sees the same pre-resolved values.
 */
export interface ToolCallNormalizationContext {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  repairMarkers: LLMMessage[];
  sessionContinuationContext: string;
  sessionContinuationDirective: SessionContinuationDirective | null;
  sessionContinuationLookupDirective: SessionContinuationLookupDirective | null;
  browserAvailable: boolean;
  exploreAvailable: boolean;
  taskFacts?: TaskFactsSnapshot;
  permissionPolicy?: PermissionPolicy;
  testOnlyCharacterizeRetiredPolicies?: true;
}

export interface ToolCallNormalizationContextInput {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  repairMarkers: LLMMessage[];
  capabilityInspection?: { availableWorkers?: readonly string[] };
  taskFacts?: TaskFactsSnapshot;
  permissionPolicy?: PermissionPolicy;
  testOnlyCharacterizeRetiredPolicies?: true;
}

export interface ToolCallNormalizationStep {
  name: string;
  apply(calls: LLMToolCall[], ctx: ToolCallNormalizationContext): LLMToolCall[];
}

export interface EngineToolCallsHookInput {
  active: boolean;
  calls: LLMToolCall[];
  messages: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  repairMarkers: LLMMessage[];
  permissionPolicy: PermissionPolicy;
  executionBudget: Pick<ExecutionBudgetController, "truncateForRecoveryBudget">;
  recoveryToolBudget: RecoveryToolBudget | null;
  recoveryToolCallsBeforeActivation: number;
  capabilityInspection?: { availableWorkers?: readonly string[] };
  taskFacts?: TaskFactsSnapshot;
  testOnlyCharacterizeRetiredPolicies?: true;
}

/**
 * The engine's slice of the inline tool-call normalization pipeline, declared as
 * data so the order is explicit and table-test-assertable.
 *
 * Both steps preserve the model-proposed effect semantics. Semantic duplicate
 * effects are handled by the effect ledger using stable ids.
 */
const ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE: ToolCallNormalizationStep[] = [
  { name: "sessionToolAlias", apply: (c) => normalizeSessionToolAliasCalls(c) },
  {
    name: "sessionToolCalls",
    apply: (c, x) => normalizeSessionToolCalls(c, x.sessionContinuationContext),
  },
];

const RETIRED_TOOL_CALL_NORMALIZATION_CHARACTERIZATION: ToolCallNormalizationStep[] = [
  ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE[0]!,
  {
    name: "enforceMissingApprovalGateRepair",
    apply: (c, x) =>
      x.permissionPolicy?.normalizeMissingApprovalGateRepair({
        calls: c,
        messages: x.messages,
        repairMarkers: x.repairMarkers,
        taskPrompt: x.taskPrompt,
        toolTrace: x.toolTrace,
        sessionContext: x.sessionContinuationContext,
      }) ?? c,
  },
  {
    name: "sessionContinuationDirective",
    apply: (c, x) => applySessionContinuationDirective(c, x.sessionContinuationDirective),
  },
  {
    name: "sessionContinuationLookupDirective",
    apply: (c, x) =>
      applySessionContinuationLookupDirective(c, x.sessionContinuationLookupDirective),
  },
  {
    name: "explicitContinuationHistory",
    apply: (c, x) => normalizeExplicitContinuationHistoryCalls(c, x.taskPrompt),
  },
  ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE[1]!,
  {
    name: "privateUrlResearchSpawn",
    apply: (c, x) =>
      normalizePrivateUrlResearchSpawnCalls(c, {
        browserAvailable: x.browserAvailable,
        taskPrompt: x.taskPrompt,
      }),
  },
  {
    name: "localUrlWebFetch",
    apply: (c, x) => normalizeLocalUrlWebFetchCalls(c, { taskPrompt: x.taskPrompt }),
  },
  {
    name: "boundedTimeoutSourceSpawn",
    apply: (c, x) =>
      normalizeBoundedTimeoutSourceSpawnAgents(c, {
        exploreAvailable: x.exploreAvailable,
        taskPrompt: x.taskPrompt,
      }),
  },
  {
    name: "boundedTimeoutDuplicateSourceSpawn",
    apply: (c, x) => normalizeBoundedTimeoutDuplicateSourceSpawns(c, { taskPrompt: x.taskPrompt }),
  },
  {
    name: "sessionContinuationDirectiveRepeat",
    apply: (c, x) => applySessionContinuationDirective(c, x.sessionContinuationDirective),
  },
  {
    name: "approvalGatedBrowserSpawn",
    apply: (c, x) =>
      x.permissionPolicy?.normalizeApprovalGatedBrowserSpawn({
        calls: c,
        messages: x.messages,
        repairMarkers: x.repairMarkers,
        taskPrompt: x.taskPrompt,
        sessionContext: x.sessionContinuationContext,
        toolTrace: x.toolTrace,
      }) ?? c,
  },
  {
    name: "limitIndependentEvidenceSpawn",
    apply: (c, x) =>
      x.taskFacts && x.taskFacts.requiredIndependentEvidenceStreams < 2
        ? c
        : limitIndependentEvidenceSpawnCalls(c, {
            taskPrompt: x.taskPrompt,
            toolTrace: x.toolTrace,
          }),
  },
];

export const ENGINE_TOOL_CALL_NORMALIZATION_ORDER: readonly string[] =
  ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE.map((step) => step.name);

export function buildToolCallNormalizationContext(
  input: ToolCallNormalizationContextInput,
): ToolCallNormalizationContext {
  const sessionContinuationContext = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  const availableWorkers = input.capabilityInspection?.availableWorkers ?? [];
  const probePending = input.testOnlyCharacterizeRetiredPolicies
    ? hasLatestSupplementalLocalTimeoutProbePrompt(input.messages)
    : false;
  const continuationDirective =
    input.testOnlyCharacterizeRetiredPolicies && !probePending
      ? findSessionContinuationDirective(sessionContinuationContext) ??
        findSessionContinuationDirective(input.taskPrompt)
      : null;
  return {
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
    repairMarkers: input.repairMarkers,
    sessionContinuationContext,
    sessionContinuationDirective: continuationDirective,
    sessionContinuationLookupDirective:
      input.testOnlyCharacterizeRetiredPolicies &&
      !probePending &&
      !continuationDirective &&
      !hasSuccessfulSessionListResult(input.toolTrace) &&
      !appliedApprovalBrowserContinuationRequested(input)
        ? findSessionContinuationLookupDirective(
            sessionContinuationContext,
            sessionContinuationContext,
          )
        : null,
    browserAvailable: availableWorkers.includes("browser"),
    exploreAvailable: availableWorkers.includes("explore"),
    ...(input.taskFacts === undefined ? {} : { taskFacts: input.taskFacts }),
    ...(input.permissionPolicy === undefined
      ? {}
      : { permissionPolicy: input.permissionPolicy }),
    ...(input.testOnlyCharacterizeRetiredPolicies
      ? { testOnlyCharacterizeRetiredPolicies: true as const }
      : {}),
  };
}

function hasSuccessfulSessionListResult(
  toolTrace: NativeToolRoundTrace[],
): boolean {
  return toolTrace.some((round) =>
    round.results.some(
      (result) =>
        result.toolName === "sessions_list" &&
        !result.isError &&
        !result.cancelled &&
        !result.skipped,
    ),
  );
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

export function normalizeEngineToolCalls(
  calls: LLMToolCall[],
  ctx: ToolCallNormalizationContext,
): LLMToolCall[] {
  const pipeline = ctx.testOnlyCharacterizeRetiredPolicies
    ? RETIRED_TOOL_CALL_NORMALIZATION_CHARACTERIZATION
    : ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE;
  return pipeline.reduce(
    (acc, step) => step.apply(acc, ctx),
    calls,
  );
}

export function applyEngineToolCallsHook(
  input: EngineToolCallsHookInput,
): LLMToolCall[] {
  if (!input.active) {
    return input.calls;
  }
  const normalized = normalizeEngineToolCalls(
    input.calls,
    buildToolCallNormalizationContext({
      taskPrompt: input.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
      repairMarkers: input.repairMarkers,
      permissionPolicy: input.permissionPolicy,
      ...(input.capabilityInspection === undefined
        ? {}
        : { capabilityInspection: input.capabilityInspection }),
      ...(input.taskFacts === undefined ? {} : { taskFacts: input.taskFacts }),
      ...(input.testOnlyCharacterizeRetiredPolicies
        ? { testOnlyCharacterizeRetiredPolicies: true as const }
        : {}),
    }),
  );
  return input.executionBudget.truncateForRecoveryBudget({
    calls: normalized,
    recoveryToolBudget: input.recoveryToolBudget,
    usedToolCalls:
      input.recoveryToolCallsBeforeActivation +
      countNativeToolCalls(input.toolTrace),
  });
}

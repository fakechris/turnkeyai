import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import {
  countNativeToolCalls,
  type NativeToolRoundTrace,
} from "../native-tool-messages";
import {
  applySessionContinuationDirective,
  applySessionContinuationLookupDirective,
} from "../runtime-policy/prompt-renderers";
import { buildContinuationDirectiveContext } from "../tool-protocol";
import {
  enforceSupplementalLocalTimeoutProbeToolCall,
  findSessionContinuationDirective,
  findSessionContinuationLookupDirective,
  limitIndependentEvidenceSpawnCalls,
  normalizeBoundedTimeoutDuplicateSourceSpawns,
  normalizeBoundedTimeoutSourceSpawnAgents,
  normalizeExplicitContinuationHistoryCalls,
  normalizeLocalUrlWebFetchCalls,
  normalizePrivateUrlResearchSpawnCalls,
} from "../runtime-facts/text-fallback-readers";
import { hasLatestSupplementalLocalTimeoutProbePrompt } from "../runtime-facts/repair-marker-facts";
import { normalizeSessionToolAliasCalls, normalizeSessionToolCalls } from "../tool-protocol";
import type { SessionContinuationDirective, SessionContinuationLookupDirective } from "../runtime-facts/text-fallback-readers";
import { produceTaskIntentEnvelope } from "../runtime-facts/task-intent-producer";
import {
  createPermissionPolicy,
  type PermissionPolicy,
} from "./permission-policy";
import type { TaskFactsSnapshot } from "./task-facts";
import type {
  ExecutionBudgetController,
  RecoveryToolBudget,
} from "./execution-budget-controller";
import { applyBoundedSourceCheckTimeoutBudget } from "./session-timeout-budget";

// Stage 8 engine cleanup — ToolCallNormalizer.
//
// Authority: own syntactic and routing normalization before execution and
// preserve the current ENGINE_TOOL_CALL_NORMALIZATION_ORDER. Shared helpers now
// live in concrete fact/render/protocol modules so the inline reference loop and
// this engine module call the same implementation without importing from each
// other.
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
}

export interface ToolCallNormalizationContextInput {
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  repairMarkers: LLMMessage[];
  capabilityInspection?: { availableWorkers?: readonly string[] };
  taskFacts?: TaskFactsSnapshot;
  permissionPolicy?: PermissionPolicy;
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
}

/**
 * The engine's slice of the inline tool-call normalization pipeline, declared as
 * data so the order is explicit and table-test-assertable.
 *
 * Applies engine normalization in dependency order:
 *   1. normalizeSessionToolAliasCalls
 *   2. enforceMissingApprovalGateRepairToolCalls
 *   3. applySessionContinuationDirective
 *   4. applySessionContinuationLookupDirective
 *   5. normalizeExplicitContinuationHistoryCalls
 *   6. normalizeSessionToolCalls
 *   7. normalizePrivateUrlResearchSpawnCalls
 *   8. normalizeLocalUrlWebFetchCalls
 *   9. normalizeBoundedTimeoutSourceSpawnAgents
 *  10. applyBoundedSourceCheckTimeoutBudget
 *  11. enforceSupplementalLocalTimeoutProbeToolCall
 *  12. normalizeBoundedTimeoutDuplicateSourceSpawns
 *  13. applySessionContinuationDirective (repeat)
 *  14. normalizeApprovalGatedBrowserSpawnCalls
 *  15. limitIndependentEvidenceSpawnCalls
 */
const ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE: ToolCallNormalizationStep[] = [
  { name: "sessionToolAlias", apply: (c) => normalizeSessionToolAliasCalls(c) },
  {
    name: "enforceMissingApprovalGateRepair",
    apply: (c, x) =>
      resolvePermissionPolicy(x).normalizeMissingApprovalGateRepair({
        calls: c,
        messages: x.messages,
        repairMarkers: x.repairMarkers,
        taskPrompt: x.taskPrompt,
        toolTrace: x.toolTrace,
        sessionContext: x.sessionContinuationContext,
      }),
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
  {
    name: "sessionToolCalls",
    apply: (c, x) => normalizeSessionToolCalls(c, x.sessionContinuationContext),
  },
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
    name: "boundedSourceTimeoutBudget",
    apply: (c, x) =>
      applyBoundedSourceCheckTimeoutBudget(c, {
        toolTrace: x.toolTrace,
        ...(x.taskFacts === undefined ? {} : { taskFacts: x.taskFacts }),
      }),
  },
  {
    name: "supplementalLocalTimeoutProbe",
    apply: (c, x) => enforceSupplementalLocalTimeoutProbeToolCall(c, x.messages),
  },
  {
    name: "boundedTimeoutDuplicateSourceSpawn",
    apply: (c, x) =>
      normalizeBoundedTimeoutDuplicateSourceSpawns(c, { taskPrompt: x.taskPrompt }),
  },
  {
    name: "sessionContinuationDirectiveRepeat",
    apply: (c, x) => applySessionContinuationDirective(c, x.sessionContinuationDirective),
  },
  {
    name: "approvalGatedBrowserSpawn",
    apply: (c, x) =>
      resolvePermissionPolicy(x).normalizeApprovalGatedBrowserSpawn({
        calls: c,
        messages: x.messages,
        repairMarkers: x.repairMarkers,
        taskPrompt: x.taskPrompt,
        sessionContext: x.sessionContinuationContext,
        toolTrace: x.toolTrace,
      }),
  },
  {
    name: "limitIndependentEvidenceSpawn",
    apply: (c, x) => {
      if (
        x.taskFacts &&
        x.taskFacts.requiredIndependentEvidenceStreams < 2
      ) {
        return c;
      }
      return limitIndependentEvidenceSpawnCalls(c, {
        taskPrompt: x.taskPrompt,
        toolTrace: x.toolTrace,
      });
    },
  },
];

const DEFAULT_PERMISSION_POLICY = createPermissionPolicy();

function resolvePermissionPolicy(
  ctx: ToolCallNormalizationContext,
): PermissionPolicy {
  return ctx.permissionPolicy ?? DEFAULT_PERMISSION_POLICY;
}

export const ENGINE_TOOL_CALL_NORMALIZATION_ORDER: readonly string[] =
  ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE.map((step) => step.name);

export function buildToolCallNormalizationContext(
  input: ToolCallNormalizationContextInput,
): ToolCallNormalizationContext {
  const probePending = hasLatestSupplementalLocalTimeoutProbePrompt(
    input.messages,
  );
  const sessionContinuationContext = buildContinuationDirectiveContext(
    input.taskPrompt,
    input.messages,
  );
  const contextualDirective = !probePending
    ? findSessionContinuationDirective(sessionContinuationContext)
    : null;
  const sessionContinuationDirective = probePending
    ? null
    : (contextualDirective ??
      findSessionContinuationDirective(input.taskPrompt));
  const sessionContinuationLookupDirective =
    !probePending &&
    !sessionContinuationDirective &&
    !hasSuccessfulSessionListResult(input.toolTrace) &&
    !appliedApprovalBrowserContinuationRequested(input)
      ? findSessionContinuationLookupDirective(
          sessionContinuationContext,
          sessionContinuationContext,
        )
      : null;
  const availableWorkers = input.capabilityInspection?.availableWorkers ?? [];
  return {
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
    repairMarkers: input.repairMarkers,
    sessionContinuationContext,
    sessionContinuationDirective,
    sessionContinuationLookupDirective,
    browserAvailable: availableWorkers.includes("browser"),
    exploreAvailable: availableWorkers.includes("explore"),
    ...(input.taskFacts === undefined ? {} : { taskFacts: input.taskFacts }),
    ...(input.permissionPolicy === undefined
      ? {}
      : { permissionPolicy: input.permissionPolicy }),
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
  return ENGINE_TOOL_CALL_NORMALIZATION_PIPELINE.reduce(
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

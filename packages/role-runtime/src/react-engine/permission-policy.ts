import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  applyAwaitingContextSetupNoToolSuppression,
  type TaskFactsSnapshot,
} from "../task-facts-shared";
import { buildReadOnlyPermissionQuerySuppressionPrompt } from "../runtime-policy/prompt-renderers";
import { buildContinuationDirectiveContext } from "../tool-protocol";
import {
  enforceMissingApprovalGateRepairToolCalls,
  normalizeApprovalGatedBrowserSpawnCalls,
} from "../runtime-facts/text-fallback-readers";
import { buildPermissionSuppressionFacts } from "../runtime-facts/permission-policy-facts";
import { selectPermissionSuppressionPolicy } from "../runtime-policy/permission-policy-core";
import type { EngineSuppressDecision } from "./types";

// Stage 8 engine cleanup — PermissionPolicy.
//
// Authority: own permission-query suppression and approval-gate compatibility
// decisions for the engine path. The text detectors remain in neutral shared
// helpers while inline is still the parity reference; this module is the engine
// policy boundary that calls them.
export const PERMISSION_POLICY_MODULE = "permission-policy" as const;
export const ENGINE_ACTIVE_PERMISSION_POLICY_IDS = [] as const;

export interface PermissionToolCallInput {
  calls: LLMToolCall[];
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  taskPrompt: string;
  toolTrace: NativeToolRoundTrace[];
  sessionContext: string;
}

export interface PermissionSuppressInput {
  calls: LLMToolCall[];
  taskPrompt: string;
  sessionContext: string;
}

export interface PermissionSuppressContextInput {
  calls: LLMToolCall[];
  taskPrompt: string;
  messages: LLMMessage[];
}

type PermissionSuppressDecision = Extract<
  EngineSuppressDecision,
  { kind: "suppress" }
>;

export interface PermissionSuppressApplicationInput {
  messages: LLMMessage[];
  lastText: string;
}

export interface PermissionSuppressHookResult {
  messages: LLMMessage[];
  forceToolChoice?: NonNullable<PermissionSuppressDecision["forceToolChoice"]>;
}

export interface PermissionSuppressHookInput {
  active?: boolean;
  calls: LLMToolCall[];
  taskPrompt: string;
  messages: LLMMessage[];
  lastText: string;
  repairMarkers: LLMMessage[];
  taskFacts?: TaskFactsSnapshot;
}

export interface PermissionPolicy {
  normalizeMissingApprovalGateRepair(input: PermissionToolCallInput): LLMToolCall[];
  normalizeApprovalGatedBrowserSpawn(input: PermissionToolCallInput): LLMToolCall[];
  suppressReadOnlyPermissionQuery(input: PermissionSuppressInput): EngineSuppressDecision;
  applySuppressDecision(
    decision: EngineSuppressDecision,
    input: PermissionSuppressApplicationInput,
  ): PermissionSuppressHookResult | null;
  applySuppressToolCallsHook(
    input: PermissionSuppressHookInput,
  ): PermissionSuppressHookResult | null;
  wouldSuppressReadOnlyPermissionQuery(input: PermissionSuppressInput): boolean;
}

export function createPermissionPolicy(): PermissionPolicy {
  return NO_ACTION_PERMISSION_POLICY;
}

/** Test-only characterization of retired task-text permission actions. */
export function createPermissionPolicyCharacterization(): PermissionPolicy {
  return DEFAULT_PERMISSION_POLICY;
}

export function buildPermissionSuppressInput(
  input: PermissionSuppressContextInput,
): PermissionSuppressInput {
  return {
    calls: input.calls,
    taskPrompt: input.taskPrompt,
    sessionContext: buildContinuationDirectiveContext(
      input.taskPrompt,
      input.messages,
    ),
  };
}

function suppressReadOnlyPermissionQuery(
  input: PermissionSuppressInput,
): EngineSuppressDecision {
  const decision = selectPermissionSuppressionPolicy({
    facts: buildPermissionSuppressionFacts(input),
  });
  if (decision.kind !== "suppress") {
    return { kind: "none" };
  }
  return {
    kind: "suppress",
    policyId: "read_only_permission_query",
    messages: [
      {
        role: "user",
        content: buildReadOnlyPermissionQuerySuppressionPrompt(),
      },
    ],
    forceToolChoice: "none",
    consumesRound: true,
    reason: "read-only permission_query does not require approval",
  };
}

function applySuppressDecision(
  decision: EngineSuppressDecision,
  input: PermissionSuppressApplicationInput,
): PermissionSuppressHookResult | null {
  if (decision.kind !== "suppress") {
    return null;
  }
  return {
    messages: [
      ...input.messages,
      { role: "assistant", content: input.lastText },
      ...decision.messages,
    ],
    ...(decision.forceToolChoice === undefined
      ? {}
      : { forceToolChoice: decision.forceToolChoice }),
  };
}

const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  normalizeMissingApprovalGateRepair(input) {
    return enforceMissingApprovalGateRepairToolCalls(input.calls, {
      messages: input.messages,
      repairMarkers: input.repairMarkers,
      taskPrompt: input.taskPrompt,
      toolTrace: input.toolTrace,
    });
  },

  normalizeApprovalGatedBrowserSpawn(input) {
    return normalizeApprovalGatedBrowserSpawnCalls(input.calls, {
      taskPrompt: input.taskPrompt,
      sessionContext: input.sessionContext,
      toolTrace: input.toolTrace,
    });
  },

  suppressReadOnlyPermissionQuery(input) {
    return suppressReadOnlyPermissionQuery(input);
  },

  applySuppressDecision(decision, input) {
    return applySuppressDecision(decision, input);
  },

  applySuppressToolCallsHook(input) {
    if (input.active === false || input.calls.length === 0) {
      return null;
    }
    const readOnlySuppression = suppressReadOnlyPermissionQuery(
      buildPermissionSuppressInput({
        calls: input.calls,
        taskPrompt: input.taskPrompt,
        messages: input.messages,
      }),
    );
    const readOnlySuppressionResult = applySuppressDecision(readOnlySuppression, {
      messages: input.messages,
      lastText: input.lastText,
    });
    if (readOnlySuppressionResult) {
      return readOnlySuppressionResult;
    }
    if (input.taskFacts && !input.taskFacts.awaitingContextSetupOnly) {
      return null;
    }
    return applyAwaitingContextSetupNoToolSuppression({
      taskPrompt: input.taskPrompt,
      messages: input.messages,
      lastText: input.lastText,
      repairMarkers: input.repairMarkers,
    });
  },

  wouldSuppressReadOnlyPermissionQuery(input) {
    return (
      selectPermissionSuppressionPolicy({
        facts: buildPermissionSuppressionFacts(input),
      }).kind === "suppress"
    );
  },
};

const NO_ACTION_PERMISSION_POLICY: PermissionPolicy = {
  normalizeMissingApprovalGateRepair(input) {
    return input.calls;
  },
  normalizeApprovalGatedBrowserSpawn(input) {
    return input.calls;
  },
  suppressReadOnlyPermissionQuery() {
    return { kind: "none" };
  },
  applySuppressDecision() {
    return null;
  },
  applySuppressToolCallsHook() {
    return null;
  },
  wouldSuppressReadOnlyPermissionQuery() {
    return false;
  },
};

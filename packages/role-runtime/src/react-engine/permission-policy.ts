import type { LLMMessage, LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildReadOnlyPermissionQuerySuppressionPrompt,
  enforceMissingApprovalGateRepairToolCalls,
  normalizeApprovalGatedBrowserSpawnCalls,
  shouldSuppressReadOnlyPermissionQueryToolCalls,
} from "../tool-loop-shared";
import type { EngineSuppressDecision } from "./types";

// Stage 8 engine cleanup — PermissionPolicy.
//
// Authority: own permission-query suppression and approval-gate compatibility
// decisions for the engine path. The text detectors remain in neutral shared
// helpers while inline is still the parity reference; this module is the engine
// policy boundary that calls them.
export const PERMISSION_POLICY_MODULE = "permission-policy" as const;

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

export interface PermissionPolicy {
  normalizeMissingApprovalGateRepair(input: PermissionToolCallInput): LLMToolCall[];
  normalizeApprovalGatedBrowserSpawn(input: PermissionToolCallInput): LLMToolCall[];
  suppressReadOnlyPermissionQuery(input: PermissionSuppressInput): EngineSuppressDecision;
  applySuppressDecision(
    decision: EngineSuppressDecision,
    input: PermissionSuppressApplicationInput,
  ): PermissionSuppressHookResult | null;
  wouldSuppressReadOnlyPermissionQuery(input: PermissionSuppressInput): boolean;
}

export function createPermissionPolicy(): PermissionPolicy {
  return DEFAULT_PERMISSION_POLICY;
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
    if (!shouldSuppressReadOnlyPermissionQueryToolCalls(input.calls, input)) {
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
  },

  applySuppressDecision(decision, input) {
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
  },

  wouldSuppressReadOnlyPermissionQuery(input) {
    return shouldSuppressReadOnlyPermissionQueryToolCalls(input.calls, input);
  },
};

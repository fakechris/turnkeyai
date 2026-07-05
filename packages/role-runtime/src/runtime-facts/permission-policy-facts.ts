import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import { readPolicyReadOnlyPermissionQuerySuppression } from "./text-fallback-readers";

export interface PermissionSuppressionFactInput {
  calls: LLMToolCall[];
  taskPrompt: string;
  sessionContext: string;
}

export interface PermissionSuppressionFacts {
  readOnlyPermissionQuery: boolean;
}

export function buildPermissionSuppressionFacts(
  input: PermissionSuppressionFactInput,
): PermissionSuppressionFacts {
  return {
    readOnlyPermissionQuery: readPolicyReadOnlyPermissionQuerySuppression(
      input.calls,
      input,
    ),
  };
}

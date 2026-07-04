import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import { readLegacyReadOnlyPermissionQuerySuppression } from "../tool-loop-shared";

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
    readOnlyPermissionQuery: readLegacyReadOnlyPermissionQuerySuppression(
      input.calls,
      input,
    ),
  };
}

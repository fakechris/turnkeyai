import type { LLMMessage } from "@turnkeyai/llm-adapter/index";

import { readPolicyFinalRecoveryBudgetCloseoutRepair } from "./text-fallback-readers";

export interface RecoveryToolBudgetCloseoutFactInput {
  pendingToolCallCount: number;
  messages: LLMMessage[];
  repairMarkers: LLMMessage[];
  resultText: string;
}

export interface RecoveryToolBudgetCloseoutFacts {
  deferToRepairRound: boolean;
}

export function buildRecoveryToolBudgetCloseoutFacts(
  input: RecoveryToolBudgetCloseoutFactInput,
): RecoveryToolBudgetCloseoutFacts {
  return {
    deferToRepairRound:
      input.pendingToolCallCount === 0 &&
      readPolicyFinalRecoveryBudgetCloseoutRepair({
        messages: input.messages,
        repairMarkers: input.repairMarkers,
        resultText: input.resultText,
      }),
  };
}

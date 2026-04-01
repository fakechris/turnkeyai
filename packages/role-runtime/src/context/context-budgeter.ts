export interface ContextBudgetInput {
  model: {
    provider: string;
    name: string;
    contextWindow: number;
  };
  reservedOutputTokens: number;
  mode: "lead" | "member" | "worker";
}

export interface PromptTokenBudget {
  totalBudget: number;
  reservedOutputTokens: number;
  systemLayerBudget: number;
  taskLayerBudget: number;
  recentTurnsBudget: number;
  compressedMemoryBudget: number;
  workerEvidenceBudget: number;
  safetyMargin: number;
}

export interface ContextEstimateInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface PromptTokenEstimate {
  inputTokens: number;
  outputTokensReserved: number;
  totalProjectedTokens: number;
  overBudget: boolean;
}

export interface ContextBudgeter {
  allocate(input: ContextBudgetInput): Promise<PromptTokenBudget>;
  estimate(input: ContextEstimateInput, reservedOutputTokens?: number, maxInputTokens?: number): Promise<PromptTokenEstimate>;
}

export class DefaultContextBudgeter implements ContextBudgeter {
  async allocate(input: ContextBudgetInput): Promise<PromptTokenBudget> {
    const totalBudget = Math.max(input.model.contextWindow - input.reservedOutputTokens, 0);
    const percentages =
      input.mode === "worker"
        ? {
            system: 0.18,
            task: 0.24,
            recent: 0.2,
            memory: 0.18,
            evidence: 0.15,
            safety: 0.05,
          }
        : {
            system: 0.2,
            task: 0.2,
            recent: 0.25,
            memory: 0.2,
            evidence: 0.1,
            safety: 0.05,
          };

    return {
      totalBudget,
      reservedOutputTokens: input.reservedOutputTokens,
      systemLayerBudget: Math.floor(totalBudget * percentages.system),
      taskLayerBudget: Math.floor(totalBudget * percentages.task),
      recentTurnsBudget: Math.floor(totalBudget * percentages.recent),
      compressedMemoryBudget: Math.floor(totalBudget * percentages.memory),
      workerEvidenceBudget: Math.floor(totalBudget * percentages.evidence),
      safetyMargin: Math.floor(totalBudget * percentages.safety),
    };
  }

  async estimate(
    input: ContextEstimateInput,
    reservedOutputTokens = 0,
    maxInputTokens?: number
  ): Promise<PromptTokenEstimate> {
    const inputTokens = roughTokenEstimate(input.systemPrompt) + roughTokenEstimate(input.userPrompt);
    const totalProjectedTokens = inputTokens + reservedOutputTokens;

    return {
      inputTokens,
      outputTokensReserved: reservedOutputTokens,
      totalProjectedTokens,
      overBudget: maxInputTokens != null ? inputTokens > maxInputTokens : false,
    };
  }
}

function roughTokenEstimate(content: string): number {
  return Math.ceil(content.length / 4);
}

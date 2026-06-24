import type { GenerateTextInput, LLMToolChoice } from "@turnkeyai/llm-adapter/types";
import type { LLMGateway } from "@turnkeyai/llm-adapter/gateway";
import type { ModelClient, ReActToolChoice } from "@turnkeyai/agent-core/react-loop";

/**
 * Bridges TurnkeyAI's {@link LLMGateway} to agent-core's {@link ModelClient}
 * port, so the reusable ReAct engine can drive the real model stack (fallback
 * chains, protocol clients, envelope handling) without agent-core depending on
 * any of it. This is the model-call seam the policy-heavy generator converges
 * onto when it routes its loop through `createReActAgent`.
 */

function toLLMToolChoice(choice: ReActToolChoice): LLMToolChoice {
  return typeof choice === "string" ? choice : { type: "tool", name: choice.name };
}

export interface GatewayModelClientDefaults {
  modelId?: string;
  modelChainId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

export function gatewayModelClient(
  gateway: Pick<LLMGateway, "generate">,
  defaults: GatewayModelClientDefaults = {}
): ModelClient {
  return {
    async generate(input) {
      const request: GenerateTextInput = {
        messages: input.messages,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.toolChoice ? { toolChoice: toLLMToolChoice(input.toolChoice) } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(defaults.modelId ? { modelId: defaults.modelId } : {}),
        ...(defaults.modelChainId ? { modelChainId: defaults.modelChainId } : {}),
        ...(defaults.temperature !== undefined ? { temperature: defaults.temperature } : {}),
        ...(defaults.maxOutputTokens !== undefined ? { maxOutputTokens: defaults.maxOutputTokens } : {}),
        ...(defaults.metadata ? { metadata: defaults.metadata } : {}),
      };
      const result = await gateway.generate(request);
      return {
        text: result.text,
        ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      };
    },
  };
}

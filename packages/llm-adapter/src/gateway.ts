import type { GenerateTextInput, GenerateTextResult, ProtocolClient } from "./types";
import { assertRequestEnvelopeWithinLimits } from "./request-envelope-guard";
import { ModelRegistry } from "./registry";

export class LLMGateway {
  private readonly registry: ModelRegistry;
  private readonly clients: ProtocolClient[];

  constructor(options: { registry: ModelRegistry; clients: ProtocolClient[] }) {
    this.registry = options.registry;
    this.clients = options.clients;
  }

  async listModels() {
    return this.registry.list();
  }

  async generate(input: GenerateTextInput): Promise<GenerateTextResult> {
    const selection = await this.registry.resolveSelection({
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.modelChainId ? { modelChainId: input.modelChainId } : {}),
    });
    const candidateModelIds = [selection.primaryModelId, ...selection.fallbackModelIds];
    const attemptedModelIds: string[] = [];
    let lastError: unknown;

    for (const modelId of candidateModelIds) {
      attemptedModelIds.push(modelId);
      try {
        const model = await this.registry.resolve(modelId);
        const requestEnvelope = assertRequestEnvelopeWithinLimits(
          {
            ...input,
            modelId,
          },
          undefined,
          model
        );
        const client = this.clients.find((item) => item.supports(model.protocol));

        if (!client) {
          throw new Error(`no protocol client for ${model.protocol}`);
        }

        const result = await client.generate(model, {
          ...input,
          modelId,
        });
        return {
          ...result,
          requestEnvelope,
          ...(selection.chainId ? { modelChainId: selection.chainId } : {}),
          ...(selection.chainId || attemptedModelIds.length > 1 ? { attemptedModelIds } : {}),
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("model generation failed without an error");
  }
}

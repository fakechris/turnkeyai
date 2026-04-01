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
    const model = await this.registry.resolve(input.modelId);
    const requestEnvelope = assertRequestEnvelopeWithinLimits(input, undefined, model);
    const client = this.clients.find((item) => item.supports(model.protocol));

    if (!client) {
      throw new Error(`no protocol client for ${model.protocol}`);
    }

    const result = await client.generate(model, input);
    return {
      ...result,
      requestEnvelope,
    };
  }
}

import type { RoleActivationInput } from "@turnkeyai/core-types/team";

import type { GeneratedRoleReply, RoleResponseGenerator } from "./deterministic-response-generator";
import type { RolePromptPacket } from "./prompt-policy";

export class HybridRoleResponseGenerator implements RoleResponseGenerator {
  private readonly primary: RoleResponseGenerator;
  private readonly fallback: RoleResponseGenerator;

  constructor(options: { primary: RoleResponseGenerator; fallback: RoleResponseGenerator }) {
    this.primary = options.primary;
    this.fallback = options.fallback;
  }

  async generate(input: { activation: RoleActivationInput; packet: RolePromptPacket }): Promise<GeneratedRoleReply> {
    try {
      return await this.primary.generate(input);
    } catch (error) {
      const fallback = await this.fallback.generate(input);
      const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
      return {
        ...fallback,
        metadata: {
          ...(fallback.metadata ?? {}),
          fallbackReason: error instanceof Error ? error.message : "unknown llm fallback",
          ...(record &&
          typeof record.code === "string" &&
          record.code === "REQUEST_ENVELOPE_OVERFLOW" &&
          record.details &&
          typeof record.details === "object"
            ? { requestEnvelopeFailure: record.details }
            : {}),
        },
      };
    }
  }
}

import type { RoleActivationInput, RoleId } from "@turnkeyai/core-types/team";

import type { RoleModelAdapter } from "./model-adapter";
import type { RolePromptPacket } from "./prompt-policy";
import type { RoleProfileRegistry } from "./role-profile";

export interface GeneratedRoleReply {
  content: string;
  mentions: RoleId[];
  metadata?: Record<string, unknown>;
}

export interface RoleResponseGenerator {
  generate(input: { activation: RoleActivationInput; packet: RolePromptPacket }): Promise<GeneratedRoleReply>;
}

export class DeterministicRoleResponseGenerator implements RoleResponseGenerator {
  private readonly modelAdapter: RoleModelAdapter;
  private readonly roleProfileRegistry: RoleProfileRegistry;

  constructor(options: { modelAdapter: RoleModelAdapter; roleProfileRegistry: RoleProfileRegistry }) {
    this.modelAdapter = options.modelAdapter;
    this.roleProfileRegistry = options.roleProfileRegistry;
  }

  async generate(input: { activation: RoleActivationInput; packet: RolePromptPacket }): Promise<GeneratedRoleReply> {
    const currentRole = input.activation.thread.roles.find((item) => item.roleId === input.activation.runState.roleId);
    if (!currentRole) {
      throw new Error(`role not found for response generation: ${input.activation.runState.roleId}`);
    }

    const profile = this.roleProfileRegistry.resolve(currentRole);
    const result = await this.modelAdapter.invoke({
      activation: input.activation,
      packet: input.packet,
      profile,
    });

    return {
      content: result.content,
      mentions: result.mentions,
      metadata: {
        adapterName: result.adapterName,
      },
    };
  }
}

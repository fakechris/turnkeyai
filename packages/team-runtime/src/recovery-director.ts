import type {
  RecoveryDecision,
  RecoveryDirector,
  SupervisorRoleFailureInput,
  SupervisorRoleReplyInput,
  SupervisorUserMessageInput,
} from "@turnkeyai/core-types/team";

export class DefaultRecoveryDirector implements RecoveryDirector {
  async onUserMessage(_input: SupervisorUserMessageInput): Promise<RecoveryDecision> {
    return { action: "complete" };
  }

  async onRoleReply(input: SupervisorRoleReplyInput): Promise<RecoveryDecision> {
    if (input.mentions.length > 0) {
      return { action: "dispatch", targetRoleIds: input.mentions };
    }

    if (input.message.roleId === input.thread.leadRoleId) {
      return { action: "complete" };
    }

    return { action: "fallback_to_lead", leadRoleId: input.thread.leadRoleId };
  }

  async onRoleFailure(input: SupervisorRoleFailureInput): Promise<RecoveryDecision> {
    if (input.failedRoleId === input.thread.leadRoleId) {
      return { action: "abort", reason: input.error.message };
    }

    return { action: "fallback_to_lead", leadRoleId: input.thread.leadRoleId };
  }
}

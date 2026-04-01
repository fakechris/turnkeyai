import { getRecentMessages } from "@turnkeyai/core-types/team";
import type { RoleActivationInput, RoleId } from "@turnkeyai/core-types/team";

import type { RolePromptPacket } from "./prompt-policy";
import type { RoleRuntimeProfile } from "./role-profile";

export interface ModelInvocation {
  activation: RoleActivationInput;
  packet: RolePromptPacket;
  profile: RoleRuntimeProfile;
}

export interface ModelInvocationResult {
  content: string;
  mentions: RoleId[];
  adapterName: string;
}

export interface RoleModelAdapter {
  invoke(input: ModelInvocation): Promise<ModelInvocationResult>;
}

export class HeuristicModelAdapter implements RoleModelAdapter {
  async invoke(input: ModelInvocation): Promise<ModelInvocationResult> {
    const { activation, packet, profile } = input;
    const currentRole = activation.thread.roles.find((item) => item.roleId === activation.runState.roleId);
    if (!currentRole) {
      throw new Error(`role not found for model adapter: ${activation.runState.roleId}`);
    }

    if (currentRole.seat === "lead") {
      const nextMember = activation.thread.roles.find(
        (item) =>
          item.seat === "member" &&
          item.roleId !== activation.runState.roleId &&
          !activation.flow.completedRoleIds.includes(item.roleId)
      );

      if (nextMember) {
        return {
          content: [
            `${packet.roleName} is operating as ${profile.personaLabel}.`,
            `${profile.leadDirective}`,
            `@{${nextMember.roleId}} Please take the next assigned slice and report back briefly.`,
          ].join("\n"),
          mentions: [nextMember.roleId],
          adapterName: "heuristic",
        };
      }

      return {
        content: [
          `${packet.roleName} is operating as ${profile.personaLabel}.`,
          profile.completionDirective,
          summarizeLeadConclusion(activation),
        ].join("\n"),
        mentions: [],
        adapterName: "heuristic",
      };
    }

    const workerObservation = extractWorkerObservation(packet.taskPrompt);

    return {
      content: [
        `${packet.roleName} is operating as ${profile.personaLabel}.`,
        ...(workerObservation ? [workerObservation] : []),
        profile.memberDirective,
        `@{${activation.thread.leadRoleId}} Please consolidate this update.`,
      ].join("\n"),
      mentions: [activation.thread.leadRoleId],
      adapterName: "heuristic",
    };
  }
}

function extractWorkerObservation(taskPrompt: string): string | null {
  const marker = "Worker result:\n";
  const index = taskPrompt.indexOf(marker);
  if (index < 0) {
    return null;
  }

  const summary = taskPrompt.slice(index + marker.length).trim();
  if (!summary) {
    return null;
  }

  return `Observed browser result:\n${summary}`;
}

function summarizeLeadConclusion(activation: RoleActivationInput): string {
  const latestMemberUpdate = [...getRecentMessages(activation.handoff.payload)]
    .reverse()
    .find((message) => message.role === "assistant" && message.roleId && message.roleId !== activation.runState.roleId);

  if (!latestMemberUpdate) {
    return "The daemon, flow ledger, role runs, and handoff loop are working end-to-end.";
  }

  const normalized = latestMemberUpdate.content
    .replace(/@\{[^}]+\}\s*Please consolidate this update\.?/g, "")
    .trim();

  return `Final synthesis based on the latest specialist update:\n${normalized}`;
}

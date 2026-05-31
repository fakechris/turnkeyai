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
  const latestToolUpdate = [...getRecentMessages(activation.handoff.payload)]
    .reverse()
    .find((message) => message.role === "tool" && message.content.trim().length > 0);

  if (latestToolUpdate) {
    return summarizeToolConclusion(latestToolUpdate.content);
  }

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

function summarizeToolConclusion(content: string): string {
  const extracted = extractToolEvidence(content);
  return [
    "Final synthesis based on the latest tool result:",
    `Verified: ${extracted || "the tool returned a result, but no concise evidence summary was available."}`,
    "Unverified: any claim not present in the tool result remains unverified.",
    "Residual risk: this fallback answer was produced without another model synthesis pass, so use the visible tool evidence as the authority.",
    "Continuation: if the evidence is incomplete or timeout-bounded, continue the same session rather than starting duplicate work.",
  ].join("\n");
}

function extractToolEvidence(content: string): string {
  const parsed = parseJsonObject(content);
  if (parsed) {
    const fields = ["final_content", "result", "evidence_summary", "summary"];
    for (const field of fields) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim()) {
        return sliceToolEvidence(value);
      }
    }
  }
  return sliceToolEvidence(content);
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sliceToolEvidence(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 1200) {
    return normalized;
  }
  return `${normalized.slice(0, 1197)}...`;
}

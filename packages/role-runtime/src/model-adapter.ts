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
  const recentMessages = getRecentMessages(activation.handoff.payload);
  const recentToolUpdates = recentMessages.filter((message) => message.role === "tool" && message.content.trim().length > 0);
  const reversedToolUpdates = [...recentToolUpdates].reverse();
  const latestToolUpdate =
    reversedToolUpdates.find((message) => hasCompletedOrPartialToolEvidence(message.content)) ??
    reversedToolUpdates.find((message) => message.content.trim().length > 0);

  if (latestToolUpdate) {
    return summarizeToolConclusion(latestToolUpdate.content, {
      cancellationSeen: recentToolUpdates.some((message) => hasCancelledToolEvidence(message.content)),
    });
  }

  const latestMemberUpdate = [...recentMessages]
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

function summarizeToolConclusion(content: string, context: { cancellationSeen?: boolean } = {}): string {
  const extracted = extractToolEvidence(content);
  return [
    "Final synthesis based on the latest tool result:",
    ...(context.cancellationSeen
      ? [
          "Cancellation context: an earlier tool result was cancelled before this continuation; confidence depends on the resumed evidence below.",
        ]
      : []),
    `Verified: ${extracted || "the tool returned a result, but no concise evidence summary was available."}`,
    "Unverified: any claim not present in the tool result remains unverified.",
    "Residual risk: this fallback answer was produced without another model synthesis pass, so use the visible tool evidence as the authority.",
    "Continuation: if the evidence is incomplete or timeout-bounded, continue the same session rather than starting duplicate work.",
  ].join("\n");
}

function extractToolEvidence(content: string): string {
  const extracted = extractEvidenceFromValue(content, 0);
  if (extracted) {
    return extracted;
  }
  return sliceToolEvidence(content);
}

function parseJsonObject(content: string): unknown | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed;
  } catch {
    return parseFirstJsonObjectSubstring(content);
  }
}

function parseFirstJsonObjectSubstring(content: string): unknown | null {
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "{") continue;
    const end = findJsonObjectEnd(content, index);
    if (end === null) continue;
    try {
      return JSON.parse(content.slice(index, end + 1)) as unknown;
    } catch {}
  }
  return null;
}

function findJsonObjectEnd(content: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function extractEvidenceFromRecord(record: Record<string, unknown>): string | null {
  const fields = ["final_content", "evidence_summary", "summary", "content", "text", "payload", "data", "output", "result", "raw"];
  for (const field of fields) {
    const value = record[field];
    const extracted = extractEvidenceFromValue(value, 0);
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

function extractEvidenceFromValue(value: unknown, depth: number): string | null {
  if (depth > 5 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const nested = parseJsonObject(trimmed);
    if (nested !== null && nested !== value) {
      return extractEvidenceFromValue(nested, depth + 1);
    }
    return sliceToolEvidence(trimmed);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractEvidenceFromValue(item, depth + 1))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? sliceToolEvidence(parts.join(" ")) : null;
  }

  if (typeof value === "object") {
    return extractEvidenceFromRecord(value as Record<string, unknown>);
  }

  return null;
}

function sliceToolEvidence(value: string): string {
  const normalized = stripHtml(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (normalized.length <= 1200) {
    return normalized;
  }
  return `${normalized.slice(0, 1197)}...`;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function hasCancelledToolEvidence(content: string): boolean {
  const parsed = parseJsonObject(content);
  if (isRecord(parsed) && parsed["status"] === "cancelled") {
    return true;
  }
  return /\bcancel(?:led|ed|lation)\b/i.test(content);
}

function hasCompletedOrPartialToolEvidence(content: string): boolean {
  const parsed = parseJsonObject(content);
  if (isRecord(parsed)) {
    const status = parsed["status"];
    return (status === "completed" || status === "partial") && Boolean(extractEvidenceFromRecord(parsed));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

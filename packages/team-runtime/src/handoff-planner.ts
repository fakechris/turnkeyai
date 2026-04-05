import type {
  BuildHandoffsInput,
  DispatchPolicy,
  DispatchDecision,
  HandoffEnvelope,
  HandoffPlanner,
  HandoffTarget,
  RoleId,
  TeamThread,
  ValidateMentionInput,
} from "@turnkeyai/core-types/team";
import { createRelayPayload } from "@turnkeyai/core-types/team";

const MENTION_RE = /@\{(?<roleId>[^}]+)\}/g;

interface DefaultHandoffPlannerOptions {
  maxPerRoleHopCount?: number;
}

export class DefaultHandoffPlanner implements HandoffPlanner {
  private readonly maxPerRoleHopCount: number;

  constructor(options: DefaultHandoffPlannerOptions = {}) {
    this.maxPerRoleHopCount = options.maxPerRoleHopCount ?? 3;
  }

  parseMentions(content: string): HandoffTarget[] {
    const out: HandoffTarget[] = [];

    for (const match of content.matchAll(MENTION_RE)) {
      const roleId = match.groups?.roleId;
      if (!roleId || match.index == null) {
        continue;
      }

      out.push({
        raw: match[0],
        roleId,
        offsetStart: match.index,
        offsetEnd: match.index + match[0].length,
      });
    }

    return out;
  }

  async validateMentionTargets(thread: TeamThread, input: ValidateMentionInput): Promise<DispatchDecision> {
    const mentions = this.parseMentions(input.content);
    const knownRoleIds = new Set(thread.roles.map((role) => role.roleId));
    const targetRoleIds = uniqueRoleIds(mentions.map((item) => item.roleId)).filter((roleId) =>
      knownRoleIds.has(roleId)
    );

    if (mentions.length === 0) {
      return {
        allowed: true,
        mode: input.flow.mode,
        targetRoleIds: [],
      };
    }

    if (targetRoleIds.length !== mentions.length) {
      return {
        allowed: false,
        reason: "message contains unknown role mention",
        mode: input.flow.mode,
        targetRoleIds: [],
      };
    }

    for (const roleId of targetRoleIds) {
      const seenCount = input.flow.edges.filter((edge) => edge.toRoleId === roleId).length;
      if (seenCount >= this.maxPerRoleHopCount) {
        return {
          allowed: false,
          reason: `role hop limit exceeded: ${roleId}`,
          mode: input.flow.mode,
          targetRoleIds: [],
        };
      }
    }

    return {
      allowed: true,
      mode: input.flow.mode,
      targetRoleIds,
    };
  }

  async buildHandoffs(input: BuildHandoffsInput): Promise<HandoffEnvelope[]> {
    return input.targetRoleIds.map((targetRoleId) => {
      const dispatchPolicy: DispatchPolicy = {
        allowParallel: input.flow.mode !== "serial",
        allowReenter: true,
        sourceFlowMode: input.flow.mode,
      };

      if (input.flow.nextExpectedRoleId) {
        dispatchPolicy.expectedNextRoleIds = [input.flow.nextExpectedRoleId];
      }

      const envelope: HandoffEnvelope = {
        taskId: `${input.flow.flowId}:${targetRoleId}:${input.now}`,
        flowId: input.flow.flowId,
        sourceMessageId: input.sourceMessage.id,
        targetRoleId,
        activationType: input.activationType,
        threadId: input.thread.threadId,
        payload: createRelayPayload({
          threadId: input.thread.threadId,
          relayBrief: "",
          recentMessages: input.recentMessages,
          ...(input.instructions ? { instructions: input.instructions } : {}),
          dispatchPolicy,
        }),
        createdAt: input.now,
      };

      if (input.fromRoleId) {
        envelope.sourceRoleId = input.fromRoleId;
      }
      return envelope;
    });
  }
}

function uniqueRoleIds(roleIds: RoleId[]): RoleId[] {
  return [...new Set(roleIds)];
}

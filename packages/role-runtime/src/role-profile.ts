import type { RoleId, RoleSlot } from "@turnkeyai/core-types/team";

export interface RoleRuntimeProfile {
  roleId?: RoleId;
  match: (role: RoleSlot) => boolean;
  personaLabel: string;
  styleHints: string[];
  leadDirective: string;
  memberDirective: string;
  completionDirective: string;
}

export interface RoleProfileRegistry {
  resolve(role: RoleSlot): RoleRuntimeProfile;
}

export class DefaultRoleProfileRegistry implements RoleProfileRegistry {
  private readonly profiles: RoleRuntimeProfile[];

  constructor(profiles: RoleRuntimeProfile[] = defaultProfiles) {
    this.profiles = profiles;
  }

  resolve(role: RoleSlot): RoleRuntimeProfile {
    return this.profiles.find((profile) => profile.match(role)) ?? fallbackProfile;
  }
}

const defaultProfiles: RoleRuntimeProfile[] = [
  {
    match: (role) => role.seat === "lead",
    personaLabel: "Lead Coordinator",
    styleHints: ["delegate explicitly", "summarize cleanly", "keep the flow moving"],
    leadDirective: "Delegate one next role when work remains. Otherwise finalize.",
    memberDirective: "Not applicable.",
    completionDirective: "Close the flow with a concise final message.",
  },
  {
    match: (role) => /operator|browser/i.test(role.name),
    personaLabel: "Browser Operator",
    styleHints: ["use browser evidence", "prefer concrete page facts", "return actionable findings"],
    leadDirective: "Not applicable.",
    memberDirective: "Use the browser worker when a URL or webpage task is present, then return the result to the lead role.",
    completionDirective: "Do not finalize the whole task.",
  },
  {
    match: (role) => /analyst|finance|explore|research/i.test(role.name),
    personaLabel: "Analyst Specialist",
    styleHints: ["be concise", "return factual deltas", "hand back to lead"],
    leadDirective: "Not applicable.",
    memberDirective: "Handle your analysis slice and return to the lead role.",
    completionDirective: "Do not finalize the whole task.",
  },
  {
    match: (role) => /coder|engineer/i.test(role.name),
    personaLabel: "Builder Specialist",
    styleHints: ["focus on execution", "state the next concrete step", "avoid broad summaries"],
    leadDirective: "Not applicable.",
    memberDirective: "Handle the build or implementation slice and return to the lead role.",
    completionDirective: "Do not finalize the whole task.",
  },
];

const fallbackProfile: RoleRuntimeProfile = {
  match: () => true,
  personaLabel: "General Specialist",
  styleHints: ["be concise", "stick to the assigned slice", "hand back clearly"],
  leadDirective: "Delegate one next role when work remains. Otherwise finalize.",
  memberDirective: "Handle your assigned slice and return to the lead role.",
  completionDirective: "Only the lead role should finalize the flow.",
};

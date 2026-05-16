// Static demo role configurations exposed via the daemon's `demo` route.
// Pure data — no daemon state captured. Lifted out of daemon.ts as part of
// P1.5c so the request handler doesn't carry inline configuration tables.

const lead = {
  roleId: "role-lead",
  name: "Lead",
  seat: "lead" as const,
  runtime: "local" as const,
  modelRef: "claude-opus",
  modelChain: "lead_reasoning",
};

export function buildDemoRoles(variant: string) {
  if (variant === "coder") {
    return [
      lead,
      {
        roleId: "role-coder",
        name: "Coder",
        seat: "member" as const,
        runtime: "local" as const,
        modelRef: "gpt-5",
        modelChain: "builder_primary",
      },
    ];
  }

  if (variant === "finance") {
    return [
      lead,
      {
        roleId: "role-finance",
        name: "Finance",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["finance"],
        modelRef: "minimax",
        modelChain: "finance_primary",
      },
    ];
  }

  if (variant === "operator") {
    return [
      lead,
      {
        roleId: "role-operator",
        name: "Operator",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["browser"],
        modelRef: "gemini",
        modelChain: "browser_primary",
      },
    ];
  }

  if (variant === "pricing") {
    return [
      lead,
      {
        roleId: "role-explore",
        name: "Explore",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["explore"],
        modelRef: "gpt-5",
        modelChain: "explore_primary",
      },
      {
        roleId: "role-finance",
        name: "Finance",
        seat: "member" as const,
        runtime: "local" as const,
        capabilities: ["finance"],
        modelRef: "minimax",
        modelChain: "finance_primary",
      },
    ];
  }

  return [
    lead,
    {
      roleId: "role-analyst",
      name: "Analyst",
      seat: "member" as const,
      runtime: "local" as const,
      capabilities: ["explore"],
      modelRef: "kimi",
      modelChain: "analyst_primary",
    },
  ];
}

// Cross-cutting types for the Mission Control app (PR K1).
//
// The Control Center → Mission Control rename means the route map changes
// shape: Setup/Bridge/Tabs/Diagnostics fold into a mission workbench IA
// centered on Missions (the user's primary unit of work). See
// docs/design/mission-control-product-design.md §5.

// Token scopes from the daemon's resolveAppToken output.
export type Scope = "read" | "operator" | "admin" | "unknown";
export const KNOWN_SCOPES: readonly Scope[] = ["read", "operator", "admin", "unknown"];

// Mission Control routes. K1 ships the full IA; pages whose backend
// objects don't exist yet (Missions, Approvals, Agents) render against
// the mock data layer.
export type Route =
  | "onboarding"
  | "missions"
  | "mission"
  | "approvals"
  | "agents"
  | "context"
  | "agent-connect"
  | "runtime"
  | "settings";

export const KNOWN_ROUTES: readonly Route[] = [
  "onboarding",
  "missions",
  "mission",
  "approvals",
  "agents",
  "context",
  "agent-connect",
  "runtime",
  "settings",
];

// Mission lifecycle states. Mapped to status-dot CSS classes by exact name.
export type MissionStatus =
  | "draft"
  | "planning"
  | "working"
  | "needs_approval"
  | "blocked"
  | "done"
  | "archived";

export const STATUS_LABEL: Record<MissionStatus, string> = {
  draft: "Draft",
  planning: "Planning",
  working: "Working",
  needs_approval: "Needs approval",
  blocked: "Blocked",
  done: "Done",
  archived: "Archived",
};

export type StatusTagTone = "" | "info" | "success" | "warning" | "danger" | "accent";
export const STATUS_TAG: Record<MissionStatus, StatusTagTone> = {
  draft: "",
  planning: "info",
  working: "success",
  needs_approval: "warning",
  blocked: "danger",
  done: "",
  archived: "",
};

export type ConnectionPillState = "unknown" | "ok" | "warn" | "bad";
export interface ConnectionPill {
  state: ConnectionPillState;
  label: string;
}

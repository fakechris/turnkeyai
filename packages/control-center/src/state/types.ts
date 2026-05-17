// Cross-cutting types for the Control Center app.

// Token scopes the dashboard knows about. Matches the daemon-side
// resolveAppToken output from packages/cli/src/app-command.ts.
export type Scope = "read" | "operator" | "admin" | "unknown";

export const KNOWN_SCOPES: readonly Scope[] = ["read", "operator", "admin", "unknown"];

// Hash routes the dashboard knows about. Adding a route requires updating
// this list AND adding a <route -> renderer> entry in App.tsx.
export type Route = "setup" | "bridge" | "tabs" | "agent" | "diagnostics";

export const KNOWN_ROUTES: readonly Route[] = [
  "setup",
  "bridge",
  "tabs",
  "agent",
  "diagnostics",
];

// State of the persistent connection pill in the top bar.
export type ConnectionPillState = "unknown" | "ok" | "warn" | "bad";

export interface ConnectionPill {
  state: ConnectionPillState;
  label: string;
}

// Left rail navigation — matches the Mission Control design.
//
// Grouped into Work / Resources / System (per the design's Sidebar). Each
// item has icon + label + optional count. Approvals + Runtime show an
// alert badge when their count is non-zero.

import { Icon, type IconName } from "./Icon";
import { useAppState } from "../state/AppState";
import type { Route } from "../state/types";

interface NavItem {
  id: Route;
  label: string;
  icon: IconName;
  count?: number;
  alert?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface SidebarCounts {
  missions: number;
  approvals: number;
  agents: number;
  context: number;
  recoveries: number;
}

export function Sidebar({
  counts,
  canCreateMission,
  onNewMission,
}: {
  counts: SidebarCounts;
  canCreateMission: boolean;
  onNewMission: () => void;
}) {
  const { state, setRoute } = useAppState();

  const groups: NavGroup[] = [
    {
      label: "Work",
      items: [
        { id: "missions", label: "Missions", icon: "missions", count: counts.missions },
        {
          id: "approvals",
          label: "Approvals",
          icon: "approvals",
          count: counts.approvals,
          alert: counts.approvals > 0,
        },
      ],
    },
    {
      label: "Resources",
      items: [
        { id: "agents", label: "Agents", icon: "agents", count: counts.agents },
        { id: "context", label: "Context", icon: "context", count: counts.context },
        { id: "agent-connect", label: "Agent Connect", icon: "connect" },
      ],
    },
    {
      label: "System",
      items: [
        {
          id: "runtime",
          label: "Runtime",
          icon: "runtime",
          count: counts.recoveries,
          alert: counts.recoveries > 0,
        },
        { id: "settings", label: "Settings", icon: "settings" },
      ],
    },
  ];

  // The "Mission" route is internal — driven by selecting a row in
  // Missions list — so it's not a top-level nav item. But when it's
  // active we want Missions to highlight (the breadcrumbs in the
  // Toolbar will show the current mission's shortId).
  const activeRoute: Route = state.route === "mission" ? "missions" : state.route;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">T</div>
        <div className="brand-name">
          <b>TurnkeyAI</b>
          <span>MISSION CONTROL</span>
        </div>
      </div>

      <button
        type="button"
        className="sb-item"
        disabled={!canCreateMission}
        title={canCreateMission ? undefined : "Open with an operator or admin token to create missions."}
        style={{
          background: "var(--surface)",
          border: "1px dashed var(--border)",
          marginBottom: 8,
        }}
        onClick={onNewMission}
      >
        <span className="glyph"><Icon name="plus" size={14} /></span>
        New mission
        <span
          className="count"
          style={{ background: "transparent", color: "var(--text-faint)" }}
        >
          ⌘N
        </span>
      </button>

      {groups.map((g) => (
        <div key={g.label}>
          <div className="sb-group-label">{g.label}</div>
          {g.items.map((it) => (
            <button
              key={it.id}
              type="button"
              className={"sb-item" + (activeRoute === it.id ? " active" : "")}
              onClick={() => {
                setRoute(it.id);
                window.location.hash = `#/${it.id}`;
              }}
            >
              <span className="glyph"><Icon name={it.icon} size={14} /></span>
              {it.label}
              {typeof it.count === "number" && (
                <span className={"count" + (it.alert ? " alert" : "")}>{it.count}</span>
              )}
            </button>
          ))}
        </div>
      ))}

      <div className="sb-footer">
        <div className="sb-footer-avatar">
          {operatorInitial(state.scope)}
        </div>
        <div className="sb-footer-meta">
          <b>operator</b>
          <span>{state.scope} scope</span>
        </div>
      </div>
    </aside>
  );
}

function operatorInitial(scope: string): string {
  // Single-character initial based on scope (read=R, operator=O, admin=A,
  // unknown=•). The design hardcodes a "chris" avatar; we keep that
  // mapping abstract until K3 wires real settings.
  switch (scope) {
    case "admin":
      return "A";
    case "operator":
      return "O";
    case "read":
      return "R";
    default:
      return "•";
  }
}

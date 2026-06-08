// Left rail navigation. Labels are user-facing jobs, not internal runtime nouns.

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
      label: "",
      items: [
        { id: "agent-connect", label: "Chat", icon: "play" },
        { id: "agents", label: "Team", icon: "agents", count: counts.agents > 0 ? counts.agents : undefined },
        { id: "settings", label: "Settings", icon: "settings" },
      ],
    },
  ];

  const activeRoute: Route = state.route === "mission" ? "agent-connect" : state.route;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">T</div>
        <div className="brand-name">
          <b>TurnkeyAI</b>
          <span>AI team</span>
        </div>
      </div>

      <button
        type="button"
        className="sb-item"
        title={canCreateMission ? undefined : "Open Chat. Sending requires permission."}
        style={{
          background: "var(--surface)",
          border: "1px dashed var(--border)",
          marginBottom: 8,
        }}
        onClick={() => {
          setRoute("agent-connect");
          window.location.hash = "#/agent-connect";
        }}
      >
        <span className="glyph"><Icon name="plus" size={14} /></span>
        New chat
      </button>

      {groups.map((g) => (
        <div key={g.label}>
          {g.label ? <div className="sb-group-label">{g.label}</div> : null}
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
          T
        </div>
        <div className="sb-footer-meta">
          <b>Ready</b>
          <span>Local workspace</span>
        </div>
      </div>
    </aside>
  );
}

import type { Route } from "../state/types";
import { useAppState } from "../state/AppState";
import { StatusPill } from "./StatusPill";

const NAV_LINKS: ReadonlyArray<{ route: Route; label: string }> = [
  { route: "setup", label: "Setup" },
  { route: "bridge", label: "Bridge" },
  { route: "tabs", label: "Tabs" },
  { route: "agent", label: "Agent Connect" },
  { route: "diagnostics", label: "Diagnostics" },
];

export function TopBar() {
  const { state } = useAppState();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">TurnkeyAI</span>
        <span className="brand-tag">Control Center</span>
      </div>
      <nav className="nav">
        {NAV_LINKS.map(({ route, label }) => (
          <a
            key={route}
            href={`#/${route}`}
            data-route={route}
            className={route === state.route ? "active" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      <StatusPill pill={state.pill} />
    </header>
  );
}

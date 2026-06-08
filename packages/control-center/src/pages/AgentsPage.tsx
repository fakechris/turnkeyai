// Team — user-facing work modes, not an internal agent/provider roster.

import { useAgents } from "../api/useMissionData";
import { Icon } from "../components/Icon";
import { useAppState } from "../state/AppState";
import type { Route } from "../state/types";

export function AgentsPage() {
  const agentsRemote = useAgents([]);
  const agents = agentsRemote.value;
  const { setRoute } = useAppState();
  const openRoute = (route: Route) => {
    setRoute(route);
    window.location.hash = `#/${route}`;
  };

  return (
    <div className="page team-page">
      <div className="human-page-head">
        <div>
          <h2>Team</h2>
          <p>Choose how TurnkeyAI should approach the next chat. Auto is the default.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => openRoute("agent-connect")}>
          <Icon name="play" size={13} /> Open Chat
        </button>
      </div>
      <div className="team-choice-grid">
        <button type="button" className="team-choice-card active" onClick={() => openRoute("agent-connect")}>
          <div className="team-choice-icon"><Icon name="agents" size={18} /></div>
          <h3>Auto</h3>
          <p>Best for most work. TurnkeyAI reads the message and picks the right helper.</p>
        </button>
        <button type="button" className="team-choice-card" onClick={() => openRoute("agent-connect")}>
          <div className="team-choice-icon"><Icon name="browser" size={18} /></div>
          <h3>Use websites</h3>
          <p>For checking pages, logged-in apps, dashboards, screenshots, and visible evidence.</p>
        </button>
        <button type="button" className="team-choice-card" onClick={() => openRoute("agent-connect")}>
          <div className="team-choice-icon"><Icon name="check" size={18} /></div>
          <h3>Review carefully</h3>
          <p>For decisions where sources, edge cases, and risk need extra scrutiny.</p>
        </button>
      </div>
      <section className="team-readable-section">
        <div className="panel-headline">
          <span>Available helpers</span>
          <small>{agentsRemote.isLive ? `${agents.length || 1} ready` : "connecting"}</small>
        </div>
        {agents.length === 0 ? (
          <p>Auto is ready. Named helpers will appear here when the local workspace reports them.</p>
        ) : (
          <div className="team-helper-list">
            {agents.map((agent) => (
              <div key={agent.id} className="team-helper-row">
                <div className="team-helper-mark">{agent.ava}</div>
                <div>
                  <b>{agent.name}</b>
                  <span>{agent.role}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

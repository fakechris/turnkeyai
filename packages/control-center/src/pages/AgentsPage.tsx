// Agents roster — grid of connected agents with capabilities + usage.

import { useAgents } from "../api/useMissionData";
import { Icon } from "../components/Icon";
import { AgentAvatar, StatusTag } from "../components/atoms";

export function AgentsPage() {
  const agentsRemote = useAgents([]);
  const agents = agentsRemote.value;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Agents</h2>
          <div className="sub">
            本机连接到 mission 的 agents · 能力 / 状态 / 用量 / 限权一览。
          </div>
        </div>
        <div className="right">
          <button type="button" className="btn"><Icon name="key" size={13} /> Manage tokens</button>
          <button type="button" className="btn primary"><Icon name="plus" size={13} /> Connect agent</button>
        </div>
      </div>
      {agents.length === 0 ? (
        <div className="card" style={{ marginTop: 16, padding: 28, textAlign: "center" }}>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {agentsRemote.isLive
              ? "No agents registered yet. Connect an external agent from Agent Connect, or run a mission to spawn the default coordinator team."
              : "Connecting to the daemon…"}
          </div>
        </div>
      ) : (
      <div className="agent-grid">
        {agents.map((a) => (
          <div key={a.id} className="agent-card">
            <div className="hd">
              <AgentAvatar agent={a} size={36} />
              <div style={{ flex: 1 }}>
                <div className="name">
                  {a.name}{" "}
                  <span className="faint mono" style={{ fontSize: 10, marginLeft: 6 }}>{a.nameCn}</span>
                </div>
                <div className="role">{a.role} · {a.provider}</div>
              </div>
              <StatusTag status={a.status} />
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>{a.providerNote}</div>
            <div className="caps">
              {a.capabilities.map((c) => <span key={c} className="tag mono">{c}</span>)}
            </div>
            <div className="stats">
              <div className="stat">
                <div className="n">{a.missions}</div>
                <div className="l">Missions</div>
              </div>
              <div className="stat">
                <div className="n">{a.tokensIn}</div>
                <div className="l">Tok in</div>
              </div>
              <div className="stat">
                <div className="n">{a.tokensOut}</div>
                <div className="l">Tok out</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

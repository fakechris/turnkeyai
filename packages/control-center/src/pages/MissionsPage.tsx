// Missions home. Grid of mission cards with status filter + sort row.
//
// Per K1 scope: cards come from MOCK_DATA. The K2 swap is exactly:
//   `const list = filtered missions from mockData` → `useMissions()` hook
//   backed by a real `/missions` daemon endpoint.

import { useState } from "react";

import { MOCK_DATA, type Mission } from "../mock/mission-data";
import { Icon } from "../components/Icon";
import { AgentStack, StatusTag } from "../components/atoms";
import { useAppState } from "../state/AppState";
import { STATUS_LABEL, type MissionStatus } from "../state/types";

interface Filter {
  id: "all" | MissionStatus;
  label: string;
  count: number;
}

export function MissionsPage({ onNewMission }: { onNewMission: () => void }) {
  const { setRoute, openMission } = useAppState();
  const [filter, setFilter] = useState<Filter["id"]>("all");

  const filters: Filter[] = [
    { id: "all", label: "All", count: MOCK_DATA.missions.length },
    { id: "working", label: "Working", count: count("working") },
    { id: "needs_approval", label: "Needs approval", count: count("needs_approval") },
    { id: "blocked", label: "Blocked", count: count("blocked") },
    { id: "done", label: "Done", count: count("done") },
    { id: "draft", label: "Draft", count: count("draft") },
  ];

  const list = filter === "all"
    ? MOCK_DATA.missions
    : MOCK_DATA.missions.filter((m) => m.status === filter);

  const pendingTotal = MOCK_DATA.approvals.length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Missions</h2>
          <div className="sub">
            本地多 Agent 工作台 · 你给目标，TurnkeyAI 协调 agents 完成、留痕。
          </div>
        </div>
        <div className="right">
          <button type="button" className="btn" onClick={() => setRoute("approvals")}>
            <Icon name="approvals" size={13} /> {pendingTotal} pending
          </button>
          <button type="button" className="btn primary" onClick={onNewMission}>
            <Icon name="plus" size={13} /> New mission
          </button>
        </div>
      </div>

      <div className="filter-bar">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            className={"filter-chip" + (filter === f.id ? " active" : "")}
            onClick={() => setFilter(f.id)}
          >
            {f.label} <span className="ct">{f.count}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <div className="row" style={{ gap: 8 }}>
          <span className="label">Sort</span>
          <select
            className="field"
            style={{ width: 140, height: 28, padding: "2px 8px" }}
            defaultValue="updated"
          >
            <option value="updated">Last updated</option>
            <option value="created">Created</option>
            <option value="status">Status</option>
          </select>
        </div>
      </div>

      <div className="mission-grid">
        {list.map((m) => (
          <MissionCard key={m.id} mission={m} onOpen={() => openMission(m.id)} />
        ))}
      </div>
    </div>
  );
}

function MissionCard({ mission, onOpen }: { mission: Mission; onOpen: () => void }) {
  return (
    <button type="button" className="mission-card" onClick={onOpen}>
      <div className="row">
        <span className={"status-dot " + mission.status} />
        <StatusTag status={mission.status} />
        <div style={{ flex: 1 }} />
        <span className="label-id mono">{mission.shortId}</span>
      </div>
      <h3>{mission.title}</h3>
      <div className="desc">{mission.desc}</div>
      <div className="row" style={{ gap: 10 }}>
        <AgentStack ids={mission.agents} max={4} />
        <div className="progress" style={{ flex: 1 }}>
          <div className="fill" style={{ width: `${mission.progress * 100}%` }} />
        </div>
        <span className="mono faint" style={{ fontSize: 10.5 }}>
          {Math.round(mission.progress * 100)}%
        </span>
      </div>
      <div className="footer">
        <span>{mission.modeLabel}</span>
        <span>·</span>
        <span>{mission.createdAt}</span>
        <div style={{ flex: 1 }} />
        {mission.pendingApprovals > 0 && (
          <span className="tag warning">
            <span className="dot" />
            {mission.pendingApprovals} approval{mission.pendingApprovals > 1 ? "s" : ""}
          </span>
        )}
        {mission.blockers > 0 && (
          <span className="tag danger">
            <span className="dot" />
            {mission.blockers} blocked
          </span>
        )}
      </div>
    </button>
  );
}

function count(status: MissionStatus): number {
  return MOCK_DATA.missions.filter((m) => m.status === status).length;
}

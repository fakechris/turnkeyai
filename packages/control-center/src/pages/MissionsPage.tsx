// Missions home. Grid of mission cards with status filter + sort row.
//
// K3.5: live-only. The /missions endpoint is the single source of truth.
// MOCK_DATA fallback is gone — an empty list renders an empty state with
// a clear "Create your first mission" CTA. Bootstrap-demo is still
// available to operators as a one-shot "show me what populated looks
// like" button, but it's not the default render path.

import { useState } from "react";

import type { Mission } from "../api/mission-api";
import { useApprovals, useBootstrapDemo, useMissions } from "../api/useMissionData";
import { Icon } from "../components/Icon";
import { AgentStack, StatusTag } from "../components/atoms";
import { useAppState } from "../state/AppState";
import { type MissionStatus } from "../state/types";

interface Filter {
  id: "all" | MissionStatus;
  label: string;
  count: number;
}

export function MissionsPage({ onNewMission }: { onNewMission: () => void }) {
  const { state, setRoute, openMission } = useAppState();
  const [filter, setFilter] = useState<Filter["id"]>("all");
  // Live missions from /missions. No mock fallback — the page renders
  // an empty-state CTA when the daemon hasn't received any missions yet.
  const missions = useMissions([]);
  const approvals = useApprovals([]);
  const bootstrap = useBootstrapDemo();
  const [bootstrapStatus, setBootstrapStatus] = useState<"idle" | "loading" | "error">("idle");

  const missionList = missions.value;
  const filters: Filter[] = [
    { id: "all", label: "All", count: missionList.length },
    { id: "working", label: "Working", count: countBy(missionList, "working") },
    { id: "needs_approval", label: "Needs approval", count: countBy(missionList, "needs_approval") },
    { id: "blocked", label: "Blocked", count: countBy(missionList, "blocked") },
    { id: "done", label: "Done", count: countBy(missionList, "done") },
    { id: "draft", label: "Draft", count: countBy(missionList, "draft") },
  ];

  const list = filter === "all" ? missionList : missionList.filter((m) => m.status === filter);
  const pendingTotal = approvals.value.filter((a) => !a.decision).length;

  // Show a "Load demo missions" button when the daemon is reachable but
  // empty — operator click triggers POST /missions/bootstrap-demo, then
  // refetches. Gated on scope (codex K2 #5): bootstrap-demo is
  // operator-only, so a read-token user clicking would 401 and apiClient
  // would clear their token, dropping them to the no-token page. Hide
  // the button entirely for read scope to avoid the trap.
  const canBootstrap = state.scope !== "read";
  const onLoadDemo = async () => {
    setBootstrapStatus("loading");
    try {
      await bootstrap();
      missions.refetch();
      approvals.refetch();
      setBootstrapStatus("idle");
    } catch {
      setBootstrapStatus("error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Missions</h2>
          <div className="sub">
            本地多 Agent 工作台 · 你给目标，TurnkeyAI 协调 agents 完成、留痕。
            {!missions.isLive && (
              <span className="mono faint" style={{ marginLeft: 8, fontSize: 11 }}>· offline fallback</span>
            )}
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

      {missionList.length === 0 ? (
        <EmptyMissionsState
          isLive={missions.isLive}
          canBootstrap={canBootstrap}
          bootstrapStatus={bootstrapStatus}
          onBootstrap={onLoadDemo}
          onNewMission={onNewMission}
        />
      ) : list.length > 0 ? (
        <div className="mission-grid">
          {list.map((m) => (
            <MissionCard key={m.id} mission={m} onOpen={() => openMission(m.id)} />
          ))}
        </div>
      ) : (
        // coderabbit K3.5: when missions exist but the current
        // filter matches none, show a filter-specific empty state
        // — NOT the "Create your first mission" CTA, which only
        // applies to a genuinely empty dataset.
        <div
          className="card"
          style={{ marginTop: 16, padding: 24, textAlign: "center" }}
        >
          <div className="muted" style={{ fontSize: 12.5 }}>
            No missions match the “{filter}” filter.{" "}
            <button
              type="button"
              className="btn ghost"
              onClick={() => setFilter("all")}
              style={{ padding: "2px 8px", fontSize: 12 }}
            >
              Clear filter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyMissionsState({
  isLive,
  canBootstrap,
  bootstrapStatus,
  onBootstrap,
  onNewMission,
}: {
  isLive: boolean;
  canBootstrap: boolean;
  bootstrapStatus: "idle" | "loading" | "error";
  onBootstrap: () => void;
  onNewMission: () => void;
}) {
  if (!isLive) {
    return (
      <div className="card" style={{ marginTop: 16, padding: 32, textAlign: "center" }}>
        <div className="muted">Connecting to the daemon…</div>
      </div>
    );
  }
  return (
    <div
      className="card"
      style={{
        marginTop: 16,
        padding: 32,
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>No missions yet.</div>
      <div className="muted" style={{ maxWidth: 520, fontSize: 12.5, lineHeight: 1.6 }}>
        Create a mission to give the agent team a goal. The coordinator
        breaks it down and dispatches work; you watch progress and follow
        up from the mission's detail page.
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn primary" onClick={onNewMission}>
          <Icon name="plus" size={13} /> Create your first mission
        </button>
        {canBootstrap && (
          <button
            type="button"
            className="btn"
            onClick={onBootstrap}
            disabled={bootstrapStatus === "loading"}
          >
            <Icon name="play" size={13} />{" "}
            {bootstrapStatus === "loading" ? "Loading…" : "Load demo fixtures"}
          </button>
        )}
      </div>
      {canBootstrap && (
        <div className="muted" style={{ fontSize: 10.5, maxWidth: 460 }}>
          Demo fixtures populate read-only sample missions (MSN-1042 etc.) so
          you can preview the populated layout. They do NOT run any agents.
        </div>
      )}
      {bootstrapStatus === "error" && (
        <div
          role="alert"
          className="muted"
          style={{ fontSize: 11, color: "var(--danger)", maxWidth: 460 }}
        >
          Failed to load demo fixtures. Check the daemon log and try again.
        </div>
      )}
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

function countBy(missions: Mission[], status: MissionStatus): number {
  return missions.filter((m) => m.status === status).length;
}

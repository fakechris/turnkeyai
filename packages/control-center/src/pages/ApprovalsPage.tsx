// Approvals queue — pending + decided tabs. K4 will persist decisions
// through a daemon endpoint; for now the dashboard records them in
// local session state (state.decisions) and the daemon-side approvals
// are read-only.

import { useState } from "react";

import type { ApprovalRow } from "../api/mission-api";
import { useAgents, useApprovals, useContextSources } from "../api/useMissionData";
import { CtxIcon, Icon } from "../components/Icon";
import { AgentAvatar } from "../components/atoms";
import { useAppState } from "../state/AppState";

export function ApprovalsPage() {
  const { state, decideApproval, openMission } = useAppState();
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const approvalsRemote = useApprovals([]);
  const agentsRemote = useAgents([]);
  const contextRemote = useContextSources([]);
  const approvals = approvalsRemote.value;
  const agents = agentsRemote.value;
  const contextSources = contextRemote.value;

  const allPending = approvals.filter(
    (a) => !a.decision && !state.decisions[a.id]
  );
  const allDecided = approvals.filter(
    (a) => a.decision || state.decisions[a.id]
  );
  const list = tab === "pending" ? allPending : allDecided;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Approvals</h2>
          <div className="sub">
            人在回路。每一项都带 mission · agent · context · 风险说明 · 精确动作。
          </div>
        </div>
        <div className="right">
          <button type="button" className="btn"><Icon name="shield" size={13} /> Policy rules</button>
        </div>
      </div>

      <div className="tab-bar">
        <button
          type="button"
          className={"t" + (tab === "pending" ? " active" : "")}
          onClick={() => setTab("pending")}
        >
          Pending <span className="mono faint" style={{ fontSize: 10, marginLeft: 4 }}>{allPending.length}</span>
        </button>
        <button
          type="button"
          className={"t" + (tab === "decided" ? " active" : "")}
          onClick={() => setTab("decided")}
        >
          Decided <span className="mono faint" style={{ fontSize: 10, marginLeft: 4 }}>{allDecided.length}</span>
        </button>
      </div>

      {list.length === 0 && (
        <div className="card" style={{ padding: 30, textAlign: "center" }}>
          <Icon name="check" size={24} />
          <div style={{ marginTop: 8, color: "var(--text-muted)" }}>
            没有待处理审批 · 你可以专注于其他事。
          </div>
        </div>
      )}

      {list.map((ap) => {
        // coderabbit K3.5: prefer local session state if present
        // (we just clicked Approve/Deny and the daemon hasn't
        // round-tripped yet) but FALL BACK to the daemon-attached
        // decision so the Decided tab doesn't render Approve/Deny
        // buttons for approvals already decided server-side.
        const localDecision = state.decisions[ap.id];
        const daemonDecision =
          ap.decision && (ap.decision.decision === "approved" || ap.decision.decision === "denied")
            ? ap.decision.decision
            : undefined;
        const effective = localDecision ?? daemonDecision;
        return (
          <ApprovalRowView
            key={ap.id}
            approval={ap}
            decision={effective}
            agents={agents}
            contextSources={contextSources}
            onApprove={() => decideApproval(ap.id, "approved")}
            onDeny={() => decideApproval(ap.id, "denied")}
            onOpenMission={() => openMission(ap.missionId)}
          />
        );
      })}
    </div>
  );
}

function ApprovalRowView({
  approval,
  decision,
  agents,
  contextSources,
  onApprove,
  onDeny,
  onOpenMission,
}: {
  approval: ApprovalRow;
  decision: "approved" | "denied" | undefined;
  agents: ReadonlyArray<{ id: string; name: string; role: string; ava: string; color: string }>;
  contextSources: ReadonlyArray<{ id: string; kind: string; title: string }>;
  onApprove: () => void;
  onDeny: () => void;
  onOpenMission: () => void;
}) {
  const agent = agents.find((a) => a.id === approval.agent);
  return (
    <div className={"approval-row " + approval.severity}>
      <div className="severity">
        {approval.severity === "high" ? "!" : approval.severity === "med" ? "·" : "i"}
      </div>
      <div>
        <div className="ttl">{approval.title}</div>
        <div className="sub">{approval.cn}</div>
        <div className="meta">
          <span>{approval.action}</span>
          <span>·</span>
          <button
            type="button"
            onClick={onOpenMission}
            className="btn ghost"
            style={{ padding: 0, fontSize: 10.5, fontFamily: "var(--font-mono)" }}
          >
            {approval.missionTitle}
          </button>
          <span>·</span>
          <span>requested {approval.requestedAgo}</span>
          <span>·</span>
          <span>policy: {approval.policyHint}</span>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 10 }}>
          {agent && (
            <span className="tag">
              <AgentAvatar agent={agent as never} size={14} />
              <span style={{ marginLeft: 4 }}>{agent.name}</span>
            </span>
          )}
          {approval.affects.map((id) => {
            const c = contextSources.find((s) => s.id === id);
            if (!c) return null;
            return (
              <span key={id} className="tag">
                <CtxIcon kind={c.kind as never} /> {c.title}
              </span>
            );
          })}
          <span className="tag warning">risk: {approval.risk}</span>
        </div>
      </div>
      <div className="deciders">
        {!decision ? (
          <>
            <button type="button" className="btn success" onClick={onApprove}>
              <Icon name="check" size={12} /> Approve
            </button>
            <button type="button" className="btn danger" onClick={onDeny}>
              <Icon name="x" size={12} /> Deny
            </button>
            <button type="button" className="btn ghost">View details ↗</button>
          </>
        ) : (
          <>
            <span
              className={"tag " + (decision === "approved" ? "success" : "danger")}
              style={{ alignSelf: "stretch", justifyContent: "center", padding: "6px 10px" }}
            >
              {decision === "approved" ? "✓ approved" : "✕ denied"} · just now
            </span>
            <button type="button" className="btn ghost">View timeline ↗</button>
          </>
        )}
      </div>
    </div>
  );
}

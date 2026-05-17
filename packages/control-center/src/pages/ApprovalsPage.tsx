// Approvals queue — pending + decided tabs. Decisions are local-session
// only in K1; K4 will persist them through a daemon endpoint.

import { useState } from "react";

import {
  MOCK_DATA,
  agentById,
  ctxById,
  type ApprovalRequest,
} from "../mock/mission-data";
import { CtxIcon, Icon } from "../components/Icon";
import { AgentAvatar } from "../components/atoms";
import { useAppState } from "../state/AppState";

export function ApprovalsPage() {
  const { state, decideApproval, openMission } = useAppState();
  const [tab, setTab] = useState<"pending" | "decided">("pending");

  const allPending = MOCK_DATA.approvals.filter((a) => !state.decisions[a.id]);
  const allDecided = MOCK_DATA.approvals.filter((a) => state.decisions[a.id]);
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

      {list.map((ap) => (
        <ApprovalRow
          key={ap.id}
          approval={ap}
          decision={state.decisions[ap.id]}
          onApprove={() => decideApproval(ap.id, "approved")}
          onDeny={() => decideApproval(ap.id, "denied")}
          onOpenMission={() => openMission(ap.missionId)}
        />
      ))}
    </div>
  );
}

function ApprovalRow({
  approval,
  decision,
  onApprove,
  onDeny,
  onOpenMission,
}: {
  approval: ApprovalRequest;
  decision: "approved" | "denied" | undefined;
  onApprove: () => void;
  onDeny: () => void;
  onOpenMission: () => void;
}) {
  const agent = agentById(approval.agent);
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
              <AgentAvatar agent={agent} size={14} />
              <span style={{ marginLeft: 4 }}>{agent.name}</span>
            </span>
          )}
          {approval.affects.map((id) => {
            const c = ctxById(id);
            if (!c) return null;
            return (
              <span key={id} className="tag">
                <CtxIcon kind={c.kind} /> {c.title}
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

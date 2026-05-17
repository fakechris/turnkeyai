// Mission Detail — the core screen. Three panes: Work Plan / Activity
// Timeline / Context + Control. Translated 1:1 from the design's
// MissionDetailView + MissionThreePane in views.jsx.
//
// K1 scope: read-only. Approve/Deny only update local in-session
// state.decisions (no daemon endpoint yet). Mutations (Reattach,
// Revoke, Navigate, Snapshot) render as visible safe-action buttons but
// don't dispatch — wired in K3.

import { useMemo, useState } from "react";

import {
  MOCK_DATA,
  agentById,
  ctxById,
  missionById,
  type ActivityEvent,
  type ApprovalRequest,
  type ContextKind,
  type ContextSource,
  type Mission,
  type WorkItem,
} from "../mock/mission-data";
import { useContextSources } from "../api/useMissionData";
import { Icon, CtxIcon } from "../components/Icon";
import { AgentAvatar, AgentStack, StatusTag } from "../components/atoms";
import { useAppState } from "../state/AppState";
import { STATUS_LABEL, type MissionStatus } from "../state/types";

const TL_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "approval", label: "Approvals" },
  { id: "browser", label: "Browser" },
  { id: "doc", label: "Doc" },
  { id: "recovery", label: "Failures" },
  { id: "artifact", label: "Artifacts" },
];

export function MissionDetailPage({ missionId }: { missionId: string }) {
  const { setRoute } = useAppState();
  const mission = missionById(missionId) ?? MOCK_DATA.missions[0];
  if (!mission) {
    return (
      <div className="page">
        <p className="muted">No missions available.</p>
      </div>
    );
  }
  // Only msn.01 has rich mock data backing the three panes. For other
  // missions render the same shell with a "view sample data" pointer.
  const hasRichData = mission.id === "msn.01";

  return (
    <>
      <MissionBar mission={mission} onBack={() => setRoute("missions")} />
      {mission.status === "needs_approval" && <ApprovalBanner />}
      {hasRichData && <RecoveryBanner />}
      {hasRichData ? (
        <ThreePane />
      ) : (
        <div className="page" style={{ padding: 28 }}>
          <p className="muted">
            This mission's detail view uses the same three-pane layout as MSN-1042.
            Mock data only covers MSN-1042 in K1 — open it to see it populated.
          </p>
          <button type="button" className="btn primary" onClick={() => setRoute("missions")}>
            ← Back to Missions
          </button>
        </div>
      )}
    </>
  );
}

function MissionBar({ mission, onBack }: { mission: Mission; onBack: () => void }) {
  return (
    <div className="mission-bar">
      <button type="button" className="btn ghost" onClick={onBack} style={{ padding: "2px 6px" }}>
        ← Missions
      </button>
      <span className="mono faint" style={{ fontSize: 10.5 }}>{mission.shortId}</span>
      <h2 style={{ marginLeft: 4 }}>{mission.title}</h2>
      <StatusTag status={mission.status} />
      <div className="meta">created {mission.createdAt} · {mission.modeLabel}</div>
      <div className="right">
        <AgentStack ids={mission.agents} max={5} />
        <button type="button" className="btn"><Icon name="diagnose" size={13} /> Diagnostics</button>
        <button type="button" className="btn"><Icon name="external" size={13} /> Export</button>
      </div>
    </div>
  );
}

function ApprovalBanner() {
  const { setRoute } = useAppState();
  return (
    <div className="approval-banner">
      <span className="warn-dot" />
      <span>
        <b>2 approvals waiting.</b> Browser Operator 想在 notion.so 提交表单；Doc Agent 想写入 §4。{" "}
        <span className="faint mono" style={{ marginLeft: 8 }}>oldest 00:00:51</span>
      </span>
      <div className="actions">
        <button type="button" className="btn" onClick={() => setRoute("approvals")}>
          Review queue
        </button>
      </div>
    </div>
  );
}

function RecoveryBanner() {
  return (
    <div className="recovery-banner">
      <span className="status-dot blocked" style={{ width: 8, height: 8 }} />
      <span>
        <b>Recovery case.</b> Browser session detached while Research Agent was extracting
        Reflect pricing evidence. <span className="faint mono" style={{ marginLeft: 4 }}>auto-retried 1×</span>
      </span>
      <div className="actions" style={{ marginLeft: "auto" }}>
        <button type="button" className="btn">Open recovery case</button>
      </div>
    </div>
  );
}

function ThreePane() {
  return (
    <div className="mission-shell">
      <WorkPlanPane />
      <TimelinePane />
      <ContextPane />
    </div>
  );
}

// ── Left: Work Plan ────────────────────────────────────────────────────

function WorkPlanPane() {
  const groupOrder: MissionStatus[] = [
    "needs_approval",
    "blocked",
    "working",
    "planning",
    "done",
    "draft",
  ];
  const groups: Partial<Record<MissionStatus, WorkItem[]>> = {};
  for (const w of MOCK_DATA.workItems) {
    (groups[w.status] ||= []).push(w);
  }
  const visibleAgents = MOCK_DATA.agents.filter((a) => a.id !== "agent.recovery");

  return (
    <div className="mission-pane">
      <div className="workplan">
        <div>
          <div className="section-h">
            <span className="label">Work plan</span>
            <span className="meta">8 items · 1 blocked · 1 approval</span>
          </div>
          {groupOrder.map((status) => {
            const items = groups[status];
            if (!items?.length) return null;
            return (
              <div key={status} style={{ marginBottom: 8 }}>
                <div className="label" style={{ padding: "4px 8px", fontSize: 10 }}>
                  {STATUS_LABEL[status]} · <span className="mono faint">{items.length}</span>
                </div>
                {items.map((wi) => <WorkItemRow key={wi.id} wi={wi} />)}
              </div>
            );
          })}
        </div>

        <div>
          <div className="section-h">
            <span className="label">Agents on this mission</span>
            <span className="meta">{visibleAgents.length}</span>
          </div>
          {visibleAgents.map((a) => (
            <div key={a.id} className="agent-row">
              <AgentAvatar agent={a} />
              <div className="meta">
                <span className="name">{a.name}</span>
                <span className="role">{a.role} · {a.provider}</span>
              </div>
              <span className={"status-dot " + a.status} title={STATUS_LABEL[a.status]} />
            </div>
          ))}
        </div>

        <div>
          <div className="section-h">
            <span className="label">Context sources</span>
            <span className="meta">{MOCK_DATA.contextSources.length}</span>
          </div>
          {MOCK_DATA.contextSources.slice(0, 5).map((c) => (
            <div key={c.id} className="agent-row">
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  display: "grid",
                  placeItems: "center",
                  background: "var(--muted-soft)",
                  color: "var(--text-muted)",
                  flexShrink: 0,
                }}
              >
                <CtxIcon kind={c.kind} />
              </div>
              <div className="meta">
                <span className="name">{c.title}</span>
                <span className="role">{c.cn} · {c.state}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkItemRow({ wi }: { wi: WorkItem }) {
  const [expanded, setExpanded] = useState(wi.id === "wi.verify-pricing");
  const agent = agentById(wi.agent);

  return (
    // Keyboard-accessible expander (codex K1 should-fix). Using a <button>
    // instead of a <div onClick> so Enter/Space toggle natively, the row
    // is in the tab order, and screen readers announce the expanded state
    // via aria-expanded.
    <button
      type="button"
      className={"work-item " + wi.status + (expanded ? " expanded" : "") + (wi.status === "done" ? " done" : "")}
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      style={{ font: "inherit", color: "inherit", textAlign: "left", width: "100%" }}
    >
      <div className="wi-row">
        <span className="wi-num mono">{String(wi.n).padStart(2, "0")}</span>
        <span className={"status-dot " + wi.status} style={{ width: 7, height: 7 }} />
        <span className="wi-title">{wi.title}</span>
        {agent && <AgentAvatar agent={agent} size={18} />}
      </div>
      <div className="wi-meta">
        <span>{wi.cn}</span>
      </div>
      {expanded && (
        <div className="wi-extra">
          <div className="row" style={{ gap: 6, padding: "2px 0 6px" }}>
            <StatusTag status={wi.status} />
            {wi.duration !== "—" && <span className="tag mono">⏱ {wi.duration}</span>}
            {wi.contextRefs.map((id) => {
              const c = ctxById(id);
              if (!c) return null;
              return (
                <span key={id} className="tag">
                  <CtxIcon kind={c.kind} /> {c.title}
                </span>
              );
            })}
          </div>
          <div className="row"><span className="k">STARTED</span><span className="v mono">{wi.started}</span></div>
          <div className="row"><span className="k">OUTPUT</span><span className="v">{wi.output}</span></div>
          {wi.progress != null && (
            <div className="row" style={{ alignItems: "center" }}>
              <span className="k">PROGRESS</span>
              <span className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="progress" style={{ width: 120 }}>
                  <span className="fill" style={{ width: `${wi.progress * 100}%` }} />
                </span>
                <span className="mono faint" style={{ fontSize: 10 }}>
                  {Math.round(wi.progress * 100)}%
                </span>
              </span>
            </div>
          )}
          {wi.blocker && (
            <div className="row">
              <span className="k">BLOCKER</span>
              <span className="v" style={{ color: "var(--danger)" }}>{wi.blocker}</span>
            </div>
          )}
        </div>
      )}
    </button>
  );
}

// ── Center: Timeline ──────────────────────────────────────────────────

function TimelinePane() {
  const { state, decideApproval } = useAppState();
  const [filter, setFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    return MOCK_DATA.timeline.filter((e) => filter === "all" || e.kind === filter);
  }, [filter]);

  return (
    <div className="mission-pane center">
      <div className="timeline-head">
        <span className="lbl label">Activity timeline</span>
        <span className="mono faint" style={{ fontSize: 10.5, marginRight: 8 }}>
          {filtered.length} events
        </span>
        <span className="spacer" />
        {TL_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={"filter-chip" + (filter === f.id ? " active" : "")}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="timeline">
        <div className="tl-day">{MOCK_DATA.timeline[0]?.day}</div>
        {filtered.map((e, i) => {
          const decision = e.approvalId ? state.decisions[e.approvalId] : undefined;
          return (
            <TimelineEventRow
              key={i}
              event={e}
              {...(decision ? { decision } : {})}
              onApprove={(id) => decideApproval(id, "approved")}
              onDeny={(id) => decideApproval(id, "denied")}
            />
          );
        })}
        <div style={{ height: 40 }} />
      </div>
    </div>
  );
}

function TimelineEventRow({
  event,
  decision,
  onApprove,
  onDeny,
}: {
  event: ActivityEvent;
  decision?: "approved" | "denied";
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const actor = agentById(event.actor);
  const target = event.target ? ctxById(event.target) : null;
  const emphasis = decision === "approved" ? "success" : decision === "denied" ? "danger" : event.emph;

  return (
    <div className="tl-event" data-kind={event.kind}>
      <div className="tl-time mono">{event.t}</div>
      <div className="tl-gutter">
        <div className="tl-marker" />
      </div>
      <div className="tl-body" data-emph={emphasis}>
        <div className="tl-actor">
          {actor?.name || "System"}
          {actor && <span className="role-mini">{actor.role}</span>}
          {target && <span className="role-mini">→ {target.title}</span>}
        </div>
        {/* Mock data uses <b>, <code> inside `text`. Keep as innerHTML for
            fidelity; safe because the source strings are static in K1.
            K2 will replace with structured event nodes. */}
        <div className="tl-msg" dangerouslySetInnerHTML={{ __html: event.text }} />

        {event.evidence && (
          <div className="tl-evidence">
            {event.evidence.map((ev) => (
              <EvidenceThumb key={ev.id} kind={ev.kind} label={ev.label} />
            ))}
          </div>
        )}

        {event.kind === "approval" && event.approvalId && !decision && (
          <div className="tl-tail" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="btn success"
              onClick={() => onApprove(event.approvalId!)}
            >
              <Icon name="check" size={12} /> Approve
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => onDeny(event.approvalId!)}
            >
              <Icon name="x" size={12} /> Deny
            </button>
            <button type="button" className="btn ghost">Details</button>
            <span className="faint mono" style={{ fontSize: 10, alignSelf: "center", marginLeft: 4 }}>
              policy: requires approval
            </span>
          </div>
        )}
        {decision && (
          <div className="tl-tail" style={{ marginTop: 8 }}>
            <span className={"tag " + (decision === "approved" ? "success" : "danger")}>
              {decision === "approved" ? "✓ approved" : "✕ denied"} by you · just now
            </span>
          </div>
        )}

        {event.kind === "recovery" && (
          <div className="tl-tail" style={{ marginTop: 10 }}>
            <button type="button" className="btn">Open recovery case</button>
            <button type="button" className="btn ghost">Acknowledge</button>
          </div>
        )}
      </div>
    </div>
  );
}

function EvidenceThumb({
  kind,
  label,
}: {
  kind: "snapshot" | "screenshot" | "extract" | "diff" | "json";
  label: string;
}) {
  if (kind === "screenshot") {
    return (
      <div className="tl-thumb" style={{ display: "grid", placeItems: "center", color: "var(--text-faint)" }}>
        <Icon name="camera" size={24} />
        <span className="thumb-tag">{label}</span>
      </div>
    );
  }
  if (kind === "snapshot" || kind === "extract" || kind === "json") {
    return (
      <div
        className="tl-thumb"
        style={{ padding: 8, fontFamily: "var(--font-mono)", fontSize: 9, lineHeight: 1.4, color: "var(--text-muted)" }}
      >
        <div style={{ color: "var(--text)" }}>{`{`}</div>
        <div>&nbsp;&nbsp;"vendor": "notion",</div>
        <div>&nbsp;&nbsp;"plan": "team",</div>
        <div>&nbsp;&nbsp;"price": null,</div>
        <div>&nbsp;&nbsp;"needs": "form"</div>
        <div style={{ color: "var(--text)" }}>{`}`}</div>
        <span className="thumb-tag">{label}</span>
      </div>
    );
  }
  // diff
  return (
    <div
      className="tl-thumb"
      style={{ padding: 8, fontFamily: "var(--font-mono)", fontSize: 9, lineHeight: 1.5, color: "var(--text-muted)" }}
    >
      <div style={{ color: "var(--success)" }}>+ ## §1 Notion AI 概览</div>
      <div style={{ color: "var(--success)" }}>+ - 定价：免费 / Plus $10 / Business…</div>
      <div style={{ color: "var(--success)" }}>+ ## §2 Reflect</div>
      <div style={{ color: "var(--text-faint)" }}>… +480 lines</div>
      <span className="thumb-tag">{label}</span>
    </div>
  );
}

// ── Right: Context + Control ──────────────────────────────────────────

function ContextPane() {
  // K3: pull the live context-source list from the daemon. The K1 mock
  // remains the fallback (so the page still has shape when the daemon
  // isn't running) but once the bridge has any active session, it
  // appears here automatically — the daemon merges live browser
  // sessions with the registry-backed entries.
  const contextSources = useContextSources(MOCK_DATA.contextSources).value;
  const [tab, setTab] = useState<ContextKind>("browser");
  const [selectedId, setSelectedId] = useState<string>("");
  const sources = contextSources.filter((c) => c.kind === tab);
  const selected = sources.find((s) => s.id === selectedId) ?? sources[0];

  const countByKind = (kind: ContextKind) =>
    contextSources.filter((c) => c.kind === kind).length;

  const tabs: Array<{ id: ContextKind; label: string }> = [
    { id: "browser", label: "Browser" },
    { id: "doc", label: "Docs" },
    { id: "folder", label: "Files" },
    { id: "api", label: "APIs" },
    { id: "desktop", label: "Desktop" },
  ];

  return (
    <div className="mission-pane">
      <div className="context-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"context-tab" + (tab === t.id ? " active" : "")}
            onClick={() => {
              setTab(t.id);
              setSelectedId("");
            }}
          >
            {t.label}<span className="ct-count">{countByKind(t.id)}</span>
          </button>
        ))}
      </div>

      {tab === "browser" && selected && (
        <BrowserContextBody source={selected} sources={sources} onSelect={setSelectedId} />
      )}
      {tab === "doc" && selected && <DocContextBody source={selected} />}
      {tab === "folder" && selected && <FolderContextBody source={selected} />}
      {tab === "api" && selected && <ApiContextBody source={selected} />}
      {tab === "desktop" && selected && <DesktopContextBody source={selected} />}

      <PendingApprovalCard />
    </div>
  );
}

function BrowserContextBody({
  source,
  sources,
  onSelect,
}: {
  source: ContextSource;
  sources: ContextSource[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="ctx-body">
      <div className="row">
        <span className="label" style={{ flex: 1 }}>Browser sessions</span>
        <span className="mono faint" style={{ fontSize: 10 }}>{sources.length} session{sources.length === 1 ? "" : "s"}</span>
      </div>
      <div className="col" style={{ gap: 4 }}>
        {sources.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            style={{
              padding: "6px 10px",
              background:
                c.id === source.id ? "var(--accent-soft)" : "var(--surface)",
              border:
                "1px solid " +
                (c.id === source.id
                  ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                  : "var(--border)"),
              borderRadius: "var(--r-sm)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
            }}
          >
            <span
              className={"status-dot " + (c.state === "attached" ? "working" : "blocked")}
              style={{ width: 6, height: 6 }}
            />
            <span
              style={{
                flex: 1,
                textAlign: "left",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              {c.title}
            </span>
            <span className="tag mono">{c.transport}</span>
          </button>
        ))}
      </div>

      <div className="browser-frame">
        <div className="browser-addr">
          <span className="secure" style={{ color: "var(--success)" }}>●</span>
          <span className="url">{source.url}</span>
          <Icon name="refresh" size={11} />
          <Icon name="more" size={11} />
        </div>
        <div className="browser-meta">
          <span className="k">Session</span><span className="v mono">{source.session}</span>
          <span className="k">Transport</span><span className="v mono">{source.transport}</span>
          <span className="k">State</span>
          <span className="v">
            <span
              className={"status-dot " + (source.state === "attached" ? "working" : "blocked")}
              style={{ width: 6, height: 6, marginRight: 4 }}
            />
            {source.state}
          </span>
          <span className="k">Last action</span><span className="v mono">{source.lastUse}</span>
        </div>
      </div>

      <div className="card">
        <div className="card-hd"><h3>Safe actions</h3></div>
        <div className="card-bd" style={{ padding: 6 }}>
          <div className="action-list">
            <div className="a">
              <span className="glyph"><Icon name="camera" size={13} /></span>
              Screenshot current viewport
              <span className="risk safe">safe</span>
            </div>
            <div className="a">
              <span className="glyph"><Icon name="snapshot" size={13} /></span>
              Capture DOM snapshot
              <span className="risk safe">safe</span>
            </div>
            <div className="a">
              <span className="glyph"><Icon name="external" size={13} /></span>
              Open tab in user browser
              <span className="risk safe">safe</span>
            </div>
            <div className="a">
              <span className="glyph"><Icon name="warning" size={13} /></span>
              Submit form / click confirm
              <span className="risk">approval</span>
            </div>
            <div className="a">
              <span className="glyph"><Icon name="warning" size={13} /></span>
              Download file
              <span className="risk">approval</span>
            </div>
            <div className="a">
              <span className="glyph"><Icon name="x" size={13} /></span>
              Revoke session
              <span className="risk danger">danger</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DocContextBody({ source }: { source: ContextSource }) {
  return (
    <div className="ctx-body">
      <div className="card">
        <div className="card-hd">
          <Icon name="doc" size={14} />
          <h3 style={{ flex: 1 }}>{source.title}</h3>
          <span className="tag success"><span className="dot" />watching</span>
        </div>
        <div
          className="card-bd"
          style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.6, color: "var(--text-muted)" }}
        >
          <div style={{ color: "var(--text)", fontWeight: 600 }}># 五款笔记应用对比矩阵</div>
          <div>updated 09:51 · agent.doc · rev 7</div>
          <div style={{ marginTop: 8, color: "var(--text)" }}>## §1 Notion AI &nbsp;<span style={{ color: "var(--success)" }}>✓ drafted</span></div>
          <div style={{ color: "var(--text)" }}>## §2 Reflect &nbsp;<span style={{ color: "var(--success)" }}>✓ drafted</span></div>
          <div style={{ color: "var(--text)" }}>## §3 Mem &nbsp;<span style={{ color: "var(--success)" }}>✓ drafted</span></div>
          <div style={{ color: "var(--text)" }}>## §4 协作与多 Agent 能力 &nbsp;<span style={{ color: "var(--warning)" }}>● approval</span></div>
          <div style={{ color: "var(--text-faint)" }}>## §5 风险与开放问题 &nbsp;<span style={{ color: "var(--text-faint)" }}>queued</span></div>
        </div>
      </div>
      <div className="browser-meta">
        <span className="k">Path</span><span className="v mono" style={{ textAlign: "right" }}>~/turnkey/research/…</span>
        <span className="k">Writer</span><span className="v mono">agent.doc</span>
        <span className="k">Baseline</span><span className="v mono">doc_b3 · 09:51</span>
        <span className="k">Diff buffer</span><span className="v mono">+12.8 kB / 480 lines</span>
      </div>
    </div>
  );
}

function FolderContextBody({ source }: { source: ContextSource }) {
  return (
    <div className="ctx-body">
      <div className="card">
        <div className="card-hd"><Icon name="folder" size={14} /><h3>{source.cn}</h3></div>
        <div className="card-bd mono" style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.7 }}>
          <div style={{ color: "var(--text)" }}>{source.url}/</div>
          <div>├── snapshots/ <span className="faint">11 files</span></div>
          <div>├── screenshots/ <span className="faint">7 files</span></div>
          <div>├── extracts/ <span className="faint">4 files</span></div>
          <div>├── evidence/ <span className="faint">2 files · sha-tagged</span></div>
          <div>└── competitor-matrix.md <span style={{ color: "var(--accent)" }}>(active)</span></div>
        </div>
      </div>
    </div>
  );
}

function ApiContextBody({ source }: { source: ContextSource }) {
  return (
    <div className="ctx-body">
      <div className="card">
        <div className="card-hd">
          <Icon name="api" size={14} />
          <h3>{source.title}</h3>
          <span className="tag success">ready</span>
        </div>
        <div className="card-bd">
          <div className="browser-meta" style={{ padding: 0 }}>
            <span className="k">Endpoint</span><span className="v mono" style={{ textAlign: "right" }}>{source.url}</span>
            <span className="k">Auth</span><span className="v mono">x-api-key · scope:search</span>
            <span className="k">Calls today</span><span className="v mono">11</span>
            <span className="k">Last call</span><span className="v mono">10:03:44</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopContextBody({ source }: { source: ContextSource }) {
  return (
    <div className="ctx-body">
      <div className="card">
        <div className="card-hd">
          <Icon name="desktop" size={14} />
          <h3>{source.title}</h3>
          <span className="tag warning">approval-gated</span>
        </div>
        <div className="card-bd muted" style={{ fontSize: 12 }}>
          桌面级访问总是需要审批。点击 <b>Request read</b> 让 agent 请求一次性截图能力，<b>不会</b> 授予持续访问。
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn warning">
              <Icon name="shield" size={12} /> Request one-shot read
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PendingApprovalCard() {
  const { state, decideApproval } = useAppState();
  const pending = MOCK_DATA.approvals.filter(
    (a) => a.missionId === "msn.01" && !state.decisions[a.id]
  );
  if (pending.length === 0) return null;
  return (
    <div className="ctx-body" style={{ paddingTop: 0 }}>
      <div
        className="card"
        style={{ borderColor: "color-mix(in srgb, var(--warning) 25%, transparent)" }}
      >
        <div
          className="card-hd"
          style={{ background: "var(--warning-soft)", borderBottom: 0 }}
        >
          <Icon name="warning" size={14} />
          <h3 style={{ color: "var(--warning)" }}>Approvals · {pending.length}</h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {pending.map((ap) => <PendingApprovalRow key={ap.id} approval={ap} onDecide={decideApproval} />)}
        </div>
      </div>
    </div>
  );
}

function PendingApprovalRow({
  approval,
  onDecide,
}: {
  approval: ApprovalRequest;
  onDecide: (id: string, decision: "approved" | "denied") => void;
}) {
  const agent = agentById(approval.agent);
  return (
    <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border-faint)" }}>
      <div style={{ fontWeight: 500, fontSize: 12.5, color: "var(--text)", marginBottom: 4 }}>
        {approval.title}
      </div>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>{approval.cn}</div>
      <div className="mono faint" style={{ fontSize: 10, marginTop: 6 }}>
        {agent?.name} · {approval.action} · {approval.requestedAgo}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button type="button" className="btn success" onClick={() => onDecide(approval.id, "approved")}>
          <Icon name="check" size={12} /> Approve
        </button>
        <button type="button" className="btn danger" onClick={() => onDecide(approval.id, "denied")}>
          <Icon name="x" size={12} /> Deny
        </button>
        <button type="button" className="btn ghost">Details</button>
      </div>
    </div>
  );
}

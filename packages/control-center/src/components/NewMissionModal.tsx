// New Mission modal. Creates a mission, seeds the initial brief, and lets
// the operator choose the agent team that should be recorded on the mission.

import { useCallback, useEffect, useRef, useState } from "react";

import type { Agent, MissionMode } from "../api/mission-api";
import { useAgents, useCreateMission } from "../api/useMissionData";

const MODES: Array<{ id: MissionMode; label: string; hint: string }> = [
  { id: "research", label: "Research and summarize", hint: "Explore sources, compare evidence, and synthesize." },
  { id: "monitor", label: "Monitor and update", hint: "Watch context over time and report material changes." },
  { id: "browser", label: "Operate browser", hint: "Use browser workers for dynamic pages and UI actions." },
  { id: "review", label: "Review and verify", hint: "Check claims, artifacts, citations, and residual risk." },
  { id: "investigation", label: "Multi-agent investigation", hint: "Coordinate browser, research, document, and review agents." },
  { id: "custom", label: "Custom", hint: "Use the default runtime team unless you select agents manually." },
];

export function NewMissionModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (missionId: string) => void;
}) {
  const createMission = useCreateMission();
  const agentsRemote = useAgents([]);
  const agents = agentsRemote.value;
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [mode, setMode] = useState<MissionMode>("research");
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [agentSelectionTouched, setAgentSelectionTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  // coderabbit K3.5: track the previous `open` value via a ref so we
  // can detect a true closed→open transition. Earlier, this effect
  // depended on `onClose` (which is recreated each parent render), so
  // any App.tsx re-render while the modal was open would re-fire the
  // effect body and wipe whatever the user had typed.
  const wasOpenRef = useRef(false);
  // Stash latest onClose in a ref so the Esc handler can call it
  // without making the effect depend on it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;
    if (justOpened) {
      // Only reset form on the closed→open transition.
      setTitle("");
      setDesc("");
      setMode("research");
      setSelectedAgents(recommendedAgentIds("research", agents));
      setAgentSelectionTouched(false);
      setSubmitting(false);
      setError(null);
    }
    // Focus title input after the dialog mounts. Tiny timeout so the
    // browser actually shows the modal before stealing focus (which
    // otherwise can interrupt the click that opened it on some browsers).
    const t = setTimeout(() => titleRef.current?.focus(), 0);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [agents, open]);

  useEffect(() => {
    if (!open || agentSelectionTouched) return;
    setSelectedAgents(recommendedAgentIds(mode, agents));
  }, [agentSelectionTouched, agents, mode, open]);

  const handleSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    const trimmedDesc = desc.trim();
    if (!trimmedTitle) {
      setError("Title is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const mission = await createMission({
        title: trimmedTitle,
        desc: trimmedDesc,
        mode,
        agents: selectedAgents,
      });
      onCreated(mission.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [title, desc, mode, selectedAgents, createMission, onCreated]);

  const toggleAgent = useCallback((agentId: string) => {
    setAgentSelectionTouched(true);
    setSelectedAgents((current) =>
      current.includes(agentId)
        ? current.filter((candidate) => candidate !== agentId)
        : [...current, agentId]
    );
  }, []);

  const modeHint = MODES.find((candidate) => candidate.id === mode)?.hint ?? "";

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--bg) 80%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        className="modal-panel card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 92vw)", maxWidth: "92vw" }}
      >
        <div className="card-hd">
          <h3 style={{ flex: 1 }}>New chat</h3>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="card-bd" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="label" style={{ fontSize: 11 }}>Name</span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Research five competitor notes apps"
              disabled={submitting}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="label" style={{ fontSize: 11 }}>Message</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Describe what you want the team to do. e.g. Compare pricing tiers across Notion, Reflect, Obsidian, Roam, Logseq. Highlight macOS-only features."
              rows={5}
              disabled={submitting}
              style={{ ...inputStyle, fontFamily: "var(--font-sans)", resize: "vertical" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="label" style={{ fontSize: 11 }}>Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as MissionMode)}
              disabled={submitting}
              style={inputStyle}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 11.5 }}>{modeHint}</span>
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="label" style={{ fontSize: 11 }}>Team</span>
              {agents.length > 0 && (
                <button
                  type="button"
                  className="btn ghost"
                  style={{ padding: "3px 8px" }}
                  disabled={submitting}
                  onClick={() => {
                    setSelectedAgents(recommendedAgentIds(mode, agents));
                    setAgentSelectionTouched(false);
                  }}
                >
                  Auto
                </button>
              )}
            </div>
            {agents.length > 0 ? (
              <div className="agent-select-grid" aria-label="Agent team">
                {agents.map((agent) => {
                  const selected = selectedAgents.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={"agent-select-item" + (selected ? " selected" : "")}
                      aria-pressed={selected}
                      disabled={submitting}
                      onClick={() => toggleAgent(agent.id)}
                    >
                      <span className="agent-select-name">{agent.name}</span>
                      <span className="agent-select-role">{agent.role} · {agent.provider}</span>
                      <span className="agent-select-caps">
                        {agent.capabilities.slice(0, 3).join(" · ")}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                {agentsRemote.isLive
                  ? "No mission agents are registered yet. The daemon will use the spawned runtime team's default roles."
                  : "Loading available mission agents…"}
              </div>
            )}
          </div>
          {error && (
            <div
              role="alert"
              style={{
                padding: "8px 10px",
                background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                borderRadius: "var(--r-sm)",
                color: "var(--danger)",
                fontSize: 11.5,
              }}
            >
              {error}
            </div>
          )}
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={handleSubmit}
              disabled={submitting || title.trim().length === 0}
            >
              {submitting ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-sm)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};

function recommendedAgentIds(mode: MissionMode, agents: Agent[]): string[] {
  if (agents.length === 0) return [];
  const matches = (agent: Agent, terms: string[]) => {
    const haystack = [
      agent.id,
      agent.name,
      agent.role,
      agent.provider,
      ...agent.capabilities,
    ].join(" ").toLowerCase();
    return terms.some((term) => haystack.includes(term));
  };
  const coordinator = agents.filter((agent) => matches(agent, ["coord", "lead", "plan", "delegate"]));
  const reviewer = agents.filter((agent) => matches(agent, ["review", "citation", "consistency"]));
  let specialists: Agent[] = [];
  switch (mode) {
    case "research":
      specialists = agents.filter((agent) => matches(agent, ["research", "search", "browser.read", "doc.read"]));
      break;
    case "monitor":
      specialists = agents.filter((agent) => matches(agent, ["monitor", "diagnostics", "replay", "browser", "doc"]));
      break;
    case "browser":
      specialists = agents.filter((agent) => matches(agent, ["browser", "session", "snapshot", "navigate"]));
      break;
    case "review":
      specialists = reviewer;
      break;
    case "investigation":
      specialists = agents.filter((agent) => matches(agent, ["research", "browser", "doc", "review"]));
      break;
    case "custom":
      specialists = agents.filter((agent) => matches(agent, ["coord", "lead"]));
      break;
  }
  return uniqueAgentIds([...coordinator, ...specialists, ...reviewer]);
}

function uniqueAgentIds(agents: Agent[]): string[] {
  return [...new Set(agents.map((agent) => agent.id))];
}

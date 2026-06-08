// Chat — the human entry. The route name is still agent-connect for
// compatibility, but the product surface is a chat-first work launcher.

import { useState } from "react";

import type { Mission } from "../api/mission-api";
import { useAgents, useApprovals, useCreateMission, useMissions } from "../api/useMissionData";
import { Icon } from "../components/Icon";
import { useAppState } from "../state/AppState";
import { canUseOperatorActions, OPERATOR_ACTION_SCOPE_HINT } from "../state/scopeAccess";

const EXAMPLES = [
  "Compare three options and tell me which one to choose.",
  "Open the dashboard, check what changed, and summarize it.",
  "Review this result and point out what is missing.",
];
const EXTERNAL_CLIENTS = ["Codex CLI", "Claude Code", "Custom API client"];
const BROWSERS = ["Chrome", "Comet", "Edge", "Chromium"];

export function AgentConnectPage() {
  const { state, openMission, setRoute } = useAppState();
  const createMission = useCreateMission();
  const agentsRemote = useAgents([]);
  const missionsRemote = useMissions([]);
  const approvalsRemote = useApprovals([]);
  const agents = agentsRemote.value;
  const recentMissions = missionsRemote.value
    .filter((mission) => mission.status !== "archived")
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 5);
  const pendingApprovals = approvalsRemote.value.filter((approval) => !approval.decision && !state.decisions[approval.id]);
  const canStart = canUseOperatorActions(state.scope);
  const [brief, setBrief] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = brief.trim();
  const submit = async () => {
    if (!trimmed || submitting || !canStart) return;
    setSubmitting(true);
    setError(null);
    try {
      const mission = await createMission({
        title: deriveTitle(trimmed),
        desc: trimmed,
        agents: selectedAgents,
      });
      openMission(mission.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setSubmitting(false);
    }
  };

  return (
    <div className="page start-page">
      <section className="work-home">
        <div className="chat-shell">
          <div className="start-composer" aria-label="Chat">
            <div className="chat-message assistant">
              <b>TurnkeyAI</b>
              <span>Tell me what you want done. I will pick the team, use tools when useful, and pause before risky actions.</span>
            </div>
            <textarea
              className="start-brief"
              value={brief}
              onChange={(event) => {
                setBrief(event.target.value);
                setError(null);
              }}
              placeholder="Message TurnkeyAI..."
              disabled={submitting || !canStart}
              rows={7}
            />
            {error ? <div className="start-error" role="alert">{error}</div> : null}
            {!canStart ? <div className="start-error" role="note">{OPERATOR_ACTION_SCOPE_HINT}</div> : null}
            <div className="start-actions">
              <div className="chat-selected-team">
                {selectedAgents.length === 0
                  ? "Auto team"
                  : `${selectedAgents.length} helper${selectedAgents.length === 1 ? "" : "s"} selected`}
              </div>
              <button
                type="button"
                className="btn primary start-primary"
                onClick={() => void submit()}
                disabled={!trimmed || submitting || !canStart}
              >
                <Icon name="play" size={13} /> {submitting ? "Sending..." : "Send"}
              </button>
            </div>
          </div>

          <aside className="work-home-side" aria-label="Current work">
            <section className="chat-team-panel" aria-label="Choose team">
              <div className="panel-headline">
                <span>Team</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setRoute("agents");
                    window.location.hash = "#/agents";
                  }}
                >
                  Change
                </button>
              </div>
              <button
                type="button"
                className="chat-team-choice"
                data-active={selectedAgents.length === 0}
                disabled={submitting || !canStart}
                onClick={() => setSelectedAgents([])}
              >
                <b>Auto</b>
                <span>Best for most work.</span>
              </button>
              {agents.length > 0 ? (
                <div className="chat-agent-list">
                  {agents.slice(0, 4).map((agent) => {
                    const selected = selectedAgents.includes(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className="chat-team-choice"
                        data-active={selected}
                        disabled={submitting || !canStart}
                        onClick={() =>
                          setSelectedAgents((current) =>
                            selected ? current.filter((id) => id !== agent.id) : [...current, agent.id]
                          )
                        }
                      >
                        <b>{agent.name}</b>
                        <span>{agent.role}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="chat-team-note">
                  {agentsRemote.isLive ? "Auto is ready." : "Checking team..."}
                </div>
              )}
            </section>

            <WorkNowPanel
              recentMissions={recentMissions}
              pendingApprovals={pendingApprovals.length}
              isLive={missionsRemote.isLive || approvalsRemote.isLive}
              onOpenMission={openMission}
            />
          </aside>
        </div>

        <div className="start-examples" aria-label="Examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="start-example"
              disabled={submitting || !canStart}
              onClick={() => setBrief(example)}
            >
              {example}
            </button>
          ))}
        </div>
      </section>
      <ConnectMoreTools
        onOpenSettings={() => {
          setRoute("settings");
          window.location.hash = "#/settings";
        }}
        token={state.token}
      />
    </div>
  );
}

function WorkNowPanel({
  recentMissions,
  pendingApprovals,
  isLive,
  onOpenMission,
}: {
  recentMissions: Mission[];
  pendingApprovals: number;
  isLive: boolean;
  onOpenMission: (missionId: string) => void;
}) {
  const active = recentMissions.filter((mission) => mission.status === "working" || mission.status === "needs_approval" || mission.status === "blocked");
  return (
    <section className="work-now-panel">
      <div className="panel-headline">
        <span>Work</span>
        <small>{isLive ? "live" : "connecting"}</small>
      </div>
      {pendingApprovals > 0 && (
        <div className="work-attention">
          <Icon name="warning" size={14} />
          <div>
            <b>{pendingApprovals} decision{pendingApprovals === 1 ? "" : "s"} needed</b>
            <span>Open the related work item to approve or deny it.</span>
          </div>
        </div>
      )}
      {recentMissions.length === 0 ? (
        <div className="work-empty">Your work will appear here after you send the first message.</div>
      ) : (
        <div className="work-list">
          {(active.length > 0 ? active : recentMissions).slice(0, 4).map((mission) => (
            <button key={mission.id} type="button" className="work-row" onClick={() => onOpenMission(mission.id)}>
              <span className={"work-dot " + mission.status} />
              <span>
                <b>{mission.title}</b>
                <small>{humanWorkStatus(mission)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ConnectMoreTools({ onOpenSettings, token }: { onOpenSettings: () => void; token: string | null }) {
  const endpoint = `${window.location.origin}/bridge/command`;
  return (
    <section className="start-secondary">
      <details className="start-advanced">
        <summary>Use TurnkeyAI from another app</summary>
        <div className="start-advanced-grid">
          <div>
            <h3>AI apps</h3>
            <p>{EXTERNAL_CLIENTS.join(", ")} can send work to this local TurnkeyAI app.</p>
            <div className="start-copy-row">
              <span>Address</span>
              <input className="field mono" readOnly value={endpoint} />
            </div>
            <div className="start-copy-row">
              <span>Token</span>
              <input className="field mono" readOnly value={token ? maskToken(token) : "(missing)"} />
            </div>
          </div>
          <div>
            <h3>Browser</h3>
            <p>Set this up only when TurnkeyAI needs logged-in websites or screenshots.</p>
            <div className="start-browser-list">{BROWSERS.join(" / ")}</div>
            <code>turnkeyai bridge install-extension</code>
          </div>
        </div>
      </details>
      <button type="button" className="btn ghost" onClick={onOpenSettings}>
        <Icon name="settings" size={13} /> Settings
      </button>
    </section>
  );
}

function humanWorkStatus(mission: Mission): string {
  if (mission.status === "done") return "Finished";
  if (mission.status === "working" || mission.status === "planning") return "Working";
  if (mission.status === "needs_approval") return "Waiting for you";
  if (mission.status === "blocked") return "Needs help";
  if (mission.status === "draft") return "Draft";
  return "Archived";
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "New chat";
  const clean = firstLine.replace(/\s+/g, " ");
  return clean.length > 86 ? `${clean.slice(0, 83)}...` : clean;
}

function maskToken(token: string): string {
  if (token.length <= 6) return "tk_....";
  return `tk_................${token.slice(-4)}`;
}

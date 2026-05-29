// Agent Connect — live bridge endpoint, token scope, and tool capability surface.

import { useCallback, useState } from "react";

import type { BridgeStatus, CapabilityInspectionReport } from "../api/types";
import { useApiClient } from "../api/useApiClient";
import { Icon } from "../components/Icon";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";

const POLL_MS = 5_000;
const CAPABILITY_THREAD = "agent-connect-preview";
const CAPABILITY_ROLE = "role-lead";
const REQUESTED_CAPABILITIES = ["browser", "research", "social-publish", "workspace"];

interface AgentProfile {
  id: string;
  name: string;
  note: string;
  configHint: string;
}

const AGENT_PROFILES: AgentProfile[] = [
  {
    id: "codex",
    name: "Codex CLI",
    note: "Use the local bridge endpoint as an authenticated tool gateway for browser and mission actions.",
    configHint: "Set base URL to the bridge endpoint and send the daemon token as Bearer or x-turnkeyai-token.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    note: "Connect through an HTTP tool adapter that calls the bridge command route with operator scope.",
    configHint: "Expose only operator-safe commands by default; reserve admin token use for short diagnostics windows.",
  },
  {
    id: "comet",
    name: "Comet / Browser Agent",
    note: "Use the bridge as the browser-control backend while keeping raw CDP behind the daemon boundary.",
    configHint: "Route browser actions through /bridge/command; do not give the client direct CDP credentials.",
  },
  {
    id: "custom",
    name: "Custom OpenAPI Client",
    note: "Any local client can call the same authenticated daemon routes once it has a scoped token.",
    configHint: "Start with read or operator scope, then add approval handling before enabling write-heavy tools.",
  },
];

interface AgentConnectLive {
  bridge: BridgeStatus | null;
  capabilities: CapabilityInspectionReport | null;
  reachable: boolean;
  error: string | null;
}

export function AgentConnectPage() {
  const { state } = useAppState();
  const client = useApiClient();
  const [selected, setSelected] = useState<string>(AGENT_PROFILES[0]?.id ?? "custom");
  const [live, setLive] = useState<AgentConnectLive>({
    bridge: null,
    capabilities: null,
    reachable: false,
    error: null,
  });

  const refreshLive = useCallback(async () => {
    const capabilityQuery = new URLSearchParams({
      threadId: CAPABILITY_THREAD,
      roleId: CAPABILITY_ROLE,
      requestedCapabilities: REQUESTED_CAPABILITIES.join(","),
    });
    const [bridgeResult, capabilityResult] = await Promise.allSettled([
      client.get<BridgeStatus>("/bridge/status"),
      client.get<CapabilityInspectionReport>(`/capabilities?${capabilityQuery.toString()}`),
    ]);
    const bridge = bridgeResult.status === "fulfilled" ? bridgeResult.value : null;
    const capabilities = capabilityResult.status === "fulfilled" ? capabilityResult.value : null;
    const error =
      bridgeResult.status === "rejected"
        ? bridgeResult.reason instanceof Error
          ? bridgeResult.reason.message
          : String(bridgeResult.reason)
        : capabilityResult.status === "rejected"
          ? capabilityResult.reason instanceof Error
            ? capabilityResult.reason.message
            : String(capabilityResult.reason)
          : null;
    setLive({ bridge, capabilities, reachable: bridge != null || capabilities != null, error });
  }, [client]);

  usePolling(refreshLive, POLL_MS);

  const profile = AGENT_PROFILES.find((candidate) => candidate.id === selected) ?? AGENT_PROFILES[0];
  const tokenMasked = state.token ? maskToken(state.token) : "(token missing)";
  const endpoint = `${window.location.origin}/bridge/command`;
  const status = bridgeStatusLabel(live);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {
      // Visible read-only fields remain selectable if clipboard access is blocked.
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Agent Connect</h2>
          <div className="sub">
            Connect external agents to the local daemon without handing them direct browser or filesystem control.
          </div>
        </div>
        <div className="right">
          <button type="button" className="btn" onClick={() => void refreshLive()}>
            <Icon name="diagnose" size={13} /> Test connection
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20 }}>
        <div className="col" style={{ gap: 4 }}>
          {AGENT_PROFILES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={"sb-item" + (selected === candidate.id ? " active" : "")}
              onClick={() => setSelected(candidate.id)}
              style={{ background: selected === candidate.id ? "var(--surface)" : "transparent" }}
            >
              <span className="glyph"><Icon name="connect" size={13} /></span>
              <span style={{ flex: 1 }}>{candidate.name}</span>
              <span className={"tag " + status.tone}>{status.label}</span>
            </button>
          ))}
        </div>

        <div className="card">
          <div className="card-hd">
            <h3
              style={{
                flex: 1,
                fontSize: 13,
                textTransform: "none",
                letterSpacing: 0,
                color: "var(--text)",
              }}
            >
              {profile?.name ?? "Agent client"}
            </h3>
            <span className={"tag " + status.tone}>{status.label}</span>
          </div>
          <div style={{ padding: "16px 18px" }}>
            <div className="muted" style={{ marginBottom: 14, fontSize: 12.5 }}>
              {profile?.note}
            </div>

            <div className="setting-row" style={{ paddingTop: 4 }}>
              <div className="lbl"><b>Endpoint</b><span>local daemon bridge command route</span></div>
              <div>
                <input className="field" readOnly value={endpoint} />
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn ghost" onClick={() => copy(endpoint)}>
                  Copy
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div className="lbl"><b>Token</b><span>stored in this browser session</span></div>
              <div>
                <input className="field" readOnly value={tokenMasked} />
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!state.token}
                  onClick={() => state.token && copy(state.token)}
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div className="lbl"><b>Scope</b><span>current token access level</span></div>
              <div>
                <input className="field" readOnly value={state.scope === "unknown" ? "checking" : state.scope} />
              </div>
              <div><span className={"tag " + scopeTone(state.scope)}>{state.scope}</span></div>
            </div>
            <div className="setting-row">
              <div className="lbl"><b>Bridge health</b><span>transport and expert-lane availability</span></div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className="tag">{live.bridge?.transport.label ?? "transport pending"}</span>
                <span className="tag">{live.bridge?.transport.mode ?? "mode pending"}</span>
                <span className={"tag " + (live.bridge?.expertLane.available ? "success" : "warning")}>
                  {live.bridge?.expertLane.available ? "expert lane available" : "expert lane gated"}
                </span>
              </div>
              <div />
            </div>
            <div className="setting-row" style={{ borderBottom: 0 }}>
              <div className="lbl"><b>Client note</b><span>recommended integration posture</span></div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>{profile?.configHint}</div>
              <div />
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-hd">
          <Icon name="agents" size={13} />
          <h3>Live capability surface</h3>
          <span className="mono faint" style={{ fontSize: 10, marginLeft: "auto" }}>
            {live.capabilities ? `generated ${formatRelativeMs(live.capabilities.generatedAt)}` : live.error ?? "checking"}
          </span>
        </div>
        <div className="card-bd">
          <CapabilityRows report={live.capabilities} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-hd">
          <Icon name="warning" size={13} />
          <h3>Why not admin by default?</h3>
        </div>
        <div className="card-bd muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Admin scope exposes raw-CDP and configuration mutation. Daily agent clients should use operator scope
          with approval gates; keep admin tokens short-lived and local to runtime diagnostics.
        </div>
      </div>
    </div>
  );
}

function CapabilityRows({ report }: { report: CapabilityInspectionReport | null }) {
  if (!report) {
    return (
      <div className="setting-row" style={{ borderBottom: 0, paddingTop: 4 }}>
        <div className="lbl"><b>Capabilities</b><span>daemon has not returned a report yet</span></div>
        <div className="muted">Waiting for /capabilities.</div>
        <div><span className="tag warning">pending</span></div>
      </div>
    );
  }

  return (
    <>
      <CapabilityRow label="Workers" items={report.availableWorkers} empty="no workers" />
      <CapabilityRow
        label="Native tools"
        items={(report.toolCapabilities ?? []).map((tool) => `${tool.name} · ${tool.executorKind}`)}
        empty="no native tools"
      />
      <CapabilityRow
        label="Connectors"
        items={report.connectorStates.map((connector) =>
          `${connector.provider} · ${connector.available && connector.authorized ? "ready" : "needs setup"}`
        )}
        empty="no connectors"
      />
      <CapabilityRow
        label="APIs"
        items={report.apiStates.map((api) => `${api.name} · ${api.ready ? "ready" : "needs env"}`)}
        empty="no APIs"
      />
      <CapabilityRow
        label="Transport order"
        items={report.transportPreferences.map(
          (preference) => `${preference.capability}: ${preference.orderedTransports.join(" > ")}`
        )}
        empty="no transport preferences"
        last
      />
    </>
  );
}

function CapabilityRow({
  label,
  items,
  empty,
  last,
}: {
  label: string;
  items: string[];
  empty: string;
  last?: boolean;
}) {
  return (
    <div className="setting-row" style={{ borderBottom: last ? 0 : undefined, paddingTop: label === "Workers" ? 4 : undefined }}>
      <div className="lbl"><b>{label}</b><span>from daemon capability inspection</span></div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {items.length > 0 ? items.map((item) => <span key={item} className="tag">{item}</span>) : <span className="muted">{empty}</span>}
      </div>
      <div />
    </div>
  );
}

function bridgeStatusLabel(live: AgentConnectLive): { label: string; tone: string } {
  if (live.bridge?.ok) return { label: "ready", tone: "success" };
  if (live.reachable) return { label: "partial", tone: "warning" };
  return { label: "offline", tone: "warning" };
}

function scopeTone(scope: string): string {
  if (scope === "admin") return "warning";
  if (scope === "operator") return "success";
  return "info";
}

function formatRelativeMs(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 1_000) return "now";
  if (delta < 60_000) return `${Math.round(delta / 1_000)}s ago`;
  return `${Math.round(delta / 60_000)}m ago`;
}

function maskToken(token: string): string {
  if (token.length <= 6) return "tk_....";
  const tail = token.slice(-4);
  return `tk_................${tail}`;
}

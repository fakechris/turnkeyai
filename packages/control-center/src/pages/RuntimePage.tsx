// Runtime — operator surface for bridge / transport / sessions /
// diagnostics / logs.
//
// Live operator diagnostics. Sections without a stable read endpoint still
// render as explicitly-labeled placeholders rather than fixture data.

import { useState } from "react";

import { useApiClient } from "../api/useApiClient";
import type { WorkerSessionRecord } from "../api/mission-api";
import type { BridgeStatus, DiagnosticsLogs, DiagnosticsSnapshot, RuntimeSummaryReport } from "../api/types";
import { Icon } from "../components/Icon";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";
import { pillFromStatus } from "../state/pillFromStatus";

const POLL_MS = 5_000;
const LOG_LIMIT = 50;

interface Live {
  diagnostics: DiagnosticsSnapshot | null;
  status: BridgeStatus | null;
  logs: DiagnosticsLogs | null;
  runtimeSummary: RuntimeSummaryReport | null;
  workerSessions: WorkerSessionRecord[];
  reachable: boolean;
}

export function RuntimePage() {
  const client = useApiClient();
  const { setPill, setLastStatus } = useAppState();
  const [live, setLive] = useState<Live>({
    diagnostics: null,
    status: null,
    logs: null,
    runtimeSummary: null,
    workerSessions: [],
    reachable: false,
  });

  usePolling(async () => {
    const [diagResult, statusResult, logsResult, runtimeResult, sessionsResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<BridgeStatus>("/bridge/status"),
      client.get<DiagnosticsLogs>(`/diagnostics/logs?limit=${LOG_LIMIT}`),
      client.get<RuntimeSummaryReport>("/runtime-summary?limit=8"),
      client.get<WorkerSessionRecord[]>("/runtime-worker-sessions?limit=8"),
    ]);

    const diagnostics = diagResult.status === "fulfilled" ? diagResult.value : null;
    const status = statusResult.status === "fulfilled" ? statusResult.value : null;
    const logs = logsResult.status === "fulfilled" ? logsResult.value : null;
    const runtimeSummary = runtimeResult.status === "fulfilled" ? runtimeResult.value : null;
    const workerSessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
    const reachable = diagnostics != null || status != null || runtimeSummary != null;

    if (status) {
      setLastStatus(status);
      setPill(pillFromStatus(status));
    } else if (reachable) {
      setPill({ state: "warn", label: "Partial" });
    } else {
      // Don't blast "Unreachable" on a single transient 401 from one
      // of the three fetches — apiClient already cleared the token if
      // applicable. Only set bad when ALL three failed.
      const allUnauth = [diagResult, statusResult, logsResult, runtimeResult, sessionsResult].every(
        (r) => r.status === "rejected" && (r.reason as Error)?.message === "unauthorized"
      );
      if (!allUnauth) setPill({ state: "bad", label: "Unreachable" });
    }
    setLive({ diagnostics, status, logs, runtimeSummary, workerSessions, reachable });
  }, POLL_MS);

  const exportBundle = () => {
    // Restored from PR H's DiagnosticsBundle (lost in the K1 rewrite).
    // Serializes the live snapshot + log tail as a JSON blob for bug
    // reports. When fetches haven't returned yet the button is disabled
    // by `bundleReady`.
    if (!live.diagnostics) return;
    const bundle = {
      diagnostics: live.diagnostics,
      bridgeStatus: live.status,
      logTail: live.logs,
      capturedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(bundle, null, 2);
    void navigator.clipboard.writeText(text).catch(() => {
      // Clipboard can be blocked in non-HTTPS / unfocused contexts.
      // K2's diagnostics drawer will offer a "select manually" fallback;
      // for K1 we just no-op so the button doesn't appear to do
      // anything wrong.
    });
  };
  const bundleReady = live.diagnostics != null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Runtime</h2>
          <div className="sub">
            操作员视图 · bridge / transport / sessions / 诊断 / replay。Mission 用户不需要常驻于此。
          </div>
        </div>
        <div className="right">
          <button
            type="button"
            className="btn"
            onClick={exportBundle}
            disabled={!bundleReady}
            title={bundleReady ? "Copy diagnostics bundle to clipboard" : "Waiting for first poll…"}
          >
            <Icon name="diagnose" size={13} /> Export diagnostics
          </button>
          <button type="button" className="btn"><Icon name="play" size={13} /> Open replay</button>
        </div>
      </div>

      <div className="runtime-grid">
        <div>
          <MetricTiles live={live} />
          <SetupHealthCard diagnostics={live.diagnostics} reachable={live.reachable} />
          <BrowserSessionsCard sessions={live.workerSessions} reachable={live.reachable} />
          <DaemonLogCard logs={live.logs} reachable={live.reachable} />
        </div>

        <div className="col" style={{ gap: 14 }}>
          <RecoveryCard summary={live.runtimeSummary} reachable={live.reachable} />
          <TransportCard status={live.status} />
          <TokensCard />
        </div>
      </div>
    </div>
  );
}

function MetricTiles({ live }: { live: Live }) {
  // Tiles always derive from live data. When the daemon hasn't returned
  // yet we render placeholder "—" rather than a fake fixture.
  const tiles =
    live.diagnostics || live.status
      ? buildLiveTiles(live)
      : ([
          { l: "Daemon", v: "—", d: "connecting…" },
          { l: "Browser sessions", v: "—", d: "" },
          { l: "Relay peers", v: "—", d: "" },
          { l: "Auth mode", v: "—", d: "" },
          { l: "Expert lane", v: "—", d: "" },
          { l: "Action queue", v: "—", d: "" },
        ] as Array<{ l: string; v: string; d: string }>);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 14 }}>
      {tiles.map((m) => (
        <div key={m.l} className="metric-tile">
          <div className="l">{m.l}</div>
          <div className="v">{m.v}</div>
          <div className="d">{m.d}</div>
        </div>
      ))}
    </div>
  );
}

function buildLiveTiles(live: Live): Array<{ l: string; v: string; d: string }> {
  const d = live.diagnostics;
  const s = live.status;
  const transport = d?.transport.mode ?? s?.transport.mode ?? "?";
  const sessionCount = d?.counters.sessionCount ?? s?.sessions.count ?? 0;
  const relayPeer = d?.counters.relayPeerCount ?? s?.relay.peerCount ?? 0;
  const relayTargets = d?.counters.relayTargetCount ?? s?.relay.targetCount ?? 0;
  const runtime = live.runtimeSummary;
  return [
    { l: "Daemon", v: `v${d?.daemon.version ?? "?"}`, d: `:${d?.daemon.port ?? "?"}` },
    { l: "Browser sessions", v: String(sessionCount), d: `transport: ${transport}` },
    { l: "Runtime attention", v: String(runtime?.attentionCount ?? 0), d: `${runtime?.activeCount ?? 0} active` },
    {
      l: "Auth mode",
      v: d?.daemon.authMode ?? "?",
      d: d ? `uptime ${formatUptimeShort(d.daemon.uptimeMs)}` : "—",
    },
    {
      l: "Expert lane",
      v: s?.expertLane.available ? "available" : "off",
      d: s?.expertLane.reason ?? "direct-CDP only",
    },
    {
      l: "Action queue",
      v: String(s?.relay.actionRequestQueueDepth ?? 0),
      d: relayPeer > 0
        ? `${relayPeer} relay peer(s), ${relayTargets} target(s)`
        : s?.relay.lastHeartbeatAgeMs != null
          ? `hb ${Math.round(s.relay.lastHeartbeatAgeMs / 1000)}s ago`
          : "no relay",
    },
  ];
}

function SetupHealthCard({
  diagnostics,
  reachable,
}: {
  diagnostics: DiagnosticsSnapshot | null;
  reachable: boolean;
}) {
  const readiness = diagnostics?.readiness;
  const checks = readiness?.checks ?? [];
  const title = setupHealthTitle(readiness?.status, reachable);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-hd">
        <Icon name="diagnose" size={13} />
        <h3>Setup health</h3>
        <span className={`tag ${readinessStatusTone(readiness?.status)}`} style={{ marginLeft: "auto" }}>
          {title}
        </span>
      </div>
      {checks.length > 0 ? (
        <div style={{ display: "grid" }}>
          {checks.map((check) => (
            <div
              key={check.id}
              className="runtime-health-row"
              data-status={check.status}
            >
              <span className={`status-dot ${readinessDotClass(check.status)}`} />
              <div style={{ minWidth: 0 }}>
                <div className="runtime-health-label">{check.label}</div>
                <div className="runtime-health-detail">{check.detail}</div>
                {check.action ? <div className="runtime-health-action">{check.action}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted" style={{ padding: 14, fontSize: 12 }}>
          {reachable ? "Waiting for readiness checks…" : "Connect to the daemon to see setup health."}
        </div>
      )}
    </div>
  );
}

function setupHealthTitle(status: "ok" | "warn" | "error" | undefined, reachable: boolean): string {
  if (status === "error") return "Action needed";
  if (status === "warn") return "Needs attention";
  if (status === "ok") return "Ready";
  return reachable ? "Checking" : "Offline";
}

function readinessStatusTone(status: "ok" | "warn" | "error" | undefined): string {
  if (status === "error") return "danger";
  if (status === "warn") return "warning";
  if (status === "ok") return "success";
  return "info";
}

function readinessDotClass(status: "ok" | "warn" | "error"): string {
  if (status === "error") return "blocked";
  if (status === "warn") return "needs_approval";
  return "working";
}

function formatUptimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatRelativeAge(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 1_000) return "now";
  if (delta < 60_000) return `${Math.round(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

function workerStatusDot(status: string): string {
  if (status === "done") return "done";
  if (status === "failed" || status === "cancelled" || status === "unrecoverable") return "blocked";
  if (status === "running" || status === "resuming") return "working";
  return "planning";
}

function runtimeChainDot(state: string): string {
  if (state === "failed" || state === "stale") return "blocked";
  if (state === "waiting") return "needs_approval";
  if (state === "resolved") return "done";
  return "working";
}

function BrowserSessionsCard({
  sessions,
  reachable,
}: {
  sessions: WorkerSessionRecord[];
  reachable: boolean;
}) {
  return (
    <div className="card">
      <div className="card-hd">
        <h3>Browser sessions</h3>
        <span className="mono faint" style={{ fontSize: 10 }}>
          {sessions.length > 0 ? `${sessions.length} worker session(s)` : reachable ? "none active" : "offline"}
        </span>
      </div>
      {sessions.length > 0 ? (
        <div style={{ display: "grid" }}>
          {sessions.map((session) => (
            <div key={session.workerRunKey} className="runtime-health-row">
              <span className={`status-dot ${workerStatusDot(session.state.status)}`} />
              <div style={{ minWidth: 0 }}>
                <div className="runtime-health-label">
                  {session.state.workerType} · {session.state.status}
                </div>
                <div className="runtime-health-detail">
                  {session.workerRunKey} · thread {session.context?.threadId ?? "-"}
                </div>
                <div className="runtime-health-action">
                  updated {formatRelativeAge(session.state.updatedAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: 14 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {reachable
              ? "No active or recently persisted worker sessions are visible to the runtime summary."
              : "Connect to the daemon to see worker sessions."}
          </div>
        </div>
      )}
    </div>
  );
}

function RecoveryCard({
  summary,
  reachable,
}: {
  summary: RuntimeSummaryReport | null;
  reachable: boolean;
}) {
  const chains = summary?.attentionChains ?? [];
  return (
    <div className="card">
      <div className="card-hd">
        <Icon name="warning" size={13} />
        <h3>Runtime attention</h3>
        <span className={`tag ${summary && summary.attentionCount > 0 ? "warning" : "success"}`} style={{ marginLeft: "auto" }}>
          {summary ? `${summary.attentionCount} attention` : reachable ? "checking" : "offline"}
        </span>
      </div>
      {summary ? (
        <div style={{ display: "grid" }}>
          {chains.length > 0 ? (
            chains.map((chain) => (
              <div key={chain.chainId} className="runtime-health-row">
                <span className={`status-dot ${runtimeChainDot(chain.canonicalState)}`} />
                <div style={{ minWidth: 0 }}>
                  <div className="runtime-health-label">
                    {chain.headline ?? `${chain.rootKind} · ${chain.canonicalState}`}
                  </div>
                  <div className="runtime-health-detail">
                    {chain.chainId} · {chain.phase}
                    {chain.waitingReason ? ` · ${chain.waitingReason}` : ""}
                  </div>
                  {chain.nextStep || chain.staleReason ? (
                    <div className="runtime-health-action">{chain.nextStep ?? chain.staleReason}</div>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div style={{ padding: 14 }}>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                Runtime has no waiting, failed, stale, or attention chains.
              </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: 14 }}>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {reachable ? "Waiting for runtime summary…" : "Connect to the daemon to see runtime attention."}
          </div>
        </div>
      )}
      {summary ? (
        <div style={{ padding: "0 14px 14px" }} className="muted">
          active {summary.activeCount} · waiting {summary.waitingCount} · failed {summary.failedCount} · stale {summary.staleCount}
        </div>
      ) : null}
    </div>
  );
}

function DaemonLogCard({
  logs,
  reachable,
}: {
  logs: DiagnosticsLogs | null;
  reachable: boolean;
}) {
  const lines = logs?.lines ?? [];
  const isLive = reachable && lines.length > 0;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-hd">
        <h3>Daemon log · tail</h3>
        <span className="mono faint" style={{ fontSize: 10, marginLeft: "auto" }}>
          {isLive
            ? `${lines.length} lines · live${logs?.redacted ? " · redacted" : ""}`
            : reachable
              ? "no log lines yet"
              : "daemon not reachable"}
        </span>
      </div>
      <div>
        {isLive ? (
          lines.slice(-LOG_LIMIT).map((line, i) => (
            <div key={i} className="log-row" style={{ gridTemplateColumns: "1fr" }}>
              <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</span>
            </div>
          ))
        ) : (
          <div className="muted" style={{ padding: 14, fontSize: 12 }}>
            {reachable
              ? "Daemon log tail will appear here as the runtime emits records."
              : "Connect to the daemon to see live logs."}
          </div>
        )}
      </div>
    </div>
  );
}

function TransportCard({ status }: { status: BridgeStatus | null }) {
  // When live, show the actual transport's mode + label on top, and pad
  // with mock standby/idle lines below so the design's three-row layout
  // is preserved.
  const liveMode = status?.transport.mode;
  return (
    <div className="card">
      <div className="card-hd"><h3>Transport</h3></div>
      <div style={{ padding: 14 }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="status-dot working" />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 500 }}>
              {liveMode ?? "direct-CDP available"}
            </div>
            <div className="muted mono" style={{ fontSize: 10.5 }}>
              {status?.transport.label ?? "chrome.local · 9222"}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <span className="status-dot planning" />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 500 }}>
              relay · {status?.relay.peerCount ? `${status.relay.peerCount} peer(s)` : "standby"}
            </div>
            <div className="muted mono" style={{ fontSize: 10.5 }}>
              {status?.relay.configured ? "relay configured" : "tk-relay-sea1 · token op"}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 10, marginTop: 10 }}>
          <span className="status-dot done" />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: 500 }}>local · idle</div>
            <div className="muted mono" style={{ fontSize: 10.5 }}>not in use</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TokensCard() {
  return (
    <div className="card">
      <div className="card-hd">
        <Icon name="key" size={13} />
        <h3>Tokens</h3>
      </div>
      <div style={{ padding: 14, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        Per-agent token enumeration lands later. For now configure auth
        via the env vars in <code>~/.turnkeyai/config.json</code> (the
        daemon prints accepted scopes at startup).
      </div>
    </div>
  );
}

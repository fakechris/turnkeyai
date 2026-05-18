// Runtime — operator surface for bridge / transport / sessions /
// diagnostics / logs.
//
// K1 mixes real and mock data:
//   - Metrics tile derives from /diagnostics + /bridge/status (real)
//   - Daemon log tail comes from /diagnostics/logs?limit=200 (real)
//   - Browser sessions table uses the mock (the daemon's listSessions
//     returns the right shape but isn't exposed at a stable read route
//     yet — coming in K2's Mission Data Model)
//   - Recovery cases use the mock (no real `/recovery-runs` enumeration
//     for the dashboard yet)
// Each mock-fed section is annotated below.

import { useState } from "react";

import { useApiClient } from "../api/useApiClient";
import type { BridgeStatus, DiagnosticsLogs, DiagnosticsSnapshot } from "../api/types";
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
  reachable: boolean;
}

export function RuntimePage() {
  const client = useApiClient();
  const { setPill, setLastStatus } = useAppState();
  const [live, setLive] = useState<Live>({
    diagnostics: null,
    status: null,
    logs: null,
    reachable: false,
  });

  usePolling(async () => {
    const [diagResult, statusResult, logsResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<BridgeStatus>("/bridge/status"),
      client.get<DiagnosticsLogs>(`/diagnostics/logs?limit=${LOG_LIMIT}`),
    ]);

    const diagnostics = diagResult.status === "fulfilled" ? diagResult.value : null;
    const status = statusResult.status === "fulfilled" ? statusResult.value : null;
    const logs = logsResult.status === "fulfilled" ? logsResult.value : null;
    const reachable = diagnostics != null || status != null;

    if (status) {
      setLastStatus(status);
      setPill(pillFromStatus(status));
    } else if (reachable) {
      setPill({ state: "warn", label: "Partial" });
    } else {
      // Don't blast "Unreachable" on a single transient 401 from one
      // of the three fetches — apiClient already cleared the token if
      // applicable. Only set bad when ALL three failed.
      const allUnauth = [diagResult, statusResult, logsResult].every(
        (r) => r.status === "rejected" && (r.reason as Error)?.message === "unauthorized"
      );
      if (!allUnauth) setPill({ state: "bad", label: "Unreachable" });
    }
    setLive({ diagnostics, status, logs, reachable });
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
          <BrowserSessionsCard />
          <DaemonLogCard logs={live.logs} reachable={live.reachable} />
        </div>

        <div className="col" style={{ gap: 14 }}>
          <RecoveryCard />
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
  return [
    { l: "Daemon", v: `v${d?.daemon.version ?? "?"}`, d: `:${d?.daemon.port ?? "?"}` },
    { l: "Browser sessions", v: String(sessionCount), d: `transport: ${transport}` },
    { l: "Relay peers", v: String(relayPeer), d: `${relayTargets} discovered tabs` },
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
      d: s?.relay.lastHeartbeatAgeMs != null ? `hb ${Math.round(s.relay.lastHeartbeatAgeMs / 1000)}s ago` : "no relay",
    },
  ];
}

function formatUptimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function BrowserSessionsCard() {
  return (
    <div className="card">
      <div className="card-hd">
        <h3>Browser sessions</h3>
        <span className="mono faint" style={{ fontSize: 10 }}>
          live · see Context for details
        </span>
      </div>
      <div style={{ padding: 14 }}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
          Live sessions are surfaced as Browser context sources on the{" "}
          <b>Context</b> tab of any mission, and aggregated on{" "}
          <b>#/context</b>. A dedicated /browser-sessions runtime table
          will return in a later phase once the daemon exposes per-session
          uptime alongside the live list.
        </div>
      </div>
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

function RecoveryCard() {
  // No `/recovery-runs` enumeration for the dashboard yet — leave a
  // placeholder so the layout stays balanced without lying about
  // recovery state.
  return (
    <div className="card">
      <div className="card-hd">
        <Icon name="warning" size={13} />
        <h3>Recovery cases</h3>
      </div>
      <div style={{ padding: 14 }}>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
          No active recovery cases. Bridge failures during a mission appear
          here when a real <code>/recovery-runs</code> enumeration lands
          (K4+).
        </div>
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

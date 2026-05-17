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
import { MOCK_DATA } from "../mock/mission-data";
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
          <button type="button" className="btn"><Icon name="diagnose" size={13} /> Export diagnostics</button>
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
  // Metric tiles. When the daemon is reachable we synthesize tiles from
  // the live snapshot. When it's NOT (or we're still loading), fall back
  // to the design mock so the layout stays populated.
  const tiles =
    live.diagnostics || live.status
      ? buildLiveTiles(live)
      : MOCK_DATA.runtime.metrics;
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

function buildLiveTiles(live: Live): typeof MOCK_DATA.runtime.metrics {
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
  // K1 still uses mock here — see header comment for context.
  return (
    <div className="card">
      <div className="card-hd">
        <h3>Browser sessions</h3>
        <span className="mono faint" style={{ fontSize: 10 }}>
          {MOCK_DATA.runtime.sessions.length} · mock data
        </span>
      </div>
      <div>
        <div
          className="log-row"
          style={{ background: "var(--surface-2)", fontWeight: 500, color: "var(--text-muted)" }}
        >
          <span>SESSION</span>
          <span>TRANSPORT</span>
          <span>STATE</span>
          <span>TARGET · UPTIME</span>
        </div>
        {MOCK_DATA.runtime.sessions.map((s) => (
          <div key={s.id} className="log-row">
            <span>{s.id}</span>
            <span>{s.transport}</span>
            <span className={"sev " + (s.state.startsWith("attached") ? "ok" : "err")}>{s.state}</span>
            <span>
              <span className="faint">{s.target}</span> · {s.duration}
            </span>
          </div>
        ))}
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
            : "mock data · daemon not reachable"}
        </span>
      </div>
      <div>
        {isLive
          ? lines.slice(-LOG_LIMIT).map((line, i) => (
              <div key={i} className="log-row" style={{ gridTemplateColumns: "1fr" }}>
                <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{line}</span>
              </div>
            ))
          : MOCK_DATA.runtime.logs.map((l, i) => (
              <div key={i} className="log-row">
                <span className="ts">{l.ts}</span>
                <span className="src">{l.src}</span>
                <span className={"sev " + l.sev}>{l.sev.toUpperCase()}</span>
                <span>{l.msg}</span>
              </div>
            ))}
      </div>
    </div>
  );
}

function RecoveryCard() {
  return (
    <div className="card">
      <div className="card-hd">
        <Icon name="warning" size={13} />
        <h3 style={{ color: "var(--danger)" }}>Recovery cases · {MOCK_DATA.recoveries.length}</h3>
      </div>
      <div style={{ padding: 14 }}>
        {MOCK_DATA.recoveries.map((r) => (
          <div key={r.id}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500 }}>{r.title}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{r.cn}</div>
            <div className="mono faint" style={{ fontSize: 10, marginTop: 8, lineHeight: 1.7 }}>
              <div>bucket · <span style={{ color: "var(--text-muted)" }}>{r.bucket}</span></div>
              <div>first seen · {r.firstSeen} · attempt {r.attempts}/3</div>
              <div>last error · {r.runtime.lastError}</div>
            </div>
            <button type="button" className="btn warning" style={{ marginTop: 10 }}>
              Open recovery case →
            </button>
          </div>
        ))}
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
      <div
        style={{
          padding: 14,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-muted)",
          lineHeight: 1.7,
        }}
      >
        <div>tk_op_•••4f12 <span className="faint">operator · agent.research</span></div>
        <div>tk_op_•••91ab <span className="faint">operator · agent.doc</span></div>
        <div>tk_rd_•••2c08 <span className="faint">read · agent.review</span></div>
        <div>tk_ad_•••8e44 <span className="faint" style={{ color: "var(--warning)" }}>admin · daemon-local</span></div>
        <div style={{ marginTop: 8, fontSize: 9.5 }} className="faint">
          mock data · K1 doesn't enumerate real per-agent tokens
        </div>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useApiClient } from "../api/useApiClient";
import type { DiagnosticsLogs, DiagnosticsSnapshot } from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { KvTable } from "../components/KvTable";
import { MetricGrid } from "../components/MetricGrid";
import {
  formatAbsoluteTimestamp,
  formatBytes,
  formatRelativeTimestamp,
  formatUptime,
} from "../components/format";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";
import { labelForMode, pillFromStatus } from "../state/pillFromStatus";

const POLL_MS = 5_000;
const LOG_LIMIT = 200;

export function DiagnosticsPage() {
  const client = useApiClient();
  const { state, setPill } = useAppState();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [logs, setLogs] = useState<DiagnosticsLogs | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  usePolling(async () => {
    const [snapResult, logsResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<DiagnosticsLogs>(`/diagnostics/logs?limit=${LOG_LIMIT}`),
    ]);

    if (snapResult.status === "fulfilled") {
      setSnapshot(snapResult.value);
      setUnreachable(false);
      if (state.lastStatus) {
        setPill(pillFromStatus(state.lastStatus));
      } else {
        setPill({
          state: "ok",
          label: labelForMode(snapResult.value.transport.mode),
        });
      }
    } else if ((snapResult.reason as Error)?.message !== "unauthorized") {
      setUnreachable(true);
      setPill({ state: "bad", label: "Unreachable" });
    }

    if (logsResult.status === "fulfilled") {
      setLogs(logsResult.value);
    } else if ((logsResult.reason as Error)?.message !== "unauthorized") {
      setLogs({
        logFile: "",
        limit: LOG_LIMIT,
        lineCount: 0,
        lines: [],
        note: `Could not load log: ${(logsResult.reason as Error)?.message ?? "unknown error"}`,
      });
    }
  }, POLL_MS);

  return (
    <section className="page-section">
      <h1>Diagnostics</h1>
      <p className="page-lede">
        Runtime environment + recent log lines. Useful when filing a bug report — copy the bundle
        below and attach it.
      </p>

      <DaemonSection snapshot={unreachable ? null : snapshot} />
      <PathsSection snapshot={unreachable ? null : snapshot} />
      <CountersSection snapshot={unreachable ? null : snapshot} />
      <NodeSection snapshot={unreachable ? null : snapshot} />

      <LogSection logs={logs} />

      <DiagnosticsBundle snapshot={snapshot} logs={logs} />
    </section>
  );
}

function DaemonSection({ snapshot }: { snapshot: DiagnosticsSnapshot | null }) {
  const d = snapshot?.daemon;
  const t = snapshot?.transport;
  return (
    <>
      <h2>Daemon</h2>
      <KvTable
        rows={[
          { key: "version", label: "Version", value: d ? `v${d.version}` : "—" },
          { key: "port", label: "Port", value: d ? String(d.port) : "—" },
          { key: "uptime", label: "Uptime", value: formatUptime(d?.uptimeMs) },
          { key: "started", label: "Started at", value: formatAbsoluteTimestamp(d?.startedAt) },
          { key: "authMode", label: "Auth mode", value: d?.authMode ?? "—" },
          {
            key: "transport",
            label: "Transport",
            value: t ? `${t.mode} (${t.label})` : "—",
          },
        ]}
      />
    </>
  );
}

function PathsSection({ snapshot }: { snapshot: DiagnosticsSnapshot | null }) {
  const p = snapshot?.paths;
  return (
    <>
      <h2>Paths</h2>
      <KvTable
        rows={[
          { key: "runtime", label: "Runtime root", value: <code>{p?.runtimeRoot ?? "—"}</code> },
          { key: "data", label: "Data dir", value: <code>{p?.dataDir ?? "—"}</code> },
          { key: "config", label: "Config file", value: <code>{p?.configFile ?? "—"}</code> },
          { key: "log", label: "Log file", value: <code>{p?.logFile ?? "—"}</code> },
          {
            key: "catalog",
            label: "Model catalog",
            value: <code>{p?.modelCatalogPath ?? "(none)"}</code>,
          },
          {
            key: "logsize",
            label: "Log size",
            value:
              p == null
                ? "—"
                : p.logFileBytes == null
                  ? "(no log file)"
                  : `${formatBytes(p.logFileBytes)} · modified ${formatRelativeTimestamp(
                      p.logFileModifiedAt
                    )}`,
          },
        ]}
      />
    </>
  );
}

function CountersSection({ snapshot }: { snapshot: DiagnosticsSnapshot | null }) {
  const c = snapshot?.counters;
  return (
    <>
      <h2>Counters</h2>
      <MetricGrid
        metrics={[
          { key: "sessions", label: "Sessions", value: c ? String(c.sessionCount) : "—" },
          { key: "peers", label: "Relay peers", value: c ? String(c.relayPeerCount) : "—" },
          {
            key: "targets",
            label: "Discovered tabs",
            value: c ? String(c.relayTargetCount) : "—",
          },
        ]}
      />
    </>
  );
}

function NodeSection({ snapshot }: { snapshot: DiagnosticsSnapshot | null }) {
  const n = snapshot?.node;
  return (
    <>
      <h2>Node runtime</h2>
      <KvTable
        rows={[
          { key: "node-v", label: "Node version", value: n?.version ?? "—" },
          { key: "platform", label: "Platform", value: n?.platform ?? "—" },
          { key: "arch", label: "Architecture", value: n?.arch ?? "—" },
        ]}
      />
    </>
  );
}

function LogSection({ logs }: { logs: DiagnosticsLogs | null }) {
  const paneRef = useRef<HTMLPreElement>(null);
  // PR I (codex S2): capture scroll position BEFORE textContent mutates so
  // the "near bottom" check isn't fooled by the inflated scrollHeight of
  // the about-to-render-larger content.
  useLayoutEffect(() => {
    if (!logs || !paneRef.current) return;
    const pane = paneRef.current;
    const wasNearBottom =
      pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    if (wasNearBottom) {
      // Defer to next frame so the new layout has settled.
      requestAnimationFrame(() => {
        if (paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight;
      });
    }
  }, [logs]);

  const lines = logs?.lines ?? [];
  const empty = lines.length === 0;
  const meta = !logs
    ? ""
    : empty
      ? ""
      : `(${logs.truncatedFromHead ? "older lines truncated · " : ""}${lines.length} line${
          lines.length === 1 ? "" : "s"
        })`;
  return (
    <>
      <h2>
        Recent log <span className="muted-count">{meta}</span>
      </h2>
      <pre ref={paneRef} className={`log-tail${empty ? " log-empty" : ""}`}>
        {empty ? (logs?.note ?? "Loading…") : lines.join("\n")}
      </pre>
    </>
  );
}

function DiagnosticsBundle({
  snapshot,
  logs,
}: {
  snapshot: DiagnosticsSnapshot | null;
  logs: DiagnosticsLogs | null;
}) {
  const [bundleText, setBundleText] = useState<string | null>(null);
  // Recompute the bundle each render that snapshot/logs change so the
  // Copy button always grabs the latest data.
  useEffect(() => {
    if (!snapshot) {
      setBundleText(null);
      return;
    }
    const bundle = {
      diagnostics: snapshot,
      logTail: logs,
      capturedAt: new Date().toISOString(),
    };
    setBundleText(JSON.stringify(bundle, null, 2));
  }, [snapshot, logs]);

  if (!bundleText) {
    return (
      <button type="button" className="copy" disabled>
        Copy diagnostics bundle (no data yet)
      </button>
    );
  }
  return (
    <>
      <CopyButton text={bundleText} label="Copy diagnostics bundle" />
      <pre className="snippet" hidden>
        {bundleText}
      </pre>
    </>
  );
}

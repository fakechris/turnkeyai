import { useState } from "react";

import { useApiClient } from "../api/useApiClient";
import type { BridgeStatus } from "../api/types";
import { KvTable } from "../components/KvTable";
import { MetricGrid, type MetricCell } from "../components/MetricGrid";
import { formatHeartbeat } from "../components/format";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";
import { pillFromStatus } from "../state/pillFromStatus";

const POLL_MS = 5_000;

export function BridgePage() {
  const client = useApiClient();
  const { setPill, setLastStatus } = useAppState();
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  usePolling(async () => {
    try {
      const next = await client.get<BridgeStatus>("/bridge/status");
      setLastStatus(next);
      setStatus(next);
      setUnreachable(false);
      setPill(pillFromStatus(next));
    } catch (error) {
      if ((error as Error).message !== "unauthorized") {
        setUnreachable(true);
        setPill({ state: "bad", label: "Unreachable" });
      }
    }
  }, POLL_MS);

  const metrics: MetricCell[] = status && !unreachable ? bridgeMetrics(status) : placeholders();

  return (
    <section className="page-section">
      <h1>Bridge Status</h1>
      <p className="page-lede">Live state of the browser-bridge transport. Polls every 5 seconds.</p>
      <MetricGrid metrics={metrics} />
      <h2>Direct CDP</h2>
      <KvTable
        rows={[
          {
            key: "configured",
            label: "Configured",
            value: status && !unreachable ? (status.directCdp?.configured ? "yes" : "no") : "—",
          },
          {
            key: "endpoint",
            label: "Endpoint",
            value: status && !unreachable ? status.directCdp?.endpoint ?? "—" : "—",
          },
        ]}
      />
    </section>
  );
}

function bridgeMetrics(status: BridgeStatus): MetricCell[] {
  const queueDepth = status.relay?.actionRequestQueueDepth ?? 0;
  const queueTone: MetricCell["tone"] =
    queueDepth >= 100 ? "bad" : queueDepth >= 10 ? "warn" : undefined;
  const peerCount = status.relay?.peerCount ?? 0;
  const peerTone: MetricCell["tone"] =
    status.transport?.mode === "relay" && peerCount >= 1 ? "ok" : undefined;
  const expert = status.expertLane ?? { available: false };

  const metrics: MetricCell[] = [
    {
      key: "transport",
      label: "Transport",
      value: `${status.transport?.mode ?? "?"} · ${status.transport?.label ?? "?"}`,
    },
    {
      key: "peer-count",
      label: "Relay peers",
      value: String(peerCount),
      ...(peerTone ? { tone: peerTone } : {}),
    },
    {
      key: "target-count",
      label: "Discovered tabs",
      value: String(status.relay?.targetCount ?? 0),
    },
    {
      key: "last-heartbeat",
      label: "Last heartbeat",
      value: formatHeartbeat(status.relay?.lastHeartbeatAgeMs),
    },
    {
      key: "queue-depth",
      label: "Action queue depth",
      value: String(queueDepth),
      ...(queueTone ? { tone: queueTone } : {}),
    },
    {
      key: "expert-lane",
      label: "Expert lane",
      value: expert.available ? "available" : expert.reason ?? "unavailable",
      tone: expert.available ? "ok" : "warn",
    },
  ];
  return metrics;
}

function placeholders(): MetricCell[] {
  return [
    { key: "transport", label: "Transport", value: "—" },
    { key: "peer-count", label: "Relay peers", value: "—" },
    { key: "target-count", label: "Discovered tabs", value: "—" },
    { key: "last-heartbeat", label: "Last heartbeat", value: "—" },
    { key: "queue-depth", label: "Action queue depth", value: "—" },
    { key: "expert-lane", label: "Expert lane", value: "—" },
  ];
}

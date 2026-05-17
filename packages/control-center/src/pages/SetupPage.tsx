import { useState } from "react";

import { useApiClient } from "../api/useApiClient";
import type { BridgeStatus } from "../api/types";
import { KvTable, type KvRow } from "../components/KvTable";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";
import { pillFromStatus } from "../state/pillFromStatus";

const POLL_MS = 5_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; status: BridgeStatus }
  | { kind: "unreachable" }
  | { kind: "unauthorized" };

export function SetupPage() {
  const client = useApiClient();
  const { setPill, setLastStatus } = useAppState();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  usePolling(async () => {
    try {
      const status = await client.get<BridgeStatus>("/bridge/status");
      setLastStatus(status);
      setPill(pillFromStatus(status));
      setLoad({ kind: "ok", status });
    } catch (error) {
      if ((error as Error).message === "unauthorized") {
        setLoad({ kind: "unauthorized" });
      } else {
        setPill({ state: "bad", label: "Unreachable" });
        setLoad({ kind: "unreachable" });
      }
    }
  }, POLL_MS);

  return (
    <section className="page-section">
      <h1>Setup</h1>
      <p className="page-lede">
        First-time checklist. Each row reflects the live state of the running daemon.
      </p>
      <KvTable rows={kvRowsFromLoad(load)} />
      <h2>Next steps</h2>
      <ul className="hints">
        {hintsFromLoad(load).map((hint, i) => (
          <li key={i} className={hint.kind ?? undefined}>
            {hint.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function kvRowsFromLoad(load: LoadState): KvRow[] {
  if (load.kind === "loading") {
    return [
      { key: "daemon", label: "Daemon", value: "—" },
      { key: "url", label: "Daemon URL", value: "—" },
      { key: "token", label: "Auth token", value: "—" },
      { key: "transport", label: "Transport", value: "—" },
      { key: "extension", label: "Browser extension", value: "—" },
      { key: "sessions", label: "Active sessions", value: "—" },
    ];
  }
  if (load.kind === "unreachable" || load.kind === "unauthorized") {
    const dashLabel = load.kind === "unauthorized" ? "unauthorized" : "unreachable";
    return [
      { key: "daemon", label: "Daemon", value: dashLabel },
      { key: "url", label: "Daemon URL", value: "—" },
      { key: "token", label: "Auth token", value: "—" },
      { key: "transport", label: "Transport", value: "—" },
      { key: "extension", label: "Browser extension", value: "—" },
      { key: "sessions", label: "Active sessions", value: "—" },
    ];
  }
  const status = load.status;
  return [
    {
      key: "daemon",
      label: "Daemon",
      value: `running · v${status.version ?? "?"}`,
    },
    { key: "url", label: "Daemon URL", value: `127.0.0.1:${status.port ?? "?"}` },
    { key: "token", label: "Auth token", value: status ? "configured" : "missing" },
    {
      key: "transport",
      label: "Transport",
      value: `${status.transport?.mode ?? "?"} — ${status.transport?.label ?? "?"}`,
    },
    { key: "extension", label: "Browser extension", value: describeExtension(status) },
    { key: "sessions", label: "Active sessions", value: String(status.sessions?.count ?? 0) },
  ];
}

function describeExtension(status: BridgeStatus): string {
  const mode = status.transport?.mode;
  if (mode === "local") return "not required (local Chromium transport)";
  if (mode === "relay") {
    const peers = status.relay?.peerCount ?? 0;
    return peers > 0 ? `connected — ${peers} peer(s)` : "no peers connected";
  }
  if (mode === "direct-cdp") {
    return status.directCdp?.endpoint
      ? `direct CDP — ${status.directCdp.endpoint}`
      : "direct CDP — endpoint not set";
  }
  return "—";
}

interface Hint {
  text: string;
  kind?: "todo" | "done";
}

function hintsFromLoad(load: LoadState): Hint[] {
  if (load.kind === "unauthorized") return [];
  if (load.kind === "unreachable") {
    return [{ text: "Daemon did not respond. Try `turnkeyai daemon status`.", kind: "todo" }];
  }
  if (load.kind === "loading") return [];
  const status = load.status;
  const hints: Hint[] = [];
  const mode = status.transport?.mode;
  if (mode === "relay" && (status.relay?.peerCount ?? 0) === 0) {
    hints.push({
      text: "Install the relay extension: `turnkeyai bridge install-extension`",
      kind: "todo",
    });
  }
  if (mode === "direct-cdp" && !status.directCdp?.endpoint) {
    hints.push({
      text: "Set TURNKEYAI_BROWSER_CDP_ENDPOINT and restart the daemon.",
      kind: "todo",
    });
  }
  if ((status.sessions?.count ?? 0) === 0) {
    hints.push({
      text: "Bootstrap a demo thread: `curl -X POST /threads/bootstrap-demo`",
      kind: "todo",
    });
  } else {
    hints.push({
      text: `${status.sessions.count} active session(s)`,
      kind: "done",
    });
  }
  hints.push({
    text: "Plug an agent in via the Agent Connect tab.",
    kind: "todo",
  });
  return hints;
}

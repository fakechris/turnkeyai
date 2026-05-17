import { useState } from "react";

import { useApiClient } from "../api/useApiClient";
import type { BridgeStatus, RelayTarget, ThreadSummary } from "../api/types";
import { formatRelativeTimestamp } from "../components/format";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";
import { pillFromStatus, labelForMode } from "../state/pillFromStatus";

const POLL_MS = 5_000;

interface PageState {
  tabs: { kind: "skip"; reason: string } | { kind: "ok"; targets: RelayTarget[] } | { kind: "error"; message: string };
  threads: { kind: "ok"; threads: ThreadSummary[] } | { kind: "error"; message: string };
}

export function TabsPage() {
  const client = useApiClient();
  const { state, setPill, setLastStatus } = useAppState();
  const [pageState, setPageState] = useState<PageState>({
    tabs: { kind: "skip", reason: "Loading…" },
    threads: { kind: "ok", threads: [] },
  });

  usePolling(async () => {
    // Fetch /bridge/status first so we know the transport mode. /relay/*
    // returns 503 on local/direct-cdp transport — branching on mode lets
    // us surface a friendly "transport doesn't have tabs" message instead.
    let status: BridgeStatus | null = null;
    try {
      status = await client.get<BridgeStatus>("/bridge/status");
      setLastStatus(status);
      setPill(pillFromStatus(status));
    } catch (error) {
      if ((error as Error).message === "unauthorized") return;
      setPill({ state: "bad", label: "Unreachable" });
    }

    const transportMode = status?.transport?.mode ?? null;
    const wantTargets = transportMode === "relay";
    const [targetsResult, threadsResult] = await Promise.allSettled([
      wantTargets ? client.get<RelayTarget[]>("/relay/targets") : Promise.resolve(null),
      client.get<ThreadSummary[]>("/threads"),
    ]);

    const next: PageState = {
      tabs: deriveTabsState(targetsResult, transportMode),
      threads: deriveThreadsState(threadsResult),
    };
    setPageState(next);
    if (status) {
      // Pill could have been "Unreachable" set above; re-apply on success.
      setPill(pillFromStatus(status));
    } else if (next.threads.kind === "ok" || next.tabs.kind === "ok") {
      setPill({ state: "ok", label: state.lastStatus ? labelForMode(state.lastStatus.transport.mode) : "Connected" });
    }
  }, POLL_MS);

  return (
    <section className="page-section">
      <h1>Tabs &amp; Threads</h1>
      <p className="page-lede">
        Live view of browser tabs discovered via the relay transport, plus the threads the daemon
        is tracking. Polls every 5 seconds. Read-only for now — spawn / revoke / navigate land in
        a follow-up.
      </p>
      <TabsSection state={pageState.tabs} />
      <ThreadsSection state={pageState.threads} />
    </section>
  );
}

function deriveTabsState(
  result: PromiseSettledResult<RelayTarget[] | null>,
  mode: string | null
): PageState["tabs"] {
  if (result.status === "rejected") {
    const message = (result.reason as Error)?.message ?? "unknown error";
    if (message === "unauthorized") return { kind: "skip", reason: "" };
    return { kind: "error", message };
  }
  if (result.value === null) {
    if (mode === "local") {
      return {
        kind: "skip",
        reason:
          "Tabs are only discovered on the relay transport. Local Chromium sessions are listed under Bridge.",
      };
    }
    if (mode === "direct-cdp") {
      return {
        kind: "skip",
        reason: "Tabs come from the relay extension. Direct-CDP transport bypasses it.",
      };
    }
    return { kind: "skip", reason: "Tabs unavailable — daemon status could not be read." };
  }
  return { kind: "ok", targets: result.value };
}

function deriveThreadsState(
  result: PromiseSettledResult<ThreadSummary[]>
): PageState["threads"] {
  if (result.status === "rejected") {
    const message = (result.reason as Error)?.message ?? "unknown error";
    if (message === "unauthorized") return { kind: "ok", threads: [] };
    return { kind: "error", message };
  }
  return { kind: "ok", threads: result.value };
}

function TabsSection({ state }: { state: PageState["tabs"] }) {
  return (
    <>
      <h2>
        Discovered tabs{" "}
        <span className="muted-count">
          {state.kind === "ok" ? `(${state.targets.length})` : ""}
        </span>
      </h2>
      {state.kind === "ok" && state.targets.length > 0 ? (
        <table className="kv list-table">
          <thead>
            <tr>
              <th>Tab</th>
              <th>URL</th>
              <th>Status</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {state.targets.map((t) => (
              <tr key={t.relayTargetId}>
                <td className="tab-title">{t.title || t.relayTargetId || "—"}</td>
                <td className="tab-url">{t.url || "—"}</td>
                <td className="tab-status">{t.status || "—"}</td>
                <td className="tab-age">{formatRelativeTimestamp(t.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="list-empty">
          {state.kind === "skip"
            ? state.reason
            : state.kind === "error"
              ? `Could not load tabs: ${state.message}`
              : "Relay transport is active but no tabs discovered yet. Open a tab in the connected browser, or check the relay extension."}
        </div>
      )}
    </>
  );
}

function ThreadsSection({ state }: { state: PageState["threads"] }) {
  return (
    <>
      <h2>
        Threads{" "}
        <span className="muted-count">
          {state.kind === "ok" ? `(${state.threads.length})` : ""}
        </span>
      </h2>
      {state.kind === "ok" && state.threads.length > 0 ? (
        <table className="kv list-table">
          <thead>
            <tr>
              <th>Team</th>
              <th>Roles</th>
              <th>Lead</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {state.threads.map((t) => (
              <tr key={t.threadId}>
                <td className="tab-title">{t.teamName || t.teamId || "—"}</td>
                <td className="muted">
                  {Array.isArray(t.roles) ? String(t.roles.length) : "0"}
                </td>
                <td className="tab-url">{t.leadRoleId || "—"}</td>
                <td className="tab-age">{formatRelativeTimestamp(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="list-empty">
          {state.kind === "error"
            ? `Could not load threads: ${state.message}`
            : "No threads yet. Bootstrap a demo with `curl -X POST /threads/bootstrap-demo`."}
        </div>
      )}
    </>
  );
}

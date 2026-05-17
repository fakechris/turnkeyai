import { useEffect } from "react";

import { useApiClient } from "../api/useApiClient";
import type { BridgeStatus } from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { KvTable } from "../components/KvTable";
import { ScopeBanner, scopeSummary } from "../components/ScopeBanner";
import { useAppState } from "../state/AppState";
import { pillFromStatus } from "../state/pillFromStatus";

export function AgentConnectPage() {
  const client = useApiClient();
  const { state, setPill, setLastStatus } = useAppState();
  const baseUrl = window.location.origin;
  const scope = state.scope;

  // One-shot liveness check on mount. Agent Connect doesn't need 5s
  // polling — copy-pasteable snippets don't change between refreshes.
  useEffect(() => {
    let cancelled = false;
    void client
      .get<BridgeStatus>("/bridge/status")
      .then((status) => {
        if (cancelled) return;
        setLastStatus(status);
        setPill(pillFromStatus(status));
      })
      .catch((error: Error) => {
        if (cancelled) return;
        if (error.message !== "unauthorized") {
          setPill({ state: "bad", label: "Unreachable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, setLastStatus, setPill]);

  const snippets = buildAgentSnippets(baseUrl, state.token);
  const hideMutations = scope === "read";

  return (
    <section className="page-section">
      <h1>Agent Connect</h1>
      <p className="page-lede">
        Endpoints and snippets for plugging Claude / Codex / Comet / Kimi into this daemon.
      </p>

      <ScopeBanner scope={scope} />

      <table className="kv" style={{ marginBottom: "16px" }}>
        <tbody>
          <tr>
            <th>Token scope</th>
            <td>
              <code>{scope}</code>{" "}
              <span className="note" style={{ marginLeft: "8px" }}>
                {scopeSummary(scope)}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Endpoints</h2>
      <KvTable
        rows={[
          { key: "base", label: "Base URL", value: baseUrl },
          {
            key: "status",
            label: "Status",
            value: (
              <code>
                GET&nbsp;/bridge/status
              </code>
            ),
          },
          {
            key: "tier1",
            label: "Tier 1 command",
            value: <code>POST&nbsp;/bridge/command</code>,
          },
          {
            key: "tier2",
            label: "Tier 2 advanced",
            value: <code>POST&nbsp;/bridge/advanced</code>,
          },
          { key: "batch", label: "Batch", value: <code>POST&nbsp;/bridge/batch</code> },
          {
            key: "expert",
            label: "Raw CDP expert",
            value: <code>POST&nbsp;/bridge/expert</code>,
          },
        ]}
      />

      <h2>Auth header</h2>
      <p>Every call must carry the daemon token in either header:</p>
      <pre className="snippet">{snippets.auth}</pre>
      <CopyButton text={snippets.auth} label="Copy auth header" />

      {!hideMutations && (
        <>
          <h2>Curl example — Tier 1 click</h2>
          <pre className="snippet">{snippets.curl}</pre>
          <CopyButton text={snippets.curl} label="Copy curl" />

          <h2>Claude Code skill (snippet)</h2>
          <pre className="snippet">{snippets.skill}</pre>
          <CopyButton text={snippets.skill} label="Copy skill snippet" />
        </>
      )}

      <p className="note">
        For a full skill bundle, run <code>turnkeyai bridge install-skill</code> from your
        terminal. That writes a generated skill doc into <code>~/.turnkeyai/skills/</code>.
      </p>
    </section>
  );
}

interface AgentSnippets {
  auth: string;
  curl: string;
  skill: string;
}

function buildAgentSnippets(baseUrl: string, token: string | null): AgentSnippets {
  const tokenLine = token ?? "<DAEMON_TOKEN>";
  return {
    auth: `Authorization: Bearer ${tokenLine}\nx-turnkeyai-token: ${tokenLine}`,
    curl: [
      `curl -X POST ${baseUrl}/bridge/command \\`,
      `  -H 'authorization: Bearer ${tokenLine}' \\`,
      "  -H 'content-type: application/json' \\",
      `  -d '{"tool":"navigate","args":{"url":"https://example.com"}}'`,
    ].join("\n"),
    skill: [
      "# TurnkeyAI Browser Bridge",
      "",
      `Endpoint: ${baseUrl}/bridge/command`,
      "Auth:     Authorization: Bearer <token>",
      "",
      "Tier-1 tools: navigate, snapshot, click, fill, key, select,",
      "              screenshot, eval, wait_for, upload, list_tabs,",
      "              switch_tab, close_tab",
      "",
      "Body: { tool: <name>, args?: <object>, sessionId?: <string> }",
      "",
      "Run `turnkeyai bridge install-skill` for a full skill doc.",
    ].join("\n"),
  };
}

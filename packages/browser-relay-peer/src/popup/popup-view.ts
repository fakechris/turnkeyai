export interface PopupStatusModel {
  daemonUrl: string;
  daemonToken: string;
  peerId: string;
  peerLabel: string;
  connection: "connected" | "disconnected" | "checking";
  daemonReachable: boolean | null;
  peerSeenByDaemon: boolean | null;
  transportMode: string | null;
  transportLabel: string | null;
  observedTargets: number;
  daemonPeers: number;
  daemonTargets: number;
  expertLane: boolean | null;
  lastHeartbeatAgeMs: number | null;
  lastError: string | null;
  version: string | null;
}

export function formatRelativeMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms ago`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function renderPopupBody(model: PopupStatusModel): string {
  const dotClass =
    model.connection === "connected"
      ? "dot dot-ok"
      : model.connection === "disconnected"
        ? "dot dot-bad"
        : "dot dot-pending";
  const stateLabel =
    model.connection === "connected"
      ? "Connected"
      : model.connection === "disconnected"
        ? "Disconnected"
        : "Checking…";
  const expertLabel =
    model.expertLane === null ? "—" : model.expertLane ? "available" : "unavailable";
  const peerSeenLabel =
    model.peerSeenByDaemon === null
      ? "—"
      : model.peerSeenByDaemon
        ? "yes"
        : "no (peer not registered with daemon)";

  return [
    `<header class="header">`,
    `  <span class="${dotClass}" aria-hidden="true"></span>`,
    `  <h1>TurnkeyAI Relay</h1>`,
    `  <span class="version">${escapeHtml(model.version ?? "")}</span>`,
    `</header>`,
    `<dl class="status">`,
    `  <dt>State</dt><dd>${escapeHtml(stateLabel)}</dd>`,
    `  <dt>Daemon</dt><dd>${escapeHtml(model.daemonUrl)}</dd>`,
    `  <dt>Daemon reachable</dt><dd>${model.daemonReachable === null ? "—" : model.daemonReachable ? "yes" : "no"}</dd>`,
    `  <dt>Peer registered</dt><dd>${escapeHtml(peerSeenLabel)}</dd>`,
    `  <dt>Transport</dt><dd>${escapeHtml(model.transportMode ?? "—")}${model.transportLabel ? ` (${escapeHtml(model.transportLabel)})` : ""}</dd>`,
    `  <dt>Expert lane</dt><dd>${escapeHtml(expertLabel)}</dd>`,
    `  <dt>Tabs observed</dt><dd>${model.observedTargets}</dd>`,
    `  <dt>Daemon peers</dt><dd>${model.daemonPeers}</dd>`,
    `  <dt>Daemon targets</dt><dd>${model.daemonTargets}</dd>`,
    `  <dt>Last heartbeat</dt><dd>${escapeHtml(formatRelativeMs(model.lastHeartbeatAgeMs))}</dd>`,
    `  <dt>Peer ID</dt><dd class="mono">${escapeHtml(model.peerId)}</dd>`,
    model.lastError
      ? `  <dt>Last error</dt><dd class="error">${escapeHtml(model.lastError)}</dd>`
      : "",
    `</dl>`,
    `<div class="actions">`,
    `  <button id="btn-reconnect" type="button">Reconnect</button>`,
    `  <button id="btn-copy" type="button">Copy diagnostics</button>`,
    `  <button id="btn-open" type="button">Open daemon</button>`,
    `</div>`,
    `<details class="settings">`,
    `  <summary>Settings</summary>`,
    `  <form id="settings-form">`,
    `    <label>Daemon URL<input name="daemonUrl" type="url" value="${escapeHtml(model.daemonUrl)}" autocomplete="off" /></label>`,
    `    <label>Token<input name="daemonToken" type="password" value="${escapeHtml(model.daemonToken)}" autocomplete="off" /></label>`,
    `    <label>Peer label<input name="peerLabel" type="text" value="${escapeHtml(model.peerLabel)}" autocomplete="off" /></label>`,
    `    <button type="submit">Save</button>`,
    `  </form>`,
    `</details>`,
  ]
    .filter(Boolean)
    .join("");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

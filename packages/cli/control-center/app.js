// TurnkeyAI Control Center — vanilla JS hash-routed dashboard.
//
// No framework, no build step. Served by the daemon at /app and talks to the
// same daemon as a real client (every fetch carries the daemon token). The
// token is bootstrapped from the URL fragment when the CLI opens the page,
// then persisted to sessionStorage so reloads keep working without re-running
// `turnkeyai app`.

const TOKEN_STORAGE_KEY = "turnkeyai.controlCenter.token";
const DEFAULT_ROUTE = "setup";
const KNOWN_ROUTES = ["setup", "bridge", "agent"];
const POLL_INTERVAL_MS = 5_000;

const pageRoot = document.getElementById("page");
const connectionPill = document.getElementById("connection-pill");
const navLinks = Array.from(document.querySelectorAll(".nav a[data-route]"));

const state = {
  token: null,
  route: DEFAULT_ROUTE,
  pollTimer: null,
  lastStatus: null,
};

bootstrapToken();
window.addEventListener("hashchange", handleHashChange);
handleHashChange();

function bootstrapToken() {
  const fragment = parseFragment(window.location.hash);
  if (fragment.token) {
    state.token = fragment.token;
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fragment.token);
    // Strip the token from the URL fragment so it does not linger in the
    // address bar / window title. Keep the route piece, if any, as the
    // canonical hash route.
    const cleanedRoute = fragment.route ?? DEFAULT_ROUTE;
    history.replaceState(null, "", `#/${cleanedRoute}`);
  } else {
    const stored = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      state.token = stored;
    }
  }
}

function parseFragment(rawHash) {
  // Accepted shapes:
  //   #/setup
  //   #token=ABC
  //   #token=ABC&route=bridge
  //   #/bridge?token=ABC (legacy — also accepted)
  const hash = rawHash.replace(/^#/, "");
  if (!hash) return { token: null, route: null };
  if (hash.startsWith("/")) {
    const [routePart, queryPart] = hash.slice(1).split("?");
    const params = new URLSearchParams(queryPart ?? "");
    return {
      token: params.get("token"),
      route: normalizeRoute(routePart),
    };
  }
  const params = new URLSearchParams(hash);
  return {
    token: params.get("token"),
    route: normalizeRoute(params.get("route")),
  };
}

function normalizeRoute(value) {
  if (!value) return null;
  return KNOWN_ROUTES.includes(value) ? value : null;
}

function handleHashChange() {
  const fragment = parseFragment(window.location.hash);
  const route = fragment.route ?? DEFAULT_ROUTE;
  state.route = route;
  for (const link of navLinks) {
    link.classList.toggle("active", link.dataset.route === route);
  }
  renderActiveRoute();
}

function renderActiveRoute() {
  stopPolling();
  if (!state.token) {
    renderTemplate("page-no-token", wireTokenForm);
    setConnectionPill("warn", "No token");
    return;
  }
  switch (state.route) {
    case "setup":
      renderTemplate("page-setup", renderSetupPage);
      break;
    case "bridge":
      renderTemplate("page-bridge", renderBridgePage);
      break;
    case "agent":
      renderTemplate("page-agent", renderAgentPage);
      break;
    default:
      renderTemplate("page-setup", renderSetupPage);
  }
}

function renderTemplate(templateId, onMount) {
  const template = document.getElementById(templateId);
  if (!template) {
    pageRoot.innerHTML = `<p class="loading">Missing template: ${templateId}</p>`;
    return;
  }
  pageRoot.replaceChildren(template.content.cloneNode(true));
  if (onMount) {
    onMount(pageRoot);
  }
}

function setConnectionPill(stateName, label) {
  if (!connectionPill) return;
  connectionPill.dataset.state = stateName;
  const labelNode = connectionPill.querySelector(".label");
  if (labelNode) labelNode.textContent = label;
}

async function apiFetch(pathname) {
  // Capture the token used for THIS request. If the token changes underneath
  // us (user pasted a new one in the no-token form) and an older request
  // happens to return 401, we must not wipe the fresh token.
  const requestToken = state.token;
  const headers = {
    accept: "application/json",
  };
  if (requestToken) {
    headers.authorization = `Bearer ${requestToken}`;
    headers["x-turnkeyai-token"] = requestToken;
  }
  const response = await fetch(pathname, { headers });
  if (response.status === 401) {
    if (state.token === requestToken) {
      // Only clear if the same token is still current — otherwise this is a
      // stale 401 for a token the user has already replaced.
      stopPolling();
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      state.token = null;
      renderTemplate("page-no-token", wireTokenForm);
      setConnectionPill("bad", "Unauthorized");
    }
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    throw new Error(`${pathname} responded ${response.status}`);
  }
  return response.json();
}

function startPolling(renderer) {
  stopPolling();
  // Recursive setTimeout instead of setInterval — guarantees the next poll
  // is only scheduled after the previous one finishes, so a slow daemon
  // can't stack up overlapping in-flight requests against itself.
  const tick = () => {
    void renderer()
      .catch(() => {
        // Renderer owns its own error display; swallow here so the loop
        // keeps trying.
      })
      .finally(() => {
        if (state.pollTimer !== null) {
          state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
        }
      });
  };
  // Non-null sentinel so stopPolling() correctly clears the first scheduled
  // tick. The actual timer ID is replaced on the first .finally().
  state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer !== null) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

// ---------- No-token page ----------

function wireTokenForm(root) {
  const form = root.querySelector("#token-form");
  const input = root.querySelector("#token-input");
  if (!form || !input) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    state.token = value;
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    handleHashChange();
  });
}

// ---------- Setup page ----------

function renderSetupPage(root) {
  const refresh = async () => {
    try {
      const status = await apiFetch("/bridge/status");
      state.lastStatus = status;
      updateSetupFields(root, status);
      updateConnectionPillFromStatus(status);
    } catch (error) {
      // apiFetch already handled 401. For other errors, mark the pill bad
      // and surface a hint in the daemon row.
      if (error.message !== "unauthorized") {
        markSetupUnreachable(root);
        setConnectionPill("bad", "Unreachable");
      }
    }
  };
  void refresh();
  startPolling(refresh);
}

function updateSetupFields(root, status) {
  setField(root, "daemon", `running · v${status.version ?? "?"}`);
  setField(root, "daemon-url", `127.0.0.1:${status.port ?? "?"}`);
  setField(root, "token", status ? "configured" : "missing");
  setField(
    root,
    "transport",
    `${status.transport?.mode ?? "?"} — ${status.transport?.label ?? "?"}`
  );
  setField(root, "extension", describeExtension(status));
  setField(root, "sessions", String(status.sessions?.count ?? 0));

  const hints = root.querySelector('[data-field="hints"]');
  if (hints) {
    hints.replaceChildren(...buildSetupHints(status).map(renderHint));
  }
}

function markSetupUnreachable(root) {
  for (const field of [
    "daemon",
    "daemon-url",
    "token",
    "transport",
    "extension",
    "sessions",
  ]) {
    setField(root, field, "—");
  }
  const daemonCell = root.querySelector('[data-field="daemon"]');
  if (daemonCell) daemonCell.textContent = "unreachable";
  const hints = root.querySelector('[data-field="hints"]');
  if (hints) {
    hints.replaceChildren(
      renderHint({
        text: "Daemon did not respond. Try `turnkeyai daemon status`.",
        kind: "todo",
      })
    );
  }
}

function describeExtension(status) {
  if (status.transport?.mode === "local") {
    return "not required (local Chromium transport)";
  }
  if (status.transport?.mode === "relay") {
    const peers = status.relay?.peerCount ?? 0;
    return peers > 0 ? `connected — ${peers} peer(s)` : "no peers connected";
  }
  if (status.transport?.mode === "direct-cdp") {
    return status.directCdp?.endpoint
      ? `direct CDP — ${status.directCdp.endpoint}`
      : "direct CDP — endpoint not set";
  }
  return "—";
}

function buildSetupHints(status) {
  const hints = [];
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

function renderHint({ text, kind }) {
  const li = document.createElement("li");
  li.textContent = text;
  if (kind) li.classList.add(kind);
  return li;
}

// ---------- Bridge page ----------

function renderBridgePage(root) {
  const refresh = async () => {
    try {
      const status = await apiFetch("/bridge/status");
      state.lastStatus = status;
      updateBridgeFields(root, status);
      updateConnectionPillFromStatus(status);
    } catch (error) {
      if (error.message !== "unauthorized") {
        markBridgeUnreachable(root);
        setConnectionPill("bad", "Unreachable");
      }
    }
  };
  void refresh();
  startPolling(refresh);
}

function updateBridgeFields(root, status) {
  setField(
    root,
    "transport-label",
    `${status.transport?.mode ?? "?"} · ${status.transport?.label ?? "?"}`
  );
  setField(root, "peer-count", String(status.relay?.peerCount ?? 0));
  setField(root, "target-count", String(status.relay?.targetCount ?? 0));
  setField(root, "last-heartbeat", formatHeartbeat(status.relay?.lastHeartbeatAgeMs));
  setField(root, "queue-depth", String(status.relay?.actionRequestQueueDepth ?? 0));

  const expert = status.expertLane ?? {};
  const expertCell = root.querySelector('[data-field="expert-lane"]');
  if (expertCell) {
    expertCell.textContent = expert.available
      ? "available"
      : expert.reason ?? "unavailable";
    expertCell.classList.remove("ok", "warn", "bad");
    expertCell.classList.add(expert.available ? "ok" : "warn");
  }

  setField(
    root,
    "cdp-configured",
    status.directCdp?.configured ? "yes" : "no"
  );
  setField(root, "cdp-endpoint", status.directCdp?.endpoint ?? "—");

  colorMetric(root, "peer-count", status.relay?.peerCount ?? 0, {
    okMin: status.transport?.mode === "relay" ? 1 : 0,
  });
  colorMetric(root, "queue-depth", status.relay?.actionRequestQueueDepth ?? 0, {
    warnMin: 10,
    badMin: 100,
  });
}

function markBridgeUnreachable(root) {
  // Reset both the value AND the metric color classes — otherwise stale
  // ok/warn/bad colors from the last good poll stick around and lie about
  // the current state.
  for (const field of [
    "transport-label",
    "peer-count",
    "target-count",
    "last-heartbeat",
    "queue-depth",
    "expert-lane",
    "cdp-configured",
    "cdp-endpoint",
  ]) {
    setField(root, field, "—");
    const cell = root.querySelector(`[data-field="${field}"]`);
    if (cell) cell.classList.remove("ok", "warn", "bad");
  }
}

function formatHeartbeat(ageMs) {
  if (ageMs === null || ageMs === undefined) return "never";
  if (ageMs < 1_000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1_000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return `${Math.round(ageMs / 3_600_000)}h ago`;
}

function colorMetric(root, field, value, thresholds) {
  const cell = root.querySelector(`[data-field="${field}"]`);
  if (!cell) return;
  cell.classList.remove("ok", "warn", "bad");
  if (thresholds.badMin !== undefined && value >= thresholds.badMin) {
    cell.classList.add("bad");
    return;
  }
  if (thresholds.warnMin !== undefined && value >= thresholds.warnMin) {
    cell.classList.add("warn");
    return;
  }
  if (thresholds.okMin !== undefined && value >= thresholds.okMin) {
    cell.classList.add("ok");
  }
}

// ---------- Agent connect page ----------

function renderAgentPage(root) {
  const baseUrl = window.location.origin;
  setField(root, "base-url", baseUrl);

  const snippets = buildAgentSnippets(baseUrl, state.token);
  for (const [name, value] of Object.entries(snippets)) {
    const slot = root.querySelector(`[data-snippet="${name}"]`);
    if (slot) slot.textContent = value;
  }

  for (const button of root.querySelectorAll(".copy[data-copy]")) {
    button.addEventListener("click", () => {
      const name = button.dataset.copy;
      const slot = root.querySelector(`[data-snippet="${name}"]`);
      if (!slot) return;
      const text = slot.textContent ?? "";
      navigator.clipboard
        .writeText(text)
        .then(() => {
          button.classList.add("copied");
          const original = button.textContent;
          button.textContent = "Copied";
          window.setTimeout(() => {
            button.classList.remove("copied");
            button.textContent = original;
          }, 1_200);
        })
        .catch(() => {
          button.textContent = "Copy failed";
        });
    });
  }

  // Refresh the connection pill once on mount — agent page doesn't need to
  // poll, but a quick liveness check on entry is useful. Skip the
  // "Unreachable" overwrite on auth errors so we don't stomp the
  // "Unauthorized" pill that apiFetch already set before throwing.
  void apiFetch("/bridge/status")
    .then((status) => updateConnectionPillFromStatus(status))
    .catch((error) => {
      if (error?.message !== "unauthorized") {
        setConnectionPill("bad", "Unreachable");
      }
    });
}

function buildAgentSnippets(baseUrl, token) {
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

// ---------- Shared ----------

function setField(root, field, value) {
  const node = root.querySelector(`[data-field="${field}"]`);
  if (node) node.textContent = value;
}

function updateConnectionPillFromStatus(status) {
  const mode = status?.transport?.mode;
  if (!mode) {
    setConnectionPill("warn", "Unknown");
    return;
  }
  if (mode === "relay" && (status.relay?.peerCount ?? 0) === 0) {
    setConnectionPill("warn", "Relay — no peers");
    return;
  }
  if (mode === "direct-cdp" && !status.directCdp?.endpoint) {
    setConnectionPill("warn", "Direct CDP — no endpoint");
    return;
  }
  setConnectionPill("ok", labelForMode(mode));
}

function labelForMode(mode) {
  if (mode === "local") return "Local";
  if (mode === "relay") return "Relay";
  if (mode === "direct-cdp") return "Direct CDP";
  return mode;
}

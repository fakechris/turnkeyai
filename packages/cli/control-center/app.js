// TurnkeyAI Control Center — vanilla JS hash-routed dashboard.
//
// No framework, no build step. Served by the daemon at /app and talks to the
// same daemon as a real client (every fetch carries the daemon token). The
// token is bootstrapped from the URL fragment when the CLI opens the page,
// then persisted to sessionStorage so reloads keep working without re-running
// `turnkeyai app`.

const TOKEN_STORAGE_KEY = "turnkeyai.controlCenter.token";
// PR I: scope is bootstrapped from the URL fragment (set by `turnkeyai app`)
// or — for users who paste a token via the no-token form — defaults to
// "unknown" since we can't introspect a hand-pasted token's grants.
const SCOPE_STORAGE_KEY = "turnkeyai.controlCenter.scope";
const KNOWN_SCOPES = ["read", "operator", "admin", "unknown"];
const DEFAULT_ROUTE = "setup";
const KNOWN_ROUTES = ["setup", "bridge", "tabs", "agent", "diagnostics"];
const POLL_INTERVAL_MS = 5_000;

const pageRoot = document.getElementById("page");
const connectionPill = document.getElementById("connection-pill");
const navLinks = Array.from(document.querySelectorAll(".nav a[data-route]"));

const state = {
  token: null,
  scope: "unknown",
  route: DEFAULT_ROUTE,
  pollTimer: null,
  // Epoch counter for the polling loop. Each startPolling() bumps this;
  // each in-flight tick captures its epoch and only reschedules if it still
  // matches. Without this, an old tick's .finally() can see the NEW route's
  // non-null pollTimer sentinel and resurrect itself, leaving two parallel
  // poll loops running (codex re-review #2).
  pollEpoch: 0,
  lastStatus: null,
};

bootstrapToken();
window.addEventListener("hashchange", handleHashChange);
handleHashChange();

function bootstrapToken() {
  const fragment = parseFragment(window.location.hash);
  if (fragment.token) {
    state.token = fragment.token;
    state.scope = normalizeScope(fragment.scope);
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fragment.token);
    sessionStorage.setItem(SCOPE_STORAGE_KEY, state.scope);
    // Strip the token + scope from the URL fragment so they do not linger
    // in the address bar / window title. Keep the route piece, if any, as
    // the canonical hash route.
    const cleanedRoute = fragment.route ?? DEFAULT_ROUTE;
    history.replaceState(null, "", `#/${cleanedRoute}`);
  } else {
    const stored = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      state.token = stored;
      state.scope = normalizeScope(sessionStorage.getItem(SCOPE_STORAGE_KEY));
    }
  }
}

function normalizeScope(raw) {
  if (typeof raw === "string" && KNOWN_SCOPES.includes(raw)) return raw;
  return "unknown";
}

function parseFragment(rawHash) {
  // Accepted shapes:
  //   #/setup
  //   #token=ABC
  //   #token=ABC&scope=operator&route=bridge
  //   #/bridge?token=ABC&scope=admin (legacy — also accepted)
  const hash = rawHash.replace(/^#/, "");
  if (!hash) return { token: null, scope: null, route: null };
  if (hash.startsWith("/")) {
    const [routePart, queryPart] = hash.slice(1).split("?");
    const params = new URLSearchParams(queryPart ?? "");
    return {
      token: params.get("token"),
      scope: params.get("scope"),
      route: normalizeRoute(routePart),
    };
  }
  const params = new URLSearchParams(hash);
  return {
    token: params.get("token"),
    scope: params.get("scope"),
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
    case "tabs":
      renderTemplate("page-tabs", renderTabsPage);
      break;
    case "agent":
      renderTemplate("page-agent", renderAgentPage);
      break;
    case "diagnostics":
      renderTemplate("page-diagnostics", renderDiagnosticsPage);
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
      sessionStorage.removeItem(SCOPE_STORAGE_KEY);
      state.token = null;
      state.scope = "unknown";
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
  //
  // Use an epoch to bind each tick to THIS startPolling call. If the user
  // navigates to a new route while a tick is in-flight, stopPolling bumps
  // the epoch and the resolving tick will see the mismatch and skip its
  // reschedule. Without this, the old tick's `.finally()` could resurrect
  // itself against the NEW route's pollTimer sentinel.
  const myEpoch = ++state.pollEpoch;
  const tick = () => {
    void renderer()
      .catch(() => {})
      .finally(() => {
        if (state.pollEpoch === myEpoch) {
          state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
        }
      });
  };
  state.pollTimer = window.setTimeout(tick, POLL_INTERVAL_MS);
}

function stopPolling() {
  // Bump the epoch FIRST so any in-flight tick's .finally() sees the
  // mismatch before we clear the timer handle.
  state.pollEpoch += 1;
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
    // Hand-pasted tokens have no scope hint — we can't know what the user
    // pasted. Default to "unknown" which the dashboard treats as
    // "probably operator+", same as a legacy single-token setup.
    state.scope = "unknown";
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    sessionStorage.setItem(SCOPE_STORAGE_KEY, state.scope);
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

// ---------- Tabs page ----------

function renderTabsPage(root) {
  const refresh = async () => {
    // Fetch /bridge/status first so we know the transport mode. /relay/*
    // returns 503 on local/direct-cdp transport ("relay browser transport
    // is not active") — calling it unconditionally would surface that as
    // a scary error. Branch on transport.mode instead.
    let status;
    try {
      status = await apiFetch("/bridge/status");
      state.lastStatus = status;
      updateConnectionPillFromStatus(status);
    } catch (error) {
      // On unauthorized, apiFetch has already swapped in the no-token page
      // and stopped polling — nothing more to do here. Doing another fetch
      // would just re-trigger the same 401 path.
      if (error.message === "unauthorized") return;

      setConnectionPill("bad", "Unreachable");
      // Try /threads anyway; it might still work if /bridge/status hit a
      // transient hiccup. Pass null to renderTabsSection so it shows the
      // transport-unknown empty state rather than the misleading "relay
      // is active but no tabs" message that an empty fulfilled array
      // would produce (caught by CodeRabbit + gemini).
      const threadsResult = await reflect(apiFetch("/threads"));
      renderTabsSection(root, null, null);
      renderThreadsSection(root, threadsResult);
      return;
    }

    const transportMode = status?.transport?.mode ?? null;
    const targetsPromise =
      transportMode === "relay" ? reflect(apiFetch("/relay/targets")) : Promise.resolve(null);
    const [targetsResult, threadsResult] = await Promise.all([
      targetsPromise,
      reflect(apiFetch("/threads")),
    ]);

    renderTabsSection(root, targetsResult, transportMode);
    renderThreadsSection(root, threadsResult);
  };
  void refresh();
  startPolling(refresh);
}

// Promise.allSettled equivalent that returns the same {status,value/reason}
// shape but works on a single promise — keeps the call sites uniform with
// the renderXSection consumers.
function reflect(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason })
  );
}

function renderTabsSection(root, result, transportMode) {
  const table = root.querySelector('[data-field="tabs-table"]');
  const rows = root.querySelector('[data-field="tabs-rows"]');
  const empty = root.querySelector('[data-field="tabs-empty"]');
  const count = root.querySelector('[data-field="tab-count"]');

  const showEmpty = (text) => {
    if (table) table.hidden = true;
    if (empty) {
      empty.hidden = false;
      empty.textContent = text;
    }
    if (count) count.textContent = "";
    if (rows) rows.replaceChildren();
  };

  // result === null means we deliberately skipped the fetch (non-relay
  // transport). Show a transport-specific hint instead of an error.
  if (result === null) {
    if (transportMode === "local") {
      showEmpty(
        "Tabs are only discovered on the relay transport. Local Chromium sessions are listed under Bridge."
      );
    } else if (transportMode === "direct-cdp") {
      showEmpty("Tabs come from the relay extension. Direct-CDP transport bypasses it.");
    } else {
      // Reached when /bridge/status failed (transport mode couldn't be
      // determined). The Unreachable pill at the top already tells the
      // user the daemon is down; keep this in sync.
      showEmpty("Tabs unavailable — daemon status could not be read.");
    }
    return;
  }

  if (result.status !== "fulfilled" || !Array.isArray(result.value)) {
    if (result.status === "rejected" && result.reason?.message === "unauthorized") {
      // apiFetch already handled the redirect; just hide our content.
      showEmpty("");
      return;
    }
    showEmpty(`Could not load tabs: ${result.reason?.message ?? "unknown error"}`);
    return;
  }

  const targets = result.value;
  if (targets.length === 0) {
    showEmpty(
      "Relay transport is active but no tabs discovered yet. Open a tab in the connected browser, or check the relay extension."
    );
    return;
  }

  if (table) table.hidden = false;
  if (empty) empty.hidden = true;
  if (count) count.textContent = `(${targets.length})`;
  if (rows) {
    rows.replaceChildren(...targets.map(renderTabRow));
  }
}

function renderTabRow(target) {
  const tr = document.createElement("tr");
  tr.appendChild(cell(target.title || target.relayTargetId || "—", "tab-title"));
  tr.appendChild(cell(target.url || "—", "tab-url"));
  tr.appendChild(cell(target.status || "—", "tab-status"));
  tr.appendChild(cell(formatRelativeTimestamp(target.lastSeenAt), "tab-age"));
  return tr;
}

function renderThreadsSection(root, result) {
  const table = root.querySelector('[data-field="threads-table"]');
  const rows = root.querySelector('[data-field="threads-rows"]');
  const empty = root.querySelector('[data-field="threads-empty"]');
  const count = root.querySelector('[data-field="thread-count"]');

  if (result.status !== "fulfilled" || !Array.isArray(result.value) || result.value.length === 0) {
    if (table) table.hidden = true;
    if (empty) empty.hidden = false;
    if (count) count.textContent = "";
    if (rows) rows.replaceChildren();
    if (empty && result.status === "rejected" && result.reason?.message !== "unauthorized") {
      empty.textContent = `Could not load threads: ${result.reason?.message ?? "unknown error"}`;
    }
    return;
  }

  const threads = result.value;
  if (table) table.hidden = false;
  if (empty) empty.hidden = true;
  if (count) count.textContent = `(${threads.length})`;
  if (rows) {
    rows.replaceChildren(...threads.map(renderThreadRow));
  }
}

function renderThreadRow(thread) {
  const tr = document.createElement("tr");
  tr.appendChild(cell(thread.teamName || thread.teamId || "—", "tab-title"));
  const roleCount = Array.isArray(thread.roles) ? thread.roles.length : 0;
  tr.appendChild(cell(String(roleCount), "muted"));
  tr.appendChild(cell(thread.leadRoleId || "—", "tab-url"));
  tr.appendChild(cell(formatRelativeTimestamp(thread.createdAt), "tab-age"));
  return tr;
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.classList.add(className);
  return td;
}

function formatRelativeTimestamp(ts) {
  if (typeof ts !== "number" || !isFinite(ts)) return "—";
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return "just now";
  if (ageMs < 1_000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1_000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

// ---------- Agent connect page ----------

function renderAgentPage(root) {
  const baseUrl = window.location.origin;
  setField(root, "base-url", baseUrl);

  // PR I: surface the token scope. The Agent Connect page used to ALWAYS
  // render a POST /bridge/command curl snippet, but if the daemon was
  // configured with only TURNKEYAI_DAEMON_READ_TOKEN that snippet would
  // 401 silently — which is the worst kind of "looks fine, but broken"
  // UX. Now: if scope is "read", show a banner explaining the gap and
  // hide the mutation snippets entirely.
  applyScopeAffordances(root, state.scope);

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

function applyScopeAffordances(root, scope) {
  const label = root.querySelector('[data-field="scope-label"]');
  const detail = root.querySelector('[data-field="scope-detail"]');
  const banner = root.querySelector('[data-field="scope-banner"]');
  const mutation = root.querySelector('[data-field="mutation-snippets"]');

  const descriptions = {
    operator: {
      summary: "operator — can call /bridge/command + browser routes",
      banner: null,
    },
    admin: {
      summary: "admin — can call everything (validation/relay/admin routes too)",
      banner: {
        kind: "ok",
        text:
          "<strong>Heads up:</strong> this token has admin scope. Prefer a TURNKEYAI_DAEMON_OPERATOR_TOKEN if you only need to drive the browser — admin tokens can call validation and relay-admin routes the dashboard never needs.",
      },
    },
    read: {
      summary: "read — inspection only, cannot drive the browser",
      banner: {
        kind: "warn",
        text:
          "<strong>Read-only token.</strong> The <code>POST /bridge/command</code> snippet would 401 with this token, so it is hidden. To plug an agent in, set <code>TURNKEYAI_DAEMON_OPERATOR_TOKEN</code> and restart the daemon, then re-run <code>turnkeyai app</code>.",
      },
    },
    unknown: {
      summary: "unknown — single-token setup (assumed to grant full access)",
      banner: null,
    },
  };
  const entry = descriptions[scope] ?? descriptions.unknown;

  if (label) label.textContent = scope;
  if (detail) detail.textContent = entry.summary;
  if (banner) {
    if (entry.banner) {
      banner.hidden = false;
      banner.className = `scope-banner scope-${entry.banner.kind}`;
      banner.innerHTML = entry.banner.text;
    } else {
      banner.hidden = true;
    }
  }
  if (mutation) {
    // Hide mutation snippets entirely when scope is read — better than
    // showing a snippet the user will copy-paste into Claude and then
    // wonder why it 401s.
    mutation.hidden = scope === "read";
  }
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

// ---------- Diagnostics page ----------

function renderDiagnosticsPage(root) {
  // Cache the latest snapshot + log payload here so the "Copy bundle" button
  // can serialize them without re-fetching. The button is set up once on
  // mount; polling just refreshes the visible fields and the cached
  // payload.
  const cache = { diagnostics: null, logs: null };
  wireDiagnosticsCopy(root, cache);

  const refresh = async () => {
    const [diagResult, logsResult] = await Promise.all([
      reflect(apiFetch("/diagnostics")),
      reflect(apiFetch("/diagnostics/logs?limit=200")),
    ]);

    if (diagResult.status === "fulfilled") {
      cache.diagnostics = diagResult.value;
      renderDiagnosticsSnapshot(root, diagResult.value);
    } else if (diagResult.reason?.message !== "unauthorized") {
      markDiagnosticsUnreachable(root);
      setConnectionPill("bad", "Unreachable");
    }

    if (logsResult.status === "fulfilled") {
      cache.logs = logsResult.value;
      renderLogPane(root, logsResult.value);
    } else if (logsResult.reason?.message !== "unauthorized") {
      renderLogPane(root, {
        lines: [],
        note: `Could not load log: ${logsResult.reason?.message ?? "unknown error"}`,
      });
    }
  };
  void refresh();
  startPolling(refresh);
}

function renderDiagnosticsSnapshot(root, snapshot) {
  const daemon = snapshot.daemon ?? {};
  const paths = snapshot.paths ?? {};
  const transport = snapshot.transport ?? {};
  const counters = snapshot.counters ?? {};
  const node = snapshot.node ?? {};

  setField(root, "daemon-version", `v${daemon.version ?? "?"}`);
  setField(root, "daemon-port", String(daemon.port ?? "?"));
  setField(root, "daemon-uptime", formatUptime(daemon.uptimeMs));
  setField(root, "daemon-started-at", formatAbsoluteTimestamp(daemon.startedAt));
  setField(root, "daemon-auth-mode", daemon.authMode ?? "—");
  setField(root, "daemon-transport", `${transport.mode ?? "?"} (${transport.label ?? "?"})`);

  setField(root, "path-runtime", paths.runtimeRoot ?? "—");
  setField(root, "path-data", paths.dataDir ?? "—");
  setField(root, "path-config", paths.configFile ?? "—");
  setField(root, "path-log", paths.logFile ?? "—");
  setField(root, "path-catalog", paths.modelCatalogPath ?? "(none)");
  setField(
    root,
    "path-log-size",
    paths.logFileBytes == null
      ? "(no log file)"
      : `${formatBytes(paths.logFileBytes)} · modified ${formatRelativeTimestamp(paths.logFileModifiedAt)}`
  );

  setField(root, "count-sessions", String(counters.sessionCount ?? 0));
  setField(root, "count-peers", String(counters.relayPeerCount ?? 0));
  setField(root, "count-targets", String(counters.relayTargetCount ?? 0));

  setField(root, "node-version", node.version ?? "—");
  setField(root, "node-platform", node.platform ?? "—");
  setField(root, "node-arch", node.arch ?? "—");

  // If the diagnostics fetch succeeded, the pill should reflect transport
  // health like the other pages do. updateConnectionPillFromStatus expects
  // a bridge-status shape; use the cached one if we have it, otherwise
  // derive a minimal status object.
  if (state.lastStatus) {
    updateConnectionPillFromStatus(state.lastStatus);
  } else {
    setConnectionPill("ok", labelForMode(transport.mode));
  }
}

function markDiagnosticsUnreachable(root) {
  for (const field of [
    "daemon-version",
    "daemon-port",
    "daemon-uptime",
    "daemon-started-at",
    "daemon-auth-mode",
    "daemon-transport",
    "path-runtime",
    "path-data",
    "path-config",
    "path-log",
    "path-catalog",
    "path-log-size",
    "count-sessions",
    "count-peers",
    "count-targets",
    "node-version",
    "node-platform",
    "node-arch",
  ]) {
    setField(root, field, "—");
  }
}

function renderLogPane(root, payload) {
  const pane = root.querySelector('[data-field="log-pane"]');
  const meta = root.querySelector('[data-field="log-meta"]');
  if (!pane) return;

  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  if (lines.length === 0) {
    pane.classList.add("log-empty");
    pane.textContent = payload?.note || "Log is empty.";
    if (meta) meta.textContent = "";
    return;
  }
  pane.classList.remove("log-empty");
  // Capture scroll state BEFORE mutating textContent. If we measured after
  // the update, a poll that added enough new lines would inflate scrollHeight
  // and make our "within 40px of bottom" check false even when the user was
  // pinned to the bottom — so auto-scroll would stop working exactly when
  // there's new content (codex S2).
  const wasNearBottom =
    pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  pane.textContent = lines.join("\n");
  if (wasNearBottom) {
    pane.scrollTop = pane.scrollHeight;
  }

  if (meta) {
    const head = payload.truncatedFromHead ? "older lines truncated · " : "";
    meta.textContent = `(${head}${lines.length} line${lines.length === 1 ? "" : "s"})`;
  }
}

function wireDiagnosticsCopy(root, cache) {
  const button = root.querySelector('[data-copy-target="diagnostics-bundle"]');
  const target = root.querySelector('[data-field="diagnostics-bundle"]');
  if (!button || !target) return;
  button.addEventListener("click", () => {
    if (!cache.diagnostics) {
      button.textContent = "No data yet — wait for first poll";
      return;
    }
    const bundle = {
      diagnostics: cache.diagnostics,
      logTail: cache.logs ?? null,
      capturedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(bundle, null, 2);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        button.classList.add("copied");
        const original = button.textContent;
        button.textContent = "Copied";
        target.hidden = false;
        target.textContent = text;
        window.setTimeout(() => {
          button.classList.remove("copied");
          button.textContent = original;
        }, 1_500);
      })
      .catch(() => {
        // Fall back to revealing the bundle pre block for manual copy.
        target.hidden = false;
        target.textContent = text;
        button.textContent = "Clipboard unavailable — select text above";
      });
  });
}

function formatUptime(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatAbsoluteTimestamp(ts) {
  if (typeof ts !== "number" || !isFinite(ts)) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
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

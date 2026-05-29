# @turnkeyai/cli

TurnkeyAI 的本地优先 Agent Runtime CLI。

## Quick start

```bash
# Open the Control Center. Auto-starts the daemon if it isn't already
# running, then opens http://127.0.0.1:4100/app in your default browser
# with the daemon token preloaded.
npx @turnkeyai/cli app
```

That's the recommended product entry point: Mission Control. The dashboard is
a React + Vite + TS app shipped inside the CLI tarball; daemon serves it as
static assets at `/app`. Built from `@turnkeyai/control-center` workspace.

Current routes: `onboarding`, `missions`, `approvals`, `agents`, `context`,
`agent-connect`, `runtime`, and `settings`.

```bash
# Open straight to a specific page
npx @turnkeyai/cli app --route runtime

# Print the URL instead of launching a browser (CI / SSH / headless)
npx @turnkeyai/cli app --no-open

# Require an existing daemon — don't auto-start
npx @turnkeyai/cli app --no-start
```

Source checkout fallback when `turnkeyai` is not on PATH:

```bash
npm run install:local-cli
turnkeyai app
turnkeyai daemon status
```

If you do not want to modify the global npm link, use the source-tree scripts:

```bash
npm run app -- --no-open
npm run daemon:status
npm run doctor
```

## Daemon lifecycle (advanced)

```bash
# Start the daemon (detached, writes ~/.turnkeyai/{config.json,daemon.pid,logs/daemon.log})
npx @turnkeyai/cli daemon start

# Inspect daemon + bridge status
npx @turnkeyai/cli daemon status

# Tail logs
npx @turnkeyai/cli daemon logs --follow

# Stop / restart
npx @turnkeyai/cli daemon stop
npx @turnkeyai/cli daemon restart

# Run the daemon in the foreground (legacy / dev loop)
npx @turnkeyai/cli daemon                      # same as `daemon start --foreground`
npx @turnkeyai/cli daemon start --foreground

# Diagnose configuration
npx @turnkeyai/cli doctor

# TUI
npx @turnkeyai/cli tui
```

### Browser bridge

```bash
# Build and stage the relay extension into ~/.turnkeyai/extensions/relay
npx @turnkeyai/cli bridge install-extension

# Print /bridge/status (json)
npx @turnkeyai/cli bridge status

# Write an agent skill + OpenAPI schema to ~/.turnkeyai/skills/
npx @turnkeyai/cli bridge install-skill
```

The relay extension landed at `~/.turnkeyai/extensions/relay` should be loaded
into Chrome / Comet via `chrome://extensions` → Developer mode → Load unpacked.

### Files

| Path | Purpose |
| --- | --- |
| `~/.turnkeyai/config.json` | Auto-generated token + port + transport (0600) |
| `~/.turnkeyai/data/` | Default data dir (override via `TURNKEYAI_DATA_DIR`) |
| `~/.turnkeyai/logs/daemon.log` | Detached daemon log (rotated by OS append) |
| `~/.turnkeyai/daemon.pid` | PID of detached daemon |
| `~/.turnkeyai/extensions/relay/` | Unpacked relay extension |
| `~/.turnkeyai/skills/` | Generated agent-skill descriptors |

### Environment variables

| Variable | Effect |
| --- | --- |
| `TURNKEYAI_HOME` | Override `~/.turnkeyai` root |
| `TURNKEYAI_DAEMON_PORT` | Daemon listen port (default 4100) |
| `TURNKEYAI_DAEMON_URL` | Override the base URL CLI/TUI uses to reach the daemon |
| `TURNKEYAI_DAEMON_TOKEN` | Legacy single-token override (treated as full access) |
| `TURNKEYAI_DAEMON_OPERATOR_TOKEN` | Layered: covers `/bridge/*` + browser routes (preferred for `turnkeyai app`) |
| `TURNKEYAI_DAEMON_ADMIN_TOKEN` | Layered: covers everything (only chosen by `turnkeyai app` if no operator token is set) |
| `TURNKEYAI_DAEMON_READ_TOKEN` | Layered: inspection only (Agent Connect downgrades when this is all that's available) |
| `TURNKEYAI_DATA_DIR` | Override the data directory |
| `TURNKEYAI_BROWSER_TRANSPORT` | `local` / `relay` / `direct-cdp` |
| `TURNKEYAI_BROWSER_RELAY_ENDPOINT` | Relay endpoint URL |
| `TURNKEYAI_BROWSER_CDP_ENDPOINT` | Direct-CDP endpoint URL |

### Bridge HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /bridge/status` | Daemon + transport + relay + expert aggregate status |
| `POST /bridge/command` | Tier 1 facade (navigate / snapshot / click / fill / key / select / screenshot / eval / wait_for / upload / list_tabs / switch_tab / close_tab) |
| `POST /bridge/advanced` | Tier 2 extras (hover, scroll, dialog, popup, console, probe, pdf, click_coord, screenshot_clip, find_tab, network.*) |
| `POST /bridge/expert` | Raw CDP pass-through (direct-cdp transport only) |
| `POST /bridge/batch` | Ordered multi-tool batch against a single session |

All routes accept `Authorization: Bearer <token>` (or `x-turnkeyai-token: <token>`).
The token is auto-generated on first `daemon start` and stored in
`~/.turnkeyai/config.json`.

# Local Install And Control Center Runbook

## Purpose

This runbook covers the user-facing local entry point for TurnkeyAI: install or
link the CLI, start the daemon, open Control Center, and diagnose the most
common first-run failures. It is intended for source-checkout development,
packed CLI validation, and local operator testing.

## Recommended Entry

Use the app command whenever possible:

```bash
npx @turnkeyai/cli app
```

The command starts the daemon if needed, waits for `/health`, opens
`http://127.0.0.1:4100/app`, and includes the daemon token in the URL fragment
so the Control Center can authenticate without a manual paste.

From a source checkout on macOS, the lowest-friction first entry is the bundled
launcher:

```text
launchers/TurnkeyAI Mission Control.command
```

Open it from Finder. It uses the current checkout first, then falls back to an
installed `turnkeyai app`, then `npx @turnkeyai/cli app`.

For a global install:

```bash
npm install -g @turnkeyai/cli
turnkeyai app
turnkeyai app install-launcher
turnkeyai daemon status
```

For a source checkout where `turnkeyai` is not on `PATH`:

```bash
npm run install:local-cli
turnkeyai app
turnkeyai daemon status
```

If you do not want to change the global npm link, stay inside the checkout and
run:

```bash
npm run app -- --no-open
npm run daemon:status
npm run doctor
```

`npm run app -- --no-open` prints the authenticated Control Center URL. Use
that URL directly in a browser for SSH/headless environments.

`npm run doctor` includes an installed-CLI readiness check. If it reports that
`turnkeyai` is not on `PATH`, either run `npm run install:local-cli`, keep using
the source-checkout commands, or launch through `npx @turnkeyai/cli app`.

### Terminal Mission Workflow

The browser UI remains the recommended workbench. When a terminal is the right
entry point, use the TUI at the mission level instead of low-level thread
commands:

```bash
npm run tui
```

Useful mission commands:

```text
missions [limit]
mission <missionId>
mission-new <title> :: <prompt>
mission-use <missionId>
mission-send [missionId] <message>
```

`mission-new` creates a linked mission/runtime thread and starts execution.
`mission` shows mission health, quality gate status, the latest final answer,
and the recent timeline. `mission-send` sends a follow-up to the current mission
after `mission-use`, or to an explicit mission id.

After one successful CLI launch, install the double-click launcher:

```bash
turnkeyai app install-launcher
```

On macOS, this writes `TurnkeyAI Mission Control.command` to the Desktop when
the Desktop folder exists; otherwise it writes under `~/.turnkeyai`. Use
`--path <file>` to choose a different location.

## Daemon Lifecycle

```bash
turnkeyai daemon start
turnkeyai daemon status
turnkeyai daemon logs --follow
turnkeyai daemon restart
turnkeyai daemon stop
```

`daemon start` runs detached by default and writes:

| Path | Purpose |
| --- | --- |
| `~/.turnkeyai/config.json` | token, port, and local daemon config |
| `~/.turnkeyai/data/` | default data directory |
| `~/.turnkeyai/logs/daemon.log` | detached daemon log |
| `~/.turnkeyai/daemon.pid` | detached daemon PID file |

Use `TURNKEYAI_HOME`, `TURNKEYAI_DATA_DIR`, or `TURNKEYAI_DAEMON_PORT` to
isolate local experiments.

### macOS Service Mode

For a persistent local daemon that survives terminal windows, install the
LaunchAgent service:

```bash
turnkeyai daemon service install
turnkeyai daemon service status
```

This writes:

| Path | Purpose |
| --- | --- |
| `~/Library/LaunchAgents/com.turnkeyai.daemon.plist` | macOS LaunchAgent definition |
| `~/.turnkeyai/bin/daemon-service.sh` | wrapper that starts the packaged or source daemon |
| `~/.turnkeyai/daemon.env` | optional service-only environment file |

LaunchAgents do not inherit most shell startup environment. Put model keys,
browser transport settings, or CDP endpoints that the daemon needs into
`~/.turnkeyai/daemon.env` when they are not already available to the GUI
session. The file is created as `0600` and is sourced by the wrapper before the
daemon starts.

To restart an installed service after changing `daemon.env`, model catalogs, or
runtime configuration:

```bash
turnkeyai daemon service restart
turnkeyai daemon service status
```

To remove the service while preserving local data and `daemon.env`:

```bash
turnkeyai daemon service uninstall
```

## Auth Token Required

If the browser shows `Auth token required`, do not open a bare
`http://127.0.0.1:4100/app` URL by hand. Open through:

```bash
turnkeyai app
```

or:

```bash
npm run app -- --no-open
```

Those commands inject the token fragment expected by the Control Center. For
API clients, pass either:

```text
Authorization: Bearer <token>
```

or:

```text
x-turnkeyai-token: <token>
```

The local token is stored in `~/.turnkeyai/config.json` with private file
permissions.

## Browser Bridge Setup

Install or refresh the relay extension:

```bash
turnkeyai bridge install-extension
turnkeyai bridge status
```

Load `~/.turnkeyai/extensions/relay` through `chrome://extensions` with
Developer mode enabled. For direct-CDP validation, start Chrome with a remote
debugging endpoint and set:

```bash
export TURNKEYAI_BROWSER_TRANSPORT=direct-cdp
export TURNKEYAI_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
```

Run:

```bash
npm run cdp:smoke -- --timeout-ms 45000
```

Control Center shows the same browser setup surface in Settings. Use it to
check the active transport, direct-CDP expert lane availability, recent browser
runtime warnings, and the exact local validation commands before starting a
browser-backed mission. Runtime remains the operator page for live mission
health and logs; Settings is where setup problems should be diagnosed before
work begins.

## Model Readiness

Real LLM acceptance needs a model catalog and provider key:

```bash
npm run acceptance:real -- --model-catalog models.local.json --scenario-timeout-ms 240000 --cdp-timeout-ms 45000
```

`turnkeyai daemon status` and the Control Center Runtime page surface missing
model keys, failed real-LLM validation runs, and browser transport warnings.

## First-Run Diagnostics

| Symptom | Check |
| --- | --- |
| `turnkeyai: command not found` | Run `npm run doctor`, then `npm run install:local-cli`; or use `npm run app -- --no-open` / `npx @turnkeyai/cli app`. |
| `Auth token required` | Reopen through `turnkeyai app`; do not manually type the bare `/app` URL. |
| Control Center stuck creating a mission | Check `turnkeyai daemon status`, Runtime readiness, and `turnkeyai daemon logs --follow`. |
| Browser work fails immediately | Check `turnkeyai bridge status`, Chrome profile ownership, and `TURNKEYAI_BROWSER_TRANSPORT`. |
| Direct-CDP unavailable | Confirm `TURNKEYAI_BROWSER_CDP_ENDPOINT` and run `npm run cdp:smoke -- --timeout-ms 45000`. |
| Real LLM acceptance fails | Inspect the validation-ops run in Runtime, then rerun the smallest failing scenario. |

For release candidates, prefer the full real gate over ad hoc manual checks.
Manual Control Center testing is useful for UX regressions, but it should not
replace the mission/tool-use acceptance scripts.

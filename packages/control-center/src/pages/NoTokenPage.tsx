// Renders when state.token is null. User can paste a token; we treat
// the pasted token as scope=unknown (we can't introspect what the
// pasted bytes grant — same as PR I/J1 vanilla/React behavior).

import { useState, type FormEvent } from "react";

import { useAppState } from "../state/AppState";

export function NoTokenPage() {
  const { setToken } = useAppState();
  const [value, setValue] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setToken(trimmed);
  };

  return (
    <div className="page auth-page">
      <div className="human-page-head">
        <div>
          <h2>Auth token required</h2>
          <p>The launcher starts the local service and opens this app with access already attached.</p>
        </div>
      </div>

      <section className="auth-card">
        <div>
          <h3>Recommended</h3>
          <p>Use the local launcher so TurnkeyAI can connect automatically.</p>
          <div className="launch-command-list" aria-label="Recommended launch commands">
            <LaunchCommand
              label="Bundled launcher"
              command="launchers/TurnkeyAI Mission Control.command"
              note="Open this from Finder in a source checkout."
            />
            <LaunchCommand
              label="No install"
              command="npx @turnkeyai/cli app"
              note="Starts TurnkeyAI without installing the command globally."
            />
            <LaunchCommand
              label="Source checkout"
              command="npm run app -- --no-open"
              note="Run this from the repository root. It prints a ready-to-open URL."
            />
            <LaunchCommand
              label="Installed app"
              command="turnkeyai app"
              note="Use this after installing or linking the TurnkeyAI command."
            />
          </div>
        </div>
        <div>
          <h3>Paste access token</h3>
          <p>If you already have the local token, paste it here. It stays in this browser tab.</p>
          <form
            onSubmit={handleSubmit}
            className="auth-token-form"
          >
            <label className="sr-only" htmlFor="token-input">
              Local access token
            </label>
            <input
              id="token-input"
              className="field"
              type="password"
              autoComplete="off"
              required
              placeholder="Local access token"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <button type="submit" className="btn primary">
              Continue
            </button>
          </form>
        </div>
      </section>

      <details className="settings-advanced auth-advanced">
        <summary>Developer launch options</summary>
        <div className="launch-command-list" aria-label="Developer launch commands">
          <LaunchCommand
            label="Install launcher"
            command="npm run app:install-launcher"
            note="Installs a double-click launcher from the repository root."
          />
          <LaunchCommand
            label="Keep service running"
            command="turnkeyai daemon service install"
            note="On macOS, installs the local service as a LaunchAgent."
          />
          <LaunchCommand
            label="Restart service"
            command="turnkeyai daemon service restart"
            note="Use after editing local config or model settings."
          />
        </div>
      </details>
    </div>
  );
}

function LaunchCommand({
  label,
  command,
  note,
}: {
  label: string;
  command: string;
  note: string;
}) {
  return (
    <div className="launch-command">
      <div className="launch-command-head">
        <span className="label">{label}</span>
        <code>{command}</code>
      </div>
      <div className="muted">{note}</div>
    </div>
  );
}

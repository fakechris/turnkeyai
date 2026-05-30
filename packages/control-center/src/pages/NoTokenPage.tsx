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
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <h2>Auth token required</h2>
          <div className="sub">
            Mission Control talks to the daemon as a real client and needs the daemon's auth token.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-bd" style={{ padding: 20 }}>
          <p style={{ marginTop: 0 }}>Open Mission Control through one of these entry points:</p>
          <div className="launch-command-list" aria-label="Mission Control launch commands">
            <LaunchCommand
              label="Bundled launcher"
              command="launchers/TurnkeyAI Mission Control.command"
              note="Open this file from Finder in a source checkout; it starts the app with the local daemon token."
            />
            <LaunchCommand
              label="Double-click launcher"
              command="npm run app:install-launcher"
              note="Use this from the repository root to install a local Mission Control launcher."
            />
            <LaunchCommand
              label="Installed CLI"
              command="turnkeyai app"
              note="Use this after installing or linking the TurnkeyAI CLI."
            />
            <LaunchCommand
              label="Link local CLI"
              command="npm run install:local-cli"
              note="Use this from the repository root if the turnkeyai command is not on PATH."
            />
            <LaunchCommand
              label="No install"
              command="npx @turnkeyai/cli app"
              note="Use this from any shell when the turnkeyai command is not on PATH."
            />
            <LaunchCommand
              label="Source checkout"
              command="npm run app -- --no-open"
              note="Use this from the repository root; it prints the tokenized URL."
            />
          </div>
          <p>
            These commands start the daemon if needed and open this page with the token already
            attached to the URL fragment.
          </p>
          <p>If you already have a token, paste it below — it's kept only in this browser tab.</p>
          <form
            onSubmit={handleSubmit}
            style={{ display: "flex", gap: 8, margin: "16px 0" }}
          >
            <label className="sr-only" htmlFor="token-input">
              Daemon token
            </label>
            <input
              id="token-input"
              className="field"
              type="password"
              autoComplete="off"
              required
              placeholder="Daemon token"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn primary">
              Use token
            </button>
          </form>
          <p className="note">
            Token is read from <code>~/.turnkeyai/config.json</code> by the launcher.{" "}
            Check access with <code>turnkeyai daemon status</code>,{" "}
            <code>npx @turnkeyai/cli daemon status</code>, or <code>npm run daemon:status</code>{" "}
            from a source checkout.
          </p>
        </div>
      </div>
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

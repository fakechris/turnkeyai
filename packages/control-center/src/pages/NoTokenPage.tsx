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
          <p style={{ marginTop: 0 }}>The recommended way to launch is:</p>
          <pre
            className="mono"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              padding: 14,
              margin: "8px 0",
              fontSize: 13,
            }}
          >
            turnkeyai app
          </pre>
          <p>
            That command starts the daemon if needed and opens this page with the token already
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
            Token is read from <code>~/.turnkeyai/config.json</code> by the CLI. It is also visible
            in <code>turnkeyai daemon status</code> output.
          </p>
        </div>
      </div>
    </div>
  );
}

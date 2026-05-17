import { useState, type FormEvent } from "react";

import { useAppState } from "../state/AppState";

/**
 * Renders when state.token is null. User can paste a token; we treat
 * the pasted token as scope=unknown (we can't introspect what the
 * pasted bytes grant — same as PR I's vanilla behavior).
 */
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
    <section className="page-section">
      <h1>Auth token required</h1>
      <p>
        This Control Center talks to the daemon as a real client and needs the daemon's auth token.
        The recommended way to launch it is:
      </p>
      <pre className="snippet">turnkeyai app</pre>
      <p>
        That command starts the daemon if needed and opens this page with the token already
        attached to the URL fragment.
      </p>
      <p>If you already have a token, paste it below — it's kept only in this browser tab.</p>
      <form className="token-form" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="token-input">
          Daemon token
        </label>
        <input
          id="token-input"
          className="token-input"
          type="password"
          autoComplete="off"
          required
          placeholder="Daemon token"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit">Use token</button>
      </form>
      <p className="note">
        Token is read from <code>~/.turnkeyai/config.json</code> by the CLI. It is also visible in{" "}
        <code>turnkeyai daemon status</code> output.
      </p>
    </section>
  );
}

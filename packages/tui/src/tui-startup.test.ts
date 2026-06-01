import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildTuiStartupSnapshot,
  formatTuiStartup,
} from "./tui-startup";

describe("tui-startup", () => {
  it("formats a healthy mission workbench startup preflight", async () => {
    const snapshot = await buildTuiStartupSnapshot({
      baseUrl: "http://127.0.0.1:4100",
      token: { token: "op-token", scope: "operator", source: "env" },
      fetchImpl: fakeFetch({
        "/health": json({ ok: true }),
        "/bridge/status": json({ ok: true }),
        "/models": json({
          defaultSelection: {
            ok: true,
            chainId: "lead_reasoning",
            primaryModelId: "primary",
            fallbackModelIds: [],
          },
          models: [{ id: "primary", configured: true, apiKeyEnv: "PRIMARY_API_KEY" }],
        }),
        "/diagnostics": json({
          readiness: {
            checks: [
              { label: "Model catalog", status: "ok", detail: "ready" },
              { label: "Browser transport", status: "ok", detail: "local bridge ready" },
            ],
          },
        }),
      }),
    });

    assert.deepEqual(snapshot.checks.map((check) => check.status), ["ok", "ok", "ok", "ok"]);
    assert.match(formatTuiStartup(snapshot).join("\n"), /TurnkeyAI Mission Workbench TUI/);
    assert.match(formatTuiStartup(snapshot).join("\n"), /model readiness\s+lead_reasoning: primary ready/);
    assert.match(formatTuiStartup(snapshot).join("\n"), /browser readiness\s+1 browser transport check\(s\) ok/);
  });

  it("surfaces auth, model, and browser readiness failures before the first command", async () => {
    const snapshot = await buildTuiStartupSnapshot({
      baseUrl: "http://127.0.0.1:4100",
      token: { token: "bad-token", scope: "unknown", source: "config" },
      fetchImpl: fakeFetch({
        "/health": json({ ok: true }),
        "/bridge/status": new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      }),
    });

    const output = formatTuiStartup(snapshot).join("\n");
    assert.match(output, /\[fail\] daemon api auth\s+\/bridge\/status returned HTTP 401/);
    assert.match(output, /\[warn\] model readiness\s+skipped because daemon API auth failed/);
    assert.match(output, /\[warn\] browser readiness\s+skipped because daemon API auth failed/);
    assert.match(output, /diagnostics: npm run doctor/);
  });

  it("reports browser transport readiness details from diagnostics", async () => {
    const snapshot = await buildTuiStartupSnapshot({
      baseUrl: "http://127.0.0.1:4100",
      token: { token: "op-token", scope: "operator", source: "env" },
      fetchImpl: fakeFetch({
        "/health": json({ ok: true }),
        "/bridge/status": json({ ok: true }),
        "/models": json({
          defaultSelection: { ok: true, primaryModelId: "primary" },
          models: [{ id: "primary", configured: true }],
        }),
        "/diagnostics": json({
          readiness: {
            checks: [
              {
                label: "Browser transport",
                status: "error",
                detail: "Direct CDP endpoint is unreachable.",
                action: "Set TURNKEYAI_BROWSER_CDP_ENDPOINT.",
              },
            ],
          },
        }),
      }),
    });

    const browser = snapshot.checks.find((check) => check.name === "browser readiness");
    assert.equal(browser?.status, "fail");
    assert.match(browser?.detail ?? "", /Direct CDP endpoint is unreachable/);
    assert.match(browser?.detail ?? "", /TURNKEYAI_BROWSER_CDP_ENDPOINT/);
  });

  it("does not hide the web app fallback when no token is configured", async () => {
    const snapshot = await buildTuiStartupSnapshot({
      baseUrl: "http://127.0.0.1:4100",
      token: null,
      fetchImpl: fakeFetch({ "/health": json({ ok: true }) }),
    });

    const output = formatTuiStartup(snapshot).join("\n");
    assert.match(output, /auth: none/);
    assert.match(output, /no daemon token configured/);
    assert.match(output, /web workbench: npm run app -- --no-open/);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(responses: Record<string, Response>): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const response = responses[url.pathname];
    if (!response) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return response.clone();
  };
}

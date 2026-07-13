import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDesktopDashboardUrl,
  isAllowedDesktopNavigation,
  isMatchingDaemonHealth,
  resolveDesktopConnection,
  resolveDesktopToken,
  resolveRuntimeEntry,
} from "./desktop-runtime";

describe("desktop runtime configuration", () => {
  it("uses the configured daemon port and operator token", () => {
    const connection = resolveDesktopConnection(
      {
        TURNKEYAI_DAEMON_OPERATOR_TOKEN: " operator-token ",
      },
      { port: 4310, token: "legacy-token" }
    );

    assert.deepEqual(connection, {
      baseUrl: "http://127.0.0.1:4310",
      token: "operator-token",
      scope: "operator",
      externallyManaged: false,
    });
  });

  it("honors an externally managed daemon URL and trims its trailing slash", () => {
    const connection = resolveDesktopConnection(
      {
        TURNKEYAI_DAEMON_URL: " http://127.0.0.1:5100/ ",
        TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
      },
      null
    );

    assert.deepEqual(connection, {
      baseUrl: "http://127.0.0.1:5100",
      token: "read-token",
      scope: "read",
      externallyManaged: true,
    });
  });

  it("rejects unsafe daemon protocols", () => {
    assert.throws(
      () => resolveDesktopConnection({ TURNKEYAI_DAEMON_URL: "file:///tmp/app" }, null),
      /must use http or https/
    );
    assert.throws(
      () => resolveDesktopConnection({ TURNKEYAI_DAEMON_URL: "https://example.com" }, null),
      /must use the daemon bind address 127\.0\.0\.1/
    );
    assert.throws(
      () => resolveDesktopConnection({ TURNKEYAI_DAEMON_URL: "http://localhost:4100" }, null),
      /must use the daemon bind address 127\.0\.0\.1/
    );
    assert.throws(
      () => resolveDesktopConnection({ TURNKEYAI_DAEMON_URL: "http:\/\/[::1]:4100" }, null),
      /must use the daemon bind address 127\.0\.0\.1/
    );
  });

  it("keeps the CLI token precedence and falls back to config", () => {
    assert.deepEqual(
      resolveDesktopToken(
        {
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator",
          TURNKEYAI_DAEMON_TOKEN: "legacy",
          TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin",
          TURNKEYAI_DAEMON_READ_TOKEN: "read",
        },
        "config"
      ),
      { token: "operator", scope: "operator" }
    );
    assert.deepEqual(resolveDesktopToken({}, "config"), {
      token: "config",
      scope: "unknown",
    });
  });

  it("encodes the token in the dashboard fragment", () => {
    assert.equal(
      buildDesktopDashboardUrl("http://127.0.0.1:4100", "a+b=c&d", "unknown"),
      "http://127.0.0.1:4100/app#token=a%2Bb%3Dc%26d&scope=unknown&route=missions"
    );
  });

  it("only keeps same-origin app navigation inside Electron", () => {
    const baseUrl = "http://127.0.0.1:4100";
    assert.equal(isAllowedDesktopNavigation("http://127.0.0.1:4100/app#/missions", baseUrl), true);
    assert.equal(isAllowedDesktopNavigation("http://127.0.0.1:4100/app/assets/app.js", baseUrl), true);
    assert.equal(isAllowedDesktopNavigation("http://127.0.0.1:4100/health", baseUrl), false);
    assert.equal(isAllowedDesktopNavigation("https://example.com/app", baseUrl), false);
  });

  it("requires the TurnkeyAI health shape for the connected port", () => {
    assert.equal(
      isMatchingDaemonHealth({ ok: true, port: 4100 }, "http://127.0.0.1:4100"),
      true
    );
    assert.equal(
      isMatchingDaemonHealth({ ok: true, port: 5100 }, "http://127.0.0.1:4100"),
      false
    );
    assert.equal(isMatchingDaemonHealth({ status: "ok" }, "http://127.0.0.1:4100"), false);
  });

  it("resolves the bundled daemon next to dev output or in packaged resources", () => {
    assert.equal(
      resolveRuntimeEntry({ packaged: false, moduleDir: "/repo/packages/desktop/dist/app", resourcesPath: "/ignored" }),
      "/repo/packages/desktop/dist/runtime/daemon.js"
    );
    assert.equal(
      resolveRuntimeEntry({ packaged: true, moduleDir: "/ignored", resourcesPath: "/Applications/TurnkeyAI.app/Contents/Resources" }),
      "/Applications/TurnkeyAI.app/Contents/Resources/runtime/daemon.js"
    );
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveDaemonCliToken } from "./daemon-token";

describe("resolveDaemonCliToken", () => {
  it("prefers operator token over legacy token", () => {
    assert.deepEqual(
      resolveDaemonCliToken(
        {
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: " operator ",
          TURNKEYAI_DAEMON_TOKEN: "legacy",
        },
        null
      ),
      { token: "operator", scope: "operator", source: "env" }
    );
  });

  it("uses legacy token when no operator token is set", () => {
    assert.deepEqual(resolveDaemonCliToken({ TURNKEYAI_DAEMON_TOKEN: "legacy" }, null), {
      token: "legacy",
      scope: "unknown",
      source: "env",
    });
  });

  it("falls through to admin, read, and config tokens", () => {
    assert.deepEqual(resolveDaemonCliToken({ TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin" }, null), {
      token: "admin",
      scope: "admin",
      source: "env",
    });
    assert.deepEqual(resolveDaemonCliToken({ TURNKEYAI_DAEMON_READ_TOKEN: "read" }, null), {
      token: "read",
      scope: "read",
      source: "env",
    });
    assert.deepEqual(resolveDaemonCliToken({}, "config-token"), {
      token: "config-token",
      scope: "unknown",
      source: "config",
    });
  });

  it("ignores blank token values", () => {
    assert.deepEqual(
      resolveDaemonCliToken(
        {
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "  ",
          TURNKEYAI_DAEMON_READ_TOKEN: "read",
        },
        "config-token"
      ),
      { token: "read", scope: "read", source: "env" }
    );
  });

  it("ignores non-string config token values", () => {
    assert.equal(resolveDaemonCliToken({}, 123), null);
    assert.equal(resolveDaemonCliToken({}, { token: "nested" }), null);
  });

  it("prefers read token for read-only callers", () => {
    assert.deepEqual(
      resolveDaemonCliToken(
        {
          TURNKEYAI_DAEMON_READ_TOKEN: "read",
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator",
          TURNKEYAI_DAEMON_TOKEN: "legacy",
        },
        "config-token",
        "read"
      ),
      { token: "read", scope: "read", source: "env" }
    );
  });

  it("does not use read tokens for operator or admin callers", () => {
    assert.deepEqual(
      resolveDaemonCliToken(
        {
          TURNKEYAI_DAEMON_READ_TOKEN: "read",
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator",
        },
        null,
        "operator"
      ),
      { token: "operator", scope: "operator", source: "env" }
    );
    assert.equal(resolveDaemonCliToken({ TURNKEYAI_DAEMON_READ_TOKEN: "read" }, null, "admin"), null);
  });
});

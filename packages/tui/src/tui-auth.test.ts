import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTuiRequestHeaders, resolveTuiToken } from "./tui-auth";

describe("tui-auth", () => {
  it("prefers operator over broader and narrower env tokens", () => {
    const token = resolveTuiToken(
      {
        TURNKEYAI_DAEMON_OPERATOR_TOKEN: " op ",
        TURNKEYAI_DAEMON_TOKEN: "legacy",
        TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin",
        TURNKEYAI_DAEMON_READ_TOKEN: "read",
      },
      null
    );

    assert.deepEqual(token, { token: "op", scope: "operator", source: "env" });
  });

  it("falls back through legacy, admin, read, then config token", () => {
    assert.deepEqual(resolveTuiToken({ TURNKEYAI_DAEMON_TOKEN: "legacy" }, null), {
      token: "legacy",
      scope: "unknown",
      source: "env",
    });
    assert.deepEqual(resolveTuiToken({ TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin" }, null), {
      token: "admin",
      scope: "admin",
      source: "env",
    });
    assert.deepEqual(resolveTuiToken({ TURNKEYAI_DAEMON_READ_TOKEN: "read" }, null), {
      token: "read",
      scope: "read",
      source: "env",
    });
    assert.deepEqual(resolveTuiToken({}, "config"), {
      token: "config",
      scope: "unknown",
      source: "config",
    });
  });

  it("builds bearer headers without dropping caller headers", () => {
    const headers = buildTuiRequestHeaders(
      { token: "op", scope: "operator", source: "env" },
      { "content-type": "application/json" }
    );

    assert.deepEqual(headers, {
      "content-type": "application/json",
      authorization: "Bearer op",
    });
  });

  it("returns caller headers unchanged when no token exists", () => {
    assert.deepEqual(buildTuiRequestHeaders(null, { accept: "application/json" }), {
      accept: "application/json",
    });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDashboardUrl,
  parseAppRoute,
  resolveAppToken,
} from "./app-command";

describe("app-command", () => {
  describe("resolveAppToken", () => {
    it("returns null when nothing is configured", () => {
      assert.equal(resolveAppToken({}, null), null);
    });

    it("prefers legacy TURNKEYAI_DAEMON_TOKEN with scope 'unknown'", () => {
      const r = resolveAppToken(
        {
          TURNKEYAI_DAEMON_TOKEN: " legacy ",
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "op",
        },
        null
      );
      assert.deepEqual(r, { token: "legacy", scope: "unknown", source: "env" });
    });

    it("prefers operator over admin over read (PR I priority)", () => {
      const r = resolveAppToken(
        {
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "op",
          TURNKEYAI_DAEMON_ADMIN_TOKEN: "ad",
          TURNKEYAI_DAEMON_READ_TOKEN: "rd",
        },
        null
      );
      assert.deepEqual(r, { token: "op", scope: "operator", source: "env" });
    });

    it("falls through to admin when no operator token is set", () => {
      const r = resolveAppToken(
        { TURNKEYAI_DAEMON_ADMIN_TOKEN: "ad", TURNKEYAI_DAEMON_READ_TOKEN: "rd" },
        null
      );
      assert.deepEqual(r, { token: "ad", scope: "admin", source: "env" });
    });

    it("returns read scope as the last env-var resort", () => {
      const r = resolveAppToken({ TURNKEYAI_DAEMON_READ_TOKEN: "rd" }, null);
      assert.deepEqual(r, { token: "rd", scope: "read", source: "env" });
    });

    it("falls back to config token with scope 'unknown'", () => {
      const r = resolveAppToken({}, "from-config");
      assert.deepEqual(r, { token: "from-config", scope: "unknown", source: "config" });
    });

    it("ignores empty strings and whitespace-only env vars", () => {
      const r = resolveAppToken(
        {
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "   ",
          TURNKEYAI_DAEMON_READ_TOKEN: "rd",
        },
        null
      );
      assert.deepEqual(r, { token: "rd", scope: "read", source: "env" });
    });
  });

  describe("buildDashboardUrl", () => {
    it("emits token + scope + route in the URL fragment", () => {
      const url = buildDashboardUrl("http://127.0.0.1:4100", "abc", "operator", "tabs");
      assert.equal(url, "http://127.0.0.1:4100/app#token=abc&scope=operator&route=tabs");
    });

    it("URL-encodes token characters that would otherwise break fragment parsing", () => {
      const url = buildDashboardUrl("http://127.0.0.1:4100", "a+b=c&d", "read", "setup");
      // & inside the token must be encoded so the dashboard's
      // URLSearchParams parser doesn't split it as a fragment separator.
      assert.equal(
        url,
        "http://127.0.0.1:4100/app#token=a%2Bb%3Dc%26d&scope=read&route=setup"
      );
    });

    it("omits token + scope when null but still includes route", () => {
      const url = buildDashboardUrl("http://127.0.0.1:4100", null, null, "diagnostics");
      assert.equal(url, "http://127.0.0.1:4100/app#route=diagnostics");
    });
  });

  describe("parseAppRoute", () => {
    it("defaults to setup when no --route is present", () => {
      assert.equal(parseAppRoute([]), "setup");
      assert.equal(parseAppRoute(["--no-open"]), "setup");
    });

    it("accepts --route <name> form", () => {
      assert.equal(parseAppRoute(["--route", "bridge"]), "bridge");
      assert.equal(parseAppRoute(["--route", "tabs"]), "tabs");
      assert.equal(parseAppRoute(["--route", "diagnostics"]), "diagnostics");
    });

    it("accepts --route=name form", () => {
      assert.equal(parseAppRoute(["--route=agent"]), "agent");
    });

    it("rejects unknown route names by falling back to setup", () => {
      assert.equal(parseAppRoute(["--route", "evil"]), "setup");
      assert.equal(parseAppRoute(["--route=../etc/passwd"]), "setup");
    });

    it("ignores --route when the next arg is missing", () => {
      assert.equal(parseAppRoute(["--route"]), "setup");
    });
  });
});

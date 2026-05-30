import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildAppLauncherScript,
  buildDashboardUrl,
  parseAppRoute,
  resolveDefaultAppLauncherPath,
  resolveAppToken,
  resolveSourceCheckoutDir,
} from "./app-command";

describe("app-command", () => {
  describe("resolveAppToken", () => {
    it("returns null when nothing is configured", () => {
      assert.equal(resolveAppToken({}, null), null);
    });

    it("prefers OPERATOR over legacy TURNKEYAI_DAEMON_TOKEN (mixed-migration case)", () => {
      // Codex PR I round-2: if a user has a legacy admin TURNKEYAI_DAEMON_TOKEN
      // set from an earlier setup and then adds the operator-scoped layered
      // token, the operator-scoped token should win. The explicit narrower
      // choice beats the older broader one. Otherwise the dashboard would
      // hand admin tokens to agents that only need operator.
      const r = resolveAppToken(
        {
          TURNKEYAI_DAEMON_TOKEN: " legacy ",
          TURNKEYAI_DAEMON_OPERATOR_TOKEN: "op",
        },
        null
      );
      assert.deepEqual(r, { token: "op", scope: "operator", source: "env" });
    });

    it("falls back to legacy TURNKEYAI_DAEMON_TOKEN when no operator token is set", () => {
      const r = resolveAppToken({ TURNKEYAI_DAEMON_TOKEN: "legacy-only" }, null);
      assert.deepEqual(r, { token: "legacy-only", scope: "unknown", source: "env" });
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
      const url = buildDashboardUrl("http://127.0.0.1:4100", "abc", "operator", "agents");
      assert.equal(url, "http://127.0.0.1:4100/app#token=abc&scope=operator&route=agents");
    });

    it("URL-encodes token characters that would otherwise break fragment parsing", () => {
      const url = buildDashboardUrl("http://127.0.0.1:4100", "a+b=c&d", "read", "missions");
      // & inside the token must be encoded so the dashboard's
      // URLSearchParams parser doesn't split it as a fragment separator.
      assert.equal(
        url,
        "http://127.0.0.1:4100/app#token=a%2Bb%3Dc%26d&scope=read&route=missions"
      );
    });

    it("omits token + scope when null but still includes route", () => {
      const url = buildDashboardUrl("http://127.0.0.1:4100", null, null, "runtime");
      assert.equal(url, "http://127.0.0.1:4100/app#route=runtime");
    });
  });

  describe("parseAppRoute", () => {
    // K1 IA plus first-run onboarding: routes match the Mission Control shell
    // (onboarding/missions/approvals/agents/context/agent-connect/runtime/settings). The old PR F→I routes
    // (setup/bridge/tabs/diagnostics) folded into those, so they're
    // rejected back to the new default ("missions").
    it("defaults to missions when no --route is present", () => {
      assert.equal(parseAppRoute([]), "missions");
      assert.equal(parseAppRoute(["--no-open"]), "missions");
    });

    it("accepts --route <name> form for K1 routes", () => {
      assert.equal(parseAppRoute(["--route", "onboarding"]), "onboarding");
      assert.equal(parseAppRoute(["--route", "missions"]), "missions");
      assert.equal(parseAppRoute(["--route", "approvals"]), "approvals");
      assert.equal(parseAppRoute(["--route", "runtime"]), "runtime");
      assert.equal(parseAppRoute(["--route", "settings"]), "settings");
    });

    it("accepts --route=name form", () => {
      assert.equal(parseAppRoute(["--route=context"]), "context");
      assert.equal(parseAppRoute(["--route=agent-connect"]), "agent-connect");
    });

    it("normalizes the short `agent` alias to `agent-connect`", () => {
      // PR I help text used "agent" for the Agent Connect page; preserve
      // the alias so old muscle-memory keeps working.
      assert.equal(parseAppRoute(["--route", "agent"]), "agent-connect");
      assert.equal(parseAppRoute(["--route=agent"]), "agent-connect");
    });

    it("rejects old PR F→I route names (Mission Control no longer has them)", () => {
      assert.equal(parseAppRoute(["--route", "setup"]), "missions");
      assert.equal(parseAppRoute(["--route", "bridge"]), "missions");
      assert.equal(parseAppRoute(["--route", "tabs"]), "missions");
      assert.equal(parseAppRoute(["--route", "diagnostics"]), "missions");
    });

    it("rejects unknown route names by falling back to missions", () => {
      assert.equal(parseAppRoute(["--route", "evil"]), "missions");
      assert.equal(parseAppRoute(["--route=../etc/passwd"]), "missions");
    });

    it("ignores --route when the next arg is missing", () => {
      assert.equal(parseAppRoute(["--route"]), "missions");
    });
  });

  describe("local app launcher", () => {
    it("builds a portable launcher that prefers the installed turnkeyai command", () => {
      const script = buildAppLauncherScript();
      assert.match(script, /^#!\/usr\/bin\/env sh/);
      assert.match(script, /command -v turnkeyai/);
      assert.match(script, /exec turnkeyai app "\$@"/);
      assert.match(script, /exec npx @turnkeyai\/cli app "\$@"/);
    });

    it("can pin the launcher to a source checkout before installed fallbacks", () => {
      const script = buildAppLauncherScript({ sourceCheckoutDir: "/Users/alice/Turnkey AI" });
      assert.match(script, /exec turnkeyai app "\$@"/);
      assert.match(script, /npm --prefix '\/Users\/alice\/Turnkey AI' run app -- "\$@"/);
      assert.match(script, /exec npx @turnkeyai\/cli app "\$@"/);
      assert.ok(
        script.indexOf("exec npm --prefix") < script.indexOf("exec turnkeyai app"),
        "source-pinned launchers should not be shadowed by an older global CLI"
      );
    });

    it("recognizes a TurnkeyAI source checkout", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "turnkeyai-source-checkout-"));
      try {
        await mkdir(path.join(dir, "packages", "cli", "src"), { recursive: true });
        await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "turnkeyai" }), "utf8");
        await writeFile(path.join(dir, "packages", "cli", "src", "cli.ts"), "", "utf8");
        assert.equal(resolveSourceCheckoutDir(dir), dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("does not pin launchers to unrelated package directories", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "turnkeyai-unrelated-checkout-"));
      try {
        await mkdir(path.join(dir, "packages", "cli", "src"), { recursive: true });
        await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "other" }), "utf8");
        await writeFile(path.join(dir, "packages", "cli", "src", "cli.ts"), "", "utf8");
        assert.equal(resolveSourceCheckoutDir(dir), null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("defaults to a macOS Desktop launcher when Desktop exists", () => {
      assert.equal(
        resolveDefaultAppLauncherPath({
          homeDir: "/Users/alice",
          platformName: "darwin",
          desktopExists: true,
        }),
        "/Users/alice/Desktop/TurnkeyAI Mission Control.command"
      );
    });

    it("falls back under ~/.turnkeyai when no Desktop exists", () => {
      assert.equal(
        resolveDefaultAppLauncherPath({
          homeDir: "/Users/alice",
          platformName: "darwin",
          desktopExists: false,
        }),
        "/Users/alice/.turnkeyai/TurnkeyAI Mission Control.command"
      );
    });

    it("uses a shell launcher outside macOS", () => {
      assert.equal(
        resolveDefaultAppLauncherPath({
          homeDir: "/home/alice",
          platformName: "linux",
          desktopExists: true,
        }),
        "/home/alice/.turnkeyai/turnkeyai-mission-control.sh"
      );
    });
  });
});

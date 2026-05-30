import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDaemonServiceScript,
  buildMacLaunchAgentPlist,
  isTransientLaunchctlBootstrapError,
  resolveDaemonLaunchCommand,
  resolveDaemonWorkingDirectory,
} from "./daemon-commands";

describe("resolveDaemonLaunchCommand", () => {
  it("uses packaged dist/daemon.js when it exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "turnkeyai-cli-launch-packaged-"));
    try {
      const distDir = path.join(root, "packages", "cli", "dist");
      await mkdir(distDir, { recursive: true });
      const daemonJs = path.join(distDir, "daemon.js");
      await writeFile(daemonJs, "", "utf8");

      assert.deepEqual(resolveDaemonLaunchCommand(distDir), {
        executable: process.execPath,
        args: [daemonJs],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses tsx + app-gateway daemon.ts in a source checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "turnkeyai-cli-launch-source-"));
    try {
      const cliSrcDir = path.join(root, "packages", "cli", "src");
      const appGatewaySrcDir = path.join(root, "packages", "app-gateway", "src");
      await mkdir(cliSrcDir, { recursive: true });
      await mkdir(appGatewaySrcDir, { recursive: true });
      const daemonTs = path.join(appGatewaySrcDir, "daemon.ts");
      await writeFile(daemonTs, "", "utf8");

      assert.deepEqual(resolveDaemonLaunchCommand(cliSrcDir), {
        executable: process.execPath,
        args: ["--import", "tsx", daemonTs],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("daemon service artifacts", () => {
  it("builds a macOS LaunchAgent that runs the service wrapper", () => {
    const plist = buildMacLaunchAgentPlist({
      label: "com.turnkeyai.daemon",
      wrapperFile: "/Users/alice/.turnkeyai/bin/daemon-service.sh",
      workingDirectory: "/Users/alice/workspace/turnkeyai",
      stdoutPath: "/Users/alice/.turnkeyai/logs/daemon.log",
      stderrPath: "/Users/alice/.turnkeyai/logs/daemon.log",
      environment: {
        TURNKEYAI_HOME: "/Users/alice/.turnkeyai",
        TURNKEYAI_MODEL_CATALOG: "/Users/alice/models.local.json",
        TURNKEYAI_BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222",
        EMPTY_VALUE: "",
      },
    });

    assert.match(plist, /<key>Label<\/key>\n  <string>com\.turnkeyai\.daemon<\/string>/);
    assert.match(plist, /<string>\/Users\/alice\/\.turnkeyai\/bin\/daemon-service\.sh<\/string>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>\n  <string>\/Users\/alice\/workspace\/turnkeyai<\/string>/);
    assert.match(plist, /<key>TURNKEYAI_HOME<\/key>/);
    assert.match(plist, /<key>TURNKEYAI_MODEL_CATALOG<\/key>/);
    assert.match(plist, /<key>TURNKEYAI_BROWSER_CDP_ENDPOINT<\/key>/);
    assert.doesNotMatch(plist, /EMPTY_VALUE/);
    assert.match(plist, /<key>KeepAlive<\/key>\n  <true\/>/);
  });

  it("escapes plist XML values", () => {
    const plist = buildMacLaunchAgentPlist({
      label: "com.turnkeyai.daemon",
      wrapperFile: "/tmp/a&b/daemon-service.sh",
      workingDirectory: "/tmp/turnkey <root>",
      stdoutPath: "/tmp/log\"file",
      stderrPath: "/tmp/log'file",
    });

    assert.match(plist, /\/tmp\/a&amp;b\/daemon-service\.sh/);
    assert.match(plist, /\/tmp\/turnkey &lt;root&gt;/);
    assert.match(plist, /\/tmp\/log&quot;file/);
    assert.match(plist, /\/tmp\/log&apos;file/);
  });

  it("builds a service wrapper that sources daemon.env before exec", () => {
    const script = buildDaemonServiceScript({
      launch: {
        executable: "/Users/alice/.nvm/versions/node/v24.13.0/bin/node",
        args: ["--import", "tsx", "/Users/alice/workspace/turnkeyai/packages/app-gateway/src/daemon.ts"],
      },
      envFile: "/Users/alice/.turnkeyai/daemon.env",
    });

    assert.match(script, /^#!\/usr\/bin\/env sh/);
    assert.match(script, /ENV_FILE=\/Users\/alice\/\.turnkeyai\/daemon\.env/);
    assert.match(script, /\. "\$ENV_FILE"/);
    assert.match(script, /exec \/Users\/alice\/\.nvm\/versions\/node\/v24\.13\.0\/bin\/node --import tsx \/Users\/alice\/workspace\/turnkeyai\/packages\/app-gateway\/src\/daemon\.ts/);
  });

  it("resolves source-checkout working directory from daemon.ts", () => {
    assert.equal(
      resolveDaemonWorkingDirectory(
        {
          executable: process.execPath,
          args: ["--import", "tsx", "/Users/alice/workspace/turnkeyai/packages/app-gateway/src/daemon.ts"],
        },
        "/tmp"
      ),
      "/Users/alice/workspace/turnkeyai"
    );
  });

  it("resolves packaged working directory from daemon.js", () => {
    assert.equal(
      resolveDaemonWorkingDirectory(
        {
          executable: process.execPath,
          args: ["/opt/turnkeyai/dist/daemon.js"],
        },
        "/tmp"
      ),
      "/opt/turnkeyai/dist"
    );
  });

  it("classifies launchd bootstrap handoff errors as retryable", () => {
    assert.equal(
      isTransientLaunchctlBootstrapError(new Error("Bootstrap failed: 5: Input/output error")),
      true
    );
    assert.equal(isTransientLaunchctlBootstrapError(new Error("service already loaded")), false);
  });
});

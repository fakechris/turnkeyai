import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveDaemonLaunchCommand } from "./daemon-commands";

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

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("cli help", () => {
  it("documents the source-tree app launcher and current app routes", async () => {
    const result = await runCliHelp(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /turnkeyai app \[--route onboarding\|missions\|approvals\|agents\|context\|agent-connect\|runtime\|settings\]/);
    assert.match(result.stdout, /turnkeyai app install-launcher \[--path <file>\]/);
    assert.match(result.stdout, /npm run app:install-launcher/);
    assert.match(result.stdout, /npm run app -- --no-open/);
    assert.match(result.stdout, /npm run daemon:status/);
    assert.doesNotMatch(result.stdout, /--route setup\|bridge\|agent/);
  });

  it("documents the real token resolution order in app help", async () => {
    const result = await runCliHelp(["app", "--help"]);
    assert.equal(result.code, 0);
    const lines = result.stdout.split("\n");
    const operatorLine = lines.findIndex((line) =>
      line.trimStart().startsWith("TURNKEYAI_DAEMON_OPERATOR_TOKEN")
    );
    const legacyLine = lines.findIndex((line) =>
      line.trimStart().startsWith("TURNKEYAI_DAEMON_TOKEN ")
    );
    assert.ok(operatorLine >= 0, "operator token must be documented");
    assert.ok(legacyLine >= 0, "legacy token must be documented");
    assert.ok(operatorLine < legacyLine, "operator token should be documented before legacy token");
  });

  it("documents the local launcher installer in app help", async () => {
    const result = await runCliHelp(["app", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /turnkeyai app install-launcher \[--path <file>\]/);
  });

  it("prints local launcher installer help", async () => {
    const result = await runCliHelp(["app", "install-launcher", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /TurnkeyAI Mission Control launcher installer/);
    assert.match(result.stdout, /--path <file>/);
  });

  it("installs a local launcher to an explicit path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "turnkeyai-launcher-"));
    try {
      const launcherPath = path.join(dir, "Mission Control.command");
      const result = await runCliHelp(["app", "install-launcher", "--path", launcherPath]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /installed TurnkeyAI Mission Control launcher/);
      const info = await stat(launcherPath);
      assert.ok((info.mode & 0o111) !== 0, "launcher should be executable");
      const content = await readFile(launcherPath, "utf8");
      assert.match(content, /exec turnkeyai app "\$@"/);
      assert.match(content, /npm --prefix .* run app -- "\$@"/);
      assert.match(content, /exec npx @turnkeyai\/cli app "\$@"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function runCliHelp(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "packages/cli/src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

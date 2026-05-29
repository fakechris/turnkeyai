import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("cli help", () => {
  it("documents the source-tree app launcher and current app routes", async () => {
    const result = await runCliHelp(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /turnkeyai app \[--route onboarding\|missions\|approvals\|agents\|context\|agent-connect\|runtime\|settings\]/);
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

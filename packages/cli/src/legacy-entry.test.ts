import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveLegacyEntryInvocation } from "./legacy-entry";

describe("legacy entry launcher", () => {
  it("prefers the bundled JavaScript entry when present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "turnkeyai-legacy-entry-bundled-"));
    try {
      await writeFile(path.join(dir, "tui.js"), "", "utf8");
      const invocation = resolveLegacyEntryInvocation("tui", ["--help"], {
        currentDir: dir,
        execPath: "/node",
      });
      assert.equal(invocation.mode, "bundled");
      assert.deepEqual(invocation.args, [path.join(dir, "tui.js"), "--help"]);
      assert.equal(invocation.command, "/node");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the source TypeScript entry in a checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "turnkeyai-legacy-entry-source-"));
    try {
      const cliSrc = path.join(root, "packages", "cli", "src");
      const tuiSrc = path.join(root, "packages", "tui", "src");
      await mkdir(cliSrc, { recursive: true });
      await mkdir(tuiSrc, { recursive: true });
      await writeFile(path.join(tuiSrc, "tui.ts"), "", "utf8");

      const invocation = resolveLegacyEntryInvocation("tui", ["--help"], {
        currentDir: cliSrc,
        execPath: "/node",
      });
      assert.equal(invocation.mode, "source");
      assert.deepEqual(invocation.args, [
        "--import",
        "tsx",
        path.join(tuiSrc, "tui.ts"),
        "--help",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the old missing-entry path when neither target exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "turnkeyai-legacy-entry-missing-"));
    try {
      const invocation = resolveLegacyEntryInvocation("tui", [], {
        currentDir: dir,
        execPath: "/node",
      });
      assert.equal(invocation.mode, "missing");
      assert.deepEqual(invocation.args, [path.join(dir, "tui.js")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolveSystemEditorCommand, runSystemEditorCommand } from "./system-file-opener";

test("resolveSystemEditorCommand uses the platform text editor command", () => {
  assert.deepEqual(resolveSystemEditorCommand("/tmp/models.local.json", "darwin"), {
    command: "open",
    args: ["-t", "/tmp/models.local.json"],
  });
  assert.deepEqual(resolveSystemEditorCommand("/tmp/models.local.json", "linux"), {
    command: "xdg-open",
    args: ["/tmp/models.local.json"],
  });
  assert.deepEqual(resolveSystemEditorCommand("C:\\TurnkeyAI\\models.local.json", "win32"), {
    command: "cmd",
    args: ["/c", "start", "", "C:\\TurnkeyAI\\models.local.json"],
  });
});

test("runSystemEditorCommand rejects when the launcher exits unsuccessfully", async () => {
  await assert.rejects(
    runSystemEditorCommand({ command: process.execPath, args: ["-e", "process.exit(7)"] }),
    /exited with code 7/
  );
});

test("runSystemEditorCommand rejects when the launcher cannot be spawned", async () => {
  await assert.rejects(
    runSystemEditorCommand({ command: "turnkeyai-command-that-does-not-exist", args: [] }),
    /ENOENT|spawn/
  );
});

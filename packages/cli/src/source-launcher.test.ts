import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const launcherPath = path.resolve(process.cwd(), "launchers", "TurnkeyAI Mission Control.command");

describe("source checkout Mission Control launcher", () => {
  it("is executable and launches the source checkout before installed fallbacks", async () => {
    const [info, content] = await Promise.all([
      stat(launcherPath),
      readFile(launcherPath, "utf8"),
    ]);

    assert.ok((info.mode & 0o111) !== 0, "source launcher should be executable");
    assert.match(content, /^#!\/usr\/bin\/env sh/);
    assert.match(content, /CHECKOUT_DIR=\$\(CDPATH= cd -- "\$SCRIPT_DIR\/\.\." && pwd\)/);
    assert.match(content, /exec npm --prefix "\$CHECKOUT_DIR" run app -- "\$@"/);
    assert.match(content, /exec turnkeyai app "\$@"/);
    assert.match(content, /exec npx @turnkeyai\/cli app "\$@"/);
    assert.ok(
      content.indexOf("exec npm --prefix") < content.indexOf("exec turnkeyai app"),
      "bundled launcher should prefer the current source checkout"
    );
  });
});

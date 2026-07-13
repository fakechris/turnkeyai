import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDesktopReleaseTag,
  parseDesktopReleaseArgs,
  parseRemoteTagTarget,
} from "./release-tag-lib.mjs";

describe("desktop release tag helpers", () => {
  it("builds the desktop tag from a package version", () => {
    assert.equal(buildDesktopReleaseTag("0.1.0"), "desktop-v0.1.0");
    assert.equal(buildDesktopReleaseTag("1.2.3-rc.1"), "desktop-v1.2.3-rc.1");
    assert.throws(() => buildDesktopReleaseTag(" 0.1.0 "), /valid semver/);
    assert.throws(() => buildDesktopReleaseTag("latest"), /valid semver/);
  });

  it("parses safe defaults and explicit publish flags", () => {
    assert.deepEqual(parseDesktopReleaseArgs([]), {
      allowDirty: false,
      help: false,
      push: false,
      remote: "origin",
      skipChecks: false,
    });
    assert.deepEqual(
      parseDesktopReleaseArgs([
        "--push",
        "--allow-dirty",
        "--skip-checks",
        "--remote=upstream",
      ]),
      {
        allowDirty: true,
        help: false,
        push: true,
        remote: "upstream",
        skipChecks: true,
      }
    );
    assert.equal(parseDesktopReleaseArgs(["--help"]).help, true);
    assert.throws(() => parseDesktopReleaseArgs(["--unknown"]), /Unknown argument/);
    assert.throws(() => parseDesktopReleaseArgs(["--remote="]), /remote name/);
  });

  it("prefers the peeled commit for annotated remote tags", () => {
    const tagObject = "a".repeat(40);
    const commit = "b".repeat(40);
    const output = [
      `${tagObject}\trefs/tags/desktop-v0.1.0`,
      `${commit}\trefs/tags/desktop-v0.1.0^{}`,
    ].join("\n");

    assert.equal(parseRemoteTagTarget(output, "desktop-v0.1.0"), commit);
    assert.equal(
      parseRemoteTagTarget(`${commit}\trefs/tags/desktop-v0.1.0`, "desktop-v0.1.0"),
      commit
    );
    assert.equal(parseRemoteTagTarget("", "desktop-v0.1.0"), null);
  });
});

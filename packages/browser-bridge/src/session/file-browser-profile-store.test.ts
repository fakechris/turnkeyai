import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBrowserProfileStore } from "./file-browser-profile-store";

test("file browser profile store backfills legacy scope-based ownership", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "browser-profile-store-"));

  try {
    const store = new FileBrowserProfileStore({ rootDir: tempDir });
    const profilePath = path.join(tempDir, `${encodeURIComponent("profile-legacy")}.json`);
    await writeFile(
      profilePath,
      `${JSON.stringify(
        {
          profileId: "profile-legacy",
          scope: "thread",
          scopeId: "thread-legacy",
          persistentDir: "/tmp/profile-legacy",
          loginState: "authenticated",
          createdAt: 1,
          updatedAt: 2,
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const profile = await store.findByOwner("thread", "thread-legacy");
    assert.ok(profile);
    assert.equal(profile.ownerType, "thread");
    assert.equal(profile.ownerId, "thread-legacy");

    const persisted = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.ownerType, "thread");
    assert.equal(persisted.ownerId, "thread-legacy");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

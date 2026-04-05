import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { FileSnapshotRefStore } from "./file-snapshot-ref-store";

test("snapshot ref store resolves refs from recent target-local snapshot history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "snapshot-ref-store-"));

  try {
    const store = new FileSnapshotRefStore({ rootDir: tempDir });

    await store.save({
      artifactId: "artifact-1",
      snapshotId: "snapshot-1",
      browserSessionId: "session-1",
      targetId: "target-1",
      createdAt: 10,
      finalUrl: "https://example.com/one",
      title: "One",
      refEntries: [
        {
          refId: "ref-1",
          role: "button",
          label: "Open pricing",
          selectors: ['button[aria-label="Open pricing"]'],
        },
      ],
    });

    await store.save({
      artifactId: "artifact-2",
      snapshotId: "snapshot-2",
      browserSessionId: "session-1",
      targetId: "target-1",
      createdAt: 20,
      finalUrl: "https://example.com/two",
      title: "Two",
      refEntries: [
        {
          refId: "ref-2",
          role: "link",
          label: "Details",
        },
      ],
    });

    const resolved = await store.resolve({
      browserSessionId: "session-1",
      targetId: "target-1",
      refId: "ref-1",
    });

    assert.ok(resolved);
    assert.equal(resolved?.strategy, "snapshot-cache");
    assert.deepEqual(resolved?.selectors, ['button[aria-label="Open pricing"]']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("snapshot ref store expires only the requested snapshot and keeps newer history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "snapshot-ref-expire-"));

  try {
    const store = new FileSnapshotRefStore({ rootDir: tempDir });

    await store.save({
      artifactId: "artifact-1",
      snapshotId: "snapshot-1",
      browserSessionId: "session-1",
      targetId: "target-1",
      createdAt: 10,
      finalUrl: "https://example.com/one",
      title: "One",
      refEntries: [{ refId: "ref-1", role: "button", label: "Old" }],
    });
    await store.save({
      artifactId: "artifact-2",
      snapshotId: "snapshot-2",
      browserSessionId: "session-1",
      targetId: "target-1",
      createdAt: 20,
      finalUrl: "https://example.com/two",
      title: "Two",
      refEntries: [{ refId: "ref-2", role: "button", label: "New" }],
    });

    await store.expire("snapshot-1");

    const oldRef = await store.resolve({
      browserSessionId: "session-1",
      targetId: "target-1",
      refId: "ref-1",
    });
    const newRef = await store.resolve({
      browserSessionId: "session-1",
      targetId: "target-1",
      refId: "ref-2",
    });

    assert.equal(oldRef, null);
    assert.equal(newRef?.label, "New");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("snapshot ref store resolves refs from legacy on-disk payloads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "snapshot-ref-legacy-"));

  try {
    const store = new FileSnapshotRefStore({ rootDir: tempDir });
    const sessionDir = path.join(tempDir, encodeURIComponent("session-legacy"));
    await writeJsonFileAtomic(path.join(sessionDir, `${encodeURIComponent("target-legacy")}.json`), {
      latestSnapshotId: "legacy-1",
      refEntries: [{ refId: "ref-legacy", role: "button", label: "Legacy button" }],
      finalUrl: "https://example.com/legacy",
      title: "Legacy",
      updatedAt: 42,
    });

    const resolved = await store.resolve({
      browserSessionId: "session-legacy",
      targetId: "target-legacy",
      refId: "ref-legacy",
    });

    assert.equal(resolved?.label, "Legacy button");
    assert.equal(resolved?.strategy, "snapshot-cache");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

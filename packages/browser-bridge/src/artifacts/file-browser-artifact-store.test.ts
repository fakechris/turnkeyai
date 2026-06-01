import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBrowserArtifactStore } from "./file-browser-artifact-store";

test("file browser artifact store enriches records with lifecycle metadata and stable ordering", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-artifact-store-"));
  try {
    const artifactRootDir = path.join(tempDir, "browser-artifacts");
    const metadataRootDir = path.join(tempDir, "artifact-records");
    const firstPath = path.join(artifactRootDir, "session-1", "first.png");
    const secondPath = path.join(artifactRootDir, "session-1", "second.json");
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, "first artifact", "utf8");
    await writeFile(secondPath, "second artifact", "utf8");

    const store = new FileBrowserArtifactStore({
      rootDir: metadataRootDir,
      artifactRootDir,
      retentionMs: 60_000,
      maxArtifactBytes: 1_000,
      sessionBudgetBytes: 2_000,
      cleanupOnSessionClose: true,
    });
    await store.put({
      artifactId: "artifact-first",
      browserSessionId: "session-1",
      type: "screenshot",
      path: firstPath,
      createdAt: 1_000,
    });
    await store.put({
      artifactId: "artifact-second",
      browserSessionId: "session-1",
      type: "snapshot",
      path: secondPath,
      createdAt: 2_000,
    });

    const records = await store.listBySession("session-1");
    assert.deepEqual(records.map((record) => record.artifactId), ["artifact-second", "artifact-first"]);
    assert.equal(records[0]?.sizeBytes, Buffer.byteLength("second artifact"));
    assert.deepEqual(records[0]?.lifecycle, {
      storageBackend: "file",
      refType: "local-path",
      retentionMs: 60_000,
      expiresAt: 62_000,
      maxArtifactBytes: 1_000,
      sessionBudgetBytes: 2_000,
      cleanupOnSessionClose: true,
      orphanReconciliation: "delete_expired",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file browser artifact store enforces per-artifact and per-session budgets", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-artifact-budget-"));
  try {
    const artifactRootDir = path.join(tempDir, "browser-artifacts");
    const metadataRootDir = path.join(tempDir, "artifact-records");
    const firstPath = path.join(artifactRootDir, "session-1", "first.bin");
    const secondPath = path.join(artifactRootDir, "session-1", "second.bin");
    const oversizedPath = path.join(artifactRootDir, "session-1", "oversized.bin");
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, "12345", "utf8");
    await writeFile(secondPath, "123456", "utf8");
    await writeFile(oversizedPath, "12345678901", "utf8");

    const store = new FileBrowserArtifactStore({
      rootDir: metadataRootDir,
      artifactRootDir,
      maxArtifactBytes: 10,
      sessionBudgetBytes: 10,
    });
    await store.put({
      artifactId: "artifact-first",
      browserSessionId: "session-1",
      type: "downloaded-file",
      path: firstPath,
      createdAt: 1_000,
    });
    await assert.rejects(
      store.put({
        artifactId: "artifact-second",
        browserSessionId: "session-1",
        type: "downloaded-file",
        path: secondPath,
        createdAt: 2_000,
      }),
      /browser session artifact budget exceeded/
    );
    await assert.rejects(
      store.put({
        artifactId: "artifact-oversized",
        browserSessionId: "session-1",
        type: "downloaded-file",
        path: oversizedPath,
        createdAt: 3_000,
      }),
      /browser artifact exceeds per-artifact budget/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("file browser artifact store prunes expired records and only deletes managed artifact files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-artifact-prune-"));
  try {
    const artifactRootDir = path.join(tempDir, "browser-artifacts");
    const metadataRootDir = path.join(tempDir, "artifact-records");
    const managedPath = path.join(artifactRootDir, "session-1", "expired.png");
    const outsidePath = path.join(tempDir, "outside.txt");
    const freshPath = path.join(artifactRootDir, "session-1", "fresh.png");
    await mkdir(path.dirname(managedPath), { recursive: true });
    await writeFile(managedPath, "expired", "utf8");
    await writeFile(outsidePath, "outside", "utf8");
    await writeFile(freshPath, "fresh", "utf8");

    const store = new FileBrowserArtifactStore({
      rootDir: metadataRootDir,
      artifactRootDir,
      retentionMs: 100,
    });
    await store.put({
      artifactId: "expired-managed",
      browserSessionId: "session-1",
      type: "screenshot",
      path: managedPath,
      createdAt: 1_000,
    });
    await store.put({
      artifactId: "expired-outside",
      browserSessionId: "session-1",
      type: "trace",
      path: outsidePath,
      createdAt: 1_000,
    });
    await store.put({
      artifactId: "fresh-managed",
      browserSessionId: "session-1",
      type: "screenshot",
      path: freshPath,
      createdAt: 2_000,
    });

    const result = await store.pruneExpired({ now: 1_500 });
    assert.deepEqual(result, { recordsDeleted: 2, filesDeleted: 1 });
    assert.equal(await exists(managedPath), false);
    assert.equal(await readFile(outsidePath, "utf8"), "outside");
    assert.equal(await exists(freshPath), true);
    assert.deepEqual((await store.listBySession("session-1")).map((record) => record.artifactId), ["fresh-managed"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false
  );
}

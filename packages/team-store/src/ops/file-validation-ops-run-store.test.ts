import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileValidationOpsRunStore } from "./file-validation-ops-run-store";

test("file validation ops run store persists and lists latest records first", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "validation-ops-run-store-"));
  try {
    const store = new FileValidationOpsRunStore({ rootDir });

    await store.put({
      runId: "validation-run-1",
      runType: "validation-profile",
      title: "Nightly Hardening",
      status: "failed",
      startedAt: 10,
      completedAt: 20,
      durationMs: 10,
      issueCount: 1,
      profileId: "nightly",
      selectors: ["failure", "acceptance"],
      issues: [
        {
          issueId: "validation-run-1:realworld:item-1",
          kind: "validation-item",
          scope: "realworld:item-1",
          summary: "real-world item failed",
          bucket: "validation",
          severity: "critical",
          recommendedAction: "rerun-profile",
          commandHint: "validation-profile-run nightly",
        },
      ],
    });

    await store.put({
      runId: "validation-run-2",
      runType: "release-readiness",
      title: "Release readiness verification",
      status: "passed",
      startedAt: 30,
      completedAt: 40,
      durationMs: 10,
      issueCount: 0,
      issues: [],
    });

    const all = await store.list();
    assert.equal(all.length, 2);
    assert.equal(all[0]?.runId, "validation-run-2");
    assert.equal(all[1]?.runId, "validation-run-1");

    const limited = await store.list(1);
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.runId, "validation-run-2");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

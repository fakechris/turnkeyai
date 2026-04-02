import assert from "node:assert/strict";
import test from "node:test";

import { runReleaseReadiness } from "./release-readiness";

test("release readiness verifies packed cli tarball and dry-run publish", { timeout: 30_000 }, async () => {
  const result = await runReleaseReadiness();

  assert.equal(result.status, "passed");
  assert.equal(result.failedChecks, 0);
  assert.ok(result.checks.some((check) => check.checkId === "pack-cli" && check.status === "passed"));
  assert.ok(result.checks.some((check) => check.checkId === "publish-dry-run" && check.status === "passed"));
  assert.equal(result.artifact?.filename.endsWith(".tgz"), true);
});


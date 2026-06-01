import assert from "node:assert/strict";
import test from "node:test";

import { browserFailureBucketLabel, selectBrowserFailureBucketRows } from "./browserFailureBuckets";

test("selectBrowserFailureBucketRows sorts newest first and keeps operator labels", () => {
  const rows = selectBrowserFailureBucketRows([
    { bucket: "attach_failed", count: 2, latestAtMs: 2000 },
    { bucket: "session_not_found", count: 1, latestAtMs: 4000 },
    { bucket: "cdp_command_timeout", count: 1, latestAtMs: 3000 },
  ]);

  assert.deepEqual(
    rows.map((row) => ({ label: row.label, countLabel: row.countLabel, latestAtMs: row.latestAtMs })),
    [
      { label: "Browser session unavailable", countLabel: "1 occurrence", latestAtMs: 4000 },
      { label: "CDP command timed out", countLabel: "1 occurrence", latestAtMs: 3000 },
      { label: "Target attach failed", countLabel: "2 occurrences", latestAtMs: 2000 },
    ]
  );
});

test("browserFailureBucketLabel falls back to readable unknown bucket text", () => {
  assert.equal(browserFailureBucketLabel("future_bucket_name"), "future bucket name");
});

test("selectBrowserFailureBucketRows handles missing bucket arrays", () => {
  assert.deepEqual(selectBrowserFailureBucketRows(undefined), []);
  assert.deepEqual(selectBrowserFailureBucketRows(null), []);
});

import assert from "node:assert/strict";
import test from "node:test";

import { BrowserResultVerifier } from "./browser-result-verifier";

test("browser result verifier flags missing final page fields", () => {
  const verifier = new BrowserResultVerifier();
  const report = verifier.verify({
    sessionId: "session-1",
    page: {
      requestedUrl: "https://example.com",
      finalUrl: "",
      title: "",
      textExcerpt: "",
      statusCode: 200,
      interactives: [],
    },
    screenshotPaths: [],
    artifactIds: [],
    trace: [],
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.includes("finalUrl")));
  assert.ok(report.issues.some((issue) => issue.includes("page title")));
});

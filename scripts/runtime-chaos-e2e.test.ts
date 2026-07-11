import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REQUIRED_RUNTIME_CHAOS_KILL_POINTS,
  runRuntimeChaosSuite,
} from "./runtime-chaos-e2e";

test("runtime chaos suite recovers every durable boundary and survives a 64-round loop", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-runtime-chaos-test-"));
  try {
    const report = await runRuntimeChaosSuite({ rootDir });

    assert.equal(report.protocol, "turnkeyai.runtime_chaos_report.v1");
    assert.equal(report.status, "passed");
    assert.deepEqual(
      report.killPoints.map((result) => result.killPoint),
      REQUIRED_RUNTIME_CHAOS_KILL_POINTS,
    );
    for (const result of report.killPoints) {
      assert.equal(result.initialExit.signal, "SIGKILL", result.killPoint);
      assert.equal(result.resumeExitCode, 0, result.killPoint);
      assert.equal(result.sameRuntimeRoot, true, result.killPoint);
      assert.equal(result.terminalJournal, true, result.killPoint);
      assert.equal(result.duplicateSideEffects, 0, result.killPoint);
      assert.equal(result.duplicateToolSignatures, 0, result.killPoint);
      assert.equal(result.replayProviderCalls, 0, result.killPoint);
    }

    assert.equal(report.stress.rounds, 64);
    assert.equal(report.stress.resumeEvents, 1);
    assert.ok(report.stress.externalizations > 0);
    assert.ok(report.stress.compactions > 0);
    assert.equal(report.stress.earlyEvidencePreserved, true);
    assert.equal(report.stress.duplicateSideEffects, 0);
    assert.equal(report.stress.duplicateToolSignatures, 0);
    assert.equal(report.stress.terminalJournal, true);
    assert.equal(report.stress.replayProviderCalls, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

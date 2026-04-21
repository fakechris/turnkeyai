import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBrowserTransportFailure,
  evaluateBrowserTransportAcceptance,
  runBrowserTransportSoak,
} from "./browser-transport-soak";

test("browser transport soak classifies relay peer timeout and direct-cdp reconnect failure", () => {
  assert.equal(
    classifyBrowserTransportFailure({
      target: "relay",
      exitCode: 1,
      output: "timed out waiting for relay peer: turnkeyai-relay-peer",
    }),
    "peer-timeout"
  );
  assert.equal(
    classifyBrowserTransportFailure({
      target: "direct-cdp",
      exitCode: 1,
      output: "reconnect verification failed after browser restart",
    }),
    "reconnect-failure"
  );
});

test("browser transport soak classifies download and upload failures as artifact failures", () => {
  assert.equal(
    classifyBrowserTransportFailure({
      target: "relay",
      exitCode: 1,
      output: "relay download action timed out after 5000ms",
    }),
    "artifact-failure"
  );
  assert.equal(
    classifyBrowserTransportFailure({
      target: "direct-cdp",
      exitCode: 1,
      output: "direct-cdp upload smoke did not record completed upload trace metadata",
    }),
    "artifact-failure"
  );
});

test("browser transport soak aggregates multi-cycle target results and failure buckets", async () => {
  const result = await runBrowserTransportSoak(
    {
      cycles: 2,
      targets: ["relay", "direct-cdp"],
      timeoutMs: 10_000,
      relayPeerCount: 2,
      verifyReconnect: true,
      verifyWorkflowLog: true,
    },
    {
      runner: async ({ target, cycleNumber }) => {
        if (target === "relay" && cycleNumber === 2) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "timed out waiting for relay peer: turnkeyai-relay-peer",
          };
        }
        if (target === "direct-cdp" && cycleNumber === 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "workflow-log verification failed for reconnect diagnostic case",
          };
        }
        return {
          exitCode: 0,
          stdout:
            target === "relay"
              ? [
                  "relay smoke passed",
                  "targets: 1",
                  "peer-count: 2",
                  "browser-final-url: http://127.0.0.1:4010/#submitted",
                  "browser-history: 3",
                  "browser-transport: chrome-relay",
                  "browser-target-continuity: chrome-tab",
                  "browser-screenshots: 0",
                  "browser-artifacts: 1",
                  "browser-targets: 2",
                  "browser-multi-target: passed",
                  "browser-download-artifacts: 1",
                  "browser-upload-actions: 1",
                  "browser-network-controls: passed",
                  "browser-resume-final-url: http://127.0.0.1:4010/#submitted",
                  "reconnect-history: 4",
                  "reconnect-final-url: http://127.0.0.1:4010/#submitted",
                  "workflow-log-status: passed",
                ].join("\n")
              : [
                  "direct-cdp smoke passed",
                  "browser-final-url: http://127.0.0.1:4010/#submitted",
                  "browser-history: 3",
                  "browser-transport: direct-cdp",
                  "browser-target-continuity: direct-cdp",
                  "browser-screenshots: 1",
                  "browser-artifacts: 1",
                  "browser-targets: 2",
                  "browser-multi-target: passed",
                  "browser-download-artifacts: 1",
                  "browser-upload-actions: 1",
                  "browser-network-controls: passed",
                  "browser-resume-final-url: http://127.0.0.1:4010/#submitted",
                  "reconnect-history: 4",
                  "reconnect-final-url: http://127.0.0.1:4010/#submitted",
                  "workflow-log-status: passed",
                ].join("\n"),
        };
      },
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.totalCycles, 2);
  assert.equal(result.failedCycles, 2);
  assert.equal(result.totalTargetRuns, 4);
  assert.equal(result.failedTargetRuns, 2);

  const relayAggregate = result.targetAggregates.find((aggregate) => aggregate.target === "relay");
  assert.equal(relayAggregate?.failedCycles, 1);
  assert.ok(relayAggregate?.failureBuckets.some((bucket) => bucket.bucket === "peer-timeout" && bucket.count === 1));
  const relayPassedRun = result.cycleResults[0]?.targets.find((run) => run.target === "relay");
  assert.equal(relayPassedRun?.failedAcceptanceChecks, 0);
  assert.equal(relayPassedRun?.passedAcceptanceChecks, 13);
  assert.ok(
    relayAggregate?.acceptanceChecks.some((check) =>
      check.checkId === "network-controls" && check.passed === 1 && check.failed === 1
    )
  );

  const cdpAggregate = result.targetAggregates.find((aggregate) => aggregate.target === "direct-cdp");
  assert.equal(cdpAggregate?.failedCycles, 1);
  assert.ok(cdpAggregate?.failureBuckets.some((bucket) => bucket.bucket === "workflow-log-failure" && bucket.count === 1));
  const cdpPassedRun = result.cycleResults[1]?.targets.find((run) => run.target === "direct-cdp");
  assert.equal(cdpPassedRun?.failedAcceptanceChecks, 0);
  assert.equal(cdpPassedRun?.passedAcceptanceChecks, 11);
  assert.ok(
    cdpAggregate?.acceptanceChecks.some((check) =>
      check.checkId === "relay-target-discovery" && check.passed === 0 && check.failed === 0 && check.skipped === 2
    )
  );
});

test("browser transport acceptance requires long-chain relay markers", () => {
  const checks = evaluateBrowserTransportAcceptance({
    target: "relay",
    exitCode: 0,
    relayPeerCount: 2,
    verifyReconnect: true,
    verifyWorkflowLog: true,
    output: [
      "targets: 1",
      "peer-count: 2",
      "browser-final-url: http://127.0.0.1:4010/#submitted",
      "browser-history: 3",
      "browser-transport: chrome-relay",
      "browser-target-continuity: chrome-tab",
      "browser-screenshots: 0",
      "browser-artifacts: 1",
      "browser-targets: 2",
      "browser-multi-target: passed",
      "browser-download-artifacts: 1",
      "browser-upload-actions: 1",
      "browser-network-controls: passed",
      "browser-resume-final-url: http://127.0.0.1:4010/#submitted",
      "reconnect-history: 4",
      "reconnect-final-url: http://127.0.0.1:4010/#submitted",
      "workflow-log-status: passed",
    ].join("\n"),
  });

  assert.deepEqual(
    checks.map((check) => [check.checkId, check.status]),
    [
      ["spawn-send-resume", "passed"],
      ["final-url-continuity", "passed"],
      ["transport-label", "passed"],
      ["target-continuity", "passed"],
      ["artifact-continuity", "passed"],
      ["network-controls", "passed"],
      ["multi-target-continuity", "passed"],
      ["download-artifact", "passed"],
      ["upload-artifact", "passed"],
      ["reconnect", "passed"],
      ["workflow-log", "passed"],
      ["relay-target-discovery", "passed"],
      ["relay-peer-multiplex", "passed"],
    ]
  );
});

test("browser transport acceptance skips optional checks when not requested", () => {
  const checks = evaluateBrowserTransportAcceptance({
    target: "direct-cdp",
    exitCode: 0,
    relayPeerCount: 1,
    verifyReconnect: false,
    verifyWorkflowLog: false,
    output: [
      "browser-final-url: http://127.0.0.1:4010/#submitted",
      "browser-history: 3",
      "browser-transport: direct-cdp",
      "browser-target-continuity: direct-cdp",
      "browser-screenshots: 1",
      "browser-artifacts: 1",
      "browser-targets: 2",
      "browser-multi-target: passed",
      "browser-download-artifacts: 1",
      "browser-upload-actions: 1",
      "browser-network-controls: passed",
      "browser-resume-final-url: http://127.0.0.1:4010/#submitted",
    ].join("\n"),
  });

  assert.equal(checks.find((check) => check.checkId === "reconnect")?.status, "skipped");
  assert.equal(checks.find((check) => check.checkId === "workflow-log")?.status, "skipped");
  assert.equal(checks.find((check) => check.checkId === "relay-peer-multiplex")?.status, "skipped");
});

test("browser transport soak treats missing acceptance markers as local regression", async () => {
  const result = await runBrowserTransportSoak(
    {
      cycles: 1,
      targets: ["relay"],
      timeoutMs: 10_000,
      relayPeerCount: 1,
      verifyReconnect: false,
      verifyWorkflowLog: false,
    },
    {
      runner: async () => ({
        exitCode: 0,
        stdout: [
          "relay smoke passed",
          "targets: 1",
          "browser-final-url: http://127.0.0.1:4010/#submitted",
          "browser-history: 3",
          "browser-transport: chrome-relay",
          "browser-target-continuity: chrome-tab",
          "browser-artifacts: 1",
          "browser-resume-final-url: http://127.0.0.1:4010/#submitted",
        ].join("\n"),
      }),
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.failedTargetRuns, 1);
  const failedRun = result.cycleResults[0]?.targets[0];
  assert.equal(failedRun?.failureBucket, "local-regression");
  assert.equal(failedRun?.failedAcceptanceChecks, 4);
  assert.equal(failedRun?.acceptanceChecks?.find((check) => check.checkId === "network-controls")?.status, "failed");
  assert.equal(
    failedRun?.acceptanceChecks?.find((check) => check.checkId === "multi-target-continuity")?.status,
    "failed"
  );
  assert.equal(failedRun?.acceptanceChecks?.find((check) => check.checkId === "download-artifact")?.status, "failed");
  assert.equal(failedRun?.acceptanceChecks?.find((check) => check.checkId === "upload-artifact")?.status, "failed");
});

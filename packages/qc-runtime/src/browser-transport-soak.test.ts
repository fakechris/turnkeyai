import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBrowserTransportFailure,
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
              ? "relay smoke passed\npeer-count: 2\nreconnect-final-url: http://127.0.0.1:4010/#submitted"
              : "direct-cdp smoke passed\nbrowser-resume-final-url: http://127.0.0.1:4010/#submitted",
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

  const cdpAggregate = result.targetAggregates.find((aggregate) => aggregate.target === "direct-cdp");
  assert.equal(cdpAggregate?.failedCycles, 1);
  assert.ok(cdpAggregate?.failureBuckets.some((bucket) => bucket.bucket === "workflow-log-failure" && bucket.count === 1));
});

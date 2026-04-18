import assert from "node:assert/strict";
import test from "node:test";

import { RelayPeerLoop } from "./peer-loop";

test("relay peer loop schedules active, idle, and error retries through the scheduler", async () => {
  const scheduled: Array<{ delayMs: number; callback: () => void }> = [];
  const cleared: unknown[] = [];
  const errors: string[] = [];
  const outcomes: Array<"active" | "idle" | "error"> = ["active", "idle", "error"];

  const loop = new RelayPeerLoop({
    runtime: {
      async runCycle() {
        const outcome = outcomes.shift();
        if (outcome === "active") {
          return {
            actionRequestId: "relay-action-1",
            peerId: "peer-1",
          browserSessionId: "browser-session-1",
          taskId: "task-1",
          relayTargetId: "tab-1",
          claimToken: "claim-1",
          url: "https://example.com",
          status: "completed",
            trace: [],
            screenshotPaths: [],
            screenshotPayloads: [],
            artifactIds: [],
          };
        }
        if (outcome === "idle") {
          return null;
        }
        throw new Error("peer error");
      },
    },
    scheduler: {
      setTimeout(callback, delayMs) {
        scheduled.push({ delayMs, callback });
        return scheduled.length;
      },
      clearTimeout(handle) {
        cleared.push(handle);
      },
    },
    activeDelayMs: 10,
    idleDelayMs: 20,
    errorDelayMs: 30,
    onError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  loop.start();
  assert.equal(loop.isRunning(), true);
  assert.equal(scheduled[0]?.delayMs, 0);

  scheduled.shift()?.callback();
  await Promise.resolve();
  assert.equal(scheduled[0]?.delayMs, 10);

  scheduled.shift()?.callback();
  await Promise.resolve();
  assert.equal(scheduled[0]?.delayMs, 20);

  scheduled.shift()?.callback();
  await Promise.resolve();
  assert.equal(scheduled[0]?.delayMs, 30);
  assert.deepEqual(errors, ["peer error"]);

  loop.stop();
  assert.equal(loop.isRunning(), false);
  assert.ok(cleared.length >= 1);
});

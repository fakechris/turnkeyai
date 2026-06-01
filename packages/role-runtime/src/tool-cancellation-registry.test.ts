import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryToolCancellationRegistry } from "./tool-cancellation-registry";

test("InMemoryToolCancellationRegistry resolves cancelled after runtime cancellation succeeds", async () => {
  const registry = new InMemoryToolCancellationRegistry();
  let releaseCancel!: () => void;
  let cancelReturned = false;
  const registration = registry.register({
    threadId: "thread-1",
    toolCallId: "tool-1",
    toolName: "sessions_spawn",
    async cancel() {
      await new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
    },
  });

  const cancelPromise = registry
    .cancel({
      threadId: "thread-1",
      toolCallIds: ["tool-1"],
      reason: "User cancelled the tool.",
    })
    .then((result) => {
      cancelReturned = true;
      return result;
    });

  const earlySignal = await Promise.race([
    registration.cancelled().then(() => "cancelled" as const),
    Promise.resolve().then(() => "pending" as const),
  ]);
  assert.equal(earlySignal, "pending");
  assert.equal(cancelReturned, false);

  releaseCancel();
  assert.deepEqual(await cancelPromise, [{ toolCallId: "tool-1", active: true, cancelled: true }]);
  assert.equal(await registration.cancelled(), "User cancelled the tool.");
});

test("InMemoryToolCancellationRegistry does not resolve cancelled when runtime cancellation fails", async () => {
  const registry = new InMemoryToolCancellationRegistry();
  const registration = registry.register({
    threadId: "thread-1",
    toolCallId: "tool-1",
    toolName: "sessions_spawn",
    async cancel() {
      throw new Error("cancel failed");
    },
  });

  assert.deepEqual(
    await registry.cancel({
      threadId: "thread-1",
      toolCallIds: ["tool-1"],
      reason: "User cancelled the tool.",
    }),
    [{ toolCallId: "tool-1", active: true, cancelled: false, error: "cancel failed" }]
  );
  assert.equal(registration.isCancelled(), false);
});

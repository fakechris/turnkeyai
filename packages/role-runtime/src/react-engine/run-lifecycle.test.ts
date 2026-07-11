import assert from "node:assert/strict";
import test from "node:test";

import type {
  RoleActivationInput,
  RuntimeProgressEvent,
  RuntimeProgressRecorder,
} from "@turnkeyai/core-types/team";

import { createRunLifecycleRecorder } from "./run-lifecycle";

function activation(): RoleActivationInput {
  return {
    thread: {
      threadId: "thread-lifecycle",
      roles: [
        {
          roleId: "role:lead",
          name: "Lead",
          seat: "lead",
        },
      ],
    },
    flow: { flowId: "flow-lifecycle" },
    handoff: { taskId: "task-lifecycle" },
    runState: {
      runKey: "run-lifecycle",
      roleId: "role:lead",
      lastDequeuedTaskId: "dispatch-lifecycle",
    },
  } as unknown as RoleActivationInput;
}

function recorder(events: RuntimeProgressEvent[]): RuntimeProgressRecorder {
  return {
    async record(event) {
      events.push(event);
    },
  };
}

test("run lifecycle records typed durable boundaries with stable attempt identity", async () => {
  const progress: RuntimeProgressEvent[] = [];
  const lifecycle = createRunLifecycleRecorder({
    activation: activation(),
    recorder: recorder(progress),
    activityHeartbeatMs: 5_000,
  });

  assert.equal(lifecycle.allocateModelCall("tool_round", 3), "tool_round:3:1");
  assert.equal(
    lifecycle.allocateModelCall("final_synthesis"),
    "final_synthesis:none:2",
  );

  await lifecycle.record({ kind: "run_started", at: 100 });
  await lifecycle.record({
    kind: "model_attempt_started",
    at: 200,
    attemptId: "attempt-1",
    phase: "tool_round",
    round: 3,
  });
  await lifecycle.record({
    kind: "provider_activity",
    at: 300,
    attemptId: "attempt-1",
    activity: "headers",
  });
  await lifecycle.record({
    kind: "provider_activity",
    at: 400,
    attemptId: "attempt-1",
    activity: "body",
  });
  await lifecycle.record({
    kind: "provider_activity",
    at: 5_500,
    attemptId: "attempt-1",
    activity: "event",
  });
  await lifecycle.record({
    kind: "model_attempt_failed",
    at: 5_600,
    attemptId: "attempt-1",
    code: "timeout",
    message: "provider stopped responding",
  });
  await lifecycle.record({
    kind: "run_terminal",
    at: 5_700,
    status: "deadline",
    message: "run deadline reached",
  });

  assert.deepEqual(
    progress.map((event) => event.metadata?.["lifecycleKind"]),
    [
      "run_started",
      "model_attempt_started",
      "provider_activity",
      "provider_activity",
      "model_attempt_failed",
      "run_terminal",
    ],
  );
  assert.equal(progress[1]?.metadata?.["attemptId"], "attempt-1");
  assert.equal(progress[1]?.metadata?.["phase"], "tool_round");
  assert.equal(progress[1]?.metadata?.["round"], 3);
  assert.equal(progress[4]?.phase, "failed");
  assert.equal(progress[5]?.closeKind, "timeout");
  assert.equal(progress[5]?.continuityState, "terminal");
  assert.equal(new Set(progress.map((event) => event.progressId)).size, 6);

  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.events.length, 7);
  assert.equal(snapshot.lastProviderActivityAt, 5_500);
  assert.equal(snapshot.inFlightAttemptIds.length, 0);
  assert.equal(snapshot.terminalStatus, "deadline");
});

test("run lifecycle progress ids stay unique across concurrent recorders for one task", async () => {
  const progress: RuntimeProgressEvent[] = [];
  const sharedActivation = activation();
  const first = createRunLifecycleRecorder({
    activation: sharedActivation,
    recorder: recorder(progress),
  });
  const second = createRunLifecycleRecorder({
    activation: sharedActivation,
    recorder: recorder(progress),
  });

  await Promise.all([
    first.record({ kind: "run_started", at: 100 }),
    second.record({ kind: "run_started", at: 101 }),
  ]);

  assert.equal(progress.length, 2);
  assert.equal(new Set(progress.map((event) => event.progressId)).size, 2);
});

test("run lifecycle recording failures never change runtime behavior", async () => {
  const errors: unknown[] = [];
  const lifecycle = createRunLifecycleRecorder({
    activation: activation(),
    recorder: {
      async record() {
        throw new Error("store unavailable");
      },
    },
    onError: (error) => errors.push(error),
  });

  await lifecycle.record({ kind: "run_started", at: 100 });

  assert.equal(errors.length, 1);
  assert.equal(lifecycle.snapshot().events.length, 1);
});

test("run lifecycle bounds a recorder that never settles", async () => {
  const lifecycle = createRunLifecycleRecorder({
    activation: activation(),
    recorder: {
      async record() {
        await new Promise(() => undefined);
      },
    },
    blockingWriteMs: 1,
  });

  await Promise.race([
    lifecycle.record({ kind: "run_started", at: 100 }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("lifecycle write blocked")), 50),
    ),
  ]);

  assert.equal(lifecycle.snapshot().events.length, 1);
});

test("run lifecycle retains cumulative totals after bounded detail rolls over", async () => {
  const lifecycle = createRunLifecycleRecorder({ activation: activation() });
  await lifecycle.record({
    kind: "model_attempt_started",
    at: 1,
    attemptId: "attempt-long",
    phase: "tool_round",
    round: 1,
  });
  for (let index = 0; index < 600; index += 1) {
    await lifecycle.record({
      kind: "provider_activity",
      at: index + 2,
      attemptId: "attempt-long",
      activity: "event",
    });
  }

  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.events.length, 512);
  assert.deepEqual(snapshot.totals, {
    startedModelAttempts: 1,
    completedModelAttempts: 0,
    failedModelAttempts: 0,
    retryWaits: 0,
    providerActivityEvents: 600,
  });
});

test("run lifecycle persists compaction circuit boundaries", async () => {
  const progress: RuntimeProgressEvent[] = [];
  const lifecycle = createRunLifecycleRecorder({
    activation: activation(),
    recorder: recorder(progress),
  });

  await lifecycle.record({
    kind: "compaction_failed",
    at: 200,
    round: 8,
    forced: false,
    consecutiveFailures: 3,
    microcompactedToolResults: 4,
    reason: "summarizer_failed",
  });
  await lifecycle.record({
    kind: "compaction_skipped",
    at: 210,
    round: 9,
    forced: false,
    consecutiveFailures: 3,
    microcompactedToolResults: 5,
    reason: "failure_circuit_open",
  });

  assert.deepEqual(progress.map((event) => event.phase), ["failed", "waiting"]);
  assert.equal(progress[0]?.metadata?.["microcompactedToolResults"], 4);
  assert.equal(progress[1]?.metadata?.["reason"], "failure_circuit_open");
});

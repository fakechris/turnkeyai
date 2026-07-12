import assert from "node:assert/strict";
import test from "node:test";

import {
  ReferenceRuntime,
  compactTranscript,
  meetAttemptBudgets,
  recoverCommittedEvents,
  reduceRuntime,
  validateTranscript,
  type AttemptBudget,
  type JournalFrame,
  type RetryAllowance,
  type TranscriptItem,
} from "./execution-semantics-sim";

test("attempt budget composition is monotone and excludes retry ownership", () => {
  const budget = meetAttemptBudgets(
    { activeMs: 300_000, maxTokens: 100_000 },
    { activeMs: 25_000 },
    { activeMs: 120_000, maxToolCalls: 8 },
    { activeMs: 90_000, maxToolCalls: 4 },
  );

  assert.deepEqual(budget, {
    activeMs: 25_000,
    maxToolCalls: 4,
    maxTokens: 100_000,
  });
  assert.equal("maxRetries" in budget, false);
});

test("external-input suspension ends active time and resume creates a new grant", () => {
  const runtime = new ReferenceRuntime({
    rootExpiresAt: 3_600_000,
    rootAttemptBudget: { activeMs: 30_000 },
  });

  runtime.advance(10_000);
  runtime.suspend("query", "external_input", "approval:42");
  runtime.advance(600_000);

  assert.equal(runtime.state.scopes.query?.state.kind, "suspended");
  assert.equal(runtime.state.attempts["query:attempt:1"]?.state, "yielded");

  runtime.resume("query", "query:attempt:2", { activeMs: 20_000 });
  assert.equal(runtime.state.attempts["query:attempt:2"]?.deadlineAt, 630_000);
  runtime.advance(20_001);
  assert.deepEqual(runtime.state.scopes.query?.state, {
    kind: "failed",
    errorCode: "operation_expired",
  });
});

test("durable scope TTL continues while external input is pending", () => {
  const runtime = new ReferenceRuntime({
    rootExpiresAt: 60_000,
    rootAttemptBudget: { activeMs: 20_000 },
  });
  runtime.suspend("query", "external_input", "approval:42");
  runtime.advance(60_000);

  assert.deepEqual(runtime.state.scopes.query?.state, {
    kind: "failed",
    errorCode: "scope_expired",
  });
});

test("caller wait expiry returns a handle without changing task state", () => {
  const runtime = new ReferenceRuntime({ rootAttemptBudget: { activeMs: 120_000 } });
  runtime.admitEffect({
    effectId: "effect-1",
    signature: "tool:a",
    scopeId: "tool-1",
    explicitBudget: { activeMs: 90_000 },
  });
  runtime.startEffect("effect-1");

  assert.deepEqual(runtime.wait("tool-1", 5_000), {
    kind: "not_ready",
    handle: "task:tool-1",
  });
  assert.equal(runtime.state.scopes["tool-1"]?.state.kind, "running");
  assert.equal(runtime.state.effects["effect-1"]?.status, "started");
});

test("crash after durable intent is safe to start, but crash after dispatch is not blindly retried", () => {
  const beforeDispatch = new ReferenceRuntime();
  beforeDispatch.admitEffect({ effectId: "intent-only", signature: "tool:a", scopeId: "scope-a" });

  const admittedReplay = beforeDispatch.replay();
  assert.equal(admittedReplay.state.effects["intent-only"]?.status, "admitted");
  admittedReplay.startEffect("intent-only");

  const afterDispatch = admittedReplay.replay();
  afterDispatch.reconcileStartedEffect("intent-only");
  assert.equal(afterDispatch.state.effects["intent-only"]?.status, "indeterminate");
  assert.equal(afterDispatch.state.scopes["scope-a"]?.state.kind, "suspended");
  assert.throws(() => afterDispatch.startEffect("intent-only"), /only a durable admitted effect/);

  const duplicate = afterDispatch.admitEffect({
    effectId: "intent-only",
    signature: "tool:a",
    scopeId: "ignored-scope",
  });
  assert.deepEqual(duplicate, {
    effectId: "intent-only",
    scopeId: "scope-a",
    created: false,
    status: "indeterminate",
  });
});

test("provider reconciliation commits a started effect without redispatch", () => {
  const runtime = new ReferenceRuntime();
  runtime.admitEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "tool-1" });
  runtime.startEffect("effect-1");

  const restarted = runtime.replay();
  restarted.reconcileStartedEffect("effect-1", "provider-receipt:1");

  assert.equal(restarted.state.effects["effect-1"]?.status, "committed");
  assert.deepEqual(restarted.state.scopes["tool-1"]?.state, {
    kind: "succeeded",
    resultRef: "provider-receipt:1",
  });
  assert.equal(
    restarted.admitEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "unused" }).created,
    false,
  );
});

test("detached completion remains consumable after parent termination", () => {
  const runtime = new ReferenceRuntime();
  runtime.admitEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "worker-1" });
  runtime.startEffect("effect-1");
  runtime.detach("worker-1");
  runtime.completeQuery("answer-ref");
  runtime.commitEffect("effect-1", "artifact-ref");

  assert.equal(runtime.state.scopes.query?.state.kind, "succeeded");
  assert.deepEqual(runtime.state.notifications["notification:worker-1"], {
    notificationId: "notification:worker-1",
    ownerScopeId: "query",
    sourceScopeId: "worker-1",
    resultRef: "artifact-ref",
    state: "pending",
  });

  const restarted = runtime.replay();
  restarted.consumeNotification("notification:worker-1");
  assert.equal(restarted.state.notifications["notification:worker-1"]?.state, "consumed");
});

test("cancellation reaches attached descendants but not detached work", () => {
  const runtime = new ReferenceRuntime();
  runtime.admitEffect({ effectId: "attached-effect", signature: "tool:a", scopeId: "attached" });
  runtime.startEffect("attached-effect");
  runtime.admitEffect({ effectId: "detached-effect", signature: "tool:b", scopeId: "detached" });
  runtime.startEffect("detached-effect");
  runtime.detach("detached");

  runtime.cancelQuery("operator_cancelled");

  assert.equal(runtime.state.scopes.query?.state.kind, "cancelled");
  assert.equal(runtime.state.scopes.attached?.state.kind, "cancelled");
  assert.equal(runtime.state.effects["attached-effect"]?.status, "indeterminate");
  assert.equal(runtime.state.scopes.detached?.state.kind, "running");
  runtime.commitEffect("detached-effect", "late-result");
  assert.equal(runtime.state.notifications["notification:detached"]?.state, "pending");
  assert.throws(
    () => runtime.admitEffect({ effectId: "late", signature: "tool:c", scopeId: "late" }),
    /only an active scope/,
  );
});

test("join expiry abandons the waiter without cancelling detached work", () => {
  const runtime = new ReferenceRuntime({ rootExpiresAt: 100 });
  runtime.admitEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "worker-1" });
  runtime.startEffect("effect-1");
  runtime.detach("worker-1");
  runtime.joinDetached("query", "worker-1", "join-1");

  runtime.advance(100);

  assert.deepEqual(runtime.state.scopes.query?.state, { kind: "failed", errorCode: "scope_expired" });
  assert.equal(runtime.state.joins["join-1"]?.state, "abandoned");
  assert.equal(runtime.state.scopes["worker-1"]?.state.kind, "running");

  runtime.commitEffect("effect-1", "late-artifact");
  assert.equal(runtime.state.notifications["notification:worker-1"]?.state, "pending");
});

test("detached completion satisfies a join but requires an explicit resume grant", () => {
  const runtime = new ReferenceRuntime();
  runtime.admitEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "worker-1" });
  runtime.startEffect("effect-1");
  runtime.detach("worker-1");
  runtime.joinDetached("query", "worker-1", "join-1");
  runtime.commitEffect("effect-1", "artifact-ref");

  assert.equal(runtime.state.joins["join-1"]?.state, "satisfied");
  assert.equal(runtime.state.scopes.query?.state.kind, "suspended");
  runtime.resume("query", "query:attempt:2", { activeMs: 10_000 });
  assert.equal(runtime.state.scopes.query?.state.kind, "running");
});

test("one retry allowance owner consumes a failure-domain capability", () => {
  const allowance: RetryAllowance = {
    allowanceId: "retry:model",
    ownerScopeId: "query",
    failureDomain: "model_transport",
    remainingAttempts: 2,
  };
  const runtime = new ReferenceRuntime({ retryAllowances: [allowance] });

  assert.equal(runtime.consumeRetry("query", "model_transport"), "retry:model");
  assert.equal(runtime.consumeRetry("query", "model_transport"), "retry:model");
  assert.throws(() => runtime.consumeRetry("query", "model_transport"), /exhausted/);

  const ambiguous = new ReferenceRuntime({
    retryAllowances: [allowance, { ...allowance, allowanceId: "retry:model:duplicate" }],
  });
  assert.throws(
    () => ambiguous.consumeRetry("query", "model_transport"),
    /exactly one retry owner allowance/,
  );
});

test("compaction preserves complete tool protocol units and every open call", () => {
  const transcript: TranscriptItem[] = [
    { kind: "message", id: "m1", role: "user", text: "inspect" },
    { kind: "assistant_tool_calls", id: "c1", callIds: ["tool-1", "tool-2"] },
    { kind: "tool_results", id: "r1", callIds: ["tool-2", "tool-1"] },
    { kind: "message", id: "m2", role: "assistant", text: "continuing" },
    { kind: "assistant_tool_calls", id: "c2", callIds: ["tool-3"] },
  ];

  const compacted = compactTranscript(transcript, 1);
  validateTranscript(compacted);
  assert.deepEqual(compacted.slice(-2), [transcript[3], transcript[4]]);
  assert.deepEqual(
    compacted[0]?.kind === "summary" ? compacted[0].sourceItemIds : [],
    ["m1", "c1", "r1"],
  );

  assert.throws(
    () => validateTranscript([
      { kind: "assistant_tool_calls", id: "c", callIds: ["a"] },
      { kind: "tool_results", id: "r", callIds: ["b"] },
    ]),
    /exactly match/,
  );
});

test("recovery ignores torn journal transactions", () => {
  const runtime = new ReferenceRuntime();
  const [started] = runtime.journal;
  assert.ok(started);
  const frames: JournalFrame[] = [
    { kind: "event", transactionId: "tx-start", event: started },
    { kind: "commit", transactionId: "tx-start" },
    {
      kind: "event",
      transactionId: "tx-torn",
      event: { type: "clock_advanced", at: 999_999 },
    },
  ];

  const recovered = recoverCommittedEvents(frames);
  assert.equal(recovered.length, 1);
  assert.equal(reduceRuntime(recovered).now, 0);
});

test("replay is deterministic and observers are non-interfering", () => {
  const runtime = new ReferenceRuntime();
  runtime.admitEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "tool-1" });
  runtime.startEffect("effect-1");
  const before = runtime.state;
  runtime.observe();
  runtime.observe();

  assert.deepEqual(runtime.state, before);
  assert.deepEqual(runtime.replay().state, runtime.state);
});

test("10,000 generated attempt-budget compositions preserve the meet law", () => {
  const random = seededRandom(0x5eed1234);
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const candidates = [randomBudget(random), randomBudget(random), randomBudget(random)];
    const effective = meetAttemptBudgets(...candidates);
    for (const key of BUDGET_KEYS) {
      const values = candidates
        .map((candidate) => candidate[key])
        .filter((value): value is number => value !== undefined);
      assert.equal(effective[key], values.length > 0 ? Math.min(...values) : undefined);
    }
  }
});

test("5,000 generated effect crash windows never redispatch ambiguous work", () => {
  const random = seededRandom(0xdecafbad);
  for (let iteration = 0; iteration < 5_000; iteration += 1) {
    const runtime = new ReferenceRuntime();
    const effectId = `effect-${iteration}`;
    runtime.admitEffect({ effectId, signature: "tool:generated", scopeId: `scope-${iteration}` });
    const crashPoint = integer(random, 3);
    if (crashPoint >= 1) runtime.startEffect(effectId);
    if (crashPoint === 2) runtime.commitEffect(effectId, `result-${iteration}`);

    const restarted = runtime.replay();
    const status = restarted.state.effects[effectId]?.status;
    if (status === "started") restarted.reconcileStartedEffect(effectId);
    const duplicate = restarted.admitEffect({
      effectId,
      signature: "tool:generated",
      scopeId: `ignored-${iteration}`,
    });

    assert.equal(duplicate.created, false);
    assert.notEqual(restarted.state.effects[effectId]?.status, "started");
    assert.deepEqual(restarted.replay().state, restarted.state);
  }
});

const BUDGET_KEYS = [
  "activeMs",
  "maxTurns",
  "maxModelCalls",
  "maxToolCalls",
  "maxTokens",
  "maxCost",
  "maxConcurrency",
] as const satisfies ReadonlyArray<keyof AttemptBudget>;

function randomBudget(random: () => number): AttemptBudget {
  const budget: AttemptBudget = {};
  for (const key of BUDGET_KEYS) {
    if (random() > 0.35) budget[key] = 1 + integer(random, 1_000_000);
  }
  return budget;
}

function integer(random: () => number, exclusiveMax: number): number {
  return Math.floor(random() * exclusiveMax);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

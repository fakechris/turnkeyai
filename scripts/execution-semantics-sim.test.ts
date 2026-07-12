import assert from "node:assert/strict";
import test from "node:test";

import {
  ReferenceRuntime,
  isTerminal,
  meetBudgets,
  requestedTimeoutBudget,
  type BudgetEnvelope,
} from "./execution-semantics-sim";

test("budget composition is monotone and never enlarges an explicit timeout", () => {
  const budget = meetBudgets(
    { deadlineAt: 300_000, maxRetries: 5, maxTokens: 100_000 },
    requestedTimeoutBudget(0, 25_000),
    { deadlineAt: 120_000, maxRetries: 3 },
    { deadlineAt: 90_000, maxRetries: 2 },
  );

  assert.deepEqual(budget, {
    deadlineAt: 25_000,
    maxRetries: 2,
    maxTokens: 100_000,
  });
});

test("foreground wait expiry returns a handle without cancelling the task", () => {
  const runtime = new ReferenceRuntime();
  runtime.proposeEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "tool-1" });

  assert.deepEqual(runtime.wait("tool-1", 30_000), {
    kind: "not_ready",
    handle: "task:tool-1",
  });
  assert.equal(runtime.state.scopes["tool-1"]?.state.kind, "waiting");

  runtime.detach("tool-1");
  runtime.completeQuery("answer-1");
  runtime.succeed("tool-1", "artifact-1");

  assert.equal(runtime.state.scopes.query?.state.kind, "succeeded");
  assert.equal(runtime.state.notifications.length, 1);
});

test("operation expiry is independent from foreground wait expiry", () => {
  const runtime = new ReferenceRuntime({ rootBudget: { deadlineAt: 300_000 } });
  runtime.proposeEffect({
    effectId: "effect-1",
    signature: "tool:a",
    scopeId: "tool-1",
    explicitBudget: requestedTimeoutBudget(runtime.state.now, 25_000),
    platformBudget: { deadlineAt: 120_000 },
  });

  assert.deepEqual(runtime.wait("tool-1", 30_000), {
    kind: "ready",
    state: { kind: "failed", errorCode: "operation_expired" },
  });
  assert.equal(runtime.state.scopes.query?.state.kind, "running");
  runtime.completeQuery("bounded failure answer");
});

test("attached children block success while detached children do not", () => {
  const runtime = new ReferenceRuntime();
  runtime.proposeEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "tool-1" });

  assert.throws(() => runtime.completeQuery("answer"), /active attached children/);
  runtime.detach("tool-1");
  runtime.completeQuery("answer");
  assert.equal(runtime.state.scopes.query?.state.kind, "succeeded");
});

test("cancellation propagates to attached children but not detached work", () => {
  const runtime = new ReferenceRuntime();
  runtime.proposeEffect({ effectId: "attached-effect", signature: "tool:a", scopeId: "attached" });
  runtime.proposeEffect({ effectId: "detached-effect", signature: "tool:b", scopeId: "detached" });
  runtime.detach("detached");

  runtime.cancelQuery("operator_cancelled");

  assert.equal(runtime.state.scopes.query?.state.kind, "cancelled");
  assert.equal(runtime.state.scopes.attached?.state.kind, "cancelled");
  assert.equal(runtime.state.scopes.detached?.state.kind, "running");
  runtime.succeed("detached", "artifact-detached");
  assert.equal(runtime.state.notifications.length, 1);
});

test("effect ids are exactly-once receipts and conflicting reuse is rejected", () => {
  const runtime = new ReferenceRuntime();
  const first = runtime.proposeEffect({ effectId: "same", signature: "tool:a:{}", scopeId: "tool-1" });
  const duplicate = runtime.proposeEffect({ effectId: "same", signature: "tool:a:{}", scopeId: "ignored" });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.scopeId, "tool-1");
  assert.equal(Object.keys(runtime.state.effects).length, 1);
  assert.throws(
    () => runtime.proposeEffect({ effectId: "same", signature: "tool:b:{}", scopeId: "tool-2" }),
    /different proposal/,
  );
});

test("replay is deterministic and observers cannot affect execution", () => {
  const runtime = new ReferenceRuntime({ rootBudget: { maxRetries: 2, maxTokens: 50_000 } });
  runtime.proposeEffect({ effectId: "effect-1", signature: "tool:a", scopeId: "tool-1" });
  const beforeObservation = runtime.state;
  const snapshot = runtime.observe();
  assert.equal(snapshot.running, 2);
  assert.deepEqual(runtime.state, beforeObservation);

  runtime.succeed("tool-1", "result-1");
  runtime.completeQuery("answer-1");
  const replayed = runtime.replay();
  assert.deepEqual(replayed.state, runtime.state);
  assert.throws(
    () => replayed.proposeEffect({ effectId: "late", signature: "tool:late", scopeId: "tool-late" }),
    /terminal query/,
  );
});

test("10,000 adversarial budget compositions preserve the meet laws", () => {
  const random = seededRandom(0x5eed1234);
  for (let index = 0; index < 10_000; index += 1) {
    const candidates: BudgetEnvelope[] = [randomBudget(random), randomBudget(random), randomBudget(random)];
    const result = meetBudgets(...candidates);
    for (const [key, value] of Object.entries(result)) {
      const finiteInputs = candidates
        .map((candidate) => candidate[key as keyof BudgetEnvelope])
        .filter((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate));
      assert.equal(value, Math.min(...finiteInputs));
    }
  }
});

test("5,000 randomized crash, detach, cancellation, and replay traces preserve invariants", () => {
  const random = seededRandom(0xdecafbad);
  for (let run = 0; run < 5_000; run += 1) {
    let runtime = new ReferenceRuntime({
      rootBudget: {
        deadlineAt: 60_000 + integer(random, 240_000),
        maxRetries: integer(random, 5),
        maxToolCalls: 1 + integer(random, 8),
      },
    });
    const taskCount = 1 + integer(random, 5);
    for (let task = 0; task < taskCount; task += 1) {
      const scopeId = `run-${run}-task-${task}`;
      const effectId = `effect-${run}-${task}`;
      const explicitTimeoutMs = 1 + integer(random, 120_000);
      const receipt = runtime.proposeEffect({
        effectId,
        signature: `tool:${task}`,
        scopeId,
        explicitBudget: requestedTimeoutBudget(runtime.state.now, explicitTimeoutMs),
        platformBudget: { deadlineAt: runtime.state.now + 180_000 },
      });
      assert.equal(receipt.created, true);
      assert.equal(
        runtime.proposeEffect({ effectId, signature: `tool:${task}`, scopeId: `${scopeId}-duplicate` }).created,
        false,
      );

      if (random() < 0.45) {
        const wait = runtime.wait(scopeId, integer(random, 5_000));
        if (wait.kind === "not_ready") runtime.detach(scopeId);
      }
      if (random() < 0.3) runtime = runtime.replay();
      if (random() < 0.15) runtime.observe();
      const current = runtime.state.scopes[scopeId];
      assert.ok(current);
      if (current.state.kind === "running" || current.state.kind === "waiting") {
        if (random() < 0.2) runtime.fail(scopeId, "scripted_failure");
        else runtime.succeed(scopeId, `result-${run}-${task}`);
      }
    }

    if (random() < 0.2) runtime.cancelQuery("scripted_cancel");
    else runtime.completeQuery(`answer-${run}`);

    const replayed = runtime.replay();
    assert.deepEqual(replayed.state, runtime.state);
    assert.equal(isTerminal(runtime.state.scopes.query!.state), true);
    assert.equal(Object.keys(runtime.state.effects).length, taskCount);
    assert.equal(
      Object.values(runtime.state.scopes).some(
        (scope) => scope.parentScopeId === "query" && scope.ownership === "attached" && !isTerminal(scope.state),
      ),
      false,
    );
  }
});

test("widely different model profiles cannot change execution invariants", () => {
  const profiles = [
    { name: "precise-fast", duplicateRate: 0.001, failureRate: 0.005, detachRate: 0.05 },
    { name: "slow-variable", duplicateRate: 0.03, failureRate: 0.08, detachRate: 0.55 },
    { name: "tool-noisy", duplicateRate: 0.18, failureRate: 0.22, detachRate: 0.35 },
  ];

  for (const [profileIndex, profile] of profiles.entries()) {
    const random = seededRandom(0xabc000 + profileIndex);
    let duplicateProposals = 0;
    for (let run = 0; run < 1_000; run += 1) {
      const runtime = new ReferenceRuntime({ rootBudget: { maxToolCalls: 6, maxRetries: 2 } });
      const effects = 1 + integer(random, 6);
      for (let effect = 0; effect < effects; effect += 1) {
        const effectId = `${profile.name}-${run}-${effect}`;
        const scopeId = `scope-${effectId}`;
        runtime.proposeEffect({ effectId, signature: `tool:${effect}`, scopeId });
        if (random() < profile.duplicateRate) {
          duplicateProposals += 1;
          assert.equal(runtime.proposeEffect({ effectId, signature: `tool:${effect}`, scopeId: "ignored" }).created, false);
        }
        if (random() < profile.detachRate) {
          runtime.wait(scopeId, integer(random, 20_000));
          runtime.detach(scopeId);
        }
        if (random() < profile.failureRate) runtime.fail(scopeId, "profiled_failure");
        else runtime.succeed(scopeId, `result-${effectId}`);
      }
      runtime.completeQuery(`answer-${run}`);
      assert.equal(Object.keys(runtime.state.effects).length, effects);
      assert.equal(runtime.state.scopes.query?.state.kind, "succeeded");
      assert.deepEqual(runtime.replay().state, runtime.state);
    }
    assert.ok(duplicateProposals >= 0);
  }
});

function randomBudget(random: () => number): BudgetEnvelope {
  const budget: BudgetEnvelope = {};
  const keys = [
    "deadlineAt",
    "maxTurns",
    "maxModelCalls",
    "maxToolCalls",
    "maxRetries",
    "maxTokens",
    "maxCost",
    "maxConcurrency",
  ] as const satisfies ReadonlyArray<keyof BudgetEnvelope>;
  for (const key of keys) {
    if (random() < 0.7) budget[key] = 1 + integer(random, 1_000_000);
  }
  return budget;
}

function integer(random: () => number, maxExclusive: number): number {
  return Math.floor(random() * maxExclusive);
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

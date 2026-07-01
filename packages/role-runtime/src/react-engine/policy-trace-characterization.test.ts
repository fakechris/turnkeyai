// Stage 8 engine cleanup (Batch 0.5) — characterization golden enforcement.
//
// Pins the current engine policy-trace decision sequence + cross-module contract
// order to a reviewable golden. If a later batch reorders a hook's module ops,
// drops a policy id, or changes the decision vocabulary, this fast unit test fails
// BEFORE the ~12-minute parity run — the golden is the cheap early tripwire, the
// parity runner is the byte-identical behavior proof.
//
// Regenerate intentionally with:
//   tsx scripts/engine-policy-trace-characterization.ts --write
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPolicyTraceCharacterization,
  renderCharacterizationJson,
} from "./policy-trace-characterization";

const GOLDEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__golden__",
  "engine-policy-trace.golden.json",
);

test("engine policy-trace characterization matches the committed golden", async () => {
  const characterization = await buildPolicyTraceCharacterization();
  const rendered = renderCharacterizationJson(characterization) + "\n";
  const golden = readFileSync(GOLDEN_PATH, "utf8");
  assert.equal(
    rendered,
    golden,
    "policy-trace characterization drifted from the golden. If intentional and " +
      "test-proven, regenerate: tsx scripts/engine-policy-trace-characterization.ts --write",
  );
});

test("characterization is deterministic across builds", async () => {
  const a = renderCharacterizationJson(await buildPolicyTraceCharacterization());
  const b = renderCharacterizationJson(await buildPolicyTraceCharacterization());
  assert.equal(a, b);
});

test("characterization covers every installed hook that the wrapper traces", async () => {
  const characterization = await buildPolicyTraceCharacterization();
  const tracedHooks = new Set(
    characterization.decisionVocabulary.map((row) => row.hook),
  );
  // Every installed hook except onFinalize (intentionally untraced) must appear.
  for (const hook of characterization.installedHookOrder) {
    if (hook === "onFinalize") continue;
    assert.ok(
      tracedHooks.has(hook),
      `characterization is missing a decision row for installed hook ${hook}`,
    );
  }
});

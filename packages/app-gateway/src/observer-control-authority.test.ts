import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_GATEWAY_DIR = path.dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(path.join(APP_GATEWAY_DIR, fileName), "utf8");
}

test("mission observers cannot expose synthetic follow-up control surfaces", () => {
  const bridge = readSource("mission-thread-bridge.ts");
  const daemon = readSource("daemon.ts");

  for (const source of [bridge, daemon]) {
    assert.doesNotMatch(source, /postIncompleteFinalFollowUp/);
    assert.doesNotMatch(source, /postLateWorkerCompletionFollowUp/);
  }
  assert.doesNotMatch(bridge, /System recovery:/);
  assert.doesNotMatch(bridge, /Automatic recovery attempt/);
  assert.doesNotMatch(bridge, /buildIncompleteFinalFollowUp/);
  assert.doesNotMatch(bridge, /buildLateWorkerCompletionFollowUp/);
});

test("completion and observability do not recognize synthetic recovery turns", () => {
  for (const fileName of [
    "mission-completion-evaluator.ts",
    "mission-observability.ts",
  ]) {
    const source = readSource(fileName);
    assert.doesNotMatch(source, /looksLikeAutomaticRecoveryUserMessage/);
    assert.doesNotMatch(source, /System recovery:/);
    assert.doesNotMatch(source, /Automatic recovery attempt/);
  }
});

test("semantic observer modules have no execution dependency", () => {
  for (const fileName of [
    "mission-completion-evaluator.ts",
    "mission-goal-slot-coverage.ts",
    "mission-observability.ts",
  ]) {
    const source = readSource(fileName);
    assert.doesNotMatch(source, /coordination-engine/);
    assert.doesNotMatch(source, /handleUserPost/);
    assert.doesNotMatch(source, /explicit-workflow/);
    assert.doesNotMatch(source, /\.generate\(/);
  }

  const bridge = readSource("mission-thread-bridge.ts");
  for (const forbidden of [
    "handleUserPost",
    "coordination-engine",
    "signalRoleLoop",
    "dispatchToRole",
    "explicitWorkflowRuntime",
    ".generate(",
  ]) {
    assert.equal(
      bridge.includes(forbidden),
      false,
      `mission lifecycle projection must not reach execution sink ${forbidden}`,
    );
  }
});

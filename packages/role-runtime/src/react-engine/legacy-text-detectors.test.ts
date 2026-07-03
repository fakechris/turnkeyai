import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_TEXT_DETECTORS,
  runLegacyTextDetector,
} from "./legacy-text-detectors";

test("legacy text detectors carry required migration metadata", () => {
  assert.ok(LEGACY_TEXT_DETECTORS.length > 0);
  for (const detector of LEGACY_TEXT_DETECTORS) {
    assert.ok(detector.id);
    assert.ok(detector.targetTypedField);
    assert.ok(detector.producer);
    assert.match(
      detector.feasibilityClass,
      /^(already_structured|present_only_as_text|missing_from_producer)$/,
    );
    assert.ok(detector.inventoryRow);
    assert.ok(detector.positiveFixture.trim());
    assert.ok(detector.negativeFixture.trim());
  }
});

test("legacy text detector runner returns facts only", () => {
  const result = runLegacyTextDetector(
    "approval_wait_timeout_text",
    "permission_result: approval_wait_timeout and still pending",
  );

  assert.deepEqual(result, {
    id: "approval_wait_timeout_text",
    matched: true,
    fact: "approval_wait_timeout",
  });
});

test("legacy text detector fixtures match declared behavior", () => {
  for (const detector of LEGACY_TEXT_DETECTORS) {
    const positive = runLegacyTextDetector(detector.id, detector.positiveFixture);
    assert.equal(positive.matched, true, detector.id);
    assert.equal(typeof positive.fact, "string", detector.id);

    const negative = runLegacyTextDetector(detector.id, detector.negativeFixture);
    assert.deepEqual(
      negative,
      { id: detector.id, matched: false, fact: null },
      detector.id,
    );
  }
});

test("legacy text detector runner is safe for unknown detectors", () => {
  assert.deepEqual(runLegacyTextDetector("missing", "anything"), {
    id: "missing",
    matched: false,
    fact: null,
  });
});

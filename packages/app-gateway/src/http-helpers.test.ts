import assert from "node:assert/strict";
import test from "node:test";

import { parseOptionalNonEmptyString, parseRequiredNonEmptyString } from "./http-helpers";

test("parseRequiredNonEmptyString trims and rejects blank values", () => {
  assert.equal(parseRequiredNonEmptyString(null), null);
  assert.equal(parseRequiredNonEmptyString(undefined), null);
  assert.equal(parseRequiredNonEmptyString(""), null);
  assert.equal(parseRequiredNonEmptyString("   "), null);
  assert.equal(parseRequiredNonEmptyString(" thread-1 "), "thread-1");
});

test("parseOptionalNonEmptyString returns undefined for blank values", () => {
  assert.equal(parseOptionalNonEmptyString(null), undefined);
  assert.equal(parseOptionalNonEmptyString(""), undefined);
  assert.equal(parseOptionalNonEmptyString("   "), undefined);
  assert.equal(parseOptionalNonEmptyString(" replay "), "replay");
});

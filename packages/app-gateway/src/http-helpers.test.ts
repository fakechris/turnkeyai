import assert from "node:assert/strict";
import test from "node:test";

import { Readable } from "node:stream";

import {
  parseOptionalNonEmptyString,
  parseRequiredNonEmptyString,
  readJsonBodySafe,
  readOptionalJsonBodySafe,
} from "./http-helpers";

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

test("readJsonBodySafe and readOptionalJsonBodySafe convert malformed JSON into stable parse errors", async () => {
  const bad = Object.assign(Readable.from([Buffer.from("{")]), {
    method: "POST",
    url: "/",
    headers: {},
  }) as any;
  const badOptional = Object.assign(Readable.from([Buffer.from("{")]), {
    method: "POST",
    url: "/",
    headers: {},
  }) as any;

  assert.deepEqual(await readJsonBodySafe(bad), {
    ok: false,
    error: "Invalid JSON",
  });
  assert.deepEqual(await readOptionalJsonBodySafe(badOptional), {
    ok: false,
    error: "Invalid JSON",
  });
});

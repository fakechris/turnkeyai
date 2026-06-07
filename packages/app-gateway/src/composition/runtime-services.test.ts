import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_DAEMON_RUNTIME_LIMITS, resolveRequestEnvelopeLimitOverridesFromEnv } from "./runtime-services";

test("default daemon runtime limits keep outer role loops aligned with the native tool loop budget", () => {
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.memberMaxIterations, 128);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.flowMaxHops, 20);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.maxQueuedHandoffsPerRole, 4);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.maxPerRoleHopCount, 3);
});

test("daemon request envelope limit overrides read only positive integer env values", () => {
  assert.deepEqual(
    resolveRequestEnvelopeLimitOverridesFromEnv({
      TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_CHARS: "20000",
      TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_BYTES: "30000",
      TURNKEYAI_REQUEST_ENVELOPE_MAX_SERIALIZED_BYTES: "not-a-number",
      TURNKEYAI_REQUEST_ENVELOPE_MAX_TOOL_COUNT: "0",
    }),
    {
      maxPromptChars: 20_000,
      maxPromptBytes: 30_000,
    }
  );
  assert.equal(resolveRequestEnvelopeLimitOverridesFromEnv({}), undefined);
});

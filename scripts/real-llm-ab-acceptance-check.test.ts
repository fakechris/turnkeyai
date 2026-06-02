import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRealLlmAbAcceptanceCheckHelpText,
  parseRealLlmAbAcceptanceCheckArgs,
} from "./real-llm-ab-acceptance-check";

test("real LLM A/B acceptance check parses the JSON path", () => {
  assert.deepEqual(parseRealLlmAbAcceptanceCheckArgs(["--json", "/tmp/ab-report.json"]), {
    jsonPath: "/tmp/ab-report.json",
  });
});

test("real LLM A/B acceptance check exposes help", () => {
  assert.deepEqual(parseRealLlmAbAcceptanceCheckArgs(["--help"]), { help: true });
  assert.match(buildRealLlmAbAcceptanceCheckHelpText(), /real LLM A\/B acceptance report check/);
  assert.match(buildRealLlmAbAcceptanceCheckHelpText(), /natural same-scenario/);
});

test("real LLM A/B acceptance check rejects missing or unknown args", () => {
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs([]), /missing required --json/);
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs(["--json"]), /missing value for --json/);
  assert.throws(() => parseRealLlmAbAcceptanceCheckArgs(["--unknown"]), /unknown argument/);
});

import assert from "node:assert/strict";
import test from "node:test";

import type { GenerateTextResult } from "@turnkeyai/llm-adapter/index";

import { finalizeEngineAnswer } from "./finalization-pipeline";

function result(text: string): GenerateTextResult {
  return { text } as GenerateTextResult;
}

test("finalizeEngineAnswer leaves text unchanged when no finalization evidence applies", () => {
  const output = finalizeEngineAnswer({
    result: result("Done."),
    taskPrompt: "Summarize the source.",
    messages: [],
    toolTrace: [],
    evidenceText: "",
  });

  assert.equal(output.text, "Done.");
});

test("finalizeEngineAnswer appends browser failure bucket visibility", () => {
  const output = finalizeEngineAnswer({
    result: result("The page marker was verified."),
    taskPrompt: "Inspect the rendered browser page and report evidence.",
    messages: [],
    toolTrace: [],
    evidenceText: JSON.stringify({ failureBuckets: [{ bucket: "cdp_command_timeout" }] }),
  });

  assert.match(output.text, /Browser limitation:/);
  assert.match(output.text, /cdp_command_timeout/);
});

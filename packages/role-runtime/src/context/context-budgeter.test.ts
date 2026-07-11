import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextBudgeter } from "./context-budgeter";

test("DefaultContextBudgeter does not undercount CJK prompts with chars divided by four", async () => {
  const estimate = await new DefaultContextBudgeter().estimate({
    systemPrompt: "中".repeat(100),
    userPrompt: "文".repeat(100),
  });

  assert.equal(estimate.inputTokens, 200);
});

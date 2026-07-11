import assert from "node:assert/strict";
import test from "node:test";

import {
  calibrateInputTokenEstimate,
  createInputTokenEstimateTracker,
  estimateGenerateTextInputTokens,
  estimateTextTokens,
  resolveInputTokenBudget,
  resolveModelContextWindowTokens,
} from "./token-estimator";

test("token estimator distinguishes ASCII prose from CJK text", () => {
  const ascii = estimateTextTokens("a".repeat(400));
  const cjk = estimateTextTokens("中".repeat(400));

  assert.equal(ascii, 100);
  assert.equal(cjk, 400);
});

test("token estimator budgets structured JSON more conservatively than prose", () => {
  const prose = "status update ready ".repeat(40);
  const structured = JSON.stringify(
    Array.from({ length: 40 }, (_, index) => ({
      id: index,
      status: "ready",
      values: [1, 2, 3],
    })),
  );

  assert.ok(estimateTextTokens(structured) > structured.length / 4);
  assert.ok(
    estimateTextTokens(structured) / structured.length >
      estimateTextTokens(prose) / prose.length,
  );
});

test("generate input estimate includes message overhead and tool schemas", () => {
  const withoutTools = estimateGenerateTextInputTokens({
    messages: [
      { role: "system", content: "You are precise." },
      { role: "user", content: "检查状态并总结。" },
    ],
  });
  const withTools = estimateGenerateTextInputTokens({
    messages: [
      { role: "system", content: "You are precise." },
      { role: "user", content: "检查状态并总结。" },
    ],
    tools: [
      {
        name: "lookup",
        description: "Look up a status record",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  });

  assert.ok(withoutTools > 10);
  assert.ok(withTools > withoutTools);
});

test("usage calibration anchors the next estimate to provider-reported input tokens", () => {
  const calibrated = calibrateInputTokenEstimate({
    currentRawEstimate: 1_150,
    previousRawEstimate: 1_000,
    previousActualInputTokens: 1_200,
  });

  assert.equal(calibrated, 1_350);
  assert.equal(
    calibrateInputTokenEstimate({ currentRawEstimate: 50 }),
    50,
  );
});

test("input token estimate tracker carries provider usage into later rounds", () => {
  const tracker = createInputTokenEstimateTracker();

  assert.deepEqual(tracker.estimate(1_000), {
    rawInputTokens: 1_000,
    estimatedInputTokens: 1_000,
    source: "heuristic",
  });
  tracker.observe({ rawInputTokens: 1_000, actualInputTokens: 1_200 });
  assert.deepEqual(tracker.estimate(1_150), {
    rawInputTokens: 1_150,
    estimatedInputTokens: 1_350,
    source: "provider_calibrated",
  });
});

test("model context windows prefer explicit config and recognize MiniMax M3 1m", () => {
  assert.equal(
    resolveModelContextWindowTokens({
      model: "custom-model",
      contextWindowTokens: 512_000,
    }),
    512_000,
  );
  assert.equal(
    resolveModelContextWindowTokens({ model: "MiniMax-M3[1m]" }),
    1_000_000,
  );
  assert.equal(
    resolveModelContextWindowTokens({ model: "unknown-model" }),
    128_000,
  );
});

test("input token budget reserves output and a window-level safety margin", () => {
  assert.equal(
    resolveInputTokenBudget({
      contextWindowTokens: 1_000_000,
      reservedOutputTokens: 8_192,
    }),
    891_808,
  );
});

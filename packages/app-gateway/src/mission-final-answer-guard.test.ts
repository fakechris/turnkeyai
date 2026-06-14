import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLifecycleStatusText } from "./mission-final-answer-guard";

describe("isLifecycleStatusText", () => {
  it("treats runtime lifecycle status lines as non-answers", () => {
    for (const text of [
      "Lead finished this turn.",
      "Lead started working",
      "Lead picked up the task.",
      "Lead prepared the task context.",
      "Queued the task for role-operator.",
      "role-finance accepted the task.",
      "Woke role-lead to start work.",
      "mission.stalled_no_final_answer",
      "mission.incomplete_final_answer.",
      "mission.cancelled",
    ]) {
      assert.equal(isLifecycleStatusText(text), true, `expected lifecycle: ${text}`);
    }
  });

  it("treats empty / whitespace-only content as a non-answer", () => {
    assert.equal(isLifecycleStatusText(""), true);
    assert.equal(isLifecycleStatusText("   \n  "), true);
  });

  it("ignores surrounding markdown emphasis / quotes when classifying", () => {
    assert.equal(isLifecycleStatusText("**Lead finished this turn.**"), true);
    assert.equal(isLifecycleStatusText('"Lead started working"'), true);
    assert.equal(isLifecycleStatusText("  _Lead picked up the task._  "), true);
  });

  it("does NOT classify a real final answer as a lifecycle status", () => {
    for (const text of [
      "## Recommendation\nUse Globex because its $1.37/M token price is lowest.",
      "Pricing: $42 per seat. Risk: no enterprise SSO. Conclusion: conditional go.",
      "The lead finished reviewing three vendors and recommends Initech.",
      "结论：建议选择 Acme，价格更低且支持搜索。",
    ]) {
      assert.equal(isLifecycleStatusText(text), false, `expected real answer: ${text}`);
    }
  });
});

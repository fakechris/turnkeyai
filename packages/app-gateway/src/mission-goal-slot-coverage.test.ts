import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateMissionGoalSlotCoverage,
  missionGoalSlotIssueDetail,
} from "./mission-goal-slot-coverage";

describe("evaluateMissionGoalSlotCoverage", () => {
  it("requires no slots for a goal with no inferable requirements", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Say hello and introduce yourself.",
      finalText: "Hello, I am the assistant.",
    });
    assert.deepEqual(coverage.required, []);
    assert.deepEqual(coverage.issues, []);
  });

  it("passes a pricing goal when the final answer carries a concrete price", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Find the pricing for the Acme plan.",
      finalText: "Acme Pro costs $42 per seat per month, billed annually.",
    });
    assert.ok(coverage.required.includes("pricing"));
    assert.equal(coverage.issues.length, 0);
  });

  it("flags a pricing goal as missing when no concrete price is present", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Find the pricing for the Acme plan.",
      finalText: "Acme has several plans aimed at teams of different sizes.",
    });
    const pricing = coverage.issues.find((issue) => issue.slot === "pricing");
    assert.ok(pricing, "expected a pricing issue");
    assert.equal(pricing.reason, "missing");
  });

  it("flags a pricing claim the answer itself marks unverified", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Find the pricing for the Acme plan.",
      finalText: "Pricing is not verified; the pricing page did not load.",
    });
    const pricing = coverage.issues.find((issue) => issue.slot === "pricing");
    assert.ok(pricing, "expected a pricing issue");
    assert.equal(pricing.reason, "unverified");
  });

  it("requires the delegated-research slot to meet the inferred stream count", () => {
    const goalText =
      "Delegate to two independent researchers to separately gather evidence and report back.";
    const missing = evaluateMissionGoalSlotCoverage({
      goalText,
      finalText: "One researcher gathered evidence on the topic.",
      evidence: { completedSessionResultCount: 1 },
    });
    assert.ok(missing.required.includes("delegated_independent_research"));
    assert.ok(
      missing.issues.some(
        (issue) => issue.slot === "delegated_independent_research" && issue.reason === "missing"
      )
    );

    const covered = evaluateMissionGoalSlotCoverage({
      goalText,
      finalText: "Two independent researchers each gathered and reported evidence.",
      evidence: { completedSessionResultCount: 2 },
    });
    assert.equal(
      covered.issues.some((issue) => issue.slot === "delegated_independent_research"),
      false
    );
  });

  it("evaluates a Chinese-language goal and answer (not English-marker-only)", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "请调研 Acme 套餐的价格，并指出主要风险。",
      finalText: "价格：Acme 专业版每席位 $42/月。风险：该来源未覆盖企业级合规要求。",
    });
    assert.ok(coverage.required.includes("pricing"));
    assert.ok(coverage.required.includes("risk_or_limitation"));
    assert.equal(coverage.issues.length, 0, JSON.stringify(coverage.issues));
  });

  it("flags a Chinese answer that leaves a required slot unfilled", () => {
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "请调研 Acme 套餐的价格。",
      finalText: "Acme 提供多种面向团队的套餐。",
    });
    assert.ok(
      coverage.issues.some((issue) => issue.slot === "pricing" && issue.reason === "missing")
    );
  });

  it("does not couple to specific vendor names or fixture prices", () => {
    // A real, non-fixture vendor with an arbitrary price must satisfy the
    // pricing slot — the gate must infer from structure, not memorized strings.
    const coverage = evaluateMissionGoalSlotCoverage({
      goalText: "Compare the pricing of Globex and Initech model APIs.",
      finalText:
        "Globex charges $1.37 per million input tokens; Initech charges $2.05 per million input tokens.",
    });
    assert.ok(coverage.required.includes("pricing"));
    assert.equal(
      coverage.issues.some((issue) => issue.slot === "pricing"),
      false
    );
  });

  it("renders a human-readable detail string for issues and for clean coverage", () => {
    assert.match(missionGoalSlotIssueDetail([]), /All goal-critical slots/);
    assert.match(
      missionGoalSlotIssueDetail([{ slot: "pricing", label: "pricing", reason: "missing" }]),
      /pricing \(missing\)/
    );
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserTransportSoakResult } from "./browser-transport-soak";
import type { ReleaseReadinessResult } from "./release-readiness";
import type { ValidationRunResult, ValidationSuiteId } from "./validation-suite";
import {
  isValidationProfileId,
  listValidationProfiles,
  runValidationProfile,
  summarizeValidationProfileResult,
  summarizeValidationStage,
} from "./validation-profile";

test("validation profiles list built-in hardening profiles", () => {
  const profiles = listValidationProfiles();

  assert.deepEqual(
    profiles.map((profile) => profile.profileId),
    ["smoke", "phase1-e2e", "nightly", "prerelease", "weekly"]
  );
  const phase1E2e = profiles.find((profile) => profile.profileId === "phase1-e2e");
  assert.ok(phase1E2e);
  assert.equal(phase1E2e.includeReleaseReadiness, false);
  assert.equal(phase1E2e.soakSeriesCycles, 1);
  assert.equal(phase1E2e.transportSoakCycles, 1);
  assert.deepEqual(phase1E2e.transportSoakTargets, ["relay", "direct-cdp"]);
  assert.ok(phase1E2e.validationSelectors.includes("acceptance:phase1-production-closure"));
  assert.ok(profiles.find((profile) => profile.profileId === "nightly")?.includeReleaseReadiness);
  assert.deepEqual(
    profiles.find((profile) => profile.profileId === "weekly")?.soakSeriesSelectors,
    ["soak", "realworld", "acceptance"]
  );
  assert.equal(profiles.find((profile) => profile.profileId === "nightly")?.transportSoakCycles, 1);
  assert.deepEqual(
    profiles.find((profile) => profile.profileId === "prerelease")?.transportSoakTargets,
    ["relay", "direct-cdp"]
  );
});

test("validation profile id guard accepts known profiles", () => {
  assert.equal(isValidationProfileId("smoke"), true);
  assert.equal(isValidationProfileId("phase1-e2e"), true);
  assert.equal(isValidationProfileId("weekly"), true);
  assert.equal(isValidationProfileId("unknown"), false);
  assert.equal(isValidationProfileId("constructor"), false);
  assert.equal(isValidationProfileId("__proto__"), false);
});

test("phase1-e2e validation profile runs e2e validation, soak, and transport stages", async () => {
  let releaseCalls = 0;
  const validationCalls: string[][] = [];
  const transportSoakCalls: Array<{ cycles?: number; targets?: string[] }> = [];

  const result = await runValidationProfile(
    "phase1-e2e",
    {},
    {
      releaseReadinessRunner: async () => {
        releaseCalls += 1;
        return makeReleaseReadinessResult();
      },
      validationRunner: (selectors) => {
        validationCalls.push([...(selectors ?? [])]);
        return makeSuiteScopedValidationRunResult(selectors);
      },
      transportSoakRunner: async (options) => {
        transportSoakCalls.push({
          ...(options.cycles !== undefined ? { cycles: options.cycles } : {}),
          ...(options.targets ? { targets: options.targets } : {}),
        });
        return makeTransportSoakResult();
      },
    }
  );

  assert.equal(result.status, "passed");
  assert.equal(result.totalStages, 3);
  assert.deepEqual(
    result.stages.map((stage) => stage.stageId),
    ["validation-run", "soak-series", "transport-soak"]
  );
  assert.equal(releaseCalls, 0);
  assert.deepEqual(validationCalls.slice(0, 5), [
    [
      "regression:browser-transport-real-world-e2e-keeps-replay-operator-aligned",
      "regression:operator-case-semantics-separate-active-manual-from-resolved-recent",
      "regression:context-real-task-attachment-pressure-keeps-critical-carry-forward",
      "regression:parallel-governance-contract-dedupes-retried-audits-by-case",
    ],
    ["acceptance:phase1-production-closure", "acceptance:browser-transport-reconnect-workflow", "acceptance:operator-cross-surface-consistency"],
    ["realworld:phase1-production-closure-runbook", "realworld:browser-research-transport-reconnect-runbook"],
    ["failure:operator-triage-compound-incident"],
    ["soak:phase1-production-closure-long-chain"],
  ]);
  assert.deepEqual(validationCalls.slice(5), [
    ["acceptance:phase1-production-closure"],
    ["realworld:phase1-production-closure-runbook"],
    ["soak:phase1-production-closure-long-chain"],
  ]);
  assert.deepEqual(transportSoakCalls, [{ cycles: 1, targets: ["relay", "direct-cdp"] }]);
});

test("smoke validation profile only runs validation catalog stage", async () => {
  let releaseCalls = 0;
  const validationCalls: string[][] = [];
  const result = await runValidationProfile(
    "smoke",
    {},
    {
      releaseReadinessRunner: async () => {
        releaseCalls += 1;
        return makeReleaseReadinessResult();
      },
      validationRunner: (selectors) => {
        validationCalls.push([...(selectors ?? [])]);
        return makeSuiteScopedValidationRunResult(selectors);
      },
      transportSoakRunner: async () => makeTransportSoakResult(),
    }
  );

  assert.equal(result.status, "passed");
  assert.equal(result.totalStages, 1);
  assert.equal(result.stages[0]?.stageId, "validation-run");
  assert.equal(releaseCalls, 0);
  assert.deepEqual(validationCalls, [
    ["regression:browser-recovery-cold-reopen-outcome", "regression:runtime-prompt-console-summarizes-boundaries", "regression:governance-publish-readback-verifies-closure"],
    ["acceptance:browser-ownership-reclaim-isolation"],
    ["realworld:browser-research-recovery-runbook", "realworld:governed-publish-readback-verification"],
  ]);
  assert.match(summarizeValidationProfileResult(result), /stages=1\/1/);
  assert.match(summarizeValidationStage(result.stages[0]!), /suites=3\/3/);
});

test("nightly validation profile aggregates validation, release, and soak failures", async () => {
  let validationStageCalls = 0;
  const validationCalls: string[][] = [];
  const transportSoakCalls: Array<{ cycles?: number; targets?: string[] }> = [];
  const result = await runValidationProfile(
    "nightly",
    {},
    {
      releaseReadinessRunner: async () =>
        makeReleaseReadinessResult({
          status: "failed",
          passedChecks: 1,
          failedChecks: 1,
          checks: [
            { checkId: "pack-cli", title: "Pack CLI", status: "passed", details: [] },
            { checkId: "publish-dry-run", title: "Publish dry-run", status: "failed", details: ["dry-run failed"] },
          ],
        }),
      validationRunner: (selectors) => {
        validationCalls.push([...(selectors ?? [])]);
        const suiteId = getSuiteIdFromSelectors(selectors);
        if (validationStageCalls < 4 && suiteId === "acceptance") {
          validationStageCalls += 1;
          return makeSuiteScopedValidationRunResult(selectors, { suiteId, failed: true });
        }
        validationStageCalls += 1;
        if (suiteId === "soak" && validationStageCalls > 4) {
          return makeSuiteScopedValidationRunResult(selectors, { suiteId, failed: true });
        }
        return makeSuiteScopedValidationRunResult(selectors, { suiteId });
      },
      transportSoakRunner: async (options) => {
        transportSoakCalls.push({
          ...(options.cycles !== undefined ? { cycles: options.cycles } : {}),
          ...(options.targets ? { targets: options.targets } : {}),
        });
        return makeTransportSoakResult({
          status: "failed",
          passedCycles: 0,
          failedCycles: 1,
          totalTargetRuns: 2,
          failedTargetRuns: 1,
          targetAggregates: [
            {
              target: "relay",
              cycles: 1,
              passedCycles: 0,
              failedCycles: 1,
              failureBuckets: [{ bucket: "peer-timeout", count: 1 }],
              acceptanceChecks: [{ checkId: "relay-peer-multiplex", passed: 0, failed: 1, skipped: 0 }],
            },
            {
              target: "direct-cdp",
              cycles: 1,
              passedCycles: 1,
              failedCycles: 0,
              failureBuckets: [{ bucket: "none", count: 1 }],
              acceptanceChecks: [{ checkId: "network-controls", passed: 1, failed: 0, skipped: 0 }],
            },
          ],
        });
      },
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.totalStages, 4);
  assert.equal(result.issues.length, 4);
  assert.deepEqual(validationCalls.slice(0, 4), [
    ["failure"],
    ["acceptance"],
    ["realworld"],
    ["soak"],
  ]);
  assert.deepEqual(validationCalls.slice(4, 7), [
    ["soak"],
    ["realworld"],
    ["acceptance"],
  ]);
  assert.deepEqual(transportSoakCalls, [{ cycles: 1, targets: ["relay", "direct-cdp"] }]);
  assert.ok(result.issues.some((issue) => issue.kind === "validation-item" && issue.scope === "acceptance:browser-ownership-reclaim-isolation"));
  assert.ok(result.issues.some((issue) => issue.kind === "release-check" && issue.scope === "publish-dry-run"));
  assert.ok(result.issues.some((issue) => issue.kind === "soak-suite" && issue.scope === "soak"));
  assert.ok(result.issues.some((issue) => issue.kind === "transport-target" && issue.scope === "relay"));
});

function makeSuiteScopedValidationRunResult(
  selectors?: string[],
  options: {
    suiteId?: ValidationSuiteId;
    failed?: boolean;
  } = {}
): ValidationRunResult {
  const suiteId = options.suiteId ?? getSuiteIdFromSelectors(selectors);
  const failed = options.failed ?? false;
  const itemId = suiteId === "acceptance"
    ? "browser-ownership-reclaim-isolation"
    : suiteId === "realworld"
      ? "browser-research-recovery-runbook"
      : `${suiteId}-sample`;
  const itemTitle = suiteId === "acceptance" ? "Ownership reclaim" : `${suiteId} scenario`;
  const area = suiteId === "acceptance" || suiteId === "realworld" ? "browser" : suiteId;
  const totalCases = failed ? 2 : 2;
  const failedCases = failed ? 1 : 0;
  const passedCases = totalCases - failedCases;
  const totalItems = 1;
  const failedItems = failed ? 1 : 0;
  const passedItems = totalItems - failedItems;

  return {
    totalSuites: 1,
    passedSuites: failed ? 0 : 1,
    failedSuites: failed ? 1 : 0,
    totalItems,
    passedItems,
    failedItems,
    totalCases,
    passedCases,
    failedCases,
    suites: [
      {
        suiteId,
        title: suiteId[0]!.toUpperCase() + suiteId.slice(1),
        summary: suiteId,
        totalItems,
        passedItems,
        failedItems,
        totalCases,
        passedCases,
        failedCases,
        items: [
          {
            suiteId,
            itemId,
            area,
            title: itemTitle,
            summary: "summary",
            status: failed ? "failed" : "passed",
            totalCases,
            passedCases,
            failedCases,
            caseResults: [],
          },
        ],
      },
    ],
  };
}

function makeReleaseReadinessResult(
  overrides: Partial<ReleaseReadinessResult> = {}
): ReleaseReadinessResult {
  return {
    status: "passed",
    totalChecks: 2,
    passedChecks: 2,
    failedChecks: 0,
    artifact: {
      filename: "turnkeyai-cli.tgz",
      totalFiles: 10,
    },
    checks: [
      { checkId: "pack-cli", title: "Pack CLI", status: "passed", details: [] },
      { checkId: "publish-dry-run", title: "Publish dry-run", status: "passed", details: [] },
    ],
    ...overrides,
  };
}

function makeTransportSoakResult(
  overrides: Partial<BrowserTransportSoakResult> = {}
): BrowserTransportSoakResult {
  return {
    status: "passed",
    totalCycles: 1,
    passedCycles: 1,
    failedCycles: 0,
    totalTargetRuns: 2,
    failedTargetRuns: 0,
    durationMs: 25,
    targets: ["relay", "direct-cdp"],
    cycleResults: [
      {
        cycleNumber: 1,
        status: "passed",
        durationMs: 25,
        targets: [
          {
            target: "relay",
            status: "passed",
            durationMs: 10,
            failureBucket: "none",
            summary: "relay passed",
            output: "",
          },
          {
            target: "direct-cdp",
            status: "passed",
            durationMs: 15,
            failureBucket: "none",
            summary: "direct-cdp passed",
            output: "",
          },
        ],
      },
    ],
    targetAggregates: [
      {
        target: "relay",
        cycles: 1,
        passedCycles: 1,
        failedCycles: 0,
        failureBuckets: [{ bucket: "none", count: 1 }],
        acceptanceChecks: [{ checkId: "network-controls", passed: 1, failed: 0, skipped: 0 }],
      },
      {
        target: "direct-cdp",
        cycles: 1,
        passedCycles: 1,
        failedCycles: 0,
        failureBuckets: [{ bucket: "none", count: 1 }],
        acceptanceChecks: [{ checkId: "network-controls", passed: 1, failed: 0, skipped: 0 }],
      },
    ],
    ...overrides,
  };
}

function getSuiteIdFromSelectors(selectors?: string[]): ValidationSuiteId {
  const firstSelector = selectors?.[0];
  const prefix = firstSelector?.split(":", 1)[0];
  switch (prefix) {
    case "regression":
    case "soak":
    case "failure":
    case "acceptance":
    case "realworld":
      return prefix;
    default:
      return "realworld";
  }
}

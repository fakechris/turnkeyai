import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type { ValidationOpsRunRecord } from "@turnkeyai/core-types/team";

import { createRouteIdempotencyStore } from "../idempotency-store";
import { handleValidationRoutes, type ValidationRouteDeps } from "./validation-routes";

function createRequest(input: { method: string; url: string; body?: unknown; headers?: Record<string, string> }) {
  const body =
    input.body === undefined ? [] : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(body), {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
  }) as any;
}

function createResponse() {
  let payload = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as any;
  return {
    res,
    headers,
    get json() {
      return payload ? JSON.parse(payload) : undefined;
    },
  };
}

function createDeps(overrides: Partial<ValidationRouteDeps> = {}): ValidationRouteDeps {
  const records: ValidationOpsRunRecord[] = [];
  return {
    validationOpsRunStore: {
      async get() {
        return null;
      },
      async put(record: ValidationOpsRunRecord) {
        records.push(record);
      },
      async list(limit?: number) {
        const sorted = [...records].sort((left, right) => right.completedAt - left.completedAt);
        return limit ? sorted.slice(0, limit) : sorted;
      },
    } as any,
    createValidationOpsRunId: (kind) => `${kind}-run-1`,
    async writeValidationArtifact(kind: string, runId: string) {
      return `${kind}/${runId}.json`;
    },
    async runBrowserTransportSoakViaCli(options) {
      return {
        status: "passed",
        cycles: options?.cycles ?? 1,
        targets: options?.targets ?? ["relay"],
        totalCycles: options?.cycles ?? 1,
        passedCycles: options?.cycles ?? 1,
        failedCycles: 0,
        totalTargetRuns: (options?.targets ?? ["relay"]).length,
        failedTargetRuns: 0,
        durationMs: 10,
        cycleResults: [],
        targetAggregates: (options?.targets ?? ["relay"]).map((target) => ({
          target,
          cycles: options?.cycles ?? 1,
          passedCycles: options?.cycles ?? 1,
          failedCycles: 0,
          failureBuckets: [{ bucket: "none", count: options?.cycles ?? 1 }],
          acceptanceChecks: [{ checkId: "network-controls", passed: options?.cycles ?? 1, failed: 0, skipped: 0 }],
        })),
      } as any;
    },
    async runReleaseReadiness() {
      return {
        status: "passed",
        totalChecks: 2,
        passedChecks: 2,
        failedChecks: 0,
        artifact: {
          filename: "turnkeyai-cli-0.1.1.tgz",
        },
        checks: [
          { checkId: "pack-cli", title: "Pack CLI", status: "passed", details: [] },
          { checkId: "publish-dry-run", title: "Publish dry-run", status: "passed", details: [] },
        ],
      };
    },
    ...overrides,
  };
}

test("validation routes trim selectors for regression and validation suite runs", async () => {
  const regression = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/regression-cases/run",
      body: { caseIds: [" ", "browser-recovery-cold-reopen-outcome"] },
    }),
    res: regression.res,
    url: new URL("http://127.0.0.1/regression-cases/run"),
    deps: createDeps(),
  });
  assert.equal(regression.res.statusCode, 200);
  assert.equal(regression.json.totalCases, 1);
  assert.equal(regression.json.results.length, 1);

  const validation = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/validation-cases/run",
      body: { selectors: [" ", "soak:browser-recovery-long-chain"] },
    }),
    res: validation.res,
    url: new URL("http://127.0.0.1/validation-cases/run"),
    deps: createDeps(),
  });
  assert.equal(validation.res.statusCode, 200);
  assert.equal(validation.json.totalSuites, 1);
  assert.equal(validation.json.suites[0]?.suiteId, "soak");
});

test("validation routes reject unknown profile ids after trimming", async () => {
  const response = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/validation-profiles/run",
      body: { profileId: "   " },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/validation-profiles/run"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Unknown validation profile" });
});

test("validation routes run the phase1-e2e profile through validation, soak, and transport stages", async () => {
  const response = createResponse();
  const transportCalls: unknown[] = [];
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/validation-profiles/run",
      body: { profileId: " phase1-e2e " },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/validation-profiles/run"),
    deps: createDeps({
      async runBrowserTransportSoakViaCli(options) {
        transportCalls.push(options);
        return createDeps().runBrowserTransportSoakViaCli(options);
      },
    }),
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.profileId, "phase1-e2e");
  assert.equal(response.json.status, "passed");
  assert.deepEqual(
    response.json.stages.map((stage: { stageId: string }) => stage.stageId),
    ["validation-run", "soak-series", "transport-soak"]
  );
  assert.deepEqual(transportCalls, [{ cycles: 1, targets: ["relay", "direct-cdp"] }]);
});

test("validation routes reject malformed transport-soak booleans and trim targets", async () => {
  const invalid = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/transport-soak/run",
      body: { verifyReconnect: "yes" },
    }),
    res: invalid.res,
    url: new URL("http://127.0.0.1/transport-soak/run"),
    deps: createDeps(),
  });
  assert.equal(invalid.res.statusCode, 400);
  assert.deepEqual(invalid.json, { error: "Invalid verifyReconnect: must be a boolean" });

  const valid = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/transport-soak/run",
      body: {
        targets: [" relay ", " ", "direct-cdp"],
        verifyReconnect: true,
      },
    }),
    res: valid.res,
    url: new URL("http://127.0.0.1/transport-soak/run"),
    deps: createDeps(),
  });
  assert.equal(valid.res.statusCode, 200);
  assert.deepEqual(valid.json.targets, ["relay", "direct-cdp"]);
});

test("validation routes run phase1 readiness through all exit gates and records readiness", async () => {
  const response = createResponse();
  const transportCalls: unknown[] = [];

  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/phase1-readiness/run",
      body: {
        transportCycles: 2,
        soakCycles: 2,
        releaseSkipBuild: true,
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/phase1-readiness/run"),
    deps: createDeps({
      async runBrowserTransportSoakViaCli(options) {
        transportCalls.push(options);
        return createDeps().runBrowserTransportSoakViaCli(options);
      },
    }),
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.status, "passed");
  assert.deepEqual(
    response.json.stages.map((stage: { stageId: string }) => stage.stageId),
    ["validation-profile", "transport-soak", "release-readiness", "soak-series"]
  );
  assert.equal(response.json.validationOps.readiness.status, "passed");
  assert.equal(response.json.validationOps.readiness.passedGates, 4);
  assert.equal(response.json.northStar.closedLoopStatus, "completed");
  assert.equal(response.json.northStar.closedLoopRate, 1);
  assert.equal(response.json.nextCommand, "validation-ops");
  assert.deepEqual(transportCalls, [
    { cycles: 1, targets: ["relay", "direct-cdp"] },
    { cycles: 2, targets: ["relay", "direct-cdp"], verifyReconnect: true, verifyWorkflowLog: true },
  ]);
});

test("validation routes reject malformed phase1 readiness options", async () => {
  const response = createResponse();

  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/phase1-readiness/run",
      body: { transportCycles: 0 },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/phase1-readiness/run"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid transportCycles: must be a positive integer" });
});

test("validation routes run phase1 baseline and expose fresh baseline status in validation ops", async () => {
  const response = createResponse();
  const transportCalls: unknown[] = [];

  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/phase1-baseline/run",
      body: {
        runs: 2,
        transportCycles: 2,
        soakCycles: 2,
        releaseSkipBuild: true,
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/phase1-baseline/run"),
    deps: createDeps({
      async runBrowserTransportSoakViaCli(options) {
        transportCalls.push(options);
        return createDeps().runBrowserTransportSoakViaCli(options);
      },
    }),
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.status, "passed");
  assert.equal(response.json.requiredRuns, 2);
  assert.equal(response.json.consecutivePassedRuns, 2);
  assert.equal(response.json.baseline.status, "fresh-passing");
  assert.equal(response.json.validationOps.baseline.status, "fresh-passing");
  assert.equal(response.json.validationOps.baseline.consecutivePassedRuns, 2);
  assert.ok(
    response.json.validationOps.latestRuns.some((run: { runType: string }) => run.runType === "phase1-baseline")
  );
  assert.equal(response.json.nextCommand, "validation-ops");
  assert.deepEqual(transportCalls, [
    { cycles: 1, targets: ["relay", "direct-cdp"] },
    { cycles: 2, targets: ["relay", "direct-cdp"], verifyReconnect: true, verifyWorkflowLog: true },
    { cycles: 1, targets: ["relay", "direct-cdp"] },
    { cycles: 2, targets: ["relay", "direct-cdp"], verifyReconnect: true, verifyWorkflowLog: true },
  ]);
});

test("validation routes count trailing clean baseline runs from the latest run", async () => {
  const response = createResponse();
  let readinessTransportCallCount = 0;

  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/phase1-baseline/run",
      body: {
        runs: 3,
        transportCycles: 2,
        soakCycles: 2,
        releaseSkipBuild: true,
      },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/phase1-baseline/run"),
    deps: createDeps({
      async runBrowserTransportSoakViaCli(options) {
        if (options?.verifyReconnect && options?.verifyWorkflowLog) {
          readinessTransportCallCount += 1;
          if (readinessTransportCallCount === 1) {
            return {
              status: "failed",
              cycles: options.cycles ?? 1,
              targets: options.targets ?? ["relay"],
              totalCycles: options.cycles ?? 1,
              passedCycles: 0,
              failedCycles: options.cycles ?? 1,
              totalTargetRuns: (options.targets ?? ["relay"]).length,
              failedTargetRuns: (options.targets ?? ["relay"]).length,
              durationMs: 10,
              cycleResults: [],
              targetAggregates: (options.targets ?? ["relay"]).map((target) => ({
                target,
                cycles: options.cycles ?? 1,
                passedCycles: 0,
                failedCycles: options.cycles ?? 1,
                failureBuckets: [{ bucket: "transport", count: options.cycles ?? 1 }],
                acceptanceChecks: [{ checkId: "network-controls", passed: 0, failed: options.cycles ?? 1, skipped: 0 }],
              })),
            } as any;
          }
        }
        return createDeps().runBrowserTransportSoakViaCli(options);
      },
    }),
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.status, "failed");
  assert.equal(response.json.consecutivePassedRuns, 2);
  assert.equal(response.json.baseline.status, "fresh-failing");
  assert.equal(response.json.validationOps.baseline.consecutivePassedRuns, 2);
  assert.match(response.json.failureReasons[0], /run 1:/);
});

test("validation routes reject malformed phase1 baseline options", async () => {
  const response = createResponse();

  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/phase1-baseline/run",
      body: { runs: 0 },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/phase1-baseline/run"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid runs: must be an integer between 1 and 50" });
});

test("validation routes reject oversized phase1 baseline cycles", async () => {
  const response = createResponse();

  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/phase1-baseline/run",
      body: { transportCycles: 51 },
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/phase1-baseline/run"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid transportCycles: must be an integer between 1 and 50" });
});

test("validation routes return 400 for malformed JSON bodies", async () => {
  const response = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/validation-cases/run",
      body: "{",
    }),
    res: response.res,
    url: new URL("http://127.0.0.1/validation-cases/run"),
    deps: createDeps(),
  });

  assert.equal(response.res.statusCode, 400);
  assert.deepEqual(response.json, { error: "Invalid JSON" });
});

// P1.6b — idempotency contract for validation /run endpoints. Two cases:
// (1) retried POST with same Idempotency-Key replays without re-running the
// underlying suite (these are minutes-long runs; double-trigger wastes
// compute); (2) same key reused with a different request shape returns 409.

test("validation routes replay idempotent /transport-soak/run without re-running the soak", async () => {
  let soakRuns = 0;
  const deps = createDeps({
    idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    async runBrowserTransportSoakViaCli(options) {
      soakRuns += 1;
      return {
        status: "passed",
        cycles: options?.cycles ?? 1,
        targets: options?.targets ?? ["relay"],
        totalCycles: options?.cycles ?? 1,
        passedCycles: options?.cycles ?? 1,
        failedCycles: 0,
        totalTargetRuns: (options?.targets ?? ["relay"]).length,
        failedTargetRuns: 0,
        durationMs: 10,
        cycleResults: [],
        targetAggregates: [],
        runIndex: soakRuns,
      } as any;
    },
  });

  const first = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/transport-soak/run",
      headers: { "idempotency-key": "ts-key-1" },
      body: { cycles: 2, targets: ["relay"] },
    }),
    res: first.res,
    url: new URL("http://127.0.0.1/transport-soak/run"),
    deps,
  });
  assert.equal(first.res.statusCode, 200);
  assert.equal(soakRuns, 1);

  const second = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/transport-soak/run",
      headers: { "idempotency-key": "ts-key-1" },
      body: { cycles: 2, targets: ["relay"] },
    }),
    res: second.res,
    url: new URL("http://127.0.0.1/transport-soak/run"),
    deps,
  });

  assert.equal(soakRuns, 1, "retried POST with same Idempotency-Key must NOT re-run the soak");
  assert.equal(second.res.statusCode, 200);
  assert.equal(second.headers.get("x-turnkeyai-idempotency-status"), "replayed");
});

test("validation routes return 409 on /transport-soak/run idempotency key reuse with different cycles", async () => {
  let soakRuns = 0;
  const deps = createDeps({
    idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
    async runBrowserTransportSoakViaCli(options) {
      soakRuns += 1;
      return {
        status: "passed",
        cycles: options?.cycles ?? 1,
        targets: options?.targets ?? ["relay"],
        totalCycles: options?.cycles ?? 1,
        passedCycles: options?.cycles ?? 1,
        failedCycles: 0,
        totalTargetRuns: 1,
        failedTargetRuns: 0,
        durationMs: 10,
        cycleResults: [],
        targetAggregates: [],
      } as any;
    },
  });

  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/transport-soak/run",
      headers: { "idempotency-key": "collision" },
      body: { cycles: 2 },
    }),
    res: createResponse().res,
    url: new URL("http://127.0.0.1/transport-soak/run"),
    deps,
  });

  const conflict = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/transport-soak/run",
      headers: { "idempotency-key": "collision" },
      body: { cycles: 5 },
    }),
    res: conflict.res,
    url: new URL("http://127.0.0.1/transport-soak/run"),
    deps,
  });

  assert.equal(soakRuns, 1, "conflicting second request must not re-run");
  assert.equal(conflict.res.statusCode, 409);
  assert.equal(conflict.json.error, "idempotency key reuse does not match the original request");
});

test("validation routes scope idempotency keys per route — same key + identical fingerprint shape on different routes do not collide", async () => {
  // Codex review of P1.6b caught that the first version of this test used two
  // routes (/regression-cases/run vs /soak-cases/run) whose fingerprints
  // happened to differ by key name (`caseIds` vs `scenarioIds`), so it
  // would pass even with a scope-collision bug. This version uses two routes
  // with IDENTICAL fingerprint shape (both /soak-cases/run and
  // /acceptance-cases/run fingerprint as `{scenarioIds}`), so only the
  // per-route scope can prevent the 409.
  const baseDeps = createDeps({
    idempotencyStore: createRouteIdempotencyStore({ now: () => 1000 }),
  });

  const soak = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/soak-cases/run",
      headers: { "idempotency-key": "shared-key" },
      body: { scenarioIds: ["shared-scenario"] },
    }),
    res: soak.res,
    url: new URL("http://127.0.0.1/soak-cases/run"),
    deps: baseDeps,
  });
  // Body shape is intentionally invalid for the suite (no such scenario id),
  // but the route validation also runs against the actual harness; the test
  // here cares only about NOT returning 409. Any 200 or 400 is acceptable —
  // 409 would prove the scope isolation failed.
  assert.notEqual(soak.res.statusCode, 409, "first call must not 409");

  const acceptance = createResponse();
  await handleValidationRoutes({
    req: createRequest({
      method: "POST",
      url: "/acceptance-cases/run",
      headers: { "idempotency-key": "shared-key" },
      body: { scenarioIds: ["shared-scenario"] },
    }),
    res: acceptance.res,
    url: new URL("http://127.0.0.1/acceptance-cases/run"),
    deps: baseDeps,
  });
  assert.notEqual(acceptance.res.statusCode, 409, "second call on a DIFFERENT route with IDENTICAL fingerprint must not 409 — scope isolation guards this");
});

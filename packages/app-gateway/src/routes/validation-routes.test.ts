import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleValidationRoutes, type ValidationRouteDeps } from "./validation-routes";

function createRequest(input: { method: string; url: string; body?: unknown }) {
  const body =
    input.body === undefined ? [] : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(body), {
    method: input.method,
    url: input.url,
    headers: {},
  }) as any;
}

function createResponse() {
  let payload = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as any;
  return {
    res,
    get json() {
      return payload ? JSON.parse(payload) : undefined;
    },
  };
}

function createDeps(overrides: Partial<ValidationRouteDeps> = {}): ValidationRouteDeps {
  return {
    validationOpsRunStore: {
      async get() {
        return null;
      },
      async put() {},
      async list(limit?: number) {
        return limit ? [] : [];
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
        })),
      } as any;
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

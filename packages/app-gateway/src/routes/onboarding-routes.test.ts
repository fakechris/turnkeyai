import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { handleOnboardingRoutes } from "./onboarding-routes";

function createRequest(input: {
  method: string;
  url: string;
  body?: unknown;
}): http.IncomingMessage {
  const chunks =
    input.body === undefined
      ? []
      : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(chunks), {
    method: input.method,
    url: input.url,
    headers: {},
  }) as unknown as http.IncomingMessage;
}

function createResponse() {
  let payload = "";
  let statusCode = 200;
  const res = {
    statusCode,
    setHeader: () => {},
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as http.ServerResponse;
  return {
    res: new Proxy(res, {
      set(target, key, value) {
        if (key === "statusCode") statusCode = Number(value);
        // @ts-expect-error proxy passthrough
        target[key] = value;
        return true;
      },
    }) as http.ServerResponse,
    getStatus: () => statusCode,
    getJson: () => (payload ? JSON.parse(payload) : undefined),
  };
}

function tmpState(): { stateFile: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-onboarding-routes-"));
  return {
    stateFile: path.join(dir, "onboarding.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const clock = { now: () => 1_700_000_000_000 };

describe("onboarding-routes", () => {
  it("GET /onboarding/state returns the default first-run marker", async () => {
    const t = tmpState();
    try {
      const { res, getStatus, getJson } = createResponse();
      const handled = await handleOnboardingRoutes({
        req: createRequest({ method: "GET", url: "/onboarding/state" }),
        res,
        url: new URL("http://127.0.0.1/onboarding/state"),
        deps: { stateFile: t.stateFile, clock },
      });
      assert.equal(handled, true);
      assert.equal(getStatus(), 200);
      assert.deepEqual(getJson(), {
        completedAt: null,
        transportChosen: null,
        transportVerifiedAt: null,
        step: null,
        updatedAt: null,
      });
    } finally {
      t.cleanup();
    }
  });

  it("PUT /onboarding/state persists marker fields and trims strings", async () => {
    const t = tmpState();
    try {
      const put = createResponse();
      await handleOnboardingRoutes({
        req: createRequest({
          method: "PUT",
          url: "/onboarding/state",
          body: {
            completedAt: 1_700_000_000_123,
            transportChosen: " local ",
            transportVerifiedAt: 1_700_000_000_456,
            step: " ready ",
          },
        }),
        res: put.res,
        url: new URL("http://127.0.0.1/onboarding/state"),
        deps: { stateFile: t.stateFile, clock },
      });

      assert.equal(put.getStatus(), 200);
      assert.deepEqual(put.getJson(), {
        completedAt: 1_700_000_000_123,
        transportChosen: "local",
        transportVerifiedAt: 1_700_000_000_456,
        step: "ready",
        updatedAt: clock.now(),
      });

      const get = createResponse();
      await handleOnboardingRoutes({
        req: createRequest({ method: "GET", url: "/onboarding/state" }),
        res: get.res,
        url: new URL("http://127.0.0.1/onboarding/state"),
        deps: { stateFile: t.stateFile, clock },
      });
      assert.deepEqual(get.getJson(), put.getJson());
    } finally {
      t.cleanup();
    }
  });

  it("PUT /onboarding/state rejects malformed values", async () => {
    const t = tmpState();
    try {
      const { res, getStatus, getJson } = createResponse();
      await handleOnboardingRoutes({
        req: createRequest({
          method: "PUT",
          url: "/onboarding/state",
          body: { completedAt: -1 },
        }),
        res,
        url: new URL("http://127.0.0.1/onboarding/state"),
        deps: { stateFile: t.stateFile, clock },
      });
      assert.equal(getStatus(), 400);
      assert.deepEqual(getJson(), {
        error: "completedAt must be a non-negative finite number or null",
      });
    } finally {
      t.cleanup();
    }
  });

  it("ignores unrelated paths", async () => {
    const t = tmpState();
    try {
      const handled = await handleOnboardingRoutes({
        req: createRequest({ method: "GET", url: "/not-onboarding" }),
        res: createResponse().res,
        url: new URL("http://127.0.0.1/not-onboarding"),
        deps: { stateFile: t.stateFile, clock },
      });
      assert.equal(handled, false);
    } finally {
      t.cleanup();
    }
  });
});

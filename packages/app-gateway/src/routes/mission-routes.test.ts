import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { composeMissionDeps } from "../composition/mission-deps";
import { handleMissionRoutes } from "./mission-routes";

function createRequest(input: {
  method: string;
  url: string;
}): http.IncomingMessage {
  return Object.assign(Readable.from([]), {
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
  // Proxy so we capture statusCode mutations from the handler.
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

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tk-mission-routes-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const clock = { now: () => 1_700_000_000_000 };

describe("mission-routes", () => {
  it("GET /missions returns the list (empty after fresh init)", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const { res, getStatus, getJson } = createResponse();
      const handled = await handleMissionRoutes({
        req: createRequest({ method: "GET", url: "/missions" }),
        res,
        url: new URL("http://127.0.0.1/missions"),
        deps,
      });
      assert.equal(handled, true);
      assert.equal(getStatus(), 200);
      assert.deepEqual(getJson(), []);
    } finally {
      t.cleanup();
    }
  });

  it("POST /missions/bootstrap-demo populates every store", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const bootstrap = await handleMissionRoutes({
        req: createRequest({ method: "POST", url: "/missions/bootstrap-demo" }),
        res: createResponse().res,
        url: new URL("http://127.0.0.1/missions/bootstrap-demo"),
        deps,
      });
      assert.equal(bootstrap, true);
      // Now query each surface.
      const missions = await runJson<unknown[]>(deps, "GET", "/missions");
      assert.ok(missions.length >= 6, "expected ≥6 demo missions");

      const msn01 = await runJson<{ id: string; status: string }>(deps, "GET", "/missions/msn.01");
      assert.equal(msn01.id, "msn.01");
      assert.equal(msn01.status, "needs_approval");

      const workItems = await runJson<unknown[]>(deps, "GET", "/missions/msn.01/work-items");
      assert.equal(workItems.length, 8);

      const timeline = await runJson<unknown[]>(deps, "GET", "/missions/msn.01/timeline?limit=5");
      assert.equal(timeline.length, 5);

      const approvals = await runJson<unknown[]>(deps, "GET", "/approvals");
      assert.equal(approvals.length, 3);

      const agents = await runJson<unknown[]>(deps, "GET", "/mission-agents");
      assert.ok(agents.length >= 5);

      const sources = await runJson<unknown[]>(deps, "GET", "/mission-context-sources");
      assert.ok(sources.length >= 6);

      // Codex K2 #2: bootstrap MUST write artifacts so the timeline's
      // "Artifact registered" event isn't a lie. Verify the descriptor
      // landed in /missions/msn.01/artifacts.
      const artifacts = await runJson<Array<{ id: string; label: string }>>(
        deps,
        "GET",
        "/missions/msn.01/artifacts"
      );
      assert.ok(artifacts.length >= 1, "expected at least one demo artifact");
      assert.ok(
        artifacts.some((a) => a.label.includes("notion_pricing")),
        "expected the notion_pricing.json artifact descriptor"
      );

      // Codex K2 #3: each approval should have a distinct
      // requestedAtMs derived from its `requestedAgo` string.
      const approvalsWithTimestamps = await runJson<Array<{ requestedAtMs: number }>>(
        deps,
        "GET",
        "/approvals"
      );
      const uniqueTimestamps = new Set(approvalsWithTimestamps.map((a) => a.requestedAtMs));
      assert.equal(
        uniqueTimestamps.size,
        approvalsWithTimestamps.length,
        "each approval must have a distinct requestedAtMs"
      );

      // Codex K2 #4: ap.desktop-figma's missionId/missionTitle must
      // refer to the same mission.
      const allApprovals = await runJson<
        Array<{ id: string; missionId: string; missionTitle: string }>
      >(deps, "GET", "/approvals");
      const desktopAp = allApprovals.find((a) => a.id === "ap.desktop-figma");
      assert.ok(desktopAp, "expected ap.desktop-figma fixture");
      const referencedMission = await runJson<{ title: string }>(
        deps,
        "GET",
        `/missions/${encodeURIComponent(desktopAp.missionId)}`
      );
      assert.equal(
        referencedMission.title,
        desktopAp.missionTitle,
        "approval's missionId must point at the mission whose title it claims"
      );
    } finally {
      t.cleanup();
    }
  });

  it("GET /missions/:id returns 404 for unknown id", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const { res, getStatus, getJson } = createResponse();
      await handleMissionRoutes({
        req: createRequest({ method: "GET", url: "/missions/msn.ghost" }),
        res,
        url: new URL("http://127.0.0.1/missions/msn.ghost"),
        deps,
      });
      assert.equal(getStatus(), 404);
      assert.deepEqual(getJson(), { error: "mission not found" });
    } finally {
      t.cleanup();
    }
  });

  it("GET /missions/:id/timeline rejects bad limits", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const { res, getStatus } = createResponse();
      await handleMissionRoutes({
        req: createRequest({ method: "GET", url: "/missions/msn.01/timeline?limit=abc" }),
        res,
        url: new URL("http://127.0.0.1/missions/msn.01/timeline?limit=abc"),
        deps,
      });
      assert.equal(getStatus(), 400);
    } finally {
      t.cleanup();
    }
  });

  it("GET /approvals attaches decisions when present", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      await handleMissionRoutes({
        req: createRequest({ method: "POST", url: "/missions/bootstrap-demo" }),
        res: createResponse().res,
        url: new URL("http://127.0.0.1/missions/bootstrap-demo"),
        deps,
      });
      // Record a decision out-of-band via the store helper.
      const approvalStore = deps.approvalStore as unknown as {
        putDecision(d: {
          approvalId: string;
          decision: "approved" | "denied";
          decidedBy: string;
          decidedAtMs: number;
        }): Promise<void>;
      };
      await approvalStore.putDecision({
        approvalId: "ap.notion-form",
        decision: "approved",
        decidedBy: "tester",
        decidedAtMs: clock.now(),
      });

      const approvals = await runJson<Array<{ id: string; decision: unknown }>>(
        deps,
        "GET",
        "/approvals"
      );
      const decided = approvals.find((a) => a.id === "ap.notion-form");
      assert.ok(decided?.decision, "expected decision payload to be attached");
    } finally {
      t.cleanup();
    }
  });

  it("ignores routes outside the /missions / /approvals namespace", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const { res } = createResponse();
      const handled = await handleMissionRoutes({
        req: createRequest({ method: "GET", url: "/bridge/status" }),
        res,
        url: new URL("http://127.0.0.1/bridge/status"),
        deps,
      });
      assert.equal(handled, false);
    } finally {
      t.cleanup();
    }
  });
});

async function runJson<T>(
  deps: ReturnType<typeof composeMissionDeps>,
  method: string,
  pathAndQuery: string
): Promise<T> {
  const { res, getJson } = createResponse();
  await handleMissionRoutes({
    req: createRequest({ method, url: pathAndQuery }),
    res,
    url: new URL(`http://127.0.0.1${pathAndQuery}`),
    deps,
  });
  return getJson() as T;
}

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
  body?: unknown;
  headers?: Record<string, string>;
}): http.IncomingMessage {
  const chunks =
    input.body === undefined
      ? []
      : [Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body))];
  return Object.assign(Readable.from(chunks), {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
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

  it("GET /mission-context-sources merges live browser sessions with registry entries", async () => {
    // PR K3: the daemon stitches live browser sessions (from the bridge)
    // in front of the registry-backed ContextSource list so the Mission
    // Detail right pane reflects the actual bridge state. The route
    // de-dupes by id (live wins) so a registry record with the same
    // synthetic id doesn't double-render.
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      // Seed a registry-backed source — same id as the live one we'll
      // emit, plus a distinct one that must survive the merge.
      await deps.contextSourceRegistry.replaceAll([
        {
          id: "ctx.browser.session.sess_a",
          kind: "browser",
          title: "stale registry record",
          url: "",
          state: "registered",
          lastUse: "—",
        },
        {
          id: "ctx.doc.notes",
          kind: "doc",
          title: "Notes",
          url: "",
          state: "watching",
          lastUse: "—",
        },
      ]);
      const browserContextSourceProvider = {
        async listLive() {
          return [
            {
              id: "ctx.browser.session.sess_a",
              kind: "browser" as const,
              title: "Browser session sess_a",
              url: "",
              state: "attached",
              lastUse: "just now",
              transport: "direct-cdp",
              session: "sess_a",
            },
          ];
        },
      };
      const { res, getJson, getStatus } = createResponse();
      await handleMissionRoutes({
        req: createRequest({ method: "GET", url: "/mission-context-sources" }),
        res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps: { ...deps, browserContextSourceProvider },
      });
      assert.equal(getStatus(), 200);
      const list = getJson() as Array<{ id: string; state: string }>;
      // Two entries: live browser (wins over stale registry) + doc.
      assert.equal(list.length, 2);
      const live = list.find((c) => c.id === "ctx.browser.session.sess_a");
      assert.equal(live?.state, "attached", "live entry must win the merge");
      assert.ok(list.some((c) => c.id === "ctx.doc.notes"), "doc registry entry must survive");
    } finally {
      t.cleanup();
    }
  });

  it("GET /mission-context-sources survives a provider that rejects (codex K3)", async () => {
    // Even though the bundled BrowserContextSourceProvider catches its
    // own errors, the route MUST also defend against a future provider
    // that rejects (or non-Error throws). Falling back to registry-only
    // results means the read endpoint still returns useful data when
    // the bridge layer is mid-recovery.
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      await deps.contextSourceRegistry.replaceAll([
        {
          id: "ctx.doc.notes",
          kind: "doc",
          title: "Notes",
          url: "",
          state: "watching",
          lastUse: "—",
        },
      ]);
      const browserContextSourceProvider = {
        async listLive(): Promise<never> {
          throw new Error("provider went pop");
        },
      };
      const { res, getStatus, getJson } = createResponse();
      await handleMissionRoutes({
        req: createRequest({ method: "GET", url: "/mission-context-sources" }),
        res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps: { ...deps, browserContextSourceProvider },
      });
      assert.equal(getStatus(), 200);
      const list = getJson() as Array<{ id: string }>;
      assert.equal(list.length, 1);
      assert.equal(list[0]!.id, "ctx.doc.notes");
    } finally {
      t.cleanup();
    }
  });

  // PR K3.5 — mission lifecycle (create → run → follow-up).
  describe("POST /missions + /missions/:id/messages (K3.5)", () => {
    function buildOrchestrator() {
      const posts: Array<{ threadId: string; content: string }> = [];
      const ticks: string[] = [];
      let nextThread = 0;
      const orchestrator = {
        async spawnThread(input: { title: string; desc: string; owner: string }) {
          nextThread += 1;
          return {
            threadId: `thread-${nextThread}`,
            leadRoleId: "role-lead",
            roleIds: ["role-lead", "role-analyst"],
          };
        },
        async postUserMessage(input: { threadId: string; content: string }) {
          posts.push(input);
        },
        threadBridge: {
          async tickAll() {
            return [];
          },
          async tickMission(missionId: string) {
            ticks.push(missionId);
            return 0;
          },
          start() {
            return () => undefined;
          },
        },
      };
      return { orchestrator, posts, ticks };
    }

    it("creates a mission, spawns a thread, posts the initial message, and ticks the bridge", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator, posts, ticks } = buildOrchestrator();
        const { res, getStatus, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "研究竞品", desc: "看 5 款笔记软件的定价", mode: "research" },
          }),
          res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 201);
        const mission = getJson() as { id: string; threadId: string; status: string; title: string };
        assert.equal(mission.title, "研究竞品");
        assert.equal(mission.threadId, "thread-1");
        // Status promoted from "draft" → "working" because the
        // coordination thread is live the moment the route returns.
        assert.equal(mission.status, "working");
        // Initial message: title + desc.
        assert.equal(posts.length, 1);
        assert.ok(posts[0]!.content.includes("研究竞品"));
        assert.ok(posts[0]!.content.includes("5 款笔记"));
        // Bridge ticked synchronously so the user's prompt is on the
        // timeline by the time the response returns.
        assert.deepEqual(ticks, [mission.id]);
      } finally {
        t.cleanup();
      }
    });

    it("returns 501 when orchestrator is not configured (test-only path)", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { res, getStatus, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "x" },
          }),
          res,
          url: new URL("http://127.0.0.1/missions"),
          deps,
        });
        assert.equal(getStatus(), 501);
        const body = getJson() as { error: string };
        assert.match(body.error, /orchestrator/);
      } finally {
        t.cleanup();
      }
    });

    it("rejects blank title with 400", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator } = buildOrchestrator();
        const { res, getStatus } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "   " },
          }),
          res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 400);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/messages posts to the linked thread and ticks the bridge", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator, posts, ticks } = buildOrchestrator();
        // Create first to get a linked mission.
        const createResp = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "test" },
          }),
          res: createResp.res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        const created = createResp.getJson() as { id: string; threadId: string };
        // Follow-up.
        const { res, getStatus, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: `/missions/${created.id}/messages`,
            body: { content: "继续看 macOS 平台支持" },
          }),
          res,
          url: new URL(`http://127.0.0.1/missions/${created.id}/messages`),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 202);
        assert.deepEqual(getJson(), { accepted: true, missionId: created.id });
        // Second post: the follow-up content lands on the linked thread.
        assert.equal(posts.length, 2);
        assert.equal(posts[1]!.threadId, created.threadId);
        assert.equal(posts[1]!.content, "继续看 macOS 平台支持");
        // Bridge ticked twice — once after create, once after follow-up.
        assert.deepEqual(ticks, [created.id, created.id]);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/messages returns 404 for unknown mission", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator } = buildOrchestrator();
        const { res, getStatus } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions/msn.ghost/messages",
            body: { content: "hi" },
          }),
          res,
          url: new URL("http://127.0.0.1/missions/msn.ghost/messages"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 404);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/messages dedupes on Idempotency-Key (codex K3.5)", async () => {
      const { createRouteIdempotencyStore } = await import("../idempotency-store");
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator, posts } = buildOrchestrator();
        const idempotencyStore = createRouteIdempotencyStore({ now: () => 1000 });
        // Create a mission to follow up on.
        const created = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "Dedupe test" },
          }),
          res: created.res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator, idempotencyStore },
        });
        const mission = created.getJson() as { id: string };
        const postsBefore = posts.length;
        // First follow-up with key.
        const first = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: `/missions/${mission.id}/messages`,
            headers: { "idempotency-key": "follow-1" },
            body: { content: "do X" },
          }),
          res: first.res,
          url: new URL(`http://127.0.0.1/missions/${mission.id}/messages`),
          deps: { ...deps, orchestrator, idempotencyStore },
        });
        assert.equal(first.getStatus(), 202);
        assert.equal(posts.length, postsBefore + 1);
        // Retry — same key + same body → no extra post, replay.
        const replay = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: `/missions/${mission.id}/messages`,
            headers: { "idempotency-key": "follow-1" },
            body: { content: "do X" },
          }),
          res: replay.res,
          url: new URL(`http://127.0.0.1/missions/${mission.id}/messages`),
          deps: { ...deps, orchestrator, idempotencyStore },
        });
        assert.equal(replay.getStatus(), 202);
        assert.equal(
          posts.length,
          postsBefore + 1,
          "retry with same idempotency-key must NOT double-post"
        );
        // Same key + different body → 409.
        const collide = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: `/missions/${mission.id}/messages`,
            headers: { "idempotency-key": "follow-1" },
            body: { content: "do Y" },
          }),
          res: collide.res,
          url: new URL(`http://127.0.0.1/missions/${mission.id}/messages`),
          deps: { ...deps, orchestrator, idempotencyStore },
        });
        assert.equal(collide.getStatus(), 409);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/messages returns 409 if mission has no linked thread", async () => {
      // bootstrap-demo missions never get a threadId because they are
      // fixtures, not interactive missions. Follow-up must fail loudly
      // rather than silently disappear into the void.
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator } = buildOrchestrator();
        // Seed an unlinked mission directly.
        await deps.missionStore.putRaw({
          id: "msn.fixture",
          shortId: "MSN-FX",
          title: "fixture",
          desc: "",
          status: "working",
          mode: "custom",
          modeLabel: "Custom",
          owner: "you",
          ownerLabel: "You",
          createdAt: "today",
          createdAtMs: clock.now(),
          agents: [],
          progress: 0,
          pendingApprovals: 0,
          blockers: 0,
          contextSummary: [],
        });
        const { res, getStatus, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions/msn.fixture/messages",
            body: { content: "hi" },
          }),
          res,
          url: new URL("http://127.0.0.1/missions/msn.fixture/messages"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 409);
        const body = getJson() as { code: string };
        assert.equal(body.code, "mission_thread_missing");
      } finally {
        t.cleanup();
      }
    });
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

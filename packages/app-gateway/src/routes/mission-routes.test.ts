import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { ActivityEvent, ApprovalRequest, Mission } from "@turnkeyai/core-types/mission";
import type { RuntimeProgressEvent, TeamMessage } from "@turnkeyai/core-types/team";

import { composeMissionDeps } from "../composition/mission-deps";
import { createMissionThreadBridge } from "../mission-thread-bridge";
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

function timelineEvent(id: string, missionId: string, tMs: number): ActivityEvent {
  return {
    id,
    missionId,
    tMs,
    kind: "thought",
    actor: "role-lead",
    text: id,
  };
}

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

  it("GET /missions/:id/timeline supports cursor pages without changing the default array shape", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      for (let i = 1; i <= 5; i++) {
        await deps.activityStore.append(timelineEvent(`ev.${i}`, "msn.cursor", i));
      }

      const defaultShape = await runJson<ActivityEvent[]>(deps, "GET", "/missions/msn.cursor/timeline?limit=2");
      assert.deepEqual(defaultShape.map((event) => event.id), ["ev.4", "ev.5"]);

      const firstPage = await runJson<{
        events: ActivityEvent[];
        nextCursor: string | null;
        hasMore: boolean;
        limit: number;
      }>(deps, "GET", "/missions/msn.cursor/timeline?page=true&limit=2");
      assert.deepEqual(firstPage.events.map((event) => event.id), ["ev.4", "ev.5"]);
      assert.equal(firstPage.hasMore, true);
      assert.equal(firstPage.limit, 2);
      assert.ok(firstPage.nextCursor);

      const secondPage = await runJson<{
        events: ActivityEvent[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        deps,
        "GET",
        `/missions/msn.cursor/timeline?page=true&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`
      );
      assert.deepEqual(secondPage.events.map((event) => event.id), ["ev.2", "ev.3"]);
      assert.equal(secondPage.hasMore, true);

      const thirdPage = await runJson<{
        events: ActivityEvent[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        deps,
        "GET",
        `/missions/msn.cursor/timeline?page=true&limit=2&cursor=${encodeURIComponent(secondPage.nextCursor!)}`
      );
      assert.deepEqual(thirdPage.events.map((event) => event.id), ["ev.1"]);
      assert.equal(thirdPage.hasMore, false);
      assert.equal(thirdPage.nextCursor, null);
    } finally {
      t.cleanup();
    }
  });

  it("GET /missions/:id/timeline rejects malformed cursors", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const { res, getStatus, getJson } = createResponse();
      await handleMissionRoutes({
        req: createRequest({ method: "GET", url: "/missions/msn.01/timeline?page=true&cursor=not-a-cursor" }),
        res,
        url: new URL("http://127.0.0.1/missions/msn.01/timeline?page=true&cursor=not-a-cursor"),
        deps,
      });
      assert.equal(getStatus(), 400);
      assert.deepEqual(getJson(), { error: "cursor must be a valid timeline cursor" });
    } finally {
      t.cleanup();
    }
  });

  it("GET /missions/:id/metrics returns derived tool/session observability", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const mission: Mission = {
        id: "msn.metrics",
        shortId: "MSN-9001",
        title: "Metrics mission",
        desc: "",
        status: "done",
        mode: "research",
        modeLabel: "Research",
        owner: "you",
        ownerLabel: "You",
        createdAt: new Date(1_000).toISOString(),
        createdAtMs: 1_000,
        agents: ["role-lead"],
        progress: 1,
        pendingApprovals: 0,
        blockers: 0,
        contextSummary: [],
        threadId: "thread-metrics",
      };
      await deps.missionStore.putRaw(mission);
      deps.runtimeProgressStore = {
        async listByThread(threadId: string, limit?: number): Promise<RuntimeProgressEvent[]> {
          assert.equal(threadId, "thread-metrics");
          assert.equal(limit, 500);
          return [
            {
              progressId: "progress.role.1",
              threadId,
              subjectKind: "role_run",
              subjectId: "role:lead",
              phase: "heartbeat",
              continuityState: "alive",
              responseTimeoutAt: clock.now() - 1,
              summary: "Lead response heartbeat expired.",
              recordedAt: clock.now() - 10,
            },
          ];
        },
      };
      await deps.activityStore.append({
        id: "ev.user",
        missionId: mission.id,
        tMs: 1_000,
        kind: "plan",
        actor: "user",
        text: "Run metrics mission.",
      });
      await deps.activityStore.append({
        id: "ev.call",
        missionId: mission.id,
        tMs: 2_000,
        kind: "tool",
        actor: "role-lead",
        text: "Calling sessions_spawn",
        runtime: { toolPhase: "call", toolName: "sessions_spawn", toolCallId: "call-1" },
      });
      await deps.activityStore.append({
        id: "ev.result",
        missionId: mission.id,
        tMs: 4_000,
        kind: "tool",
        actor: "role-lead",
        text: "Tool sessions_spawn returned evidence.",
        runtime: { toolPhase: "result", toolName: "sessions_spawn", toolCallId: "call-1" },
      });
      await deps.activityStore.append({
        id: "ev.final",
        missionId: mission.id,
        tMs: 5_000,
        kind: "thought",
        actor: "role-lead",
        text: "Final answer with residual risk.",
      });

      const metrics = await runJson<{
        wallClockMs: number;
        tool: { requested: number; results: number };
        sessions: { spawned: number };
        browser: { profileFallbacks: number };
        liveness: { active: number; waiting: number; stale: number };
        qualityGate: { status: string; evidenceEvents: number };
      }>(deps, "GET", "/missions/msn.metrics/metrics");

      assert.equal(metrics.wallClockMs, 4_000);
      assert.deepEqual(metrics.tool, {
        requested: 1,
        results: 1,
        executed: 1,
        skipped: 0,
        failed: 0,
        cancelled: 0,
        timeouts: 0,
      });
      assert.equal(metrics.sessions.spawned, 1);
      assert.equal(metrics.browser.profileFallbacks, 0);
      assert.equal(metrics.liveness.active, 1);
      assert.equal(metrics.liveness.waiting, 0);
      assert.equal(metrics.liveness.stale, 1);
      assert.equal(metrics.qualityGate.status, "blocked");
      assert.equal(metrics.qualityGate.evidenceEvents, 1);
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

  it("POST /approvals/:id/decision records operator decision and timeline event", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      await handleMissionRoutes({
        req: createRequest({ method: "POST", url: "/missions/bootstrap-demo" }),
        res: createResponse().res,
        url: new URL("http://127.0.0.1/missions/bootstrap-demo"),
        deps,
      });
      const { res, getStatus, getJson } = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/approvals/ap.notion-form/decision",
          body: { decision: "approved", decidedBy: "operator" },
        }),
        res,
        url: new URL("http://127.0.0.1/approvals/ap.notion-form/decision"),
        deps,
      });
      assert.equal(getStatus(), 200);
      assert.equal(getJson().decision.decision, "approved");
      const approvals = await runJson<Array<{ id: string; decision: { decision: string } | null }>>(
        deps,
        "GET",
        "/approvals"
      );
      assert.equal(approvals.find((a) => a.id === "ap.notion-form")?.decision?.decision, "approved");
      const timeline = await runJson<Array<{ approvalId?: string; tags?: string[] }>>(
        deps,
        "GET",
        "/missions/msn.01/timeline?limit=50"
      );
      assert.ok(
        timeline.some((event) => event.approvalId === "ap.notion-form" && event.tags?.includes("permission.result")),
        "expected decision to be visible on mission timeline"
      );
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

  it("POST /mission-context-sources registers a manual document source", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const { res, getStatus, getJson } = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/mission-context-sources",
          body: {
            kind: "doc",
            title: " Launch notes ",
            path: " /Users/alice/work/launch.md ",
            writer: "agent.doc",
          },
        }),
        res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps,
      });

      assert.equal(getStatus(), 201);
      const created = getJson() as { id: string; kind: string; title: string; url: string; state: string; writer: string };
      assert.match(created.id, /^ctx\.doc\.manual\.\d+\.launch-notes$/);
      assert.equal(created.kind, "doc");
      assert.equal(created.title, "Launch notes");
      assert.equal(created.url, "/Users/alice/work/launch.md");
      assert.equal(created.state, "attached");
      assert.equal(created.writer, "agent.doc");

      const list = await deps.contextSourceRegistry.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, created.id);
    } finally {
      t.cleanup();
    }
  });

  it("POST /mission-context-sources dedupes on Idempotency-Key", async () => {
    const { createRouteIdempotencyStore } = await import("../idempotency-store");
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const idempotencyStore = createRouteIdempotencyStore({ now: () => 1000 });
      const request = {
        kind: "folder",
        title: "Workspace",
        path: "/Users/alice/work",
      };

      const first = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/mission-context-sources",
          headers: { "idempotency-key": "ctx-1" },
          body: request,
        }),
        res: first.res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps: { ...deps, idempotencyStore },
      });
      assert.equal(first.getStatus(), 201);

      const replay = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/mission-context-sources",
          headers: { "idempotency-key": "ctx-1" },
          body: request,
        }),
        res: replay.res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps: { ...deps, idempotencyStore },
      });
      assert.equal(replay.getStatus(), 201);
      assert.deepEqual(replay.getJson(), first.getJson());

      const list = await deps.contextSourceRegistry.list();
      assert.equal(list.length, 1, "retry with same idempotency-key must not double-register");

      const collide = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/mission-context-sources",
          headers: { "idempotency-key": "ctx-1" },
          body: { ...request, path: "/Users/alice/other-work" },
        }),
        res: collide.res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps: { ...deps, idempotencyStore },
      });
      assert.equal(collide.getStatus(), 409);
    } finally {
      t.cleanup();
    }
  });

  it("POST /mission-context-sources validates manual context input", async () => {
    const t = tmpDir();
    try {
      const deps = composeMissionDeps({ dataDir: t.dir, clock });
      const invalidKind = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/mission-context-sources",
          body: { kind: "browser", title: "Live tab", url: "https://example.com" },
        }),
        res: invalidKind.res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps,
      });
      assert.equal(invalidKind.getStatus(), 400);
      assert.deepEqual(invalidKind.getJson(), { error: "kind must be doc, folder, api, or desktop" });

      const missingPath = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/mission-context-sources",
          body: { kind: "folder", title: "Workspace" },
        }),
        res: missingPath.res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps,
      });
      assert.equal(missingPath.getStatus(), 400);
      assert.deepEqual(missingPath.getJson(), { error: "url or path is required" });

      const bothFields = createResponse();
      await handleMissionRoutes({
        req: createRequest({
          method: "POST",
          url: "/mission-context-sources",
          body: {
            kind: "api",
            title: "Workspace API",
            url: "https://example.com/workspace",
            path: "/Users/alice/workspace",
          },
        }),
        res: bothFields.res,
        url: new URL("http://127.0.0.1/mission-context-sources"),
        deps,
      });
      assert.equal(bothFields.getStatus(), 400);
      assert.deepEqual(bothFields.getJson(), { error: "Provide either url or path, not both" });
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

    async function flushMicrotasks(): Promise<void> {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    async function waitForMissionStatus(
      deps: ReturnType<typeof composeMissionDeps>,
      missionId: string,
      status: Mission["status"]
    ): Promise<Mission> {
      for (let i = 0; i < 25; i += 1) {
        const mission = await deps.missionStore.get(missionId);
        if (mission?.status === status) return mission;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const latest = await deps.missionStore.get(missionId);
      throw new Error(`mission ${missionId} did not reach status ${status}; latest=${latest?.status ?? "missing"}`);
    }

    async function waitUntil(label: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
      for (let i = 0; i < 25; i += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    }

    it("creates a mission quickly and starts the initial message in the background", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const posts: Array<{ threadId: string; content: string }> = [];
        const ticks: string[] = [];
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => {
          releasePost = resolve;
        });
        const orchestrator = {
          async spawnThread() {
            return {
              threadId: "thread-1",
              leadRoleId: "role-lead",
              roleIds: ["role-lead", "role-analyst"],
            };
          },
          async postUserMessage(input: { threadId: string; content: string }) {
            posts.push(input);
            await postGate;
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
        // The route returned before the initial post finished.
        assert.equal(posts.length, 1);
        assert.ok(posts[0]!.content.includes("研究竞品"));
        assert.ok(posts[0]!.content.includes("5 款笔记"));
        assert.deepEqual(ticks, []);
        releasePost();
        await waitUntil("initial mission tick", () => ticks.length === 1);
        assert.deepEqual(ticks, [mission.id]);
      } finally {
        t.cleanup();
      }
    });

    it("approval decisions resume linked mission threads", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator, posts, ticks } = buildOrchestrator();
        const { res, getStatus, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "Approval gated browser task", desc: "Open a local form and dry-run submit", mode: "browser" },
          }),
          res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 201);
        const mission = getJson() as Mission;
        await waitUntil("initial mission post", () => posts.length === 1);

        const latest = await deps.missionStore.get(mission.id);
        assert.ok(latest);
        await deps.missionStore.putRaw({
          ...latest,
          status: "needs_approval",
          pendingApprovals: 1,
        });
        const approval: ApprovalRequest = {
          id: "ap.linked-browser-submit",
          severity: "med",
          missionId: mission.id,
          missionTitle: mission.title,
          agent: "role-lead",
          action: "browser.form.submit",
          title: "Dry-run submit",
          affects: [],
          risk: "isolated local dry-run",
          requestedAt: "now",
          requestedAtMs: clock.now(),
          requestedAgo: "now",
          policyHint: "approval",
          payload: {
            toolPermission: {
              threadId: mission.threadId,
              toolCallId: "call-1",
              action: "browser.form.submit",
              scope: "mutate",
              requirement: {
                level: "approval",
                scope: "mutate",
                reason: "browser form submit",
                cacheKey: `${mission.threadId}:browser:mutate:approval:browser.form.submit`,
              },
            },
          },
        };
        await deps.approvalStore.put(approval);
        const applied: Array<{ threadId: string; approvalId: string }> = [];

        const decisionResponse = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/approvals/ap.linked-browser-submit/decision",
            body: { decision: "approved", decidedBy: "operator" },
          }),
          res: decisionResponse.res,
          url: new URL("http://127.0.0.1/approvals/ap.linked-browser-submit/decision"),
          deps: {
            ...deps,
            orchestrator,
            toolPermissionService: {
              async apply(input) {
                applied.push(input);
                return {
                  status: "applied",
                  approvalId: input.approvalId,
                  cacheKey: `${mission.threadId}:browser:mutate:approval:browser.form.submit`,
                  message: `Permission request ${input.approvalId} applied.`,
                };
              },
            },
          },
        });
        assert.equal(decisionResponse.getStatus(), 200);
        assert.deepEqual(applied, [{ threadId: mission.threadId!, approvalId: "ap.linked-browser-submit" }]);
        await waitUntil("approval continuation post", () => posts.length === 2);
        assert.equal(posts[1]?.threadId, mission.threadId);
        assert.match(posts[1]?.content ?? "", /ap\.linked-browser-submit/);
        assert.match(posts[1]?.content ?? "", /runtime permission cache is already applied/);
        assert.doesNotMatch(posts[1]?.content ?? "", /permission_applied/);
        await waitUntil("approval continuation tick", () => ticks.filter((id) => id === mission.id).length >= 2);
        const resumed = await deps.missionStore.get(mission.id);
        assert.equal(resumed?.status, "working");
      } finally {
        t.cleanup();
      }
    });

    it("approval decisions fall back when permission auto-apply fails", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator, posts } = buildOrchestrator();
        const { res, getStatus, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "Approval apply fallback", desc: "Dry-run browser action", mode: "browser" },
          }),
          res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 201);
        const mission = getJson() as Mission;
        await waitUntil("initial mission post", () => posts.length === 1);

        const latest = await deps.missionStore.get(mission.id);
        assert.ok(latest);
        await deps.missionStore.putRaw({
          ...latest,
          status: "needs_approval",
          pendingApprovals: 1,
        });
        await deps.approvalStore.put({
          id: "ap.apply-fallback",
          severity: "med",
          missionId: mission.id,
          missionTitle: mission.title,
          agent: "role-lead",
          action: "browser.form.submit",
          title: "Dry-run submit",
          affects: [],
          risk: "isolated local dry-run",
          requestedAt: "now",
          requestedAtMs: clock.now(),
          requestedAgo: "now",
          policyHint: "approval",
          payload: {
            toolPermission: {
              threadId: mission.threadId,
              toolCallId: "call-1",
              action: "browser.form.submit",
              scope: "mutate",
              requirement: {
                level: "approval",
                scope: "mutate",
                reason: "browser form submit",
                cacheKey: `${mission.threadId}:browser:mutate:approval:browser.form.submit`,
              },
            },
          },
        });

        const decisionResponse = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/approvals/ap.apply-fallback/decision",
            body: { decision: "approved", decidedBy: "operator" },
          }),
          res: decisionResponse.res,
          url: new URL("http://127.0.0.1/approvals/ap.apply-fallback/decision"),
          deps: {
            ...deps,
            orchestrator,
            toolPermissionService: {
              async apply() {
                throw new Error("permission cache unavailable");
              },
            },
          },
        });
        assert.equal(decisionResponse.getStatus(), 200);
        await waitUntil("approval fallback continuation post", () => posts.length === 2);
        assert.match(posts[1]?.content ?? "", /permission_result/);
        assert.match(posts[1]?.content ?? "", /permission_applied/);
      } finally {
        t.cleanup();
      }
    });

    it("approval decisions do not reopen terminal missions", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator, posts, ticks } = buildOrchestrator();
        const { res, getStatus, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: {
              title: "Already done",
              desc: "Terminal mission with late approval decision",
              mode: "browser",
            },
          }),
          res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(getStatus(), 201);
        const mission = getJson() as Mission;
        await waitUntil("initial terminal mission post", () => posts.length === 1);
        posts.length = 0;
        ticks.length = 0;
        await deps.missionStore.putRaw({
          ...mission,
          status: "done",
          progress: 1,
          pendingApprovals: 1,
        });
        await deps.approvalStore.put({
          id: "ap.done-submit",
          severity: "med",
          missionId: mission.id,
          missionTitle: mission.title,
          agent: "role-lead",
          action: "browser.form.submit",
          title: "Late submit",
          affects: [],
          risk: "late decision",
          requestedAt: "now",
          requestedAtMs: clock.now(),
          requestedAgo: "now",
          policyHint: "approval",
        });

        const decisionResponse = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/approvals/ap.done-submit/decision",
            body: { decision: "approved", decidedBy: "operator" },
          }),
          res: decisionResponse.res,
          url: new URL("http://127.0.0.1/approvals/ap.done-submit/decision"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(decisionResponse.getStatus(), 200);
        await flushMicrotasks();
        assert.deepEqual(posts, []);
        assert.deepEqual(ticks, []);
        const latest = await deps.missionStore.get(mission.id);
        assert.equal(latest?.status, "done");
      } finally {
        t.cleanup();
      }
    });

    it("records background startup failure without overwriting newer mission state", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => {
          releasePost = resolve;
        });
        const orchestrator = {
          async spawnThread() {
            return {
              threadId: "thread-1",
              leadRoleId: "role-lead",
              roleIds: ["role-lead", "role-analyst"],
            };
          },
          async postUserMessage() {
            await postGate;
            throw new Error("LLM unavailable");
          },
          threadBridge: {
            async tickAll() {
              return [];
            },
            async tickMission() {
              return 0;
            },
            start() {
              return () => undefined;
            },
          },
        };
        const { res, getJson } = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "startup failure" },
          }),
          res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        const created = getJson() as Mission;
        await deps.missionStore.putRaw({
          ...created,
          title: "operator renamed while startup was pending",
          blockers: 4,
        });

        releasePost();

        const updated = await waitForMissionStatus(deps, created.id, "blocked");
        assert.equal(updated.title, "operator renamed while startup was pending");
        assert.equal(updated.blockers, 4);
        await waitUntil("mission start failure event", async () => {
          const timeline = await deps.activityStore.listByMission(created.id, { limit: 10 });
          return timeline.some((event) => event.runtime?.eventType === "mission.start_failed");
        });
        const timeline = await deps.activityStore.listByMission(created.id, { limit: 10 });
        const failureEvent = timeline.find((event) => event.runtime?.eventType === "mission.start_failed");
        assert.equal(failureEvent?.text, "mission.start_failed");
        assert.equal(failureEvent?.runtime?.errorMessage, "LLM unavailable");
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
        await flushMicrotasks();
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
        await waitUntil("follow-up bridge tick", () => ticks.length === 2);
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

    it("POST /missions/:id/messages reopens a done mission while the follow-up runs", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const { orchestrator } = buildOrchestrator();
        const createResp = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "done mission follow-up" },
          }),
          res: createResp.res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        const created = createResp.getJson() as Mission;
        await flushMicrotasks();
        await deps.missionStore.putRaw({
          ...created,
          status: "done",
          progress: 1,
        });

        const followUpResp = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: `/missions/${created.id}/messages`,
            body: { content: "continue the completed mission" },
          }),
          res: followUpResp.res,
          url: new URL(`http://127.0.0.1/missions/${created.id}/messages`),
          deps: { ...deps, orchestrator },
        });

        assert.equal(followUpResp.getStatus(), 202);
        const reopened = await waitForMissionStatus(deps, created.id, "working");
        assert.equal(reopened.progress < 1, true, "follow-up should make completion visibly in-flight again");
        assert.equal(reopened.blockers, 0);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/reconcile forces a mission/thread mirror pass", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        let tickAllCalls = 0;
        const orchestrator = {
          async spawnThread() {
            throw new Error("unused");
          },
          async postUserMessage() {
            throw new Error("unused");
          },
          threadBridge: {
            async tickAll() {
              tickAllCalls += 1;
              return [
                { missionId: "msn.1", appended: 2 },
                { missionId: "msn.2", appended: 0 },
              ];
            },
            async tickMission() {
              throw new Error("unused");
            },
            start() {
              return () => undefined;
            },
          },
        };
        const response = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/reconcile" }),
          res: response.res,
          url: new URL("http://127.0.0.1/missions/reconcile"),
          deps: { ...deps, orchestrator },
        });

        assert.equal(response.getStatus(), 200);
        assert.deepEqual(response.getJson(), {
          ok: true,
          scope: "all",
          missions: [
            { missionId: "msn.1", appended: 2 },
            { missionId: "msn.2", appended: 0 },
          ],
          appended: 2,
        });
        assert.equal(tickAllCalls, 1);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/reconcile forces one mission/thread mirror pass", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        await deps.missionStore.putRaw({
          id: "msn.reconcile",
          shortId: "MSN-R",
          title: "needs reconcile",
          desc: "",
          status: "working",
          mode: "custom",
          modeLabel: "Custom",
          owner: "operator",
          ownerLabel: "Operator",
          createdAt: new Date(clock.now()).toISOString(),
          createdAtMs: clock.now(),
          agents: ["role-lead"],
          progress: 0.5,
          pendingApprovals: 0,
          blockers: 0,
          contextSummary: [],
          threadId: "thread-reconcile",
        });
        const ticked: string[] = [];
        const orchestrator = {
          async spawnThread() {
            throw new Error("unused");
          },
          async postUserMessage() {
            throw new Error("unused");
          },
          threadBridge: {
            async tickAll() {
              throw new Error("unused");
            },
            async tickMission(missionId: string) {
              ticked.push(missionId);
              return 3;
            },
            start() {
              return () => undefined;
            },
          },
        };
        const response = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/msn.reconcile/reconcile" }),
          res: response.res,
          url: new URL("http://127.0.0.1/missions/msn.reconcile/reconcile"),
          deps: { ...deps, orchestrator },
        });

        assert.equal(response.getStatus(), 200);
        assert.deepEqual(response.getJson(), {
          ok: true,
          scope: "mission",
          missionId: "msn.reconcile",
          appended: 3,
        });
        assert.deepEqual(ticked, ["msn.reconcile"]);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/reconcile returns 501 when reconcile is not configured", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const response = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/reconcile" }),
          res: response.res,
          url: new URL("http://127.0.0.1/missions/reconcile"),
          deps,
        });

        assert.equal(response.getStatus(), 501);
        assert.deepEqual(response.getJson(), { error: "mission reconcile not configured" });

        await deps.missionStore.putRaw({
          id: "msn.no-tick",
          shortId: "MSN-N",
          title: "no tick",
          desc: "",
          status: "working",
          mode: "custom",
          modeLabel: "Custom",
          owner: "operator",
          ownerLabel: "Operator",
          createdAt: new Date(clock.now()).toISOString(),
          createdAtMs: clock.now(),
          agents: ["role-lead"],
          progress: 0,
          pendingApprovals: 0,
          blockers: 0,
          contextSummary: [],
          threadId: "thread-no-tick",
        });
        const missingTickMission = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/msn.no-tick/reconcile" }),
          res: missingTickMission.res,
          url: new URL("http://127.0.0.1/missions/msn.no-tick/reconcile"),
          deps: {
            ...deps,
            orchestrator: {
              async spawnThread() {
                throw new Error("unused");
              },
              async postUserMessage() {
                throw new Error("unused");
              },
              threadBridge: {
                async tickAll() {
                  return [];
                },
                start() {
                  return () => undefined;
                },
              } as never,
            },
          },
        });
        assert.equal(missingTickMission.getStatus(), 501);
        assert.deepEqual(missingTickMission.getJson(), { error: "mission reconcile not configured" });
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/reconcile validates mission id and existence", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const orchestrator = {
          async spawnThread() {
            throw new Error("unused");
          },
          async postUserMessage() {
            throw new Error("unused");
          },
          threadBridge: {
            async tickAll() {
              return [];
            },
            async tickMission() {
              throw new Error("unused");
            },
            start() {
              return () => undefined;
            },
          },
        };

        const malformed = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/%E0%A4%A/reconcile" }),
          res: malformed.res,
          url: new URL("http://127.0.0.1/missions/%E0%A4%A/reconcile"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(malformed.getStatus(), 400);
        assert.deepEqual(malformed.getJson(), { error: "invalid mission id encoding" });

        const missing = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/missing/reconcile" }),
          res: missing.res,
          url: new URL("http://127.0.0.1/missions/missing/reconcile"),
          deps: { ...deps, orchestrator },
        });
        assert.equal(missing.getStatus(), 404);
        assert.deepEqual(missing.getJson(), { error: "mission not found" });
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/archive archives terminal missions and rejects active missions", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        await deps.missionStore.putRaw({
          id: "msn.done",
          shortId: "MSN-DONE",
          title: "done mission",
          desc: "",
          status: "done",
          mode: "custom",
          modeLabel: "Custom",
          owner: "operator",
          ownerLabel: "Operator",
          createdAt: new Date(clock.now()).toISOString(),
          createdAtMs: clock.now(),
          agents: ["role-lead"],
          progress: 1,
          pendingApprovals: 0,
          blockers: 0,
          contextSummary: [],
          threadId: "thread-done",
        });
        await deps.missionStore.putRaw({
          id: "msn.working",
          shortId: "MSN-WORK",
          title: "working mission",
          desc: "",
          status: "working",
          mode: "custom",
          modeLabel: "Custom",
          owner: "operator",
          ownerLabel: "Operator",
          createdAt: new Date(clock.now()).toISOString(),
          createdAtMs: clock.now(),
          agents: ["role-lead"],
          progress: 0.5,
          pendingApprovals: 0,
          blockers: 0,
          contextSummary: [],
          threadId: "thread-working",
        });

        const archivedResponse = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/msn.done/archive" }),
          res: archivedResponse.res,
          url: new URL("http://127.0.0.1/missions/msn.done/archive"),
          deps,
        });
        assert.equal(archivedResponse.getStatus(), 200);
        assert.equal((archivedResponse.getJson() as Mission).status, "archived");
        assert.equal((await deps.missionStore.get("msn.done"))?.status, "archived");

        const activeResponse = createResponse();
        await handleMissionRoutes({
          req: createRequest({ method: "POST", url: "/missions/msn.working/archive" }),
          res: activeResponse.res,
          url: new URL("http://127.0.0.1/missions/msn.working/archive"),
          deps,
        });
        assert.equal(activeResponse.getStatus(), 409);
        assert.deepEqual(activeResponse.getJson(), {
          error: "mission is still active",
          code: "mission_active",
          status: "working",
        });
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/messages accepts follow-up before the agent turn finishes", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        let releasePost: (() => void) | undefined;
        const posts: Array<{ threadId: string; content: string }> = [];
        const ticks: string[] = [];
        const orchestrator = {
          async spawnThread() {
            return {
              threadId: "thread-slow-follow-up",
              leadRoleId: "role-lead",
              roleIds: ["role-lead"],
            };
          },
          async postUserMessage(input: { threadId: string; content: string }) {
            if (input.content === "slow follow-up") {
              await new Promise<void>((resolve) => {
                releasePost = resolve;
              });
            }
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

        const createdResp = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "slow mission" },
          }),
          res: createdResp.res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        const created = createdResp.getJson() as { id: string };
        await flushMicrotasks();

        const followUpResp = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: `/missions/${created.id}/messages`,
            body: { content: "slow follow-up" },
          }),
          res: followUpResp.res,
          url: new URL(`http://127.0.0.1/missions/${created.id}/messages`),
          deps: { ...deps, orchestrator },
        });
        assert.equal(followUpResp.getStatus(), 202);
        assert.deepEqual(followUpResp.getJson(), { accepted: true, missionId: created.id });
        assert.equal(posts.length, 1, "slow follow-up must still be running after 202 accepted");
        assert.deepEqual(ticks, [created.id]);

        const release = releasePost;
        assert.ok(release, "expected the slow follow-up to be waiting");
        release();
        await waitUntil("slow follow-up bridge tick", () => ticks.length === 2);
        assert.equal(posts.length, 2);
        assert.equal(posts[1]!.content, "slow follow-up");
        assert.deepEqual(ticks, [created.id, created.id]);
      } finally {
        t.cleanup();
      }
    });

    it("POST /missions/:id/messages mirrors native tool call, progress, result, and final answer", async () => {
      const t = tmpDir();
      try {
        const deps = composeMissionDeps({ dataDir: t.dir, clock });
        const messages: TeamMessage[] = [];
        let messageCounter = 0;
        let eventCounter = 0;
        const threadBridge = createMissionThreadBridge({
          missionStore: deps.missionStore,
          teamMessageStore: {
            async list(threadId: string) {
              return messages
                .filter((message) => message.threadId === threadId)
                .sort((a, b) => a.createdAt - b.createdAt);
            },
          },
          activityStore: deps.activityStore,
          newEventId: () => `ev.tool-replay.${++eventCounter}`,
          clock,
        });
        const orchestrator = {
          async spawnThread() {
            return {
              threadId: "thread-tool-replay",
              leadRoleId: "role-lead",
              roleIds: ["role-lead"],
            };
          },
          async postUserMessage(input: { threadId: string; content: string }) {
            const nextCreatedAt = () => clock.now() + ++messageCounter;
            messages.push({
              id: `msg-${messageCounter}`,
              threadId: input.threadId,
              role: "user",
              name: "User",
              content: input.content,
              createdAt: nextCreatedAt(),
              updatedAt: clock.now(),
            });
            if (input.content !== "run browser task") return;
            messages.push({
              id: "assistant-tool-call",
              threadId: input.threadId,
              role: "assistant",
              name: "Lead",
              roleId: "role-lead",
              content: "",
              createdAt: nextCreatedAt(),
              updatedAt: clock.now(),
              toolCalls: [
                {
                  id: "call-browser",
                  name: "sessions_send",
                  arguments: { session_key: "worker:browser:1", message: "snapshot current page" },
                },
              ],
              toolProgress: [
                {
                  toolCallId: "call-browser",
                  toolName: "sessions_send",
                  phase: "progress",
                  summary: "Browser worker captured the current page snapshot.",
                  detail: { eventType: "browser.snapshot", targetId: "target-1" },
                  ts: clock.now() + 10,
                },
              ],
              metadata: { nativeToolUse: true, toolRound: 1 },
            });
            messages.push({
              id: "tool-browser-result",
              threadId: input.threadId,
              role: "tool",
              name: "sessions_send",
              content: "Page title: Example Domain",
              createdAt: nextCreatedAt(),
              updatedAt: clock.now(),
              toolCallId: "call-browser",
              toolStatus: "completed",
            });
            messages.push({
              id: "assistant-final",
              threadId: input.threadId,
              role: "assistant",
              name: "Lead",
              roleId: "role-lead",
              content: "The browser task completed with title Example Domain.",
              createdAt: nextCreatedAt(),
              updatedAt: clock.now(),
            });
          },
          threadBridge,
        };

        const created = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: "/missions",
            body: { title: "Tool replay" },
          }),
          res: created.res,
          url: new URL("http://127.0.0.1/missions"),
          deps: { ...deps, orchestrator },
        });
        const mission = created.getJson() as { id: string };
        const followUp = createResponse();
        await handleMissionRoutes({
          req: createRequest({
            method: "POST",
            url: `/missions/${mission.id}/messages`,
            body: { content: "run browser task" },
          }),
          res: followUp.res,
          url: new URL(`http://127.0.0.1/missions/${mission.id}/messages`),
          deps: { ...deps, orchestrator },
        });

        assert.equal(followUp.getStatus(), 202);
        await waitUntil("tool replay events", async () => {
          const timeline = await deps.activityStore.listByMission(mission.id, { limit: 50 });
          return timeline.some((event) => event.runtime?.toolCallId === "call-browser");
        });
        const timeline = await runJson<Array<{ kind: string; text: string; runtime?: Record<string, string> }>>(
          deps,
          "GET",
          `/missions/${mission.id}/timeline?limit=50`
        );
        const toolEvents = timeline.filter((event) => event.runtime?.toolCallId === "call-browser");
        assert.deepEqual(
          toolEvents.map((event) => event.runtime?.toolPhase),
          ["call", "progress", "result"]
        );
        assert.equal(
          toolEvents[0]?.runtime?.callInput,
          '{"session_key":"worker:browser:1","message":"snapshot current page"}'
        );
        assert.equal(
          toolEvents[1]?.runtime?.progressDetail,
          '{"eventType":"browser.snapshot","targetId":"target-1"}'
        );
        assert.equal(toolEvents[2]?.runtime?.resultContent, "Page title: Example Domain");
        assert.ok(
          timeline.some((event) => event.kind === "thought" && event.text.includes("title Example Domain")),
          "expected the final assistant answer to remain visible after tool replay"
        );
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
        await waitUntil("first follow-up post", () => posts.length === postsBefore + 1);
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

// Mission Control READ endpoints (PR K2).
//
//   GET  /missions                          → Mission[]
//   GET  /missions/:id                      → Mission
//   GET  /missions/:id/work-items           → WorkItem[]
//   GET  /missions/:id/timeline?limit=N     → ActivityEvent[]
//   GET  /missions/:id/artifacts            → Artifact[]
//   GET  /missions/:id/approvals            → ApprovalRequest[]
//   GET  /approvals                         → ApprovalRequest[]  (global queue)
//   GET  /mission-agents                    → Agent[]
//   GET  /mission-context-sources           → ContextSource[]
//   POST /missions/bootstrap-demo           → upsert design fixtures
//
// All routes are `read` scoped (see daemon-auth.ts) except
// /missions/bootstrap-demo which is `operator` — it writes data.
//
// Mission creation, mission follow-up messages, and approval decisions
// are mutation routes; the remaining mission surfaces are read-mostly
// so the dashboard can render without owning the coordination runtime.

import type http from "node:http";

import type {
  ActivityEvent,
  ActivityEventStore,
  AgentRegistry,
  ApprovalRequestStore,
  ArtifactStore,
  ContextSourceRegistry,
  Mission,
  MissionId,
  MissionStore,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";

import {
  parsePositiveLimit,
  readJsonBodySafe,
  sendJson,
} from "../http-helpers";
import {
  runIdempotently,
  type RouteIdempotencyStore,
} from "../idempotency-store";
import { buildDemoFixtures } from "../mission-demo-fixtures";
import type { MissionThreadBridge } from "../mission-thread-bridge";
import { recordApprovalDecision } from "../tool-permission-service";

/**
 * Optional bundle that turns the read-mostly Mission Control routes
 * into a real coordination surface (PR K3.5). When supplied, the
 * `POST /missions` route spawns a linked team-runtime thread on every
 * mission, and `POST /missions/:id/messages` routes user follow-ups
 * onto that thread so the coordination engine can react.
 *
 * Kept optional so unit tests for read-only behavior don't have to
 * mount the entire runtime stack.
 */
export interface MissionOrchestratorDeps {
  /** Creates a fresh team-runtime thread for a new mission. */
  spawnThread(input: {
    title: string;
    desc: string;
    owner: string;
  }): Promise<{ threadId: string; leadRoleId: string; roleIds: string[] }>;
  /** Posts a user message onto the linked thread (delegates to the
   *  coordination engine which wakes the role loop). */
  postUserMessage(input: { threadId: string; content: string }): Promise<void>;
  /** Mirrors the linked thread's messages onto the mission activity
   *  log immediately. Routes call this after each post so the new row
   *  appears without waiting for the next interval tick. */
  threadBridge: MissionThreadBridge;
}

export interface MissionRouteDeps {
  missionStore: MissionStore & {
    putRaw(mission: Mission): Promise<void>;
    create: MissionStore["create"];
  };
  workItemStore: WorkItemStore;
  activityStore: ActivityEventStore & {
    replaceAll(missionId: MissionId, events: ActivityEvent[]): Promise<void>;
  };
  approvalStore: ApprovalRequestStore & {
    listDecisions(): Promise<import("@turnkeyai/core-types/mission").ApprovalDecision[]>;
  };
  artifactStore: ArtifactStore;
  agentRegistry: AgentRegistry & { replaceAll(agents: import("@turnkeyai/core-types/mission").Agent[]): Promise<void> };
  contextSourceRegistry: ContextSourceRegistry & {
    replaceAll(sources: import("@turnkeyai/core-types/mission").ContextSource[]): Promise<void>;
  };
  clock: { now(): number };
  idGenerator: {
    missionId(): string;
    shortId(): string;
  };
  orchestrator?: MissionOrchestratorDeps;
  /**
   * Optional. When supplied, POST /missions/:id/messages honors the
   * Idempotency-Key header so a retried follow-up doesn't double-post
   * onto the linked thread. codex K3.5 flagged that the sibling
   * /messages route uses this store and /missions/:id/messages
   * didn't.
   */
  idempotencyStore?: RouteIdempotencyStore;
  /**
   * Optional. When supplied, GET /mission-context-sources returns
   * `[...live browser sessions, ...registry entries]` so the Mission
   * Detail right pane reflects the bridge's actual current state
   * instead of only what the registry has cached. Live entries use a
   * synthetic `ctx.browser.session.<sessionId>` id so they line up with
   * the recorder-emitted ActivityEvent.target field.
   */
  browserContextSourceProvider?: {
    listLive(): Promise<import("@turnkeyai/core-types/mission").ContextSource[]>;
  };
}

export async function handleMissionRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: MissionRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;
  const { pathname } = url;
  const method = req.method;

  if (method === "GET" && pathname === "/missions") {
    sendJson(res, 200, await deps.missionStore.list());
    return true;
  }

  if (method === "GET" && pathname === "/mission-agents") {
    sendJson(res, 200, await deps.agentRegistry.list());
    return true;
  }

  if (method === "GET" && pathname === "/mission-context-sources") {
    // Live browser sessions first so the right pane defaults to the
    // currently-attached context. The bundled provider catches its
    // own errors and returns []; we also wrap defensively here so a
    // future provider that doesn't (or rejects non-Error) cannot turn
    // the read endpoint into a 500. Failure to list the registry is
    // still surfaced — that signals corrupt persistence, not transient
    // bridge state.
    //
    // Scope note: this route is `read`-gated while /browser-sessions
    // is `operator`-gated. Live session IDs are not credentials; they
    // are opaque identifiers used to pair Mission Detail entries with
    // recorded ActivityEvents. Read-scope users already see the
    // mission's activity log; surfacing the session id alongside is
    // consistent with that view and required for the dashboard to
    // render. If session IDs become sensitive in a future deployment,
    // tighten this route — not the activity log.
    const livePromise = deps.browserContextSourceProvider
      ? deps.browserContextSourceProvider.listLive().catch(() => [] as import("@turnkeyai/core-types/mission").ContextSource[])
      : Promise.resolve([] as import("@turnkeyai/core-types/mission").ContextSource[]);
    const [live, registry] = await Promise.all([
      livePromise,
      deps.contextSourceRegistry.list(),
    ]);
    // De-dupe by id so a registry record that happens to share an id
    // with a live session (rare today, but possible once K4 starts
    // persisting browser sessions) doesn't appear twice. Live wins —
    // its state/lastUseAtMs reflect the bridge's actual moment-in-time.
    const seen = new Set(live.map((entry) => entry.id));
    const merged = [
      ...live,
      ...registry.filter((entry) => !seen.has(entry.id)),
    ];
    sendJson(res, 200, merged);
    return true;
  }

  if (method === "GET" && pathname === "/approvals") {
    // Two single-pass directory scans + a memory join, instead of N+1
    // per-approval getDecision reads (gemini K2 review). Stays O(N+D)
    // and lets a 100-approval queue render in one tick.
    const [approvals, decisions] = await Promise.all([
      deps.approvalStore.list(),
      deps.approvalStore.listDecisions(),
    ]);
    const decisionByApprovalId = new Map(
      decisions.map((d) => [d.approvalId, d] as const)
    );
    const withDecisions = approvals.map((a) => ({
      ...a,
      decision: decisionByApprovalId.get(a.id) ?? null,
    }));
    sendJson(res, 200, withDecisions);
    return true;
  }

  const approvalDecisionMatch = pathname.match(/^\/approvals\/([^/]+)\/decision$/);
  if (method === "POST" && approvalDecisionMatch) {
    let approvalId: string;
    try {
      approvalId = decodeURIComponent(approvalDecisionMatch[1]!);
    } catch {
      sendJson(res, 400, { error: "invalid approval id encoding" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<{
      decision?: unknown;
      decidedBy?: unknown;
      reason?: unknown;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const decision = readApprovalDecision(bodyResult.value.decision);
    if (!decision) {
      sendJson(res, 400, { error: "decision must be approved or denied" });
      return true;
    }
    const decidedBy = readNonEmptyString(bodyResult.value.decidedBy) ?? "operator";
    const reason = readNonEmptyString(bodyResult.value.reason);
    try {
      const result = await recordApprovalDecision({
        approvalStore: deps.approvalStore,
        activityStore: deps.activityStore,
        clock: deps.clock,
        newEventId: () => `ev.${approvalId}.${deps.clock.now()}`,
        approvalId,
        decision,
        decidedBy,
        ...(reason ? { reason } : {}),
      });
      sendJson(res, 200, result);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "approval not found" ? 404 : message === "approval already decided" ? 409 : 500;
      sendJson(res, status, { error: message });
      return true;
    }
  }

  if (method === "POST" && pathname === "/missions") {
    // PR K3.5 — create a mission AND spawn its linked team-runtime
    // thread atomically. Without the orchestrator we can still persist
    // the Mission record (useful in tests that exercise read paths),
    // but a user-facing create without a thread can't get follow-ups
    // — surface a 501 so the caller is told to bring the orchestrator
    // up rather than silently filing inert missions.
    if (!deps.orchestrator) {
      sendJson(res, 501, { error: "mission orchestrator not configured" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<{
      title?: unknown;
      desc?: unknown;
      mode?: unknown;
      modeLabel?: unknown;
      owner?: unknown;
      ownerLabel?: unknown;
      agents?: unknown;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const title = readNonEmptyString(body.title);
    if (!title) {
      sendJson(res, 400, { error: "title is required" });
      return true;
    }
    const desc = readString(body.desc) ?? "";
    // coderabbit K3.5 round-1: reject provided-but-invalid mode
    // with 400 instead of silently coercing to "custom". A missing
    // `mode` field still defaults to "custom" (intentional — the
    // dashboard's mode dropdown only sends a value when the user
    // picks one explicitly).
    let mode: import("@turnkeyai/core-types/mission").MissionMode = "custom";
    if (body.mode !== undefined) {
      const parsed = readMissionMode(body.mode);
      if (parsed === null) {
        sendJson(res, 400, { error: "mode is invalid" });
        return true;
      }
      mode = parsed;
    }
    const modeLabel = readNonEmptyString(body.modeLabel) ?? defaultModeLabel(mode);
    const owner = readNonEmptyString(body.owner) ?? "you";
    const ownerLabel = readNonEmptyString(body.ownerLabel) ?? "You";

    // Spawn the thread FIRST so we never persist a mission whose
    // threadId references nothing. If spawnThread throws, the mission
    // is never created.
    //
    // coderabbit K3.5: this sequence is NOT fully atomic — if
    // putRaw or postUserMessage throws after spawnThread succeeded,
    // we leak an orphan thread (and possibly a half-initialized
    // mission). We compensate with a best-effort cleanup: on any
    // failure after spawnThread, log loudly so an operator can
    // garbage-collect the orphan thread. A real transaction wrapper
    // lands with the K4 approval queue work, where the cost of
    // half-states becomes more visible (a pending approval pointing
    // at a non-existent mission would be much worse than a stray
    // empty team thread today).
    const thread = await deps.orchestrator.spawnThread({ title, desc, owner });
    let createdOk = false;
    try {
      const agents = Array.isArray(body.agents) && body.agents.every((a) => typeof a === "string")
        ? (body.agents as string[])
        : thread.roleIds;
      // gemini K3.5: write the fully-formed mission in ONE atomic
      // putRaw rather than calling create() (which writes once) and
      // then putRaw() (a second write to attach threadId). The
      // threadId is server-injected so it doesn't fit
      // CreateMissionInput; assembling the full Mission shape here
      // and persisting once keeps the create path single-write.
      const nowMs = deps.clock.now();
      const linked: Mission = {
        id: deps.idGenerator.missionId(),
        shortId: deps.idGenerator.shortId(),
        title,
        desc,
        status: "working",
        mode,
        modeLabel,
        owner,
        ownerLabel,
        createdAt: new Date(nowMs).toISOString(),
        createdAtMs: nowMs,
        agents,
        progress: 0,
        pendingApprovals: 0,
        blockers: 0,
        contextSummary: [],
        threadId: thread.threadId,
      };
      await deps.missionStore.putRaw(linked);

      createdOk = true;
      sendJson(res, 201, linked);
      startMissionInBackground({
        deps,
        orchestrator: deps.orchestrator,
        mission: linked,
        threadId: thread.threadId,
        content: desc.length > 0 ? `${title}\n\n${desc}` : title,
      });
      return true;
    } finally {
      if (!createdOk) {
        console.error("mission creation failed after thread spawn — orphan thread", {
          threadId: thread.threadId,
        });
      }
    }
  }

  // /missions/:id/messages — user follow-up on a linked thread.
  const followUpMatch = pathname.match(/^\/missions\/([^/]+)\/messages$/);
  if (method === "POST" && followUpMatch) {
    if (!deps.orchestrator) {
      sendJson(res, 501, { error: "mission orchestrator not configured" });
      return true;
    }
    // coderabbit K3.5: decodeURIComponent throws URIError on
    // malformed escapes (e.g. "%E0%A4%A"). Return 400 instead of
    // letting the global 500 handler take over.
    let missionId: string;
    try {
      missionId = decodeURIComponent(followUpMatch[1]!);
    } catch {
      sendJson(res, 400, { error: "invalid mission id encoding" });
      return true;
    }
    const mission = await deps.missionStore.get(missionId);
    if (!mission) {
      sendJson(res, 404, { error: "mission not found" });
      return true;
    }
    if (!mission.threadId) {
      sendJson(res, 409, {
        error: "mission has no linked thread",
        code: "mission_thread_missing",
      });
      return true;
    }
    const bodyResult = await readJsonBodySafe<{ content?: unknown }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const content = readNonEmptyString(bodyResult.value.content);
    if (!content) {
      sendJson(res, 400, { error: "content is required" });
      return true;
    }
    // codex K3.5: honor Idempotency-Key so a retried follow-up
    // doesn't double-post on the linked thread. Fingerprinting on
    // (missionId, content) — same key + same payload replays the
    // cached 202; same key + different content surfaces 409.
    const orchestrator = deps.orchestrator;
    const linkedThreadId = mission.threadId;
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: `missions:${mission.id}:messages`,
      fingerprint: { missionId: mission.id, content },
      execute: async () => {
        await orchestrator.postUserMessage({
          threadId: linkedThreadId,
          content,
        });
        await orchestrator.threadBridge.tickMission(mission.id);
        return {
          statusCode: 202,
          body: { accepted: true, missionId: mission.id },
        };
      },
    });
  }

  if (method === "POST" && pathname === "/missions/bootstrap-demo") {
    const fixtures = buildDemoFixtures(deps.clock.now());
    await Promise.all([
      ...fixtures.missions.map((m) => deps.missionStore.putRaw(m)),
      ...fixtures.workItems.map((w) => deps.workItemStore.put(w)),
      ...fixtures.approvals.map((a) => deps.approvalStore.put(a)),
      // Artifacts (codex K2 #2 — was missing). The demo timeline
      // references `evidence/notion_pricing.json` as a registered
      // artifact; without writing it here, GET /missions/msn.01/artifacts
      // would lie by returning [].
      ...fixtures.artifacts.map((a) => deps.artifactStore.put(a)),
      deps.activityStore.replaceAll(
        // The fixtures only have a timeline for msn.01 — find it from
        // the first event.
        fixtures.timeline[0]?.missionId ?? "msn.01",
        fixtures.timeline
      ),
      deps.agentRegistry.replaceAll(fixtures.agents),
      deps.contextSourceRegistry.replaceAll(fixtures.contextSources),
    ]);
    sendJson(res, 201, {
      ok: true,
      missions: fixtures.missions.length,
      workItems: fixtures.workItems.length,
      approvals: fixtures.approvals.length,
      artifacts: fixtures.artifacts.length,
      timeline: fixtures.timeline.length,
      agents: fixtures.agents.length,
      contextSources: fixtures.contextSources.length,
    });
    return true;
  }

  // /missions/:id and friends — parse the id from the path.
  const missionMatch = pathname.match(
    /^\/missions\/([^/]+)(?:\/(work-items|timeline|artifacts|approvals))?$/
  );
  if (method === "GET" && missionMatch) {
    const id = decodeURIComponent(missionMatch[1]!);
    const sub = missionMatch[2];
    if (!sub) {
      const mission = await deps.missionStore.get(id);
      if (!mission) {
        sendJson(res, 404, { error: "mission not found" });
        return true;
      }
      sendJson(res, 200, mission);
      return true;
    }
    if (sub === "work-items") {
      sendJson(res, 200, await deps.workItemStore.listByMission(id));
      return true;
    }
    if (sub === "timeline") {
      // limit is optional (defaults to 200). gemini K2 caught the prior
      // implementation rejected requests without a limit param because
      // parsePositiveLimit(null) → 100 historically but the call site
      // treated null as "bad". Explicit handling here: missing param =
      // default 200, present-but-malformed = 400.
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam === null ? 200 : parsePositiveLimit(limitParam);
      if (limit === null) {
        sendJson(res, 400, { error: "limit must be a positive integer" });
        return true;
      }
      sendJson(
        res,
        200,
        await deps.activityStore.listByMission(id, { limit })
      );
      return true;
    }
    if (sub === "artifacts") {
      sendJson(res, 200, await deps.artifactStore.listByMission(id));
      return true;
    }
    if (sub === "approvals") {
      sendJson(res, 200, await deps.approvalStore.listByMission(id));
      return true;
    }
  }

  return false;
}

function startMissionInBackground(input: {
  deps: MissionRouteDeps;
  orchestrator: MissionOrchestratorDeps;
  mission: Mission;
  threadId: string;
  content: string;
}): void {
  void (async () => {
    try {
      // Keep mission creation fast. The first user turn wakes the
      // coordination engine, which may call a real LLM or tool and must
      // not hold the "Create mission" request open.
      await input.orchestrator.postUserMessage({
        threadId: input.threadId,
        content: input.content,
      });
      await input.orchestrator.threadBridge.tickMission(input.mission.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("mission background start failed", {
        missionId: input.mission.id,
        threadId: input.threadId,
        error,
      });
      const now = input.deps.clock.now();
      try {
        const latestMission = (await input.deps.missionStore.get(input.mission.id)) ?? input.mission;
        await input.deps.missionStore.putRaw({
          ...latestMission,
          status: "blocked",
          blockers: Math.max(latestMission.blockers, 1),
        });
        await input.deps.activityStore.append({
          id: `mission-start-failed:${input.mission.id}:${now}`,
          missionId: input.mission.id,
          tMs: now,
          kind: "recovery",
          actor: "system",
          text: "mission.start_failed",
          emph: "danger",
          tags: ["mission_start_failed"],
          runtime: {
            eventType: "mission.start_failed",
            threadId: input.threadId,
            errorMessage: message,
          },
        });
      } catch (recordError) {
        console.error("mission background start failure recording failed", {
          missionId: input.mission.id,
          error: recordError,
        });
      }
    }
  })();
}

const VALID_MODES = new Set([
  "research",
  "monitor",
  "browser",
  "review",
  "investigation",
  "custom",
]);

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readApprovalDecision(value: unknown): "approved" | "denied" | null {
  return value === "approved" || value === "denied" ? value : null;
}

function readMissionMode(
  value: unknown
): import("@turnkeyai/core-types/mission").MissionMode | null {
  if (typeof value !== "string") return null;
  return VALID_MODES.has(value)
    ? (value as import("@turnkeyai/core-types/mission").MissionMode)
    : null;
}

function defaultModeLabel(
  mode: import("@turnkeyai/core-types/mission").MissionMode
): string {
  switch (mode) {
    case "research":
      return "Research";
    case "monitor":
      return "Monitor";
    case "browser":
      return "Browser";
    case "review":
      return "Review";
    case "investigation":
      return "Investigation";
    case "custom":
      return "Custom";
  }
}

// Mission Control endpoints.
//
//   GET  /missions                          → Mission[]
//   GET  /missions/:id                      → Mission
//   GET  /missions/:id/work-items           → WorkItem[]
//   GET  /missions/:id/timeline?limit=N     → ActivityEvent[]
//   GET  /missions/:id/timeline?page=true   → { events, nextCursor, hasMore }
//   GET  /missions/:id/artifacts            → Artifact[]
//   GET  /missions/:id/approvals            → ApprovalRequest[]
//   GET  /missions/:id/metrics              → MissionObservabilitySnapshot
//   GET  /approvals                         → ApprovalRequest[]  (global queue)
//   GET  /mission-agents                    → Agent[]
//   GET  /mission-context-sources           → ContextSource[]
//   POST /mission-context-sources           → register manual ContextSource
//   POST /missions/reconcile                → force mission/thread mirror pass
//   POST /missions/:id/reconcile            → force one mission/thread mirror pass
//   POST /missions/:id/cancel               → cancel the active linked runtime
//   POST /missions/:id/archive              → archive a terminal mission
//   POST /missions/bootstrap-demo           → upsert design fixtures
//
// Read routes are `read` scoped (see daemon-auth.ts); mutation routes
// such as /mission-context-sources and /missions/bootstrap-demo are
// `operator` scoped because they write data.
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
  ContextKind,
  ContextSource,
  ContextSourceRegistry,
  Mission,
  MissionMode,
  MissionId,
  MissionStore,
  WorkItemStore,
} from "@turnkeyai/core-types/mission";

const MISSION_BACKGROUND_MIRROR_INTERVAL_MS = 1000;
import type {
  RoleLoopRunner,
  RoleRunStore,
  RuntimeProgressEvent,
  RuntimeProgressStore,
  TeamMessage,
  TeamMessageStore,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import type { ToolCancellationRegistry } from "@turnkeyai/role-runtime/tool-cancellation-registry";
import type { ToolPermissionService } from "@turnkeyai/role-runtime/tool-permission-service";

import {
  parsePositiveLimit,
  readJsonBodySafe,
  readOptionalJsonBodySafe,
  sendJson,
} from "../http-helpers";
import {
  runIdempotently,
  type RouteIdempotencyStore,
} from "../idempotency-store";
import { buildDemoFixtures } from "../mission-demo-fixtures";
import { buildMissionObservabilitySnapshot } from "../mission-observability";
import type { MissionThreadBridge } from "../mission-thread-bridge";
import { recordApprovalDecision } from "../tool-permission-service";
import { cancelToolCallsOnMessage } from "./workflow-routes";

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
    mode: MissionMode;
  }): Promise<{ threadId: string; leadRoleId: string; roleIds: string[] }>;
  /** Posts a user message onto the linked thread (delegates to the
   *  coordination engine which wakes the role loop). */
  postUserMessage(input: {
    threadId: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<void>;
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
  toolPermissionService?: Pick<ToolPermissionService, "apply">;
  runtimeProgressStore?: Pick<RuntimeProgressStore, "listByThread">;
  teamMessageStore?: TeamMessageStore;
  roleRunStore?: Pick<RoleRunStore, "listByThread">;
  roleLoopRunner?: Pick<RoleLoopRunner, "cancel">;
  workerRuntime?: Pick<WorkerRuntime, "cancel" | "listSessions">;
  toolCancellationRegistry?: ToolCancellationRegistry;
}

const DEFAULT_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_LIMIT = 500;

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

  if (method === "POST" && pathname === "/mission-context-sources") {
    const bodyResult = await readJsonBodySafe<{
      kind?: unknown;
      title?: unknown;
      url?: unknown;
      path?: unknown;
      state?: unknown;
      writer?: unknown;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const kind = readManualContextKind(bodyResult.value.kind);
    if (!kind) {
      sendJson(res, 400, { error: "kind must be doc, folder, api, or desktop" });
      return true;
    }
    const title = readNonEmptyString(bodyResult.value.title);
    if (!title) {
      sendJson(res, 400, { error: "title is required" });
      return true;
    }
    const url = readNonEmptyString(bodyResult.value.url);
    const path = readNonEmptyString(bodyResult.value.path);
    if (url && path) {
      sendJson(res, 400, { error: "Provide either url or path, not both" });
      return true;
    }
    const urlOrPath = url ?? path;
    if (!urlOrPath) {
      sendJson(res, 400, { error: "url or path is required" });
      return true;
    }
    const state = readNonEmptyString(bodyResult.value.state) ?? defaultContextSourceState(kind);
    const writer = readNonEmptyString(bodyResult.value.writer);

    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: "mission-context-sources:create",
      fingerprint: { kind, title, url: urlOrPath, state, writer },
      execute: async () => {
        const existing = await deps.contextSourceRegistry.list();
        const source = buildManualContextSource({
          existing,
          kind,
          title,
          url: urlOrPath,
          state,
          writer,
          nowMs: deps.clock.now(),
        });
        await deps.contextSourceRegistry.replaceAll([...existing, source]);
        return { statusCode: 201, body: source };
      },
    });
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
        missionStore: deps.missionStore,
        activityStore: deps.activityStore,
        clock: deps.clock,
        newEventId: () => `ev.${approvalId}.${deps.clock.now()}`,
        approvalId,
        decision,
        decidedBy,
        ...(reason ? { reason } : {}),
      });
      await applyApprovedPermissionDecision({
        approval: result.approval,
        decision: result.decision.decision,
        ...(deps.toolPermissionService ? { toolPermissionService: deps.toolPermissionService } : {}),
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
    const thread = await deps.orchestrator.spawnThread({ title, desc, owner, mode });
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
        const followUpMission = await reopenDoneMissionForFollowUp(deps, mission);
        startMissionFollowUpInBackground({
          deps,
          orchestrator,
          mission: followUpMission,
          threadId: linkedThreadId,
          content,
        });
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

  if (method === "POST" && pathname === "/missions/reconcile") {
    const threadBridge = deps.orchestrator?.threadBridge;
    if (!threadBridge || typeof threadBridge.tickAll !== "function") {
      sendJson(res, 501, { error: "mission reconcile not configured" });
      return true;
    }
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: "missions:reconcile",
      fingerprint: { scope: "all" },
      execute: async () => {
        const missions = await threadBridge.tickAll();
        return {
          statusCode: 200,
          body: {
            ok: true,
            scope: "all",
            missions,
            appended: missions.reduce((sum, mission) => sum + mission.appended, 0),
          },
        };
      },
    });
  }

  const reconcileMissionMatch = pathname.match(/^\/missions\/([^/]+)\/reconcile$/);
  if (method === "POST" && reconcileMissionMatch) {
    const threadBridge = deps.orchestrator?.threadBridge;
    if (!threadBridge || typeof threadBridge.tickMission !== "function") {
      sendJson(res, 501, { error: "mission reconcile not configured" });
      return true;
    }
    let missionId: string;
    try {
      missionId = decodeURIComponent(reconcileMissionMatch[1]!);
    } catch {
      sendJson(res, 400, { error: "invalid mission id encoding" });
      return true;
    }
    const mission = await deps.missionStore.get(missionId);
    if (!mission) {
      sendJson(res, 404, { error: "mission not found" });
      return true;
    }
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: `missions:${mission.id}:reconcile`,
      fingerprint: { missionId: mission.id },
      execute: async () => {
        const appended = await threadBridge.tickMission(mission.id);
        return {
          statusCode: 200,
          body: {
            ok: true,
            scope: "mission",
            missionId: mission.id,
            appended,
          },
        };
      },
    });
  }

  const cancelMissionMatch = pathname.match(/^\/missions\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMissionMatch) {
    let missionId: string;
    try {
      missionId = decodeURIComponent(cancelMissionMatch[1]!);
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
    const bodyResult = await readOptionalJsonBodySafe<{ reason?: unknown }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const reason = readNonEmptyString(bodyResult.value?.reason) ?? "mission cancelled by operator";
    if (reason.length > 1_000) {
      sendJson(res, 400, { error: "reason must be at most 1000 characters" });
      return true;
    }
    const threadId = mission.threadId;
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: `missions:${mission.id}:cancel`,
      fingerprint: { missionId: mission.id, reason },
      execute: async () => {
        const result = await cancelMissionRuntime({ deps, mission, threadId, reason });
        return { statusCode: 200, body: result };
      },
    });
  }

  const archiveMissionMatch = pathname.match(/^\/missions\/([^/]+)\/archive$/);
  if (method === "POST" && archiveMissionMatch) {
    let missionId: string;
    try {
      missionId = decodeURIComponent(archiveMissionMatch[1]!);
    } catch {
      sendJson(res, 400, { error: "invalid mission id encoding" });
      return true;
    }
    const mission = await deps.missionStore.get(missionId);
    if (!mission) {
      sendJson(res, 404, { error: "mission not found" });
      return true;
    }
    return runIdempotently({
      req,
      res,
      store: deps.idempotencyStore,
      scope: `missions:${mission.id}:archive`,
      fingerprint: { missionId: mission.id },
      execute: async () => {
        if (mission.status === "working" || mission.status === "planning" || mission.status === "needs_approval") {
          return {
            statusCode: 409,
            body: {
              error: "mission is still active",
              code: "mission_active",
              status: mission.status,
            },
          };
        }
        const archived: Mission = {
          ...mission,
          status: "archived",
        };
        await deps.missionStore.putRaw(archived);
        return {
          statusCode: 200,
          body: archived,
        };
      },
    });
  }

  // /missions/:id and friends — parse the id from the path.
  const missionMatch = pathname.match(
    /^\/missions\/([^/]+)(?:\/(work-items|timeline|artifacts|approvals|metrics))?$/
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
      const parsedLimit = limitParam === null ? DEFAULT_TIMELINE_LIMIT : parsePositiveLimit(limitParam);
      const limit = parsedLimit === null ? null : Math.min(parsedLimit, MAX_TIMELINE_LIMIT);
      if (limit === null) {
        sendJson(res, 400, { error: "limit must be a positive integer" });
        return true;
      }
      const wantsPage = url.searchParams.get("page") === "true";
      const cursorParam = url.searchParams.get("cursor");
      const cursor = cursorParam ? decodeTimelineCursor(cursorParam) : null;
      if (cursorParam && !cursor) {
        sendJson(res, 400, { error: "cursor must be a valid timeline cursor" });
        return true;
      }
      if (wantsPage) {
        const rawEvents = await loadMissionTimelineEvents(deps, id, {
          limit: limit + 1,
          ...(cursor ? { before: cursor } : {}),
        });
        const hasMore = rawEvents.length > limit;
        const events = hasMore ? rawEvents.slice(1) : rawEvents;
        sendJson(res, 200, {
          events,
          nextCursor: hasMore && events.length > 0 ? encodeTimelineCursor(events[0]!) : null,
          hasMore,
          limit,
        });
        return true;
      }
      sendJson(
        res,
        200,
        await loadMissionTimelineEvents(deps, id, {
          limit,
          ...(cursor ? { before: cursor } : {}),
        })
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
    if (sub === "metrics") {
      const mission = await deps.missionStore.get(id);
      if (!mission) {
        sendJson(res, 404, { error: "mission not found" });
        return true;
      }
      sendJson(
        res,
        200,
        buildMissionObservabilitySnapshot({
          mission,
          events: await deps.activityStore.listByMission(id),
          progressEvents:
            mission.threadId && deps.runtimeProgressStore
              ? await deps.runtimeProgressStore.listByThread(mission.threadId, 500)
              : [],
          nowMs: deps.clock.now(),
        })
      );
      return true;
    }
  }

  return false;
}

async function loadMissionTimelineEvents(
  deps: MissionRouteDeps,
  missionId: string,
  options?: { limit?: number; before?: { tMs: number; id: string } }
): Promise<ActivityEvent[]> {
  if (!deps.runtimeProgressStore) {
    const activityEvents = await deps.activityStore.listByMission(missionId, options);
    return pageTimelineEvents(orderTimelineEventsForDisplay(activityEvents), options);
  }
  const mission = await deps.missionStore.get(missionId);
  if (!mission?.threadId) {
    const activityEvents = await deps.activityStore.listByMission(missionId, options);
    return pageTimelineEvents(orderTimelineEventsForDisplay(activityEvents), options);
  }
  const [activityEvents, progressEvents] = await Promise.all([
    deps.activityStore.listByMission(missionId, options),
    deps.runtimeProgressStore.listByThread(mission.threadId, 500),
  ]);
  const merged = [
    ...activityEvents,
    ...progressEvents.flatMap((event) => buildTimelineEventFromRuntimeProgress(missionId, event)),
  ];
  return pageTimelineEvents(orderTimelineEventsForDisplay(merged), options);
}

function pageTimelineEvents(
  ordered: ActivityEvent[],
  options?: { limit?: number; before?: { tMs: number; id: string } }
): ActivityEvent[] {
  const visible = options?.before
    ? ordered.filter((event) => compareTimelineEventToCursor(event, options.before!) < 0)
    : ordered;
  if (typeof options?.limit === "number" && options.limit > 0) {
    return visible.slice(-options.limit);
  }
  return visible;
}

function orderTimelineEventsForDisplay(events: ActivityEvent[]): ActivityEvent[] {
  const toolCallAnchors = new Map<string, number>();
  for (const event of events) {
    const runtime = event.runtime;
    const toolCallId = runtime?.toolCallId;
    if (!toolCallId || runtime?.toolPhase !== "call") continue;
    const current = toolCallAnchors.get(toolCallId);
    if (current === undefined || event.tMs < current) {
      toolCallAnchors.set(toolCallId, event.tMs);
    }
  }
  return [...events].sort((left, right) => {
    const leftKey = timelineDisplaySortKey(left, toolCallAnchors);
    const rightKey = timelineDisplaySortKey(right, toolCallAnchors);
    return (
      leftKey.tMs - rightKey.tMs ||
      leftKey.phaseRank - rightKey.phaseRank ||
      left.tMs - right.tMs ||
      left.id.localeCompare(right.id)
    );
  });
}

function timelineDisplaySortKey(
  event: ActivityEvent,
  toolCallAnchors: ReadonlyMap<string, number>
): { tMs: number; phaseRank: number } {
  const toolCallId = event.runtime?.toolCallId;
  const anchorTMs = toolCallId ? toolCallAnchors.get(toolCallId) : undefined;
  const phaseRank = timelineToolPhaseRank(event);
  if (anchorTMs !== undefined && phaseRank > 0 && event.tMs <= anchorTMs) {
    return { tMs: anchorTMs + phaseRank / 1000, phaseRank };
  }
  return { tMs: event.tMs, phaseRank };
}

function timelineToolPhaseRank(event: ActivityEvent): number {
  const runtime = event.runtime;
  if (runtime?.toolPhase === "call") return 0;
  if (runtime?.toolPhase === "progress") return 1;
  if (runtime?.eventType === "permission.query") return 2;
  if (runtime?.eventType === "permission.result") return 3;
  if (runtime?.eventType === "permission.applied") return 4;
  if (runtime?.toolPhase === "result") return 9;
  return 5;
}

function buildTimelineEventFromRuntimeProgress(
  missionId: string,
  event: RuntimeProgressEvent
): ActivityEvent[] {
  const toolName = readRuntimeProgressToolName(event);
  if (!shouldExposeRuntimeProgressOnTimeline(event, toolName)) {
    return [];
  }
  const display = displayRuntimeProgressEvent(event, toolName);
  const runtime: Record<string, string> = {
    activitySourceId: `runtime-progress:${event.progressId}`,
    progressId: event.progressId,
    runtimeSource: "runtime_progress",
    progressPhase: event.phase,
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
  };
  if (event.chainId) runtime.chainId = event.chainId;
  if (event.spanId) runtime.spanId = event.spanId;
  if (event.parentSpanId) runtime.parentSpanId = event.parentSpanId;
  if (event.flowId) runtime.flowId = event.flowId;
  if (event.taskId) runtime.taskId = event.taskId;
  if (event.roleId) runtime.teamRole = event.roleId;
  if (event.workerType) runtime.workerType = event.workerType;
  if (toolName) runtime.toolName = toolName;
  const lifecycleEventType = readStringFromRecord(event.metadata, "eventType");
  if (lifecycleEventType === "run.lifecycle") {
    runtime.eventType = lifecycleEventType;
    copyRuntimeMetadataString(event.metadata, runtime, "lifecycleKind");
    copyRuntimeMetadataString(event.metadata, runtime, "attemptId");
    copyRuntimeMetadataString(event.metadata, runtime, "activity", "providerActivity");
    copyRuntimeMetadataString(event.metadata, runtime, "phase", "modelPhase");
    copyRuntimeMetadataString(event.metadata, runtime, "round", "modelRound");
    copyRuntimeMetadataString(event.metadata, runtime, "code");
    copyRuntimeMetadataString(event.metadata, runtime, "status");
  }
  const toolCallId = readStringFromRecord(event.metadata, "toolCallId");
  if (toolCallId) runtime.toolCallId = toolCallId;
  const detail = readRecordFromRecord(event.metadata, "detail");
  const sessionKey = readStringFromRecord(detail, "session_key");
  if (sessionKey) runtime.sessionKey = sessionKey;
  const browserSessionId = event.artifacts?.browserSessionId;
  if (browserSessionId) runtime.browserSessionId = browserSessionId;

  return [
    {
      id: `runtime-progress:${event.progressId}`,
      missionId,
      tMs: event.recordedAt,
      kind: display.kind,
      actor: display.actor,
      text: display.text,
      tags: [
        "runtime-progress",
        display.kind,
        ...(toolName ? [toolName] : []),
        event.phase,
      ],
      runtime,
      ...(event.phase === "completed" ? { emph: "success" as const } : {}),
      ...(event.phase === "failed" || event.phase === "cancelled" ? { emph: "danger" as const } : {}),
    },
  ];
}

function shouldExposeRuntimeProgressOnTimeline(event: RuntimeProgressEvent, toolName: string | null): boolean {
  if (event.progressId.includes("session-memory") || event.summary.startsWith("Session memory ")) {
    return false;
  }
  if (event.summary.startsWith("Scheduled session memory ")) {
    return false;
  }
  if (event.summary.startsWith("Provider tool protocol round")) {
    return false;
  }
  if (event.metadata?.["eventType"] === "run.lifecycle") {
    return true;
  }
  if (event.progressKind === "heartbeat" && event.heartbeatSource === "long_running_tick") {
    return false;
  }
  if (event.subjectKind === "worker_run") {
    return (
      event.phase === "started" ||
      event.phase === "completed" ||
      event.phase === "failed" ||
      event.phase === "cancelled"
    );
  }
  if (event.subjectKind === "dispatch") {
    return (
      event.statusReason === "dispatch_handoff_queued" ||
      event.statusReason === "dispatch_role_inbox_accepted" ||
      event.statusReason === "dispatch_role_loop_signaled"
    );
  }
  if (toolName) {
    if (toolName.startsWith("browser_")) {
      return isUsefulBrowserToolSummary(event.summary);
    }
    return event.summary.startsWith("Tool call started:") || event.summary.startsWith("Tool call completed:");
  }
  if (event.subjectKind === "role_run") {
    return (
      event.phase === "started" ||
      event.phase === "completed" ||
      event.statusReason === "role_loop_dequeued" ||
      event.statusReason === "role_loop_hydrated"
    );
  }
  return false;
}

function displayRuntimeProgressEvent(
  event: RuntimeProgressEvent,
  toolName: string | null
): { kind: ActivityEvent["kind"]; actor: string; text: string } {
  if (event.subjectKind === "worker_run") {
    const worker = event.workerType ?? "worker";
    return {
      kind: worker === "browser" ? "browser" : "tool",
      actor: worker === "browser" ? "browser" : event.roleId ?? "role-lead",
      text: humanizeWorkerProgress(event, worker),
    };
  }
  if (event.subjectKind === "dispatch") {
    return {
      kind: "thought",
      actor: event.roleId ?? "role-lead",
      text: humanizeDispatchProgress(event),
    };
  }
  if (toolName) {
    return {
      kind: toolName.startsWith("browser_") ? "browser" : "tool",
      actor: event.roleId ?? "role-lead",
      text: humanizeToolProgress(event, toolName),
    };
  }
  return {
    kind: "thought",
    actor: event.roleId ?? "role-lead",
    text: humanizeRoleProgress(event),
  };
}

function humanizeRoleProgress(event: RuntimeProgressEvent): string {
  if (event.metadata?.["eventType"] === "run.lifecycle") {
    return event.summary;
  }
  switch (event.statusReason) {
    case "role_loop_dequeued":
      return "Lead picked up the task.";
    case "role_loop_hydrated":
      return "Lead prepared the task context.";
    default:
      if (event.phase === "started") return "Lead started working.";
      if (event.phase === "completed") return "Lead finished this turn.";
      return event.summary;
  }
}

function copyRuntimeMetadataString(
  metadata: Record<string, unknown> | undefined,
  runtime: Record<string, string>,
  sourceKey: string,
  targetKey = sourceKey,
): void {
  const value = metadata?.[sourceKey];
  if (typeof value === "string" && value.trim()) {
    runtime[targetKey] = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    runtime[targetKey] = String(value);
  }
}

function humanizeDispatchProgress(event: RuntimeProgressEvent): string {
  const role = event.roleId ?? "Lead";
  switch (event.statusReason) {
    case "dispatch_handoff_queued":
      return `Queued the task for ${role}.`;
    case "dispatch_role_inbox_accepted":
      return `${role} accepted the task.`;
    case "dispatch_role_loop_signaled":
      return `Woke ${role} to start work.`;
    default:
      return event.summary;
  }
}

function humanizeToolProgress(event: RuntimeProgressEvent, toolName: string): string {
  if (event.summary.startsWith("Browser observed") || event.summary.startsWith("Browser failure")) {
    return event.summary;
  }
  if (event.phase === "started") return `Started ${toolName}.`;
  if (event.phase === "completed") return `Completed ${toolName}.`;
  if (event.phase === "failed") return `${toolName} failed.`;
  if (event.phase === "cancelled") return `${toolName} was cancelled.`;
  return event.summary;
}

function humanizeWorkerProgress(event: RuntimeProgressEvent, worker: string): string {
  if (event.phase === "started") return `${labelWorker(worker)} started.`;
  if (event.phase === "completed") return event.summary;
  if (event.phase === "failed") return `${labelWorker(worker)} failed.`;
  if (event.phase === "cancelled") return `${labelWorker(worker)} was cancelled.`;
  return event.summary;
}

function labelWorker(worker: string): string {
  if (worker === "explore") return "Research worker";
  if (worker === "browser") return "Browser worker";
  return `${worker} worker`;
}

function isUsefulBrowserToolSummary(summary: string): boolean {
  return (
    summary.startsWith("Tool call started: browser_") ||
    summary.startsWith("Tool call completed: browser_") ||
    summary.startsWith("Browser observed") ||
    summary.startsWith("Browser failure")
  );
}

function readRuntimeProgressToolName(event: RuntimeProgressEvent): string | null {
  const toolName = readStringFromRecord(event.metadata, "toolName");
  if (toolName) return toolName;
  const toolNames = readArrayFromRecord(event.metadata, "toolNames").filter(
    (item): item is string => typeof item === "string"
  );
  return toolNames.length === 1 ? toolNames[0]! : null;
}

function readRecordFromRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = (value as Record<string, unknown>)[key];
  return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
}

function readStringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" && item.trim().length > 0 ? item : null;
}

function readArrayFromRecord(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item) ? item : [];
}

function compareTimelineEvents(left: ActivityEvent, right: ActivityEvent): number {
  return compareTimelineEventToCursor(left, { tMs: right.tMs, id: right.id });
}

function compareTimelineEventToCursor(
  event: ActivityEvent,
  cursor: { tMs: number; id: string }
): number {
  if (event.tMs !== cursor.tMs) return event.tMs - cursor.tMs;
  return event.id.localeCompare(cursor.id);
}

async function cancelMissionRuntime(input: {
  deps: MissionRouteDeps;
  mission: Mission;
  threadId: string;
  reason: string;
}): Promise<{
  cancelled: boolean;
  missionId: string;
  threadId: string;
  roleRuns: { requested: number; cancelled: number };
  toolCalls: { messages: number; requested: number; cancelled: number };
  workerSessions: { requested: number; cancelled: number };
}> {
  const { deps, mission, threadId, reason } = input;
  const now = deps.clock.now();
  const [roleRuns, messages, workerSessions] = await Promise.all([
    deps.roleRunStore ? deps.roleRunStore.listByThread(threadId).catch(() => []) : Promise.resolve([]),
    deps.teamMessageStore ? deps.teamMessageStore.list(threadId, 500).catch(() => []) : Promise.resolve([]),
    deps.workerRuntime?.listSessions ? deps.workerRuntime.listSessions().catch(() => []) : Promise.resolve([]),
  ]);

  const activeRoleRuns = (roleRuns ?? []).filter((run) =>
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_worker" ||
    run.status === "resuming"
  );
  const roleCancelResults = await Promise.all(
    activeRoleRuns.map((run) =>
      deps.roleLoopRunner?.cancel
        ? deps.roleLoopRunner.cancel(run.runKey, reason).catch(() => false)
        : Promise.resolve(false)
    )
  );

  let toolMessages = 0;
  let requestedToolCalls = 0;
  let cancelledToolCalls = 0;
  if (deps.teamMessageStore) {
    for (const message of findCancellableAssistantToolMessages(messages ?? [])) {
      const cancellableIds = findCancellableToolCallIds(message);
      if (cancellableIds.length === 0) continue;
      toolMessages += 1;
      requestedToolCalls += cancellableIds.length;
      const result = await cancelToolCallsOnMessage({
        teamMessageStore: deps.teamMessageStore,
        now,
        messageId: message.id,
        requestedThreadId: threadId,
        toolCallIds: cancellableIds,
        reason,
        ...(deps.toolCancellationRegistry ? { toolCancellationRegistry: deps.toolCancellationRegistry } : {}),
        ...(deps.workerRuntime ? { workerRuntime: deps.workerRuntime } : {}),
      });
      if (result.statusCode === 200 && isCancelledToolBody(result.body)) {
        cancelledToolCalls += result.body.toolCallIds.length;
      }
    }
  }

  const activeWorkerSessions = (workerSessions ?? []).filter(
    (session) =>
      session.context?.threadId === threadId &&
      !["done", "failed", "cancelled"].includes(session.state.status)
  );
  const workerCancelResults = await Promise.all(
    activeWorkerSessions.map((session) =>
      deps.workerRuntime?.cancel
        ? deps.workerRuntime
            .cancel({ workerRunKey: session.workerRunKey, reason })
            .then((state) => Boolean(state))
            .catch(() => false)
        : Promise.resolve(false)
    )
  );

  const currentMission = (await deps.missionStore.get(mission.id)) ?? mission;
  const updatedMission: Mission = {
    ...currentMission,
    status: "blocked",
    blockers: Math.max(currentMission.blockers, 1),
  };
  await deps.missionStore.putRaw(updatedMission);
  await deps.activityStore.append({
    id: `mission-cancelled:${mission.id}:${now}`,
    missionId: mission.id,
    tMs: now,
    kind: "recovery",
    actor: "system",
    text:
      "Mission cancelled by the operator. Active work was stopped before completion; verified evidence may be incomplete, unverified source checks remain, and the user can continue later if they want to resume.",
    emph: "warn",
    tags: ["mission_cancelled"],
    runtime: {
      eventType: "mission.cancelled",
      threadId,
      reason,
      roleRunsRequested: String(activeRoleRuns.length),
      roleRunsCancelled: String(roleCancelResults.filter(Boolean).length),
      toolCallsRequested: String(requestedToolCalls),
      toolCallsCancelled: String(cancelledToolCalls),
      workerSessionsRequested: String(activeWorkerSessions.length),
      workerSessionsCancelled: String(workerCancelResults.filter(Boolean).length),
    },
  });

  return {
    cancelled: true,
    missionId: mission.id,
    threadId,
    roleRuns: {
      requested: activeRoleRuns.length,
      cancelled: roleCancelResults.filter(Boolean).length,
    },
    toolCalls: {
      messages: toolMessages,
      requested: requestedToolCalls,
      cancelled: cancelledToolCalls,
    },
    workerSessions: {
      requested: activeWorkerSessions.length,
      cancelled: workerCancelResults.filter(Boolean).length,
    },
  };
}

function findCancellableAssistantToolMessages(messages: TeamMessage[]): TeamMessage[] {
  return messages.filter((message) => message.role === "assistant" && findCancellableToolCallIds(message).length > 0);
}

function findCancellableToolCallIds(message: TeamMessage): string[] {
  const toolCalls = message.toolCalls ?? [];
  if (toolCalls.length === 0) return [];
  const terminalIds = new Set(
    (message.toolProgress ?? [])
      .filter((event) => event.phase === "completed" || event.phase === "failed" || event.phase === "cancelled")
      .map((event) => event.toolCallId)
  );
  return toolCalls.map((call) => call.id).filter((id) => !terminalIds.has(id));
}

function isCancelledToolBody(value: unknown): value is { toolCallIds: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { toolCallIds?: unknown }).toolCallIds)
  );
}

async function reopenDoneMissionForFollowUp(
  deps: MissionRouteDeps,
  mission: Mission
): Promise<Mission> {
  const latest = (await deps.missionStore.get(mission.id)) ?? mission;
  if (latest.status !== "done") {
    return latest;
  }
  const reopened: Mission = {
    ...latest,
    status: "working",
    progress: Math.min(latest.progress, 0.99),
    blockers: 0,
  };
  await deps.missionStore.putRaw(reopened);
  return reopened;
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
      const postPromise = input.orchestrator.postUserMessage({
        threadId: input.threadId,
        content: input.content,
      });
      const mirrorLoop = mirrorMissionWhilePostRuns({
        orchestrator: input.orchestrator,
        missionId: input.mission.id,
        label: "initial",
      });
      await postPromise;
      await mirrorLoop.stopAndFlush();
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

function startMissionFollowUpInBackground(input: {
  deps: MissionRouteDeps;
  orchestrator: MissionOrchestratorDeps;
  mission: Mission;
  threadId: string;
  content: string;
}): void {
  void (async () => {
    try {
      const prepared = input.orchestrator.threadBridge.prepareUserMessage
        ? await input.orchestrator.threadBridge.prepareUserMessage(
            input.mission.id,
            input.content,
          )
        : { content: input.content, notificationIds: [] };
      const postPromise = input.orchestrator.postUserMessage({
        threadId: input.threadId,
        content: prepared.content,
        ...(prepared.deliveryId ? { idempotencyKey: prepared.deliveryId } : {}),
      });
      const mirrorLoop = mirrorMissionWhilePostRuns({
        orchestrator: input.orchestrator,
        missionId: input.mission.id,
        label: "follow-up",
      });
      await postPromise;
      if (
        prepared.deliveryId &&
        input.orchestrator.threadBridge.acknowledgePreparedUserMessage
      ) {
        try {
          await input.orchestrator.threadBridge.acknowledgePreparedUserMessage({
            missionId: input.mission.id,
            deliveryId: prepared.deliveryId,
            notificationIds: prepared.notificationIds,
          });
        } catch (error) {
          console.error("mission worker result acknowledgement failed", {
            missionId: input.mission.id,
            deliveryId: prepared.deliveryId,
            error,
          });
        }
      }
      await mirrorLoop.stopAndFlush();
      await input.orchestrator.threadBridge.tickMission(input.mission.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("mission background follow-up failed", {
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
          id: `mission-follow-up-failed:${input.mission.id}:${now}`,
          missionId: input.mission.id,
          tMs: now,
          kind: "recovery",
          actor: "system",
          text: "mission.follow_up_failed",
          emph: "danger",
          tags: ["mission_follow_up_failed"],
          runtime: {
            eventType: "mission.follow_up_failed",
            threadId: input.threadId,
            errorMessage: message,
          },
        });
      } catch (recordError) {
        console.error("mission background follow-up failure recording failed", {
          missionId: input.mission.id,
          error: recordError,
        });
      }
    }
  })();
}

function mirrorMissionWhilePostRuns(input: {
  orchestrator: MissionOrchestratorDeps;
  missionId: string;
  label: string;
}): { stopAndFlush(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const tick = async () => {
    try {
      await input.orchestrator.threadBridge.tickMission(input.missionId);
    } catch (error) {
      console.warn("mission background mirror tick failed", {
        missionId: input.missionId,
        label: input.label,
        error,
      });
    }
  };
  const interval = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  }, MISSION_BACKGROUND_MIRROR_INTERVAL_MS);
  interval.unref?.();
  inFlight = tick().finally(() => {
    inFlight = null;
  });
  return {
    async stopAndFlush() {
      stopped = true;
      clearInterval(interval);
      await inFlight;
      await tick();
    },
  };
}

async function applyApprovedPermissionDecision(input: {
  toolPermissionService?: Pick<ToolPermissionService, "apply">;
  approval: { id: string; payload?: Record<string, unknown> };
  decision: "approved" | "denied";
}): Promise<boolean> {
  if (input.decision !== "approved" || !input.toolPermissionService) {
    return false;
  }
  const threadId = readApprovalToolPermissionThreadId(input.approval.payload);
  if (!threadId) {
    return false;
  }
  try {
    const applied = await input.toolPermissionService.apply({
      threadId,
      approvalId: input.approval.id,
    });
    return applied.status === "applied";
  } catch (error) {
    console.error("mission approval permission auto-apply failed", {
      approvalId: input.approval.id,
      error,
    });
    return false;
  }
}

function readApprovalToolPermissionThreadId(payload: Record<string, unknown> | undefined): string | null {
  const toolPermission = payload?.["toolPermission"];
  if (!isRecord(toolPermission)) {
    return null;
  }
  const threadId = toolPermission["threadId"];
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_MODES = new Set([
  "research",
  "monitor",
  "browser",
  "review",
  "investigation",
  "custom",
]);

const MANUAL_CONTEXT_KINDS = new Set<ContextKind>(["doc", "folder", "api", "desktop"]);

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readManualContextKind(value: unknown): ContextKind | null {
  if (typeof value !== "string") return null;
  return MANUAL_CONTEXT_KINDS.has(value as ContextKind) ? (value as ContextKind) : null;
}

function defaultContextSourceState(kind: ContextKind): string {
  return kind === "api" ? "ready" : "attached";
}

function buildManualContextSource(input: {
  existing: ContextSource[];
  kind: ContextKind;
  title: string;
  url: string;
  state: string;
  writer: string | null;
  nowMs: number;
}): ContextSource {
  const baseId = `ctx.${input.kind}.manual.${input.nowMs}.${slugifyContextSource(input.title)}`;
  const taken = new Set(input.existing.map((source) => source.id));
  let id = baseId;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${baseId}.${suffix}`;
    suffix += 1;
  }
  return {
    id,
    kind: input.kind,
    title: input.title,
    url: input.url,
    state: input.state,
    lastUse: "",
    lastUseAtMs: input.nowMs,
    ...(input.writer ? { writer: input.writer } : {}),
  };
}

function slugifyContextSource(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "source";
}

function encodeTimelineCursor(event: ActivityEvent): string {
  return Buffer.from(JSON.stringify({ tMs: event.tMs, id: event.id }), "utf8").toString("base64url");
}

function decodeTimelineCursor(value: string): { tMs: number; id: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object") return null;
    const record = decoded as Record<string, unknown>;
    const tMs = record.tMs;
    const id = record.id;
    if (
      typeof tMs !== "number" ||
      !Number.isSafeInteger(tMs) ||
      tMs < 0 ||
      typeof id !== "string" ||
      id.trim() === ""
    ) {
      return null;
    }
    return { tMs, id };
  } catch {
    return null;
  }
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

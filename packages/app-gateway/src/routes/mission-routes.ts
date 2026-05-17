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
// K3+K4 will add the actual creation/mutation routes
// (POST /missions, POST /missions/:id/work-items, etc.). K2 is read-only
// except for the bootstrap helper so the dashboard has content to render.

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

import { parsePositiveLimit, sendJson } from "../http-helpers";
import { buildDemoFixtures } from "../mission-demo-fixtures";

export interface MissionRouteDeps {
  missionStore: MissionStore & { putRaw(mission: Mission): Promise<void> };
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
    sendJson(res, 200, await deps.contextSourceRegistry.list());
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

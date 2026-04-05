import type http from "node:http";

import {
  parseOptionalNonEmptyString,
  parsePositiveLimit,
  parseRequiredNonEmptyString,
  sendJson,
} from "../http-helpers";

export interface InspectionRouteDeps {
  listThreads(): Promise<unknown>;
  listRecentEvents(threadId: string | undefined, limit: number): Promise<unknown>;
  resolveExternalRoute(channelId: string, userId: string): Promise<unknown>;
  listMessages(threadId: string): Promise<unknown>;
  listFlows(threadId: string, limit: number): Promise<unknown>;
  buildFlowSummary(threadId: string): Promise<unknown>;
  listRuntimeChainsByThread(threadId: string, limit: number): Promise<unknown>;
  listActiveRuntimeChains(limit: number, threadId: string | null): Promise<unknown>;
  loadRuntimeSummary(threadId: string | null, limit: number): Promise<{ attentionChains: unknown }>;
  listRuntimeChainsByCanonicalState(
    state: "waiting" | "failed",
    limit: number,
    threadId: string | null
  ): Promise<unknown>;
  listWorkerSessions(limit: number, threadId: string | null): Promise<unknown>;
  listStaleRuntimeChains(limit: number, threadId: string | null): Promise<unknown>;
  listRuntimeProgressByThread(threadId: string, limit: number): Promise<unknown>;
  loadRuntimeChainDetail(chainId: string, limit?: number): Promise<{ events: unknown[]; [key: string]: unknown } | null>;
  listRuntimeProgressByChain(chainId: string, limit: number): Promise<unknown>;
  listRoleRuns(threadId: string): Promise<unknown>;
  getSessionMemory(threadId: string): Promise<unknown | null>;
  listModels(): Promise<unknown>;
  inspectCapabilities(threadId: string, roleId: string, requestedCapabilities: string[]): Promise<unknown>;
  listGovernancePermissions(threadId: string): Promise<unknown>;
  buildGovernanceSummary(threadId: string, limit: number): Promise<unknown>;
  buildRecoverySummary(threadId: string, limit: number): Promise<unknown>;
  buildPromptConsole(threadId: string, limit: number): Promise<unknown>;
  buildOperatorSummary(threadId: string, limit: number): Promise<unknown>;
  buildOperatorAttention(threadId: string, limit: number): Promise<unknown>;
  buildOperatorTriage(threadId: string, limit: number): Promise<unknown>;
  listGovernanceAudits(threadId: string | undefined, limit: number): Promise<unknown>;
  listGovernanceWorkerAudits(threadId: string | undefined, limit: number): Promise<unknown>;
  listReplays(input: { threadId?: string; layer?: string; limit: number }): Promise<unknown>;
  buildReplaySummary(threadId: string | undefined, limit: number): Promise<unknown>;
  buildReplayConsole(threadId: string | undefined, limit: number): Promise<unknown>;
}

export async function handleInspectionRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: InspectionRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method === "GET" && url.pathname === "/threads") {
    sendJson(res, 200, await deps.listThreads());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const limit = Number(url.searchParams.get("limit") ?? 50);
    sendJson(res, 200, await deps.listRecentEvents(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/routes/resolve") {
    const channelId = parseRequiredNonEmptyString(url.searchParams.get("channelId"));
    const userId = parseRequiredNonEmptyString(url.searchParams.get("userId"));
    if (!channelId || !userId) {
      sendJson(res, 400, { error: "channelId and userId are required" });
      return true;
    }
    sendJson(res, 200, await deps.resolveExternalRoute(channelId, userId));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/messages") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    sendJson(res, 200, await deps.listMessages(threadId));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/flows") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listFlows(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/flows-summary") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    sendJson(res, 200, await deps.buildFlowSummary(threadId));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-chains") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listRuntimeChainsByThread(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-active") {
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listActiveRuntimeChains(limit, parseOptionalNonEmptyString(url.searchParams.get("threadId")) ?? null));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-summary") {
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.loadRuntimeSummary(parseOptionalNonEmptyString(url.searchParams.get("threadId")) ?? null, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-worker-sessions") {
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listWorkerSessions(limit, parseOptionalNonEmptyString(url.searchParams.get("threadId")) ?? null));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-waiting") {
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.listRuntimeChainsByCanonicalState(
        "waiting",
        limit,
        parseOptionalNonEmptyString(url.searchParams.get("threadId")) ?? null
      )
    );
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-failed") {
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.listRuntimeChainsByCanonicalState(
        "failed",
        limit,
        parseOptionalNonEmptyString(url.searchParams.get("threadId")) ?? null
      )
    );
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-stale") {
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listStaleRuntimeChains(limit, parseOptionalNonEmptyString(url.searchParams.get("threadId")) ?? null));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-attention") {
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    const summary = await deps.loadRuntimeSummary(parseOptionalNonEmptyString(url.searchParams.get("threadId")) ?? null, limit);
    sendJson(res, 200, summary.attentionChains);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runtime-progress") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listRuntimeProgressByThread(threadId, limit));
    return true;
  }

  const runtimeChainEventsMatch = req.method === "GET" ? url.pathname.match(/^\/runtime-chains\/([^/]+)\/events$/) : null;
  if (runtimeChainEventsMatch) {
    const chainId = decodeURIComponent(runtimeChainEventsMatch[1] ?? "");
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    const detail = await deps.loadRuntimeChainDetail(chainId, limit);
    if (!detail) {
      sendJson(res, 404, { error: "runtime chain not found" });
      return true;
    }
    sendJson(res, 200, detail.events.slice(-limit));
    return true;
  }

  const runtimeChainProgressMatch = req.method === "GET" ? url.pathname.match(/^\/runtime-chains\/([^/]+)\/progress$/) : null;
  if (runtimeChainProgressMatch) {
    const chainId = decodeURIComponent(runtimeChainProgressMatch[1] ?? "");
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listRuntimeProgressByChain(chainId, limit));
    return true;
  }

  const runtimeChainMatch = req.method === "GET" ? url.pathname.match(/^\/runtime-chains\/([^/]+)$/) : null;
  if (runtimeChainMatch) {
    const chainId = decodeURIComponent(runtimeChainMatch[1] ?? "");
    const detail = await deps.loadRuntimeChainDetail(chainId);
    if (!detail) {
      sendJson(res, 404, { error: "runtime chain not found" });
      return true;
    }
    sendJson(res, 200, detail);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/runs") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    sendJson(res, 200, await deps.listRoleRuns(threadId));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/context/session-memory") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const record = await deps.getSessionMemory(threadId);
    if (!record) {
      sendJson(res, 404, { error: "session memory not found" });
      return true;
    }
    sendJson(res, 200, record);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/models") {
    sendJson(res, 200, await deps.listModels());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/capabilities") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    const roleId = parseRequiredNonEmptyString(url.searchParams.get("roleId"));
    if (!threadId || !roleId) {
      sendJson(res, 400, { error: "threadId and roleId are required" });
      return true;
    }
    const requestedCapabilities = (url.searchParams.get("requestedCapabilities") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    sendJson(res, 200, await deps.inspectCapabilities(threadId, roleId, requestedCapabilities));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/governance/permissions") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    sendJson(res, 200, await deps.listGovernancePermissions(threadId));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/governance/summary") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildGovernanceSummary(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/recovery-summary") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildRecoverySummary(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/prompt-console") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildPromptConsole(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/operator-summary") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildOperatorSummary(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/operator-attention") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildOperatorAttention(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/operator-triage") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildOperatorTriage(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/governance/audits") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listGovernanceAudits(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/governance/workers") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.listGovernanceWorkerAudits(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/replays") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const layer = parseOptionalNonEmptyString(url.searchParams.get("layer"));
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(
      res,
      200,
      await deps.listReplays({
        limit,
        ...(threadId ? { threadId } : {}),
        ...(layer ? { layer } : {}),
      })
    );
    return true;
  }

  if (req.method === "GET" && url.pathname === "/replay-summary") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildReplaySummary(threadId, limit));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/replay-console") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    sendJson(res, 200, await deps.buildReplayConsole(threadId, limit));
    return true;
  }

  return false;
}

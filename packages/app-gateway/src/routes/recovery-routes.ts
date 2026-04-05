import type http from "node:http";

import {
  parseOptionalNonEmptyString,
  parsePositiveInteger,
  parsePositiveLimit,
  parseRequiredNonEmptyString,
  sendJson,
} from "../http-helpers";

export interface RecoveryRouteDeps {
  buildReplayIncidents(input: {
    threadId?: string;
    limit: number;
    action?: string;
    category?: string;
  }): Promise<unknown>;
  buildReplayRecoveries(input: { threadId?: string; limit: number; action?: string }): Promise<unknown>;
  getReplayGroup(threadId: string, groupId: string): Promise<unknown | null>;
  getReplayBundle(threadId: string, groupId: string): Promise<unknown | null>;
  getReplayRecovery(threadId: string, groupId: string): Promise<unknown | null>;
  listRecoveryRuns(threadId: string): Promise<unknown[]>;
  getRecoveryRun(threadId: string, recoveryRunId: string): Promise<unknown | null>;
  getRecoveryTimeline(threadId: string, recoveryRunId: string): Promise<unknown | null>;
  executeRecoveryRunAction(input: {
    threadId: string;
    recoveryRunId: string;
    action: "approve" | "reject" | "retry" | "fallback" | "resume";
  }): Promise<{ statusCode: number; body: unknown }>;
  dispatchReplayRecovery(input: {
    threadId: string;
    groupId: string;
  }): Promise<{ statusCode: number; body: unknown }>;
  getReplay(replayId: string): Promise<unknown | null>;
}

export async function handleRecoveryRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: RecoveryRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method === "GET" && url.pathname === "/replay-incidents") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    const action = parseOptionalNonEmptyString(url.searchParams.get("action"));
    const category = parseOptionalNonEmptyString(url.searchParams.get("category"));
    sendJson(
      res,
      200,
      await deps.buildReplayIncidents({
        limit,
        ...(threadId ? { threadId } : {}),
        ...(action ? { action } : {}),
        ...(category ? { category } : {}),
      })
    );
    return true;
  }

  if (req.method === "GET" && url.pathname === "/replay-recoveries") {
    const threadId = parseOptionalNonEmptyString(url.searchParams.get("threadId"));
    const limit = parsePositiveLimit(url.searchParams.get("limit"));
    if (limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    const action = parseOptionalNonEmptyString(url.searchParams.get("action"));
    sendJson(
      res,
      200,
      await deps.buildReplayRecoveries({
        limit,
        ...(threadId ? { threadId } : {}),
        ...(action ? { action } : {}),
      })
    );
    return true;
  }

  const replayGroupMatch = url.pathname.match(/^\/replay-groups\/([^/]+)$/);
  if (req.method === "GET" && replayGroupMatch) {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const group = await deps.getReplayGroup(threadId, decodeURIComponent(replayGroupMatch[1]!));
    if (!group) {
      sendJson(res, 404, { error: "replay group not found" });
      return true;
    }
    sendJson(res, 200, group);
    return true;
  }

  const replayBundleMatch = url.pathname.match(/^\/replay-bundles\/([^/]+)$/);
  if (req.method === "GET" && replayBundleMatch) {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const bundle = await deps.getReplayBundle(threadId, decodeURIComponent(replayBundleMatch[1]!));
    if (!bundle) {
      sendJson(res, 404, { error: "replay bundle not found" });
      return true;
    }
    sendJson(res, 200, bundle);
    return true;
  }

  const replayRecoveryMatch = url.pathname.match(/^\/replay-recoveries\/([^/]+)$/);
  if (req.method === "GET" && replayRecoveryMatch) {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const recovery = await deps.getReplayRecovery(threadId, decodeURIComponent(replayRecoveryMatch[1]!));
    if (!recovery) {
      sendJson(res, 404, { error: "replay recovery not found" });
      return true;
    }
    sendJson(res, 200, recovery);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/recovery-runs") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const limit = parsePositiveInteger(url.searchParams.get("limit"));
    if (url.searchParams.get("limit") && limit == null) {
      sendJson(res, 400, { error: "limit must be a positive integer" });
      return true;
    }
    const runs = await deps.listRecoveryRuns(threadId);
    sendJson(res, 200, {
      totalRuns: runs.length,
      runs: limit == null ? runs : runs.slice(0, limit),
    });
    return true;
  }

  const recoveryRunMatch = url.pathname.match(/^\/recovery-runs\/([^/]+)$/);
  if (req.method === "GET" && recoveryRunMatch) {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const run = await deps.getRecoveryRun(threadId, decodeURIComponent(recoveryRunMatch[1]!));
    if (!run) {
      sendJson(res, 404, { error: "recovery run not found" });
      return true;
    }
    sendJson(res, 200, run);
    return true;
  }

  const recoveryTimelineMatch = url.pathname.match(/^\/recovery-runs\/([^/]+)\/timeline$/);
  if (req.method === "GET" && recoveryTimelineMatch) {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const timeline = await deps.getRecoveryTimeline(threadId, decodeURIComponent(recoveryTimelineMatch[1]!));
    if (!timeline) {
      sendJson(res, 404, { error: "recovery run not found" });
      return true;
    }
    sendJson(res, 200, timeline);
    return true;
  }

  const recoveryRunActionMatch = url.pathname.match(
    /^\/recovery-runs\/([^/]+)\/(approve|reject|retry|fallback|resume)$/
  );
  if (req.method === "POST" && recoveryRunActionMatch) {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const result = await deps.executeRecoveryRunAction({
      threadId,
      recoveryRunId: decodeURIComponent(recoveryRunActionMatch[1]!),
      action: recoveryRunActionMatch[2] as "approve" | "reject" | "retry" | "fallback" | "resume",
    });
    sendJson(res, result.statusCode, result.body);
    return true;
  }

  const replayRecoveryDispatchMatch = url.pathname.match(/^\/replay-recoveries\/([^/]+)\/dispatch$/);
  if (req.method === "POST" && replayRecoveryDispatchMatch) {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const result = await deps.dispatchReplayRecovery({
      threadId,
      groupId: decodeURIComponent(replayRecoveryDispatchMatch[1]!),
    });
    sendJson(res, result.statusCode, result.body);
    return true;
  }

  const replayMatch = url.pathname.match(/^\/replays\/([^/]+)$/);
  if (req.method === "GET" && replayMatch) {
    const replay = await deps.getReplay(decodeURIComponent(replayMatch[1]!));
    if (!replay) {
      sendJson(res, 404, { error: "replay not found" });
      return true;
    }
    sendJson(res, 200, replay);
    return true;
  }

  return false;
}

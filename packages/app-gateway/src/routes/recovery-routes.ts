import type http from "node:http";

import {
  parseOptionalNonEmptyString,
  parsePositiveInteger,
  parsePositiveLimit,
  parseRequiredNonEmptyString,
  sendJson,
} from "../http-helpers";
import { readIdempotencyKey, type RouteIdempotencyStore } from "../idempotency-store";

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
  idempotencyStore?: RouteIdempotencyStore;
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
    const groupId = parsePathParam(replayGroupMatch[1]!);
    if (!groupId) {
      sendJson(res, 400, { error: "groupId is required" });
      return true;
    }
    const group = await deps.getReplayGroup(threadId, groupId);
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
    const groupId = parsePathParam(replayBundleMatch[1]!);
    if (!groupId) {
      sendJson(res, 400, { error: "groupId is required" });
      return true;
    }
    const bundle = await deps.getReplayBundle(threadId, groupId);
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
    const groupId = parsePathParam(replayRecoveryMatch[1]!);
    if (!groupId) {
      sendJson(res, 400, { error: "groupId is required" });
      return true;
    }
    const recovery = await deps.getReplayRecovery(threadId, groupId);
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
    const recoveryRunId = parsePathParam(recoveryRunMatch[1]!);
    if (!recoveryRunId) {
      sendJson(res, 400, { error: "recoveryRunId is required" });
      return true;
    }
    const run = await deps.getRecoveryRun(threadId, recoveryRunId);
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
    const recoveryRunId = parsePathParam(recoveryTimelineMatch[1]!);
    if (!recoveryRunId) {
      sendJson(res, 400, { error: "recoveryRunId is required" });
      return true;
    }
    const timeline = await deps.getRecoveryTimeline(threadId, recoveryRunId);
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
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey.ok) {
      sendJson(res, 400, { error: idempotencyKey.error });
      return true;
    }
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const recoveryRunId = parsePathParam(recoveryRunActionMatch[1]!);
    if (!recoveryRunId) {
      sendJson(res, 400, { error: "recoveryRunId is required" });
      return true;
    }
    const action = recoveryRunActionMatch[2] as "approve" | "reject" | "retry" | "fallback" | "resume";
    const executeAction = async () =>
      deps.executeRecoveryRunAction({
        threadId,
        recoveryRunId,
        action,
      });
    const result = deps.idempotencyStore
      ? await deps.idempotencyStore.execute({
          scope: "recovery:run-action",
          ...(idempotencyKey.key ? { key: idempotencyKey.key } : {}),
          fingerprint: JSON.stringify({ threadId, recoveryRunId, action }),
          execute: executeAction,
        })
      : ({
          kind: "response",
          ...(await executeAction()),
          replayed: false,
        } as const);
    sendIdempotentResponse(res, result);
    return true;
  }

  const replayRecoveryDispatchMatch = url.pathname.match(/^\/replay-recoveries\/([^/]+)\/dispatch$/);
  if (req.method === "POST" && replayRecoveryDispatchMatch) {
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey.ok) {
      sendJson(res, 400, { error: idempotencyKey.error });
      return true;
    }
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    const groupId = parsePathParam(replayRecoveryDispatchMatch[1]!);
    if (!groupId) {
      sendJson(res, 400, { error: "groupId is required" });
      return true;
    }
    const executeDispatch = async () =>
      deps.dispatchReplayRecovery({
        threadId,
        groupId,
      });
    const result = deps.idempotencyStore
      ? await deps.idempotencyStore.execute({
          scope: "recovery:replay-dispatch",
          ...(idempotencyKey.key ? { key: idempotencyKey.key } : {}),
          fingerprint: JSON.stringify({ threadId, groupId }),
          execute: executeDispatch,
        })
      : ({
          kind: "response",
          ...(await executeDispatch()),
          replayed: false,
        } as const);
    sendIdempotentResponse(res, result);
    return true;
  }

  const replayMatch = url.pathname.match(/^\/replays\/([^/]+)$/);
  if (req.method === "GET" && replayMatch) {
    const replayId = parsePathParam(replayMatch[1]!);
    if (!replayId) {
      sendJson(res, 400, { error: "replayId is required" });
      return true;
    }
    const replay = await deps.getReplay(replayId);
    if (!replay) {
      sendJson(res, 404, { error: "replay not found" });
      return true;
    }
    sendJson(res, 200, replay);
    return true;
  }

  return false;
}

function parsePathParam(value: string): string | null {
  try {
    return parseRequiredNonEmptyString(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function sendIdempotentResponse(
  res: http.ServerResponse,
  result:
    | { kind: "response"; statusCode: number; body: unknown; replayed: boolean }
    | { kind: "conflict"; statusCode: 409; body: { error: string } }
): void {
  if (result.kind === "conflict") {
    sendJson(res, result.statusCode, result.body);
    return;
  }
  if (result.replayed) {
    res.setHeader("x-turnkeyai-idempotency-status", "replayed");
  }
  sendJson(res, result.statusCode, result.body);
}

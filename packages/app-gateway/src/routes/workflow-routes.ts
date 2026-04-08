import type http from "node:http";

import {
  SESSION_TARGETS,
  WORKER_KINDS,
} from "@turnkeyai/core-types/team";
import type {
  Clock,
  IdGenerator,
  SessionTarget,
  WorkerKind,
} from "@turnkeyai/core-types/team";

import {
  parseRequiredNonEmptyString,
  readJsonBodySafe,
  readOptionalJsonBodySafe,
  sendJson,
} from "../http-helpers";

interface CoordinationEngineDeps {
  handleUserPost(body: { threadId: string; content: string }): Promise<void>;
}

interface TeamEventBusDeps {
  publish(event: {
    eventId: string;
    threadId: string;
    kind: "message.posted";
    createdAt: number;
    payload: {
      route: "user";
      contentLength: number;
    };
  }): Promise<void>;
}

interface ScheduledTaskRuntimeDeps {
  listByThread(threadId: string): Promise<unknown>;
  schedule(input: {
    threadId: string;
    targetRoleId: string;
    capsule: {
      title: string;
      instructions: string;
      artifactRefs?: string[];
      dependencyRefs?: string[];
      expectedOutput?: string;
    };
      schedule: {
        kind: "cron";
        expr: string;
        tz: string;
      };
    sessionTarget?: SessionTarget;
    targetWorker?: WorkerKind;
  }): Promise<unknown>;
  triggerDue(now?: number): Promise<unknown>;
}

export interface WorkflowRouteDeps {
  coordinationEngine: CoordinationEngineDeps;
  teamEventBus: TeamEventBusDeps;
  scheduledTaskRuntime: ScheduledTaskRuntimeDeps;
  idGenerator: IdGenerator;
  clock: Clock;
}

const MAX_MESSAGE_CONTENT_CHARS = 20_000;
const MAX_SCHEDULED_TITLE_CHARS = 200;
const MAX_SCHEDULED_INSTRUCTIONS_CHARS = 20_000;
const MAX_SCHEDULED_REF_COUNT = 32;
const MAX_SCHEDULED_REF_CHARS = 200;
const ALLOWED_SESSION_TARGETS = new Set<string>(SESSION_TARGETS);
const ALLOWED_TARGET_WORKERS = new Set<string>(WORKER_KINDS);

export async function handleWorkflowRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: WorkflowRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;

  if (req.method === "GET" && url.pathname === "/scheduled-tasks") {
    const threadId = parseRequiredNonEmptyString(url.searchParams.get("threadId"));
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    sendJson(res, 200, await deps.scheduledTaskRuntime.listByThread(threadId));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/messages") {
    const bodyResult = await readJsonBodySafe<{ threadId: string; content: string }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const threadId = parseRequiredNonEmptyString(body.threadId);
    const content = parseRequiredNonEmptyString(body.content);
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    if (!content) {
      sendJson(res, 400, { error: "content is required" });
      return true;
    }
    if (content.length > MAX_MESSAGE_CONTENT_CHARS) {
      sendJson(res, 400, { error: `content must be at most ${MAX_MESSAGE_CONTENT_CHARS} characters` });
      return true;
    }
    await deps.coordinationEngine.handleUserPost({ ...body, threadId, content });
    await deps.teamEventBus.publish({
      eventId: deps.idGenerator.messageId(),
      threadId,
      kind: "message.posted",
      createdAt: deps.clock.now(),
      payload: {
        route: "user",
        contentLength: content.length,
      },
    });
    sendJson(res, 202, { accepted: true, threadId });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/scheduled-tasks") {
    const bodyResult = await readJsonBodySafe<{
      threadId: string;
      targetRoleId: string;
      capsule: {
        title: string;
        instructions: string;
        artifactRefs?: string[];
        dependencyRefs?: string[];
        expectedOutput?: string;
      };
      schedule: {
        kind: "cron";
        expr: string;
        tz: string;
      };
      sessionTarget?: SessionTarget;
      targetWorker?: WorkerKind;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const threadId = parseRequiredNonEmptyString(body.threadId);
    const targetRoleId = parseRequiredNonEmptyString(body.targetRoleId);
    const title = parseRequiredNonEmptyString(body.capsule?.title);
    const instructions = parseRequiredNonEmptyString(body.capsule?.instructions);
    const expr = parseRequiredNonEmptyString(body.schedule?.expr);
    const tz = parseRequiredNonEmptyString(body.schedule?.tz);
    if (!threadId) {
      sendJson(res, 400, { error: "threadId is required" });
      return true;
    }
    if (!targetRoleId) {
      sendJson(res, 400, { error: "targetRoleId is required" });
      return true;
    }
    if (!title) {
      sendJson(res, 400, { error: "capsule.title is required" });
      return true;
    }
    if (!instructions) {
      sendJson(res, 400, { error: "capsule.instructions is required" });
      return true;
    }
    if (title.length > MAX_SCHEDULED_TITLE_CHARS) {
      sendJson(res, 400, { error: `capsule.title must be at most ${MAX_SCHEDULED_TITLE_CHARS} characters` });
      return true;
    }
    if (instructions.length > MAX_SCHEDULED_INSTRUCTIONS_CHARS) {
      sendJson(res, 400, { error: `capsule.instructions must be at most ${MAX_SCHEDULED_INSTRUCTIONS_CHARS} characters` });
      return true;
    }
    if (!expr) {
      sendJson(res, 400, { error: "schedule.expr is required" });
      return true;
    }
    if (!tz) {
      sendJson(res, 400, { error: "schedule.tz is required" });
      return true;
    }
    if (body.schedule?.kind !== "cron") {
      sendJson(res, 400, { error: "schedule.kind must be cron" });
      return true;
    }
    if (body.sessionTarget && !ALLOWED_SESSION_TARGETS.has(body.sessionTarget)) {
      sendJson(res, 400, { error: "sessionTarget must be main or worker" });
      return true;
    }
    if (body.targetWorker && !ALLOWED_TARGET_WORKERS.has(body.targetWorker)) {
      sendJson(res, 400, { error: "targetWorker is invalid" });
      return true;
    }
    const artifactRefs = normalizeRefArray(body.capsule?.artifactRefs, "capsule.artifactRefs");
    if (!artifactRefs.ok) {
      sendJson(res, 400, { error: artifactRefs.error });
      return true;
    }
    const dependencyRefs = normalizeRefArray(body.capsule?.dependencyRefs, "capsule.dependencyRefs");
    if (!dependencyRefs.ok) {
      sendJson(res, 400, { error: dependencyRefs.error });
      return true;
    }
    sendJson(
      res,
      201,
      await deps.scheduledTaskRuntime.schedule({
        ...body,
        threadId,
        targetRoleId,
        capsule: {
          ...body.capsule,
          title,
          instructions,
          ...(artifactRefs.value.length > 0 ? { artifactRefs: artifactRefs.value } : {}),
          ...(dependencyRefs.value.length > 0 ? { dependencyRefs: dependencyRefs.value } : {}),
        },
        schedule: {
          ...body.schedule,
          expr,
          tz,
        },
      })
    );
    return true;
  }

  if (req.method === "POST" && url.pathname === "/scheduled-tasks/trigger-due") {
    const bodyResult = await readOptionalJsonBodySafe<{ now?: number }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (body.now != null && (!Number.isFinite(body.now) || body.now < 0)) {
      sendJson(res, 400, { error: "now must be a non-negative finite number" });
      return true;
    }
    sendJson(res, 200, await deps.scheduledTaskRuntime.triggerDue(body.now));
    return true;
  }

  return false;
}

function normalizeRefArray(
  value: unknown,
  fieldName: string
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value == null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be an array of non-empty strings` };
  }
  if (value.length > MAX_SCHEDULED_REF_COUNT) {
    return { ok: false, error: `${fieldName} must contain at most ${MAX_SCHEDULED_REF_COUNT} entries` };
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, error: `${fieldName} must be an array of non-empty strings` };
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      return { ok: false, error: `${fieldName} must be an array of non-empty strings` };
    }
    if (trimmed.length > MAX_SCHEDULED_REF_CHARS) {
      return {
        ok: false,
        error: `${fieldName} entries must be at most ${MAX_SCHEDULED_REF_CHARS} characters`,
      };
    }
    normalized.push(trimmed);
  }
  return { ok: true, value: normalized };
}

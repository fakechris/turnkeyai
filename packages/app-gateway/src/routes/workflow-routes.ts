import type http from "node:http";

import type { Clock, IdGenerator } from "@turnkeyai/core-types/team";

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
    sessionTarget?: "main" | "worker";
    targetWorker?: "browser" | "coder" | "finance" | "explore" | "harness";
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
      sessionTarget?: "main" | "worker";
      targetWorker?: "browser" | "coder" | "finance" | "explore" | "harness";
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
    if (!expr) {
      sendJson(res, 400, { error: "schedule.expr is required" });
      return true;
    }
    if (!tz) {
      sendJson(res, 400, { error: "schedule.tz is required" });
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
    sendJson(res, 200, await deps.scheduledTaskRuntime.triggerDue(body.now));
    return true;
  }

  return false;
}

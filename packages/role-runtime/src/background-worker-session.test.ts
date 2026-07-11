import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BACKGROUND_WORKER_SESSION_PROTOCOL,
  buildBackgroundWorkerSessionAccepted,
  parseBackgroundWorkerSessionAccepted,
  serializeBackgroundWorkerSessionAccepted,
} from "./background-worker-session";

test("background worker session protocol round-trips a durable running handle", () => {
  const accepted = buildBackgroundWorkerSessionAccepted({
    taskId: "task-1",
    sessionKey: "worker:explore:task:task-1",
    agentId: "explore",
    label: "source research",
    toolCallId: "call-1",
    acceptedAt: 1_000,
    deadlineAt: 61_000,
  });

  assert.deepEqual(accepted, {
    protocol: BACKGROUND_WORKER_SESSION_PROTOCOL,
    version: 1,
    task_id: "task-1",
    session_key: "worker:explore:task:task-1",
    agent_id: "explore",
    status: "running",
    label: "source research",
    tool_call_id: "call-1",
    accepted_at: 1_000,
    deadline_at: 61_000,
  });
  assert.deepEqual(
    parseBackgroundWorkerSessionAccepted(serializeBackgroundWorkerSessionAccepted(accepted)),
    accepted,
  );
});

test("background worker session protocol rejects unversioned or terminal payloads", () => {
  assert.equal(parseBackgroundWorkerSessionAccepted("{}"), null);
  assert.equal(
    parseBackgroundWorkerSessionAccepted(JSON.stringify({
      protocol: BACKGROUND_WORKER_SESSION_PROTOCOL,
      version: 1,
      status: "completed",
    })),
    null,
  );
});

test("background worker protocol literal is owned by one production module", () => {
  const srcRoot = dirname(fileURLToPath(import.meta.url));
  const owners = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .filter((entry) =>
      readFileSync(join(srcRoot, entry), "utf8").includes("turnkeyai.background_worker_session.v1"),
    );

  assert.deepEqual(owners, ["background-worker-session.ts"]);
});

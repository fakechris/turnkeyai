import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInvocationInput } from "@turnkeyai/core-types/team";

import { ExploreWorkerHandler } from "./explore-worker-handler";

test("explore worker fetches the OpenAI pricing page through direct HTTP", async () => {
  const handler = new ExploreWorkerHandler({
    fetchFn: async () =>
      new Response(
        `
          <html>
            <head><title>API Pricing</title></head>
            <body>
              <main>
                GPT-5 input $1.25 / 1M tokens
                GPT-5 output $10.00 / 1M tokens
              </main>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: { "content-type": "text/html" },
        }
      ),
  });

  const result = await handler.run(buildExploreInvocationInput());

  assert.equal(result?.status, "completed");
  const payload = result?.payload as {
    findings: string[];
    apiAttempt: { statusCode: number };
    transportAudit: { finalTransport: string; downgraded: boolean; trustLevel: string };
  };
  assert.equal(payload.apiAttempt.statusCode, 200);
  assert.deepEqual(payload.findings, ["GPT-5 input $1.25 / 1M tokens", "GPT-5 output $10.00 / 1M tokens"]);
  assert.equal(payload.transportAudit.finalTransport, "official_api");
  assert.equal(payload.transportAudit.downgraded, false);
  assert.equal(payload.transportAudit.trustLevel, "promotable");
});

test("explore worker falls back to browser when direct fetch is blocked", async () => {
  const handler = new ExploreWorkerHandler({
    fetchFn: async () =>
      new Response("Enable JavaScript and cookies to continue", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    browserBridge: {
      async inspectPublicPage(url) {
        return {
          requestedUrl: url,
          finalUrl: url,
          title: "OpenAI API Pricing",
          textExcerpt: "GPT-5 input $1.25 / 1M tokens",
          statusCode: 200,
        };
      },
    },
  });

  const result = await handler.run(buildExploreInvocationInput());

  assert.equal(result?.status, "partial");
  const payload = result?.payload as {
    findings: string[];
    apiAttempt: { transport: string; statusCode: number };
    transportAudit: { finalTransport: string; downgraded: boolean; fallbackReason: string; trustLevel: string };
  };
  assert.equal(payload.findings[0], "GPT-5 input $1.25 / 1M tokens");
  assert.equal(payload.apiAttempt.transport, "official_api");
  assert.equal(payload.transportAudit.finalTransport, "browser");
  assert.equal(payload.transportAudit.downgraded, true);
  assert.match(payload.transportAudit.fallbackReason, /403|blocked/i);
  assert.equal(payload.transportAudit.trustLevel, "observational");
});

test("explore worker returns failed when direct fetch is blocked and no browser fallback exists", async () => {
  const handler = new ExploreWorkerHandler({
    fetchFn: async () =>
      new Response("<html><title>Blocked</title><body>Access denied</body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
  });

  const result = await handler.run(buildExploreInvocationInput());

  assert.equal(result?.status, "failed");
  assert.match(result?.summary ?? "", /HTTP 403/);
});

test("explore worker does not use browser fallback when browser is not allowed", async () => {
  const handler = new ExploreWorkerHandler({
    fetchFn: async () =>
      new Response("Enable JavaScript and cookies to continue", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    browserBridge: {
      async inspectPublicPage(url) {
        return {
          requestedUrl: url,
          finalUrl: url,
          title: "Should not be used",
          textExcerpt: "",
          statusCode: 200,
        };
      },
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      capabilityInspection: {
        availableWorkers: ["explore"],
        connectorStates: [],
        apiStates: [],
        skillStates: [],
        transportPreferences: [
          {
            capability: "explore",
            orderedTransports: ["official_api", "business_tool", "browser"],
          },
        ],
        unavailableCapabilities: [],
        generatedAt: 1,
      },
    },
  });

  assert.equal(result?.status, "failed");
  const payload = result?.payload as {
    transportAudit: { finalTransport: string; fallbackReason: string };
  };
  assert.equal(payload.transportAudit.finalTransport, "official_api");
  assert.match(payload.transportAudit.fallbackReason, /browser fallback blocked/i);
});

test("explore worker rejects private hosts before fetching", async () => {
  let called = false;
  const handler = new ExploreWorkerHandler({
    fetchFn: async () => {
      called = true;
      return new Response("ok", { status: 200 });
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      taskPrompt: "Inspect http://127.0.0.1/pricing",
    },
  });

  assert.equal(called, false);
  assert.equal(result?.status, "failed");
  assert.match(result?.summary ?? "", /blocked explore URL host/i);
});

function buildExploreInvocationInput(): WorkerInvocationInput {
  return {
    activation: {
      runState: {
        runKey: "role:explore:thread:1",
        threadId: "thread-1",
        roleId: "role-explore",
        mode: "group",
        status: "running",
        iterationCount: 0,
        maxIterations: 6,
        inbox: [],
        lastActiveAt: 1,
      },
      thread: {
        threadId: "thread-1",
        teamId: "team-1",
        teamName: "Pricing",
        leadRoleId: "role-lead",
        roles: [
          { roleId: "role-lead", name: "Lead", seat: "lead", runtime: "local" },
          { roleId: "role-explore", name: "Explore", seat: "member", runtime: "local", capabilities: ["explore"] },
        ],
        participantLinks: [],
        metadataVersion: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      flow: {
        flowId: "flow-1",
        threadId: "thread-1",
        rootMessageId: "msg-root",
        mode: "serial",
        status: "running",
        currentStageIndex: 0,
        activeRoleIds: ["role-explore"],
        completedRoleIds: [],
        failedRoleIds: [],
        hopCount: 1,
        maxHops: 8,
        edges: [],
        createdAt: 1,
        updatedAt: 1,
      },
      handoff: {
        taskId: "task-1",
        flowId: "flow-1",
        sourceMessageId: "msg-1",
        targetRoleId: "role-explore",
        activationType: "mention",
        threadId: "thread-1",
        payload: {
          threadId: "thread-1",
          relayBrief: "Search OpenAI and check API pricing.",
          recentMessages: [],
          instructions: "Search OpenAI and check API pricing.",
          dispatchPolicy: {
            allowParallel: false,
            allowReenter: true,
            sourceFlowMode: "serial",
          },
        },
        createdAt: 1,
      },
    },
    packet: {
      roleId: "role-explore",
      roleName: "Explore",
      systemPrompt: "Research official pages.",
      taskPrompt: "Search OpenAI and check API pricing.",
      outputContract: "Return official pricing lines.",
      suggestedMentions: ["role-lead"],
      preferredWorkerKinds: ["explore"],
    },
  };
}

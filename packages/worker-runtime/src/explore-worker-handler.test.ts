import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelayPayload, type WorkerInvocationInput } from "@turnkeyai/core-types/team";

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

test("explore worker turns natural-language research tasks into a search URL", async () => {
  let fetchedUrl = "";
  const handler = new ExploreWorkerHandler({
    fetchFn: async (input) => {
      fetchedUrl = String(input);
      return new Response(
        `
          <html>
            <head><title>slock npm package github at DuckDuckGo</title></head>
            <body>
              <div class="result">
                <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fexample%2Fslock&amp;rut=abc">GitHub - example/slock &amp; docs</a>
                <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fexample%2Fslock&amp;rut=abc">Distributed lock package for Node.js &amp; TypeScript</a>
              </div>
            </body>
          </html>
        `,
        {
          status: 200,
          headers: { "content-type": "text/html" },
        }
      );
    },
  });

  const input = buildExploreInvocationInput();
  const result = await handler.run({
    ...input,
    activation: {
      ...input.activation,
      handoff: {
        ...input.activation.handoff,
        payload: normalizeRelayPayload({
          threadId: "thread-1",
          relayBrief: "Research slock package metadata.",
          recentMessages: [],
          instructions: "Research slock package metadata.",
        }),
      },
    },
    packet: {
      ...input.packet,
      taskPrompt: [
        "Research slock - what it is, core capabilities, user scale, community feedback, code quality, and update frequency.",
        "Search queries to try:",
        '- "slock npm package github"',
        '- "slock distributed lock library"',
        "Report findings with URLs and specific metrics.",
      ].join("\n"),
    },
  });

  assert.equal(result?.status, "completed");
  assert.match(fetchedUrl, /^https:\/\/duckduckgo\.com\/html\/\?/);
  assert.match(decodeURIComponent(fetchedUrl), /slock npm package github/);
  const payload = result?.payload as {
    findings: string[];
    searchResults: Array<{ title: string; url: string; snippet: string }>;
    transportAudit: { finalTransport: string; trustLevel: string };
  };
  assert.equal(payload.searchResults[0]?.url, "https://github.com/example/slock");
  assert.equal(payload.searchResults[0]?.title, "GitHub - example/slock & docs");
  assert.equal(payload.searchResults[0]?.snippet, "Distributed lock package for Node.js & TypeScript");
  assert.match(payload.findings[0] ?? "", /Distributed lock package/);
  assert.equal(payload.transportAudit.finalTransport, "business_tool");
  assert.equal(payload.transportAudit.trustLevel, "observational");
});

test("explore worker prefers quoted task entity over generic search instructions", async () => {
  let fetchedUrl = "";
  const handler = new ExploreWorkerHandler({
    fetchFn: async (input) => {
      fetchedUrl = String(input);
      return new Response(
        `
          <html>
            <head><title>Slock at DuckDuckGo</title></head>
            <body>
              <div class="result">
                <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fslock.ai%2F&amp;rut=abc">Slock - Where humans and AI agents build together</a>
              </div>
            </body>
          </html>
        `,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    },
  });

  const input = buildExploreInvocationInput();
  const taskPrompt =
    'Find information about "Slock" - what product/company it is. Search for official documentation, company websites, product pages, or credible reviews.';
  const result = await handler.run({
    ...input,
    activation: {
      ...input.activation,
      handoff: {
        ...input.activation.handoff,
        payload: normalizeRelayPayload({
          threadId: "thread-1",
          relayBrief: taskPrompt,
          recentMessages: [],
          instructions: taskPrompt,
        }),
      },
    },
    packet: {
      ...input.packet,
      taskPrompt,
    },
  });

  assert.equal(result?.status, "completed");
  assert.match(decodeURIComponent(fetchedUrl), /q=Slock(?:&|$)/);
  assert.doesNotMatch(decodeURIComponent(fetchedUrl), /official documentation/);
});

test("explore worker fails blocked search pages instead of promoting them as evidence", async () => {
  const handler = new ExploreWorkerHandler({
    fetchFn: async () =>
      new Response(
        `
          <html>
            <head><title>Google Search</title></head>
            <body>Please click here if you are not redirected within a few seconds.</body>
          </html>
        `,
        {
          status: 200,
          headers: { "content-type": "text/html" },
        }
      ),
  });

  const input = buildExploreInvocationInput();
  const taskPrompt = "Research Multica product software";
  const result = await handler.run({
    ...input,
    activation: {
      ...input.activation,
      handoff: {
        ...input.activation.handoff,
        payload: normalizeRelayPayload({
          threadId: "thread-1",
          relayBrief: taskPrompt,
          recentMessages: [],
          instructions: taskPrompt,
        }),
      },
    },
    packet: {
      ...input.packet,
      taskPrompt,
    },
  });

  assert.equal(result?.status, "failed");
  const payload = result?.payload as {
    apiAttempt: { errorMessage: string; transport: string };
    transportAudit: { finalTransport: string; trustLevel: string; fallbackReason: string };
  };
  assert.match(payload.apiAttempt.errorMessage, /blocked content/i);
  assert.equal(payload.apiAttempt.transport, "business_tool");
  assert.equal(payload.transportAudit.finalTransport, "business_tool");
  assert.equal(payload.transportAudit.trustLevel, "observational");
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
  assert.match(result?.summary ?? "", /blocked content/i);
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

test("explore worker does not start browser fallback after cancellation", async () => {
  const controller = new AbortController();
  let browserCalled = false;
  const handler = new ExploreWorkerHandler({
    fetchFn: async () => {
      controller.abort("session tool timeout");
      throw new Error("direct fetch aborted");
    },
    browserBridge: {
      async inspectPublicPage() {
        browserCalled = true;
        throw new Error("browser should not start after cancellation");
      },
    },
  });

  await assert.rejects(
    handler.run({
      ...buildExploreInvocationInput(),
      signal: controller.signal,
    }),
    /session tool timeout/
  );
  assert.equal(browserCalled, false);
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

test("explore worker falls back to browser for blocked private hosts when browser is available", async () => {
  let fetched = false;
  let browserUrl = "";
  const handler = new ExploreWorkerHandler({
    fetchFn: async () => {
      fetched = true;
      return new Response("ok", { status: 200 });
    },
    browserBridge: {
      async inspectPublicPage(url) {
        browserUrl = url;
        return {
          requestedUrl: url,
          finalUrl: url,
          title: "Local Vendor Alpha",
          textExcerpt: "Pricing: $19 per seat. Strength: traceable screenshots. Risk: limited API catalog.",
          statusCode: 200,
        };
      },
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      taskPrompt: "Inspect http://127.0.0.1:49152/vendor-alpha",
    },
  });

  assert.equal(fetched, false);
  assert.equal(browserUrl, "http://127.0.0.1:49152/vendor-alpha");
  assert.equal(result?.status, "partial");
  assert.match(result?.summary ?? "", /fell back to browser/i);
  const payload = result?.payload as {
    findings: string[];
    transportAudit: { finalTransport: string; fallbackReason: string; downgraded: boolean };
  };
  assert.equal(payload.findings[0], "Pricing: $19 per seat.");
  assert.equal(payload.transportAudit.finalTransport, "browser");
  assert.equal(payload.transportAudit.downgraded, true);
  assert.match(payload.transportAudit.fallbackReason, /blocked explore URL host/i);
});

test("explore worker keeps blocked private hosts failed when browser fallback is unavailable", async () => {
  let browserCalled = false;
  const handler = new ExploreWorkerHandler({
    browserBridge: {
      async inspectPublicPage(url) {
        browserCalled = true;
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
      taskPrompt: "Inspect http://127.0.0.1:49152/vendor-alpha",
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

  assert.equal(browserCalled, false);
  assert.equal(result?.status, "failed");
  assert.match(result?.summary ?? "", /browser fallback is not allowed/i);
});

test("explore worker can explicitly allow loopback hosts for isolated E2E fixtures", async () => {
  let fetchedUrl = "";
  const handler = new ExploreWorkerHandler({
    allowLoopbackHosts: true,
    fetchFn: async (input) => {
      fetchedUrl = String(input);
      return new Response(
        "<html><head><title>Local Fixture</title></head><body>TURNKEYAI_LOCAL_FIXTURE_OK</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      taskPrompt: "Inspect http://127.0.0.1:49152/fixture",
    },
  });

  assert.equal(result?.status, "completed");
  assert.equal(fetchedUrl, "http://127.0.0.1:49152/fixture");
  assert.match(result?.summary ?? "", /TURNKEYAI_LOCAL_FIXTURE_OK/);
});

test("explore worker fetches every explicit URL in a multi-source task", async () => {
  const fetchedUrls: string[] = [];
  const handler = new ExploreWorkerHandler({
    allowLoopbackHosts: true,
    fetchFn: async (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.endsWith("/vendor-alpha")) {
        return new Response(
          "<html><head><title>Vendor Alpha Evidence</title></head><body>Pricing: $19 per seat. Strength: browser automation. Risk: limited API catalog.</body></html>",
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response(
        "<html><head><title>Vendor Beta Evidence</title></head><body>Pricing: $29 per workspace. Strength: approval workflow. Risk: separate browser connector.</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      taskPrompt: [
        "Compare these two source pages.",
        "Alpha: http://127.0.0.1:49152/vendor-alpha",
        "Beta: http://127.0.0.1:49152/vendor-beta",
        "Return pricing, strengths, and risks for both vendors.",
      ].join("\n"),
    },
  });

  assert.equal(result?.status, "completed");
  assert.deepEqual(fetchedUrls, [
    "http://127.0.0.1:49152/vendor-alpha",
    "http://127.0.0.1:49152/vendor-beta",
  ]);
  assert.match(result?.summary ?? "", /fetched 2 of 2 sources/);
  assert.match(result?.summary ?? "", /\$19 per seat/);
  assert.match(result?.summary ?? "", /\$29 per workspace/);
  const payload = result?.payload as {
    pages: Array<{ requestedUrl: string; title: string }>;
    findings: string[];
    sourceResults: Array<{ status: string; url: string; findings: string[] }>;
  };
  assert.equal(payload.pages.length, 2);
  assert.equal(payload.sourceResults.length, 2);
  assert.deepEqual(payload.sourceResults.map((item) => item.status), ["completed", "completed"]);
  assert.match(payload.findings.join("\n"), /vendor-alpha: .*Pricing: \$19 per seat/i);
  assert.match(payload.findings.join("\n"), /vendor-beta: .*Pricing: \$29 per workspace/i);
});

test("explore worker synthesizes a decision note from existing evidence on resume", async () => {
  let fetched = false;
  const handler = new ExploreWorkerHandler({
    allowLoopbackHosts: true,
    fetchFn: async () => {
      fetched = true;
      throw new Error("continuation synthesis should not fetch");
    },
  });
  const input = buildExploreInvocationInput();

  const result = await handler.run({
    ...input,
    sessionState: {
      workerRunKey: "worker:explore:task:task-1:call-1",
      workerType: "explore",
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      lastResult: {
        workerType: "explore",
        status: "completed",
        summary: "Explore worker fetched 1 of 1 sources.",
        payload: {
          pages: [
            {
              requestedUrl: "http://127.0.0.1:49152/vendor-alpha",
              finalUrl: "http://127.0.0.1:49152/vendor-alpha",
              title: "Vendor Alpha Evidence",
              textExcerpt: "Pricing: $19 per seat. Strength: browser automation. Risk: limited API catalog.",
              statusCode: 200,
            },
          ],
          sourceResults: [
            {
              url: "http://127.0.0.1:49152/vendor-alpha",
              label: "Vendor Alpha",
              status: "completed",
              findings: [
                "Pricing: $19 per seat.",
                "Strength: browser automation.",
                "Risk: limited API catalog.",
              ],
              page: {
                requestedUrl: "http://127.0.0.1:49152/vendor-alpha",
                finalUrl: "http://127.0.0.1:49152/vendor-alpha",
                title: "Vendor Alpha Evidence",
                textExcerpt: "Pricing: $19 per seat. Strength: browser automation. Risk: limited API catalog.",
                statusCode: 200,
              },
            },
          ],
          findings: [
            "Vendor Alpha: Pricing: $19 per seat.",
            "Vendor Alpha: Strength: browser automation.",
            "Vendor Alpha: Risk: limited API catalog.",
          ],
        },
      },
      history: [
        {
          id: "history-tool-1",
          role: "tool",
          content: "Explore worker fetched Vendor Alpha. Pricing: $19 per seat. Strength: browser automation. Risk: limited API catalog.",
          createdAt: 2,
          status: "completed",
          payload: {
            page: {
              requestedUrl: "http://127.0.0.1:49152/vendor-alpha",
              finalUrl: "http://127.0.0.1:49152/vendor-alpha",
              title: "Vendor Alpha Evidence",
              textExcerpt: "Pricing: $19 per seat. Strength: browser automation. Risk: limited API catalog.",
              statusCode: 200,
            },
          },
        },
      ],
    },
    packet: {
      ...input.packet,
      continuityMode: "resume-existing",
      taskPrompt: [
        "Continue from the previous work on this mission.",
        "Ask the same Vendor Alpha research thread to revisit its notes and turn the evidence into a decision note for a product lead.",
        "Keep the answer source-bounded.",
        "",
        "Continuation context:",
        "Previous worker status: done",
        "Last result: Explore worker fetched 1 of 1 sources.",
        "- tool status=completed: Final URL: http://127.0.0.1:49152/vendor-alpha. Title: Vendor Alpha Evidence.",
      ].join("\n"),
    },
  });

  assert.equal(fetched, false);
  assert.equal(result?.status, "completed");
  assert.match(result?.summary ?? "", /reused prior evidence/i);
  const payload = result?.payload as { content: string; pages: unknown[]; sourceResults: unknown[] };
  assert.match(payload.content, /\$19 per seat/);
  assert.match(payload.content, /Residual risk/i);
  assert.equal(payload.pages.length, 1);
  assert.equal(payload.sourceResults.length, 1);
});

test("explore worker ignores evidence-summary pseudo URLs when extracting explicit targets", async () => {
  const fetchedUrls: string[] = [];
  const handler = new ExploreWorkerHandler({
    allowLoopbackHosts: true,
    fetchFn: async (input) => {
      fetchedUrls.push(String(input));
      return new Response(
        "<html><head><title>Vendor Alpha Evidence</title></head><body>Pricing: $19 per seat.</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      taskPrompt: [
        "Fetch http://127.0.0.1:49152/vendor-alpha",
        "Recent transcript noise: Final URL: http://127.0.0.1:49152/vendor-alpha/nPage title follows.",
        "More transcript noise: http://127.0.0.1:49152/vendor-alpha/nFinal URL.",
      ].join("\n"),
    },
  });

  assert.equal(result?.status, "completed");
  assert.deepEqual(fetchedUrls, ["http://127.0.0.1:49152/vendor-alpha"]);
});

test("explore worker ignores truncated transcript URLs and strips closing brackets", async () => {
  const fetchedUrls: string[] = [];
  const handler = new ExploreWorkerHandler({
    allowLoopbackHosts: true,
    fetchFn: async (input) => {
      fetchedUrls.push(String(input));
      return new Response(
        "<html><head><title>Vendor Alpha Evidence</title></head><body>Pricing: $19 per seat.</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      taskPrompt: [
        "Fetch http://127.0.0.1:49152/vendor-alpha].",
        "Ignore transcript truncation: http://127.0.0.1:49152/vendor…",
        "Ignore encoded transcript truncation: http://127.0.0.1:49152/vendor%E2%80%A6",
      ].join("\n"),
    },
  });

  assert.equal(result?.status, "completed");
  assert.deepEqual(fetchedUrls, ["http://127.0.0.1:49152/vendor-alpha"]);
});

test("explore worker strips prose punctuation from explicit URLs", async () => {
  let fetchedUrl = "";
  const handler = new ExploreWorkerHandler({
    allowLoopbackHosts: true,
    fetchFn: async (input) => {
      fetchedUrl = String(input);
      return new Response(
        "<html><head><title>Local Fixture</title></head><body>TURNKEYAI_LOCAL_FIXTURE_OK</body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    },
  });

  const result = await handler.run({
    ...buildExploreInvocationInput(),
    packet: {
      ...buildExploreInvocationInput().packet,
      taskPrompt: "Fetch http://127.0.0.1:49152/vendor-beta. Report the marker.",
    },
  });

  assert.equal(result?.status, "completed");
  assert.equal(fetchedUrl, "http://127.0.0.1:49152/vendor-beta");
  assert.match(result?.summary ?? "", /TURNKEYAI_LOCAL_FIXTURE_OK/);
});

test("explore worker rejects bracketed IPv6 loopback hosts before fetching", async () => {
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
      taskPrompt: "Inspect http://[::1]/pricing",
    },
  });

  assert.equal(called, false);
  assert.equal(result?.status, "failed");
  assert.match(result?.summary ?? "", /blocked explore URL host/i);
});

test("explore worker rejects IPv4-mapped IPv6 private hosts before fetching", async () => {
  let called = false;
  const handler = new ExploreWorkerHandler({
    fetchFn: async () => {
      called = true;
      return new Response("ok", { status: 200 });
    },
  });

  for (const taskPrompt of [
    "Inspect http://[::ffff:127.0.0.1]/pricing",
    "Inspect http://[::ffff:10.0.0.1]/pricing",
    "Inspect http://[::7f00:1]/pricing",
  ]) {
    const result = await handler.run({
      ...buildExploreInvocationInput(),
      packet: {
        ...buildExploreInvocationInput().packet,
        taskPrompt,
      },
    });

    assert.equal(result?.status, "failed");
    assert.match(result?.summary ?? "", /blocked explore URL host/i);
  }
  assert.equal(called, false);
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
        payload: normalizeRelayPayload({
          threadId: "thread-1",
          relayBrief: "Search OpenAI and check API pricing.",
          recentMessages: [],
          instructions: "Search OpenAI and check API pricing.",
          dispatchPolicy: {
            allowParallel: false,
            allowReenter: true,
            sourceFlowMode: "serial",
          },
        }),
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

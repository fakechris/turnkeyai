import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

interface MissionToolUseE2eOptions {
  modelCatalogPath?: string;
  scenarioTimeoutMs: number;
  scenario: MissionE2eScenario;
  matrixScenarios?: MissionE2eScenario[];
}

type MissionE2eScenario =
  | "basic"
  | "comparison"
  | "followup"
  | "cancel"
  | "approval"
  | "browser-dynamic"
  | "timeout-recovery";

interface Mission {
  id: string;
  status: string;
  threadId?: string;
  blockers?: number;
}

interface ActivityEvent {
  kind: string;
  text: string;
  tMs: number;
  emph?: string;
  runtime?: Record<string, unknown>;
  tags?: string[];
  approvalId?: string;
}

interface MissionObservabilitySnapshot {
  status: string;
  tool: {
    requested: number;
    results: number;
    failed: number;
    cancelled: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
  };
  approvals: {
    requested: number;
    applied: number;
    decided: number;
  };
  recovery: {
    events: number;
  };
  liveness: {
    active: number;
    waiting: number;
    stale: number;
  };
  qualityGate: {
    status: string;
    evidenceEvents: number;
  };
}

const FINAL_MARKER = "TURNKEYAI_MISSION_E2E_OK";
const FIXTURE_MARKER = "TURNKEYAI_MISSION_FIXTURE_OK";
const COMPARISON_FINAL_MARKER = "TURNKEYAI_MISSION_COMPARISON_OK";
const ALPHA_MARKER = "TURNKEYAI_VENDOR_ALPHA_OK";
const BETA_MARKER = "TURNKEYAI_VENDOR_BETA_OK";
const FOLLOWUP_PHASE_MARKER = "TURNKEYAI_MISSION_FOLLOWUP_PHASE_ONE";
const FOLLOWUP_FINAL_MARKER = "TURNKEYAI_MISSION_FOLLOWUP_OK";
const CANCEL_FINAL_MARKER = "TURNKEYAI_MISSION_CANCEL_OK";
const APPROVAL_MARKER = "TURNKEYAI_APPROVAL_FIXTURE_OK";
const APPROVAL_FINAL_MARKER = "TURNKEYAI_MISSION_APPROVAL_OK";
const DYNAMIC_BROWSER_MARKER = "TURNKEYAI_DYNAMIC_BROWSER_OK";
const DYNAMIC_BROWSER_FINAL_MARKER = "TURNKEYAI_MISSION_DYNAMIC_BROWSER_OK";
const TIMEOUT_FINAL_MARKER = "TURNKEYAI_MISSION_TIMEOUT_OK";

interface FixtureServer {
  server: Server;
  basicUrl: string;
  alphaUrl: string;
  betaUrl: string;
  slowUrl: string;
  approvalUrl: string;
  dynamicUrl: string;
}

interface ScenarioSpec {
  scenario: MissionE2eScenario;
  title: string;
  desc: string;
  finalMarker: string;
  evidenceMarkers: string[];
  answerTerms: string[];
  answerPatterns?: Array<{ label: string; pattern: RegExp }>;
  evidenceLinePatterns?: Array<{ label: string; pattern: RegExp }>;
  allowLabeledEvidenceWithoutBullets?: boolean;
  expectedSpawnCalls: number;
  expectedSendCalls: number;
  expectedToolResults: number;
  expectedSpawnedSessions: number;
  expectedContinuedSessions: number;
  minEvidenceEvents: number;
  expectedBullets: number;
}

interface MissionScenarioResult {
  scenario: MissionE2eScenario;
  mission: Mission;
  timeline: ActivityEvent[];
  metrics: MissionObservabilitySnapshot;
  final: ActivityEvent;
  quality: ReturnType<typeof evaluateFinalQuality>;
}

interface WorkerSessionRecord {
  workerRunKey: string;
  state: {
    status: string;
    workerType?: string;
    lastError?: { message?: string };
  };
}

interface ApprovalRecord {
  id: string;
  missionId: string;
  action: string;
  decision?: unknown;
  requestedAtMs?: number;
}

function parseOptions(args: string[]): MissionToolUseE2eOptions {
  const options: MissionToolUseE2eOptions = {
    scenarioTimeoutMs: 180_000,
    scenario: "basic",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model-catalog") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --model-catalog");
      }
      options.modelCatalogPath = value;
      index += 1;
      continue;
    }
    if (arg === "--scenario") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --scenario");
      }
      options.scenario = parseScenarioName(value, "--scenario");
      index += 1;
      continue;
    }
    if (arg === "--matrix-scenarios") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --matrix-scenarios");
      }
      options.matrixScenarios = parseScenarioList(value);
      index += 1;
      continue;
    }
    if (arg === "--scenario-timeout-ms") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("missing value for --scenario-timeout-ms");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error("--scenario-timeout-ms must be a positive integer");
      }
      options.scenarioTimeoutMs = parsed;
      index += 1;
      continue;
    }
  }
  return options;
}

function parseScenarioList(value: string): MissionE2eScenario[] {
  const scenarios = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (scenarios.length === 0) {
    throw new Error("--matrix-scenarios must include at least one scenario");
  }
  return scenarios.map((scenario) => parseScenarioName(scenario, "--matrix-scenarios"));
}

function parseScenarioName(value: string, argName: string): MissionE2eScenario {
  if (
    value === "basic" ||
    value === "comparison" ||
    value === "followup" ||
    value === "cancel" ||
    value === "approval" ||
    value === "browser-dynamic" ||
    value === "timeout-recovery"
  ) {
    return value;
  }
  throw new Error(`${argName} must be basic, comparison, followup, cancel, approval, browser-dynamic, or timeout-recovery`);
}

async function main(options: MissionToolUseE2eOptions): Promise<void> {
  const modelCatalogPath = resolveModelCatalogPath(options.modelCatalogPath);
  const fixture = await startFixtureServer();
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-mission-e2e-"));
  const port = await allocatePort();
  const token = `mission-e2e-${Date.now()}`;
  const daemon = startDaemon({
    runtimeRoot,
    port,
    token,
    modelCatalogPath,
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForDaemonHealth({ baseUrl, daemon, timeoutMs: 20_000 });
    const scenarios = options.matrixScenarios ?? [options.scenario];
    const results = [];
    for (const scenario of scenarios) {
      try {
        results.push(
          await runMissionScenario({
            baseUrl,
            token,
            fixture,
            scenario,
            timeoutMs: options.scenarioTimeoutMs,
          })
        );
      } catch (error) {
        throw new Error(
          `mission scenario ${scenario} failed: ${errorMessage(error)}\n\ndaemon output tail:\n${daemon.output()}`
        );
      }
    }
    for (const result of results) {
      printScenarioResult(result);
    }
    if (scenarios.length > 1) {
      console.log(`mission tool-use real llm matrix passed: ${scenarios.join(",")}`);
    }
  } finally {
    await stopDaemon(daemon.child);
    await closeServer(fixture.server);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function runMissionScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  if (input.scenario === "followup") {
    return runMissionFollowupScenario(input);
  }
  if (input.scenario === "cancel") {
    return runMissionCancelScenario(input);
  }
  if (input.scenario === "approval") {
    return runMissionApprovalScenario(input);
  }
  if (input.scenario === "timeout-recovery") {
    return runMissionTimeoutScenario(input);
  }
  const spec = buildScenarioSpec(input.scenario, input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");
  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionToolUseTimeline(result.timeline, spec);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission ${input.scenario} final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: input.scenario, mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionFollowupScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const initialSpec = buildFollowupInitialSpec(input.fixture);
  const finalSpec = buildScenarioSpec("followup", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec: initialSpec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const initial = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: initialSpec.finalMarker,
    timeoutMs: input.timeoutMs,
  });
  assertMissionToolUseTimeline(initial.timeline, initialSpec);
  const sessionKey = extractFirstSessionKey(initial.timeline);
  assert.ok(sessionKey, "follow-up E2E requires a session_key from the phase-one sessions_spawn result");

  await requestJson<{ accepted: boolean; missionId: string }>({
    method: "POST",
    url: `${input.baseUrl}/missions/${encodeURIComponent(mission.id)}/messages`,
    token: input.token,
    body: {
      content: [
        "Continue this mission from the existing explore child session.",
        "Call sessions_send exactly once using the session_key from the prior sessions_spawn tool result.",
        "Do not call sessions_spawn, sessions_history, or sessions_list.",
        `The sessions_send message must ask the child to return its complete final report containing ${FIXTURE_MARKER}.`,
        `Final answer must include ${FOLLOWUP_FINAL_MARKER}, ${FIXTURE_MARKER}, sessions_send, the reused session_key, the phrase no duplicate session, and the exact words residual risk.`,
        "Use plain Markdown with heading `Evidence` and exactly three bullets: same-session follow-up, fixture evidence, residual risk.",
        "Put the final success marker in the same-session follow-up bullet. Do not create a separate marker bullet.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    },
  });

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: finalSpec.finalMarker,
    timeoutMs: input.timeoutMs,
  });
  assertMissionToolUseTimeline(result.timeline, finalSpec);
  assertFollowupReusedSession(result.timeline, sessionKey);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionMetrics(metrics, finalSpec);
  const final = findFinalEvent(result.timeline, finalSpec.finalMarker);
  assert.ok(final, "mission timeline must include a follow-up final assistant answer");
  const quality = evaluateFinalQuality(final.text, finalSpec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission followup final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "followup", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionCancelScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec("cancel", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const activeCall = await waitForToolCallEvent({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    toolName: "sessions_spawn",
    timeoutMs: Math.min(input.timeoutMs, 60_000),
  });
  await requestJson<{ cancelled: boolean }>({
    method: "POST",
    url: `${input.baseUrl}/message/cancel-tools`,
    token: input.token,
    body: {
      messageId: activeCall.messageId,
      threadId: mission.threadId,
      toolCallIds: [activeCall.toolCallId],
      reason: "operator cancelled mission e2e slow tool",
    },
  });

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionCancelTimeline(result.timeline, spec);
  const cancelledSessionKey = extractFirstSessionKey(result.timeline);
  assert.ok(cancelledSessionKey, "cancel E2E requires a session_key from the cancelled sessions_spawn result");
  await assertWorkerSessionCancelled({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    workerRunKey: cancelledSessionKey,
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionCancelMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a cancellation final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission cancel final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "cancel", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionApprovalScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec("approval", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const approval = await waitForApprovalRequest({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    action: "browser.form.submit",
    timeoutMs: Math.min(input.timeoutMs, 90_000),
  });
  await requestJson<unknown>({
    method: "POST",
    url: `${input.baseUrl}/approvals/${encodeURIComponent(approval.id)}/decision`,
    token: input.token,
    body: {
      decision: "approved",
      decidedBy: "mission-e2e",
      reason: "approving isolated mission E2E approval-gate fixture",
    },
  });

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
  });
  assertMissionToolUseTimeline(result.timeline, spec);
  assertMissionApprovalTimeline(result.timeline, spec, approval.id);
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionApprovalMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include an approval final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission approval final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "approval", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

async function runMissionTimeoutScenario(input: {
  baseUrl: string;
  token: string;
  fixture: FixtureServer;
  scenario: MissionE2eScenario;
  timeoutMs: number;
}): Promise<MissionScenarioResult> {
  const spec = buildScenarioSpec("timeout-recovery", input.fixture);
  const mission = await createMission({
    baseUrl: input.baseUrl,
    token: input.token,
    spec,
  });
  assert.ok(mission.threadId, "mission route must create a linked team thread");

  const result = await waitForMissionCompletion({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    finalMarker: spec.finalMarker,
    timeoutMs: input.timeoutMs,
    failFastDoneWithoutMarker: true,
  });
  assertMissionTimeoutTimeline(result.timeline, spec);
  const timeoutSessionKey = extractFirstSessionKey(result.timeline);
  assert.ok(timeoutSessionKey, "timeout E2E requires a session_key from the timed-out sessions_spawn result");
  await assertWorkerSessionResumableAfterTimeout({
    baseUrl: input.baseUrl,
    token: input.token,
    threadId: mission.threadId,
    workerRunKey: timeoutSessionKey,
  });
  const metrics = await waitForMissionMetricsSettled({
    baseUrl: input.baseUrl,
    token: input.token,
    missionId: mission.id,
    timeoutMs: 20_000,
  });
  assertMissionTimeoutMetrics(metrics, spec);
  const final = findFinalEvent(result.timeline, spec.finalMarker);
  assert.ok(final, "mission timeline must include a timeout final assistant answer");
  const quality = evaluateFinalQuality(final.text, spec);
  assert.deepEqual(
    quality.failures,
    [],
    `mission timeout final answer quality failures: ${quality.failures.join("; ")}\n${final.text}`
  );
  return { scenario: "timeout-recovery", mission: result.mission, timeline: result.timeline, metrics, final, quality };
}

function printScenarioResult(result: MissionScenarioResult): void {
  console.log("mission tool-use real llm e2e passed");
  console.log(`mission-scenario: ${result.scenario}`);
  console.log(`mission-id: ${result.mission.id}`);
  console.log(`mission-status: ${result.mission.status}`);
  console.log(`mission-thread-id: ${result.mission.threadId ?? ""}`);
  console.log(`mission-tool-events: ${result.timeline.filter((event) => event.kind === "tool").length}`);
  console.log(`mission-quality-gate: ${result.metrics.qualityGate.status}`);
  console.log(`mission-metrics-tools: ${result.metrics.tool.requested}/${result.metrics.tool.results}`);
  console.log(`mission-metrics-sessions: ${result.metrics.sessions.spawned}/${result.metrics.sessions.continued}`);
  console.log(
    `mission-metrics-approvals: ${result.metrics.approvals.requested}/${result.metrics.approvals.decided}/${result.metrics.approvals.applied}`
  );
  console.log(
    `mission-metrics-liveness: ${result.metrics.liveness.active}/${result.metrics.liveness.waiting}/${result.metrics.liveness.stale}`
  );
  console.log(`mission-metrics-evidence: ${result.metrics.qualityGate.evidenceEvents}`);
  console.log(`mission-final-bytes: ${Buffer.byteLength(result.final.text, "utf8")}`);
  console.log(`mission-final-bullets: ${result.quality.bullets}`);
}

function resolveModelCatalogPath(explicitPath?: string): string {
  if (explicitPath?.trim()) {
    const candidate = path.resolve(explicitPath.trim());
    readFileSync(candidate, "utf8");
    return candidate;
  }
  const candidates = [
    process.env.TURNKEYAI_MODEL_CATALOG,
    path.resolve(process.cwd(), "models.local.json"),
    path.resolve(process.cwd(), "models.json"),
  ].filter((item): item is string => Boolean(item?.trim()));
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error("mission E2E requires --model-catalog, TURNKEYAI_MODEL_CATALOG, models.local.json, or models.json");
}

async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/fixture") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>TurnkeyAI Mission E2E Fixture</title></head>
  <body>
    <main>
      <h1>Mission route tool-use fixture</h1>
      <p id="marker">${FIXTURE_MARKER}</p>
      <p>Evidence source: local fixture served only for the mission route acceptance test.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/slow-fixture") {
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><title>TurnkeyAI Slow Mission E2E Fixture</title></head>
  <body>
    <main>
      <h1>Slow mission route tool-use fixture</h1>
      <p id="marker">${FIXTURE_MARKER}</p>
      <p>This response is intentionally delayed so the cancellation path can stop the active tool call.</p>
    </main>
  </body>
</html>`);
      }, 180_000);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (pathname === "/vendor-alpha") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Vendor Alpha Evidence</title></head>
  <body>
    <main>
      <h1>Vendor Alpha</h1>
      <p id="marker">${ALPHA_MARKER}</p>
      <p>Pricing: $19 per seat.</p>
      <p>Strength: browser automation and traceable screenshots.</p>
      <p>Risk: API integration catalog is still limited.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/vendor-beta") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Vendor Beta Evidence</title></head>
  <body>
    <main>
      <h1>Vendor Beta</h1>
      <p id="marker">${BETA_MARKER}</p>
      <p>Pricing: $29 per workspace.</p>
      <p>Strength: approval workflow and team handoff history.</p>
      <p>Risk: browser control requires a separate connector.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/approval-form") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head><title>Approval Gate Fixture</title></head>
  <body>
    <main>
      <h1>Approval gate fixture</h1>
      <p id="marker">${APPROVAL_MARKER}</p>
      <p>This local page is safe evidence for browser.form.submit approval gating; no external mutation is performed.</p>
    </main>
  </body>
</html>`);
      return;
    }
    if (pathname === "/dynamic-dashboard") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html>
  <head>
    <title>Dynamic Browser Fixture</title>
    <script>
      window.__turnkeyDynamicState = { status: "booting" };
      const renderTurnkeyDynamicFixture = () => {
        const root = document.getElementById("dynamic-root");
        if (!root) {
          window.__turnkeyDynamicState = { status: "missing-root" };
          return;
        }
        window.__turnkeyDynamicState = {
          status: "ready",
          marker: "${DYNAMIC_BROWSER_MARKER}",
          activeUsers: 42,
          queueDepth: 7,
          source: "client-rendered local fixture"
        };
        root.innerHTML = [
          "<h1>Dynamic operations dashboard</h1>",
          "<p id='marker'>${DYNAMIC_BROWSER_MARKER}</p>",
          "<p id='active-users'>Active users: 42</p>",
          "<p id='queue-depth'>Queue depth: 7</p>",
          "<p id='risk'>Residual risk: local dynamic fixture only.</p>"
        ].join("");
      };
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", renderTurnkeyDynamicFixture, { once: true });
      } else {
        renderTurnkeyDynamicFixture();
      }
    </script>
  </head>
  <body>
    <main id="dynamic-root">
      <h1>Loading dynamic dashboard</h1>
      <p>Server HTML does not contain the evidence marker; browser JavaScript must render it.</p>
    </main>
  </body>
</html>`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  });
  const port = await listenOnRandomPort(server);
  return {
    server,
    basicUrl: `http://127.0.0.1:${port}/fixture`,
    alphaUrl: `http://127.0.0.1:${port}/vendor-alpha`,
    betaUrl: `http://127.0.0.1:${port}/vendor-beta`,
    slowUrl: `http://127.0.0.1:${port}/slow-fixture`,
    approvalUrl: `http://127.0.0.1:${port}/approval-form`,
    dynamicUrl: `http://127.0.0.1:${port}/dynamic-dashboard`,
  };
}

async function createMission(input: {
  baseUrl: string;
  token: string;
  spec: ScenarioSpec;
}): Promise<Mission> {
  return requestJson<Mission>({
    method: "POST",
    url: `${input.baseUrl}/missions`,
    token: input.token,
    body: {
      title: input.spec.title,
      mode: "research",
      desc: input.spec.desc,
      owner: "e2e",
      ownerLabel: "E2E",
    },
  });
}

function buildScenarioSpec(scenario: MissionE2eScenario, fixture: FixtureServer): ScenarioSpec {
  if (scenario === "timeout-recovery") {
    return {
      scenario,
      title: "Mission route timeout recovery E2E",
      finalMarker: TIMEOUT_FINAL_MARKER,
      evidenceMarkers: [],
      answerTerms: ["timed out", "verification did not complete", "continue", "residual risk"],
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      desc: [
        "Run the mission route timeout recovery E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        "The sessions_spawn input must include timeout_seconds as the JSON number 0.001.",
        `The explore sub-agent task must fetch ${fixture.slowUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
        "The local fixture is intentionally too slow; do not call sessions_send, sessions_history, sessions_list, or any fallback session after the timeout result.",
        `Final answer must include ${TIMEOUT_FINAL_MARKER}, timed out, verification did not complete, continue, and the exact words residual risk.`,
        `Use plain Markdown with heading \`Timeout result\` and exactly three bullets: timeout boundary, attempted verification, residual risk. The first bullet must start with "- timeout boundary: ${TIMEOUT_FINAL_MARKER} -". The third bullet must include the literal word continue.`,
        "Do not add any paragraph, summary, or note after the three bullets.",
        "Do not claim the fixture marker was verified unless it appears in the tool result.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "browser-dynamic") {
    return {
      scenario,
      title: "Mission route dynamic browser extraction E2E",
      finalMarker: DYNAMIC_BROWSER_FINAL_MARKER,
      evidenceMarkers: [DYNAMIC_BROWSER_MARKER],
      answerTerms: ["browser", "Active users: 42", "Queue depth: 7", "residual risk"],
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      desc: [
        "Run the mission route dynamic browser extraction E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=browser exactly once.",
        `The browser sub-agent task must open ${fixture.dynamicUrl}, inspect the JavaScript-rendered DOM, and report marker ${DYNAMIC_BROWSER_MARKER}.`,
        "The task must also report the exact dynamic facts Active users: 42 and Queue depth: 7.",
        "Do not use an explore/fetch session for this task; the marker is intentionally rendered by browser JavaScript.",
        `Final answer must include ${DYNAMIC_BROWSER_FINAL_MARKER}, ${DYNAMIC_BROWSER_MARKER}, Active users: 42, Queue depth: 7, and the exact words residual risk.`,
        "Use plain Markdown with heading `Browser evidence` and exactly three bullets: dynamic DOM evidence, extracted dashboard facts, residual risk.",
        "Do not create a separate bullet for the final success marker. Put it in the dynamic DOM evidence bullet.",
        "Keep the final answer under 140 words. Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "approval") {
    return {
      scenario,
      title: "Mission route approval-gated browser E2E",
      finalMarker: APPROVAL_FINAL_MARKER,
      evidenceMarkers: [APPROVAL_MARKER],
      answerTerms: ["permission.query", "permission.result", "permission.applied", "browser.form.submit", "residual risk"],
      evidenceLinePatterns: [
        { label: "approval request evidence", pattern: /^\s*(?:[-*+]\s+)?approval request\s*:/im },
        { label: "approval decision/application evidence", pattern: /^\s*(?:[-*+]\s+)?approval decision\/application\s*:/im },
        { label: "browser fixture evidence", pattern: /^\s*(?:[-*+]\s+)?browser fixture evidence\s*:/im },
        { label: "residual risk evidence", pattern: /^\s*(?:[-*+]\s+)?residual risk\s*:/im },
      ],
      allowLabeledEvidenceWithoutBullets: true,
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 4,
      desc: [
        "Run the mission route approval-gated browser E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=browser exactly once.",
        "Do not call permission_query, permission_result, or permission_applied directly; the runtime gate must emit those while handling sessions_spawn.",
        "The browser task must include the exact action phrase browser.form.submit and the word submit so the runtime approval gate is exercised before browser work starts.",
        `After the runtime approval gate is cleared, the browser task must open ${fixture.approvalUrl}, verify marker ${APPROVAL_MARKER}, and report that this fixture performs no external mutation.`,
        "Do not ask the browser sub-agent to click a real submit control; this is an approval-gate fixture, not a real external mutation.",
        "Use this exact final answer shape after the browser worker result returns:",
        "## Evidence",
        `- Approval request: ${APPROVAL_FINAL_MARKER}; permission.query blocked browser.form.submit before browser work started.`,
        "- Approval decision/application: permission.result approved the request and permission.applied cached it for the runtime gate.",
        `- Browser fixture evidence: sessions_spawn(browser) verified ${APPROVAL_MARKER} on the local fixture and no external mutation was performed.`,
        "- Residual risk: this validates the approval gate and local fixture path, not a real external submit.",
        "Do not use tables, links, code fences, or bold/italic markup.",
      ].join("\n"),
    };
  }
  if (scenario === "cancel") {
    return {
      scenario,
      title: "Mission route real cancellation E2E",
      finalMarker: CANCEL_FINAL_MARKER,
      evidenceMarkers: [],
      answerTerms: ["cancelled", "sessions_spawn", "residual risk"],
      evidenceLinePatterns: [
        { label: "cancelled tool call evidence", pattern: /^\s*(?:[-*+]\s+)?cancelled tool call\s*:/im },
        { label: "control-path evidence", pattern: /^\s*(?:[-*+]\s+)?control-path evidence\s*:/im },
        { label: "residual risk evidence", pattern: /^\s*(?:[-*+]\s+)?residual risk\s*:/im },
      ],
      allowLabeledEvidenceWithoutBullets: true,
      expectedSpawnCalls: 1,
      expectedSendCalls: 0,
      expectedToolResults: 1,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 1,
      expectedBullets: 3,
      desc: [
        "Run the mission route cancellation E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        `The explore sub-agent task must fetch ${fixture.slowUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
        "Wait for the sessions_spawn tool result before writing the final answer.",
        "If the tool result is cancelled by the operator, stop using tools and write the final answer from the cancellation evidence.",
        "Use this exact final answer shape after cancellation:",
        "## Evidence",
        `- cancelled tool call: ${CANCEL_FINAL_MARKER}; sessions_spawn was cancelled by the operator.`,
        "- control-path evidence: the cancellation came from the tool result and no extra session tools were used.",
        "- residual risk: the slow page may not have returned evidence before cancellation.",
        "Do not use tables, links, code fences, or bold/italic markup.",
        "Do not call sessions_send, sessions_history, or sessions_list.",
      ].join("\n"),
    };
  }
  if (scenario === "followup") {
    return {
      scenario,
      title: "Mission route real follow-up E2E",
      finalMarker: FOLLOWUP_FINAL_MARKER,
      evidenceMarkers: [FIXTURE_MARKER],
      answerTerms: ["sessions_send", "no duplicate session", "residual risk"],
      answerPatterns: [{ label: "same-session continuity", pattern: /same[- ]session|reused session|existing session/i }],
      expectedSpawnCalls: 1,
      expectedSendCalls: 1,
      expectedToolResults: 2,
      expectedSpawnedSessions: 1,
      expectedContinuedSessions: 1,
      minEvidenceEvents: 2,
      expectedBullets: 3,
      desc: [
        "Run phase 1 of the mission route follow-up E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        `The explore sub-agent task must fetch ${fixture.basicUrl}, report the page title, marker ${FIXTURE_MARKER}, and return a reusable session summary.`,
        `Phase 1 final answer must include ${FOLLOWUP_PHASE_MARKER}, ${FIXTURE_MARKER}, the exact session_key returned by sessions_spawn, and the exact words residual risk.`,
        "Use plain Markdown with heading `Evidence` and exactly three bullets: session tool call, fixture marker, residual risk.",
        "Do not use tables, links, code fences, or bold/italic markup.",
        "Do not call sessions_send during phase 1.",
      ].join("\n"),
    };
  }
  if (scenario === "comparison") {
    return {
      scenario,
      title: "Mission route real comparison E2E",
      finalMarker: COMPARISON_FINAL_MARKER,
      evidenceMarkers: [ALPHA_MARKER, BETA_MARKER],
      answerTerms: ["Vendor Alpha", "Vendor Beta", "Source coverage", "residual risk"],
      expectedSpawnCalls: 2,
      expectedSendCalls: 0,
      expectedToolResults: 2,
      expectedSpawnedSessions: 2,
      expectedContinuedSessions: 0,
      minEvidenceEvents: 2,
      expectedBullets: 4,
      desc: [
        "Run the mission route complex comparison E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly twice: one child session for Vendor Alpha and one child session for Vendor Beta.",
        `Vendor Alpha task: fetch ${fixture.alphaUrl}; report title, marker ${ALPHA_MARKER}, pricing, strength, and risk.`,
        `Vendor Beta task: fetch ${fixture.betaUrl}; report title, marker ${BETA_MARKER}, pricing, strength, and risk.`,
        "Do not finalize until both child session tool results have returned and both markers are present in tool evidence.",
        `Final answer must include ${COMPARISON_FINAL_MARKER}, ${ALPHA_MARKER}, and ${BETA_MARKER}.`,
        "Use plain Markdown with heading `Source coverage` and exactly four bullets: Alpha evidence, Beta evidence, comparison conclusion, residual risk.",
        "Do not create separate bullets for markers. Put the source markers in their source bullets and the final success marker in the comparison conclusion bullet.",
        "The residual risk bullet must contain the exact words `residual risk`.",
        "Keep the final answer under 160 words. Do not use tables, links, code fences, or bold/italic markup.",
        "Do not make unsupported claims beyond the two local fixture sources.",
      ].join("\n"),
    };
  }
  return {
    scenario,
    title: "Mission route real tool-use E2E",
    finalMarker: FINAL_MARKER,
    evidenceMarkers: [FIXTURE_MARKER],
    answerTerms: ["sessions_spawn", "residual risk"],
    expectedSpawnCalls: 1,
    expectedSendCalls: 0,
    expectedToolResults: 1,
    expectedSpawnedSessions: 1,
    expectedContinuedSessions: 0,
    minEvidenceEvents: 1,
    expectedBullets: 3,
    desc: [
      "Run the mission route release-gate E2E.",
      "Use the available session tool instead of answering from memory.",
      "Call sessions_spawn with agent_id=explore exactly once.",
      `The explore sub-agent task must fetch ${fixture.basicUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
      `Final answer must include ${FINAL_MARKER} and ${FIXTURE_MARKER}.`,
      "Use plain Markdown with heading `Evidence` and exactly three bullets: session tool call, fixture marker, residual risk.",
      "Do not create a separate bullet for the final success marker. Put it in the session tool call bullet.",
      "The residual risk bullet must contain the exact words `residual risk`.",
      "Keep the final answer under 120 words. Do not use tables, links, code fences, or bold/italic markup.",
      "Do not include the final success marker unless the session tool result contains the fixture marker.",
    ].join("\n"),
  };
}

function buildFollowupInitialSpec(fixture: FixtureServer): ScenarioSpec {
  return {
    scenario: "followup",
    title: "Mission route real follow-up E2E",
    finalMarker: FOLLOWUP_PHASE_MARKER,
    evidenceMarkers: [FIXTURE_MARKER],
    answerTerms: ["sessions_spawn", "session_key", "residual risk"],
    expectedSpawnCalls: 1,
    expectedSendCalls: 0,
    expectedToolResults: 1,
    expectedSpawnedSessions: 1,
    expectedContinuedSessions: 0,
    minEvidenceEvents: 1,
    expectedBullets: 3,
    desc: [
      "Run phase 1 of the mission route follow-up E2E.",
      "Use the available session tool instead of answering from memory.",
      "Call sessions_spawn with agent_id=explore exactly once.",
      `The explore sub-agent task must fetch ${fixture.basicUrl}, report the page title, marker ${FIXTURE_MARKER}, and return a reusable session summary.`,
      `Phase 1 final answer must include ${FOLLOWUP_PHASE_MARKER}, ${FIXTURE_MARKER}, the exact session_key returned by sessions_spawn, and the exact words residual risk.`,
      "Use plain Markdown with heading `Evidence` and exactly three bullets: session tool call, fixture marker, residual risk.",
      "Do not use tables, links, code fences, or bold/italic markup.",
      "Do not call sessions_send during phase 1.",
    ].join("\n"),
  };
}

async function waitForMissionCompletion(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  finalMarker: string;
  timeoutMs: number;
  failFastDoneWithoutMarker?: boolean;
}): Promise<{ mission: Mission; timeline: ActivityEvent[] }> {
  const startedAt = Date.now();
  let latestMission: Mission | null = null;
  let latestTimeline: ActivityEvent[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latestMission = await requestJson<Mission>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
      token: input.token,
    });
    latestTimeline = await requestJson<ActivityEvent[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
      token: input.token,
    });
    if (latestMission.status === "blocked") {
      throw new Error(`mission blocked before completion:\n${summarizeMissionState(latestMission, latestTimeline)}`);
    }
    if (latestMission.status === "done" && findFinalEvent(latestTimeline, input.finalMarker)) {
      return { mission: latestMission, timeline: latestTimeline };
    }
    if (input.failFastDoneWithoutMarker && latestMission.status === "done") {
      await sleep(1_000);
      latestMission = await requestJson<Mission>({
        method: "GET",
        url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
        token: input.token,
      });
      latestTimeline = await requestJson<ActivityEvent[]>({
        method: "GET",
        url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
        token: input.token,
      });
      if (latestMission.status === "done" && findFinalEvent(latestTimeline, input.finalMarker)) {
        return { mission: latestMission, timeline: latestTimeline };
      }
      if (latestMission.status === "done") {
        throw new Error(
          `mission completed without final marker ${input.finalMarker}:\n${summarizeMissionState(latestMission, latestTimeline)}`
        );
      }
    }
    await sleep(1_000);
  }
  throw new Error(
    `mission did not complete within ${input.timeoutMs}ms:\n${summarizeMissionState(latestMission, latestTimeline)}`
  );
}

function assertMissionToolUseTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "mission timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const spawnCallIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "call");
  const sendCallIndexes = findToolPhaseIndexes(timeline, "sessions_send", "call");
  const callIndexes = [...spawnCallIndexes, ...sendCallIndexes].sort((a, b) => a - b);
  const progressIndexes = [
    ...findToolPhaseIndexes(timeline, "sessions_spawn", "progress"),
    ...findToolPhaseIndexes(timeline, "sessions_send", "progress"),
  ].sort((a, b) => a - b);
  const spawnResultIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "result");
  const sendResultIndexes = findToolPhaseIndexes(timeline, "sessions_send", "result");
  const resultIndexes = [...spawnResultIndexes, ...sendResultIndexes].sort((a, b) => a - b);
  const callIndex = callIndexes[0] ?? -1;
  const resultIndex = resultIndexes.at(-1) ?? -1;
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(planIndex >= 0, "mission timeline must include the user plan event");
  assert.ok(callIndex > planIndex, "session tool call must appear after the user plan");
  assert.equal(
    spawnCallIndexes.length,
    spec.expectedSpawnCalls,
    `${spec.scenario} expected exactly ${spec.expectedSpawnCalls} sessions_spawn calls`
  );
  assert.equal(
    sendCallIndexes.length,
    spec.expectedSendCalls,
    `${spec.scenario} expected exactly ${spec.expectedSendCalls} sessions_send calls`
  );
  assert.equal(
    callIndexes.length,
    spec.expectedToolResults,
    `${spec.scenario} expected exactly ${spec.expectedToolResults} session tool calls`
  );
  assert.equal(
    resultIndexes.length,
    spec.expectedToolResults,
    `${spec.scenario} expected exactly ${spec.expectedToolResults} session tool results`
  );
  for (const progressIndex of progressIndexes) {
    assert.ok(progressIndex > callIndex, "sessions_spawn progress must appear after the first tool call");
  }
  assert.ok(resultIndex > callIndex, "session tool result must appear after the tool call");
  assert.ok(finalIndex > resultIndex, "final answer must appear after the session tool result");
  const resultEvidence = resultIndexes
    .map((index) => timeline[index]!)
    .map((event) => String(event.runtime?.["resultContent"] ?? event.text))
    .join("\n");
  for (const marker of spec.evidenceMarkers) {
    assert.match(resultEvidence, new RegExp(marker), `sessions_spawn results must include fixture evidence ${marker}`);
  }
  const danger = timeline.find((event) => event.emph === "danger" || event.kind === "recovery");
  assert.equal(danger, undefined, `mission E2E timeline contains recovery/danger event: ${danger?.text ?? ""}`);
}

function extractFirstSessionKey(timeline: ActivityEvent[]): string | null {
  for (const event of timeline) {
    if (event.runtime?.["toolName"] !== "sessions_spawn" || event.runtime?.["toolPhase"] !== "result") {
      continue;
    }
    const content = String(event.runtime?.["resultContent"] ?? event.text);
    const match = content.match(/"session_key"\s*:\s*"([^"]+)"/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function assertFollowupReusedSession(timeline: ActivityEvent[], expectedSessionKey: string): void {
  const sendCalls = timeline.filter(
    (event) => event.runtime?.["toolName"] === "sessions_send" && event.runtime?.["toolPhase"] === "call"
  );
  assert.equal(sendCalls.length, 1, "follow-up E2E must call sessions_send exactly once");
  const callInput = sendCalls[0]?.runtime?.["callInput"];
  assert.equal(typeof callInput, "string", "sessions_send call must persist structured callInput");
  const parsed = JSON.parse(callInput as string) as { session_key?: string };
  assert.equal(parsed.session_key, expectedSessionKey, "sessions_send must reuse the phase-one session_key");
}

async function waitForToolCallEvent(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  toolName: "sessions_spawn" | "sessions_send";
  timeoutMs: number;
}): Promise<{ messageId: string; toolCallId: string; timeline: ActivityEvent[] }> {
  const startedAt = Date.now();
  let latestTimeline: ActivityEvent[] = [];
  while (Date.now() - startedAt < input.timeoutMs) {
    latestTimeline = await requestJson<ActivityEvent[]>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
      token: input.token,
    });
    const event = latestTimeline.find(
      (item) => item.runtime?.["toolName"] === input.toolName && item.runtime?.["toolPhase"] === "call"
    );
    const messageId = event?.runtime?.["messageId"];
    const toolCallId = event?.runtime?.["toolCallId"];
    if (typeof messageId === "string" && messageId.length > 0 && typeof toolCallId === "string" && toolCallId.length > 0) {
      return { messageId, toolCallId, timeline: latestTimeline };
    }
    await sleep(500);
  }
  throw new Error(`mission did not emit ${input.toolName} call before cancellation:\n${summarizeMissionState(null, latestTimeline)}`);
}

async function waitForApprovalRequest(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  action: string;
  timeoutMs: number;
}): Promise<ApprovalRecord> {
  const startedAt = Date.now();
  let latestApprovals: ApprovalRecord[] = [];
  let latestMission: Mission | null = null;
  while (Date.now() - startedAt < input.timeoutMs) {
    latestApprovals = await requestJson<ApprovalRecord[]>({
      method: "GET",
      url: `${input.baseUrl}/approvals`,
      token: input.token,
    });
    const approval = latestApprovals.find(
      (item) => item.missionId === input.missionId && item.action === input.action && item.decision == null
    );
    latestMission = await requestJson<Mission>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}`,
      token: input.token,
    });
    if (approval) {
      assert.equal(latestMission.status, "needs_approval", "mission must expose needs_approval while approval is pending");
      return approval;
    }
    if (latestMission.status === "blocked" || latestMission.status === "done") {
      const timeline = await requestJson<ActivityEvent[]>({
        method: "GET",
        url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/timeline?limit=200`,
        token: input.token,
      });
      throw new Error(
        `mission reached ${latestMission.status} before approval ${input.action} was requested:\n${summarizeMissionState(latestMission, timeline)}`
      );
    }
    await sleep(500);
  }
  throw new Error(
    `mission did not request approval ${input.action} within ${input.timeoutMs}ms: ${JSON.stringify({
      mission: latestMission,
      approvals: latestApprovals,
    })}`
  );
}

function assertMissionCancelTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "mission cancellation timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const callIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "call");
  const resultIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "result");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(planIndex >= 0, "mission cancellation timeline must include the user plan event");
  assert.equal(callIndexes.length, 1, "cancel E2E expected exactly one sessions_spawn call");
  assert.equal(resultIndexes.length, 1, "cancel E2E expected exactly one sessions_spawn result");
  assert.ok(callIndexes[0]! > planIndex, "sessions_spawn call must appear after the user plan");
  assert.ok(resultIndexes[0]! > callIndexes[0]!, "cancelled sessions_spawn result must appear after the call");
  assert.ok(finalIndex > resultIndexes[0]!, "final answer must appear after the cancelled sessions_spawn result");
  const result = timeline[resultIndexes[0]!];
  const resultBlob = [result?.text ?? "", String(result?.runtime?.["resultContent"] ?? "")].join("\n");
  assert.match(resultBlob, /\bcancel(?:led|ed)?\b/i, "cancelled sessions_spawn result must name cancellation");
  assert.equal(result?.emph, "danger", "cancelled sessions_spawn result should be marked as an attention event");
}

function assertMissionApprovalTimeline(timeline: ActivityEvent[], spec: ScenarioSpec, approvalId: string): void {
  const approvalEvents = timeline.filter((event) => event.kind === "approval" || event.approvalId === approvalId);
  assert.ok(approvalEvents.length >= 2, "approval E2E must record request and decision/application events");
  const eventTypes = timeline.map((event) => String(event.runtime?.["eventType"] ?? "")).filter(Boolean);
  assert.ok(eventTypes.includes("permission.query"), "approval E2E timeline must include permission.query");
  assert.ok(eventTypes.includes("permission.result"), "approval E2E timeline must include permission.result");
  assert.ok(eventTypes.includes("permission.applied"), "approval E2E timeline must include permission.applied");

  const callIndex = findToolPhaseIndexes(timeline, "sessions_spawn", "call")[0] ?? -1;
  const resultIndex = findToolPhaseIndexes(timeline, "sessions_spawn", "result")[0] ?? -1;
  const queryIndex = timeline.findIndex((event) => event.runtime?.["eventType"] === "permission.query");
  const decisionIndex = timeline.findIndex((event) => event.runtime?.["eventType"] === "permission.result");
  const appliedIndex = timeline.findIndex((event) => event.runtime?.["eventType"] === "permission.applied");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(queryIndex > callIndex, "permission.query must occur after the sessions_spawn call");
  assert.ok(decisionIndex > queryIndex, "permission.result must occur after permission.query");
  assert.ok(appliedIndex > decisionIndex, "permission.applied must occur after permission.result");
  assert.ok(appliedIndex > queryIndex, "permission.applied must occur after permission.query");
  assert.ok(resultIndex > appliedIndex, "browser worker result must occur after permission.applied");
  assert.ok(finalIndex > resultIndex, "final answer must appear after the approved browser result");
}

function assertMissionTimeoutTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "mission timeout timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const spawnCallIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "call");
  const sendCallIndexes = findToolPhaseIndexes(timeline, "sessions_send", "call");
  const resultIndexes = findToolPhaseIndexes(timeline, "sessions_spawn", "result");
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(planIndex >= 0, "mission timeout timeline must include the user plan event");
  assert.equal(spawnCallIndexes.length, 1, "timeout E2E expected exactly one sessions_spawn call");
  assert.equal(sendCallIndexes.length, 0, "timeout E2E must not call sessions_send after timeout");
  assert.equal(resultIndexes.length, 1, "timeout E2E expected exactly one sessions_spawn result");
  assert.ok(spawnCallIndexes[0]! > planIndex, "sessions_spawn call must appear after the user plan");
  assert.ok(resultIndexes[0]! > spawnCallIndexes[0]!, "timeout sessions_spawn result must appear after the call");
  assert.ok(finalIndex > resultIndexes[0]!, "final answer must appear after the timeout result");

  const callInput = timeline[spawnCallIndexes[0]!]!.runtime?.["callInput"];
  assert.equal(typeof callInput, "string", "timeout sessions_spawn call must persist structured callInput");
  const parsedCall = JSON.parse(callInput as string) as { timeout_seconds?: number; agent_id?: string };
  assert.equal(parsedCall.agent_id, "explore", "timeout E2E must use the explore child session");
  assert.equal(parsedCall.timeout_seconds, 0.001, "timeout E2E must request the bounded timeout_seconds value");

  const result = timeline[resultIndexes[0]!];
  const resultBlob = [result?.text ?? "", String(result?.runtime?.["resultContent"] ?? "")].join("\n");
  assert.match(resultBlob, /\btimeout|timed out\b/i, "timeout sessions_spawn result must name the timeout");
  assert.match(resultBlob, /"status"\s*:\s*"timeout"/, "timeout sessions_spawn result must use session status=timeout");
  assert.equal(result?.emph, "danger", "timeout sessions_spawn result should be marked as an attention event");
}

async function assertWorkerSessionCancelled(input: {
  baseUrl: string;
  token: string;
  threadId: string;
  workerRunKey: string;
}): Promise<void> {
  const sessions = await requestJson<WorkerSessionRecord[]>({
    method: "GET",
    url: `${input.baseUrl}/runtime-worker-sessions?threadId=${encodeURIComponent(input.threadId)}&limit=20`,
    token: input.token,
  });
  const session = sessions.find((item) => item.workerRunKey === input.workerRunKey);
  assert.ok(session, `cancel E2E must expose worker session ${input.workerRunKey}`);
  assert.equal(session.state.status, "cancelled", "cancel E2E worker session must end as cancelled");
}

async function assertWorkerSessionResumableAfterTimeout(input: {
  baseUrl: string;
  token: string;
  threadId: string;
  workerRunKey: string;
}): Promise<void> {
  const sessions = await requestJson<WorkerSessionRecord[]>({
    method: "GET",
    url: `${input.baseUrl}/runtime-worker-sessions?threadId=${encodeURIComponent(input.threadId)}&limit=20`,
    token: input.token,
  });
  const session = sessions.find((item) => item.workerRunKey === input.workerRunKey);
  assert.ok(session, `timeout E2E must expose worker session ${input.workerRunKey}`);
  assert.equal(session.state.status, "resumable", "timeout E2E worker session must remain resumable");
}

async function waitForMissionMetricsSettled(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  timeoutMs: number;
}): Promise<MissionObservabilitySnapshot> {
  const startedAt = Date.now();
  let latest: MissionObservabilitySnapshot | null = null;
  while (Date.now() - startedAt < input.timeoutMs) {
    latest = await requestJson<MissionObservabilitySnapshot>({
      method: "GET",
      url: `${input.baseUrl}/missions/${encodeURIComponent(input.missionId)}/metrics`,
      token: input.token,
    });
    if (
      latest.status === "done" &&
      latest.liveness.active === 0 &&
      latest.liveness.waiting === 0 &&
      latest.liveness.stale === 0
    ) {
      return latest;
    }
    await sleep(500);
  }
  throw new Error(`mission metrics did not settle after terminal completion: ${JSON.stringify(latest)}`);
}

function findToolPhaseIndexes(
  timeline: ActivityEvent[],
  toolName: "sessions_spawn" | "sessions_send",
  phase: "call" | "progress" | "result"
): number[] {
  return timeline.flatMap((event, index) =>
    event.runtime?.["toolName"] === toolName && event.runtime?.["toolPhase"] === phase ? [index] : []
  );
}

function assertMissionMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assert.equal(metrics.status, "done", "mission metrics must reflect the completed mission status");
  assert.equal(metrics.tool.requested, spec.expectedToolResults, "mission metrics must match requested tool calls");
  assert.equal(metrics.tool.results, spec.expectedToolResults, "mission metrics must match tool results");
  assert.equal(metrics.tool.failed, 0, "mission metrics must not report failed tool results");
  assert.equal(metrics.tool.timeouts, 0, "mission metrics must not report timed-out tools");
  assert.equal(metrics.sessions.spawned, spec.expectedSpawnedSessions, "mission metrics must match spawned sub-agent sessions");
  assert.equal(metrics.sessions.continued, spec.expectedContinuedSessions, "mission metrics must match continued sub-agent sessions");
  assert.equal(metrics.recovery.events, 0, "mission metrics must not report recovery events");
  assert.equal(metrics.liveness.active, 0, "completed mission must not retain active runtime subjects");
  assert.equal(metrics.liveness.waiting, 0, "completed mission must not retain waiting runtime subjects");
  assert.equal(metrics.liveness.stale, 0, "mission metrics must not report stale runtime subjects");
  assert.equal(metrics.qualityGate.status, "passed", "mission metrics quality gate must pass");
  assert.ok(metrics.qualityGate.evidenceEvents >= spec.minEvidenceEvents, "mission metrics must count evidence-bearing events");
}

function assertMissionCancelMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assert.equal(metrics.status, "done", "cancel E2E mission should still complete with a final answer");
  assert.equal(metrics.tool.requested, spec.expectedToolResults, "cancel E2E must count the requested tool call");
  assert.equal(metrics.tool.results, spec.expectedToolResults, "cancel E2E must count the cancelled tool result");
  assert.equal(metrics.tool.cancelled, 1, "cancel E2E must report one cancelled tool");
  assert.equal(metrics.tool.timeouts, 0, "cancel E2E cancellation must not be reported as a timeout");
  assert.equal(metrics.sessions.spawned, spec.expectedSpawnedSessions, "cancel E2E must count the spawned sub-agent session");
  assert.equal(metrics.sessions.continued, 0, "cancel E2E must not continue a sub-agent session");
  assert.equal(metrics.liveness.active, 0, "cancel E2E must not retain active runtime subjects");
  assert.equal(metrics.liveness.waiting, 0, "cancel E2E must not retain waiting runtime subjects");
  assert.equal(metrics.liveness.stale, 0, "cancel E2E must not report stale runtime subjects");
  assert.equal(metrics.qualityGate.status, "blocked", "cancel E2E should keep failed-tool attention visible");
  assert.ok(metrics.qualityGate.evidenceEvents >= spec.minEvidenceEvents, "cancel E2E must count the cancelled tool result as evidence");
}

function assertMissionTimeoutMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assert.equal(metrics.status, "done", "timeout E2E mission should complete with a bounded final answer");
  assert.equal(metrics.tool.requested, spec.expectedToolResults, "timeout E2E must count the requested tool call");
  assert.equal(metrics.tool.results, spec.expectedToolResults, "timeout E2E must count the timeout tool result");
  assert.equal(metrics.tool.failed, 1, "timeout E2E must report the timed-out tool as failed attention");
  assert.equal(metrics.tool.cancelled, 0, "timeout E2E timeout must not be reported as cancellation");
  assert.equal(metrics.tool.timeouts, 1, "timeout E2E must report one timed-out tool");
  assert.equal(metrics.sessions.spawned, spec.expectedSpawnedSessions, "timeout E2E must count the spawned sub-agent session");
  assert.equal(metrics.sessions.continued, 0, "timeout E2E must not continue a sub-agent session");
  assert.equal(metrics.liveness.active, 0, "timeout E2E must not retain active runtime subjects");
  assert.equal(metrics.liveness.waiting, 0, "timeout E2E must not retain waiting runtime subjects");
  assert.equal(metrics.liveness.stale, 0, "timeout E2E must not report stale runtime subjects");
  assert.equal(metrics.qualityGate.status, "blocked", "timeout E2E should keep failed-tool attention visible");
  assert.ok(metrics.qualityGate.evidenceEvents >= spec.minEvidenceEvents, "timeout E2E must count the timeout tool result as evidence");
}

function assertMissionApprovalMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assertMissionMetrics(metrics, spec);
  assert.equal(metrics.approvals.requested, 1, "approval E2E must count one requested approval");
  assert.equal(metrics.approvals.decided, 1, "approval E2E must count one approval decision");
  assert.equal(metrics.approvals.applied, 1, "approval E2E must count one applied approval");
}

function findFinalEvent(timeline: ActivityEvent[], finalMarker: string): ActivityEvent | null {
  return timeline.find((event) => event.kind === "thought" && event.text.includes(finalMarker)) ?? null;
}

function evaluateFinalQuality(content: string, spec: ScenarioSpec): { bullets: number; failures: string[] } {
  const failures: string[] = [];
  const bytes = Buffer.byteLength(content, "utf8");
  const bullets = (content.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  const requiredEvidenceLineCount = spec.evidenceLinePatterns?.length ?? 0;
  const hasLabeledEvidenceShape =
    spec.allowLabeledEvidenceWithoutBullets === true &&
    requiredEvidenceLineCount === spec.expectedBullets &&
    spec.evidenceLinePatterns?.every((item) => item.pattern.test(content)) === true;
  if (bytes < 180) failures.push("final answer is too short");
  if (bullets !== spec.expectedBullets && !(bullets === 0 && hasLabeledEvidenceShape)) {
    failures.push(`final answer must include exactly ${spec.expectedBullets} Markdown bullets`);
  }
  if (!content.includes(spec.finalMarker)) failures.push(`missing ${spec.finalMarker}`);
  for (const marker of spec.evidenceMarkers) {
    if (!content.includes(marker)) failures.push(`missing ${marker}`);
  }
  for (const term of spec.answerTerms) {
    if (!content.toLowerCase().includes(term.toLowerCase())) failures.push(`missing ${term}`);
  }
  for (const item of spec.answerPatterns ?? []) {
    if (!item.pattern.test(content)) failures.push(`missing ${item.label}`);
  }
  for (const item of spec.evidenceLinePatterns ?? []) {
    if (!item.pattern.test(content)) failures.push(`missing ${item.label}`);
  }
  if (/\b(assume|assumes|assuming|assumed|estimate|estimated|estimates|estimating|guess|guessed|guesses|guessing|probably|probable|maybe|perhaps|approximately|approximate)\b/i.test(content)) {
    failures.push("final answer contains unsupported/hedged claim language");
  }
  return { bullets, failures };
}

function startDaemon(input: {
  runtimeRoot: string;
  port: number;
  token: string;
  modelCatalogPath: string;
}): { child: ChildProcessWithoutNullStreams; output: () => string } {
  let output = "";
  const child = spawn("npm", ["run", "daemon"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TURNKEYAI_HOME: input.runtimeRoot,
      TURNKEYAI_DATA_DIR: path.join(input.runtimeRoot, "data"),
      TURNKEYAI_DAEMON_PORT: String(input.port),
      TURNKEYAI_DAEMON_TOKEN: input.token,
      TURNKEYAI_MODEL_CATALOG: input.modelCatalogPath,
      TURNKEYAI_BROWSER_TRANSPORT: process.env.TURNKEYAI_BROWSER_TRANSPORT?.trim() || "local",
      TURNKEYAI_E2E_ALLOW_LOOPBACK_EXPLORE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > 16_000) {
      output = output.slice(-16_000);
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, output: () => output };
}

async function waitForDaemonHealth(input: {
  baseUrl: string;
  daemon: { child: ChildProcessWithoutNullStreams; output: () => string };
  timeoutMs: number;
}): Promise<void> {
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  input.daemon.child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    if (exited) {
      throw new Error(`daemon exited before health check: ${JSON.stringify(exited)}\n${input.daemon.output()}`);
    }
    try {
      const response = await fetch(`${input.baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`daemon did not become healthy within ${input.timeoutMs}ms\n${input.daemon.output()}`);
}

async function requestJson<T>(input: {
  method: "GET" | "POST";
  url: string;
  token: string;
  body?: unknown;
}): Promise<T> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`${input.method} ${input.url} returned ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address?.port) {
        resolve(address.port);
        return;
      }
      reject(new Error("failed to allocate a local port"));
    });
  });
  await closeServer(server);
  return port;
}

async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || !address?.port) {
    throw new Error("fixture server did not report a port");
  }
  return address.port;
}

async function closeServer(server: Server | net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function stopDaemon(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function summarizeMissionState(mission: Mission | null, timeline: ActivityEvent[]): string {
  const events = timeline
    .slice(-12)
    .map((event) => {
      const phase = event.runtime?.["toolPhase"] ? ` ${event.runtime["toolPhase"]}` : "";
      const tool = event.runtime?.["toolName"] ? ` ${event.runtime["toolName"]}` : "";
      return `- ${event.kind}${tool}${phase}: ${event.text.slice(0, 220).replace(/\s+/g, " ")}`;
    })
    .join("\n");
  return [
    `mission=${mission ? JSON.stringify(mission) : "null"}`,
    `timeline-events=${timeline.length}`,
    events,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(parseOptions(process.argv.slice(2)));
}

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

type MissionE2eScenario = "basic" | "comparison";

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
}

interface MissionObservabilitySnapshot {
  status: string;
  tool: {
    requested: number;
    results: number;
    failed: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
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

interface FixtureServer {
  server: Server;
  basicUrl: string;
  alphaUrl: string;
  betaUrl: string;
}

interface ScenarioSpec {
  scenario: MissionE2eScenario;
  title: string;
  desc: string;
  finalMarker: string;
  evidenceMarkers: string[];
  answerTerms: string[];
  expectedToolResults: number;
  expectedSpawnedSessions: number;
  minEvidenceEvents: number;
  expectedBullets: number;
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
  if (value === "basic" || value === "comparison") return value;
  throw new Error(`${argName} must be basic or comparison`);
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
      results.push(
        await runMissionScenario({
          baseUrl,
          token,
          fixture,
          scenario,
          timeoutMs: options.scenarioTimeoutMs,
        })
      );
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
}): Promise<{
  scenario: MissionE2eScenario;
  mission: Mission;
  timeline: ActivityEvent[];
  metrics: MissionObservabilitySnapshot;
  final: ActivityEvent;
  quality: ReturnType<typeof evaluateFinalQuality>;
}> {
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

function printScenarioResult(result: {
  scenario: MissionE2eScenario;
  mission: Mission;
  timeline: ActivityEvent[];
  metrics: MissionObservabilitySnapshot;
  final: ActivityEvent;
  quality: ReturnType<typeof evaluateFinalQuality>;
}): void {
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
  if (scenario === "comparison") {
    return {
      scenario,
      title: "Mission route real comparison E2E",
      finalMarker: COMPARISON_FINAL_MARKER,
      evidenceMarkers: [ALPHA_MARKER, BETA_MARKER],
      answerTerms: ["Vendor Alpha", "Vendor Beta", "Source coverage", "residual risk"],
      expectedToolResults: 2,
      expectedSpawnedSessions: 2,
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
    expectedToolResults: 1,
    expectedSpawnedSessions: 1,
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

async function waitForMissionCompletion(input: {
  baseUrl: string;
  token: string;
  missionId: string;
  finalMarker: string;
  timeoutMs: number;
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
    await sleep(1_000);
  }
  throw new Error(
    `mission did not complete within ${input.timeoutMs}ms:\n${summarizeMissionState(latestMission, latestTimeline)}`
  );
}

function assertMissionToolUseTimeline(timeline: ActivityEvent[], spec: ScenarioSpec): void {
  assert.ok(timeline.length > 0, "mission timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const callIndexes = findToolPhaseIndexes(timeline, "call");
  const progressIndexes = findToolPhaseIndexes(timeline, "progress");
  const resultIndexes = findToolPhaseIndexes(timeline, "result");
  const callIndex = callIndexes[0] ?? -1;
  const resultIndex = resultIndexes.at(-1) ?? -1;
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(spec.finalMarker));
  assert.ok(planIndex >= 0, "mission timeline must include the user plan event");
  assert.ok(callIndex > planIndex, "sessions_spawn call must appear after the user plan");
  assert.equal(
    callIndexes.length,
    spec.expectedToolResults,
    `${spec.scenario} expected exactly ${spec.expectedToolResults} sessions_spawn calls`
  );
  assert.equal(
    resultIndexes.length,
    spec.expectedToolResults,
    `${spec.scenario} expected exactly ${spec.expectedToolResults} sessions_spawn results`
  );
  for (const progressIndex of progressIndexes) {
    assert.ok(progressIndex > callIndex, "sessions_spawn progress must appear after the first tool call");
  }
  assert.ok(resultIndex > callIndex, "sessions_spawn result must appear after the tool call");
  assert.ok(finalIndex > resultIndex, "final answer must appear after the sessions_spawn result");
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

function findToolPhaseIndexes(timeline: ActivityEvent[], phase: "call" | "progress" | "result"): number[] {
  return timeline.flatMap((event, index) =>
    event.runtime?.["toolName"] === "sessions_spawn" && event.runtime?.["toolPhase"] === phase ? [index] : []
  );
}

function assertMissionMetrics(metrics: MissionObservabilitySnapshot, spec: ScenarioSpec): void {
  assert.equal(metrics.status, "done", "mission metrics must reflect the completed mission status");
  assert.equal(metrics.tool.requested, spec.expectedToolResults, "mission metrics must match requested tool calls");
  assert.equal(metrics.tool.results, spec.expectedToolResults, "mission metrics must match tool results");
  assert.equal(metrics.tool.failed, 0, "mission metrics must not report failed tool results");
  assert.equal(metrics.tool.timeouts, 0, "mission metrics must not report timed-out tools");
  assert.equal(metrics.sessions.spawned, spec.expectedSpawnedSessions, "mission metrics must match spawned sub-agent sessions");
  assert.equal(metrics.recovery.events, 0, "mission metrics must not report recovery events");
  assert.equal(metrics.liveness.active, 0, "completed mission must not retain active runtime subjects");
  assert.equal(metrics.liveness.waiting, 0, "completed mission must not retain waiting runtime subjects");
  assert.equal(metrics.liveness.stale, 0, "mission metrics must not report stale runtime subjects");
  assert.equal(metrics.qualityGate.status, "passed", "mission metrics quality gate must pass");
  assert.ok(metrics.qualityGate.evidenceEvents >= spec.minEvidenceEvents, "mission metrics must count evidence-bearing events");
}

function findFinalEvent(timeline: ActivityEvent[], finalMarker: string): ActivityEvent | null {
  return timeline.find((event) => event.kind === "thought" && event.text.includes(finalMarker)) ?? null;
}

function evaluateFinalQuality(content: string, spec: ScenarioSpec): { bullets: number; failures: string[] } {
  const failures: string[] = [];
  const bytes = Buffer.byteLength(content, "utf8");
  const bullets = (content.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  if (bytes < 180) failures.push("final answer is too short");
  if (bullets !== spec.expectedBullets) {
    failures.push(`final answer must include exactly ${spec.expectedBullets} Markdown bullets`);
  }
  if (!content.includes(spec.finalMarker)) failures.push(`missing ${spec.finalMarker}`);
  for (const marker of spec.evidenceMarkers) {
    if (!content.includes(marker)) failures.push(`missing ${marker}`);
  }
  for (const term of spec.answerTerms) {
    if (!content.toLowerCase().includes(term.toLowerCase())) failures.push(`missing ${term}`);
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

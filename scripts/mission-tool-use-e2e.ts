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
}

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

function parseOptions(args: string[]): MissionToolUseE2eOptions {
  const options: MissionToolUseE2eOptions = {
    scenarioTimeoutMs: 180_000,
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
    const mission = await createMission({
      baseUrl,
      token,
      fixtureUrl: fixture.url,
    });
    assert.ok(mission.threadId, "mission route must create a linked team thread");
    const result = await waitForMissionCompletion({
      baseUrl,
      token,
      missionId: mission.id,
      timeoutMs: options.scenarioTimeoutMs,
    });
    assertMissionToolUseTimeline(result.timeline);
    const metrics = await requestJson<MissionObservabilitySnapshot>({
      method: "GET",
      url: `${baseUrl}/missions/${encodeURIComponent(mission.id)}/metrics`,
      token,
    });
    assertMissionMetrics(metrics);
    const final = findFinalEvent(result.timeline);
    assert.ok(final, "mission timeline must include a final assistant answer");
    const quality = evaluateFinalQuality(final.text);
    assert.deepEqual(quality.failures, [], `mission final answer quality failures: ${quality.failures.join("; ")}`);
    console.log("mission tool-use real llm e2e passed");
    console.log(`mission-id: ${result.mission.id}`);
    console.log(`mission-status: ${result.mission.status}`);
    console.log(`mission-thread-id: ${result.mission.threadId ?? ""}`);
    console.log(`mission-tool-events: ${result.timeline.filter((event) => event.kind === "tool").length}`);
    console.log(`mission-quality-gate: ${metrics.qualityGate.status}`);
    console.log(`mission-metrics-tools: ${metrics.tool.requested}/${metrics.tool.results}`);
    console.log(`mission-metrics-sessions: ${metrics.sessions.spawned}/${metrics.sessions.continued}`);
    console.log(`mission-metrics-liveness: ${metrics.liveness.active}/${metrics.liveness.waiting}/${metrics.liveness.stale}`);
    console.log(`mission-metrics-evidence: ${metrics.qualityGate.evidenceEvents}`);
    console.log(`mission-final-bytes: ${Buffer.byteLength(final.text, "utf8")}`);
    console.log(`mission-final-bullets: ${quality.bullets}`);
  } finally {
    await stopDaemon(daemon.child);
    await closeServer(fixture.server);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
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

async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url !== "/fixture") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
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
  });
  const port = await listenOnRandomPort(server);
  return { server, url: `http://127.0.0.1:${port}/fixture` };
}

async function createMission(input: {
  baseUrl: string;
  token: string;
  fixtureUrl: string;
}): Promise<Mission> {
  return requestJson<Mission>({
    method: "POST",
    url: `${input.baseUrl}/missions`,
    token: input.token,
    body: {
      title: "Mission route real tool-use E2E",
      mode: "research",
      desc: [
        "Run the mission route release-gate E2E.",
        "Use the available session tool instead of answering from memory.",
        "Call sessions_spawn with agent_id=explore exactly once.",
        `The explore sub-agent task must fetch ${input.fixtureUrl} and report the page title plus marker ${FIXTURE_MARKER}.`,
        `Final answer must include ${FINAL_MARKER} and ${FIXTURE_MARKER}.`,
        "Use Markdown with heading `Evidence` and at least three bullets: session tool call, fixture marker, residual risk.",
        "Do not include the final success marker unless the session tool result contains the fixture marker.",
      ].join("\n"),
      owner: "e2e",
      ownerLabel: "E2E",
    },
  });
}

async function waitForMissionCompletion(input: {
  baseUrl: string;
  token: string;
  missionId: string;
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
    if (latestMission.status === "done" && findFinalEvent(latestTimeline)) {
      return { mission: latestMission, timeline: latestTimeline };
    }
    await sleep(1_000);
  }
  throw new Error(
    `mission did not complete within ${input.timeoutMs}ms:\n${summarizeMissionState(latestMission, latestTimeline)}`
  );
}

function assertMissionToolUseTimeline(timeline: ActivityEvent[]): void {
  assert.ok(timeline.length > 0, "mission timeline must not be empty");
  const planIndex = timeline.findIndex((event) => event.kind === "plan");
  const callIndex = timeline.findIndex(
    (event) => event.runtime?.["toolName"] === "sessions_spawn" && event.runtime?.["toolPhase"] === "call"
  );
  const progressIndex = timeline.findIndex(
    (event) => event.runtime?.["toolName"] === "sessions_spawn" && event.runtime?.["toolPhase"] === "progress"
  );
  const resultIndex = timeline.findIndex(
    (event) => event.runtime?.["toolName"] === "sessions_spawn" && event.runtime?.["toolPhase"] === "result"
  );
  const finalIndex = timeline.findIndex((event) => event.kind === "thought" && event.text.includes(FINAL_MARKER));
  assert.ok(planIndex >= 0, "mission timeline must include the user plan event");
  assert.ok(callIndex > planIndex, "sessions_spawn call must appear after the user plan");
  if (progressIndex >= 0) {
    assert.ok(progressIndex > callIndex, "sessions_spawn progress must appear after the tool call");
  }
  assert.ok(resultIndex > callIndex, "sessions_spawn result must appear after the tool call");
  assert.ok(finalIndex > resultIndex, "final answer must appear after the sessions_spawn result");
  const result = timeline[resultIndex]!;
  assert.match(
    String(result.runtime?.["resultContent"] ?? result.text),
    new RegExp(FIXTURE_MARKER),
    "sessions_spawn result must include fixture evidence"
  );
  const danger = timeline.find((event) => event.emph === "danger" || event.kind === "recovery");
  assert.equal(danger, undefined, `mission E2E timeline contains recovery/danger event: ${danger?.text ?? ""}`);
}

function assertMissionMetrics(metrics: MissionObservabilitySnapshot): void {
  assert.equal(metrics.status, "done", "mission metrics must reflect the completed mission status");
  assert.ok(metrics.tool.requested >= 1, "mission metrics must count requested tool calls");
  assert.ok(metrics.tool.results >= 1, "mission metrics must count tool results");
  assert.equal(metrics.tool.failed, 0, "mission metrics must not report failed tool results");
  assert.equal(metrics.tool.timeouts, 0, "mission metrics must not report timed-out tools");
  assert.ok(metrics.sessions.spawned >= 1, "mission metrics must count spawned sub-agent sessions");
  assert.equal(metrics.recovery.events, 0, "mission metrics must not report recovery events");
  assert.equal(metrics.liveness.stale, 0, "mission metrics must not report stale runtime subjects");
  assert.equal(metrics.qualityGate.status, "passed", "mission metrics quality gate must pass");
  assert.ok(metrics.qualityGate.evidenceEvents >= 1, "mission metrics must count evidence-bearing events");
}

function findFinalEvent(timeline: ActivityEvent[]): ActivityEvent | null {
  return timeline.find((event) => event.kind === "thought" && event.text.includes(FINAL_MARKER)) ?? null;
}

function evaluateFinalQuality(content: string): { bullets: number; failures: string[] } {
  const failures: string[] = [];
  const bytes = Buffer.byteLength(content, "utf8");
  const bullets = (content.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  if (bytes < 180) failures.push("final answer is too short");
  if (bullets < 3) failures.push("final answer must include at least three Markdown bullets");
  if (!content.includes(FINAL_MARKER)) failures.push(`missing ${FINAL_MARKER}`);
  if (!content.includes(FIXTURE_MARKER)) failures.push(`missing ${FIXTURE_MARKER}`);
  if (!/\bsessions_spawn\b/i.test(content)) failures.push("missing sessions_spawn evidence");
  if (!/\bresidual risk\b/i.test(content)) failures.push("missing residual risk");
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

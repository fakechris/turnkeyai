import { access, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createServer } from "node:http";

import {
  assertBrowserSmokeActionParity,
  buildDownloadUploadFixtureMarkup,
  buildDownloadUploadFixtureScript,
  buildRichInteractionFixtureMarkup,
  buildRichInteractionFixtureScript,
  countUploadTraceEntries,
  isUploadedExportTitle,
  resolveDownloadSmokeArtifact,
  verifyBrowserSmokeMultiTarget,
  writeExportCsvResponse,
  type BrowserSmokeResponse,
} from "./lib/browser-smoke-shared";

const args = process.argv.slice(2);
let daemonUrl = process.env.TURNKEYAI_DAEMON_URL ?? "";
let cdpEndpoint = process.env.TURNKEYAI_BROWSER_CDP_ENDPOINT ?? "";
let startUrl = "";
let chromePath: string | null = null;
let profileDir: string | null = null;
let timeoutMs = 20_000;
let keepOpen = false;
let skipLaunch = false;
let daemonPort: number | null = null;
let cdpPort: number | null = null;
let verifyReconnect = false;
let verifyWorkflowLog = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--daemon-url") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --daemon-url");
    }
    daemonUrl = value;
    index += 1;
    continue;
  }
  if (arg === "--cdp-endpoint") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --cdp-endpoint");
    }
    cdpEndpoint = value;
    index += 1;
    continue;
  }
  if (arg === "--url") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --url");
    }
    startUrl = value;
    index += 1;
    continue;
  }
  if (arg === "--daemon-port") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --daemon-port");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("--daemon-port must be a positive integer");
    }
    daemonPort = parsed;
    index += 1;
    continue;
  }
  if (arg === "--cdp-port") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --cdp-port");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("--cdp-port must be a positive integer");
    }
    cdpPort = parsed;
    index += 1;
    continue;
  }
  if (arg === "--chrome-path") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --chrome-path");
    }
    chromePath = value;
    index += 1;
    continue;
  }
  if (arg === "--profile-dir") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --profile-dir");
    }
    profileDir = path.resolve(process.cwd(), value);
    index += 1;
    continue;
  }
  if (arg === "--timeout-ms") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --timeout-ms");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("--timeout-ms must be a positive number");
    }
    timeoutMs = Math.trunc(parsed);
    index += 1;
    continue;
  }
  if (arg === "--keep-open") {
    keepOpen = true;
    continue;
  }
  if (arg === "--skip-launch") {
    skipLaunch = true;
    continue;
  }
  if (arg === "--verify-reconnect") {
    verifyReconnect = true;
    continue;
  }
  if (arg === "--verify-workflow-log") {
    verifyWorkflowLog = true;
    continue;
  }
}

await main();

async function main(): Promise<void> {
  const resolvedProfileDir = profileDir ?? path.join(os.tmpdir(), `turnkeyai-direct-cdp-smoke-${Date.now()}`);
  const resolvedDaemonUrl = daemonUrl.trim()
    ? daemonUrl.trim().replace(/\/+$/, "")
    : `http://127.0.0.1:${daemonPort ?? (await resolveFreePort())}`;
  const resolvedDaemonPort = Number(new URL(resolvedDaemonUrl).port || 80);
  const resolvedCdpPort = cdpPort ?? (cdpEndpoint.trim() ? null : await resolveFreePort());
  const resolvedCdpEndpoint = cdpEndpoint.trim()
    ? cdpEndpoint.trim().replace(/\/+$/, "")
    : `http://127.0.0.1:${resolvedCdpPort}`;
  const fixture = startUrl.trim() ? null : await startDirectCdpSmokeFixture();
  const effectiveStartUrl = startUrl.trim() || fixture!.url;
  const resolvedChromePath =
    skipLaunch ? null : await resolveChromePath(chromePath ?? process.env.TURNKEYAI_BROWSER_PATH);

  let daemonChild: ChildProcess | null = null;
  let chromeChild: ChildProcess | null = null;

  try {
    await mkdir(resolvedProfileDir, { recursive: true });

    if (!skipLaunch) {
      chromeChild = launchChromeForDirectCdp({
        chromePath: resolvedChromePath!,
        profileDir: resolvedProfileDir,
        cdpPort: resolvedCdpPort ?? Number(new URL(resolvedCdpEndpoint).port || 9222),
        startUrl: effectiveStartUrl,
      });
    } else {
      await access(resolvedProfileDir).catch(() => undefined);
    }

    await waitForCdpEndpoint(resolvedCdpEndpoint, timeoutMs);

    daemonChild = spawn("npm", ["run", "daemon"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TURNKEYAI_BROWSER_TRANSPORT: "direct-cdp",
        TURNKEYAI_BROWSER_CDP_ENDPOINT: resolvedCdpEndpoint,
        TURNKEYAI_DAEMON_PORT: String(resolvedDaemonPort),
      },
      stdio: "ignore",
    });

    await waitForHealth(resolvedDaemonUrl, timeoutMs);
    const smoke = await runDirectCdpBrowserSessionSmoke({
      daemonUrl: resolvedDaemonUrl,
      startUrl: effectiveStartUrl,
    });
    const reconnectSmoke =
      verifyReconnect
        ? await runDirectCdpReconnectSmoke({
            daemonUrl: resolvedDaemonUrl,
            timeoutMs,
            cdpEndpoint: resolvedCdpEndpoint,
            browserChild: chromeChild,
            relaunch: () =>
              launchChromeForDirectCdp({
                chromePath: resolvedChromePath!,
                profileDir: resolvedProfileDir,
                cdpPort: resolvedCdpPort ?? Number(new URL(resolvedCdpEndpoint).port || 9222),
                startUrl: effectiveStartUrl,
              }),
            browserSmoke: smoke,
          })
        : null;
    if (reconnectSmoke) {
      chromeChild = reconnectSmoke.browserChild;
    }
    const workflowLogSmoke =
      verifyWorkflowLog
        ? await runDirectCdpWorkflowLogSmoke({
            daemonUrl: resolvedDaemonUrl,
          })
        : null;

    console.log("direct-cdp smoke passed");
    console.log(`daemon: ${resolvedDaemonUrl}`);
    console.log(`cdp-endpoint: ${resolvedCdpEndpoint}`);
    console.log(`browser-session: ${smoke.sessionId}`);
    console.log(`browser-final-url: ${smoke.finalUrl}`);
    console.log(`browser-history: ${smoke.historyLength}`);
    console.log(`browser-transport: ${smoke.transportLabel}`);
    console.log(`browser-target-continuity: ${smoke.targetContinuity}`);
    console.log(`browser-screenshots: ${smoke.screenshotCount}`);
    console.log(`browser-artifacts: ${smoke.artifactCount}`);
    console.log(`browser-targets: ${smoke.targetCount}`);
    console.log(`browser-download-artifacts: ${smoke.downloadArtifactCount}`);
    console.log(`browser-upload-actions: ${smoke.uploadTraceCount}`);
    console.log(`browser-action-kinds: ${smoke.actionKinds.join(",")}`);
    console.log("browser-action-parity: passed");
    console.log("browser-cdp-controls: passed");
    console.log("browser-artifact-safety: passed");
    if (smoke.multiTargetContinuityPassed) {
      console.log("browser-multi-target: passed");
    }
    if (smoke.networkControlsPassed) {
      console.log("browser-network-controls: passed");
    }
    if (smoke.resumeFinalUrl) {
      console.log(`browser-resume-final-url: ${smoke.resumeFinalUrl}`);
    }
    if (reconnectSmoke) {
      console.log(`reconnect-history: ${reconnectSmoke.historyLength}`);
      console.log(`reconnect-final-url: ${reconnectSmoke.finalUrl}`);
    }
    if (workflowLogSmoke) {
      console.log(`workflow-log-case: ${workflowLogSmoke.caseId}`);
      console.log(`workflow-log-status: ${workflowLogSmoke.status}`);
    }
    console.log(`profile: ${resolvedProfileDir}`);
    console.log(`url: ${effectiveStartUrl}`);

    if (keepOpen) {
      console.log("processes left running due to --keep-open");
      daemonChild = null;
      chromeChild = null;
    }
  } finally {
    chromeChild?.kill("SIGTERM");
    daemonChild?.kill("SIGTERM");
    await fixture?.close();
    if (!keepOpen) {
      await rm(resolvedProfileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function launchChromeForDirectCdp(input: {
  chromePath: string;
  profileDir: string;
  cdpPort: number;
  startUrl: string;
}): ChildProcess {
  return spawn(
    input.chromePath,
    [
      `--user-data-dir=${input.profileDir}`,
      `--remote-debugging-port=${input.cdpPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      input.startUrl,
    ],
    {
      stdio: "ignore",
    }
  );
}

async function runDirectCdpBrowserSessionSmoke(input: {
  daemonUrl: string;
  startUrl: string;
}): Promise<{
  threadId: string;
  sessionId: string;
  finalUrl: string;
  resumeFinalUrl?: string;
  historyLength: number;
  transportLabel: string;
  targetContinuity: string;
  screenshotCount: number;
  artifactCount: number;
  targetCount: number;
  downloadArtifactCount: number;
  uploadTraceCount: number;
  networkControlsPassed: boolean;
  multiTargetContinuityPassed: boolean;
  actionKinds: string[];
}> {
  const thread = (await postJson(`${input.daemonUrl}/threads/bootstrap-demo`, {
    variant: "default",
  })) as { threadId?: unknown };
  const threadId = requireString(thread.threadId, "threadId");

  const spawnResponse = (await postJson(`${input.daemonUrl}/browser-sessions/spawn`, {
    threadId,
    url: input.startUrl,
    instructions: `Open ${input.startUrl} and capture a direct-cdp smoke snapshot`,
  })) as BrowserSmokeResponse;
  const sessionId = requireString(spawnResponse.sessionId, "spawn sessionId");
  const spawnFinalUrl = requireString(spawnResponse.page?.finalUrl, "spawn final page URL");
  const spawnTransportLabel = requireString(spawnResponse.transportLabel, "spawn transport label");
  if (spawnTransportLabel !== "direct-cdp") {
    throw new Error(`direct-cdp spawn returned unexpected transport label: ${spawnTransportLabel}`);
  }
  if (spawnFinalUrl !== input.startUrl && !spawnFinalUrl.startsWith(input.startUrl)) {
    throw new Error(`direct-cdp spawn returned unexpected final URL: ${spawnFinalUrl}`);
  }

  const sendResponse = (await postJson(`${input.daemonUrl}/browser-sessions/${encodeURIComponent(sessionId)}/send`, {
    threadId,
    instructions: "Exercise direct-cdp network controls, type into the form, submit it, and inspect page metadata.",
    actions: [
      ...buildNetworkSmokeActions("direct-cdp"),
      { kind: "hover", selectors: ["#hover-target"] },
      { kind: "key", key: "Tab" },
      { kind: "select", selectors: ["#plan-select"], value: "team" },
      { kind: "drag", source: { selectors: ["#drag-source"] }, target: { selectors: ["#drop-zone"] } },
      { kind: "waitFor", selectors: ["#relay-submit"], state: "visible", timeoutMs: 5_000 },
      { kind: "dialog", action: "accept", timeoutMs: 5_000 },
      { kind: "eval", expression: "setTimeout(() => alert('direct-cdp-dialog'), 0); 'dialog-armed';", timeoutMs: 5_000 },
      { kind: "probe", probe: "links", maxItems: 5 },
      { kind: "storage", area: "localStorage", action: "set", key: "transport", value: "direct-cdp" },
      { kind: "cookie", action: "set", name: "transport", value: "direct-cdp", path: "/" },
      { kind: "cdp", method: "Runtime.evaluate", params: { expression: "document.readyState" }, timeoutMs: 5_000 },
      { kind: "download", urlPattern: "/export.csv", timeoutMs: 5_000 },
      { kind: "click", selectors: ["#download-link"] },
      { kind: "type", selectors: ["#relay-input"], text: "turnkey cdp" },
      { kind: "click", selectors: ["#relay-submit"] },
      { kind: "console", probe: "page-metadata" },
      { kind: "snapshot", note: "after-submit" },
    ],
  })) as BrowserSmokeResponse;
  const sendFinalUrl = requireString(sendResponse.page?.finalUrl, "send final page URL");
  const sendTitle = requireString(sendResponse.page?.title, "send page title");
  if (!sendFinalUrl.includes("#submitted")) {
    throw new Error(`direct-cdp send smoke did not submit fixture form: ${sendFinalUrl}`);
  }
  if (sendTitle !== "submitted:turnkey cdp") {
    throw new Error(`direct-cdp send smoke returned unexpected title: ${sendTitle}`);
  }
  if (requireString(sendResponse.transportLabel, "send transport label") !== "direct-cdp") {
    throw new Error("direct-cdp send smoke lost transport labeling");
  }
  assertNetworkSmokeTrace(sendResponse, "direct-cdp");

  const metadataTrace = sendResponse.trace?.find((entry) => entry.kind === "console");
  const metadataResult = metadataTrace?.output && typeof metadataTrace.output === "object"
    ? (metadataTrace.output as { result?: { title?: unknown; href?: unknown } }).result
    : null;
  if (!metadataResult || metadataResult.title !== "submitted:turnkey cdp") {
    throw new Error("direct-cdp send smoke console probe did not observe the submitted title");
  }
  if (typeof metadataResult.href !== "string" || !metadataResult.href.includes("#submitted")) {
    throw new Error("direct-cdp send smoke console probe did not observe the submitted hash URL");
  }
  const downloadSmoke = resolveDownloadSmokeArtifact(sendResponse, "direct-cdp");

  const uploadResponse = (await postJson(`${input.daemonUrl}/browser-sessions/${encodeURIComponent(sessionId)}/send`, {
    threadId,
    instructions: "Upload the downloaded CSV artifact back into the fixture and verify file chooser continuity.",
    actions: [
      { kind: "upload", selectors: ["#upload-input"], artifactId: downloadSmoke.artifactId },
      { kind: "console", probe: "page-metadata" },
      { kind: "snapshot", note: "after-upload" },
    ],
  })) as BrowserSmokeResponse;
  const uploadFinalUrl = requireString(uploadResponse.page?.finalUrl, "upload final page URL");
  const uploadTitle = requireString(uploadResponse.page?.title, "upload page title");
  if (!uploadFinalUrl.includes("#submitted")) {
    throw new Error(`direct-cdp upload smoke lost the submitted page state: ${uploadFinalUrl}`);
  }
  if (!isUploadedExportTitle(uploadTitle)) {
    throw new Error(`direct-cdp upload smoke returned unexpected title: ${uploadTitle}`);
  }
  if (requireString(uploadResponse.transportLabel, "upload transport label") !== "direct-cdp") {
    throw new Error("direct-cdp upload smoke lost transport labeling");
  }
  const uploadTraceCount = countUploadTraceEntries(uploadResponse, "direct-cdp");

  const multiTarget = await verifyBrowserSmokeMultiTarget({
    daemonUrl: input.daemonUrl,
    threadId,
    sessionId,
    startUrl: input.startUrl,
    originalTargetId: uploadResponse.targetId ?? sendResponse.targetId ?? spawnResponse.targetId,
    label: "direct-cdp",
    client: { getJson, postJson },
  });

  const resumeResponse = (await postJson(`${input.daemonUrl}/browser-sessions/${encodeURIComponent(sessionId)}/resume`, {
    threadId,
    instructions: "Resume the direct-cdp session, scroll, inspect interactives, and capture a final snapshot.",
    actions: [
      { kind: "scroll", direction: "down", amount: 240 },
      { kind: "console", probe: "interactive-summary" },
      { kind: "snapshot", note: "post-resume" },
      { kind: "screenshot", label: "post-resume" },
    ],
  })) as BrowserSmokeResponse;
  const resumeFinalUrl = requireString(resumeResponse.page?.finalUrl, "resume final page URL");
  if (!resumeFinalUrl.includes("#submitted")) {
    throw new Error(`direct-cdp resume smoke lost the submitted page state: ${resumeFinalUrl}`);
  }
  if (resumeResponse.dispatchMode !== "resume") {
    throw new Error(`direct-cdp resume smoke returned unexpected dispatch mode: ${String(resumeResponse.dispatchMode ?? "unknown")}`);
  }
  if (resumeResponse.transportLabel !== "direct-cdp") {
    throw new Error(`direct-cdp resume smoke returned unexpected transport label: ${String(resumeResponse.transportLabel ?? "unknown")}`);
  }
  const interactiveTrace = resumeResponse.trace?.find((entry) => entry.kind === "console");
  const interactiveResult =
    interactiveTrace?.output && typeof interactiveTrace.output === "object"
      ? (interactiveTrace.output as { result?: unknown }).result
      : null;
  if (!Array.isArray(interactiveResult) || interactiveResult.length < 2) {
    throw new Error("direct-cdp resume smoke did not surface interactive summary results");
  }
  if (resumeResponse.screenshotPaths !== undefined && !Array.isArray(resumeResponse.screenshotPaths)) {
    throw new Error("direct-cdp resume smoke returned non-array screenshotPaths");
  }
  if (resumeResponse.artifactIds !== undefined && !Array.isArray(resumeResponse.artifactIds)) {
    throw new Error("direct-cdp resume smoke returned non-array artifactIds");
  }
  const screenshotPaths = Array.isArray(resumeResponse.screenshotPaths) ? resumeResponse.screenshotPaths : [];
  const artifactIds = [
    ...(Array.isArray(sendResponse.artifactIds) ? sendResponse.artifactIds : []),
    ...(Array.isArray(uploadResponse.artifactIds) ? uploadResponse.artifactIds : []),
    ...(Array.isArray(resumeResponse.artifactIds) ? resumeResponse.artifactIds : []),
  ];
  const screenshotCount = screenshotPaths.length;
  const artifactCount = artifactIds.length;
  if (screenshotCount < 1) {
    throw new Error("direct-cdp resume smoke did not persist a screenshot artifact path");
  }
  if (artifactCount < 1) {
    throw new Error("direct-cdp resume smoke did not persist browser artifact metadata");
  }

  const history = await getSessionHistory(input.daemonUrl, threadId, sessionId);
  const dispatchSequence = history.map((entry) => entry.dispatchMode).join(",");
  if (dispatchSequence !== "spawn,send,send,resume") {
    throw new Error(`direct-cdp smoke history recorded unexpected dispatch sequence: ${dispatchSequence}`);
  }
  if (!history.every((entry) => entry.transportLabel === "direct-cdp")) {
    throw new Error("direct-cdp smoke history is missing direct-cdp transport labels");
  }
  const actionKinds = assertBrowserSmokeActionParity([sendResponse, uploadResponse, resumeResponse], "direct-cdp");

  return {
    threadId,
    sessionId,
    finalUrl: sendFinalUrl,
    resumeFinalUrl,
    historyLength: history.length,
    transportLabel: spawnTransportLabel,
    targetContinuity: "direct-cdp",
    screenshotCount,
    artifactCount,
    targetCount: multiTarget.targetCount,
    downloadArtifactCount: downloadSmoke.downloadArtifactCount,
    uploadTraceCount,
    networkControlsPassed: true,
    multiTargetContinuityPassed: true,
    actionKinds,
  };
}

async function waitForCdpEndpoint(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      await getJson(resolveVersionUrl(endpoint));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for CDP endpoint ${endpoint} | last error: ${lastError ?? "unknown"}`);
}

async function waitForCdpEndpointUnavailable(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await getJson(resolveVersionUrl(endpoint));
    } catch {
      return;
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for CDP endpoint ${endpoint} to go offline`);
}

function resolveVersionUrl(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/json/version") ? normalized : `${normalized}/json/version`;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      await getJson(`${baseUrl}/health`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for daemon health | last error: ${lastError ?? "unknown"}`);
}

async function getSessionHistory(
  daemonUrl: string,
  threadId: string,
  sessionId: string
): Promise<Array<{ dispatchMode?: unknown; transportLabel?: unknown }>> {
  return (await getJson(
    `${daemonUrl}/browser-sessions/${encodeURIComponent(sessionId)}/history?threadId=${encodeURIComponent(threadId)}&limit=10`
  )) as Array<{ dispatchMode?: unknown; transportLabel?: unknown }>;
}

async function runDirectCdpReconnectSmoke(input: {
  daemonUrl: string;
  timeoutMs: number;
  cdpEndpoint: string;
  browserChild: ChildProcess | null;
  relaunch: () => ChildProcess;
  browserSmoke: Awaited<ReturnType<typeof runDirectCdpBrowserSessionSmoke>>;
}): Promise<{
  browserChild: ChildProcess;
  historyLength: number;
  finalUrl: string;
}> {
  if (!input.browserChild) {
    throw new Error("direct-cdp reconnect smoke requires a locally launched browser; do not combine --verify-reconnect with --skip-launch");
  }

  input.browserChild.kill("SIGTERM");
  await waitForCdpEndpointUnavailable(input.cdpEndpoint, input.timeoutMs);

  const relaunched = input.relaunch();
  await waitForCdpEndpoint(input.cdpEndpoint, input.timeoutMs);

  const resumeResponse = (await postJson(
    `${input.daemonUrl}/browser-sessions/${encodeURIComponent(input.browserSmoke.sessionId)}/resume`,
    {
      threadId: input.browserSmoke.threadId,
      instructions: "Resume after direct-cdp reconnect and confirm the form state still holds.",
      actions: [
        { kind: "console", probe: "page-metadata" },
        { kind: "snapshot", note: "post-cdp-reconnect" },
      ],
    }
  )) as BrowserSmokeResponse;
  const finalUrl = requireString(resumeResponse.page?.finalUrl, "direct-cdp reconnect final page URL");
  if (!finalUrl.includes("#submitted")) {
    throw new Error(`direct-cdp reconnect smoke lost page state after browser restart: ${finalUrl}`);
  }
  if (resumeResponse.dispatchMode !== "resume") {
    throw new Error(`direct-cdp reconnect smoke returned unexpected dispatch mode: ${String(resumeResponse.dispatchMode ?? "unknown")}`);
  }
  if (resumeResponse.transportLabel !== "direct-cdp") {
    throw new Error(`direct-cdp reconnect smoke returned unexpected transport label: ${String(resumeResponse.transportLabel ?? "unknown")}`);
  }
  const metadataTrace = resumeResponse.trace?.find((entry) => entry.kind === "console");
  const metadataResult =
    metadataTrace?.output && typeof metadataTrace.output === "object"
      ? (metadataTrace.output as { result?: { title?: unknown; href?: unknown } }).result
      : null;
  if (!metadataResult || typeof metadataResult.href !== "string" || !metadataResult.href.includes("#submitted")) {
    throw new Error("direct-cdp reconnect smoke console probe did not observe the submitted hash URL");
  }

  const history = await getSessionHistory(
    input.daemonUrl,
    input.browserSmoke.threadId,
    input.browserSmoke.sessionId
  );
  const dispatchSequence = history.map((entry) => entry.dispatchMode).join(",");
  if (dispatchSequence !== "spawn,send,send,resume,resume") {
    throw new Error(`direct-cdp reconnect smoke recorded unexpected dispatch sequence: ${dispatchSequence}`);
  }
  if (!history.every((entry) => entry.transportLabel === "direct-cdp")) {
    throw new Error("direct-cdp reconnect smoke history is missing direct-cdp transport labels");
  }

  return {
    browserChild: relaunched,
    historyLength: history.length,
    finalUrl,
  };
}

async function runDirectCdpWorkflowLogSmoke(input: {
  daemonUrl: string;
}): Promise<{ caseId: string; status: string }> {
  const caseId = "direct-cdp-recovery-workflow-log-surfaces-reconnect-diagnostics";
  const result = (await postJson(`${input.daemonUrl}/regression-cases/run`, {
    caseIds: [caseId],
  })) as {
    totalCases?: number;
    failedCases?: number;
    results?: Array<{ caseId?: string; status?: string }>;
  };
  const entry = result.results?.[0];
  if (!entry || entry.caseId !== caseId || entry.status !== "passed" || result.failedCases !== 0) {
    throw new Error(`direct-cdp workflow log smoke failed: ${JSON.stringify(entry ?? result)}`);
  }
  return {
    caseId,
    status: entry.status,
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

async function resolveChromePath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new Error(
    "no supported Chromium executable found; pass --chrome-path or set TURNKEYAI_BROWSER_PATH"
  );
}

async function resolveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function startDirectCdpSmokeFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const html = buildDirectCdpSmokeFixtureHtml();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/headers-smoke") {
      const header = req.headers["x-turnkeyai-smoke"];
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ header: Array.isArray(header) ? header.join(",") : header ?? null }));
      return;
    }
    if (url.pathname === "/export.csv") {
      writeExportCsvResponse(res);
      return;
    }
    if (url.pathname !== "/") {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind direct-cdp smoke fixture server"));
        return;
      }
      resolve(address.port);
    });
    server.on("error", reject);
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function buildDirectCdpSmokeFixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>direct-cdp-smoke-initial</title>
    <style>
      body { font-family: sans-serif; margin: 24px; min-height: 2200px; }
      .spacer { height: 1400px; background: linear-gradient(#fff, #eef9ff); }
      label, input, button { display: block; margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <h1>TurnkeyAI Direct CDP Smoke</h1>
    <p id="status">idle</p>
    <label for="relay-input">Direct CDP Input</label>
    <input id="relay-input" aria-label="Direct CDP Input" />
    <button id="relay-submit" type="button">Submit Direct CDP Form</button>
    ${buildRichInteractionFixtureMarkup()}
    ${buildDownloadUploadFixtureMarkup()}
    <div class="spacer"></div>
    <script>
      const input = document.getElementById("relay-input");
      const status = document.getElementById("status");
      const button = document.getElementById("relay-submit");
      button.addEventListener("click", () => {
        const value = input.value || "empty";
        document.title = "submitted:" + value;
        status.textContent = "submitted:" + value;
        location.hash = "submitted";
      });
      ${buildRichInteractionFixtureScript()}
      ${buildDownloadUploadFixtureScript()}
    </script>
  </body>
</html>`;
}

function buildNetworkSmokeActions(label: string): Array<Record<string, unknown>> {
  const mockBody = JSON.stringify({ ok: true, transport: label });
  return [
    { kind: "network", action: "setExtraHeaders", headers: { "x-turnkeyai-smoke": label } },
    {
      kind: "eval",
      expression: buildHeaderProbeExpression("header"),
      awaitPromise: true,
      timeoutMs: 5_000,
    },
    {
      kind: "network",
      action: "emulateConditions",
      latencyMs: 0,
      downloadThroughputBytesPerSec: 1_000_000,
      uploadThroughputBytesPerSec: 500_000,
    },
    {
      kind: "network",
      action: "mockResponse",
      urlPattern: "/mock-smoke",
      method: "GET",
      status: 201,
      headers: { "content-type": "application/json" },
      body: mockBody,
      timeoutMs: 5_000,
    },
    {
      kind: "eval",
      expression: [
        "(async () => {",
        "  const response = await fetch('/mock-smoke');",
        "  const body = await response.json();",
        "  window.__turnkeyNetworkSmoke = { ...(window.__turnkeyNetworkSmoke || {}), mockStatus: response.status, mockTransport: body.transport };",
        "  return window.__turnkeyNetworkSmoke;",
        "})()",
      ].join("\n"),
      awaitPromise: true,
      timeoutMs: 5_000,
    },
    { kind: "network", action: "blockUrls", urlPatterns: ["*://*/blocked-smoke*"] },
    {
      kind: "eval",
      expression: [
        "(async () => {",
        "  let blocked = false;",
        "  try {",
        "    await fetch('/blocked-smoke?phase=blocked');",
        "  } catch {",
        "    blocked = true;",
        "  }",
        "  window.__turnkeyNetworkSmoke = { ...(window.__turnkeyNetworkSmoke || {}), blocked };",
        "  return window.__turnkeyNetworkSmoke;",
        "})()",
      ].join("\n"),
      awaitPromise: true,
      timeoutMs: 5_000,
    },
    { kind: "network", action: "clearBlockedUrls" },
    {
      kind: "eval",
      expression: [
        "(async () => {",
        "  const response = await fetch('/blocked-smoke?phase=clear');",
        "  window.__turnkeyNetworkSmoke = { ...(window.__turnkeyNetworkSmoke || {}), unblockedStatus: response.status };",
        "  return window.__turnkeyNetworkSmoke;",
        "})()",
      ].join("\n"),
      awaitPromise: true,
      timeoutMs: 5_000,
    },
    { kind: "network", action: "clearMockResponses" },
    {
      kind: "eval",
      expression: [
        "(async () => {",
        "  const response = await fetch('/mock-smoke?phase=cleared');",
        "  window.__turnkeyNetworkSmoke = { ...(window.__turnkeyNetworkSmoke || {}), postMockStatus: response.status };",
        "  return window.__turnkeyNetworkSmoke;",
        "})()",
      ].join("\n"),
      awaitPromise: true,
      timeoutMs: 5_000,
    },
    { kind: "network", action: "clearEmulation" },
    { kind: "network", action: "clearExtraHeaders" },
    {
      kind: "eval",
      expression: buildHeaderProbeExpression("clearedHeader"),
      awaitPromise: true,
      timeoutMs: 5_000,
    },
  ];
}

function buildHeaderProbeExpression(field: "header" | "clearedHeader"): string {
  return [
    "(async () => {",
    `  const response = await fetch('/headers-smoke?field=${field}');`,
    "  const body = await response.json();",
    `  window.__turnkeyNetworkSmoke = { ...(window.__turnkeyNetworkSmoke || {}), ${field}: body.header ?? null };`,
    "  return window.__turnkeyNetworkSmoke;",
    "})()",
  ].join("\n");
}

function assertNetworkSmokeTrace(response: BrowserSmokeResponse, label: string): void {
  const networkOutput = (action: string): Record<string, unknown> | null => {
    const entry = response.trace?.find((candidate) =>
      candidate.kind === "network" &&
      candidate.output &&
      typeof candidate.output === "object" &&
      candidate.output.action === action
    );
    return entry?.output ?? null;
  };

  const headersOutput = networkOutput("setExtraHeaders");
  if (!headersOutput || headersOutput.set !== true || headersOutput.headerCount !== 1) {
    throw new Error("direct-cdp network smoke did not set extra headers");
  }
  const emulationOutput = networkOutput("emulateConditions");
  if (!emulationOutput || emulationOutput.emulated !== true || emulationOutput.latencyMs !== 0) {
    throw new Error("direct-cdp network smoke did not emulate network conditions");
  }
  const mockOutput = networkOutput("mockResponse");
  if (!mockOutput || mockOutput.matched !== true || mockOutput.status !== 201) {
    throw new Error("direct-cdp network smoke did not match mock response");
  }
  const blockOutput = networkOutput("blockUrls");
  if (!blockOutput || blockOutput.blocked !== true || blockOutput.urlPatternCount !== 1) {
    throw new Error("direct-cdp network smoke did not block URLs");
  }
  for (const action of ["clearBlockedUrls", "clearMockResponses", "clearEmulation", "clearExtraHeaders"]) {
    const output = networkOutput(action);
    if (!output || output.cleared !== true) {
      throw new Error(`direct-cdp network smoke did not clear ${action}`);
    }
  }

  const finalResult = response.trace
    ?.filter((entry) => entry.kind === "eval")
    .map((entry) => entry.output?.result)
    .find((result): result is Record<string, unknown> =>
      isRecord(result) &&
      result.header === label &&
      result.mockStatus === 201 &&
      result.mockTransport === label &&
      result.blocked === true &&
      result.unblockedStatus === 404 &&
      result.postMockStatus === 404 &&
      result.clearedHeader === null
    );
  if (!finalResult) {
    throw new Error("direct-cdp network smoke did not observe expected network side effects");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error((json as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return json;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error((json as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

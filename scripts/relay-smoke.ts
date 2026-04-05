import { access, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createServer, type Server } from "node:http";

const args = process.argv.slice(2);
let daemonUrl = process.env.TURNKEYAI_DAEMON_URL ?? "";
let startUrl = "";
let chromePath: string | null = null;
let profileDir: string | null = null;
let timeoutMs = 20_000;
let skipBuild = false;
let keepOpen = false;
let requireTarget = true;
let requireBrowserAction = true;
let daemonPort: number | null = null;
let peerCount = 1;
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
  if (arg === "--peer-count") {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("missing value for --peer-count");
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("--peer-count must be a positive integer");
    }
    peerCount = parsed;
    index += 1;
    continue;
  }
  if (arg === "--skip-build") {
    skipBuild = true;
    continue;
  }
  if (arg === "--keep-open") {
    keepOpen = true;
    continue;
  }
  if (arg === "--no-require-target") {
    requireTarget = false;
    requireBrowserAction = false;
    continue;
  }
  if (arg === "--no-browser-action") {
    requireBrowserAction = false;
    continue;
  }
  if (arg === "--verify-reconnect") {
    verifyReconnect = true;
    continue;
  }
  if (arg === "--verify-workflow-log") {
    verifyWorkflowLog = true;
  }
}

await main();

async function main(): Promise<void> {
  const extensionDir = path.resolve(process.cwd(), "packages/browser-relay-peer/dist/extension");
  const resolvedProfileDir = profileDir ?? path.join(os.tmpdir(), `turnkeyai-relay-smoke-${Date.now()}`);
  const resolvedDaemonUrl = daemonUrl.trim()
    ? daemonUrl.trim().replace(/\/+$/, "")
    : `http://127.0.0.1:${daemonPort ?? (await resolveFreePort())}`;
  const resolvedDaemonPort = Number(new URL(resolvedDaemonUrl).port || 80);
  const fixture = startUrl.trim() ? null : await startRelaySmokeFixture();
  const effectiveStartUrl = startUrl.trim() || fixture!.url;

  let daemonChild: ChildProcess | null = null;
  const browserChildren = new Map<string, ChildProcess>();
  const syntheticPeerIds: string[] = [];

  try {
    if (!skipBuild) {
      await runCommand("npm", ["run", "build:relay-extension"], {
        TURNKEYAI_RELAY_DAEMON_URL: resolvedDaemonUrl,
      });
    } else {
      await access(path.join(extensionDir, "manifest.json"));
    }

    await mkdir(resolvedProfileDir, { recursive: true });
    const primaryProfileDir = path.join(resolvedProfileDir, "peer-1");
    await mkdir(primaryProfileDir, { recursive: true });

    daemonChild = spawn("npm", ["run", "daemon"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TURNKEYAI_BROWSER_TRANSPORT: "relay",
        TURNKEYAI_DAEMON_PORT: String(resolvedDaemonPort),
      },
      stdio: "ignore",
    });

    const resolvedChromePath = await resolveChromePath(chromePath ?? process.env.TURNKEYAI_BROWSER_PATH);
    browserChildren.set(
      "primary",
      launchChromePeer({
        chromePath: resolvedChromePath,
        extensionDir,
        profileDir: primaryProfileDir,
        startUrl: effectiveStartUrl,
      })
    );

    await waitForHealth(resolvedDaemonUrl, timeoutMs);
    const peerStates = await waitForRelayPeers({
      daemonUrl: resolvedDaemonUrl,
      timeoutMs,
      requiredCount: 1,
      requireTarget,
    });
    const primaryPeer = peerStates[0]!;
    if (peerCount > 1) {
      syntheticPeerIds.push(...(await registerSyntheticRelayPeers({
        daemonUrl: resolvedDaemonUrl,
        count: peerCount - 1,
        startUrl: effectiveStartUrl,
      })));
    }
    const allPeers = await waitForRelayPeers({
      daemonUrl: resolvedDaemonUrl,
      timeoutMs,
      requiredCount: peerCount,
      requireTarget,
    });
    const browserSmoke =
      requireBrowserAction
        ? await runBrowserSessionSmoke({
            daemonUrl: resolvedDaemonUrl,
            startUrl: effectiveStartUrl,
            richActions: !startUrl.trim(),
          })
        : null;
    const reconnectSmoke =
      verifyReconnect && browserSmoke
        ? await runRelayReconnectSmoke({
            daemonUrl: resolvedDaemonUrl,
            timeoutMs,
            peerId: primaryPeer.peerId,
            browserChild: browserChildren.get("primary")!,
            relaunch: () =>
              launchChromePeer({
                chromePath: resolvedChromePath,
                extensionDir,
                profileDir: primaryProfileDir,
                startUrl: effectiveStartUrl,
              }),
            browserSmoke,
            requireTarget,
          })
        : null;
    if (reconnectSmoke) {
      browserChildren.set("primary", reconnectSmoke.browserChild);
    }
    const workflowLogSmoke =
      verifyWorkflowLog
        ? await runRelayWorkflowLogSmoke({
            daemonUrl: resolvedDaemonUrl,
          })
        : null;

    console.log("relay smoke passed");
    console.log(`daemon: ${resolvedDaemonUrl}`);
    console.log(`peer: ${primaryPeer.peerId}`);
    if (primaryPeer.targets !== null) {
      console.log(`targets: ${primaryPeer.targets}`);
    }
    if (allPeers.length > 1) {
      console.log(`peer-count: ${allPeers.length}`);
    }
    if (browserSmoke) {
      console.log(`browser-session: ${browserSmoke.sessionId}`);
      console.log(`browser-final-url: ${browserSmoke.finalUrl}`);
      console.log(`browser-history: ${browserSmoke.historyLength}`);
      console.log(`browser-transport: ${browserSmoke.transportLabel}`);
      if (browserSmoke.resumeFinalUrl) {
        console.log(`browser-resume-final-url: ${browserSmoke.resumeFinalUrl}`);
      }
    }
    if (reconnectSmoke) {
      console.log(`reconnect-peer: ${reconnectSmoke.peerId}`);
      console.log(`reconnect-history: ${reconnectSmoke.historyLength}`);
      console.log(`reconnect-final-url: ${reconnectSmoke.finalUrl}`);
    }
    if (workflowLogSmoke) {
      console.log(`workflow-log-case: ${workflowLogSmoke.caseId}`);
      console.log(`workflow-log-status: ${workflowLogSmoke.status}`);
    }
    if (syntheticPeerIds.length > 0) {
      console.log(`synthetic-peers: ${syntheticPeerIds.join(",")}`);
    }
    console.log(`profile: ${resolvedProfileDir}`);
    console.log(`url: ${effectiveStartUrl}`);

    if (keepOpen) {
      console.log("processes left running due to --keep-open");
      daemonChild = null;
      browserChildren.clear();
    }
  } finally {
    for (const child of browserChildren.values()) {
      child.kill("SIGTERM");
    }
    if (daemonChild) {
      daemonChild.kill("SIGTERM");
    }
    await fixture?.close();
    if (!keepOpen) {
      await rm(resolvedProfileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function launchChromePeer(input: {
  chromePath: string;
  extensionDir: string;
  profileDir: string;
  startUrl: string;
}): ChildProcess {
  return spawn(
    input.chromePath,
    [
      `--user-data-dir=${input.profileDir}`,
      `--disable-extensions-except=${input.extensionDir}`,
      `--load-extension=${input.extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      input.startUrl,
    ],
    {
      stdio: "ignore",
    }
  );
}

async function runCommand(command: string, argv: string[], extraEnv: Record<string, string> = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${argv.join(" ")} exited with code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}

async function resolveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free daemon port"));
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

async function waitForRelayPeers(input: {
  daemonUrl: string;
  timeoutMs: number;
  requiredCount: number;
  requireTarget: boolean;
}): Promise<Array<{ peerId: string; targets: number | null }>> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: string | null = null;
  let lastObservedState = "no relay peers observed";

  while (Date.now() < deadline) {
    try {
      const peers = ((await getJson(`${input.daemonUrl}/relay/peers`)) as Array<{
        peerId: string;
        status: "online" | "stale";
      }>).filter((item) => item.status === "online");
      lastObservedState =
        peers.length > 0
          ? peers.map((peer) => `${peer.peerId}:${peer.status}`).join(", ")
          : "no online relay peers";
      if (peers.length >= input.requiredCount) {
        const peerStates: Array<{ peerId: string; targets: number | null }> = [];
        let satisfied = true;
        for (const peer of peers.slice(0, input.requiredCount)) {
          if (!input.requireTarget) {
            peerStates.push({ peerId: peer.peerId, targets: null });
            continue;
          }
          const targets = (await getJson(
            `${input.daemonUrl}/relay/targets?peerId=${encodeURIComponent(peer.peerId)}`
          )) as Array<{ relayTargetId: string }>;
          lastObservedState = `${peer.peerId}:targets=${targets.length}`;
          if (targets.length === 0) {
            satisfied = false;
            break;
          }
          peerStates.push({ peerId: peer.peerId, targets: targets.length });
        }
        if (satisfied && peerStates.length === input.requiredCount) {
          return peerStates;
        }
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  throw new Error(
    `timed out waiting for relay peers | last state: ${lastObservedState} | last error: ${lastError ?? "unknown"}`
  );
}

async function runBrowserSessionSmoke(input: {
  daemonUrl: string;
  startUrl: string;
  richActions: boolean;
}): Promise<{
  threadId: string;
  sessionId: string;
  finalUrl: string;
  resumeFinalUrl?: string;
  historyLength: number;
  transportLabel: string;
}> {
  const thread = (await postJson(`${input.daemonUrl}/threads/bootstrap-demo`, {
    variant: "default",
  })) as {
    threadId?: unknown;
  };
  const threadId = typeof thread.threadId === "string" ? thread.threadId : "";
  if (!threadId) {
    throw new Error("browser session smoke did not return a threadId");
  }

  const response = (await postJson(`${input.daemonUrl}/browser-sessions/spawn`, {
    threadId,
    url: input.startUrl,
    instructions: `Open ${input.startUrl} and capture a relay smoke snapshot`,
  })) as {
    sessionId?: unknown;
    page?: {
      finalUrl?: unknown;
    };
  };

  const sessionId = typeof response.sessionId === "string" ? response.sessionId : "";
  const finalUrl = typeof response.page?.finalUrl === "string" ? response.page.finalUrl : "";
  const transportLabel = typeof (response as { transportLabel?: unknown }).transportLabel === "string"
    ? ((response as { transportLabel: string }).transportLabel)
    : "";
  if (!sessionId) {
    throw new Error("browser session smoke did not return a sessionId");
  }
  if (!finalUrl) {
    throw new Error("browser session smoke did not return a final page URL");
  }
  if (!transportLabel) {
    throw new Error("browser session smoke did not return a transport label");
  }
  if (finalUrl !== input.startUrl && !finalUrl.startsWith(input.startUrl)) {
    throw new Error(`browser session smoke returned unexpected final URL: ${finalUrl}`);
  }

  if (!input.richActions) {
    const history = await getSessionHistory(input.daemonUrl, threadId, sessionId);
    return {
      threadId,
      sessionId,
      finalUrl,
      historyLength: history.length,
      transportLabel,
    };
  }

  const sendResponse = (await postJson(`${input.daemonUrl}/browser-sessions/${encodeURIComponent(sessionId)}/send`, {
    threadId,
    instructions: "Type into the relay form, submit it, and inspect page metadata.",
    actions: [
      { kind: "type", selectors: ["#relay-input"], text: "turnkey relay" },
      { kind: "click", selectors: ["#relay-submit"] },
      { kind: "console", probe: "page-metadata" },
      { kind: "snapshot", note: "after-submit" },
    ],
  })) as BrowserSmokeResponse;
  const sendFinalUrl = requireString(sendResponse.page?.finalUrl, "relay send final page URL");
  const sendTitle = requireString(sendResponse.page?.title, "relay send page title");
  const sendTransportLabel = requireString(sendResponse.transportLabel, "relay send transport label");
  if (!sendFinalUrl.includes("#submitted")) {
    throw new Error(`relay send smoke did not submit fixture form: ${sendFinalUrl}`);
  }
  if (sendTitle !== "submitted:turnkey relay") {
    throw new Error(`relay send smoke returned unexpected title: ${sendTitle}`);
  }
  if (sendTransportLabel !== "chrome-relay") {
    throw new Error(`relay send smoke returned unexpected transport label: ${sendTransportLabel}`);
  }
  const metadataTrace = sendResponse.trace?.find((entry) => entry.kind === "console");
  const metadataResult = metadataTrace?.output && typeof metadataTrace.output === "object"
    ? (metadataTrace.output as { result?: { title?: unknown; href?: unknown; interactiveCount?: unknown } }).result
    : null;
  if (!metadataResult || metadataResult.title !== "submitted:turnkey relay") {
    throw new Error("relay send smoke console probe did not observe the submitted title");
  }
  if (typeof metadataResult.href !== "string" || !metadataResult.href.includes("#submitted")) {
    throw new Error("relay send smoke console probe did not observe the submitted hash URL");
  }

  const resumeResponse = (await postJson(`${input.daemonUrl}/browser-sessions/${encodeURIComponent(sessionId)}/resume`, {
    threadId,
    instructions: "Resume the relay session, scroll, inspect interactives, and capture a final snapshot.",
    actions: [
      { kind: "scroll", direction: "down", amount: 240 },
      { kind: "console", probe: "interactive-summary" },
      { kind: "snapshot", note: "post-resume" },
    ],
  })) as BrowserSmokeResponse;
  const resumeFinalUrl = requireString(resumeResponse.page?.finalUrl, "relay resume final page URL");
  if (!resumeFinalUrl.includes("#submitted")) {
    throw new Error(`relay resume smoke lost the submitted page state: ${resumeFinalUrl}`);
  }
  if (resumeResponse.dispatchMode !== "resume") {
    throw new Error(`relay resume smoke returned unexpected dispatch mode: ${String(resumeResponse.dispatchMode ?? "unknown")}`);
  }
  if (resumeResponse.transportLabel !== "chrome-relay") {
    throw new Error(`relay resume smoke returned unexpected transport label: ${String(resumeResponse.transportLabel ?? "unknown")}`);
  }
  const interactiveTrace = resumeResponse.trace?.find((entry) => entry.kind === "console");
  const interactiveResult =
    interactiveTrace?.output && typeof interactiveTrace.output === "object"
      ? (interactiveTrace.output as { result?: unknown }).result
      : null;
  if (!Array.isArray(interactiveResult) || interactiveResult.length < 2) {
    throw new Error("relay resume smoke did not surface interactive summary results");
  }

  const history = await getSessionHistory(input.daemonUrl, threadId, sessionId);
  const dispatchSequence = history.map((entry) => entry.dispatchMode).join(",");
  if (dispatchSequence !== "spawn,send,resume") {
    throw new Error(`relay smoke history recorded unexpected dispatch sequence: ${dispatchSequence}`);
  }
  if (!history.every((entry) => entry.transportLabel === "chrome-relay")) {
    throw new Error("relay smoke history is missing chrome-relay transport labels");
  }
  if (!history.every((entry) => typeof entry.transportTargetId === "string" && entry.transportTargetId.startsWith("chrome-tab:"))) {
    throw new Error("relay smoke history is missing chrome-tab transport targets");
  }

  return {
    threadId,
    sessionId,
    finalUrl: sendFinalUrl,
    resumeFinalUrl,
    historyLength: history.length,
    transportLabel: sendTransportLabel,
  };
}

async function runRelayReconnectSmoke(input: {
  daemonUrl: string;
  timeoutMs: number;
  peerId: string;
  browserChild: ChildProcess;
  relaunch: () => ChildProcess;
  browserSmoke: Awaited<ReturnType<typeof runBrowserSessionSmoke>>;
  requireTarget: boolean;
}): Promise<{
  peerId: string;
  browserChild: ChildProcess;
  historyLength: number;
  finalUrl: string;
}> {
  const previousPeer = await getRelayPeerRecord(input.daemonUrl, input.peerId);
  await terminateChildProcess(input.browserChild);

  const relaunched = input.relaunch();
  await waitForRelayPeerReady({
    daemonUrl: input.daemonUrl,
    peerId: input.peerId,
    timeoutMs: input.timeoutMs,
    lastSeenAfter: previousPeer?.lastSeenAt ?? 0,
    requireTarget: input.requireTarget,
  });

  const resumeBody = {
    threadId: input.browserSmoke.threadId,
    instructions: "Resume after relay peer reconnect and confirm the form state still holds.",
    actions: [
      { kind: "console", probe: "page-metadata" },
      { kind: "snapshot", note: "post-peer-reconnect" },
    ],
  };
  const resumeResponse = (await postJsonWithRetry(
    `${input.daemonUrl}/browser-sessions/${encodeURIComponent(input.browserSmoke.sessionId)}/resume`,
    resumeBody,
    {
      retries: 1,
      shouldRetry: (error) =>
        error.message.includes("relay action request timed out") ||
        error.message.includes("timed out waiting for relay peers"),
      beforeRetry: async () => {
        await waitForRelayPeerReady({
          daemonUrl: input.daemonUrl,
          peerId: input.peerId,
          timeoutMs: input.timeoutMs,
          lastSeenAfter: 0,
          requireTarget: input.requireTarget,
        });
        await sleep(500);
      },
    }
  )) as BrowserSmokeResponse;
  const finalUrl = requireString(resumeResponse.page?.finalUrl, "relay reconnect resume final page URL");
  if (!finalUrl.includes("#submitted")) {
    throw new Error(`relay reconnect smoke lost page state after peer restart: ${finalUrl}`);
  }
  const history = await getSessionHistory(
    input.daemonUrl,
    input.browserSmoke.threadId,
    input.browserSmoke.sessionId
  );
  return {
    peerId: input.peerId,
    browserChild: relaunched,
    historyLength: history.length,
    finalUrl,
  };
}

async function waitForRelayPeerReady(input: {
  daemonUrl: string;
  peerId: string;
  timeoutMs: number;
  lastSeenAfter: number;
  requireTarget: boolean;
}): Promise<void> {
  await waitForRelayPeerHeartbeatAdvance({
    daemonUrl: input.daemonUrl,
    peerId: input.peerId,
    timeoutMs: input.timeoutMs,
    lastSeenAfter: input.lastSeenAfter,
  });
  if (!input.requireTarget) {
    return;
  }
  const deadline = Date.now() + input.timeoutMs;
  let lastTargetCount = 0;
  while (Date.now() < deadline) {
    const targets = (await getJson(
      `${input.daemonUrl}/relay/targets?peerId=${encodeURIComponent(input.peerId)}`
    )) as Array<{ relayTargetId: string }>;
    lastTargetCount = targets.length;
    if (targets.length > 0) {
      return;
    }
    await sleep(300);
  }
  throw new Error(`relay reconnect smoke did not restore targets for ${input.peerId} (last count: ${lastTargetCount})`);
}

async function waitForRelayPeerHeartbeatAdvance(input: {
  daemonUrl: string;
  peerId: string;
  timeoutMs: number;
  lastSeenAfter: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastObservedSeenAt = 0;
  while (Date.now() < deadline) {
    const peer = await getRelayPeerRecord(input.daemonUrl, input.peerId);
    lastObservedSeenAt = peer?.lastSeenAt ?? 0;
    if (peer && peer.status === "online" && peer.lastSeenAt > input.lastSeenAfter) {
      return;
    }
    await sleep(300);
  }

  throw new Error(
    `timed out waiting for relay peer ${input.peerId} heartbeat to advance (last seen at: ${lastObservedSeenAt})`
  );
}

async function getRelayPeerRecord(
  daemonUrl: string,
  peerId: string
): Promise<{ peerId: string; status: "online" | "stale"; lastSeenAt: number } | null> {
  const peers = (await getJson(`${daemonUrl}/relay/peers`)) as Array<{
    peerId: string;
    status: "online" | "stale";
    lastSeenAt: number;
  }>;
  return peers.find((peer) => peer.peerId === peerId) ?? null;
}

async function terminateChildProcess(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exitedGracefully = await waitForChildExit(child, graceMs);
  if (exitedGracefully) {
    return;
  }
  child.kill("SIGKILL");
  await waitForChildExit(child, 2_000);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onExit);
    };
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

async function registerSyntheticRelayPeers(input: {
  daemonUrl: string;
  count: number;
  startUrl: string;
}): Promise<string[]> {
  const peerIds: string[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const peerId = `synthetic-relay-peer-${index + 2}`;
    peerIds.push(peerId);
    await postJson(`${input.daemonUrl}/relay/peers/register`, {
      peerId,
      label: `Synthetic Relay Peer ${index + 2}`,
      capabilities: ["snapshot"],
      transportLabel: "synthetic-relay",
    });
    await postJson(`${input.daemonUrl}/relay/peers/${encodeURIComponent(peerId)}/targets/report`, {
      targets: [
        {
          relayTargetId: `synthetic-tab:${index + 2}`,
          url: input.startUrl,
          title: `Synthetic Relay Target ${index + 2}`,
          status: "open",
        },
      ],
    });
  }
  return peerIds;
}

async function runRelayWorkflowLogSmoke(input: {
  daemonUrl: string;
}): Promise<{ caseId: string; status: string }> {
  const caseId = "relay-recovery-workflow-log-surfaces-peer-diagnostics";
  const result = (await postJson(`${input.daemonUrl}/regression-cases/run`, {
    caseIds: [caseId],
  })) as {
    totalCases?: number;
    failedCases?: number;
    results?: Array<{ caseId?: string; status?: string; details?: string[] }>;
  };
  const entry = result.results?.[0];
  if (!entry || entry.caseId !== caseId || entry.status !== "passed" || result.failedCases !== 0) {
    throw new Error(`relay workflow log smoke failed: ${JSON.stringify(entry ?? result)}`);
  }
  return {
    caseId,
    status: entry.status,
  };
}

async function getSessionHistory(
  daemonUrl: string,
  threadId: string,
  sessionId: string
): Promise<Array<{ dispatchMode?: unknown; transportLabel?: unknown; transportTargetId?: unknown }>> {
  return (await getJson(
    `${daemonUrl}/browser-sessions/${encodeURIComponent(sessionId)}/history?threadId=${encodeURIComponent(threadId)}&limit=10`
  )) as Array<{ dispatchMode?: unknown; transportLabel?: unknown; transportTargetId?: unknown }>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

async function startRelaySmokeFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const html = buildRelaySmokeFixtureHtml();
  const server = createServer((req, res) => {
    if ((req.url ?? "/") !== "/") {
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
        reject(new Error("failed to bind relay smoke fixture server"));
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

function buildRelaySmokeFixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>relay-smoke-initial</title>
    <style>
      body { font-family: sans-serif; margin: 24px; min-height: 2200px; }
      .spacer { height: 1400px; background: linear-gradient(#fff, #f3f7ff); }
      label, input, button { display: block; margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <h1>TurnkeyAI Relay Smoke</h1>
    <p id="status">idle</p>
    <label for="relay-input">Relay Input</label>
    <input id="relay-input" aria-label="Relay Input" />
    <button id="relay-submit" type="button">Submit Relay Form</button>
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
    </script>
  </body>
</html>`;
}

interface BrowserSmokeResponse {
  sessionId?: string;
  dispatchMode?: string;
  resumeMode?: string;
  transportMode?: string;
  transportLabel?: string;
  transportTargetId?: string;
  page?: {
    finalUrl?: string;
    title?: string;
  };
  screenshotPaths?: string[];
  trace?: Array<{
    kind?: string;
    output?: Record<string, unknown>;
  }>;
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

async function postJsonWithRetry(
  url: string,
  body: unknown,
  input: {
    retries: number;
    shouldRetry(error: Error): boolean;
    beforeRetry?: () => Promise<void>;
  }
): Promise<unknown> {
  let attempt = 0;
  let lastError: Error | null = null;
  while (attempt <= input.retries) {
    try {
      return await postJson(url, body);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      lastError = normalized;
      if (attempt >= input.retries || !input.shouldRetry(normalized)) {
        throw normalized;
      }
      if (input.beforeRetry) {
        await input.beforeRetry();
      } else {
        await sleep(300);
      }
      attempt += 1;
    }
  }
  throw lastError ?? new Error("postJsonWithRetry failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

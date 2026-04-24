import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DirectCdpBrowserAdapter } from "@turnkeyai/browser-bridge/transport/direct-cdp-adapter";
import type { BrowserRawCdpExpertLane } from "@turnkeyai/core-types/team";

const chromePath = resolveChromePath();
const liveChromeTest = chromePath ? test : test.skip;

liveChromeTest(
  "browser raw CDP live e2e controls cross-site iframe shadow DOM and popup targets",
  { timeout: 45_000 },
  async () => {
    assert.ok(chromePath);
    const fixture = await startRawCdpFixture();
    const cdpPort = await resolveFreePort();
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-raw-cdp-live-"));
    const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
    const chrome = launchChrome({
      chromePath,
      cdpPort,
      profileDir,
      startUrl: fixture.mainUrl,
      isolateOrigins: [fixture.iframeOrigin],
    });
    const adapter = new DirectCdpBrowserAdapter({
      artifactRootDir: path.join(profileDir, "artifacts"),
      stateRootDir: path.join(profileDir, "state"),
      transportMode: "direct-cdp",
      directCdp: {
        endpoint: cdpEndpoint,
      },
    });
    const expertLane = adapter.getRawCdpExpertLane();
    const browserSessionId = "live-raw-cdp-session";

    try {
      await waitForCdpEndpoint(cdpEndpoint, 20_000);
      await expertLane.sendExpertCommand({
        browserSessionId,
        method: "Target.setDiscoverTargets",
        params: { discover: true },
      });

      const pageTarget = await waitForTarget(expertLane, browserSessionId, (target) => target.url === fixture.mainUrl);
      const iframeTarget = await waitForTarget(expertLane, browserSessionId, (target) =>
        typeof target.url === "string" && target.url.startsWith(fixture.iframeUrl)
      );
      assert.equal(iframeTarget.type, "iframe");
      assert.equal(iframeTarget.url, fixture.iframeUrl);

      const iframeSession = await expertLane.attachExpertTarget({
        browserSessionId,
        targetId: iframeTarget.targetId,
      });
      const shadowState = await runtimeEvaluate(expertLane, {
        browserSessionId,
        expertSessionId: iframeSession.expertSessionId,
        expression: `(() => {
          const button = document.querySelector("#shadow-host").shadowRoot.querySelector("#shadow-button");
          const rect = button.getBoundingClientRect();
          return {
            origin: location.origin,
            text: button.textContent,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            clicks: window.__rawCdpClicks
          };
        })()`,
      });
      assertRecord(shadowState);
      assert.deepEqual(
        {
          origin: shadowState.origin,
          text: shadowState.text,
          clicks: shadowState.clicks,
        },
        {
          origin: fixture.iframeOrigin,
          text: "Submit from shadow",
          clicks: 0,
        }
      );

      await dispatchMouse(expertLane, {
        browserSessionId,
        expertSessionId: iframeSession.expertSessionId,
        x: Number(shadowState.x),
        y: Number(shadowState.y),
      });
      const clickedState = await runtimeEvaluate(expertLane, {
        browserSessionId,
        expertSessionId: iframeSession.expertSessionId,
        expression: `(() => {
          const button = document.querySelector("#shadow-host").shadowRoot.querySelector("#shadow-button");
          return { clicks: window.__rawCdpClicks, text: button.textContent };
        })()`,
      });
      assertRecord(clickedState);
      assert.deepEqual(clickedState, {
        clicks: 1,
        text: "Clicked 1",
      });

      const pageSession = await expertLane.attachExpertTarget({
        browserSessionId,
        targetId: pageTarget.targetId,
      });
      await runtimeEvaluate(expertLane, {
        browserSessionId,
        expertSessionId: pageSession.expertSessionId,
        expression: `window.open(${JSON.stringify(fixture.popupUrl)}, "raw-cdp-popup", "width=420,height=320"); "opened";`,
      });

      const popupTarget = await waitForTarget(expertLane, browserSessionId, (target) => target.url === fixture.popupUrl);
      assert.equal(popupTarget.type, "page");
      const popupSession = await expertLane.attachExpertTarget({
        browserSessionId,
        targetId: popupTarget.targetId,
      });
      const popupState = await runtimeEvaluate(expertLane, {
        browserSessionId,
        expertSessionId: popupSession.expertSessionId,
        expression: `({ title: document.title, marker: document.querySelector("#popup-marker").textContent })`,
      });
      assertRecord(popupState);
      assert.deepEqual(popupState, {
        title: "Raw CDP Popup",
        marker: "popup-ready",
      });
    } finally {
      chrome.kill("SIGTERM");
      await fixture.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  }
);

function resolveChromePath(): string | null {
  const candidates = [
    process.env.TURNKEYAI_BROWSER_PATH,
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function launchChrome(input: {
  chromePath: string;
  cdpPort: number;
  profileDir: string;
  startUrl: string;
  isolateOrigins?: string[];
}): ChildProcess {
  return spawn(
    input.chromePath,
    [
      `--user-data-dir=${input.profileDir}`,
      `--remote-debugging-port=${input.cdpPort}`,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--no-first-run",
      "--no-default-browser-check",
      "--site-per-process",
      ...(input.isolateOrigins?.length ? [`--isolate-origins=${input.isolateOrigins.join(",")}`] : []),
      input.startUrl,
    ],
    {
      stdio: "ignore",
    }
  );
}

async function startRawCdpFixture(): Promise<{
  mainUrl: string;
  iframeUrl: string;
  iframeOrigin: string;
  popupUrl: string;
  close: () => Promise<void>;
}> {
  const iframeServer = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html>
  <head><title>Raw CDP Iframe</title></head>
  <body>
    <div id="shadow-host"></div>
    <script>
      window.__rawCdpClicks = 0;
      const host = document.querySelector("#shadow-host");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<button id="shadow-button" style="margin:80px;padding:24px 32px">Submit from shadow</button>';
      root.querySelector("#shadow-button").addEventListener("click", () => {
        window.__rawCdpClicks += 1;
        root.querySelector("#shadow-button").textContent = "Clicked " + window.__rawCdpClicks;
      });
    </script>
  </body>
</html>`);
  });
  await listen(iframeServer, "0.0.0.0");
  const iframePort = requireServerPort(iframeServer);
  const iframeUrl = `http://127.0.0.1:${iframePort}/iframe.html`;
  const iframeOrigin = `http://127.0.0.1:${iframePort}`;

  const mainServer = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url?.startsWith("/popup")) {
      res.end(`<!doctype html>
<html>
  <head><title>Raw CDP Popup</title></head>
  <body><main id="popup-marker">popup-ready</main></body>
</html>`);
      return;
    }
    res.end(`<!doctype html>
<html>
  <head><title>Raw CDP Main</title></head>
  <body>
    <h1>Raw CDP Main</h1>
    <iframe id="embedded-frame" src="${iframeUrl}" width="640" height="360"></iframe>
  </body>
</html>`);
  });
  await listen(mainServer, "0.0.0.0");
  const mainPort = requireServerPort(mainServer);
  const mainUrl = `http://localhost:${mainPort}/main.html`;
  const popupUrl = `http://localhost:${mainPort}/popup.html`;

  return {
    mainUrl,
    iframeUrl,
    iframeOrigin,
    popupUrl,
    close: async () => {
      await Promise.all([closeServer(mainServer), closeServer(iframeServer)]);
    },
  };
}

async function waitForTarget(
  expertLane: BrowserRawCdpExpertLane,
  browserSessionId: string,
  predicate: (target: { targetId: string; type: string; url?: string; openerId?: string }) => boolean
) {
  const deadline = Date.now() + 15_000;
  let lastTargets: unknown[] = [];
  while (Date.now() < deadline) {
    const targets = await expertLane.listExpertTargets(browserSessionId);
    lastTargets = targets;
    const target = targets.find(predicate);
    if (target) {
      return target;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for live CDP target; last targets: ${JSON.stringify(lastTargets)}`);
}

async function runtimeEvaluate(
  expertLane: BrowserRawCdpExpertLane,
  input: {
    browserSessionId: string;
    expertSessionId: string;
    expression: string;
  }
): Promise<unknown> {
  const response = await expertLane.sendExpertCommand({
    browserSessionId: input.browserSessionId,
    expertSessionId: input.expertSessionId,
    method: "Runtime.evaluate",
    params: {
      expression: input.expression,
      awaitPromise: true,
      returnByValue: true,
    },
  });
  return (response.result as { result?: { value?: unknown } }).result?.value;
}

async function dispatchMouse(
  expertLane: BrowserRawCdpExpertLane,
  input: {
    browserSessionId: string;
    expertSessionId: string;
    x: number;
    y: number;
  }
): Promise<void> {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await expertLane.sendExpertCommand({
      browserSessionId: input.browserSessionId,
      expertSessionId: input.expertSessionId,
      method: "Input.dispatchMouseEvent",
      params: {
        type,
        x: input.x,
        y: input.y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      },
    });
  }
}

async function waitForCdpEndpoint(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, "")}/json/version`);
      if (response.ok) {
        return;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for CDP endpoint ${endpoint}: ${lastError}`);
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
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function listen(server: Server, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.listen(0, host, resolve);
    server.on("error", reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function requireServerPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server did not expose a TCP port");
  }
  return address.port;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

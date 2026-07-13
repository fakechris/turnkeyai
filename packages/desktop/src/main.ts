import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, shell } from "electron";
import { verifyDesktopDaemonProof } from "@turnkeyai/shared-utils/desktop-daemon-proof";

import {
  buildDesktopDashboardUrl,
  isAllowedDesktopNavigation,
  isMatchingDaemonHealth,
  resolveDesktopConnection,
  resolveRuntimeEntry,
  type DesktopConnection,
  type DesktopRuntimeConfig,
  type DesktopTokenScope,
} from "./desktop-runtime";

const HEALTH_TIMEOUT_MS = 10_000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let dashboardUrl: string | null = null;
let daemonBaseUrl: string | null = null;
let startupPromise: Promise<void> | null = null;

interface DesktopCredential {
  token: string;
  scope: DesktopTokenScope;
}

function getTurnkeyHome(): string {
  return process.env.TURNKEYAI_HOME?.trim() || path.join(homedir(), ".turnkeyai");
}

function readRuntimeConfig(): DesktopRuntimeConfig | null {
  const configFile = path.join(getTurnkeyHome(), "config.json");
  if (!existsSync(configFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    const config: DesktopRuntimeConfig = {
      token: typeof parsed.token === "string" ? parsed.token : null,
    };
    if (typeof parsed.port === "number") config.port = parsed.port;
    return config;
  } catch {
    return null;
  }
}

async function isHealthy(
  baseUrl: string,
  credential: DesktopCredential | null = null,
  timeoutMs = 1_500
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthUrl = new URL("/health", baseUrl);
    const challenge = credential ? randomBytes(32).toString("hex") : null;
    if (credential && challenge) {
      healthUrl.searchParams.set("desktopChallenge", challenge);
      healthUrl.searchParams.set("desktopScope", credential.scope);
    }
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    if (!isMatchingDaemonHealth(payload, baseUrl)) return false;
    if (!credential || !challenge) return true;
    const proof = (payload as Record<string, unknown>).desktopProof;
    const expectedPort = Number(
      healthUrl.port || (healthUrl.protocol === "https:" ? 443 : 80)
    );
    return verifyDesktopDaemonProof(
      credential.token,
      challenge,
      credential.scope,
      expectedPort,
      proof
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl: string): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    if (await isHealthy(baseUrl, null, 1_000)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureDaemon(connection: DesktopConnection): Promise<void> {
  const credential =
    connection.token && connection.scope
      ? { token: connection.token, scope: connection.scope }
      : null;
  if (await isHealthy(connection.baseUrl, credential)) return;
  if (connection.externallyManaged) {
    throw new Error(`The configured daemon is not reachable at ${connection.baseUrl}.`);
  }

  const daemonEntry = resolveRuntimeEntry({
    packaged: app.isPackaged,
    moduleDir: MODULE_DIR,
    resourcesPath: process.resourcesPath,
  });
  if (!existsSync(daemonEntry)) {
    throw new Error(`The bundled daemon is missing: ${daemonEntry}`);
  }

  const logsDir = path.join(getTurnkeyHome(), "logs");
  mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, "daemon.log");
  const logFd = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [daemonEntry], {
      cwd: path.dirname(daemonEntry),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        TURNKEYAI_CONTROL_CENTER_DIR: path.join(path.dirname(daemonEntry), "control-center"),
      },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (!(await waitForHealth(connection.baseUrl))) {
    throw new Error(
      `TurnkeyAI daemon did not become healthy at ${connection.baseUrl}. Check ${logFile}.`
    );
  }
}

async function prepareDashboard(): Promise<{ url: string; baseUrl: string }> {
  const initial = resolveDesktopConnection(process.env, readRuntimeConfig());
  await ensureDaemon(initial);

  // The first local launch creates ~/.turnkeyai/config.json, so resolve a
  // second time after health is ready to pick up the generated token.
  const ready = resolveDesktopConnection(process.env, readRuntimeConfig());
  if (!ready.token || !ready.scope) {
    throw new Error(
      "The daemon is running, but no access token is available. Check ~/.turnkeyai/config.json or the TURNKEYAI_DAEMON_*_TOKEN environment variables."
    );
  }
  if (!(await isHealthy(ready.baseUrl, { token: ready.token, scope: ready.scope }))) {
    throw new Error(
      `The process at ${ready.baseUrl} could not prove it owns the configured TurnkeyAI daemon token.`
    );
  }
  return {
    url: buildDesktopDashboardUrl(ready.baseUrl, ready.token, ready.scope),
    baseUrl: ready.baseUrl,
  };
}

function openExternal(targetUrl: string): void {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      void shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed renderer URLs.
  }
}

async function createWindow(): Promise<BrowserWindow> {
  if (!dashboardUrl || !daemonBaseUrl) {
    throw new Error("Desktop dashboard was not prepared before creating the window.");
  }

  const window = new BrowserWindow({
    width: 1_440,
    height: 960,
    minWidth: 1_080,
    minHeight: 720,
    show: false,
    backgroundColor: "#f4f1eb",
    title: "TurnkeyAI",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // The Control Center does not need camera, microphone, geolocation, MIDI,
  // notifications, or other privileged Chromium permissions. Keep the
  // renderer deny-by-default even if connected loopback content is replaced.
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  );

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedDesktopNavigation(url, daemonBaseUrl ?? "")) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  try {
    await window.loadURL(dashboardUrl);
  } catch (error) {
    window.destroy();
    throw new Error(`The TurnkeyAI dashboard failed to load from ${dashboardUrl}.`, {
      cause: error,
    });
  }
  return window;
}

async function startDesktop(): Promise<void> {
  if (mainWindow) return;
  const prepared = await prepareDashboard();
  dashboardUrl = prepared.url;
  daemonBaseUrl = prepared.baseUrl;
  mainWindow = await createWindow();
}

function ensureDesktopStarted(): Promise<void> {
  if (mainWindow) return Promise.resolve();
  startupPromise ??= startDesktop().finally(() => {
    startupPromise = null;
  });
  return startupPromise;
}

function handleStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("TurnkeyAI could not start", message);
  app.quit();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      if (!startupPromise) void ensureDesktopStarted().catch(handleStartupError);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(ensureDesktopStarted).catch(handleStartupError);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Re-check health so reopening from the Dock also recovers a daemon
      // that exited while every desktop window was closed.
      if (!startupPromise) void ensureDesktopStarted().catch(handleStartupError);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

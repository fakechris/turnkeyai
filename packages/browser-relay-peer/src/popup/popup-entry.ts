import {
  loadChromeRelayExtensionRuntimeConfig,
  saveChromeRelayExtensionRuntimeConfig,
  type ChromeRelayExtensionRuntimeConfig,
} from "../chrome-extension-config";

import { renderPopupBody, type PopupStatusModel } from "./popup-view";

const STATUS_STORAGE_KEY = "turnkeyaiRelayStatus";
const POLL_INTERVAL_MS = 2_000;

interface StoredStatus {
  lastHeartbeatAt?: number;
  lastHeartbeatOk?: boolean;
  lastActionAt?: number;
  lastActionKind?: string;
  lastActionStatus?: "ok" | "error";
  lastError?: string;
  observedTargets?: number;
}

interface DaemonBridgeStatus {
  ok?: boolean;
  version?: string;
  transport?: { mode?: string; label?: string };
  relay?: { peerCount?: number; targetCount?: number; lastHeartbeatAgeMs?: number | null };
  expertLane?: { available?: boolean };
  peers?: Array<{ peerId: string }>;
}

async function readStoredStatus(): Promise<StoredStatus> {
  const chromeLike = (globalThis as Record<string, unknown>).chrome as {
    storage?: {
      local?: {
        get(keys: string, callback: (items: Record<string, unknown>) => void): void;
      };
    };
  } | undefined;
  const storage = chromeLike?.storage?.local;
  if (!storage) return {};
  return new Promise<StoredStatus>((resolve) => {
    storage.get(STATUS_STORAGE_KEY, (items) => {
      const value = items[STATUS_STORAGE_KEY];
      resolve(value && typeof value === "object" ? (value as StoredStatus) : {});
    });
  });
}

async function fetchDaemonStatus(
  config: ChromeRelayExtensionRuntimeConfig,
  signal: AbortSignal
): Promise<DaemonBridgeStatus | null> {
  try {
    const headers: Record<string, string> = {};
    if (config.daemonToken) headers.authorization = `Bearer ${config.daemonToken}`;
    const statusResponse = await fetch(`${config.daemonBaseUrl}/bridge/status`, {
      headers,
      signal,
    });
    if (!statusResponse.ok) return null;
    const status = (await statusResponse.json()) as DaemonBridgeStatus;
    try {
      const peersResponse = await fetch(`${config.daemonBaseUrl}/relay/peers`, {
        headers,
        signal,
      });
      if (peersResponse.ok) {
        const peersJson = (await peersResponse.json()) as { peers?: Array<{ peerId: string }> };
        status.peers = Array.isArray(peersJson.peers) ? peersJson.peers : [];
      }
    } catch {
      // peers list is optional context
    }
    return status;
  } catch {
    return null;
  }
}

function buildModel(
  config: ChromeRelayExtensionRuntimeConfig,
  daemonStatus: DaemonBridgeStatus | null,
  stored: StoredStatus,
  loading: boolean
): PopupStatusModel {
  const daemonReachable = daemonStatus ? daemonStatus.ok ?? true : false;
  const peerSeenByDaemon = daemonStatus
    ? Boolean(daemonStatus.peers?.some((peer) => peer.peerId === config.peerId))
    : null;
  return {
    daemonUrl: config.daemonBaseUrl,
    daemonToken: config.daemonToken ?? "",
    peerId: config.peerId,
    peerLabel: config.peerLabel,
    connection:
      loading && !daemonStatus
        ? "checking"
        : daemonReachable && (peerSeenByDaemon ?? true)
          ? "connected"
          : "disconnected",
    daemonReachable,
    peerSeenByDaemon,
    transportMode: daemonStatus?.transport?.mode ?? null,
    transportLabel: daemonStatus?.transport?.label ?? null,
    observedTargets: stored.observedTargets ?? 0,
    daemonPeers: daemonStatus?.relay?.peerCount ?? 0,
    daemonTargets: daemonStatus?.relay?.targetCount ?? 0,
    expertLane: daemonStatus?.expertLane?.available ?? null,
    lastHeartbeatAgeMs:
      daemonStatus?.relay?.lastHeartbeatAgeMs ??
      (stored.lastHeartbeatAt ? Date.now() - stored.lastHeartbeatAt : null),
    lastError: stored.lastError ?? null,
    version: daemonStatus?.version ?? null,
  };
}

async function refresh(loading = false): Promise<void> {
  const config = await loadChromeRelayExtensionRuntimeConfig();
  const stored = await readStoredStatus();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  const daemonStatus = await fetchDaemonStatus(config, controller.signal);
  clearTimeout(timeout);
  const model = buildModel(config, daemonStatus, stored, loading);
  document.body.innerHTML = renderPopupBody(model);
  wireInteractions(config);
}

function wireInteractions(config: ChromeRelayExtensionRuntimeConfig): void {
  document.getElementById("btn-reconnect")?.addEventListener("click", () => {
    sendServiceWorkerMessage({ type: "turnkeyai.relay.popup-action-reconnect" });
  });
  document.getElementById("btn-copy")?.addEventListener("click", async () => {
    const redactedConfig = {
      ...config,
      daemonToken: config.daemonToken ? "***redacted***" : null,
    };
    const payload = { config: redactedConfig, takenAt: new Date().toISOString() };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      flashMessage("copied diagnostics");
    } catch {
      flashMessage("clipboard unavailable");
    }
  });
  document.getElementById("btn-open")?.addEventListener("click", () => {
    const chromeLike = (globalThis as Record<string, unknown>).chrome as {
      tabs?: { create?: (input: { url: string }) => void };
    } | undefined;
    chromeLike?.tabs?.create?.({ url: config.daemonBaseUrl });
  });
  document.getElementById("settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const daemonUrl = String(data.get("daemonUrl") ?? "").trim();
    const daemonToken = String(data.get("daemonToken") ?? "").trim();
    const peerLabel = String(data.get("peerLabel") ?? "").trim();
    try {
      await saveChromeRelayExtensionRuntimeConfig({
        daemonBaseUrl: daemonUrl,
        ...(daemonToken ? { daemonToken } : {}),
        ...(peerLabel ? { peerLabel } : {}),
      });
      sendServiceWorkerMessage({ type: "turnkeyai.relay.popup-config-update" });
      flashMessage("saved");
      await refresh();
    } catch (error) {
      flashMessage(`save failed: ${(error as Error).message}`);
    }
  });
}

function sendServiceWorkerMessage(message: Record<string, unknown>): void {
  const chromeLike = (globalThis as Record<string, unknown>).chrome as {
    runtime?: { sendMessage?: (message: unknown) => Promise<unknown> | unknown };
  } | undefined;
  try {
    void chromeLike?.runtime?.sendMessage?.(message);
  } catch {
    // ignore — service worker may be inactive
  }
}

function flashMessage(text: string): void {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

void refresh(true);
const pollHandle = setInterval(() => {
  void refresh(false);
}, POLL_INTERVAL_MS);

window.addEventListener("unload", () => clearInterval(pollHandle));

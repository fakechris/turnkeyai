declare const __TURNKEYAI_RELAY_DAEMON_URL__: string | undefined;

export interface ChromeRelayExtensionRuntimeConfig {
  daemonBaseUrl: string;
  daemonToken?: string;
  peerId: string;
  peerLabel: string;
  capabilities: string[];
  transportLabel: string;
  activeDelayMs: number;
  idleDelayMs: number;
  errorDelayMs: number;
}

interface ChromeStorageLocalLike {
  get(
    keys: string | string[] | Record<string, unknown> | null | undefined,
    callback: (items: Record<string, unknown>) => void
  ): void;
}

const STORAGE_KEY = "turnkeyaiRelayConfig";
const DEFAULT_DAEMON_BASE_URL = resolveDefaultDaemonBaseUrl();

const DEFAULT_RUNTIME_CONFIG: ChromeRelayExtensionRuntimeConfig = {
  daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
  peerId: "turnkeyai-relay-peer",
  peerLabel: "TurnkeyAI Chrome Relay",
  capabilities: ["open", "snapshot", "click", "type", "scroll", "console", "screenshot"],
  transportLabel: "chrome-extension-relay",
  activeDelayMs: 25,
  idleDelayMs: 500,
  errorDelayMs: 1_000,
};

export async function loadChromeRelayExtensionRuntimeConfig(): Promise<ChromeRelayExtensionRuntimeConfig> {
  const chromeLike = (globalThis as Record<string, unknown>).chrome as {
    storage?: {
      local?: ChromeStorageLocalLike;
    };
    runtime?: {
      id?: string;
    };
  } | undefined;

  const runtimeId = chromeLike?.runtime?.id?.trim() || "chrome-extension";
  const stored = await readStoredRelayConfig(chromeLike?.storage?.local);

  return {
    daemonBaseUrl: normalizeUrl(asOptionalString(stored.daemonBaseUrl) ?? DEFAULT_RUNTIME_CONFIG.daemonBaseUrl),
    ...(asOptionalString(stored.daemonToken) ? { daemonToken: asOptionalString(stored.daemonToken)! } : {}),
    peerId: asOptionalString(stored.peerId) ?? `${DEFAULT_RUNTIME_CONFIG.peerId}:${runtimeId}`,
    peerLabel: asOptionalString(stored.peerLabel) ?? DEFAULT_RUNTIME_CONFIG.peerLabel,
    capabilities: normalizeStringArray(stored.capabilities, DEFAULT_RUNTIME_CONFIG.capabilities),
    transportLabel: asOptionalString(stored.transportLabel) ?? DEFAULT_RUNTIME_CONFIG.transportLabel,
    activeDelayMs: normalizePositiveInteger(stored.activeDelayMs, DEFAULT_RUNTIME_CONFIG.activeDelayMs),
    idleDelayMs: normalizePositiveInteger(stored.idleDelayMs, DEFAULT_RUNTIME_CONFIG.idleDelayMs),
    errorDelayMs: normalizePositiveInteger(stored.errorDelayMs, DEFAULT_RUNTIME_CONFIG.errorDelayMs),
  };
}

async function readStoredRelayConfig(storageLocal?: ChromeStorageLocalLike): Promise<Record<string, unknown>> {
  if (!storageLocal) {
    return {};
  }

  return new Promise<Record<string, unknown>>((resolve) => {
    storageLocal.get(STORAGE_KEY, (items) => {
      const value = items[STORAGE_KEY];
      resolve(value && typeof value === "object" ? (value as Record<string, unknown>) : {});
    });
  });
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const next = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  return next.length ? next : [...fallback];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveDefaultDaemonBaseUrl(): string {
  const injectedValue =
    typeof __TURNKEYAI_RELAY_DAEMON_URL__ !== "undefined" ? __TURNKEYAI_RELAY_DAEMON_URL__ : undefined;
  return normalizeUrl(injectedValue || "http://127.0.0.1:4100");
}

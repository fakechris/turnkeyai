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
  pullWaitMs: number;
}

interface ChromeStorageLocalLike {
  get(
    keys: string | string[] | Record<string, unknown> | null | undefined,
    callback: (items: Record<string, unknown>) => void
  ): void;
  set?(items: Record<string, unknown>, callback?: () => void): void;
  remove?(keys: string | string[], callback?: () => void): void;
}

export type ChromeRelayExtensionRuntimeConfigPatch = Partial<
  Pick<
    ChromeRelayExtensionRuntimeConfig,
    "daemonBaseUrl" | "daemonToken" | "peerId" | "peerLabel"
  >
>;

const STORAGE_KEY = "turnkeyaiRelayConfig";
const DEFAULT_DAEMON_BASE_URL = resolveDefaultDaemonBaseUrl();

const DEFAULT_RUNTIME_CONFIG: ChromeRelayExtensionRuntimeConfig = {
  daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
  peerId: "turnkeyai-relay-peer",
  peerLabel: "TurnkeyAI Chrome Relay",
  capabilities: [
    "open",
    "snapshot",
    "click",
    "type",
    "hover",
    "key",
    "select",
    "drag",
    "scroll",
    "console",
    "probe",
    "permission",
    "wait",
    "waitFor",
    "dialog",
    "popup",
    "storage",
    "cookie",
    "eval",
    "network",
    "download",
    "upload",
    "screenshot",
    "cdp",
  ],
  transportLabel: "chrome-extension-relay",
  activeDelayMs: 25,
  idleDelayMs: 500,
  errorDelayMs: 1_000,
  pullWaitMs: 25_000,
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
    pullWaitMs: normalizeNonNegativeInteger(stored.pullWaitMs, DEFAULT_RUNTIME_CONFIG.pullWaitMs),
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

export async function saveChromeRelayExtensionRuntimeConfig(
  patch: ChromeRelayExtensionRuntimeConfigPatch
): Promise<ChromeRelayExtensionRuntimeConfig> {
  const chromeLike = (globalThis as Record<string, unknown>).chrome as {
    storage?: { local?: ChromeStorageLocalLike };
  } | undefined;
  const storageLocal = chromeLike?.storage?.local;
  if (!storageLocal?.set) {
    throw new Error("chrome.storage.local.set is unavailable");
  }
  const existing = await readStoredRelayConfig(storageLocal);
  const next = pruneStoredRelayConfig({
    ...existing,
    ...filterDefinedKeys(patch),
  });
  await new Promise<void>((resolve) => {
    storageLocal.set!({ [STORAGE_KEY]: next }, () => resolve());
  });
  return loadChromeRelayExtensionRuntimeConfig();
}

function filterDefinedKeys<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function pruneStoredRelayConfig(record: Record<string, unknown>): Record<string, unknown> {
  const allowedKeys: Array<keyof ChromeRelayExtensionRuntimeConfig> = [
    "daemonBaseUrl",
    "daemonToken",
    "peerId",
    "peerLabel",
    "capabilities",
    "transportLabel",
    "activeDelayMs",
    "idleDelayMs",
    "errorDelayMs",
    "pullWaitMs",
  ];
  const out: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (record[key] !== undefined) {
      out[key] = record[key];
    }
  }
  return out;
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

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveDefaultDaemonBaseUrl(): string {
  const injectedValue =
    typeof __TURNKEYAI_RELAY_DAEMON_URL__ !== "undefined" ? __TURNKEYAI_RELAY_DAEMON_URL__ : undefined;
  return normalizeUrl(injectedValue || "http://127.0.0.1:4100");
}

export interface ChromeRelayExtensionManifestOptions {
  name?: string;
  version?: string;
  description?: string;
  matches: string[];
  daemonOrigins?: string[];
  permissions?: string[];
}

export interface ChromeExtensionManifest {
  manifest_version: 3;
  name: string;
  version: string;
  description: string;
  background: {
    service_worker: string;
    type: "module";
  };
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{
    matches: string[];
    js: string[];
    run_at: "document_idle";
    all_frames: boolean;
  }>;
}

const DEFAULT_PERMISSIONS = ["storage", "tabs", "scripting", "activeTab", "alarms", "debugger"];
const DEFAULT_DAEMON_ORIGINS = ["http://127.0.0.1:4100/*", "http://localhost:4100/*"];

export function buildChromeRelayExtensionManifest(
  options: ChromeRelayExtensionManifestOptions
): ChromeExtensionManifest {
  const matches = uniqueTrimmed(options.matches);
  if (!matches.length) {
    throw new Error("chrome relay extension manifest requires at least one page match pattern");
  }

  const permissions = uniqueTrimmed(options.permissions ?? DEFAULT_PERMISSIONS);
  const daemonOrigins = uniqueTrimmed(options.daemonOrigins ?? DEFAULT_DAEMON_ORIGINS);

  return {
    manifest_version: 3,
    name: options.name?.trim() || "TurnkeyAI Relay Bridge",
    version: options.version?.trim() || "0.1.0",
    description:
      options.description?.trim() ||
      "Attach TurnkeyAI to your existing Chrome tabs through a local relay daemon.",
    background: {
      service_worker: "service-worker.js",
      type: "module",
    },
    permissions,
    host_permissions: [...matches, ...daemonOrigins],
    content_scripts: [
      {
        matches,
        js: ["content-script.js"],
        run_at: "document_idle",
        all_frames: true,
      },
    ],
  };
}

function uniqueTrimmed(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

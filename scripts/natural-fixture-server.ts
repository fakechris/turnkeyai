import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  applyNaturalFixtureUrlOverrides,
  buildNaturalScenarioSpec,
  startFixtureServer,
  type FixtureServer,
  type NaturalMissionE2eScenario,
} from "./mission-tool-use-e2e";

const BROWSER_FOCUSED_SCENARIOS = [
  "natural-browser-external-page-review",
  "natural-browser-complex-page-review",
] as const satisfies readonly NaturalMissionE2eScenario[];

export interface NaturalFixtureServerManifest {
  kind: "turnkeyai.natural-fixture-server.manifest";
  urls: {
    externalPageUrl?: string;
    complexBrowserUrl: string;
    dashboardUrl: string;
    dynamicUrl: string;
  };
  scenarios: Array<{
    scenario: (typeof BROWSER_FOCUSED_SCENARIOS)[number];
    prompt: string;
  }>;
}

export interface NaturalFixtureServerCliOptions {
  port?: number;
  manifestOut?: string;
  envOut?: string;
  help?: boolean;
}

export function parseNaturalFixtureServerArgs(args: string[]): NaturalFixtureServerCliOptions {
  const options: NaturalFixtureServerCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (!value) throw new Error("--port requires a value");
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
      options.port = port;
      index += 1;
      continue;
    }
    if (arg === "--manifest-out") {
      const value = args[index + 1];
      if (!value) throw new Error("--manifest-out requires a value");
      options.manifestOut = value;
      index += 1;
      continue;
    }
    if (arg === "--env-out") {
      const value = args[index + 1];
      if (!value) throw new Error("--env-out requires a value");
      options.envOut = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg ?? ""}`);
  }
  return options;
}

export function buildNaturalFixtureServerHelpText(): string {
  return [
    "Usage: npm run mission:e2e:fixtures -- [options]",
    "",
    "Options:",
    "  --port <port>           Bind the fixture server to a stable localhost port",
    "  --manifest-out <path>   Write browser-focused prompt/URL manifest JSON",
    "  --env-out <path>        Write shell exports for natural browser URL overrides",
    "  --help, -h              Show this help and exit",
  ].join("\n");
}

export function buildNaturalFixtureServerManifest(fixture: FixtureServer): NaturalFixtureServerManifest {
  return {
    kind: "turnkeyai.natural-fixture-server.manifest",
    urls: {
      ...(fixture.externalPageUrl ? { externalPageUrl: fixture.externalPageUrl } : {}),
      complexBrowserUrl: fixture.complexBrowserUrl,
      dashboardUrl: fixture.dashboardUrl,
      dynamicUrl: fixture.dynamicUrl,
    },
    scenarios: BROWSER_FOCUSED_SCENARIOS.map((scenario) => ({
      scenario,
      prompt: buildNaturalScenarioSpec(scenario, fixture).desc,
    })),
  };
}

export function buildNaturalFixtureEnvFile(manifest: NaturalFixtureServerManifest): string {
  const entries = [
    ["TURNKEYAI_NATURAL_COMPLEX_BROWSER_URL", manifest.urls.complexBrowserUrl],
    ["TURNKEYAI_NATURAL_DASHBOARD_URL", manifest.urls.dashboardUrl],
    ["TURNKEYAI_NATURAL_DYNAMIC_URL", manifest.urls.dynamicUrl],
    ...(manifest.urls.externalPageUrl
      ? ([["TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL", manifest.urls.externalPageUrl]] as const)
      : []),
  ] as const;
  return `${entries.map(([key, value]) => `export ${key}=${quoteShellValue(value)}`).join("\n")}\n`;
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function runNaturalFixtureServerCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseNaturalFixtureServerArgs(args);
  if (options.help) {
    console.log(buildNaturalFixtureServerHelpText());
    return;
  }
  const fixture = applyNaturalFixtureUrlOverrides(await startFixtureServer({ port: options.port }));
  const manifest = buildNaturalFixtureServerManifest(fixture);
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.manifestOut) {
    await writeFile(options.manifestOut, manifestJson);
  }
  if (options.envOut) {
    await writeFile(options.envOut, buildNaturalFixtureEnvFile(manifest));
  }
  console.log(manifestJson.trimEnd());
  console.error("natural fixture server running; press Ctrl-C to stop");

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      fixture.server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNaturalFixtureServerCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

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

export async function runNaturalFixtureServerCli(): Promise<void> {
  const fixture = applyNaturalFixtureUrlOverrides(await startFixtureServer());
  const manifest = buildNaturalFixtureServerManifest(fixture);
  console.log(JSON.stringify(manifest, null, 2));
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

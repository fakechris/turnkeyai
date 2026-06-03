import assert from "node:assert/strict";
import test from "node:test";

import { buildNaturalFixtureServerManifest } from "./natural-fixture-server";
import { applyNaturalFixtureUrlOverrides, startFixtureServer } from "./mission-tool-use-e2e";

test("natural fixture server manifest exposes browser-focused prompts and URLs", async () => {
  const fixture = applyNaturalFixtureUrlOverrides(await startFixtureServer(), {
    TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL: "https://news.ycombinator.com/",
  } as NodeJS.ProcessEnv);
  try {
    const manifest = buildNaturalFixtureServerManifest(fixture);
    assert.equal(manifest.kind, "turnkeyai.natural-fixture-server.manifest");
    assert.equal(manifest.urls.externalPageUrl, "https://news.ycombinator.com/");
    assert.match(manifest.urls.complexBrowserUrl, /^http:\/\/127\.0\.0\.1:\d+\/complex-browser$/);
    assert.deepEqual(
      manifest.scenarios.map((scenario) => scenario.scenario),
      ["natural-browser-external-page-review", "natural-browser-complex-page-review"]
    );
    assert.match(manifest.scenarios[0]!.prompt, /https:\/\/news\.ycombinator\.com\//);
    assert.match(manifest.scenarios[1]!.prompt, new RegExp(manifest.urls.complexBrowserUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const response = await fetch(manifest.urls.complexBrowserUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Complex browser workbench/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      fixture.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

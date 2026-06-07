import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNaturalFixtureEnvFile,
  buildNaturalFixtureServerHelpText,
  buildNaturalFixtureServerManifest,
  parseNaturalFixtureServerArgs,
} from "./natural-fixture-server";
import { applyNaturalFixtureUrlOverrides, startFixtureServer } from "./mission-tool-use-e2e";

test("natural fixture server manifest exposes core fixture URLs and browser-focused prompts", async () => {
  const fixture = applyNaturalFixtureUrlOverrides(await startFixtureServer(), {
    TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL: "https://news.ycombinator.com/",
  } as NodeJS.ProcessEnv);
  try {
    const manifest = buildNaturalFixtureServerManifest(fixture);
    assert.equal(manifest.kind, "turnkeyai.natural-fixture-server.manifest");
    assert.equal(manifest.urls.externalPageUrl, "https://news.ycombinator.com/");
    assert.match(manifest.urls.alphaUrl, /^http:\/\/127\.0\.0\.1:\d+\/vendor-alpha$/);
    assert.match(manifest.urls.betaUrl, /^http:\/\/127\.0\.0\.1:\d+\/vendor-beta$/);
    assert.match(manifest.urls.slowUrl, /^http:\/\/127\.0\.0\.1:\d+\/slow-fixture$/);
    assert.match(manifest.urls.approvalUrl, /^http:\/\/127\.0\.0\.1:\d+\/approval-form$/);
    assert.match(manifest.urls.complexBrowserUrl, /^http:\/\/127\.0\.0\.1:\d+\/complex-browser$/);
    assert.match(
      manifest.fixtureContentHashes["http://<loopback-host>:<loopback-port>/complex-browser"] ?? "",
      /^sha256:[a-f0-9]{64}$/
    );
    assert.match(
      manifest.fixtureContentHashes["http://<loopback-host>:<loopback-port>/ops-dashboard"] ?? "",
      /^sha256:[a-f0-9]{64}$/
    );
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

test("natural fixture server supports a stable requested port", async () => {
  const first = await startFixtureServer();
  const port = Number(new URL(first.complexBrowserUrl).port);
  await new Promise<void>((resolve, reject) => {
    first.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const fixture = await startFixtureServer({ port });
  try {
    assert.equal(new URL(fixture.complexBrowserUrl).port, String(port));
    assert.equal(new URL(fixture.dashboardUrl).port, String(port));
    assert.equal(new URL(fixture.dynamicUrl).port, String(port));
  } finally {
    await new Promise<void>((resolve, reject) => {
      fixture.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("natural fixture env file exports core URL overrides", async () => {
  const fixture = applyNaturalFixtureUrlOverrides(await startFixtureServer(), {
    TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL: "https://example.com/browser?q=owner's-review",
  } as NodeJS.ProcessEnv);
  try {
    const manifest = buildNaturalFixtureServerManifest(fixture);
    const envFile = buildNaturalFixtureEnvFile(manifest);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_COMPLEX_BROWSER_URL='http:\/\/127\.0\.0\.1:\d+\/complex-browser'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_ALPHA_URL='http:\/\/127\.0\.0\.1:\d+\/vendor-alpha'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_BETA_URL='http:\/\/127\.0\.0\.1:\d+\/vendor-beta'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_SLOW_URL='http:\/\/127\.0\.0\.1:\d+\/slow-fixture'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_CANCEL_RESUME_URL='http:\/\/127\.0\.0\.1:\d+\/cancel-resume-fixture'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_APPROVAL_URL='http:\/\/127\.0\.0\.1:\d+\/approval-form'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_DASHBOARD_URL='http:\/\/127\.0\.0\.1:\d+\/ops-dashboard'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_DYNAMIC_URL='http:\/\/127\.0\.0\.1:\d+\/dynamic-dashboard'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_ORCHESTRATION_URL='http:\/\/127\.0\.0\.1:\d+\/product-orchestration'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_BRIDGE_URL='http:\/\/127\.0\.0\.1:\d+\/product-bridge'$/m);
    assert.match(envFile, /^export TURNKEYAI_NATURAL_PRODUCT_SIGNALS_URL='http:\/\/127\.0\.0\.1:\d+\/product-signals'$/m);
    assert.match(
      envFile,
      /^export TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL='https:\/\/example\.com\/browser\?q=owner%27s-review'$/m
    );

    const rawQuoteEnvFile = buildNaturalFixtureEnvFile({
      ...manifest,
      urls: {
        ...manifest.urls,
        externalPageUrl: "https://example.com/browser?q=owner's-review",
      },
    });
    assert.match(
      rawQuoteEnvFile,
      /^export TURNKEYAI_NATURAL_EXTERNAL_BROWSER_URL='https:\/\/example\.com\/browser\?q=owner'\\''s-review'$/m
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      fixture.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("natural fixture server CLI parses output and port options", () => {
  assert.deepEqual(parseNaturalFixtureServerArgs(["--port", "51277", "--manifest-out", "manifest.json", "--env-out", "fixture.env"]), {
    port: 51277,
    manifestOut: "manifest.json",
    envOut: "fixture.env",
  });
  assert.deepEqual(parseNaturalFixtureServerArgs(["--help"]), { help: true });
  assert.throws(() => parseNaturalFixtureServerArgs(["--port", "nope"]), /--port must be an integer/);
  assert.match(buildNaturalFixtureServerHelpText(), /--manifest-out/);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildControlCenterStartupBanner } from "./daemon-startup-banner";

describe("buildControlCenterStartupBanner", () => {
  it("points authenticated users at the launcher instead of a bare /app URL", () => {
    const lines = buildControlCenterStartupBanner({
      port: 4100,
      assetAvailable: true,
      authMode: "token",
      tokenGenerated: true,
      configFile: "/home/user/.turnkeyai/config.json",
    });

    assert.match(lines.join("\n"), /turnkeyai app/);
    assert.match(lines.join("\n"), /npx @turnkeyai\/cli app/);
    assert.match(lines.join("\n"), /npm run app -- --no-open/);
    assert.match(lines.join("\n"), /direct URL http:\/\/127\.0\.0\.1:4100\/app requires a token/);
    assert.match(lines.join("\n"), /generated token written to \/home\/user\/\.turnkeyai\/config\.json/);
    assert.notEqual(lines[0], "control center: http://127.0.0.1:4100/app");
  });

  it("prints the direct URL only when daemon auth is disabled", () => {
    assert.deepEqual(
      buildControlCenterStartupBanner({
        port: 4100,
        assetAvailable: true,
        authMode: "disabled",
        tokenGenerated: false,
        configFile: "/home/user/.turnkeyai/config.json",
      }),
      ["control center: http://127.0.0.1:4100/app"]
    );
  });

  it("reports a missing Control Center bundle", () => {
    assert.deepEqual(
      buildControlCenterStartupBanner({
        port: 4100,
        assetAvailable: false,
        authMode: "token",
        tokenGenerated: false,
        configFile: "/home/user/.turnkeyai/config.json",
      }),
      ["control center: (bundle not found; rebuild @turnkeyai/cli)"]
    );
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import { DefaultCapabilityDiscoveryService } from "./capability-discovery-service";

test("capability discovery reports worker, connector, api, and transport readiness", async () => {
  const previousShopifyStoreUrl = process.env.SHOPIFY_STORE_URL;
  const previousShopifyAccessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  process.env.SHOPIFY_STORE_URL = "https://example.myshopify.com";
  process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test";

  try {
    const service = new DefaultCapabilityDiscoveryService({
      availableWorkers: ["browser", "finance"],
      skills: [{ skillId: "shopify-builder", installed: true, capability: "shopify" }],
      now: () => 123,
    });

    const result = await service.inspect({
      threadId: "thread-1",
      roleId: "role-operator",
      requestedCapabilities: ["shopify", "browser"],
      preferredWorkerKinds: ["browser"],
    });

    assert.deepEqual(result.availableWorkers, ["browser", "finance"]);
    assert.equal(result.generatedAt, 123);
    assert.equal(result.connectorStates.some((entry) => entry.provider === "shopify" && entry.authorized), true);
    assert.equal(result.apiStates.some((entry) => entry.name === "shopify-admin" && entry.ready), true);
    assert.equal(result.skillStates.some((entry) => entry.skillId === "shopify-builder" && entry.installed), true);
    assert.deepEqual(
      result.transportPreferences.find((entry) => entry.capability === "shopify")?.orderedTransports,
      ["official_api", "business_tool", "browser"]
    );
    assert.deepEqual(
      result.transportPreferences.find((entry) => entry.capability === "browser")?.orderedTransports,
      ["browser"]
    );
  } finally {
    restoreEnv("SHOPIFY_STORE_URL", previousShopifyStoreUrl);
    restoreEnv("SHOPIFY_ACCESS_TOKEN", previousShopifyAccessToken);
  }
});

test("capability discovery prefers official api before browser for explore flows", async () => {
  const service = new DefaultCapabilityDiscoveryService({
    availableWorkers: ["explore", "browser"],
    now: () => 456,
  });

  const result = await service.inspect({
    threadId: "thread-1",
    roleId: "role-explore",
    requestedCapabilities: ["explore"],
    preferredWorkerKinds: ["explore"],
  });

  assert.deepEqual(
    result.transportPreferences.find((entry) => entry.capability === "explore")?.orderedTransports,
    ["official_api", "business_tool", "browser"]
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

import assert from "node:assert/strict";
import test from "node:test";

import { DefaultApiExecutionVerifier } from "./api-execution-verifier";

test("api execution verifier diagnoses missing scopes before generic business errors", () => {
  const verifier = new DefaultApiExecutionVerifier();

  const report = verifier.verify({
    apiName: "shopify-admin",
    operation: "productCreate",
    transport: "official_api",
    statusCode: 403,
    requiredScopes: ["write_products"],
    grantedScopes: [],
    responseBody: {
      userErrors: [{ message: "Access denied for productCreate field." }],
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.category, "scope");
  assert.equal(report.suggestedActions.includes("grant required scopes for shopify-admin"), true);
});

test("api execution verifier surfaces schema errors as non-retryable", () => {
  const verifier = new DefaultApiExecutionVerifier();

  const report = verifier.verify({
    apiName: "shopify-admin",
    operation: "productCreate",
    transport: "official_api",
    schemaErrors: ["Field 'bodyHtml' does not exist on ProductInput"],
  });

  assert.equal(report.ok, false);
  assert.equal(report.category, "schema");
  assert.equal(report.retryable, false);
});

test("api execution verifier does not misclassify generic 403 responses as scope failures", () => {
  const verifier = new DefaultApiExecutionVerifier();

  const report = verifier.verify({
    apiName: "openai-pricing",
    operation: "fetch_public_pricing_page",
    transport: "official_api",
    statusCode: 403,
    responseBody: {
      excerpt: "Enable JavaScript and cookies to continue",
    },
  });

  assert.equal(report.category, "business");
});

test("api execution verifier treats 429 as a retryable network diagnosis", () => {
  const verifier = new DefaultApiExecutionVerifier();

  const report = verifier.verify({
    apiName: "openai-pricing",
    operation: "fetch_public_pricing_page",
    transport: "official_api",
    statusCode: 429,
  });

  assert.equal(report.category, "network");
  assert.equal(report.retryable, true);
});

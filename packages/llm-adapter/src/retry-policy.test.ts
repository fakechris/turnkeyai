import assert from "node:assert/strict";
import test from "node:test";

import { RequestEnvelopeOverflowError } from "./request-envelope-guard";
import {
  createRetryAllowance,
  decideProviderRetry,
  type ProviderRetryPolicy,
} from "./retry-policy";
import { ProviderRequestError } from "./types";

test("retry allowance is consumed once across one failure domain", () => {
  const allowance = createRetryAllowance({
    allowanceId: "allowance-1",
    ownerScopeId: "gateway-call-1",
    failureDomain: "model_transport",
    maxAttempts: 2,
  });

  assert.equal(allowance.claimAttempt(), true);
  assert.equal(allowance.claimAttempt(), true);
  assert.equal(allowance.claimAttempt(), false);
  assert.deepEqual(allowance.snapshot(), {
    allowanceId: "allowance-1",
    ownerScopeId: "gateway-call-1",
    failureDomain: "model_transport",
    initialAttempts: 2,
    remainingAttempts: 0,
  });
});

const policy: ProviderRetryPolicy = {
  transientMaxAttempts: 3,
  timeoutMaxAttempts: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 20_000,
};

test("retry policy honors Retry-After for a retryable provider response", () => {
  const decision = decideProviderRetry({
    error: new ProviderRequestError("rate limited", {
      code: "rate_limit",
      status: 429,
      retryable: true,
      retryAfterMs: 2_500,
    }),
    attempt: 1,
    policy,
    random: () => 0.5,
  });

  assert.deepEqual(decision, { retry: true, delayMs: 2_500 });
});

test("retry policy caps transient and timeout attempts independently", () => {
  const transient = new ProviderRequestError("server error", {
    code: "server_error",
    status: 503,
    retryable: true,
  });
  const timeout = new ProviderRequestError("timed out", {
    code: "timeout",
    retryable: true,
  });

  assert.equal(decideProviderRetry({ error: transient, attempt: 2, policy, random: () => 0 }).retry, true);
  assert.equal(decideProviderRetry({ error: transient, attempt: 3, policy, random: () => 0 }).retry, false);
  assert.equal(decideProviderRetry({ error: timeout, attempt: 1, policy, random: () => 0 }).retry, true);
  assert.equal(decideProviderRetry({ error: timeout, attempt: 2, policy, random: () => 0 }).retry, false);
});

test("retry policy never retries authentication or request-envelope failures", () => {
  const auth = new ProviderRequestError("unauthorized", {
    code: "authentication",
    status: 401,
    retryable: false,
  });
  const envelope = new RequestEnvelopeOverflowError({
    diagnostics: {
      messageCount: 17,
      promptChars: 1,
      promptBytes: 1,
      metadataBytes: 0,
      artifactCount: 0,
      toolCount: 0,
      toolSchemaBytes: 0,
      toolResultCount: 0,
      toolResultBytes: 0,
      inlineAttachmentBytes: 0,
      inlineImageCount: 0,
      inlineImageBytes: 0,
      inlinePdfCount: 0,
      inlinePdfBytes: 0,
      multimodalPartCount: 0,
      totalSerializedBytes: 1,
      overLimitKeys: ["messageCount"],
    },
  });

  assert.equal(decideProviderRetry({ error: auth, attempt: 1, policy, random: () => 0 }).retry, false);
  assert.equal(decideProviderRetry({ error: envelope, attempt: 1, policy, random: () => 0 }).retry, false);
});

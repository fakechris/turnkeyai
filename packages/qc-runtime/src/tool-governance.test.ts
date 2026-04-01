import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApiDiagnosisReport,
  PermissionCacheRecord,
} from "@turnkeyai/core-types/team";

import { DefaultEvidenceTrustPolicy } from "./evidence-trust-policy";
import { DefaultPermissionGovernancePolicy } from "./permission-governance-policy";
import { DefaultPromptAdmissionPolicy } from "./prompt-admission-policy";

test("permission governance policy marks write API scope failures as denied with browser fallback", () => {
  const policy = new DefaultPermissionGovernancePolicy();

  const evaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "explore",
    payload: {
      apiAttempt: {
        operation: "productCreate",
      },
      trace: [{ kind: "open" }],
    },
    apiDiagnosis: [
      {
        ok: false,
        category: "scope",
        retryable: false,
        issues: ["missing scopes: write_products"],
        suggestedActions: ["grant required scopes for Shopify Admin"],
      },
    ],
    transportAudit: {
      capability: "explore",
      preferredOrder: ["official_api", "browser"],
      attemptedTransports: ["official_api"],
      finalTransport: "official_api",
      downgraded: true,
      fallbackReason: "missing scope",
      trustLevel: "observational",
    },
  });

  assert.equal(evaluation.requirement.level, "approval");
  assert.equal(evaluation.requirement.scope, "mutate");
  assert.equal(evaluation.decision, "denied");
  assert.equal(evaluation.recommendedAction, "fallback_browser");
  assert.equal(evaluation.fallbackTransport, "browser");
});

test("permission governance policy reuses cached decisions", () => {
  const policy = new DefaultPermissionGovernancePolicy();
  const cachedDecision: PermissionCacheRecord = {
    cacheKey: "thread-1:browser:navigate:confirm",
    threadId: "thread-1",
    workerType: "browser",
    requirement: {
      level: "confirm",
      scope: "navigate",
      rationale: "interactive browser action",
      cacheKey: "thread-1:browser:navigate:confirm",
    },
    decision: "granted",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: Date.now() + 60_000,
  };

  const evaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "browser",
    payload: {
      trace: [{ kind: "click" }],
    },
    apiDiagnosis: [],
    cachedDecision,
  });

  assert.equal(evaluation.source, "cache");
  assert.equal(evaluation.decision, "granted");
  assert.equal(evaluation.requirement.level, "confirm");
});

test("permission governance policy ignores expired cache entries using injected time source", () => {
  const policy = new DefaultPermissionGovernancePolicy();
  const cachedDecision: PermissionCacheRecord = {
    cacheKey: "thread-1:browser:navigate:confirm",
    threadId: "thread-1",
    workerType: "browser",
    requirement: {
      level: "confirm",
      scope: "navigate",
      rationale: "interactive browser action",
      cacheKey: "thread-1:browser:navigate:confirm",
    },
    decision: "granted",
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 100,
  };

  const evaluation = policy.evaluate({
    now: 101,
    threadId: "thread-1",
    workerType: "browser",
    payload: {
      trace: [{ kind: "click" }],
    },
    apiDiagnosis: [],
    cachedDecision,
  });

  assert.equal(evaluation.source, "policy");
  assert.equal(evaluation.decision, "prompt_required");
});

test("permission governance policy does not escalate noun-based read operations to publish approval", () => {
  const policy = new DefaultPermissionGovernancePolicy();

  const evaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "explore",
    payload: {
      apiAttempt: {
        operation: "getPost",
      },
      trace: [{ kind: "open" }],
    },
    apiDiagnosis: [],
    transportAudit: {
      capability: "explore",
      preferredOrder: ["official_api", "browser"],
      attemptedTransports: ["official_api"],
      finalTransport: "official_api",
      downgraded: false,
      trustLevel: "promotable",
    },
  });

  assert.equal(evaluation.requirement.level, "none");
  assert.equal(evaluation.requirement.scope, "read");
  assert.equal(evaluation.decision, "granted");
});

test("permission governance policy catches verb-first write and publish operations", () => {
  const policy = new DefaultPermissionGovernancePolicy();

  const writeEvaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "explore",
    payload: {
      apiAttempt: {
        operation: "createProduct",
      },
    },
    apiDiagnosis: [],
  });

  const publishEvaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "explore",
    payload: {
      apiAttempt: {
        operation: "publishArticle",
      },
    },
    apiDiagnosis: [],
  });

  assert.equal(writeEvaluation.requirement.level, "approval");
  assert.equal(writeEvaluation.requirement.scope, "mutate");
  assert.equal(writeEvaluation.decision, "prompt_required");

  assert.equal(publishEvaluation.requirement.level, "approval");
  assert.equal(publishEvaluation.requirement.scope, "publish");
  assert.equal(publishEvaluation.decision, "prompt_required");
});

test("permission governance policy treats upsert operations as mutating writes", () => {
  const policy = new DefaultPermissionGovernancePolicy();

  const evaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "explore",
    payload: {
      apiAttempt: {
        operation: "upsertRecord",
      },
    },
    apiDiagnosis: [],
  });

  assert.equal(evaluation.requirement.level, "approval");
  assert.equal(evaluation.requirement.scope, "mutate");
  assert.equal(evaluation.decision, "prompt_required");
});

test("permission governance policy keeps delimiter-style read operations read-only", () => {
  const policy = new DefaultPermissionGovernancePolicy();

  const underscoreEvaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "explore",
    payload: {
      apiAttempt: {
        operation: "get_post",
      },
    },
    apiDiagnosis: [],
  });

  const dashEvaluation = policy.evaluate({
    threadId: "thread-1",
    workerType: "explore",
    payload: {
      apiAttempt: {
        operation: "get-post",
      },
    },
    apiDiagnosis: [],
  });

  assert.equal(underscoreEvaluation.requirement.scope, "read");
  assert.equal(underscoreEvaluation.decision, "granted");
  assert.equal(dashEvaluation.requirement.scope, "read");
  assert.equal(dashEvaluation.decision, "granted");
});

test("evidence trust policy keeps verified read-only browser evidence promotable", () => {
  const policy = new DefaultEvidenceTrustPolicy();

  const assessment = policy.assess({
    workerType: "browser",
    workerStatus: "completed",
    payload: {
      trace: [{ kind: "open" }, { kind: "snapshot" }, { kind: "console" }],
      quality: {
        stepReport: { ok: true },
        resultReport: { ok: true },
        errors: [],
      },
    },
    apiDiagnosis: [],
    permission: {
      requirement: {
        level: "none",
        scope: "read",
        rationale: "read-only",
        cacheKey: "thread-1:browser:read:none",
      },
      decision: "granted",
      source: "policy",
      recommendedAction: "proceed",
    },
    transportAudit: {
      capability: "browser",
      preferredOrder: ["browser"],
      attemptedTransports: ["browser"],
      finalTransport: "browser",
      downgraded: false,
      trustLevel: "promotable",
    },
  });

  assert.equal(assessment.sourceType, "browser");
  assert.equal(assessment.trustLevel, "promotable");
  assert.equal(assessment.verified, true);
  assert.equal(assessment.downgraded, false);
});

test("prompt admission policy downgrades observational evidence to summary-only", () => {
  const policy = new DefaultPromptAdmissionPolicy();
  const apiDiagnosis: ApiDiagnosisReport[] = [];

  const decision = policy.decide({
    workerType: "explore",
    workerStatus: "completed",
    summary: "Fetched a blocked page through browser fallback.",
    payload: {},
    trust: {
      sourceType: "browser",
      trustLevel: "observational",
      rationale: ["browser fallback result is not fully verified"],
      verified: false,
      downgraded: true,
    },
    permission: {
      requirement: {
        level: "none",
        scope: "read",
        rationale: "read-only",
        cacheKey: "thread-1:explore:read:none",
      },
      decision: "granted",
      source: "policy",
      recommendedAction: "proceed",
    },
    apiDiagnosis,
  });

  assert.equal(decision.mode, "summary_only");
  assert.equal(decision.trustLevel, "observational");
});

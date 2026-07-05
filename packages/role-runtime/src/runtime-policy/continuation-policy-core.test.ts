import assert from "node:assert/strict";
import test from "node:test";

import {
  selectIndependentEvidenceStreamsPolicy,
  selectMissingApprovalGateContinuationPolicy,
  selectTimeoutContinuationPolicy,
} from "./continuation-policy-core";

test("continuation core prefers approved-browser timeout continuation", () => {
  const decision = selectTimeoutContinuationPolicy({
    facts: {
      timedOutApprovedBrowserSession: true,
      timedOutSiblingSession: true,
    },
  });

  assert.equal(decision.kind, "continue");
  assert.equal(decision.policyId, "approved_browser_timeout_continuation");
});

test("continuation core selects independent evidence continuation from typed facts", () => {
  const decision = selectIndependentEvidenceStreamsPolicy({
    facts: {
      independentEvidenceStreams: true,
      requiredStreams: 3,
      completedSessions: 1,
    },
  });

  assert.equal(decision.kind, "continue");
  assert.equal(decision.policyId, "independent_evidence_stream_continuation");
});

test("continuation core returns none for missing approval gate when fact is false", () => {
  const decision = selectMissingApprovalGateContinuationPolicy({
    facts: { missingApprovalGate: false },
  });

  assert.equal(decision.kind, "none");
});

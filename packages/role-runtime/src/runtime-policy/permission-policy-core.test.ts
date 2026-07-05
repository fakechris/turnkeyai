import assert from "node:assert/strict";
import test from "node:test";

import { selectPermissionSuppressionPolicy } from "./permission-policy-core";

test("permission core returns none when read-only permission suppression is false", () => {
  assert.deepEqual(
    selectPermissionSuppressionPolicy({
      facts: { readOnlyPermissionQuery: false },
    }),
    {
      kind: "none",
      policyId: "none",
      reasonCode: "permission_query_allowed",
      render: null,
    },
  );
});

test("permission core selects read-only permission suppression from typed facts", () => {
  const decision = selectPermissionSuppressionPolicy({
    facts: { readOnlyPermissionQuery: true },
  });

  assert.equal(decision.kind, "suppress");
  assert.equal(decision.policyId, "read_only_permission_query");
  assert.equal(decision.forceToolChoice, "none");
  assert.equal(decision.consumesRound, true);
});

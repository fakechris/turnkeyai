import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "./native-tool-messages";
import {
  buildApprovalWaitTimeoutLocalEvidenceCloseout,
  collectApprovalWaitTimeoutRuntimeEvidence,
} from "./tool-loop-shared";

test("collectApprovalWaitTimeoutRuntimeEvidence keeps permission evidence only", () => {
  const toolTrace: NativeToolRoundTrace[] = [
    {
      round: 1,
      calls: [],
      results: [
        {
          toolCallId: "toolu-permission-query",
          toolName: "permission_query",
          content: JSON.stringify({
            approval_id: "approval-1",
            status: "pending",
          }),
          isError: false,
          contentBytes: 52,
        },
        {
          toolCallId: "toolu-session",
          toolName: "sessions_send",
          content: "ignored session evidence",
          isError: false,
          contentBytes: 24,
        },
      ],
    },
    {
      round: 2,
      calls: [],
      results: [
        {
          toolCallId: "toolu-permission-result",
          toolName: "permission_result",
          content: JSON.stringify({
            approval_id: "approval-1",
            status: "approval_wait_timeout",
          }),
          isError: false,
          contentBytes: 66,
        },
      ],
    },
  ];

  const evidence = collectApprovalWaitTimeoutRuntimeEvidence(toolTrace);

  assert.match(evidence, /permission_query:/);
  assert.match(evidence, /permission_result:/);
  assert.doesNotMatch(evidence, /sessions_send|ignored session evidence/);
});

test("buildApprovalWaitTimeoutLocalEvidenceCloseout preserves model metadata and evidence", () => {
  const result = buildApprovalWaitTimeoutLocalEvidenceCloseout({
    selection: {
      modelId: "model-a",
      modelChainId: "chain-a",
    },
    evidenceText:
      "permission_query requested approval and permission_result returned pending.",
    error: new Error("final synthesis unavailable"),
  });

  assert.equal(result.modelId, "model-a");
  assert.equal(result.modelChainId, "chain-a");
  assert.equal(result.providerId, "local");
  assert.equal(result.adapterName, "local-evidence-closeout");
  assert.match(result.text, /Approval wait-timeout closeout confirmed/);
  assert.match(result.text, /pending/);
  assert.match(
    result.text,
    /permission_query requested approval and permission_result returned pending/,
  );
  assert.deepEqual(result.raw, {
    reason: "approval_wait_timeout_final_synthesis_unavailable",
    message: "final synthesis unavailable",
    evidence:
      "permission_query requested approval and permission_result returned pending.",
  });
});

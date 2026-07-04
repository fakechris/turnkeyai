import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { producePermissionEvidenceEnvelope } from "./permission-evidence-producer";

function trace(input: {
  calls?: NativeToolRoundTrace["calls"];
  results?: NativeToolRoundTrace["results"];
  progress?: NativeToolRoundTrace["progress"];
}): NativeToolRoundTrace[] {
  return [
    {
      round: 1,
      calls: input.calls ?? [],
      results: input.results ?? [],
      ...(input.progress ? { progress: input.progress } : {}),
    },
  ];
}

function result(toolName: string, content: unknown): NativeToolRoundTrace["results"][number] {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return {
    toolCallId: `call-${toolName}`,
    toolName,
    isError: false,
    contentBytes: text.length,
    content: text,
  };
}

test("PermissionEvidenceProducer returns none without permission evidence", () => {
  const envelope = producePermissionEvidenceEnvelope({
    toolTrace: trace({ results: [] }),
  });

  assert.equal(envelope.kind, "permission_evidence");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.facts.latestStatus, "none");
  assert.equal(envelope.facts.pendingApproval, false);
});

test("PermissionEvidenceProducer reads pending query progress", () => {
  const envelope = producePermissionEvidenceEnvelope({
    toolTrace: trace({
      calls: [{ id: "call-permission", name: "permission_query", input: {} }],
      progress: [
        {
          toolCallId: "call-permission",
          toolName: "permission_query",
          phase: "progress",
          summary: "Approval required.",
          detail: { eventType: "permission.query", status: "pending" },
          ts: 1,
        },
      ],
    }),
  });

  assert.equal(envelope.facts.latestStatus, "pending");
  assert.equal(envelope.facts.latestToolName, "permission_query");
  assert.equal(envelope.facts.latestResultStatus, null);
  assert.equal(envelope.facts.pendingApproval, true);
  assert.equal(envelope.facts.waitTimeout, false);
});

test("PermissionEvidenceProducer reads denied result status", () => {
  const envelope = producePermissionEvidenceEnvelope({
    toolTrace: trace({
      results: [result("permission_result", { status: "denied" })],
    }),
  });

  assert.equal(envelope.facts.latestStatus, "denied");
  assert.equal(envelope.facts.deniedApproval, true);
  assert.equal(envelope.facts.pendingApproval, false);
});

test("PermissionEvidenceProducer reads applied progress after approval", () => {
  const envelope = producePermissionEvidenceEnvelope({
    toolTrace: trace({
      results: [result("permission_result", { status: "approved" })],
      progress: [
        {
          toolCallId: "call-permission",
          toolName: "permission_result",
          phase: "progress",
          summary: "Approved.",
          detail: { eventType: "permission.result", status: "approved" },
          ts: 1,
        },
        {
          toolCallId: "call-permission",
          toolName: "permission_result",
          phase: "progress",
          summary: "Permission request was applied.",
          detail: { eventType: "permission.applied", status: "applied" },
          ts: 2,
        },
      ],
    }),
  });

  assert.equal(envelope.facts.latestStatus, "applied");
  assert.equal(envelope.facts.appliedApproval, true);
  assert.equal(envelope.facts.pendingApproval, false);
});

test("PermissionEvidenceProducer reads structured wait-timeout status", () => {
  const envelope = producePermissionEvidenceEnvelope({
    toolTrace: trace({
      results: [result("permission_result", { status: "approval_wait_timeout" })],
    }),
  });

  assert.equal(envelope.facts.latestStatus, "wait_timeout");
  assert.equal(envelope.facts.pendingApproval, true);
  assert.equal(envelope.facts.waitTimeout, true);
  assert.equal(envelope.facts.appliedApproval, false);
  assert.equal(envelope.facts.deniedApproval, false);
});

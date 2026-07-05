import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { SESSION_TOOL_RESULT_PROTOCOL } from "../session-tool-result-protocol";
import type { RoleToolExecutionResult } from "../tool-use";
import {
  buildRuntimeFactBundle,
  buildRuntimeRoundFactBundle,
} from "./runtime-fact-bundle";

function traceResult(input: {
  toolName: string;
  content: string;
  id?: string;
}): NativeToolRoundTrace["results"][number] {
  return {
    toolCallId: input.id ?? `toolu-${input.toolName}`,
    toolName: input.toolName,
    isError: false,
    contentBytes: input.content.length,
    content: input.content,
  };
}

function completedSessionContent(finalContent: string): string {
  return JSON.stringify({
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: "task-1",
    session_key: "worker:explore:task-1",
    agent_id: "explore",
    status: "completed",
    tool_chain: [],
    result: finalContent,
    final_content: finalContent,
    payload: null,
  });
}

test("RuntimeFactBundle aggregates all producer envelopes and splits text views", () => {
  const bundle = buildRuntimeFactBundle({
    taskPrompt:
      "Return a source-backed table with columns Name and Pricing. Use browser-visible evidence.",
    messages: [{ role: "user", content: "Compare source evidence." }],
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [
          traceResult({
            toolName: "web_fetch",
            content: "Source evidence: Pricing is $10.",
          }),
          traceResult({
            toolName: "sessions_spawn",
            content: completedSessionContent("Delegated source evidence."),
          }),
        ],
      },
    ],
  });

  assert.deepEqual(
    bundle.envelopes.map((envelope) => envelope.kind).sort(),
    [
      "browser_evidence",
      "permission_evidence",
      "session_evidence",
      "task_intent",
      "usable_evidence",
    ],
  );
  assert.notEqual(bundle.policy, bundle.finalText);
  assert.equal(bundle.policy.taskIntent.browserVisibleEvidenceRequired, true);
  assert.equal(bundle.policy.usable.usableEvidence, true);
  assert.match(bundle.finalText.sourceBoundedEvidenceText, /Pricing is \$10/);
  assert.match(
    bundle.finalText.completedSessionEvidenceText,
    /Delegated source evidence/,
  );
  assert.match(bundle.finalText.naturalFinishEvidenceText, /Pricing is \$10/);

  const policyJson = JSON.stringify(bundle.policy);
  assert.doesNotMatch(policyJson, /sourceBoundedEvidenceText/);
  assert.doesNotMatch(policyJson, /naturalFinishEvidenceText/);
  assert.doesNotMatch(policyJson, /runtimeEvidenceText/);
});

test("RuntimeRoundFactBundle is round scoped and does not invent task intent", () => {
  const results: RoleToolExecutionResult[] = [
    {
      toolCallId: "toolu-permission",
      toolName: "permission_result",
      content: JSON.stringify({ status: "denied" }),
      progress: [
        {
          phase: "completed",
          toolName: "permission_result",
          summary: "Permission denied.",
          detail: {
            eventType: "permission.result",
            status: "denied",
          },
        },
      ],
    },
    {
      toolCallId: "toolu-session",
      toolName: "sessions_spawn",
      content: completedSessionContent("Round delegated evidence."),
    },
  ];

  const bundle = buildRuntimeRoundFactBundle({ results });

  assert.deepEqual(
    bundle.envelopes.map((envelope) => envelope.kind).sort(),
    ["permission_evidence", "session_evidence", "usable_evidence"],
  );
  assert.equal(bundle.policy.permission.latestStatus, "denied");
  assert.equal(bundle.policy.usable.usableEvidence, true);
  assert.match(bundle.finalText.toolResultContentText, /Round delegated evidence/);
  assert.equal("taskIntent" in bundle.policy, false);
  assert.equal("browser" in bundle.policy, false);
  assert.equal(
    "browserVisibleEvidenceRequired" in
      (bundle.policy as unknown as Record<string, unknown>),
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  buildEvidenceSnapshot,
  createEvidenceLedger,
  EVIDENCE_LEDGER_MODULE,
} from "./evidence-ledger";

function result(input: {
  toolName: string;
  content: string;
  id?: string;
}): NativeToolRoundTrace["results"][number] {
  return {
    toolCallId: input.id ?? `toolu-${input.toolName}`,
    toolName: input.toolName,
    content: input.content,
    isError: false,
    contentBytes: input.content.length,
  };
}

function completedSessionContent(finalContent: string): string {
  return JSON.stringify({
    task_id: "task-1",
    session_key: "worker:explore:task-1",
    agent_id: "explore",
    status: "completed",
    result: finalContent,
    final_content: finalContent,
  });
}

test("EvidenceLedger module id is stable", () => {
  assert.equal(EVIDENCE_LEDGER_MODULE, "evidence-ledger");
});

test("EvidenceLedger snapshot preserves source and completed-session evidence formula", () => {
  const toolTrace: NativeToolRoundTrace[] = [
    {
      round: 1,
      calls: [],
      results: [
        result({
          toolName: "web_fetch",
          content: "Source label: pricing page returned $10 per month.",
        }),
        result({
          toolName: "sessions_spawn",
          content: completedSessionContent(
            "Delegated final source evidence: plan is $10 per month.",
          ),
        }),
      ],
    },
  ];

  const snapshot = buildEvidenceSnapshot({
    taskPrompt: "Compare the source evidence.",
    messages: [{ role: "user", content: "Use source-backed evidence." }],
    toolTrace,
  });

  assert.match(snapshot.sourceBoundedEvidenceText, /pricing page returned \$10/);
  assert.match(
    snapshot.completedSessionEvidenceText,
    /Delegated final source evidence/,
  );
  assert.match(snapshot.naturalFinishEvidenceText, /pricing page returned \$10/);
  assert.match(
    snapshot.naturalFinishEvidenceText,
    /Delegated final source evidence/,
  );
});

test("EvidenceLedger class returns the same snapshot contract", () => {
  const ledger = createEvidenceLedger();
  const snapshot = ledger.snapshot({
    taskPrompt: "Summarize source evidence.",
    messages: [],
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [
          result({
            toolName: "web_fetch",
            content: "Source evidence: feature is available.",
          }),
        ],
      },
    ],
  });

  assert.equal(snapshot.completedSessionEvidenceText, "");
  assert.match(snapshot.naturalFinishEvidenceText, /feature is available/);
});

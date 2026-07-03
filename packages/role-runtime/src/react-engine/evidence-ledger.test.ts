import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { SESSION_TOOL_RESULT_PROTOCOL } from "../session-tool-result-protocol";
import type { RoleToolExecutionResult } from "../tool-use";
import {
  buildEvidenceSnapshot,
  buildToolResultContentText,
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

function timeoutSessionContent(): string {
  return JSON.stringify({
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: "task-2",
    session_key: "worker:explore:task-2",
    agent_id: "explore",
    status: "timeout",
    tool_chain: [],
    timeout_seconds: 90,
    evidence_available: true,
    evidence_summary: "partial source evidence",
    result: "partial source evidence",
    final_content: null,
    payload: null,
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
  assert.match(snapshot.toolTraceResultContent, /pricing page returned \$10/);
  assert.match(
    snapshot.approvalWaitTimeoutRuntimeEvidence,
    /permission_query\/permission_result evidence/,
  );
  assert.equal(snapshot.usableEvidence, true);
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
  assert.match(snapshot.toolTraceResultContent, /feature is available/);
  assert.equal(snapshot.usableEvidence, true);
});

test("EvidenceLedger binds run snapshot inputs while preserving live tool trace reads", () => {
  const ledger = createEvidenceLedger();
  const toolTrace: NativeToolRoundTrace[] = [];
  const runEvidence = ledger.forRun({
    taskPrompt: "Summarize source evidence.",
    toolTrace,
  });

  assert.equal(
    runEvidence.snapshot([
      { role: "user", content: "Use the latest source result." },
    ]).usableEvidence,
    false,
  );

  toolTrace.push({
    round: 1,
    calls: [],
    results: [
      result({
        toolName: "web_fetch",
        content: "Source evidence added after the binder was created.",
      }),
    ],
  });

  const snapshot = runEvidence.snapshot([
    { role: "user", content: "Use the latest source result." },
  ]);

  assert.equal(snapshot.usableEvidence, true);
  assert.match(
    snapshot.toolTraceResultContent,
    /Source evidence added after the binder was created/,
  );
});

test("EvidenceLedger snapshots approval wait-timeout runtime evidence", () => {
  const snapshot = buildEvidenceSnapshot({
    taskPrompt: "Close out pending approval.",
    messages: [],
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [
          result({
            toolName: "permission_query",
            content: "approval requested for browser.form.submit",
          }),
          result({
            toolName: "permission_result",
            content: "approval_wait_timeout still pending",
          }),
        ],
      },
    ],
  });

  assert.match(
    snapshot.approvalWaitTimeoutRuntimeEvidence,
    /permission_query: approval requested/,
  );
  assert.match(
    snapshot.approvalWaitTimeoutRuntimeEvidence,
    /permission_result: approval_wait_timeout still pending/,
  );
});

test("EvidenceLedger produces permission facts for pending wait-timeout evidence", () => {
  const ledger = createEvidenceLedger();
  const snapshot = ledger.snapshot({
    taskPrompt: "Submit the form after approval.",
    messages: [],
    toolTrace: [
      {
        round: 0,
        calls: [],
        results: [
          result({
            toolName: "permission_query",
            content: "requested approval for browser.form.submit",
          }),
          result({
            toolName: "permission_result",
            content: "approval_wait_timeout: approval is still pending",
          }),
        ],
      },
    ],
  });

  assert.equal(snapshot.permission.latestStatus, "wait_timeout");
  assert.equal(snapshot.permission.pendingApproval, true);
  assert.equal(snapshot.permission.waitTimeout, true);
  assert.match(
    snapshot.permission.runtimeEvidenceText,
    /approval_wait_timeout/,
  );
});

test("EvidenceLedger keeps pending permission_result compatible with wait-timeout repairs", () => {
  const ledger = createEvidenceLedger();
  const snapshot = ledger.snapshot({
    taskPrompt: "Submit the form after approval.",
    messages: [],
    toolTrace: [
      {
        round: 0,
        calls: [],
        results: [
          result({
            toolName: "permission_result",
            content: JSON.stringify({ status: "pending" }),
          }),
        ],
      },
    ],
  });

  assert.equal(snapshot.permission.latestStatus, "pending");
  assert.equal(snapshot.permission.pendingApproval, true);
  assert.equal(snapshot.permission.waitTimeout, true);
});

test("EvidenceLedger marks skipped/error-only traces as not usable evidence", () => {
  const snapshot = buildEvidenceSnapshot({
    taskPrompt: "Summarize source evidence.",
    messages: [],
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [
          {
            ...result({
              toolName: "web_fetch",
              content: "source failed",
            }),
            isError: true,
          },
          {
            ...result({
              toolName: "web_fetch",
              content: "source skipped",
              id: "toolu-skipped",
            }),
            skipped: true,
          },
        ],
      },
    ],
  });

  assert.match(snapshot.toolTraceResultContent, /source failed/);
  assert.equal(snapshot.usableEvidence, false);
});

test("EvidenceLedger owns current tool-result content text", () => {
  const results: RoleToolExecutionResult[] = [
    {
      toolCallId: "toolu-first",
      toolName: "web_fetch",
      content: "first source result",
    },
    {
      toolCallId: "toolu-empty",
      toolName: "web_fetch",
      content: "   ",
    },
    {
      toolCallId: "toolu-second",
      toolName: "sessions_spawn",
      content: "second delegated result",
    },
  ];

  assert.equal(
    buildToolResultContentText(results),
    "first source result\n\nsecond delegated result",
  );
  assert.equal(
    createEvidenceLedger().toolResultContentText(results),
    "first source result\n\nsecond delegated result",
  );
});

test("EvidenceLedger owns current completed-session and timeout signals", () => {
  const ledger = createEvidenceLedger();
  const completed = ledger.completedSessionEvidence([
    {
      toolCallId: "toolu-completed",
      toolName: "sessions_spawn",
      content: completedSessionContent("delegated final evidence"),
    },
  ]);
  assert.ok(completed);
  assert.equal(completed.toolName, "sessions_spawn");
  assert.deepEqual(completed.finalContents, ["delegated final evidence"]);

  const timeout = ledger.subAgentToolTimeout([
    {
      toolCallId: "toolu-timeout",
      toolName: "sessions_send",
      content: timeoutSessionContent(),
    },
  ]);
  assert.deepEqual(timeout, {
    toolName: "sessions_send",
    sessionKey: "worker:explore:task-2",
    agentId: "explore",
    timeoutSeconds: 90,
    evidenceAvailable: true,
  });
});

test("EvidenceLedger owns current round evidence snapshot for hook handoffs", () => {
  const ledger = createEvidenceLedger();
  const snapshot = ledger.currentRound([
    {
      toolCallId: "toolu-completed",
      toolName: "sessions_spawn",
      content: completedSessionContent("delegated final evidence"),
    },
    {
      toolCallId: "toolu-timeout",
      toolName: "sessions_send",
      content: timeoutSessionContent(),
    },
    {
      toolCallId: "toolu-source",
      toolName: "web_fetch",
      content: "standalone source evidence",
    },
  ]);

  assert.ok(snapshot.completedSession);
  assert.equal(snapshot.completedSession.toolName, "sessions_spawn");
  assert.deepEqual(snapshot.completedSessionFinalContents, [
    "delegated final evidence",
  ]);
  assert.deepEqual(snapshot.timeoutSignal, {
    toolName: "sessions_send",
    sessionKey: "worker:explore:task-2",
    agentId: "explore",
    timeoutSeconds: 90,
    evidenceAvailable: true,
  });
  assert.match(snapshot.toolResultContentText, /delegated final evidence/);
  assert.match(snapshot.toolResultContentText, /standalone source evidence/);
  assert.deepEqual(snapshot.completedSessions, [
    {
      toolName: "sessions_spawn",
      sessionKey: "worker:explore:task-1",
      agentId: "explore",
      finalContents: ["delegated final evidence"],
      browserRecoverySummaries: [],
    },
  ]);
  assert.deepEqual(snapshot.timeoutSignals, [
    {
      toolName: "sessions_send",
      sessionKey: "worker:explore:task-2",
      agentId: "explore",
      timeoutSeconds: 90,
      evidenceAvailable: true,
    },
  ]);
});

test("EvidenceLedger produces typed completed-session facts", () => {
  const ledger = createEvidenceLedger();
  const snapshot = ledger.currentRound([
    {
      toolCallId: "toolu-completed",
      toolName: "sessions_spawn",
      content: JSON.stringify({
        protocol: SESSION_TOOL_RESULT_PROTOCOL,
        task_id: "task-typed-completed",
        session_key: "worker:browser:task-typed-completed",
        agent_id: "browser",
        status: "completed",
        tool_chain: [],
        result: "Observed checkout total: $42",
        final_content: "Observed checkout total: $42",
        payload: null,
      }),
    },
  ]);

  assert.equal(snapshot.completedSessions.length, 1);
  assert.equal(
    snapshot.completedSessions[0]?.sessionKey,
    "worker:browser:task-typed-completed",
  );
  assert.equal(snapshot.completedSessions[0]?.agentId, "browser");
  assert.deepEqual(snapshot.completedSessions[0]?.finalContents, [
    "Observed checkout total: $42",
  ]);
});

test("EvidenceLedger produces typed timeout facts", () => {
  const ledger = createEvidenceLedger();
  const snapshot = ledger.currentRound([
    {
      toolCallId: "toolu-timeout",
      toolName: "sessions_send",
      content: JSON.stringify({
        protocol: SESSION_TOOL_RESULT_PROTOCOL,
        task_id: "task-typed-timeout",
        session_key: "worker:source:task-typed-timeout",
        agent_id: "source",
        status: "timeout",
        tool_chain: [],
        timeout_seconds: 30,
        evidence_available: true,
        result: "partial source evidence",
        final_content: null,
        payload: null,
      }),
    },
  ]);

  assert.equal(snapshot.timeoutSignals.length, 1);
  assert.equal(
    snapshot.timeoutSignals[0]?.sessionKey,
    "worker:source:task-typed-timeout",
  );
  assert.equal(snapshot.timeoutSignals[0]?.agentId, "source");
  assert.equal(snapshot.timeoutSignals[0]?.timeoutSeconds, 30);
  assert.equal(snapshot.timeoutSignals[0]?.evidenceAvailable, true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_TOOL_RESULT_PROTOCOL } from "../session-tool-result-protocol";
import type { RoleToolExecutionResult } from "../tool-use";
import {
  produceSessionEvidenceEnvelope,
  produceSessionEvidenceEnvelopeFromRound,
} from "./session-evidence-producer";

function result(toolName: string, content: unknown): RoleToolExecutionResult {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return {
    toolCallId: `call-${toolName}`,
    toolName,
    content: text,
    isError: false,
    contentBytes: text.length,
  } as RoleToolExecutionResult;
}

function sessionResult(input: {
  status: "completed" | "timeout";
  sessionKey: string;
  agentId: "browser" | "explore";
  finalContent?: string | null;
  result?: string;
  label?: string | null;
  parentSessionKey?: string | null;
  timeoutSeconds?: number | null;
  evidenceAvailable?: boolean;
}): Record<string, unknown> {
  return {
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: "task-1",
    session_key: input.sessionKey,
    agent_id: input.agentId,
    ...(input.label ? { label: input.label } : {}),
    ...(input.parentSessionKey
      ? { parent_session_key: input.parentSessionKey }
      : {}),
    status: input.status,
    ...(input.timeoutSeconds !== undefined
      ? { timeout_seconds: input.timeoutSeconds }
      : {}),
    ...(input.evidenceAvailable !== undefined
      ? { evidence_available: input.evidenceAvailable }
      : {}),
    tool_chain: [],
    result: input.result ?? input.finalContent ?? "",
    final_content: input.finalContent ?? null,
    payload: null,
  };
}

test("SessionEvidenceProducer produces completed session facts from round results", () => {
  const envelope = produceSessionEvidenceEnvelopeFromRound({
    results: [
      result(
        "sessions_spawn",
        sessionResult({
          status: "completed",
          sessionKey: "session-a",
          agentId: "browser",
          finalContent: "Rendered checkout total is $42.",
          label: "checkout",
        }),
      ),
    ],
  });

  assert.equal(envelope.kind, "session_evidence");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.facts.completedSessions.length, 1);
  assert.equal(envelope.facts.completedSession?.sessionKey, "session-a");
  assert.equal(envelope.facts.completedSession?.agentId, "browser");
  assert.deepEqual(envelope.facts.completedSessionFinalContents, [
    "Rendered checkout total is $42.",
  ]);
  assert.deepEqual(envelope.facts.completedStreamLabels, ["checkout"]);
});

test("SessionEvidenceProducer handles sessions_send and sessions_history evidence", () => {
  const envelope = produceSessionEvidenceEnvelopeFromRound({
    results: [
      result(
        "sessions_send",
        sessionResult({
          status: "completed",
          sessionKey: "session-send",
          agentId: "explore",
          finalContent: "Follow-up evidence is complete.",
          label: "follow-up",
          parentSessionKey: "session-root",
        }),
      ),
      result("sessions_history", {
        session_key: "history-session",
        agent_id: "explore",
        total_messages: 1,
        messages: [{ content: "History evidence content." }],
      }),
    ],
  });

  assert.equal(envelope.facts.completedSessions.length, 2);
  assert.deepEqual(envelope.facts.completedSessionFinalContents, [
    "Follow-up evidence is complete.",
  ]);
  assert.deepEqual(
    envelope.facts.completedSessions.flatMap((fact) => fact.finalContents),
    ["Follow-up evidence is complete.", "History evidence content."],
  );
  assert.deepEqual(envelope.facts.completedStreamLabels, []);
});

test("SessionEvidenceProducer produces resumable timeout facts", () => {
  const envelope = produceSessionEvidenceEnvelopeFromRound({
    results: [
      result(
        "sessions_send",
        sessionResult({
          status: "timeout",
          sessionKey: "slow-source",
          agentId: "explore",
          result: "Partial source evidence",
          timeoutSeconds: 45,
          evidenceAvailable: true,
        }),
      ),
    ],
  });

  assert.equal(envelope.facts.timeoutSignals.length, 1);
  assert.equal(envelope.facts.timeoutSignal?.sessionKey, "slow-source");
  assert.equal(envelope.facts.timeoutSignal?.seconds, 45);
  assert.equal(envelope.facts.timeoutSignal?.resumable, true);
  assert.equal(envelope.facts.timeoutSignal?.evidenceAvailable, true);
  assert.equal(envelope.facts.resumableTimeouts.length, 1);
});

test("SessionEvidenceProducer produces trace-level facts", () => {
  const envelope = produceSessionEvidenceEnvelope({
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [
          {
            toolCallId: "call-1",
            toolName: "sessions_spawn",
            isError: false,
            contentBytes: 0,
            content: JSON.stringify(
              sessionResult({
                status: "completed",
                sessionKey: "trace-session",
                agentId: "explore",
                finalContent: "Trace evidence complete.",
                label: "trace",
              }),
            ),
          },
        ],
      },
    ],
  });

  assert.equal(envelope.facts.completedSession?.sessionKey, "trace-session");
  assert.deepEqual(envelope.facts.completedStreamLabels, ["trace"]);
});

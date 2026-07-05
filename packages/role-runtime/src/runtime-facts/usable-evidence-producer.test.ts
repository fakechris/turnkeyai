import assert from "node:assert/strict";
import test from "node:test";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import { produceUsableEvidenceEnvelope } from "./usable-evidence-producer";

function traceResult(
  input: Partial<NativeToolRoundTrace["results"][number]>,
): NativeToolRoundTrace["results"][number] {
  return {
    toolCallId: input.toolCallId ?? "call-1",
    toolName: input.toolName ?? "web_fetch",
    isError: input.isError ?? false,
    contentBytes: input.contentBytes ?? 10,
    content: input.content ?? "evidence",
    ...(input.skipped === undefined ? {} : { skipped: input.skipped }),
  };
}

test("UsableEvidenceProducer returns false for skipped-only traces", () => {
  const envelope = produceUsableEvidenceEnvelope({
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [traceResult({ skipped: true })],
      },
    ],
  });

  assert.equal(envelope.kind, "usable_evidence");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.facts.usableEvidence, false);
});

test("UsableEvidenceProducer returns false for error-only traces", () => {
  const envelope = produceUsableEvidenceEnvelope({
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [traceResult({ isError: true })],
      },
    ],
  });

  assert.equal(envelope.facts.usableEvidence, false);
});

test("UsableEvidenceProducer returns true for non-skipped non-error results", () => {
  const envelope = produceUsableEvidenceEnvelope({
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [traceResult({ content: "source evidence" })],
      },
    ],
  });

  assert.equal(envelope.facts.usableEvidence, true);
});

test("UsableEvidenceProducer returns true for completed session evidence", () => {
  const envelope = produceUsableEvidenceEnvelope({
    toolTrace: [
      {
        round: 1,
        calls: [],
        results: [
          traceResult({
            toolName: "sessions_spawn",
            content: "completed session evidence",
          }),
        ],
      },
    ],
  });

  assert.equal(envelope.facts.usableEvidence, true);
});

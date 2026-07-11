import assert from "node:assert/strict";
import test from "node:test";

import {
  compactToolResultTraceContent,
  compactSessionPayloadEvidenceExcerpt,
  nativeToolResultTraceHasUsableEvidence,
  readPayloadEvidenceExcerpt,
  sessionToolResultHasUsableEvidence,
} from "./tool-protocol";
import {
  parseSessionToolResult,
  SESSION_TOOL_RESULT_PROTOCOL,
} from "./session-tool-result-protocol";

test("browser page evidence precedes synthesized payload content", () => {
  const payload = {
    content: `Long synthesized summary ${"x".repeat(3_000)}`,
    pages: [
      {
        requestedUrl: "https://docs.example.test/guide",
        finalUrl: "https://docs.example.test/guide",
        title: "Integration Guide",
        textExcerpt: "The verified configuration value is 42.",
      },
    ],
  };

  const evidence = readPayloadEvidenceExcerpt(payload);
  assert.ok(evidence?.startsWith("https://docs.example.test/guide\nIntegration Guide\nThe verified configuration value is 42."));

  const compacted = compactSessionPayloadEvidenceExcerpt(payload);
  assert.match(compacted.evidence_excerpt, /verified configuration value is 42/);
});

test("compacted session traces retain typed multi-source references", () => {
  const compacted = compactToolResultTraceContent(JSON.stringify({
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: "task-1",
    session_key: "worker:explore:task-1",
    agent_id: "explore",
    label: "Combined documentation review",
    status: "completed",
    tool_chain: ["explore"],
    result: "Reviewed two documentation sources.",
    final_content: "Both sources were reviewed.",
    payload: {
      sourceResults: [
        {
          url: "https://alpha.example.test/guide",
          label: "Alpha documentation",
          status: "completed",
          page: {
            requestedUrl: "https://alpha.example.test/guide",
            finalUrl: "https://alpha.example.test/guide",
            title: "Alpha Guide",
            textExcerpt: "A large source body that should not be retained in typed references.",
            statusCode: 200,
          },
        },
        {
          url: "https://beta.example.test/guide",
          label: "Beta documentation",
          status: "completed",
          page: {
            requestedUrl: "https://beta.example.test/guide",
            finalUrl: "https://beta.example.test/guide",
            title: "Beta Guide",
            textExcerpt: "Another source body that should remain in the evidence excerpt only.",
            statusCode: 200,
          },
        },
      ],
    },
  }));

  const parsed = JSON.parse(compacted.content) as {
    payload?: {
      sourceResults?: Array<{
        url?: string;
        label?: string;
        status?: string;
        page?: Record<string, unknown>;
      }>;
    };
  };
  assert.deepEqual(parsed.payload?.sourceResults, [
    {
      url: "https://alpha.example.test/guide",
      label: "Alpha documentation",
      status: "completed",
      page: {
        requestedUrl: "https://alpha.example.test/guide",
        finalUrl: "https://alpha.example.test/guide",
        title: "Alpha Guide",
        statusCode: 200,
      },
    },
    {
      url: "https://beta.example.test/guide",
      label: "Beta documentation",
      status: "completed",
      page: {
        requestedUrl: "https://beta.example.test/guide",
        finalUrl: "https://beta.example.test/guide",
        title: "Beta Guide",
        statusCode: 200,
      },
    },
  ]);
});

function sessionResult(input: {
  status: "completed" | "partial" | "failed" | "timeout" | "cancelled";
  result: string;
  evidenceAvailable?: boolean;
  evidenceSummary?: string;
  finalContent?: string | null;
}) {
  const parsed = parseSessionToolResult(JSON.stringify({
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: "task-1",
    session_key: "worker:explore:task-1",
    agent_id: "explore",
    status: input.status,
    ...(input.evidenceAvailable === undefined ? {} : { evidence_available: input.evidenceAvailable }),
    ...(input.evidenceSummary ? { evidence_summary: input.evidenceSummary } : {}),
    tool_chain: ["explore"],
    result: input.result,
    final_content: input.finalContent ?? null,
    payload: null,
  }));
  assert.ok(parsed);
  return parsed;
}

test("session evidence uses protocol status instead of failure wording", () => {
  assert.equal(
    sessionToolResultHasUsableEvidence(sessionResult({ status: "failed", result: "request rejected" })),
    false,
  );
  assert.equal(
    sessionToolResultHasUsableEvidence(sessionResult({ status: "timeout", result: "worker timed out" })),
    false,
  );
  assert.equal(
    sessionToolResultHasUsableEvidence(sessionResult({
      status: "timeout",
      result: "worker timed out after collecting one source",
      evidenceAvailable: true,
      evidenceSummary: "Source A reports the verified value.",
    })),
    true,
  );
  assert.equal(
    sessionToolResultHasUsableEvidence(sessionResult({
      status: "completed",
      result: "Completed review of timeout behavior.",
    })),
    true,
  );
});

test("native trace evidence rejects typed failures and control-plane output only", () => {
  const base = {
    toolCallId: "call-1",
    contentBytes: 20,
    isError: false,
  };
  assert.equal(
    nativeToolResultTraceHasUsableEvidence({
      ...base,
      toolName: "web_fetch",
      content: "Verified documentation for timeout configuration.",
    }),
    true,
  );
  assert.equal(
    nativeToolResultTraceHasUsableEvidence({
      ...base,
      toolName: "memory_search",
      content: "Memory index lookup completed.",
    }),
    false,
  );
  assert.equal(
    nativeToolResultTraceHasUsableEvidence({
      ...base,
      toolName: "web_fetch",
      content: "The source returned content.",
      isError: true,
    }),
    false,
  );
  assert.equal(
    nativeToolResultTraceHasUsableEvidence({
      ...base,
      toolName: "sessions_spawn",
      content: JSON.stringify({
        protocol: SESSION_TOOL_RESULT_PROTOCOL,
        task_id: "task-1",
        session_key: "worker:explore:task-1",
        agent_id: "explore",
        status: "failed",
        tool_chain: ["explore"],
        result: "Sub-agent failed after the provider rejected the request.",
        final_content: null,
        payload: null,
      }),
    }),
    false,
  );
});

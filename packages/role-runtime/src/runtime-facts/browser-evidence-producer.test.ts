import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_TOOL_RESULT_PROTOCOL } from "../session-tool-result-protocol";
import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { TaskIntentFacts } from "./types";
import { produceBrowserEvidenceEnvelope } from "./browser-evidence-producer";

const baseTaskIntent: TaskIntentFacts = {
  requestedTableColumns: [],
  providerSupportSchemaRequested: false,
  browserVisibleEvidenceRequired: true,
  productSignalDashboardEvidenceRequested: false,
  timeoutRecoveryRequested: false,
  awaitingContextSetupOnly: false,
  requiredIndependentEvidenceStreams: 0,
};

function round(input: Partial<NativeToolRoundTrace>): NativeToolRoundTrace {
  return {
    round: 1,
    calls: [],
    results: [],
    ...input,
  };
}

test("BrowserEvidenceProducer reads rendered browser snapshot progress", () => {
  const envelope = produceBrowserEvidenceEnvelope({
    taskIntent: baseTaskIntent,
    toolTrace: [
      round({
        progress: [
          {
            toolCallId: "browser-1",
            toolName: "browser_snapshot",
            phase: "progress",
            summary: "Snapshot captured",
            detail: {
              eventType: "browser.snapshot",
              finalUrl: "http://127.0.0.1:5173/checkout",
              title: "Checkout",
            },
            ts: 1,
          },
        ],
      }),
    ],
  });

  assert.equal(envelope.kind, "browser_evidence");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.facts.browserVisibleEvidenceEvents.length, 1);
  assert.equal(envelope.facts.browserVisibleEvidenceEvents[0]?.kind, "browser_snapshot");
  assert.equal(envelope.facts.missingBrowserVisibleEvidence, false);
});

test("BrowserEvidenceProducer reads product-signal dashboard evidence", () => {
  const envelope = produceBrowserEvidenceEnvelope({
    taskIntent: {
      ...baseTaskIntent,
      productSignalDashboardEvidenceRequested: true,
    },
    toolTrace: [
      round({
        progress: [
          {
            toolCallId: "browser-1",
            toolName: "browser_snapshot",
            phase: "progress",
            summary: "Product-signals dashboard visible",
            detail: {
              eventType: "browser.snapshot",
              finalUrl: "http://127.0.0.1:5173/product-signals",
              title: "Product Signal Dashboard",
            },
            ts: 1,
          },
        ],
      }),
    ],
  });

  assert.equal(envelope.facts.productSignalDashboardEvidenceEvents.length, 1);
  assert.equal(envelope.facts.missingProductSignalDashboardEvidence, false);
});

test("BrowserEvidenceProducer reads browser recovery payloads and failure buckets", () => {
  const sessionContent = JSON.stringify({
    protocol: SESSION_TOOL_RESULT_PROTOCOL,
    task_id: "task-1",
    session_key: "browser-session",
    agent_id: "browser",
    status: "completed",
    tool_chain: [],
    result: "Recovered browser session.",
    final_content: "Recovered browser session.",
    payload: {
      browserRecovery: {
        summary: "Browser recovery metadata: warm resume.",
        failureBuckets: [{ bucket: "session_not_found", count: 1 }],
      },
    },
  });
  const envelope = produceBrowserEvidenceEnvelope({
    taskIntent: baseTaskIntent,
    toolTrace: [
      round({
        results: [
          {
            toolCallId: "session-1",
            toolName: "sessions_spawn",
            isError: false,
            contentBytes: sessionContent.length,
            content: sessionContent,
          },
        ],
        progress: [
          {
            toolCallId: "browser-1",
            toolName: "browser_snapshot",
            phase: "failed",
            summary: "Browser snapshot timed out",
            detail: {
              eventType: "browser.snapshot",
              failureBuckets: [{ bucket: "cdp_command_timeout", count: 1 }],
            },
            ts: 1,
          },
        ],
      }),
    ],
  });

  assert.equal(
    envelope.facts.events.some((event) => event.kind === "browser_recovery"),
    true,
  );
  assert.equal(envelope.facts.failureBuckets.includes("browser_timeout"), true);
  assert.equal(
    envelope.facts.failureBuckets.includes("browser_navigation_failed"),
    true,
  );
});

test("BrowserEvidenceProducer does not treat static fetch as browser-visible evidence", () => {
  const envelope = produceBrowserEvidenceEnvelope({
    taskIntent: baseTaskIntent,
    toolTrace: [
      round({
        results: [
          {
            toolCallId: "fetch-1",
            toolName: "web_fetch",
            isError: false,
            contentBytes: 32,
            content: "<html>static content</html>",
          },
        ],
      }),
    ],
  });

  assert.equal(envelope.facts.browserVisibleEvidenceEvents.length, 0);
  assert.equal(envelope.facts.missingBrowserVisibleEvidence, true);
});

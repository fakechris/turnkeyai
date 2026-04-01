import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextCompressor } from "./context-compressor";

test("context compressor prunes noisy worker trace steps into compact findings", async () => {
  const compressor = new DefaultContextCompressor();

  const digest = await compressor.compressWorkerTrace({
    workerRunKey: "worker-1",
    threadId: "thread-1",
    workerType: "browser",
    trace: [
      { kind: "open", output: { finalUrl: "https://example.com/pricing" } },
      { kind: "snapshot", output: { title: "Pricing", finalUrl: "https://example.com/pricing", interactiveCount: 12 } },
      { kind: "console", output: { result: { title: "Pricing", href: "https://example.com/pricing" } } },
      { kind: "wait", output: { timeoutMs: 800 } },
    ],
    artifactIds: ["artifact-1"],
  });

  assert.ok(digest.findings.some((entry) => entry.includes("Opened https://example.com/pricing")));
  assert.ok(digest.findings.some((entry) => entry.includes("Snapshot title=Pricing")));
  assert.ok(digest.findings.some((entry) => entry.includes("Console probe returned")));
  assert.equal(digest.traceDigest?.prunedStepCount, 1);
});

test("context compressor preserves failure context when worker findings exist", async () => {
  const compressor = new DefaultContextCompressor();

  const digest = await compressor.compressWorkerTrace({
    workerRunKey: "worker-2",
    threadId: "thread-1",
    workerType: "browser",
    status: "failed",
    trace: [
      { kind: "open", output: { finalUrl: "https://example.com/pricing" } },
      { kind: "snapshot", output: { title: "Pricing", finalUrl: "https://example.com/pricing" } },
    ],
    artifactIds: [],
  });

  assert.ok(digest.findings[0]?.includes("Worker failed"));
  assert.ok(digest.findings.some((entry) => entry.includes("Opened https://example.com/pricing")));
});

test("context compressor collapses oversized worker evidence into bounded reference-first digests", async () => {
  const compressor = new DefaultContextCompressor();

  const digest = await compressor.compressWorkerTrace({
    workerRunKey: "worker-oversized",
    threadId: "thread-1",
    workerType: "browser",
    trace: [
      { kind: "open", output: { finalUrl: "https://example.com/research/alpha" } },
      {
        kind: "console",
        output: {
          result: {
            summary:
              "A".repeat(220),
          },
        },
      },
      {
        kind: "console",
        output: {
          result: {
            summary:
              "B".repeat(220),
          },
        },
      },
      {
        kind: "console",
        output: {
          result: {
            summary:
              "C".repeat(220),
          },
        },
      },
      {
        kind: "console",
        output: {
          result: {
            summary:
              "D".repeat(220),
          },
        },
      },
    ],
    artifactIds: Array.from({ length: 10 }, (_, index) => `artifact-${index + 1}`),
  });

  assert.equal(digest.referenceOnly, true);
  assert.equal(digest.truncated, true);
  assert.equal(digest.artifactIds.length, 6);
  assert.equal(digest.artifactCount, 10);
  assert.ok((digest.findingCharCount ?? 0) <= 320);
  assert.match(digest.microcompactSummary ?? "", /findings kept|chars/i);
});

test("context compressor keeps pending work scoped to the active role plus shared user asks", async () => {
  const compressor = new DefaultContextCompressor();

  const scratchpad = await compressor.compressRoleScratchpad({
    threadId: "thread-1",
    roleId: "role-finance",
    messages: [
      {
        messageId: "msg-user-1",
        role: "user",
        name: "Chris",
        content: "Please compare pricing and keep the pending follow-up visible.",
        createdAt: 1,
      },
      {
        messageId: "msg-research-1",
        role: "assistant",
        roleId: "role-research",
        name: "Research",
        content: "Pending: verify the benchmark source list.",
        createdAt: 2,
      },
      {
        messageId: "msg-finance-1",
        role: "assistant",
        roleId: "role-finance",
        name: "Finance",
        content: "Pending: estimate first-month cost.",
        createdAt: 3,
      },
    ],
  });

  assert.ok(scratchpad.pendingWork.some((entry) => entry.includes("compare pricing")));
  assert.ok(scratchpad.pendingWork.some((entry) => entry.includes("estimate first-month cost")));
  assert.equal(scratchpad.pendingWork.some((entry) => entry.includes("benchmark source list")), false);
});

test("context compressor carries unresolved merge and approval language into summary and scratchpad", async () => {
  const compressor = new DefaultContextCompressor();

  const messages = [
    {
      messageId: "msg-user-1",
      role: "user" as const,
      name: "Chris",
      content: "We still have an unresolved merge conflict and need approval before the retry continues.",
      createdAt: 1,
    },
    {
      messageId: "msg-lead-1",
      role: "assistant" as const,
      roleId: "role-lead",
      name: "Lead",
      content: "Open question: which shard is missing, and who needs to approve the follow-up?",
      createdAt: 2,
    },
  ];

  const threadSummary = await compressor.compressThread({
    threadId: "thread-1",
    messages,
  });
  const scratchpad = await compressor.compressRoleScratchpad({
    threadId: "thread-1",
    roleId: "role-lead",
    messages,
  });

  assert.ok(threadSummary.openQuestions.some((entry) => /unresolved merge conflict/i.test(entry)));
  assert.ok(threadSummary.openQuestions.some((entry) => /approve the follow-up/i.test(entry)));
  assert.ok(scratchpad.pendingWork.some((entry) => /need approval before the retry continues/i.test(entry)));
});

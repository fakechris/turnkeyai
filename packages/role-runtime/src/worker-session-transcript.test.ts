import assert from "node:assert/strict";
import test from "node:test";

import {
  countWorkerSessionTranscriptMessages,
  readWorkerSessionTranscript,
  summarizeWorkerSessionEvidence,
} from "./worker-session-transcript";

test("worker session transcript prefers durable history over legacy lastResult", () => {
  const transcript = readWorkerSessionTranscript("worker:explore:task-1", {
    workerRunKey: "worker:explore:task-1",
    workerType: "explore",
    status: "done",
    createdAt: 1,
    updatedAt: 4,
    history: [
      {
        id: "history-1",
        role: "assistant",
        content: "Transcript final answer.",
        createdAt: 3,
        status: "completed",
      },
    ],
    lastResult: {
      workerType: "explore",
      status: "completed",
      summary: "Stale last result.",
      payload: null,
    },
  });

  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.content, "Transcript final answer.");
});

test("worker session transcript falls back to legacy lastResult when history is absent", () => {
  const state = {
    workerRunKey: "worker:explore:task-1",
    workerType: "explore" as const,
    status: "done" as const,
    createdAt: 1,
    updatedAt: 4,
    currentTaskId: "task-1",
    lastResult: {
      workerType: "explore" as const,
      status: "completed" as const,
      summary: "Legacy result.",
      payload: { source: "legacy" },
    },
  };

  const transcript = readWorkerSessionTranscript("worker:explore:task-1", state);

  assert.equal(countWorkerSessionTranscriptMessages("worker:explore:task-1", state), 1);
  assert.deepEqual(transcript[0], {
    id: "worker-history:worker:explore:task-1:legacy-result",
    role: "tool",
    toolName: "explore",
    status: "completed",
    content: "Legacy result.",
    payload: { source: "legacy" },
    createdAt: 4,
    taskId: "task-1",
  });
});

test("worker session evidence summary uses latest transcript evidence before stale summaries", () => {
  const summary = summarizeWorkerSessionEvidence({
    workerRunKey: "worker:browser:task-1",
    workerType: "browser",
    status: "resumable",
    createdAt: 1,
    updatedAt: 5,
    history: [
      {
        id: "history-1",
        role: "user",
        content: "Open checkout.",
        createdAt: 2,
      },
      {
        id: "history-2",
        role: "tool",
        content: "Navigation failed.",
        status: "failed",
        createdAt: 3,
      },
      {
        id: "history-3",
        role: "assistant",
        content: "Verified checkout total is $42.",
        status: "completed",
        createdAt: 4,
      },
    ],
    continuationDigest: {
      reason: "timeout_summary",
      summary: "Timeout after browser operation.",
      createdAt: 5,
    },
    lastResult: {
      workerType: "browser",
      status: "completed",
      summary: "Old browser result.",
      payload: null,
    },
  });

  assert.equal(summary, "Verified checkout total is $42.");
});

test("worker session evidence summary ignores no-usable-evidence timeout summaries", () => {
  const summary = summarizeWorkerSessionEvidence({
    workerRunKey: "worker:explore:task-1",
    workerType: "explore",
    status: "resumable",
    createdAt: 1,
    updatedAt: 5,
    history: [
      {
        id: "history-generic-interrupt",
        role: "tool",
        content: "Sub-agent interrupted before completion.",
        status: "partial",
        createdAt: 3,
      },
      {
        id: "history-timeout-summary",
        role: "assistant",
        content:
          "## Timeout Summary - No Usable Evidence Gathered\n\nWhat Was Verified\n- Nothing. The sub-agent timed out before any verifiable evidence was collected.",
        status: "completed",
        createdAt: 4,
      },
    ],
    continuationDigest: {
      reason: "timeout_summary",
      summary: "No usable evidence gathered before timeout.",
      createdAt: 5,
    },
    lastResult: {
      workerType: "explore",
      status: "partial",
      summary: "No verifiable evidence was captured.",
      payload: null,
    },
  });

  assert.equal(summary, null);
});

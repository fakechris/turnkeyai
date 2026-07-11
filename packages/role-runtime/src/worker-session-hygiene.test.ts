import assert from "node:assert/strict";
import test from "node:test";

import type {
  TeamMessage,
  WorkerRuntime,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

import { sweepOrphanWorkerSessions } from "./worker-session-hygiene";

test("sweepOrphanWorkerSessions keeps fresh sessions owned by an in-flight journal", async () => {
  const runtime = fakeRuntime([session("worker-1", "running", 900)]);

  const result = await sweepOrphanWorkerSessions({
    workerRuntime: runtime,
    runJournalStore: journalStore("in_flight"),
    now: () => 1_000,
    staleAfterMs: 500,
  });

  assert.deepEqual(result, { scanned: 1, cancelled: 0, retained: 1 });
  assert.deepEqual(runtime.cancelled, []);
});

test("sweepOrphanWorkerSessions cancels active sessions after the parent journal completes", async () => {
  const runtime = fakeRuntime([
    session("worker-running", "running", 990),
    session("worker-resumable", "resumable", 990),
  ]);

  const result = await sweepOrphanWorkerSessions({
    workerRuntime: runtime,
    runJournalStore: journalStore("completed"),
    now: () => 1_000,
    staleAfterMs: 500,
  });

  assert.equal(result.cancelled, 1);
  assert.deepEqual(runtime.cancelled, ["worker-running"]);
});

test("sweepOrphanWorkerSessions retains unexpired background sessions after parent completion", async () => {
  const background = session("worker-background", "running", 990);
  background.context = {
    ...background.context!,
    background: true,
    deadlineAt: 2_000,
  };
  const runtime = fakeRuntime([background]);

  const result = await sweepOrphanWorkerSessions({
    workerRuntime: runtime,
    runJournalStore: journalStore("completed"),
    now: () => 1_000,
    staleAfterMs: 500,
  });

  assert.equal(result.cancelled, 0);
  assert.deepEqual(runtime.cancelled, []);
});

test("sweepOrphanWorkerSessions cancels stale nonterminal sessions without an owning journal", async () => {
  const runtime = fakeRuntime([
    session("worker-stale", "waiting_external", 100),
    session("worker-done", "done", 100),
  ]);

  const result = await sweepOrphanWorkerSessions({
    workerRuntime: runtime,
    runJournalStore: journalStore(null),
    now: () => 1_000,
    staleAfterMs: 500,
  });

  assert.equal(result.cancelled, 1);
  assert.deepEqual(runtime.cancelled, ["worker-stale"]);
});

function session(
  workerRunKey: string,
  status: WorkerSessionRecord["state"]["status"],
  updatedAt: number,
): WorkerSessionRecord {
  return {
    workerRunKey,
    executionToken: 1,
    state: {
      workerRunKey,
      workerType: "explore",
      status,
      createdAt: 1,
      updatedAt,
    },
    context: {
      threadId: "thread-1",
      flowId: "flow-1",
      taskId: "task-1",
      roleId: "role-lead",
      parentSpanId: "role:role:role-lead:thread:thread-1",
    },
  };
}

function fakeRuntime(records: WorkerSessionRecord[]): WorkerRuntime & {
  cancelled: string[];
} {
  const cancelled: string[] = [];
  return {
    cancelled,
    async listSessions() {
      return records;
    },
    async cancel(input: { workerRunKey: string }) {
      cancelled.push(input.workerRunKey);
      return null;
    },
  } as unknown as WorkerRuntime & { cancelled: string[] };
}

function journalStore(status: "in_flight" | "completed" | null): {
  get(messageId: string): Promise<TeamMessage | null>;
} {
  return {
    async get(messageId) {
      if (!status) return null;
      return {
        id: messageId,
        threadId: "thread-1",
        role: "system",
        name: "Lead",
        content: "",
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          runJournal: {
            protocol: "turnkeyai.run_journal.v1",
            status,
            runKey: "role:role-lead:thread:thread-1",
          },
        },
      };
    },
  };
}

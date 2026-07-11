import type {
  TeamMessageStore,
  WorkerRuntime,
  WorkerSessionRecord,
} from "@turnkeyai/core-types/team";

import { RUN_JOURNAL_PROTOCOL } from "./react-engine/run-journal";

const TERMINAL_WORKER_STATUSES = new Set(["done", "failed", "cancelled"]);
const ACTIVE_WORKER_STATUSES = new Set(["running", "idle"]);

export interface WorkerSessionHygieneResult {
  scanned: number;
  cancelled: number;
  retained: number;
}

export async function sweepOrphanWorkerSessions(input: {
  workerRuntime: Pick<WorkerRuntime, "cancel" | "listSessions">;
  runJournalStore: Pick<TeamMessageStore, "get">;
  now: () => number;
  staleAfterMs: number;
  onError?: (error: unknown, workerRunKey: string) => void;
}): Promise<WorkerSessionHygieneResult> {
  const sessions = input.workerRuntime.listSessions
    ? await input.workerRuntime.listSessions()
    : [];
  let cancelled = 0;
  let retained = 0;

  for (const session of sessions) {
    if (TERMINAL_WORKER_STATUSES.has(session.state.status)) {
      retained += 1;
      continue;
    }
    const parentRunKey = readParentRunKey(session);
    const journal = parentRunKey
      ? await input.runJournalStore.get(`runtime-journal:${parentRunKey}`)
      : null;
    const journalStatus = readJournalStatus(journal?.metadata?.["runJournal"]);
    const stale =
      input.now() - session.state.updatedAt > Math.max(0, input.staleAfterMs);
    const backgroundDeadlineAt = session.context?.background
      ? session.context.deadlineAt
      : undefined;
    const backgroundExpired =
      backgroundDeadlineAt !== undefined && input.now() >= backgroundDeadlineAt;
    const unexpiredBackground =
      session.context?.background === true &&
      backgroundDeadlineAt !== undefined &&
      !backgroundExpired;
    const shouldCancel =
      backgroundExpired ||
      (!unexpiredBackground && journalStatus === "completed" &&
        ACTIVE_WORKER_STATUSES.has(session.state.status)) ||
      (!unexpiredBackground && journalStatus === null && stale) ||
      (!unexpiredBackground && journalStatus === "in_flight" && stale);
    if (!shouldCancel) {
      retained += 1;
      continue;
    }
    try {
      await input.workerRuntime.cancel({
        workerRunKey: session.workerRunKey,
        reason:
          backgroundExpired
            ? "background worker deadline expired"
            : journalStatus === "completed"
            ? "owning role run completed"
            : "orphan worker session exceeded retention TTL",
      });
      cancelled += 1;
    } catch (error) {
      retained += 1;
      input.onError?.(error, session.workerRunKey);
    }
  }

  return { scanned: sessions.length, cancelled, retained };
}

function readParentRunKey(session: WorkerSessionRecord): string | null {
  const parentSpanId = session.context?.parentSpanId;
  return parentSpanId?.startsWith("role:")
    ? parentSpanId.slice("role:".length)
    : session.context?.parentSessionKey ?? null;
}

function readJournalStatus(
  value: unknown,
): "in_flight" | "completed" | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const journal = value as Record<string, unknown>;
  if (journal["protocol"] !== RUN_JOURNAL_PROTOCOL) return null;
  return journal["status"] === "in_flight" || journal["status"] === "completed"
    ? journal["status"]
    : null;
}

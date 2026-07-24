import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { ToolResult } from "@turnkeyai/agent-core/tool";
import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";
import { KeyedAsyncMutex } from "@turnkeyai/shared-utils/async-mutex";

import { RunEffectLedger } from "./effect-ledger";

export const RUN_EFFECT_WAL_PROTOCOL = "turnkeyai.effect_wal.v1" as const;

/**
 * A single durable effect-ledger transition. The run journal appends one of
 * these per admit/start/result instead of rewriting the whole journal
 * (transcript + full ledger) on every transition. `seq` is a per-run
 * monotonic counter; the journal snapshot records the highest seq it has
 * folded in (its watermark), and recovery replays only entries above that
 * watermark, so a crash between the snapshot write and the WAL truncation
 * re-applies nothing.
 */
export type EffectWalEntry =
  | { seq: number; op: "admit"; round: number; call: LLMToolCall }
  | { seq: number; op: "start"; effectId: string }
  | { seq: number; op: "result"; result: ToolResult };

export interface RunEffectWalStore {
  /** Append one transition durably (must fsync before resolving). */
  append(runKey: string, entry: EffectWalEntry): Promise<void>;
  /** All entries currently in the WAL, in append order. */
  readAll(runKey: string): Promise<EffectWalEntry[]>;
  /** Drop the WAL after its transitions are durable in a journal snapshot. */
  truncate(runKey: string): Promise<void>;
}

/**
 * Replay WAL entries whose seq is strictly greater than `afterSeq` onto a
 * ledger already restored from the journal snapshot. Entries at or below the
 * watermark are already reflected in the snapshot, so skipping them keeps
 * replay idempotent across the snapshot/WAL crash boundary. Returns the
 * highest seq observed (>= afterSeq) so the caller can continue the counter.
 */
export function replayEffectWal(
  ledger: RunEffectLedger,
  entries: readonly EffectWalEntry[],
  afterSeq: number,
): number {
  let highestSeq = afterSeq;
  const ordered = [...entries]
    .filter((entry) => entry.seq > afterSeq)
    .sort((left, right) => left.seq - right.seq);
  for (const entry of ordered) {
    highestSeq = Math.max(highestSeq, entry.seq);
    applyEffectWalEntry(ledger, entry);
  }
  return highestSeq;
}

function applyEffectWalEntry(
  ledger: RunEffectLedger,
  entry: EffectWalEntry,
): void {
  // Replay is best-effort against a malformed/partial log: a transition that
  // cannot legally apply (e.g. a start for an effect the snapshot never
  // admitted) is skipped rather than aborting the whole recovery, which
  // would strand the run. The resume reconciliation downstream converts any
  // resulting non-terminal effect to a safe not-dispatched/indeterminate
  // result and never redispatches it.
  try {
    switch (entry.op) {
      case "admit":
        ledger.admit({ round: entry.round, call: entry.call });
        return;
      case "start":
        ledger.start(entry.effectId);
        return;
      case "result":
        ledger.recordResult(entry.result);
        return;
    }
  } catch {
    // Skip an inapplicable transition; see the comment above.
  }
}

export function highestWalSeq(entries: readonly EffectWalEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
}

/**
 * In-memory WAL store for tests and for callers that do not wire a durable
 * WAL (the run journal falls back to full-journal writes when no store is
 * provided, so this is only a convenience for exercising the WAL path).
 */
export class InMemoryRunEffectWalStore implements RunEffectWalStore {
  private readonly logs = new Map<string, EffectWalEntry[]>();

  async append(runKey: string, entry: EffectWalEntry): Promise<void> {
    const log = this.logs.get(runKey) ?? [];
    log.push(structuredClone(entry));
    this.logs.set(runKey, log);
  }

  async readAll(runKey: string): Promise<EffectWalEntry[]> {
    return structuredClone(this.logs.get(runKey) ?? []);
  }

  async truncate(runKey: string): Promise<void> {
    this.logs.delete(runKey);
  }
}

/**
 * Append-only, one-file-per-run durable WAL. Appends are fsync'd before
 * resolving so "admit persisted before dispatch" holds. Reads tolerate a
 * torn trailing line (an append interrupted by a crash): that transition
 * never became durable, so the corresponding tool never dispatched, and
 * dropping it is correct.
 */
export class FileRunEffectWalStore implements RunEffectWalStore {
  private readonly rootDir: string;
  private readonly mutex = new KeyedAsyncMutex<string>();

  constructor(options: { rootDir: string }) {
    this.rootDir = options.rootDir;
  }

  async append(runKey: string, entry: EffectWalEntry): Promise<void> {
    await this.mutex.run(runKey, async () => {
      await mkdir(this.rootDir, { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      const handle = await open(this.walPath(runKey), "a");
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  async readAll(runKey: string): Promise<EffectWalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.walPath(runKey), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const entries: EffectWalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      const parsed = parseWalLine(line);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  async truncate(runKey: string): Promise<void> {
    await this.mutex.run(runKey, async () => {
      await rm(this.walPath(runKey), { force: true });
    });
  }

  private walPath(runKey: string): string {
    return path.join(this.rootDir, `${encodeURIComponent(runKey)}.jsonl`);
  }
}

function parseWalLine(line: string): EffectWalEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { seq?: unknown }).seq !== "number"
  ) {
    return null;
  }
  const op = (value as { op?: unknown }).op;
  if (op === "admit" || op === "start" || op === "result") {
    return value as EffectWalEntry;
  }
  return null;
}

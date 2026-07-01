// Stage 8 engine cleanup — concrete EnginePolicyTrace implementation.
//
// The policy trace is an observability sink for policy decisions: each module
// records which policy fired or skipped, in which phase, and why. It records
// facts about decisions; it does not make decisions. See the plan's
// "Hook Orchestration Contract" and the EnginePolicyTrace contract in types.ts.
import type { EnginePolicyTrace, EnginePolicyTraceEntry } from "./types";

/**
 * In-memory policy trace recorder. Entries are appended in fire order and
 * exposed as an immutable snapshot copy so callers cannot mutate the ledger.
 */
export class InMemoryEnginePolicyTrace implements EnginePolicyTrace {
  private readonly entries: EnginePolicyTraceEntry[] = [];

  record(entry: EnginePolicyTraceEntry): void {
    this.entries.push(entry);
  }

  snapshot(): EnginePolicyTraceEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

/**
 * Convenience factory so the composition root and tests do not depend on the
 * concrete class name.
 */
export function createEnginePolicyTrace(): EnginePolicyTrace {
  return new InMemoryEnginePolicyTrace();
}

/**
 * No-op trace used where an EnginePolicyTrace is optional. Recording is a
 * no-op and the snapshot is always empty. Keeping this here avoids each module
 * inventing its own null-object.
 */
export const NOOP_ENGINE_POLICY_TRACE: EnginePolicyTrace = {
  record(): void {
    /* intentionally empty */
  },
  snapshot(): EnginePolicyTraceEntry[] {
    return [];
  },
};

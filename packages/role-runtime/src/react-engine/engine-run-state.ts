// Stage 8 engine cleanup — mutable cross-hook run-state owner (module shell).
//
// EngineRunState is the ONLY mutable cross-hook run-state owner for one engine
// run. Controllers and registries return typed decisions; the adapter applies
// them here. This module must not import predicates or policy modules, must not
// parse text, execute tools, or synthesize answers.
//
// Batch 0 provides the public shape and a minimal, behavior-neutral
// implementation. The real cross-hook state migration lands in Batch 1
// ("Extract Observability, Normalization, And Finalization"). The signal input
// shapes below are intentionally minimal placeholders and are widened in later
// batches as the owning controllers/registries are extracted.
import type { CloseoutDecision, LLMMessage } from "./types";

export interface CompletedSessionSignal {
  /** Raw tool results from the round that completed the sub-agent session. */
  toolResults?: unknown[];
  /** Sticky completed metadata payload, if any. */
  metadata?: Record<string, unknown>;
}

export interface TimeoutSignal {
  metadata?: Record<string, unknown>;
}

export interface ReductionSignal {
  metadata?: Record<string, unknown>;
}

export interface MemoryFlushSignal {
  metadata?: Record<string, unknown>;
}

export interface EngineRunStateSnapshot {
  repairMarkers: readonly string[];
  pendingCloseout: CloseoutDecision | null;
  completedSession: CompletedSessionSignal | null;
  timeoutSignal: TimeoutSignal | null;
  reduction: ReductionSignal | null;
  memoryFlushes: readonly MemoryFlushSignal[];
  finalMessages: readonly LLMMessage[] | null;
}

export interface EngineRunState {
  repairMarkers(): readonly string[];
  recordRepairMarker(marker: string): void;
  applyPendingCloseout(decision: CloseoutDecision): void;
  recordCompletedSession(input: CompletedSessionSignal): void;
  recordTimeoutSignal(input: TimeoutSignal): void;
  recordReduction(input: ReductionSignal): void;
  recordMemoryFlush(input: MemoryFlushSignal): void;
  captureFinalMessages(messages: readonly LLMMessage[]): void;
  captureFinalMessagesIfAbsent(messages: readonly LLMMessage[]): void;
  snapshot(): EngineRunStateSnapshot;
}

/**
 * Minimal EngineRunState implementation.
 *
 * Mutation rules (per plan "Mutable Run-State Ownership"):
 * - reduction is last-wins.
 * - memoryFlushes is append-only.
 * - finalMessages is a first-closeout/error snapshot; captureFinalMessagesIfAbsent
 *   fills it only when absent (natural finish).
 */
class DefaultEngineRunState implements EngineRunState {
  private readonly markerLedger: string[] = [];
  private pendingCloseout: CloseoutDecision | null = null;
  private completedSession: CompletedSessionSignal | null = null;
  private timeoutSignal: TimeoutSignal | null = null;
  private reduction: ReductionSignal | null = null;
  private readonly memoryFlushes: MemoryFlushSignal[] = [];
  private finalMessages: LLMMessage[] | null = null;

  repairMarkers(): readonly string[] {
    return this.markerLedger.slice();
  }

  recordRepairMarker(marker: string): void {
    this.markerLedger.push(marker);
  }

  applyPendingCloseout(decision: CloseoutDecision): void {
    this.pendingCloseout = decision;
  }

  recordCompletedSession(input: CompletedSessionSignal): void {
    this.completedSession = input;
  }

  recordTimeoutSignal(input: TimeoutSignal): void {
    this.timeoutSignal = input;
  }

  recordReduction(input: ReductionSignal): void {
    // last-wins
    this.reduction = input;
  }

  recordMemoryFlush(input: MemoryFlushSignal): void {
    // append-only
    this.memoryFlushes.push(input);
  }

  captureFinalMessages(messages: readonly LLMMessage[]): void {
    this.finalMessages = messages.slice();
  }

  captureFinalMessagesIfAbsent(messages: readonly LLMMessage[]): void {
    if (this.finalMessages === null) {
      this.finalMessages = messages.slice();
    }
  }

  snapshot(): EngineRunStateSnapshot {
    return {
      repairMarkers: this.markerLedger.slice(),
      pendingCloseout: this.pendingCloseout,
      completedSession: this.completedSession,
      timeoutSignal: this.timeoutSignal,
      reduction: this.reduction,
      memoryFlushes: this.memoryFlushes.slice(),
      finalMessages: this.finalMessages === null ? null : this.finalMessages.slice(),
    };
  }
}

export function createEngineRunState(): EngineRunState {
  return new DefaultEngineRunState();
}

// Stage 8 engine cleanup — mutable cross-hook run-state owner.
//
// EngineRunState is the only mutable cross-hook run-state owner for one engine
// run. Controllers and registries return typed decisions; the adapter applies
// them here. This module must not import predicates or policy modules, must not
// parse text, execute tools, or synthesize answers.
import type {
  GenerateTextResult,
  LLMMessage,
} from "@turnkeyai/llm-adapter/index";

import type { PreCompactionMemoryFlushResult } from "../pre-compaction-memory-flusher";
import type {
  RequestEnvelopeReductionLevel,
  RequestEnvelopeReductionSnapshot,
} from "../request-envelope-reducer";
import type { ToolLoopCloseoutMetadata } from "../runtime-derived-mission-report";
import type {
  collectToolResultContentText,
  findCompletedSessionEvidence,
  findSubAgentToolTimeout,
} from "../tool-result-evidence";

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

export interface DefaultEngineRunStateValues {
  ToolLoopCloseout: unknown;
  CloseoutResult: unknown;
  Reduction: ReductionSignal;
  ReductionSnapshot: unknown;
  MemoryFlush: MemoryFlushSignal;
  CompletedSession: CompletedSessionSignal;
  CompletedSessionToolResults: unknown;
  TimeoutSignal: TimeoutSignal;
  PendingCloseout: unknown;
}

export interface RoleEngineRunStateValues extends DefaultEngineRunStateValues {
  ToolLoopCloseout: ToolLoopCloseoutMetadata;
  CloseoutResult: GenerateTextResult;
  Reduction: {
    level: RequestEnvelopeReductionLevel;
    omittedSections: string[];
  } & ReductionSignal;
  ReductionSnapshot: RequestEnvelopeReductionSnapshot | undefined;
  MemoryFlush: PreCompactionMemoryFlushResult & MemoryFlushSignal;
  CompletedSession: NonNullable<
    ReturnType<typeof findCompletedSessionEvidence>
  > &
    CompletedSessionSignal;
  CompletedSessionToolResults: Parameters<
    typeof collectToolResultContentText
  >[0];
  TimeoutSignal: NonNullable<ReturnType<typeof findSubAgentToolTimeout>> &
    TimeoutSignal;
  PendingCloseout: {
    reasonLines: string[];
    closeout: ToolLoopCloseoutMetadata;
  };
}

export type RoleEngineRunState = EngineRunState<RoleEngineRunStateValues>;

export interface EngineRunStateSnapshot<
  TValues extends DefaultEngineRunStateValues = DefaultEngineRunStateValues,
> {
  repairMarkers: readonly string[];
  toolLoopCloseout: TValues["ToolLoopCloseout"] | undefined;
  closeoutResult: TValues["CloseoutResult"] | undefined;
  pendingCloseout: TValues["PendingCloseout"] | undefined;
  completedSession: TValues["CompletedSession"] | undefined;
  completedSessionToolResults:
    | TValues["CompletedSessionToolResults"]
    | undefined;
  timeoutSignal: TValues["TimeoutSignal"] | undefined;
  reduction: TValues["Reduction"] | undefined;
  reductionSnapshot: TValues["ReductionSnapshot"] | undefined;
  memoryFlushes: readonly TValues["MemoryFlush"][];
  finalMessages: readonly LLMMessage[] | undefined;
}

export interface EngineRunState<
  TValues extends DefaultEngineRunStateValues = DefaultEngineRunStateValues,
> {
  repairMarkers(): readonly string[];
  recordRepairMarker(marker: string): void;

  toolLoopCloseout(): TValues["ToolLoopCloseout"] | undefined;
  recordToolLoopCloseout(input: TValues["ToolLoopCloseout"]): void;
  recordToolLoopCloseoutIfAbsent(input: TValues["ToolLoopCloseout"]): void;

  closeoutResult(): TValues["CloseoutResult"] | undefined;
  recordCloseoutResult(input: TValues["CloseoutResult"]): void;

  pendingCloseout(): TValues["PendingCloseout"] | undefined;
  recordPendingCloseout(input: TValues["PendingCloseout"]): void;

  completedSession(): TValues["CompletedSession"] | undefined;
  completedSessionToolResults():
    | TValues["CompletedSessionToolResults"]
    | undefined;
  recordCompletedSession(input: {
    session: TValues["CompletedSession"];
    toolResults: TValues["CompletedSessionToolResults"];
  }): void;

  timeoutSignal(): TValues["TimeoutSignal"] | undefined;
  recordTimeoutSignal(input: TValues["TimeoutSignal"]): void;

  reduction(): TValues["Reduction"] | undefined;
  reductionSnapshot(): TValues["ReductionSnapshot"] | undefined;
  recordReduction(input: {
    reduction: TValues["Reduction"];
    reductionSnapshot: TValues["ReductionSnapshot"] | undefined;
  }): void;

  memoryFlushes(): readonly TValues["MemoryFlush"][];
  recordMemoryFlush(input: TValues["MemoryFlush"]): void;

  finalMessages(): readonly LLMMessage[] | undefined;
  captureFinalMessages(messages: readonly LLMMessage[]): void;
  captureFinalMessagesIfAbsent(messages: readonly LLMMessage[]): void;

  snapshot(): EngineRunStateSnapshot<TValues>;
}

/**
 * Mutation rules:
 * - toolLoopCloseout can be sticky via recordToolLoopCloseoutIfAbsent.
 * - reduction is last-wins and carries its matching snapshot.
 * - memoryFlushes is append-only.
 * - finalMessages is a first-closeout/error snapshot; captureFinalMessagesIfAbsent
 *   fills it only when absent (natural finish).
 */
class DefaultEngineRunState<
  TValues extends DefaultEngineRunStateValues,
> implements EngineRunState<TValues> {
  private readonly markerLedger: string[] = [];
  private toolLoopCloseoutValue: TValues["ToolLoopCloseout"] | undefined;
  private closeoutResultValue: TValues["CloseoutResult"] | undefined;
  private pendingCloseoutValue: TValues["PendingCloseout"] | undefined;
  private completedSessionValue: TValues["CompletedSession"] | undefined;
  private completedSessionToolResultsValue:
    | TValues["CompletedSessionToolResults"]
    | undefined;
  private timeoutSignalValue: TValues["TimeoutSignal"] | undefined;
  private reductionValue: TValues["Reduction"] | undefined;
  private reductionSnapshotValue: TValues["ReductionSnapshot"] | undefined;
  private readonly memoryFlushValues: TValues["MemoryFlush"][] = [];
  private finalMessageValues: LLMMessage[] | undefined;

  repairMarkers(): readonly string[] {
    return this.markerLedger.slice();
  }

  recordRepairMarker(marker: string): void {
    this.markerLedger.push(marker);
  }

  toolLoopCloseout(): TValues["ToolLoopCloseout"] | undefined {
    return this.toolLoopCloseoutValue;
  }

  recordToolLoopCloseout(input: TValues["ToolLoopCloseout"]): void {
    this.toolLoopCloseoutValue = input;
  }

  recordToolLoopCloseoutIfAbsent(input: TValues["ToolLoopCloseout"]): void {
    this.toolLoopCloseoutValue ??= input;
  }

  closeoutResult(): TValues["CloseoutResult"] | undefined {
    return this.closeoutResultValue;
  }

  recordCloseoutResult(input: TValues["CloseoutResult"]): void {
    this.closeoutResultValue = input;
  }

  pendingCloseout(): TValues["PendingCloseout"] | undefined {
    return this.pendingCloseoutValue;
  }

  recordPendingCloseout(input: TValues["PendingCloseout"]): void {
    this.pendingCloseoutValue = input;
  }

  completedSession(): TValues["CompletedSession"] | undefined {
    return this.completedSessionValue;
  }

  completedSessionToolResults():
    | TValues["CompletedSessionToolResults"]
    | undefined {
    return this.completedSessionToolResultsValue;
  }

  recordCompletedSession(input: {
    session: TValues["CompletedSession"];
    toolResults: TValues["CompletedSessionToolResults"];
  }): void {
    this.completedSessionValue = input.session;
    this.completedSessionToolResultsValue = input.toolResults;
  }

  timeoutSignal(): TValues["TimeoutSignal"] | undefined {
    return this.timeoutSignalValue;
  }

  recordTimeoutSignal(input: TValues["TimeoutSignal"]): void {
    this.timeoutSignalValue = input;
  }

  reduction(): TValues["Reduction"] | undefined {
    return this.reductionValue;
  }

  reductionSnapshot(): TValues["ReductionSnapshot"] | undefined {
    return this.reductionSnapshotValue;
  }

  recordReduction(input: {
    reduction: TValues["Reduction"];
    reductionSnapshot: TValues["ReductionSnapshot"] | undefined;
  }): void {
    this.reductionValue = input.reduction;
    this.reductionSnapshotValue = input.reductionSnapshot;
  }

  memoryFlushes(): readonly TValues["MemoryFlush"][] {
    return this.memoryFlushValues.slice();
  }

  recordMemoryFlush(input: TValues["MemoryFlush"]): void {
    this.memoryFlushValues.push(input);
  }

  finalMessages(): readonly LLMMessage[] | undefined {
    return this.finalMessageValues?.slice();
  }

  captureFinalMessages(messages: readonly LLMMessage[]): void {
    this.finalMessageValues = messages.slice();
  }

  captureFinalMessagesIfAbsent(messages: readonly LLMMessage[]): void {
    this.finalMessageValues ??= messages.slice();
  }

  snapshot(): EngineRunStateSnapshot<TValues> {
    return {
      repairMarkers: this.markerLedger.slice(),
      toolLoopCloseout: this.toolLoopCloseoutValue,
      closeoutResult: this.closeoutResultValue,
      pendingCloseout: this.pendingCloseoutValue,
      completedSession: this.completedSessionValue,
      completedSessionToolResults: this.completedSessionToolResultsValue,
      timeoutSignal: this.timeoutSignalValue,
      reduction: this.reductionValue,
      reductionSnapshot: this.reductionSnapshotValue,
      memoryFlushes: this.memoryFlushValues.slice(),
      finalMessages: this.finalMessageValues?.slice(),
    };
  }
}

export function createEngineRunState<
  TValues extends DefaultEngineRunStateValues = DefaultEngineRunStateValues,
>(): EngineRunState<TValues> {
  return new DefaultEngineRunState<TValues>();
}

export function createRoleEngineRunState(): RoleEngineRunState {
  return createEngineRunState<RoleEngineRunStateValues>();
}

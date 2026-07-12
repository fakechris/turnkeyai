import assert from "node:assert/strict";

export type Ownership = "attached" | "detached";

export type ScopeState =
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "waiting"; handle: string; reason: string }
  | { kind: "succeeded"; resultRef: string }
  | { kind: "failed"; errorCode: string }
  | { kind: "cancelled"; reason: string };

export interface BudgetEnvelope {
  deadlineAt?: number;
  maxTurns?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxRetries?: number;
  maxTokens?: number;
  maxCost?: number;
  maxConcurrency?: number;
}

export interface ScopeRecord {
  scopeId: string;
  parentScopeId?: string;
  ownership: Ownership;
  state: ScopeState;
  budget: BudgetEnvelope;
}

export interface EffectRecord {
  effectId: string;
  signature: string;
  scopeId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  resultRef?: string;
}

export interface RuntimeState {
  now: number;
  rootScopeId: string;
  scopes: Record<string, ScopeRecord>;
  effects: Record<string, EffectRecord>;
  notifications: Array<{ scopeId: string; state: ScopeState }>;
}

export type RuntimeEvent =
  | { type: "runtime_started"; at: number; root: ScopeRecord }
  | { type: "clock_advanced"; at: number }
  | { type: "effect_committed"; at: number; effect: EffectRecord; scope: ScopeRecord }
  | { type: "scope_detached"; at: number; scopeId: string }
  | { type: "scope_waiting"; at: number; scopeId: string; handle: string; reason: string }
  | { type: "scope_succeeded"; at: number; scopeId: string; resultRef: string }
  | { type: "scope_failed"; at: number; scopeId: string; errorCode: string }
  | { type: "scope_cancelled"; at: number; scopeId: string; reason: string }
  | { type: "notification_enqueued"; at: number; scopeId: string; state: ScopeState };

export interface EffectProposal {
  effectId: string;
  signature: string;
  scopeId: string;
  explicitBudget?: BudgetEnvelope;
  platformBudget?: BudgetEnvelope;
  policyBudget?: BudgetEnvelope;
}

export interface EffectReceipt {
  effectId: string;
  scopeId: string;
  created: boolean;
}

export interface ObserverSnapshot {
  now: number;
  rootState: ScopeState["kind"];
  running: number;
  waiting: number;
  terminal: number;
  detached: number;
  effects: number;
}

const FINITE_BUDGET_KEYS = [
  "deadlineAt",
  "maxTurns",
  "maxModelCalls",
  "maxToolCalls",
  "maxRetries",
  "maxTokens",
  "maxCost",
  "maxConcurrency",
] as const satisfies ReadonlyArray<keyof BudgetEnvelope>;

export function meetBudgets(...budgets: Array<BudgetEnvelope | undefined>): BudgetEnvelope {
  const result: BudgetEnvelope = {};
  for (const key of FINITE_BUDGET_KEYS) {
    const values = budgets
      .map((budget) => budget?.[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length > 0) {
      result[key] = Math.min(...values);
    }
  }
  return result;
}

export function requestedTimeoutBudget(now: number, timeoutMs?: number): BudgetEnvelope | undefined {
  if (timeoutMs === undefined) return undefined;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 0, "timeout must be a non-negative finite duration");
  return { deadlineAt: now + timeoutMs };
}

export function isTerminal(state: ScopeState): boolean {
  return state.kind === "succeeded" || state.kind === "failed" || state.kind === "cancelled";
}

export function reduceRuntime(events: readonly RuntimeEvent[]): RuntimeState {
  let state: RuntimeState | undefined;
  for (const event of events) {
    if (event.type === "runtime_started") {
      assert.equal(state, undefined, "runtime can start only once");
      state = {
        now: event.at,
        rootScopeId: event.root.scopeId,
        scopes: { [event.root.scopeId]: structuredClone(event.root) },
        effects: {},
        notifications: [],
      };
      continue;
    }
    assert.ok(state, "runtime must start before other events");
    state.now = Math.max(state.now, event.at);
    switch (event.type) {
      case "clock_advanced":
        break;
      case "effect_committed":
        assert.equal(state.effects[event.effect.effectId], undefined, "effect id already committed");
        assert.equal(state.scopes[event.scope.scopeId], undefined, "scope id already exists");
        state.effects[event.effect.effectId] = structuredClone(event.effect);
        state.scopes[event.scope.scopeId] = structuredClone(event.scope);
        break;
      case "scope_detached": {
        const scope = requiredScope(state, event.scopeId);
        assert.equal(isTerminal(scope.state), false, "terminal scope cannot detach");
        scope.ownership = "detached";
        break;
      }
      case "scope_waiting": {
        const scope = requiredScope(state, event.scopeId);
        assert.equal(isTerminal(scope.state), false, "terminal scope cannot wait");
        scope.state = { kind: "waiting", handle: event.handle, reason: event.reason };
        break;
      }
      case "scope_succeeded":
        transitionTerminal(state, event.scopeId, { kind: "succeeded", resultRef: event.resultRef });
        updateEffectForScope(state, event.scopeId, "succeeded", event.resultRef);
        break;
      case "scope_failed":
        transitionTerminal(state, event.scopeId, { kind: "failed", errorCode: event.errorCode });
        updateEffectForScope(state, event.scopeId, "failed");
        break;
      case "scope_cancelled":
        transitionTerminal(state, event.scopeId, { kind: "cancelled", reason: event.reason });
        updateEffectForScope(state, event.scopeId, "cancelled");
        break;
      case "notification_enqueued":
        state.notifications.push({ scopeId: event.scopeId, state: structuredClone(event.state) });
        break;
    }
  }
  assert.ok(state, "runtime journal is empty");
  return state;
}

export class ReferenceRuntime {
  readonly journal: RuntimeEvent[];
  private stateValue: RuntimeState;

  constructor(input: { now?: number; rootBudget?: BudgetEnvelope; journal?: RuntimeEvent[] } = {}) {
    if (input.journal) {
      this.journal = structuredClone(input.journal);
      this.stateValue = reduceRuntime(this.journal);
      return;
    }
    const now = input.now ?? 0;
    const started: RuntimeEvent = {
      type: "runtime_started",
      at: now,
      root: {
        scopeId: "query",
        ownership: "attached",
        state: { kind: "running" },
        budget: structuredClone(input.rootBudget ?? {}),
      },
    };
    this.journal = [started];
    this.stateValue = reduceRuntime(this.journal);
  }

  get state(): RuntimeState {
    return structuredClone(this.stateValue);
  }

  advance(ms: number): void {
    assert.ok(Number.isFinite(ms) && ms >= 0, "clock advance must be non-negative");
    this.append({ type: "clock_advanced", at: this.stateValue.now + ms });
    this.expireDueScopes();
  }

  proposeEffect(proposal: EffectProposal): EffectReceipt {
    const root = requiredScope(this.stateValue, this.stateValue.rootScopeId);
    assert.equal(root.state.kind, "running", "terminal query cannot commit effects");
    const existing = this.stateValue.effects[proposal.effectId];
    if (existing) {
      assert.equal(existing.signature, proposal.signature, "effect id reused with a different proposal");
      return { effectId: existing.effectId, scopeId: existing.scopeId, created: false };
    }
    const parentBudget = root.budget;
    const budget = meetBudgets(
      parentBudget,
      proposal.explicitBudget,
      proposal.platformBudget,
      proposal.policyBudget,
    );
    const scope: ScopeRecord = {
      scopeId: proposal.scopeId,
      parentScopeId: root.scopeId,
      ownership: "attached",
      state: { kind: "running" },
      budget,
    };
    const effect: EffectRecord = {
      effectId: proposal.effectId,
      signature: proposal.signature,
      scopeId: scope.scopeId,
      status: "running",
    };
    this.append({ type: "effect_committed", at: this.stateValue.now, effect, scope });
    return { effectId: effect.effectId, scopeId: scope.scopeId, created: true };
  }

  wait(scopeId: string, waitMs: number): { kind: "ready"; state: ScopeState } | { kind: "not_ready"; handle: string } {
    assert.ok(Number.isFinite(waitMs) && waitMs >= 0, "wait must be a non-negative finite duration");
    const scope = requiredScope(this.stateValue, scopeId);
    if (isTerminal(scope.state)) return { kind: "ready", state: structuredClone(scope.state) };
    this.advance(waitMs);
    const latest = requiredScope(this.stateValue, scopeId);
    if (isTerminal(latest.state)) return { kind: "ready", state: structuredClone(latest.state) };
    const handle = `task:${scopeId}`;
    this.append({ type: "scope_waiting", at: this.stateValue.now, scopeId, handle, reason: "wait_elapsed" });
    return { kind: "not_ready", handle };
  }

  detach(scopeId: string): void {
    this.append({ type: "scope_detached", at: this.stateValue.now, scopeId });
  }

  succeed(scopeId: string, resultRef: string): void {
    this.append({ type: "scope_succeeded", at: this.stateValue.now, scopeId, resultRef });
    this.notifyIfDetached(scopeId);
  }

  fail(scopeId: string, errorCode: string): void {
    this.append({ type: "scope_failed", at: this.stateValue.now, scopeId, errorCode });
    this.notifyIfDetached(scopeId);
  }

  completeQuery(resultRef: string): void {
    const root = requiredScope(this.stateValue, this.stateValue.rootScopeId);
    assert.equal(root.state.kind, "running", "query is already terminal");
    const attached = Object.values(this.stateValue.scopes).filter(
      (scope) => scope.parentScopeId === root.scopeId && scope.ownership === "attached" && !isTerminal(scope.state),
    );
    assert.deepEqual(attached.map((scope) => scope.scopeId), [], "query cannot succeed with active attached children");
    this.append({ type: "scope_succeeded", at: this.stateValue.now, scopeId: root.scopeId, resultRef });
  }

  cancelQuery(reason: string): void {
    const root = requiredScope(this.stateValue, this.stateValue.rootScopeId);
    if (isTerminal(root.state)) return;
    for (const scope of Object.values(this.stateValue.scopes)) {
      if (scope.parentScopeId === root.scopeId && scope.ownership === "attached" && !isTerminal(scope.state)) {
        this.append({ type: "scope_cancelled", at: this.stateValue.now, scopeId: scope.scopeId, reason });
      }
    }
    this.append({ type: "scope_cancelled", at: this.stateValue.now, scopeId: root.scopeId, reason });
  }

  observe(): ObserverSnapshot {
    const before = JSON.stringify(this.stateValue);
    const scopes = Object.values(this.stateValue.scopes);
    const snapshot: ObserverSnapshot = {
      now: this.stateValue.now,
      rootState: requiredScope(this.stateValue, this.stateValue.rootScopeId).state.kind,
      running: scopes.filter((scope) => scope.state.kind === "running").length,
      waiting: scopes.filter((scope) => scope.state.kind === "waiting").length,
      terminal: scopes.filter((scope) => isTerminal(scope.state)).length,
      detached: scopes.filter((scope) => scope.ownership === "detached").length,
      effects: Object.keys(this.stateValue.effects).length,
    };
    assert.equal(JSON.stringify(this.stateValue), before, "observer mutated runtime state");
    return snapshot;
  }

  replay(): ReferenceRuntime {
    return new ReferenceRuntime({ journal: this.journal });
  }

  private notifyIfDetached(scopeId: string): void {
    const scope = requiredScope(this.stateValue, scopeId);
    if (scope.ownership !== "detached") return;
    this.append({
      type: "notification_enqueued",
      at: this.stateValue.now,
      scopeId,
      state: structuredClone(scope.state),
    });
  }

  private expireDueScopes(): void {
    const rootScopeId = this.stateValue.rootScopeId;
    const dueChildren = Object.values(this.stateValue.scopes)
      .filter(
        (scope) =>
          scope.scopeId !== rootScopeId &&
          !isTerminal(scope.state) &&
          scope.budget.deadlineAt !== undefined &&
          scope.budget.deadlineAt <= this.stateValue.now,
      )
      .sort((left, right) => left.scopeId.localeCompare(right.scopeId));
    for (const scope of dueChildren) {
      this.append({
        type: "scope_failed",
        at: this.stateValue.now,
        scopeId: scope.scopeId,
        errorCode: "operation_expired",
      });
      this.notifyIfDetached(scope.scopeId);
    }

    const root = requiredScope(this.stateValue, rootScopeId);
    if (
      !isTerminal(root.state) &&
      root.budget.deadlineAt !== undefined &&
      root.budget.deadlineAt <= this.stateValue.now
    ) {
      this.cancelQuery("execution_expired");
    }
  }

  private append(event: RuntimeEvent): void {
    this.journal.push(structuredClone(event));
    this.stateValue = reduceRuntime(this.journal);
  }
}

function requiredScope(state: RuntimeState, scopeId: string): ScopeRecord {
  const scope = state.scopes[scopeId];
  assert.ok(scope, `scope not found: ${scopeId}`);
  return scope;
}

function transitionTerminal(state: RuntimeState, scopeId: string, next: ScopeState): void {
  const scope = requiredScope(state, scopeId);
  assert.equal(isTerminal(scope.state), false, "terminal transition is irreversible");
  scope.state = structuredClone(next);
}

function updateEffectForScope(
  state: RuntimeState,
  scopeId: string,
  status: EffectRecord["status"],
  resultRef?: string,
): void {
  const effect = Object.values(state.effects).find((candidate) => candidate.scopeId === scopeId);
  if (!effect) return;
  effect.status = status;
  if (resultRef !== undefined) effect.resultRef = resultRef;
}

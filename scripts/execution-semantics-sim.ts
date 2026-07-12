import assert from "node:assert/strict";

export type Ownership = "attached" | "detached";

export interface AttemptBudget {
  activeMs?: number;
  maxTurns?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCost?: number;
  maxConcurrency?: number;
}

export type ScopeState =
  | { kind: "running"; attemptId: string }
  | {
      kind: "suspended";
      handle: string;
      waitKind: "external_input" | "detached_result" | "scheduled_resume";
    }
  | { kind: "succeeded"; resultRef: string }
  | { kind: "failed"; errorCode: string }
  | { kind: "cancelled"; reason: string };

export interface ScopeRecord {
  scopeId: string;
  parentScopeId?: string;
  ownership: Ownership;
  expiresAt?: number;
  state: ScopeState;
}

export interface AttemptRecord {
  attemptId: string;
  scopeId: string;
  startedAt: number;
  deadlineAt?: number;
  state: "running" | "yielded" | "succeeded" | "failed" | "cancelled" | "indeterminate";
  budget: AttemptBudget;
}

export interface EffectRecord {
  effectId: string;
  signature: string;
  scopeId: string;
  status: "admitted" | "started" | "committed" | "failed" | "indeterminate";
  resultRef?: string;
  errorCode?: string;
}

export interface RetryAllowance {
  allowanceId: string;
  ownerScopeId: string;
  failureDomain: "model_transport" | "tool_transport" | "workflow_step";
  remainingAttempts: number;
}

export interface InboxNotification {
  notificationId: string;
  ownerScopeId: string;
  sourceScopeId: string;
  resultRef: string;
  state: "pending" | "consumed";
}

export interface JoinRecord {
  joinId: string;
  parentScopeId: string;
  childScopeId: string;
  state: "waiting" | "satisfied" | "abandoned";
}

export interface RuntimeState {
  now: number;
  rootScopeId: string;
  scopes: Record<string, ScopeRecord>;
  attempts: Record<string, AttemptRecord>;
  effects: Record<string, EffectRecord>;
  retryAllowances: Record<string, RetryAllowance>;
  notifications: Record<string, InboxNotification>;
  joins: Record<string, JoinRecord>;
}

export type RuntimeEvent =
  | {
      type: "runtime_started";
      at: number;
      root: ScopeRecord;
      attempt: AttemptRecord;
      retryAllowances: RetryAllowance[];
    }
  | { type: "clock_advanced"; at: number }
  | { type: "effect_admitted"; at: number; effect: EffectRecord; scope: ScopeRecord; attempt: AttemptRecord }
  | { type: "effect_started"; at: number; effectId: string }
  | { type: "effect_committed"; at: number; effectId: string; resultRef: string }
  | { type: "effect_failed"; at: number; effectId: string; errorCode: string }
  | { type: "effect_indeterminate"; at: number; effectId: string }
  | { type: "scope_detached"; at: number; scopeId: string }
  | {
      type: "scope_suspended";
      at: number;
      scopeId: string;
      handle: string;
      waitKind: "external_input" | "detached_result" | "scheduled_resume";
    }
  | { type: "scope_resumed"; at: number; scopeId: string; attempt: AttemptRecord }
  | { type: "scope_succeeded"; at: number; scopeId: string; resultRef: string }
  | { type: "scope_failed"; at: number; scopeId: string; errorCode: string }
  | { type: "scope_cancelled"; at: number; scopeId: string; reason: string }
  | { type: "notification_enqueued"; at: number; notification: InboxNotification }
  | { type: "notification_consumed"; at: number; notificationId: string }
  | { type: "join_created"; at: number; join: JoinRecord }
  | { type: "join_satisfied"; at: number; joinId: string }
  | { type: "join_abandoned"; at: number; joinId: string }
  | { type: "retry_consumed"; at: number; allowanceId: string };

export interface EffectProposal {
  effectId: string;
  signature: string;
  scopeId: string;
  parentScopeId?: string;
  attemptId?: string;
  scopeExpiresAt?: number;
  explicitBudget?: AttemptBudget;
  platformBudget?: AttemptBudget;
  safetyBudget?: AttemptBudget;
}

export interface EffectAdmission {
  effectId: string;
  scopeId: string;
  created: boolean;
  status: EffectRecord["status"];
}

export interface ObserverSnapshot {
  now: number;
  rootState: ScopeState["kind"];
  activeAttempts: number;
  terminalScopes: number;
  detachedScopes: number;
  pendingNotifications: number;
  indeterminateEffects: number;
}

export type TranscriptItem =
  | { kind: "message"; id: string; role: "system" | "user" | "assistant"; text: string }
  | { kind: "assistant_tool_calls"; id: string; callIds: string[] }
  | { kind: "tool_results"; id: string; callIds: string[] }
  | { kind: "summary"; id: string; sourceItemIds: string[] };

export type JournalFrame =
  | { kind: "event"; transactionId: string; event: RuntimeEvent }
  | { kind: "commit"; transactionId: string };

const ATTEMPT_BUDGET_KEYS = [
  "activeMs",
  "maxTurns",
  "maxModelCalls",
  "maxToolCalls",
  "maxTokens",
  "maxCost",
  "maxConcurrency",
] as const satisfies ReadonlyArray<keyof AttemptBudget>;

export function meetAttemptBudgets(...budgets: Array<AttemptBudget | undefined>): AttemptBudget {
  const result: AttemptBudget = {};
  for (const key of ATTEMPT_BUDGET_KEYS) {
    const values = budgets
      .map((budget) => budget?.[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length > 0) result[key] = Math.min(...values);
  }
  return result;
}

export function isTerminal(state: ScopeState): boolean {
  return state.kind === "succeeded" || state.kind === "failed" || state.kind === "cancelled";
}

export function recoverCommittedEvents(frames: readonly JournalFrame[]): RuntimeEvent[] {
  const committed = new Set(
    frames.filter((frame) => frame.kind === "commit").map((frame) => frame.transactionId),
  );
  return frames.flatMap((frame) =>
    frame.kind === "event" && committed.has(frame.transactionId)
      ? [structuredClone(frame.event)]
      : [],
  );
}

export function validateTranscript(items: readonly TranscriptItem[]): void {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "tool_results") {
      const call = items[index - 1];
      assert.equal(call?.kind, "assistant_tool_calls", "tool results must follow their assistant tool calls");
      assert.deepEqual(
        [...item.callIds].sort(),
        [...(call?.kind === "assistant_tool_calls" ? call.callIds : [])].sort(),
        "tool result ids must exactly match the preceding call ids",
      );
    }
    if (item.kind === "assistant_tool_calls") {
      const result = items[index + 1];
      assert.ok(
        result?.kind === "tool_results" || index === items.length - 1,
        "only the final tool-call unit may remain open",
      );
    }
  }
}

export function compactTranscript(
  items: readonly TranscriptItem[],
  keepRecentCompleteUnits: number,
): TranscriptItem[] {
  assert.ok(Number.isInteger(keepRecentCompleteUnits) && keepRecentCompleteUnits >= 0);
  validateTranscript(items);

  const units: TranscriptItem[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "assistant_tool_calls" && items[index + 1]?.kind === "tool_results") {
      units.push([structuredClone(item), structuredClone(items[index + 1]!)]);
      index += 1;
    } else {
      units.push([structuredClone(item)]);
    }
  }

  const openIndex = units.findIndex(
    (unit) => unit.length === 1 && unit[0]?.kind === "assistant_tool_calls",
  );
  const compactableEnd = openIndex >= 0 ? openIndex : units.length;
  const compactCount = Math.max(0, compactableEnd - keepRecentCompleteUnits);
  if (compactCount === 0) return items.map((item) => structuredClone(item));

  const compacted = units.slice(0, compactCount).flat();
  const summary: TranscriptItem = {
    kind: "summary",
    id: `summary:${compacted.map((item) => item.id).join(",")}`,
    sourceItemIds: compacted.map((item) => item.id),
  };
  const result = [summary, ...units.slice(compactCount).flat()];
  validateTranscript(result);
  return result;
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
        attempts: { [event.attempt.attemptId]: structuredClone(event.attempt) },
        effects: {},
        retryAllowances: Object.fromEntries(
          event.retryAllowances.map((allowance) => [allowance.allowanceId, structuredClone(allowance)]),
        ),
        notifications: {},
        joins: {},
      };
      continue;
    }
    assert.ok(state, "runtime must start before other events");
    state.now = Math.max(state.now, event.at);
    switch (event.type) {
      case "clock_advanced":
        break;
      case "effect_admitted":
        assert.equal(state.effects[event.effect.effectId], undefined, "effect id already exists");
        assert.equal(state.scopes[event.scope.scopeId], undefined, "scope id already exists");
        state.effects[event.effect.effectId] = structuredClone(event.effect);
        state.scopes[event.scope.scopeId] = structuredClone(event.scope);
        state.attempts[event.attempt.attemptId] = structuredClone(event.attempt);
        break;
      case "effect_started":
        requiredEffect(state, event.effectId).status = "started";
        break;
      case "effect_committed": {
        const effect = requiredEffect(state, event.effectId);
        effect.status = "committed";
        effect.resultRef = event.resultRef;
        finishScopeAndAttempt(state, effect.scopeId, { kind: "succeeded", resultRef: event.resultRef }, "succeeded");
        break;
      }
      case "effect_failed": {
        const effect = requiredEffect(state, event.effectId);
        effect.status = "failed";
        effect.errorCode = event.errorCode;
        finishScopeAndAttempt(state, effect.scopeId, { kind: "failed", errorCode: event.errorCode }, "failed");
        break;
      }
      case "effect_indeterminate": {
        const effect = requiredEffect(state, event.effectId);
        effect.status = "indeterminate";
        const scope = requiredScope(state, effect.scopeId);
        markActiveAttempt(state, scope, "indeterminate");
        scope.state = {
          kind: "suspended",
          handle: `effect:${effect.effectId}`,
          waitKind: "external_input",
        };
        break;
      }
      case "scope_detached": {
        const scope = requiredScope(state, event.scopeId);
        assert.equal(isTerminal(scope.state), false, "terminal scope cannot detach");
        scope.ownership = "detached";
        break;
      }
      case "scope_suspended": {
        const scope = requiredScope(state, event.scopeId);
        assert.equal(scope.state.kind, "running", "only an active scope can suspend");
        markActiveAttempt(state, scope, "yielded");
        scope.state = { kind: "suspended", handle: event.handle, waitKind: event.waitKind };
        break;
      }
      case "scope_resumed": {
        const scope = requiredScope(state, event.scopeId);
        assert.equal(scope.state.kind, "suspended", "only a suspended scope can resume");
        assert.equal(state.attempts[event.attempt.attemptId], undefined, "attempt id already exists");
        state.attempts[event.attempt.attemptId] = structuredClone(event.attempt);
        scope.state = { kind: "running", attemptId: event.attempt.attemptId };
        break;
      }
      case "scope_succeeded":
        finishScopeAndAttempt(state, event.scopeId, { kind: "succeeded", resultRef: event.resultRef }, "succeeded");
        break;
      case "scope_failed":
        settleOpenEffectForScopeTermination(state, event.scopeId, event.errorCode);
        finishScopeAndAttempt(state, event.scopeId, { kind: "failed", errorCode: event.errorCode }, "failed");
        break;
      case "scope_cancelled":
        settleOpenEffectForScopeTermination(state, event.scopeId, event.reason);
        finishScopeAndAttempt(state, event.scopeId, { kind: "cancelled", reason: event.reason }, "cancelled");
        break;
      case "notification_enqueued":
        state.notifications[event.notification.notificationId] ??= structuredClone(event.notification);
        break;
      case "notification_consumed":
        requiredNotification(state, event.notificationId).state = "consumed";
        break;
      case "join_created": {
        assert.equal(state.joins[event.join.joinId], undefined, "join id already exists");
        state.joins[event.join.joinId] = structuredClone(event.join);
        break;
      }
      case "join_satisfied":
        requiredJoin(state, event.joinId).state = "satisfied";
        break;
      case "join_abandoned":
        requiredJoin(state, event.joinId).state = "abandoned";
        break;
      case "retry_consumed": {
        const allowance = requiredAllowance(state, event.allowanceId);
        assert.ok(allowance.remainingAttempts > 0, "retry allowance exhausted");
        allowance.remainingAttempts -= 1;
        break;
      }
    }
  }
  assert.ok(state, "runtime journal is empty");
  return state;
}

export class ReferenceRuntime {
  readonly journal: RuntimeEvent[];
  private stateValue: RuntimeState;

  constructor(input: {
    now?: number;
    rootExpiresAt?: number;
    rootAttemptBudget?: AttemptBudget;
    retryAllowances?: RetryAllowance[];
    journal?: RuntimeEvent[];
  } = {}) {
    if (input.journal) {
      this.journal = structuredClone(input.journal);
      this.stateValue = reduceRuntime(this.journal);
      return;
    }
    const now = input.now ?? 0;
    const budget = structuredClone(input.rootAttemptBudget ?? {});
    const attempt = createAttempt("query:attempt:1", "query", now, budget);
    const root: ScopeRecord = {
      scopeId: "query",
      ownership: "attached",
      ...(input.rootExpiresAt === undefined ? {} : { expiresAt: input.rootExpiresAt }),
      state: { kind: "running", attemptId: attempt.attemptId },
    };
    this.journal = [{
      type: "runtime_started",
      at: now,
      root,
      attempt,
      retryAllowances: structuredClone(input.retryAllowances ?? []),
    }];
    this.stateValue = reduceRuntime(this.journal);
  }

  get state(): RuntimeState {
    return structuredClone(this.stateValue);
  }

  advance(ms: number): void {
    assert.ok(Number.isFinite(ms) && ms >= 0, "clock advance must be non-negative");
    this.append({ type: "clock_advanced", at: this.stateValue.now + ms });
    this.expireDueAttempts();
    this.expireDueScopes();
  }

  admitEffect(proposal: EffectProposal): EffectAdmission {
    const parent = requiredScope(
      this.stateValue,
      proposal.parentScopeId ?? this.stateValue.rootScopeId,
    );
    assert.equal(parent.state.kind, "running", "only an active scope can admit effects");
    const existing = this.stateValue.effects[proposal.effectId];
    if (existing) {
      assert.equal(existing.signature, proposal.signature, "effect id reused with a different proposal");
      return {
        effectId: existing.effectId,
        scopeId: existing.scopeId,
        created: false,
        status: existing.status,
      };
    }

    const parentAttempt = requiredAttempt(this.stateValue, parent.state.attemptId);
    const budget = meetAttemptBudgets(
      parentAttempt.budget,
      proposal.explicitBudget,
      proposal.platformBudget,
      proposal.safetyBudget,
    );
    const attempt = createAttempt(
      proposal.attemptId ?? `${proposal.scopeId}:attempt:1`,
      proposal.scopeId,
      this.stateValue.now,
      budget,
    );
    const scope: ScopeRecord = {
      scopeId: proposal.scopeId,
      parentScopeId: parent.scopeId,
      ownership: "attached",
      ...(proposal.scopeExpiresAt === undefined ? {} : { expiresAt: proposal.scopeExpiresAt }),
      state: { kind: "running", attemptId: attempt.attemptId },
    };
    const effect: EffectRecord = {
      effectId: proposal.effectId,
      signature: proposal.signature,
      scopeId: scope.scopeId,
      status: "admitted",
    };
    this.append({ type: "effect_admitted", at: this.stateValue.now, effect, scope, attempt });
    return { effectId: effect.effectId, scopeId: scope.scopeId, created: true, status: "admitted" };
  }

  startEffect(effectId: string): void {
    const effect = requiredEffect(this.stateValue, effectId);
    assert.equal(effect.status, "admitted", "only a durable admitted effect can start");
    this.append({ type: "effect_started", at: this.stateValue.now, effectId });
  }

  commitEffect(effectId: string, resultRef: string): void {
    const effect = requiredEffect(this.stateValue, effectId);
    assert.equal(effect.status, "started", "effect must start before its receipt commits");
    this.append({ type: "effect_committed", at: this.stateValue.now, effectId, resultRef });
    this.finishDetached(effect.scopeId, resultRef);
  }

  failEffect(effectId: string, errorCode: string): void {
    const effect = requiredEffect(this.stateValue, effectId);
    assert.ok(effect.status === "admitted" || effect.status === "started");
    this.append({ type: "effect_failed", at: this.stateValue.now, effectId, errorCode });
    this.finishDetached(effect.scopeId, `error:${errorCode}`);
  }

  reconcileStartedEffect(effectId: string, externalResultRef?: string): void {
    const effect = requiredEffect(this.stateValue, effectId);
    assert.equal(effect.status, "started", "only a started effect needs crash reconciliation");
    if (externalResultRef !== undefined) {
      this.commitEffect(effectId, externalResultRef);
      return;
    }
    this.append({ type: "effect_indeterminate", at: this.stateValue.now, effectId });
  }

  wait(scopeId: string, waitMs: number): { kind: "ready"; state: ScopeState } | { kind: "not_ready"; handle: string } {
    assert.ok(Number.isFinite(waitMs) && waitMs >= 0, "wait must be non-negative");
    const scope = requiredScope(this.stateValue, scopeId);
    if (isTerminal(scope.state)) return { kind: "ready", state: structuredClone(scope.state) };
    this.advance(waitMs);
    const latest = requiredScope(this.stateValue, scopeId);
    return isTerminal(latest.state)
      ? { kind: "ready", state: structuredClone(latest.state) }
      : { kind: "not_ready", handle: `task:${scopeId}` };
  }

  suspend(
    scopeId: string,
    waitKind: "external_input" | "detached_result" | "scheduled_resume",
    handle: string,
  ): void {
    this.append({ type: "scope_suspended", at: this.stateValue.now, scopeId, waitKind, handle });
  }

  resume(scopeId: string, attemptId: string, grant: AttemptBudget): void {
    const scope = requiredScope(this.stateValue, scopeId);
    if (scope.expiresAt !== undefined) assert.ok(scope.expiresAt > this.stateValue.now, "scope TTL expired");
    const attempt = createAttempt(attemptId, scopeId, this.stateValue.now, grant);
    this.append({ type: "scope_resumed", at: this.stateValue.now, scopeId, attempt });
  }

  detach(scopeId: string): void {
    this.append({ type: "scope_detached", at: this.stateValue.now, scopeId });
  }

  joinDetached(parentScopeId: string, childScopeId: string, joinId: string): void {
    const parent = requiredScope(this.stateValue, parentScopeId);
    const child = requiredScope(this.stateValue, childScopeId);
    assert.equal(parent.state.kind, "running", "joining scope must be active");
    assert.equal(child.ownership, "detached", "join target must be detached");
    this.append({
      type: "join_created",
      at: this.stateValue.now,
      join: { joinId, parentScopeId, childScopeId, state: "waiting" },
    });
    this.suspend(parentScopeId, "detached_result", `join:${joinId}`);
  }

  consumeNotification(notificationId: string): void {
    this.append({ type: "notification_consumed", at: this.stateValue.now, notificationId });
  }

  consumeRetry(ownerScopeId: string, failureDomain: RetryAllowance["failureDomain"]): string {
    const matches = Object.values(this.stateValue.retryAllowances).filter(
      (allowance) => allowance.ownerScopeId === ownerScopeId && allowance.failureDomain === failureDomain,
    );
    assert.equal(matches.length, 1, "one failure domain must have exactly one retry owner allowance");
    const allowance = matches[0]!;
    assert.ok(allowance.remainingAttempts > 0, "retry allowance exhausted");
    this.append({ type: "retry_consumed", at: this.stateValue.now, allowanceId: allowance.allowanceId });
    return allowance.allowanceId;
  }

  completeQuery(resultRef: string): void {
    const root = requiredScope(this.stateValue, this.stateValue.rootScopeId);
    assert.equal(root.state.kind, "running", "query is not active");
    const attached = Object.values(this.stateValue.scopes).filter(
      (scope) => scope.parentScopeId === root.scopeId && scope.ownership === "attached" && !isTerminal(scope.state),
    );
    assert.deepEqual(attached.map((scope) => scope.scopeId), [], "query cannot succeed with active attached children");
    this.append({ type: "scope_succeeded", at: this.stateValue.now, scopeId: root.scopeId, resultRef });
  }

  cancelQuery(reason: string): void {
    this.cancelScopeTree(this.stateValue.rootScopeId, reason);
  }

  observe(): ObserverSnapshot {
    const before = JSON.stringify(this.stateValue);
    const scopes = Object.values(this.stateValue.scopes);
    const snapshot: ObserverSnapshot = {
      now: this.stateValue.now,
      rootState: requiredScope(this.stateValue, this.stateValue.rootScopeId).state.kind,
      activeAttempts: Object.values(this.stateValue.attempts).filter((attempt) => attempt.state === "running").length,
      terminalScopes: scopes.filter((scope) => isTerminal(scope.state)).length,
      detachedScopes: scopes.filter((scope) => scope.ownership === "detached").length,
      pendingNotifications: Object.values(this.stateValue.notifications).filter((item) => item.state === "pending").length,
      indeterminateEffects: Object.values(this.stateValue.effects).filter((effect) => effect.status === "indeterminate").length,
    };
    assert.equal(JSON.stringify(this.stateValue), before, "observer mutated runtime state");
    return snapshot;
  }

  replay(): ReferenceRuntime {
    return new ReferenceRuntime({ journal: this.journal });
  }

  private finishDetached(scopeId: string, resultRef: string): void {
    const scope = requiredScope(this.stateValue, scopeId);
    if (scope.ownership !== "detached") return;
    const notificationId = `notification:${scopeId}`;
    this.append({
      type: "notification_enqueued",
      at: this.stateValue.now,
      notification: {
        notificationId,
        ownerScopeId: scope.parentScopeId ?? this.stateValue.rootScopeId,
        sourceScopeId: scopeId,
        resultRef,
        state: "pending",
      },
    });
    for (const join of Object.values(this.stateValue.joins)) {
      if (join.childScopeId === scopeId && join.state === "waiting") {
        this.append({ type: "join_satisfied", at: this.stateValue.now, joinId: join.joinId });
      }
    }
  }

  private expireDueAttempts(): void {
    const due = Object.values(this.stateValue.attempts)
      .filter((attempt) => attempt.state === "running" && attempt.deadlineAt !== undefined && attempt.deadlineAt <= this.stateValue.now)
      .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
    for (const attempt of due) {
      const effect = Object.values(this.stateValue.effects).find((candidate) => candidate.scopeId === attempt.scopeId);
      if (effect && (effect.status === "admitted" || effect.status === "started")) {
        this.failEffect(effect.effectId, "operation_expired");
      } else {
        this.append({ type: "scope_failed", at: this.stateValue.now, scopeId: attempt.scopeId, errorCode: "operation_expired" });
      }
    }
  }

  private expireDueScopes(): void {
    const due = Object.values(this.stateValue.scopes)
      .filter((scope) => !isTerminal(scope.state) && scope.expiresAt !== undefined && scope.expiresAt <= this.stateValue.now)
      .sort((left, right) => left.scopeId.localeCompare(right.scopeId));
    for (const scope of due) {
      if (isTerminal(requiredScope(this.stateValue, scope.scopeId).state)) continue;
      for (const join of Object.values(this.stateValue.joins)) {
        if (join.parentScopeId === scope.scopeId && join.state === "waiting") {
          this.append({ type: "join_abandoned", at: this.stateValue.now, joinId: join.joinId });
        }
      }
      this.cancelAttachedDescendants(scope.scopeId, "parent_scope_expired");
      this.append({ type: "scope_failed", at: this.stateValue.now, scopeId: scope.scopeId, errorCode: "scope_expired" });
    }
  }

  private cancelScopeTree(scopeId: string, reason: string): void {
    const scope = requiredScope(this.stateValue, scopeId);
    if (isTerminal(scope.state)) return;
    this.cancelAttachedDescendants(scopeId, reason);
    this.append({ type: "scope_cancelled", at: this.stateValue.now, scopeId, reason });
  }

  private cancelAttachedDescendants(parentScopeId: string, reason: string): void {
    const children = Object.values(this.stateValue.scopes).filter(
      (scope) => scope.parentScopeId === parentScopeId && scope.ownership === "attached" && !isTerminal(scope.state),
    );
    for (const child of children) this.cancelScopeTree(child.scopeId, reason);
  }

  private append(event: RuntimeEvent): void {
    this.journal.push(structuredClone(event));
    this.stateValue = reduceRuntime(this.journal);
  }
}

function createAttempt(
  attemptId: string,
  scopeId: string,
  now: number,
  budget: AttemptBudget,
): AttemptRecord {
  return {
    attemptId,
    scopeId,
    startedAt: now,
    ...(budget.activeMs === undefined ? {} : { deadlineAt: now + budget.activeMs }),
    state: "running",
    budget: structuredClone(budget),
  };
}

function requiredScope(state: RuntimeState, scopeId: string): ScopeRecord {
  const scope = state.scopes[scopeId];
  assert.ok(scope, `scope not found: ${scopeId}`);
  return scope;
}

function requiredAttempt(state: RuntimeState, attemptId: string): AttemptRecord {
  const attempt = state.attempts[attemptId];
  assert.ok(attempt, `attempt not found: ${attemptId}`);
  return attempt;
}

function requiredEffect(state: RuntimeState, effectId: string): EffectRecord {
  const effect = state.effects[effectId];
  assert.ok(effect, `effect not found: ${effectId}`);
  return effect;
}

function requiredAllowance(state: RuntimeState, allowanceId: string): RetryAllowance {
  const allowance = state.retryAllowances[allowanceId];
  assert.ok(allowance, `retry allowance not found: ${allowanceId}`);
  return allowance;
}

function requiredNotification(state: RuntimeState, notificationId: string): InboxNotification {
  const notification = state.notifications[notificationId];
  assert.ok(notification, `notification not found: ${notificationId}`);
  return notification;
}

function requiredJoin(state: RuntimeState, joinId: string): JoinRecord {
  const join = state.joins[joinId];
  assert.ok(join, `join not found: ${joinId}`);
  return join;
}

function markActiveAttempt(
  state: RuntimeState,
  scope: ScopeRecord,
  next: AttemptRecord["state"],
): void {
  if (scope.state.kind !== "running") return;
  const attempt = requiredAttempt(state, scope.state.attemptId);
  assert.equal(attempt.state, "running", "active scope attempt is not running");
  attempt.state = next;
}

function finishScopeAndAttempt(
  state: RuntimeState,
  scopeId: string,
  nextScope: ScopeState,
  nextAttempt: AttemptRecord["state"],
): void {
  const scope = requiredScope(state, scopeId);
  assert.equal(isTerminal(scope.state), false, "terminal transition is irreversible");
  markActiveAttempt(state, scope, nextAttempt);
  scope.state = structuredClone(nextScope);
}

function settleOpenEffectForScopeTermination(
  state: RuntimeState,
  scopeId: string,
  reason: string,
): void {
  const effect = Object.values(state.effects).find((candidate) => candidate.scopeId === scopeId);
  if (!effect) return;
  if (effect.status === "admitted") {
    effect.status = "failed";
    effect.errorCode = reason;
  } else if (effect.status === "started") {
    effect.status = "indeterminate";
    effect.errorCode = reason;
  }
}

# Durable Inbox And Join Migration Slice

Status: implementation contract for V2 migration step 4. Baseline:
`986c727f`.

## Objective

Make detached worker results durably returnable after parent termination and
define join expiry without transferring cancellation authority to the parent.
Enqueuing a result must not invoke a model, reopen a mission, or create another
business effect.

## Current Deviation

- background `sessions_spawn` returns only an accepted session record; it has
  no durable result handle or inbox record;
- the worker session store durably retains `lastResult`, but consumers discover
  it by scanning worker sessions and mission activity;
- `MissionThreadBridge` currently calls `handleWorkerCompletion` automatically
  and reopens a terminal mission when a late worker completes;
- activity events act as delivery dedupe markers but are not a consumable inbox;
- there is no durable join record, join expiry, or parent-expiry contract.

## Durable Records

The mission/thread registry owns two model-independent records:

```ts
interface WorkerResultNotification {
  notificationId: string;
  ownerScopeId: string;
  sourceScopeId: string;
  sourceVersion: number;
  resultRef: string;
  state: "pending" | "consumed";
  createdAt: number;
  consumedAt?: number;
  consumedByMessageId?: string;
}

interface WorkerJoinRecord {
  joinId: string;
  ownerScopeId: string;
  sourceScopeId: string;
  state: "waiting" | "satisfied" | "abandoned";
  createdAt: number;
  expiresAt?: number;
  notificationId?: string;
  resolvedAt?: number;
}
```

`resultRef` points to the existing durable worker-session result. The inbox
does not duplicate an unbounded payload.

## Delivery Protocol

1. Worker completion is already durable in `WorkerSessionStore`.
2. Reconciliation idempotently writes one notification keyed by source scope
   and source version.
3. The same reconciliation pass satisfies matching waiting joins.
4. An audit activity may be appended after the notification exists.
5. No model call, follow-up message, or mission reopen occurs on enqueue.
6. A later user turn may project pending notifications into its durable user
   message with stable notification ids.
7. Only after that message is durable may notifications become `consumed`.
8. Restart reconciliation marks a notification consumed when the durable user
   message already carries its id, closing the message/ack crash window.

Repeated completion scans, process restarts, and duplicate source events must
return the same notification and never invoke compute.

## Join And Expiry

- joining a detached worker creates a durable `waiting` record and suspends the
  joining scope; it does not change ownership of the worker;
- worker completion changes matching joins to `satisfied` and attaches the
  notification id, but does not create a new attempt;
- owner expiry changes only the join to `abandoned`;
- an abandoned or expired join never cancels, deletes, or reparents detached
  work;
- the eventual detached result remains pending in the owner inbox even when
  its former parent is terminal or its join is abandoned.

## Implementation Sequence

1. Add the record/store contracts and deterministic state-transition tests.
2. Add an atomic file-backed inbox/join store with idempotent enqueue, consume,
   satisfy, and abandon operations.
3. Wire the store into daemon composition and late-worker reconciliation.
4. Replace automatic late-completion follow-up/reopen with enqueue plus audit.
5. Add next-user-turn projection and durable-message acknowledgement.
6. Add restart tests for every message/ack and completion/join boundary.
7. Add architecture guards that inbox writes cannot import or call model,
   policy, prompt, or dispatch services.

## Required Counterexamples

- detached completion after terminal parent remains listable and consumable;
- scanning the same worker version twice yields one notification;
- crash after notification write but before audit append does not lose or
  duplicate the result;
- crash after user-message durability but before consume acknowledgement is
  reconciled to consumed;
- notification enqueue with observers enabled or disabled produces identical
  authoritative records and zero model calls;
- join expiry abandons only the join and never calls worker cancellation;
- completion after join abandonment still creates a pending notification;
- completion satisfies a waiting join without starting a new attempt.

## Scope Control

Forbidden in this slice:

- prompt-quality rules, task detectors, automatic continuation, or mission
  quality evaluation changes;
- workflow step execution beyond the join state transition;
- model-profile, E2E, timeout, retry, or compaction changes;
- copying full worker result payloads into inbox files.

## Exit Criteria

- late completion is durable and consumable without automatic compute;
- parent terminal/expiry cannot orphan or cancel detached work;
- join transitions satisfy the counterexample matrix;
- daemon composition uses the durable path and the legacy automatic callback is
  absent from production wiring;
- deterministic package suites, simulator, policy inventory, typecheck, and
  `git diff --check` are green;
- exact results are recorded before the workflow slice begins.

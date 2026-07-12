import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ExplicitWorkflowDefinition,
  ExplicitWorkflowRecord,
} from "@turnkeyai/core-types/team";
import { FileWorkerResultInboxStore } from "@turnkeyai/team-store/worker/file-worker-result-inbox-store";
import { FileExplicitWorkflowStore } from "@turnkeyai/team-store/workflow/file-explicit-workflow-store";

import { ExplicitWorkflowRuntime } from "./explicit-workflow-runtime";

function approvalWorkflow(workflowId = "workflow:approval:1"): ExplicitWorkflowDefinition {
  return {
    workflowId,
    ownerScopeId: "mission:1",
    retryAllowances: [{ allowanceId: "approval-step-retry", maxRetries: 1 }],
    steps: [
      {
        stepId: "apply-permission",
        trigger: { kind: "effect_receipt", key: "approval:ap.1" },
        allowedEffects: ["permission_applied"],
        join: "none",
        attemptBudget: { activeMs: 1_000, maxToolCalls: 1 },
        retryAllowanceIds: ["approval-step-retry"],
        nextStepIds: ["run-approved-action"],
      },
      {
        stepId: "run-approved-action",
        trigger: { kind: "effect_receipt", key: "apply-permission" },
        allowedEffects: ["sessions_spawn"],
        join: "detached",
        attemptBudget: { activeMs: 2_000, maxToolCalls: 1 },
        retryAllowanceIds: [],
        nextStepIds: ["accept-detached-result"],
      },
      {
        stepId: "accept-detached-result",
        trigger: { kind: "inbox_notification", key: "run-approved-action" },
        allowedEffects: [],
        join: "none",
        attemptBudget: {},
        retryAllowanceIds: [],
        nextStepIds: [],
      },
    ],
  };
}

function step(record: ExplicitWorkflowRecord, stepId: string) {
  const found = record.steps.find((candidate) => candidate.stepId === stepId);
  assert.ok(found, `expected workflow step ${stepId}`);
  return found;
}

test("explicit approval workflow survives suspend, wake, retry, join, inbox resume, and restart", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-explicit-workflow-"));
  try {
    let now = 100;
    const clock = { now: () => now };
    const workflowRoot = path.join(rootDir, "workflows");
    const inboxRoot = path.join(rootDir, "inbox");
    let workflowStore = new FileExplicitWorkflowStore({ rootDir: workflowRoot });
    let inboxStore = new FileWorkerResultInboxStore({ rootDir: inboxRoot });
    let runtime = new ExplicitWorkflowRuntime({
      workflowStore,
      workerResultInboxStore: inboxStore,
      clock,
    });

    const created = await runtime.create(approvalWorkflow());
    assert.equal(created.status, "suspended");
    assert.equal(step(created, "apply-permission").state, "waiting");

    const wrongTrigger = await runtime.signal(created.workflowId, {
      eventId: "approval:wrong",
      kind: "user_input",
      key: "approval:ap.1",
      occurredAt: now,
    });
    assert.equal(wrongTrigger.version, created.version);
    assert.equal(wrongTrigger.processedTriggerIds.length, 0);

    const woken = await runtime.signal(created.workflowId, {
      eventId: "approval:decision:ap.1",
      kind: "effect_receipt",
      key: "approval:ap.1",
      occurredAt: 50,
      payloadRef: "approval-decision:ap.1",
    });
    assert.equal(woken.status, "running");
    assert.equal(step(woken, "apply-permission").state, "ready");
    assert.equal(step(woken, "apply-permission").attempts.length, 1);
    assert.equal(step(woken, "apply-permission").attempts[0]?.grant.grantedAt, 100);
    assert.equal(step(woken, "apply-permission").attempts[0]?.grant.deadlineAt, 1_100);

    workflowStore = new FileExplicitWorkflowStore({ rootDir: workflowRoot });
    inboxStore = new FileWorkerResultInboxStore({ rootDir: inboxRoot });
    runtime = new ExplicitWorkflowRuntime({
      workflowStore,
      workerResultInboxStore: inboxStore,
      clock,
    });
    const duplicateWake = await runtime.signal(created.workflowId, {
      eventId: "approval:decision:ap.1",
      kind: "effect_receipt",
      key: "approval:ap.1",
      occurredAt: now,
    });
    assert.equal(duplicateWake.version, woken.version);

    await assert.rejects(
      () => runtime.admitEffect({
        workflowId: created.workflowId,
        stepId: "apply-permission",
        effectId: "effect:forbidden",
        effectName: "sessions_spawn",
        effectInput: {},
      }),
      /effect is not allowed/,
    );
    const firstProposal = await runtime.admitEffect({
      workflowId: created.workflowId,
      stepId: "apply-permission",
      effectId: "effect:permission-applied:1",
      effectName: "permission_applied",
      effectInput: { approval_id: "ap.1" },
    });
    assert.equal(firstProposal.kind, "proposal");
    if (firstProposal.kind !== "proposal") throw new Error("expected a proposal");
    assert.equal(firstProposal.workflow.status, "running");
    assert.equal(step(firstProposal.workflow, "apply-permission").state, "effect_admitted");

    runtime = new ExplicitWorkflowRuntime({
      workflowStore: new FileExplicitWorkflowStore({ rootDir: workflowRoot }),
      workerResultInboxStore: new FileWorkerResultInboxStore({ rootDir: inboxRoot }),
      clock,
    });
    const replayedProposal = await runtime.admitEffect({
      workflowId: created.workflowId,
      stepId: "apply-permission",
      effectId: "effect:permission-applied:1",
      effectName: "permission_applied",
      effectInput: { approval_id: "ap.1" },
    });
    assert.equal(replayedProposal.kind, "proposal");
    if (replayedProposal.kind !== "proposal") throw new Error("expected a replayed proposal");
    assert.deepEqual(replayedProposal.proposal, firstProposal.proposal);
    assert.equal(replayedProposal.workflow.version, firstProposal.workflow.version);

    now = 150;
    const retryReady = await runtime.recordEffectReceipt({
      workflowId: created.workflowId,
      stepId: "apply-permission",
      effectId: "effect:permission-applied:1",
      status: "failed",
      errorCode: "permission_cache_temporarily_unavailable",
      retryAllowanceId: "approval-step-retry",
    });
    assert.equal(step(retryReady, "apply-permission").state, "ready");
    assert.equal(step(retryReady, "apply-permission").attempts.length, 2);
    assert.equal(retryReady.retryAllowances[0]?.remainingRetries, 0);
    assert.equal(retryReady.retryAllowances[0]?.ownerScopeId, "mission:1");
    assert.equal(retryReady.retryAllowances[0]?.failureDomain, "workflow_step");

    await runtime.admitEffect({
      workflowId: created.workflowId,
      stepId: "apply-permission",
      effectId: "effect:permission-applied:2",
      effectName: "permission_applied",
      effectInput: { approval_id: "ap.1" },
    });
    now = 175;
    const permissionApplied = await runtime.recordEffectReceipt({
      workflowId: created.workflowId,
      stepId: "apply-permission",
      effectId: "effect:permission-applied:2",
      status: "committed",
      resultRef: "permission-cache:ap.1",
    });
    assert.equal(step(permissionApplied, "apply-permission").state, "completed");
    assert.equal(step(permissionApplied, "run-approved-action").state, "ready");
    now = 176;
    const duplicateReceipt = await runtime.recordEffectReceipt({
      workflowId: created.workflowId,
      stepId: "apply-permission",
      effectId: "effect:permission-applied:2",
      status: "committed",
      resultRef: "permission-cache:ap.1",
    });
    assert.equal(duplicateReceipt.version, permissionApplied.version);
    const priorReceipt = await runtime.admitEffect({
      workflowId: created.workflowId,
      stepId: "apply-permission",
      effectId: "effect:permission-applied:2",
      effectName: "permission_applied",
      effectInput: { approval_id: "ap.1" },
    });
    assert.equal(priorReceipt.kind, "prior_receipt");
    if (priorReceipt.kind !== "prior_receipt") throw new Error("expected a prior receipt");
    assert.equal(priorReceipt.receipt.resultRef, "permission-cache:ap.1");

    await runtime.admitEffect({
      workflowId: created.workflowId,
      stepId: "run-approved-action",
      effectId: "effect:approved-action:1",
      effectName: "sessions_spawn",
      effectInput: { agent_id: "browser", task: "perform declared approved action" },
    });
    now = 200;
    const waitingJoin = await runtime.recordEffectReceipt({
      workflowId: created.workflowId,
      stepId: "run-approved-action",
      effectId: "effect:approved-action:1",
      status: "committed",
      resultRef: "worker-session:worker:browser:approved-action",
      sourceScopeId: "worker:browser:approved-action",
      joinExpiresAt: 500,
    });
    const actionStep = step(waitingJoin, "run-approved-action");
    assert.equal(actionStep.state, "waiting_join");
    assert.ok(actionStep.joinId);
    assert.equal(waitingJoin.status, "suspended");
    assert.equal((await runtime.reconcileJoin(created.workflowId, actionStep.stepId)).version, waitingJoin.version);

    const notification = {
      notificationId: "notification:approved-action",
      ownerScopeId: "mission:1",
      sourceScopeId: "worker:browser:approved-action",
      sourceVersion: 1,
      resultRef: "worker-session:worker:browser:approved-action",
      state: "pending" as const,
      createdAt: 250,
    };
    const activeInbox = new FileWorkerResultInboxStore({ rootDir: inboxRoot });
    await activeInbox.putNotification(notification);
    await activeInbox.satisfyWaitingJoins({
      sourceScopeId: notification.sourceScopeId,
      notificationId: notification.notificationId,
      resolvedAt: notification.createdAt,
    });
    const joined = await runtime.reconcileJoin(created.workflowId, actionStep.stepId);
    assert.equal(step(joined, actionStep.stepId).state, "completed");
    assert.equal(step(joined, "accept-detached-result").state, "waiting");
    assert.equal(joined.status, "suspended");

    const completed = await runtime.signal(created.workflowId, {
      eventId: notification.notificationId,
      kind: "inbox_notification",
      key: "run-approved-action",
      occurredAt: notification.createdAt,
      payloadRef: notification.resultRef,
    });
    assert.equal(completed.status, "completed");
    assert.equal(step(completed, "accept-detached-result").state, "completed");
    assert.equal(
      (await activeInbox.getNotification(notification.notificationId))?.state,
      "pending",
      "workflow wake must not implicitly consume the owner inbox result",
    );

    const restarted = new ExplicitWorkflowRuntime({
      workflowStore: new FileExplicitWorkflowStore({ rootDir: workflowRoot }),
      workerResultInboxStore: activeInbox,
      clock,
    });
    assert.deepEqual(await restarted.get(created.workflowId), completed);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("expired and indeterminate workflow attempts cannot dispatch or retry", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-explicit-workflow-"));
  try {
    let now = 1_000;
    const workflowStore = new FileExplicitWorkflowStore({ rootDir: path.join(rootDir, "workflows") });
    const inboxStore = new FileWorkerResultInboxStore({ rootDir: path.join(rootDir, "inbox") });
    const runtime = new ExplicitWorkflowRuntime({
      workflowStore,
      workerResultInboxStore: inboxStore,
      clock: { now: () => now },
    });
    const definition = approvalWorkflow("workflow:expiry");
    definition.steps = [
      {
        stepId: "one",
        trigger: { kind: "user_input", key: "start" },
        allowedEffects: ["tool"],
        join: "none",
        attemptBudget: { activeMs: 10, maxToolCalls: 1 },
        retryAllowanceIds: ["approval-step-retry"],
        nextStepIds: [],
      },
    ];
    await runtime.create(definition);
    await runtime.signal(definition.workflowId, {
      eventId: "start:1",
      kind: "user_input",
      key: "start",
      occurredAt: now,
    });
    now = 1_011;
    await assert.rejects(
      () => runtime.admitEffect({
        workflowId: definition.workflowId,
        stepId: "one",
        effectId: "effect:late",
        effectName: "tool",
        effectInput: {},
      }),
      /attempt expired/,
    );
    assert.equal((await runtime.get(definition.workflowId))?.status, "failed");

    const indeterminate = approvalWorkflow("workflow:indeterminate");
    indeterminate.steps = [{
      stepId: "one",
      trigger: { kind: "user_input", key: "start" },
      allowedEffects: ["tool"],
      join: "none",
      attemptBudget: { activeMs: 100, maxToolCalls: 1 },
      retryAllowanceIds: ["approval-step-retry"],
      nextStepIds: [],
    }];
    now = 2_000;
    await runtime.create(indeterminate);
    await runtime.signal(indeterminate.workflowId, {
      eventId: "start:2",
      kind: "user_input",
      key: "start",
      occurredAt: now,
    });
    await runtime.admitEffect({
      workflowId: indeterminate.workflowId,
      stepId: "one",
      effectId: "effect:ambiguous",
      effectName: "tool",
      effectInput: {},
    });
    const failed = await runtime.recordEffectReceipt({
      workflowId: indeterminate.workflowId,
      stepId: "one",
      effectId: "effect:ambiguous",
      status: "indeterminate",
      retryAllowanceId: "approval-step-retry",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.retryAllowances[0]?.remainingRetries, 1);
    assert.equal(step(failed, "one").attempts.length, 1);
    await assert.rejects(
      () => runtime.admitEffect({
        workflowId: indeterminate.workflowId,
        stepId: "one",
        effectId: "effect:after-terminal",
        effectName: "tool",
        effectInput: {},
      }),
      /workflow is terminal/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file workflow store rejects stale compare-and-swap writes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-explicit-workflow-"));
  try {
    const store = new FileExplicitWorkflowStore({ rootDir });
    const runtime = new ExplicitWorkflowRuntime({
      workflowStore: store,
      workerResultInboxStore: new FileWorkerResultInboxStore({
        rootDir: path.join(rootDir, "inbox"),
      }),
      clock: { now: () => 100 },
    });
    const created = await runtime.create(approvalWorkflow("workflow:cas"));
    const stale = structuredClone(created);
    const updated = await runtime.signal(created.workflowId, {
      eventId: "approval:cas",
      kind: "effect_receipt",
      key: "approval:ap.1",
      occurredAt: 100,
    });
    assert.ok(updated.version > stale.version);
    assert.equal(await store.put(stale, { expectedVersion: stale.version }), null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("attached receipts complete directly and failed steps cannot borrow retry ownership", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "turnkeyai-explicit-workflow-"));
  try {
    const runtime = new ExplicitWorkflowRuntime({
      workflowStore: new FileExplicitWorkflowStore({ rootDir: path.join(rootDir, "workflows") }),
      workerResultInboxStore: new FileWorkerResultInboxStore({ rootDir: path.join(rootDir, "inbox") }),
      clock: { now: () => 100 },
    });
    const definition: ExplicitWorkflowDefinition = {
      workflowId: "workflow:attached",
      ownerScopeId: "mission:attached",
      retryAllowances: [],
      steps: [{
        stepId: "attached-effect",
        trigger: { kind: "user_input", key: "start" },
        allowedEffects: ["attached_tool"],
        join: "attached",
        attemptBudget: { activeMs: 100, maxToolCalls: 1 },
        retryAllowanceIds: [],
        nextStepIds: [],
      }],
    };
    await runtime.create(definition);
    await runtime.signal(definition.workflowId, {
      eventId: "start:attached",
      kind: "user_input",
      key: "start",
      occurredAt: 50,
    });
    await runtime.admitEffect({
      workflowId: definition.workflowId,
      stepId: "attached-effect",
      effectId: "effect:attached",
      effectName: "attached_tool",
      effectInput: {},
    });
    await assert.rejects(
      () => runtime.recordEffectReceipt({
        workflowId: definition.workflowId,
        stepId: "attached-effect",
        effectId: "effect:attached",
        status: "failed",
        retryAllowanceId: "borrowed-allowance",
      }),
      /retry allowance is not owned/,
    );
    const failed = await runtime.recordEffectReceipt({
      workflowId: definition.workflowId,
      stepId: "attached-effect",
      effectId: "effect:attached",
      status: "failed",
      errorCode: "attached_failure",
    });
    assert.equal(failed.status, "failed");

    const committedDefinition = structuredClone(definition);
    committedDefinition.workflowId = "workflow:attached-committed";
    await runtime.create(committedDefinition);
    await runtime.signal(committedDefinition.workflowId, {
      eventId: "start:attached-committed",
      kind: "user_input",
      key: "start",
      occurredAt: 50,
    });
    await runtime.admitEffect({
      workflowId: committedDefinition.workflowId,
      stepId: "attached-effect",
      effectId: "effect:attached-committed",
      effectName: "attached_tool",
      effectInput: {},
    });
    const committed = await runtime.recordEffectReceipt({
      workflowId: committedDefinition.workflowId,
      stepId: "attached-effect",
      effectId: "effect:attached-committed",
      status: "committed",
      resultRef: "attached-result:1",
    });
    assert.equal(committed.status, "completed");
    assert.equal(step(committed, "attached-effect").joinId, undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

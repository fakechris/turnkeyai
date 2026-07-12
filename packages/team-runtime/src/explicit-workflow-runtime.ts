import { createHash } from "node:crypto";

import type {
  Clock,
  ExplicitWorkflowAttemptGrant,
  ExplicitWorkflowDefinition,
  ExplicitWorkflowEffectProposal,
  ExplicitWorkflowEffectReceipt,
  ExplicitWorkflowRecord,
  ExplicitWorkflowStepDefinition,
  ExplicitWorkflowStepRecord,
  ExplicitWorkflowStore,
  ExplicitWorkflowTriggerEvent,
  WorkerResultInboxStore,
} from "@turnkeyai/core-types/team";

interface ExplicitWorkflowRuntimeOptions {
  workflowStore: ExplicitWorkflowStore;
  workerResultInboxStore: Pick<WorkerResultInboxStore, "getJoin" | "putJoin">;
  clock: Clock;
}

export class ExplicitWorkflowRuntime {
  constructor(private readonly options: ExplicitWorkflowRuntimeOptions) {}

  async create(definition: ExplicitWorkflowDefinition): Promise<ExplicitWorkflowRecord> {
    validateDefinition(definition);
    const now = this.options.clock.now();
    const record: ExplicitWorkflowRecord = {
      workflowId: definition.workflowId,
      ownerScopeId: definition.ownerScopeId,
      version: 0,
      status: "suspended",
      definition: structuredClone(definition),
      steps: definition.steps.map((step) => ({
        stepId: step.stepId,
        state: "waiting",
        attempts: [],
      })),
      retryAllowances: definition.retryAllowances.map((allowance) => ({
        allowanceId: allowance.allowanceId,
        ownerScopeId: definition.ownerScopeId,
        failureDomain: "workflow_step",
        initialRetries: allowance.maxRetries,
        remainingRetries: allowance.maxRetries,
      })),
      processedTriggerIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const stored = await this.options.workflowStore.put(record, { expectedVersion: 0 });
    if (!stored) {
      const existing = await this.options.workflowStore.get(definition.workflowId);
      if (existing && sameDefinition(existing.definition, definition)) return existing;
      throw new Error(`explicit workflow already exists: ${definition.workflowId}`);
    }
    return stored;
  }

  async get(workflowId: string): Promise<ExplicitWorkflowRecord | null> {
    return this.options.workflowStore.get(workflowId);
  }

  async signal(
    workflowId: string,
    event: ExplicitWorkflowTriggerEvent,
  ): Promise<ExplicitWorkflowRecord> {
    validateTriggerEvent(event);
    const resumedAt = this.options.clock.now();
    const { record } = await this.transition(workflowId, (draft) => {
      if (isTerminalWorkflow(draft)) {
        return { changed: false, result: undefined };
      }
      if (draft.processedTriggerIds.includes(event.eventId)) {
        return { changed: false, result: undefined };
      }
      const activated = activateMatchingSteps(draft, event, undefined, resumedAt);
      if (!activated) return { changed: false, result: undefined };
      draft.processedTriggerIds.push(event.eventId);
      draft.updatedAt = resumedAt;
      refreshWorkflowStatus(draft);
      return { changed: true, result: undefined };
    });
    return record;
  }

  async admitEffect(input: {
    workflowId: string;
    stepId: string;
    effectId: string;
    effectName: string;
    effectInput: Record<string, unknown>;
  }): Promise<
    | {
        kind: "proposal";
        workflow: ExplicitWorkflowRecord;
        proposal: ExplicitWorkflowEffectProposal;
      }
    | {
        kind: "prior_receipt";
        workflow: ExplicitWorkflowRecord;
        receipt: ExplicitWorkflowEffectReceipt;
      }
  > {
    if (!input.effectId || !input.effectName) {
      throw new Error("workflow effect id and name are required");
    }
    const now = this.options.clock.now();
    const transition = await this.transition<
      ExplicitWorkflowEffectProposal | ExplicitWorkflowEffectReceipt | Error
    >(
      input.workflowId,
      (draft) => {
        const prior = findEffectAttempt(draft, input.effectId);
        if (prior?.proposal) {
          assertSameProposal(prior.proposal, input);
          if (!prior.receipt && isTerminalWorkflow(draft)) {
            throw new Error(`workflow is terminal: ${draft.workflowId}:${draft.status}`);
          }
          return {
            changed: false,
            result: prior.receipt ?? prior.proposal,
          };
        }
        if (isTerminalWorkflow(draft)) {
          throw new Error(`workflow is terminal: ${draft.workflowId}:${draft.status}`);
        }
        const step = requiredStepRecord(draft, input.stepId);
        const definition = requiredStepDefinition(draft, input.stepId);
        if (step.state !== "ready") {
          throw new Error(`workflow step is not ready: ${input.stepId}:${step.state}`);
        }
        if (!definition.allowedEffects.includes(input.effectName)) {
          throw new Error(
            `workflow effect is not allowed: ${input.stepId}:${input.effectName}`,
          );
        }
        const attempt = requiredCurrentAttempt(step);
        if (attempt.grant.deadlineAt !== undefined && now > attempt.grant.deadlineAt) {
          step.state = "failed";
          step.errorCode = "attempt_expired";
          draft.updatedAt = now;
          refreshWorkflowStatus(draft);
          return {
            changed: true,
            result: new Error(`workflow attempt expired: ${attempt.grant.attemptId}`),
          };
        }
        if ((attempt.grant.budget.maxToolCalls ?? 1) < 1) {
          throw new Error(`workflow attempt has no tool-call budget: ${attempt.grant.attemptId}`);
        }
        const proposal: ExplicitWorkflowEffectProposal = {
          effectId: input.effectId,
          workflowId: draft.workflowId,
          stepId: input.stepId,
          attemptId: attempt.grant.attemptId,
          effectName: input.effectName,
          input: structuredClone(input.effectInput),
          join: definition.join,
          proposedAt: now,
        };
        attempt.proposal = proposal;
        step.state = "effect_admitted";
        draft.updatedAt = now;
        refreshWorkflowStatus(draft);
        return { changed: true, result: proposal };
      },
    );
    if (transition.result instanceof Error) throw transition.result;
    return "status" in transition.result
      ? {
          kind: "prior_receipt",
          workflow: transition.record,
          receipt: transition.result,
        }
      : {
          kind: "proposal",
          workflow: transition.record,
          proposal: transition.result,
        };
  }

  async recordEffectReceipt(input: {
    workflowId: string;
    stepId: string;
    effectId: string;
    status: ExplicitWorkflowEffectReceipt["status"];
    resultRef?: string;
    errorCode?: string;
    sourceScopeId?: string;
    joinExpiresAt?: number;
    retryAllowanceId?: string;
  }): Promise<ExplicitWorkflowRecord> {
    const now = this.options.clock.now();
    const { record } = await this.transition(input.workflowId, async (draft) => {
      const step = requiredStepRecord(draft, input.stepId);
      const definition = requiredStepDefinition(draft, input.stepId);
      const attempt = findAttemptByEffectId(step, input.effectId);
      if (!attempt?.proposal) {
        throw new Error(`workflow effect proposal not found: ${input.effectId}`);
      }
      const receipt: ExplicitWorkflowEffectReceipt = {
        effectId: input.effectId,
        status: input.status,
        recordedAt: now,
        ...(input.resultRef ? { resultRef: input.resultRef } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.sourceScopeId ? { sourceScopeId: input.sourceScopeId } : {}),
      };
      if (attempt.receipt) {
        assertSameReceipt(attempt.receipt, receipt);
        return { changed: false, result: undefined };
      }
      if (step.state !== "effect_admitted") {
        throw new Error(`workflow step cannot accept a receipt: ${input.stepId}:${step.state}`);
      }

      if (input.status === "failed" && input.retryAllowanceId) {
        if (!definition.retryAllowanceIds.includes(input.retryAllowanceId)) {
          throw new Error(
            `workflow retry allowance is not owned by step: ${input.stepId}:${input.retryAllowanceId}`,
          );
        }
      }
      attempt.receipt = receipt;

      if (input.status === "committed") {
        if (definition.join !== "detached") {
          step.state = "completed";
          const receiptEvent: ExplicitWorkflowTriggerEvent = {
            eventId: `workflow-receipt:${input.effectId}`,
            kind: "effect_receipt",
            key: input.stepId,
            occurredAt: now,
            ...(input.resultRef ? { payloadRef: input.resultRef } : {}),
          };
          const nextIds = new Set(definition.nextStepIds);
          if (activateMatchingSteps(draft, receiptEvent, nextIds)) {
            draft.processedTriggerIds.push(receiptEvent.eventId);
          }
        } else {
          if (!input.sourceScopeId) {
            throw new Error(
              `workflow joined effect requires a source scope: ${input.effectId}`,
            );
          }
          const joinId = stableJoinId(draft.workflowId, input.stepId, input.effectId);
          await this.options.workerResultInboxStore.putJoin({
            joinId,
            ownerScopeId: draft.ownerScopeId,
            sourceScopeId: input.sourceScopeId,
            state: "waiting",
            createdAt: now,
            ...(input.joinExpiresAt !== undefined
              ? { expiresAt: input.joinExpiresAt }
              : {}),
          });
          step.state = "waiting_join";
          step.joinId = joinId;
        }
      } else if (
        input.status === "failed" &&
        input.retryAllowanceId &&
        consumeRetryAllowance(draft, input.retryAllowanceId)
      ) {
        step.state = "ready";
        delete step.errorCode;
        step.attempts.push({
          grant: createAttemptGrant(draft, definition, step, now),
        });
      } else {
        step.state = "failed";
        step.errorCode =
          input.status === "indeterminate"
            ? "effect_indeterminate"
            : input.errorCode ?? "effect_failed";
      }
      draft.updatedAt = now;
      refreshWorkflowStatus(draft);
      return { changed: true, result: undefined };
    });
    return record;
  }

  async reconcileJoin(workflowId: string, stepId: string): Promise<ExplicitWorkflowRecord> {
    const current = await this.required(workflowId);
    const currentStep = requiredStepRecord(current, stepId);
    if (currentStep.state !== "waiting_join" || !currentStep.joinId) return current;
    const join = await this.options.workerResultInboxStore.getJoin(currentStep.joinId);
    if (!join || join.state === "waiting") return current;
    const now = this.options.clock.now();
    const { record } = await this.transition(workflowId, (draft) => {
      const step = requiredStepRecord(draft, stepId);
      if (step.state !== "waiting_join" || step.joinId !== join.joinId) {
        return { changed: false, result: undefined };
      }
      if (join.state === "satisfied") {
        step.state = "completed";
        if (join.notificationId) step.joinNotificationId = join.notificationId;
      } else {
        step.state = "failed";
        step.errorCode = "join_abandoned";
      }
      draft.updatedAt = now;
      refreshWorkflowStatus(draft);
      return { changed: true, result: undefined };
    });
    return record;
  }

  private async required(workflowId: string): Promise<ExplicitWorkflowRecord> {
    const record = await this.options.workflowStore.get(workflowId);
    if (!record) throw new Error(`explicit workflow not found: ${workflowId}`);
    return record;
  }

  private async transition<T>(
    workflowId: string,
    mutate: (
      draft: ExplicitWorkflowRecord,
    ) => Promise<TransitionResult<T>> | TransitionResult<T>,
  ): Promise<{ record: ExplicitWorkflowRecord; result: T }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.required(workflowId);
      const draft = structuredClone(current);
      const transition = await mutate(draft);
      if (!transition.changed) return { record: current, result: transition.result };
      const stored = await this.options.workflowStore.put(draft, {
        expectedVersion: current.version,
      });
      if (stored) return { record: stored, result: transition.result };
    }
    throw new Error(`explicit workflow transition conflict: ${workflowId}`);
  }
}

interface TransitionResult<T> {
  changed: boolean;
  result: T;
}

function activateMatchingSteps(
  record: ExplicitWorkflowRecord,
  event: ExplicitWorkflowTriggerEvent,
  candidateStepIds?: ReadonlySet<string>,
  grantedAt = event.occurredAt,
): boolean {
  let activated = false;
  let changedInPass = true;
  while (changedInPass) {
    changedInPass = false;
    for (const definition of record.definition.steps) {
      if (candidateStepIds && !candidateStepIds.has(definition.stepId)) continue;
      const step = requiredStepRecord(record, definition.stepId);
      if (step.state !== "waiting") continue;
      if (definition.trigger.kind !== event.kind || definition.trigger.key !== event.key) {
        continue;
      }
      if (!predecessorsCompleted(record, definition.stepId)) continue;
      step.triggerEventId = event.eventId;
      if (definition.allowedEffects.length === 0) {
        step.state = "completed";
      } else {
        step.state = "ready";
        step.attempts.push({
          grant: createAttemptGrant(record, definition, step, grantedAt),
        });
      }
      activated = true;
      changedInPass = true;
    }
  }
  return activated;
}

function createAttemptGrant(
  record: ExplicitWorkflowRecord,
  definition: ExplicitWorkflowStepDefinition,
  step: ExplicitWorkflowStepRecord,
  grantedAt: number,
): ExplicitWorkflowAttemptGrant {
  const attemptNumber = step.attempts.length + 1;
  const activeMs = definition.attemptBudget.activeMs;
  return {
    attemptId: `${record.workflowId}:${step.stepId}:attempt:${attemptNumber}`,
    attemptNumber,
    grantedAt,
    budget: structuredClone(definition.attemptBudget),
    ...(activeMs !== undefined ? { deadlineAt: grantedAt + activeMs } : {}),
  };
}

function predecessorsCompleted(record: ExplicitWorkflowRecord, stepId: string): boolean {
  const predecessorIds = record.definition.steps
    .filter((step) => step.nextStepIds.includes(stepId))
    .map((step) => step.stepId);
  return predecessorIds.every(
    (predecessorId) => requiredStepRecord(record, predecessorId).state === "completed",
  );
}

function refreshWorkflowStatus(record: ExplicitWorkflowRecord): void {
  if (record.status === "cancelled") return;
  if (record.steps.some((step) => step.state === "failed")) {
    record.status = "failed";
  } else if (record.steps.every((step) => step.state === "completed")) {
    record.status = "completed";
  } else if (
    record.steps.some(
      (step) => step.state === "ready" || step.state === "effect_admitted",
    )
  ) {
    record.status = "running";
  } else {
    record.status = "suspended";
  }
}

function isTerminalWorkflow(record: ExplicitWorkflowRecord): boolean {
  return (
    record.status === "completed" ||
    record.status === "failed" ||
    record.status === "cancelled"
  );
}

function consumeRetryAllowance(record: ExplicitWorkflowRecord, allowanceId: string): boolean {
  const allowance = record.retryAllowances.find(
    (candidate) => candidate.allowanceId === allowanceId,
  );
  if (!allowance || allowance.remainingRetries <= 0) return false;
  allowance.remainingRetries -= 1;
  return true;
}

function requiredStepRecord(
  record: ExplicitWorkflowRecord,
  stepId: string,
): ExplicitWorkflowStepRecord {
  const step = record.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) throw new Error(`workflow step not found: ${stepId}`);
  return step;
}

function requiredStepDefinition(
  record: ExplicitWorkflowRecord,
  stepId: string,
): ExplicitWorkflowStepDefinition {
  const step = record.definition.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) throw new Error(`workflow step definition not found: ${stepId}`);
  return step;
}

function requiredCurrentAttempt(step: ExplicitWorkflowStepRecord) {
  const attempt = step.attempts.at(-1);
  if (!attempt) throw new Error(`workflow step has no attempt grant: ${step.stepId}`);
  return attempt;
}

function findAttemptByEffectId(step: ExplicitWorkflowStepRecord, effectId: string) {
  return step.attempts.find((attempt) => attempt.proposal?.effectId === effectId);
}

function findEffectAttempt(
  record: ExplicitWorkflowRecord,
  effectId: string,
): ExplicitWorkflowStepRecord["attempts"][number] | null {
  for (const step of record.steps) {
    const attempt = step.attempts.find(
      (attempt) => attempt.proposal?.effectId === effectId,
    );
    if (attempt) return attempt;
  }
  return null;
}

function assertSameProposal(
  proposal: ExplicitWorkflowEffectProposal,
  input: {
    workflowId: string;
    stepId: string;
    effectName: string;
    effectInput: Record<string, unknown>;
  },
): void {
  if (
    proposal.workflowId !== input.workflowId ||
    proposal.stepId !== input.stepId ||
    proposal.effectName !== input.effectName ||
    stableJson(proposal.input) !== stableJson(input.effectInput)
  ) {
    throw new Error(`workflow effect id reused with a different proposal: ${proposal.effectId}`);
  }
}

function assertSameReceipt(
  existing: ExplicitWorkflowEffectReceipt,
  candidate: ExplicitWorkflowEffectReceipt,
): void {
  const stableExisting = {
    ...existing,
    recordedAt: 0,
  };
  const stableCandidate = {
    ...candidate,
    recordedAt: 0,
  };
  if (stableJson(stableExisting) !== stableJson(stableCandidate)) {
    throw new Error(`workflow effect receipt changed: ${candidate.effectId}`);
  }
}

function stableJoinId(workflowId: string, stepId: string, effectId: string): string {
  const digest = createHash("sha256")
    .update(`${workflowId}\n${stepId}\n${effectId}`)
    .digest("hex")
    .slice(0, 24);
  return `workflow-join:${digest}`;
}

function validateDefinition(definition: ExplicitWorkflowDefinition): void {
  if (!definition.workflowId || !definition.ownerScopeId || definition.steps.length === 0) {
    throw new Error("explicit workflow identity and steps are required");
  }
  const stepIds = new Set<string>();
  for (const step of definition.steps) {
    if (!step.stepId || stepIds.has(step.stepId)) {
      throw new Error(`explicit workflow step id is invalid or duplicated: ${step.stepId}`);
    }
    stepIds.add(step.stepId);
    if (!step.trigger.key) throw new Error(`workflow trigger key is required: ${step.stepId}`);
    if (new Set(step.allowedEffects).size !== step.allowedEffects.length) {
      throw new Error(`workflow allowed effects are duplicated: ${step.stepId}`);
    }
    if (
      new Set(step.retryAllowanceIds).size !== step.retryAllowanceIds.length ||
      new Set(step.nextStepIds).size !== step.nextStepIds.length
    ) {
      throw new Error(`workflow step references are duplicated: ${step.stepId}`);
    }
    if (step.allowedEffects.some((effect) => !effect)) {
      throw new Error(`workflow allowed effect is empty: ${step.stepId}`);
    }
    validateAttemptBudget(step);
  }
  for (const step of definition.steps) {
    for (const nextStepId of step.nextStepIds) {
      if (!stepIds.has(nextStepId) || nextStepId === step.stepId) {
        throw new Error(`workflow next step is invalid: ${step.stepId}:${nextStepId}`);
      }
    }
  }
  assertAcyclic(definition.steps);

  const allowanceIds = new Set<string>();
  for (const allowance of definition.retryAllowances) {
    if (
      !allowance.allowanceId ||
      allowanceIds.has(allowance.allowanceId) ||
      !Number.isInteger(allowance.maxRetries) ||
      allowance.maxRetries < 0
    ) {
      throw new Error(`workflow retry allowance is invalid: ${allowance.allowanceId}`);
    }
    allowanceIds.add(allowance.allowanceId);
  }
  for (const step of definition.steps) {
    for (const allowanceId of step.retryAllowanceIds) {
      if (!allowanceIds.has(allowanceId)) {
        throw new Error(`workflow step references unknown retry allowance: ${allowanceId}`);
      }
    }
  }
}

function validateAttemptBudget(step: ExplicitWorkflowStepDefinition): void {
  for (const [key, value] of Object.entries(step.attemptBudget)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`workflow attempt budget is invalid: ${step.stepId}:${key}`);
    }
  }
}

function assertAcyclic(steps: ExplicitWorkflowStepDefinition[]): void {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) throw new Error(`workflow graph contains a cycle: ${stepId}`);
    visiting.add(stepId);
    for (const nextStepId of byId.get(stepId)?.nextStepIds ?? []) visit(nextStepId);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.stepId);
}

function validateTriggerEvent(event: ExplicitWorkflowTriggerEvent): void {
  if (!event.eventId || !event.key || !Number.isFinite(event.occurredAt)) {
    throw new Error("explicit workflow trigger event is invalid");
  }
}

function sameDefinition(
  left: ExplicitWorkflowDefinition,
  right: ExplicitWorkflowDefinition,
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

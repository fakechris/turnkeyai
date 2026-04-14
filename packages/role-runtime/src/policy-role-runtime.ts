import type {
  ApiDiagnosisReport,
  ApiExecutionAttempt,
  ApiExecutionVerifier,
  Clock,
  EvidenceTrustAssessment,
  EvidenceTrustPolicy,
  IdGenerator,
  PermissionCacheRecord,
  PermissionCacheStore,
  PermissionEvaluation,
  PermissionGovernancePolicy,
  PromptAdmissionDecision,
  PromptAdmissionPolicy,
  ReplayStore,
  RoleActivationInput,
  RoleRuntime,
  RoleRuntimeResult,
  RuntimeError,
  TeamEventBus,
  TeamMessage,
  TransportExecutionAudit,
  WorkerContinuationOutcome,
  WorkerKind,
  WorkerExecutionResult,
  WorkerEvidenceDigestStore,
  WorkerRuntime,
} from "@turnkeyai/core-types/team";
import { getContinuationContext } from "@turnkeyai/core-types/team";
import { classifyFailureFromStatus, classifyRuntimeError } from "@turnkeyai/qc-runtime/failure-taxonomy";

import type { ContextCompressor } from "./compression/context-compressor";
import type { RoleResponseGenerator } from "./deterministic-response-generator";
import type { RolePromptPacket, RolePromptPolicy } from "./prompt-policy";

interface PolicyRoleRuntimeOptions {
  idGenerator: Pick<IdGenerator, "messageId">;
  clock: Clock;
  promptPolicy: RolePromptPolicy;
  responseGenerator: RoleResponseGenerator;
  workerRuntime?: WorkerRuntime;
  contextCompressor?: ContextCompressor;
  workerEvidenceDigestStore?: WorkerEvidenceDigestStore;
  apiExecutionVerifier?: ApiExecutionVerifier;
  teamEventBus?: TeamEventBus;
  permissionGovernancePolicy?: PermissionGovernancePolicy;
  evidenceTrustPolicy?: EvidenceTrustPolicy;
  promptAdmissionPolicy?: PromptAdmissionPolicy;
  permissionCacheStore?: PermissionCacheStore;
  replayRecorder?: ReplayStore;
}

export class PolicyRoleRuntime implements RoleRuntime {
  private readonly idGenerator: Pick<IdGenerator, "messageId">;
  private readonly clock: Clock;
  private readonly promptPolicy: RolePromptPolicy;
  private readonly responseGenerator: RoleResponseGenerator;
  private readonly workerRuntime: WorkerRuntime | undefined;
  private readonly contextCompressor: ContextCompressor | undefined;
  private readonly workerEvidenceDigestStore: WorkerEvidenceDigestStore | undefined;
  private readonly apiExecutionVerifier: ApiExecutionVerifier | undefined;
  private readonly teamEventBus: TeamEventBus | undefined;
  private readonly permissionGovernancePolicy: PermissionGovernancePolicy | undefined;
  private readonly evidenceTrustPolicy: EvidenceTrustPolicy | undefined;
  private readonly promptAdmissionPolicy: PromptAdmissionPolicy | undefined;
  private readonly permissionCacheStore: PermissionCacheStore | undefined;
  private readonly replayRecorder: ReplayStore | undefined;

  constructor(options: PolicyRoleRuntimeOptions) {
    this.idGenerator = options.idGenerator;
    this.clock = options.clock;
    this.promptPolicy = options.promptPolicy;
    this.responseGenerator = options.responseGenerator;
    this.workerRuntime = options.workerRuntime;
    this.contextCompressor = options.contextCompressor;
    this.workerEvidenceDigestStore = options.workerEvidenceDigestStore;
    this.apiExecutionVerifier = options.apiExecutionVerifier;
    this.teamEventBus = options.teamEventBus;
    this.permissionGovernancePolicy = options.permissionGovernancePolicy;
    this.evidenceTrustPolicy = options.evidenceTrustPolicy;
    this.promptAdmissionPolicy = options.promptAdmissionPolicy;
    this.permissionCacheStore = options.permissionCacheStore;
    this.replayRecorder = options.replayRecorder;
  }

  async runActivation(input: RoleActivationInput): Promise<RoleRuntimeResult> {
    const role = input.thread.roles.find((item) => item.roleId === input.runState.roleId);
    if (!role) {
      return {
        status: "failed",
        error: this.error("ROLE_MISSING", `role not found: ${input.runState.roleId}`, false),
      };
    }

    try {
      const basePacket = await this.promptPolicy.buildPacket(input);
      let workerResult: WorkerExecutionResult | null = null;
      let activeWorker = null;
      let workerState: Awaited<ReturnType<NonNullable<WorkerRuntime>["getState"]>> | null = null;
      let workerError: RuntimeError | null = null;
      let workerBindings: RoleRuntimeResult["workerBindings"] = [];
      let workerGovernance: WorkerGovernanceBundle | null = null;
      let workerReplayPath: string | null = null;
      let workerContinuation: WorkerContinuationOutcome | null = null;

      if (this.workerRuntime) {
        try {
          const existingWorkerResolution = await this.resolveExistingWorker(
            input,
            basePacket
          );
          const existingWorker = existingWorkerResolution.worker;
          if (existingWorker) {
            activeWorker = existingWorker;
            workerContinuation = buildWorkerContinuationOutcome({
              packet: basePacket,
              resolution: existingWorkerResolution,
              activeWorker,
            });
            workerResult = await this.workerRuntime.resume({
              workerRunKey: existingWorker.workerRunKey,
              activation: input,
              packet: basePacket,
            });
            workerState = await this.workerRuntime.getState(existingWorker.workerRunKey);
          } else {
            activeWorker = await this.workerRuntime.spawn({
              activation: input,
              packet: basePacket,
            });
            if (activeWorker) {
              workerContinuation = buildWorkerContinuationOutcome({
                packet: basePacket,
                resolution: existingWorkerResolution,
                activeWorker,
              });
              workerResult = await this.workerRuntime.send({
                workerRunKey: activeWorker.workerRunKey,
                activation: input,
                packet: basePacket,
              });
              workerState = await this.workerRuntime.getState(activeWorker.workerRunKey);
            }
          }

          if (activeWorker) {
            workerBindings = [{ workerType: activeWorker.workerType, workerRunKey: activeWorker.workerRunKey }];
            workerGovernance = await this.evaluateWorkerGovernance(input, workerResult);
            await this.runBestEffort(
              () => this.persistWorkerEvidence(input, activeWorker!.workerRunKey, workerResult, workerGovernance),
              "persist worker evidence"
            );
            await this.runBestEffort(
              () =>
                this.publishWorkerEvents(
                  input,
                  activeWorker!.workerRunKey,
                  workerResult,
                  workerState,
                  workerGovernance,
                  workerContinuation
                ),
              "publish worker events"
            );
            workerReplayPath = await this.runBestEffort(
              () =>
                this.recordWorkerReplay(
                  input,
                  activeWorker!.workerRunKey,
                  workerResult,
                  workerGovernance,
                  workerContinuation
                ),
              "record worker replay",
              null
            );
          }
        } catch (error) {
          workerError = this.error(
            "WORKER_FAILED",
            error instanceof Error ? error.message : "worker execution failed",
            true
          );
          if (activeWorker) {
            workerReplayPath = await this.runBestEffort(
              () =>
                this.recordWorkerFailureReplay(
                  input,
                  activeWorker!.workerRunKey,
                  activeWorker!.workerType,
                  workerError!,
                  workerContinuation
                ),
              "record worker failure replay",
              null
            );
          }
        }
      }

      const packet = workerResult
        ? this.appendWorkerGovernanceToPacket(basePacket, workerResult, workerGovernance)
        : basePacket;
      const apiDiagnosis = workerGovernance?.apiDiagnosis ?? this.inspectApiExecution(workerResult?.payload);
      const reply = await this.responseGenerator.generate({
        activation: input,
        packet,
      });

      const message = this.buildMessage(input, reply.content, packet, {
        ...(reply.metadata ?? {}),
        ...(activeWorker ? { spawnedWorkers: [activeWorker] } : {}),
        ...(workerResult
          ? {
              workerUsed: true,
              workerType: workerResult.workerType,
              workerPayload: workerResult.payload,
              ...(workerState ? { workerState } : {}),
              ...(workerContinuation ? { workerContinuation } : {}),
              ...(apiDiagnosis.length > 0 ? { apiDiagnosis } : {}),
              ...(workerGovernance
                ? {
                    workerGovernance: {
                      permission: workerGovernance.permission,
                      trust: workerGovernance.trust,
                      admission: workerGovernance.admission,
                    },
                  }
                : {}),
              ...(workerReplayPath ? { replay: { worker: workerReplayPath } } : {}),
            }
          : {}),
        ...(workerError
          ? {
              workerUsed: false,
              workerError,
              ...(workerContinuation ? { workerContinuation } : {}),
              ...(workerReplayPath ? { replay: { worker: workerReplayPath } } : {}),
            }
          : {}),
        ...(basePacket.promptAssembly ? { promptAssembly: basePacket.promptAssembly } : {}),
      });
      const roleReplayPath = await this.runBestEffort(
        () =>
          this.recordRoleReplay(
            input,
            packet,
            message,
            workerGovernance,
            workerResult,
            workerError,
            workerReplayPath,
            workerContinuation
          ),
        "record role replay",
        null
      );
      if (roleReplayPath) {
        message.metadata = {
          ...(message.metadata ?? {}),
          replay: {
            ...(message.metadata?.replay && typeof message.metadata.replay === "object"
              ? (message.metadata.replay as Record<string, unknown>)
              : {}),
            role: roleReplayPath,
          },
        };
      }

      return {
        status: "ok",
        message,
        mentions: reply.mentions,
        ...(workerBindings.length > 0 ? { workerBindings } : {}),
      };
    } catch (error) {
      const runtimeError = normalizeRuntimeError(
        error,
        this.error("WORKER_FAILED", "role runtime generation failed", true)
      );
      await this.runBestEffort(() => this.recordRoleFailureReplay(input, runtimeError), "record role failure replay");
      return {
        status: "failed",
        error: runtimeError,
      };
    }
  }

  private inspectApiExecution(payload: unknown): ApiDiagnosisReport[] {
    if (!this.apiExecutionVerifier || !payload || typeof payload !== "object") {
      return [];
    }

    const record = payload as Record<string, unknown>;
    const attempts = collectApiAttempts(record);
    return attempts.map((attempt) => this.apiExecutionVerifier!.verify(attempt));
  }

  private async resolveExistingWorker(
    input: RoleActivationInput,
    packet: {
      preferredWorkerKinds?: WorkerKind[];
      continuityMode?: "fresh" | "prefer-existing" | "resume-existing";
      capabilityInspection?: { availableWorkers: WorkerKind[] };
    }
  ): Promise<{
    worker: { workerType: WorkerKind; workerRunKey: string } | null;
    requestedWorkerType?: WorkerKind;
    requestedWorkerRunKey?: string;
    reason?: WorkerContinuationOutcome["reason"];
  }> {
    const workerSessions = input.runState.workerSessions;
    if (!workerSessions || !this.workerRuntime) {
      return { worker: null };
    }

    const preferredKinds = packet.preferredWorkerKinds?.length ? packet.preferredWorkerKinds : inferPreferredWorkerKinds(input);
    const allowedWorkers = packet.capabilityInspection?.availableWorkers
      ? new Set(packet.capabilityInspection.availableWorkers)
      : null;
    let firstUnavailable:
      | {
          requestedWorkerType?: WorkerKind;
          requestedWorkerRunKey?: string;
          reason: WorkerContinuationOutcome["reason"];
        }
      | null = null;
    for (const workerType of preferredKinds) {
      const workerRunKey = workerSessions[workerType];
      if (allowedWorkers && !allowedWorkers.has(workerType)) {
        if (workerRunKey && !firstUnavailable) {
          firstUnavailable = {
            requestedWorkerType: workerType,
            requestedWorkerRunKey: workerRunKey,
            reason: "capability_unavailable",
          };
        }
        continue;
      }

      if (!workerRunKey) {
        continue;
      }

      const state = await this.workerRuntime.getState(workerRunKey);
      if (!state) {
        if (!firstUnavailable) {
          firstUnavailable = {
            requestedWorkerType: workerType,
            requestedWorkerRunKey: workerRunKey,
            reason: "session_missing",
          };
        }
        continue;
      }
      if (state.status === "failed" || state.status === "cancelled") {
        if (!firstUnavailable) {
          firstUnavailable = {
            requestedWorkerType: workerType,
            requestedWorkerRunKey: workerRunKey,
            reason: "session_terminal",
          };
        }
        continue;
      }

      if (!shouldReuseWorkerSession(packet.continuityMode, state.status)) {
        if (!firstUnavailable) {
          firstUnavailable = {
            requestedWorkerType: workerType,
            requestedWorkerRunKey: workerRunKey,
            reason: packet.continuityMode === "fresh" ? "fresh_requested" : "reuse_disallowed",
          };
        }
        continue;
      }

      return {
        worker: { workerType, workerRunKey },
        requestedWorkerType: workerType,
        requestedWorkerRunKey: workerRunKey,
      };
    }

    if (firstUnavailable) {
      return {
        worker: null,
        ...firstUnavailable,
      };
    }

    const boundKinds = preferredKinds.filter((workerType) => Boolean(workerSessions[workerType]));
    return {
      worker: null,
      ...(boundKinds[0]
        ? {
            requestedWorkerType: boundKinds[0],
            requestedWorkerRunKey: workerSessions[boundKinds[0]],
          }
        : {}),
      reason: packet.continuityMode === "fresh" ? "fresh_requested" : "no_bound_session",
    };
  }

  private buildMessage(
    input: RoleActivationInput,
    content: string,
    packet: { systemPrompt: string; outputContract: string },
    generationMetadata: Record<string, unknown>
  ): TeamMessage {
    const now = this.clock.now();
    const role = input.thread.roles.find((item) => item.roleId === input.runState.roleId);
    const route = role?.seat === "lead" ? "lead-role" : "member-worker";

    return {
      id: this.idGenerator.messageId(),
      threadId: input.thread.threadId,
      role: "assistant",
      roleId: input.runState.roleId,
      name: role?.name ?? input.runState.roleId,
      content,
      createdAt: now,
      updatedAt: now,
      source: {
        type: "worker",
        chatType: "group",
        route,
        speakerType: "Role",
        speakerName: role?.name ?? input.runState.roleId,
      },
      metadata: {
        activationType: input.handoff.activationType,
        flowId: input.flow.flowId,
        runtimeMode: "policy-driven",
        outputContract: packet.outputContract,
        systemPromptPreview: packet.systemPrompt,
        ...generationMetadata,
      },
    };
  }

  private error(code: RuntimeError["code"], message: string, retryable: boolean): RuntimeError {
    return { code, message, retryable };
  }

  private async persistWorkerEvidence(
    input: RoleActivationInput,
    workerRunKey: string,
    workerResult: Awaited<ReturnType<NonNullable<WorkerRuntime>["send"]>>,
    governance: WorkerGovernanceBundle | null
  ): Promise<void> {
    if (!workerResult || !this.contextCompressor || !this.workerEvidenceDigestStore) {
      return;
    }

    const payload = workerResult.payload;
    if (!payload || typeof payload !== "object") {
      return;
    }

    const trace = Array.isArray((payload as Record<string, unknown>).trace)
      ? ((payload as Record<string, unknown>).trace as Array<Record<string, unknown>>)
      : [];
    if (trace.length === 0) {
      return;
    }

    const digest = await this.contextCompressor.compressWorkerTrace({
      workerRunKey,
      threadId: input.thread.threadId,
      workerType: workerResult.workerType,
      status: workerResult.status,
      ...(governance?.trust.sourceType ? { sourceType: governance.trust.sourceType } : {}),
      ...(governance?.trust.trustLevel ? { trustLevel: governance.trust.trustLevel } : {}),
      ...(governance?.admission.mode ? { admissionMode: governance.admission.mode } : {}),
      ...(governance?.admission.reason ? { admissionReason: governance.admission.reason } : {}),
      trace,
      artifactIds: extractArtifactIds(payload as Record<string, unknown>),
    });
    await this.workerEvidenceDigestStore.put(digest);
  }

  private async publishWorkerEvents(
    input: RoleActivationInput,
    workerRunKey: string,
    workerResult: Awaited<ReturnType<NonNullable<WorkerRuntime>["send"]>>,
    workerState: Awaited<ReturnType<NonNullable<WorkerRuntime>["getState"]>>,
    governance: WorkerGovernanceBundle | null,
    workerContinuation: WorkerContinuationOutcome | null
  ): Promise<void> {
    if (!this.teamEventBus || !workerResult) {
      return;
    }

    const now = this.clock.now();
    const payload = workerResult.payload && typeof workerResult.payload === "object"
      ? (workerResult.payload as Record<string, unknown>)
      : {};
    const transportAudit = governance?.transportAudit ?? getTransportAudit(payload);
    const apiDiagnosis = governance?.apiDiagnosis ?? this.inspectApiExecution(workerResult.payload);
    const permission = governance?.permission ?? defaultPermissionEvaluation(input.thread.threadId, workerResult.workerType);
    const trust = governance?.trust ?? defaultTrustAssessment(workerResult.workerType, workerResult.status, payload, apiDiagnosis, permission, transportAudit);
    const admission = governance?.admission ?? defaultPromptAdmissionDecision(workerResult.status, trust, permission, apiDiagnosis);

    await this.teamEventBus.publish({
      eventId: this.idGenerator.messageId(),
      threadId: input.thread.threadId,
      kind: "worker.updated",
      createdAt: now,
      payload: {
        roleId: input.runState.roleId,
        workerType: workerResult.workerType,
        workerRunKey,
        status: workerResult.status,
        ...(workerState ? { workerState: workerState.status } : {}),
        ...(workerContinuation ? { workerContinuation } : {}),
      },
    });

    await this.teamEventBus.publish({
      eventId: this.idGenerator.messageId(),
      threadId: input.thread.threadId,
      kind: "audit.logged",
      createdAt: now,
      payload: {
        scope: "worker_execution",
        roleId: input.runState.roleId,
        workerType: workerResult.workerType,
        workerRunKey,
        status: workerResult.status,
        permissionRequirement: permission.requirement.level,
        permission,
        transport: transportAudit?.finalTransport ?? null,
        transportAudit,
        trustLevel: trust.trustLevel,
        trust,
        admission,
        apiDiagnosis,
        ...(workerContinuation ? { workerContinuation } : {}),
        ...(classifyFailureFromStatus({
          layer: "worker",
          status: workerResult.status,
          summary: workerResult.summary,
          payload,
        })
          ? {
              failure: classifyFailureFromStatus({
                layer: "worker",
                status: workerResult.status,
                summary: workerResult.summary,
                payload,
              }),
            }
          : {}),
      },
    });
  }

  private async evaluateWorkerGovernance(
    input: RoleActivationInput,
    workerResult: WorkerExecutionResult | null
  ): Promise<WorkerGovernanceBundle | null> {
    if (!workerResult) {
      return null;
    }

    const payload = getPayloadRecord(workerResult.payload);
    const apiDiagnosis = this.inspectApiExecution(workerResult.payload);
    const transportAudit = getTransportAudit(payload);
    const provisional = this.permissionGovernancePolicy?.evaluate({
      now: this.clock.now(),
      threadId: input.thread.threadId,
      workerType: workerResult.workerType,
      payload,
      apiDiagnosis,
      transportAudit,
      cachedDecision: null,
    }) ?? defaultPermissionEvaluation(input.thread.threadId, workerResult.workerType);
    const cachedDecision =
      this.permissionCacheStore && provisional.requirement.cacheKey
        ? await this.permissionCacheStore.get(provisional.requirement.cacheKey)
        : null;
    const permission = this.permissionGovernancePolicy?.evaluate({
      now: this.clock.now(),
      threadId: input.thread.threadId,
      workerType: workerResult.workerType,
      payload,
      apiDiagnosis,
      transportAudit,
      cachedDecision,
    }) ?? provisional;
    const trust = this.evidenceTrustPolicy?.assess({
      workerType: workerResult.workerType,
      workerStatus: workerResult.status,
      payload,
      apiDiagnosis,
      permission,
      transportAudit,
    }) ?? defaultTrustAssessment(workerResult.workerType, workerResult.status, payload, apiDiagnosis, permission, transportAudit);
    const admission = this.promptAdmissionPolicy?.decide({
      workerType: workerResult.workerType,
      workerStatus: workerResult.status,
      summary: workerResult.summary,
      payload,
      trust,
      permission,
      apiDiagnosis,
    }) ?? defaultPromptAdmissionDecision(workerResult.status, trust, permission, apiDiagnosis);

    await this.persistPermissionDecision(input, workerResult.workerType, permission);

    return {
      permission,
      trust,
      admission,
      apiDiagnosis,
      transportAudit,
      cachedDecision,
    };
  }

  private async persistPermissionDecision(
    input: RoleActivationInput,
    workerType: WorkerKind,
    permission: PermissionEvaluation
  ): Promise<void> {
    if (!this.permissionCacheStore || permission.source === "cache") {
      return;
    }

    const now = this.clock.now();
    await this.permissionCacheStore.put({
      cacheKey: permission.requirement.cacheKey,
      threadId: input.thread.threadId,
      workerType,
      requirement: permission.requirement,
      decision: permission.decision,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + permissionCacheTtlMs(permission),
      ...(permission.denialReason ? { denialReason: permission.denialReason } : {}),
    });
  }

  private async runBestEffort<T>(operation: () => Promise<T>, label: string, fallbackValue: T): Promise<T>;
  private async runBestEffort(operation: () => Promise<void>, label: string): Promise<void>;
  private async runBestEffort<T>(
    operation: () => Promise<T>,
    label: string,
    fallbackValue?: T
  ): Promise<T | void> {
    try {
      return await operation();
    } catch (error) {
      console.error(
        `${label} failed:`,
        error instanceof Error ? error.message : error
      );
      return fallbackValue;
    }
  }

  private appendWorkerGovernanceToPacket(
    packet: RolePromptPacket,
    workerResult: WorkerExecutionResult,
    governance: WorkerGovernanceBundle | null
  ): RolePromptPacket {
    const workerSection = buildWorkerPromptSection(workerResult, governance);
    if (!workerSection) {
      return packet;
    }

    return {
      ...packet,
      taskPrompt: `${packet.taskPrompt}\n\n${workerSection}`,
    };
  }

  private async recordWorkerReplay(
    input: RoleActivationInput,
    workerRunKey: string,
    workerResult: WorkerExecutionResult | null,
    governance: WorkerGovernanceBundle | null,
    workerContinuation: WorkerContinuationOutcome | null
  ): Promise<string | null> {
    if (!this.replayRecorder || !workerResult) {
      return null;
    }

    const payload = getPayloadRecord(workerResult.payload);
    const recoveryContext = getContinuationContext(input.handoff.payload)?.recovery;
    const failure = classifyFailureFromStatus({
      layer: "worker",
      status: workerResult.status,
      summary: workerResult.summary,
      payload,
    });

    return this.replayRecorder.record({
      replayId: `${input.handoff.taskId}:worker:${workerRunKey}`,
      layer: "worker",
      status: workerResult.status,
      recordedAt: this.clock.now(),
      threadId: input.thread.threadId,
      flowId: input.flow.flowId,
      roleId: input.runState.roleId,
      taskId: input.handoff.taskId,
      ...(recoveryContext?.dispatchReplayId
        ? { parentReplayId: recoveryContext.dispatchReplayId }
        : {}),
      workerType: workerResult.workerType,
      workerRunKey,
      summary: workerResult.summary,
      ...(failure ? { failure } : {}),
      metadata: {
        ...(recoveryContext
          ? { recoveryContext }
          : {}),
        ...(workerContinuation ? { workerContinuation } : {}),
        governance: governance
          ? {
              permission: governance.permission,
              trust: governance.trust,
              admission: governance.admission,
              apiDiagnosis: governance.apiDiagnosis,
              transportAudit: governance.transportAudit,
            }
          : null,
        payload,
      },
    });
  }

  private async recordWorkerFailureReplay(
    input: RoleActivationInput,
    workerRunKey: string,
    workerType: WorkerKind,
    error: RuntimeError,
    workerContinuation?: WorkerContinuationOutcome | null
  ): Promise<string | null> {
    if (!this.replayRecorder) {
      return null;
    }
    const recoveryContext = getContinuationContext(input.handoff.payload)?.recovery;

    return this.replayRecorder.record({
      replayId: `${input.handoff.taskId}:worker:${workerRunKey}`,
      layer: "worker",
      status: "failed",
      recordedAt: this.clock.now(),
      threadId: input.thread.threadId,
      flowId: input.flow.flowId,
      roleId: input.runState.roleId,
      taskId: input.handoff.taskId,
      ...(recoveryContext?.dispatchReplayId
        ? { parentReplayId: recoveryContext.dispatchReplayId }
        : {}),
      workerType,
      workerRunKey,
      summary: error.message,
      failure: classifyRuntimeError({
        layer: "worker",
        error,
        fallbackMessage: error.message,
      }),
      metadata: {
        ...(workerContinuation ? { workerContinuation } : {}),
      },
    });
  }

  private async recordRoleReplay(
    input: RoleActivationInput,
    packet: RolePromptPacket,
    message: TeamMessage,
    governance: WorkerGovernanceBundle | null,
    workerResult: WorkerExecutionResult | null,
    workerError: RuntimeError | null,
    workerReplayPath: string | null,
    workerContinuation: WorkerContinuationOutcome | null
  ): Promise<string | null> {
    if (!this.replayRecorder) {
      return null;
    }
    const recoveryContext = getContinuationContext(input.handoff.payload)?.recovery;

    const failure =
      workerError != null
        ? classifyRuntimeError({
            layer: "role",
            error: workerError,
            fallbackMessage: workerError.message,
          })
        : undefined;

    return this.replayRecorder.record({
      replayId: `${input.handoff.taskId}:role:${input.runState.runKey}`,
      layer: "role",
      status: workerError ? "failed" : "completed",
      recordedAt: this.clock.now(),
      threadId: input.thread.threadId,
      flowId: input.flow.flowId,
      roleId: input.runState.roleId,
      taskId: input.handoff.taskId,
      ...(recoveryContext?.dispatchReplayId
        ? { parentReplayId: recoveryContext.dispatchReplayId }
        : {}),
      summary: message.content,
      ...(failure ? { failure } : {}),
      metadata: {
        continuityMode: packet.continuityMode ?? null,
        activationType: input.handoff.activationType,
        ...(recoveryContext
          ? { recoveryContext }
          : {}),
        ...(workerResult ? { workerStatus: workerResult.status, workerType: workerResult.workerType } : {}),
        ...(workerContinuation ? { workerContinuation } : {}),
        ...(workerReplayPath ? { workerReplayPath } : {}),
        ...(governance
          ? {
              governance: {
                permission: governance.permission,
                trust: governance.trust,
                admission: governance.admission,
              },
            }
          : {}),
      },
    });
  }

  private async recordRoleFailureReplay(input: RoleActivationInput, error: RuntimeError): Promise<void> {
    if (!this.replayRecorder) {
      return;
    }
    const recoveryContext = getContinuationContext(input.handoff.payload)?.recovery;

    await this.replayRecorder.record({
      replayId: `${input.handoff.taskId}:role:${input.runState.runKey}`,
      layer: "role",
      status: "failed",
      recordedAt: this.clock.now(),
      threadId: input.thread.threadId,
      flowId: input.flow.flowId,
      roleId: input.runState.roleId,
      taskId: input.handoff.taskId,
      ...(recoveryContext?.dispatchReplayId
        ? { parentReplayId: recoveryContext.dispatchReplayId }
        : {}),
      summary: error.message,
      failure: classifyRuntimeError({
        layer: "role",
        error,
        fallbackMessage: error.message,
      }),
      metadata: {
        activationType: input.handoff.activationType,
        ...(recoveryContext
          ? { recoveryContext }
          : {}),
      },
    });
  }
}

function normalizeRuntimeError(error: unknown, fallback: RuntimeError): RuntimeError {
  if (error && typeof error === "object") {
    const record = error as Partial<RuntimeError> & { details?: unknown };
    if (typeof record.code === "string" && typeof record.message === "string") {
      return {
        code: record.code,
        message: record.message,
        retryable: typeof record.retryable === "boolean" ? record.retryable : fallback.retryable,
        ...(record.details && typeof record.details === "object"
          ? { details: record.details as Record<string, unknown> }
          : {}),
      };
    }
  }

  if (error instanceof Error) {
    return {
      ...fallback,
      message: error.message,
    };
  }

  return fallback;
}

interface WorkerGovernanceBundle {
  permission: PermissionEvaluation;
  trust: EvidenceTrustAssessment;
  admission: PromptAdmissionDecision;
  apiDiagnosis: ApiDiagnosisReport[];
  transportAudit: TransportExecutionAudit | null;
  cachedDecision: PermissionCacheRecord | null;
}

function buildWorkerContinuationOutcome(input: {
  packet: {
    continuityMode?: "fresh" | "prefer-existing" | "resume-existing";
  };
  resolution: {
    worker: { workerType: WorkerKind; workerRunKey: string } | null;
    requestedWorkerType?: WorkerKind;
    requestedWorkerRunKey?: string;
    reason?: WorkerContinuationOutcome["reason"];
  };
  activeWorker: { workerType: WorkerKind; workerRunKey: string } | null;
}): WorkerContinuationOutcome | null {
  const requestedMode = input.packet.continuityMode ?? null;
  const activeWorker = input.activeWorker;
  if (!activeWorker) {
    return requestedMode
      ? {
          state: requestedMode === "resume-existing" ? "cold_recreated" : "spawned_fresh",
          requestedMode,
          ...(input.resolution.requestedWorkerType ? { requestedWorkerType: input.resolution.requestedWorkerType } : {}),
          ...(input.resolution.requestedWorkerRunKey ? { requestedWorkerRunKey: input.resolution.requestedWorkerRunKey } : {}),
          ...(input.resolution.reason ? { reason: input.resolution.reason } : {}),
          summary:
            requestedMode === "resume-existing"
              ? buildColdRecreatedSummary(input.resolution.reason)
              : buildSpawnFreshSummary(requestedMode, input.resolution.reason),
        }
      : null;
  }

  if (input.resolution.worker) {
    return {
      state: "resumed_existing",
      requestedMode,
      resolvedWorkerType: activeWorker.workerType,
      resolvedWorkerRunKey: activeWorker.workerRunKey,
      requestedWorkerType: input.resolution.worker.workerType,
      requestedWorkerRunKey: input.resolution.worker.workerRunKey,
      summary: `Resumed the existing ${activeWorker.workerType} worker session.`,
    };
  }

  return {
    state: requestedMode === "resume-existing" ? "cold_recreated" : "spawned_fresh",
    requestedMode,
    ...(input.resolution.requestedWorkerType ? { requestedWorkerType: input.resolution.requestedWorkerType } : {}),
    ...(input.resolution.requestedWorkerRunKey ? { requestedWorkerRunKey: input.resolution.requestedWorkerRunKey } : {}),
    resolvedWorkerType: activeWorker.workerType,
    resolvedWorkerRunKey: activeWorker.workerRunKey,
    ...(input.resolution.reason ? { reason: input.resolution.reason } : {}),
    summary:
      requestedMode === "resume-existing"
        ? buildColdRecreatedSummary(input.resolution.reason)
        : buildSpawnFreshSummary(requestedMode, input.resolution.reason),
  };
}

function buildColdRecreatedSummary(reason: WorkerContinuationOutcome["reason"] | undefined): string {
  switch (reason) {
    case "session_missing":
      return "Requested resume-existing but the bound worker session was missing, so work restarted cold.";
    case "session_terminal":
      return "Requested resume-existing but the bound worker session was already terminal, so work restarted cold.";
    case "capability_unavailable":
      return "Requested resume-existing but the bound worker capability was unavailable, so work restarted cold.";
    case "reuse_disallowed":
      return "Requested resume-existing but the existing worker session was not reusable, so work restarted cold.";
    case "no_bound_session":
      return "Requested resume-existing but no bound worker session was available, so work restarted cold.";
    default:
      return "Requested resume-existing but work restarted cold instead of resuming a live worker session.";
  }
}

function buildSpawnFreshSummary(
  requestedMode: "fresh" | "prefer-existing" | "resume-existing" | null,
  reason: WorkerContinuationOutcome["reason"] | undefined
): string {
  if (requestedMode === "fresh" || reason === "fresh_requested") {
    return "Started a fresh worker session as requested.";
  }
  if (requestedMode === "prefer-existing") {
    switch (reason) {
      case "session_missing":
        return "Preferred an existing worker session, but the bound session was missing, so a fresh worker session started.";
      case "session_terminal":
        return "Preferred an existing worker session, but the bound session was terminal, so a fresh worker session started.";
      case "capability_unavailable":
        return "Preferred an existing worker session, but that capability was unavailable, so a fresh worker session started.";
      default:
        return "Preferred an existing worker session, but a fresh worker session started instead.";
    }
  }
  return "Started a fresh worker session.";
}

function shouldReuseWorkerSession(
  continuityMode: "fresh" | "prefer-existing" | "resume-existing" | undefined,
  status: NonNullable<Awaited<ReturnType<WorkerRuntime["getState"]>>>["status"]
): boolean {
  if (continuityMode === "fresh") {
    return false;
  }

  if (continuityMode === "resume-existing") {
    return true;
  }

  if (continuityMode === "prefer-existing") {
    return ["running", "waiting_input", "waiting_external", "resumable", "done"].includes(status);
  }

  return ["running", "waiting_input", "waiting_external", "resumable"].includes(status);
}

function collectApiAttempts(payload: Record<string, unknown>): ApiExecutionAttempt[] {
  const attempts: ApiExecutionAttempt[] = [];

  const singleAttempt = payload.apiAttempt;
  if (isApiExecutionAttempt(singleAttempt)) {
    attempts.push(singleAttempt);
  }

  const multipleAttempts = payload.apiAttempts;
  if (Array.isArray(multipleAttempts)) {
    for (const item of multipleAttempts) {
      if (isApiExecutionAttempt(item)) {
        attempts.push(item);
      }
    }
  }

  return attempts;
}

function isApiExecutionAttempt(value: unknown): value is ApiExecutionAttempt {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.apiName === "string" &&
    typeof record.operation === "string" &&
    (record.transport === "official_api" || record.transport === "business_tool")
  );
}

function inferPreferredWorkerKinds(input: RoleActivationInput): WorkerKind[] {
  const role = input.thread.roles.find((item) => item.roleId === input.runState.roleId);
  const capabilities = new Set(role?.capabilities ?? []);
  const ordered: WorkerKind[] = [];

  if (capabilities.has("browser")) {
    ordered.push("browser");
  }
  if (capabilities.has("coder")) {
    ordered.push("coder");
  }
  if (capabilities.has("finance")) {
    ordered.push("finance");
  }
  if (capabilities.has("explore")) {
    ordered.push("explore");
  }
  if (capabilities.has("harness")) {
    ordered.push("harness");
  }

  return ordered.length > 0 ? ordered : ["browser", "coder", "finance", "explore", "harness"];
}

function extractArtifactIds(payload: Record<string, unknown>): string[] {
  if (Array.isArray(payload.artifactIds)) {
    return payload.artifactIds.filter((item): item is string => typeof item === "string");
  }

  // Defensive fallback: current browser capture writes both artifactIds and screenshotPaths,
  // but older payload shapes may only expose screenshots.
  if (Array.isArray(payload.screenshotPaths)) {
    return payload.screenshotPaths.filter((item): item is string => typeof item === "string");
  }

  return [];
}

function getPayloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function getTransportAudit(payload: Record<string, unknown>): TransportExecutionAudit | null {
  const transportAudit = payload.transportAudit;
  if (!transportAudit || typeof transportAudit !== "object") {
    return null;
  }

  return transportAudit as TransportExecutionAudit;
}

function defaultPermissionEvaluation(threadId: string, workerType: WorkerKind): PermissionEvaluation {
  return {
    requirement: {
      level: "none",
      scope: "read",
      rationale: "default permissive read-only execution",
      cacheKey: `${threadId}:${workerType}:read:none`,
    },
    decision: "granted",
    source: "policy",
    recommendedAction: "proceed",
  };
}

function defaultTrustAssessment(
  workerType: WorkerKind,
  workerStatus: WorkerExecutionResult["status"],
  _payload: Record<string, unknown>,
  apiDiagnosis: ApiDiagnosisReport[],
  permission: PermissionEvaluation,
  transportAudit: TransportExecutionAudit | null
): EvidenceTrustAssessment {
  const trustLevel =
    permission.decision === "granted" &&
    workerStatus === "completed" &&
    apiDiagnosis.every((entry) => entry.ok)
      ? transportAudit?.trustLevel ?? "promotable"
      : "observational";

  return {
    sourceType: inferSourceType(workerType, transportAudit),
    trustLevel,
    rationale:
      trustLevel === "promotable"
        ? ["default trust path accepted completed worker result"]
        : [`worker result downgraded (status=${workerStatus}, permission=${permission.decision})`],
    verified: trustLevel === "promotable",
    downgraded: trustLevel !== "promotable",
  };
}

function defaultPromptAdmissionDecision(
  workerStatus: WorkerExecutionResult["status"],
  trust: EvidenceTrustAssessment,
  permission: PermissionEvaluation,
  apiDiagnosis: ApiDiagnosisReport[]
): PromptAdmissionDecision {
  if (permission.decision === "denied" || workerStatus === "failed") {
    return {
      mode: "blocked",
      trustLevel: "observational",
      reason: permission.denialReason ?? "worker result is not admissible",
    };
  }

  if (permission.decision === "prompt_required" || trust.trustLevel === "observational" || apiDiagnosis.some((entry) => !entry.ok)) {
    return {
      mode: "summary_only",
      trustLevel: trust.trustLevel,
      reason: "worker result is downgraded to summary only",
    };
  }

  return {
    mode: workerStatus === "completed" ? "full" : "summary_only",
    trustLevel: trust.trustLevel,
    reason: workerStatus === "completed" ? "worker result is fully admissible" : "partial worker result is summary only",
  };
}

function inferSourceType(workerType: WorkerKind, transportAudit: TransportExecutionAudit | null): EvidenceTrustAssessment["sourceType"] {
  if (workerType === "browser" || transportAudit?.finalTransport === "browser") {
    return "browser";
  }

  if (transportAudit?.finalTransport === "official_api") {
    return "api";
  }

  return "tool";
}

function permissionCacheTtlMs(permission: PermissionEvaluation): number {
  if (permission.decision === "granted") {
    return 30 * 60 * 1000;
  }

  if (permission.decision === "prompt_required") {
    return 10 * 60 * 1000;
  }

  return 15 * 60 * 1000;
}

function buildWorkerPromptSection(
  workerResult: WorkerExecutionResult,
  governance: WorkerGovernanceBundle | null
): string | null {
  if (!governance) {
    return `Worker result:\n${workerResult.summary}`;
  }

  const action = governance.permission.recommendedAction ? ` Recommended action: ${governance.permission.recommendedAction}.` : "";
  if (governance.admission.mode === "full") {
    return [
      "Worker result:",
      workerResult.summary,
      `Trust: ${governance.trust.trustLevel}.`,
    ].join("\n");
  }

  if (governance.admission.mode === "summary_only") {
    return [
      "Worker observation (non-final):",
      workerResult.summary,
      `Reason: ${governance.admission.reason}.${action}`,
    ].join("\n");
  }

  return [
    "Worker governance note:",
    `Result was not admitted into prompt context. Reason: ${governance.admission.reason}.${action}`,
  ].join("\n");
}

import { hasContinuationDirectiveSignal } from "@turnkeyai/core-types/continuation-semantics";
import type {
  CapabilityDiscoveryService,
  CapabilityInspectionResult,
  DispatchContinuationContext,
  FanOutMergeContext,
  MergeSynthesisPacket,
  ParallelOrchestrationContext,
  ResearchShardPacket,
  RoleActivationInput,
  RoleId,
  RolePromptPacketLike,
  RoleSlot,
  WorkerKind,
} from "@turnkeyai/core-types/team";
import {
  getContinuationContext,
  getInstructions,
  getMergeContext,
  getParallelContext,
  getPreferredWorkerKinds,
  getRecentMessages,
  getRelayBrief,
  getSessionTarget,
} from "@turnkeyai/core-types/team";

import { DefaultContextBudgeter, type ContextBudgeter, type PromptTokenEstimate } from "./context/context-budgeter";
import { DefaultRoleMemoryResolver, type RoleMemoryResolver } from "./context/role-memory-resolver";
import { DefaultPromptAssembler, type OmittedPromptSegment, type PromptAssembler } from "./prompt/prompt-assembler";
import { getRoleModelHint, getRoleModelSelection } from "./role-model-selection";
import type { RoleProfileRegistry } from "./role-profile";

export interface RolePromptPacket extends RolePromptPacketLike {
  seat: RoleSlot["seat"];
  promptAssembly?: {
    tokenEstimate: PromptTokenEstimate;
    omittedSegments: OmittedPromptSegment[];
    includedSegments: string[];
    sectionOrder: string[];
    compactedSegments: string[];
    assemblyFingerprint: string;
    usedArtifacts: string[];
    envelopeHint?: {
      toolResultCount?: number;
      toolResultBytes?: number;
      inlineAttachmentBytes?: number;
      inlineImageCount?: number;
      inlineImageBytes?: number;
      inlinePdfCount?: number;
      inlinePdfBytes?: number;
      multimodalPartCount?: number;
    };
  };
}

export interface RolePromptPolicy {
  buildPacket(input: RoleActivationInput): Promise<RolePromptPacket>;
}

interface ModelSelectionDescriber {
  describeSelection(input: { modelId?: string; modelChainId?: string }): Promise<{
    primary: {
      providerId: string;
      model: string;
    };
  }>;
}

export class DefaultRolePromptPolicy implements RolePromptPolicy {
  private static readonly MAX_SYSTEM_PROMPT_CACHE_ENTRIES = 64;
  private readonly roleProfileRegistry: RoleProfileRegistry;
  private readonly contextBudgeter: ContextBudgeter;
  private readonly roleMemoryResolver: RoleMemoryResolver;
  private readonly promptAssembler: PromptAssembler;
  private readonly reservedOutputTokens: number;
  private readonly capabilityDiscoveryService: CapabilityDiscoveryService | undefined;
  private readonly modelSelectionDescriber: ModelSelectionDescriber | undefined;
  private readonly systemPromptCache = new Map<string, string>();

  constructor(options: {
    roleProfileRegistry: RoleProfileRegistry;
    contextBudgeter?: ContextBudgeter;
    roleMemoryResolver?: RoleMemoryResolver;
    promptAssembler?: PromptAssembler;
    reservedOutputTokens?: number;
    capabilityDiscoveryService?: CapabilityDiscoveryService;
    modelSelectionDescriber?: ModelSelectionDescriber;
  }) {
    this.roleProfileRegistry = options.roleProfileRegistry;
    this.contextBudgeter = options.contextBudgeter ?? new DefaultContextBudgeter();
    this.roleMemoryResolver =
      options.roleMemoryResolver ??
      new DefaultRoleMemoryResolver({
        threadSummaryStore: { get: async () => null, put: async () => {} },
        roleScratchpadStore: { get: async () => null, put: async () => {} },
        workerEvidenceDigestStore: { get: async () => null, put: async () => {}, listByThread: async () => [] },
      });
    this.promptAssembler =
      options.promptAssembler ??
      new DefaultPromptAssembler({
        estimateTokens: (input, reservedOutputTokens, maxInputTokens) =>
          this.contextBudgeter.estimate(input, reservedOutputTokens, maxInputTokens),
      });
    this.reservedOutputTokens = options.reservedOutputTokens ?? 1_200;
    this.capabilityDiscoveryService = options.capabilityDiscoveryService;
    this.modelSelectionDescriber = options.modelSelectionDescriber;
  }

  async buildPacket(input: RoleActivationInput): Promise<RolePromptPacket> {
    const currentRole = input.thread.roles.find((item) => item.roleId === input.runState.roleId);
    if (!currentRole) {
      throw new Error(`role not found for prompt policy: ${input.runState.roleId}`);
    }

    const profile = this.roleProfileRegistry.resolve(currentRole);

    const remainingMembers = input.thread.roles.filter(
      (item) =>
        item.seat === "member" &&
        item.roleId !== currentRole.roleId &&
        !input.flow.completedRoleIds.includes(item.roleId)
    );

    const outputContract = buildOutputContract(currentRole, profile);
    const preferredWorkerKinds = inferPreferredWorkerKindsFromActivation(input, currentRole);
    const continuityMode = inferContinuityMode(input);
    const continuationContext = getContinuationContext(input.handoff.payload);
    const mergeContext = getMergeContext(input.handoff.payload);
    const parallelContext = getParallelContext(input.handoff.payload);
    const resumeTarget = getSessionTarget(input.handoff.payload);
    const threadSummary = await this.roleMemoryResolver.loadThreadSummary(input.thread.threadId);
    const threadSessionMemory = await this.roleMemoryResolver.loadThreadSessionMemory(input.thread.threadId);
    const roleScratchpad = await this.roleMemoryResolver.loadRoleScratchpad(input.thread.threadId, currentRole.roleId);
    const retrievedMemory = await this.roleMemoryResolver.retrieveMemory({
      threadId: input.thread.threadId,
      roleId: currentRole.roleId,
      queryText: buildMemoryQuery(input),
    });
    const workerEvidence = await this.roleMemoryResolver.loadWorkerEvidence(input.thread.threadId);
    const modelHint = await this.resolveModelHint(currentRole);
    const budget = await this.contextBudgeter.allocate({
      model: {
        provider: modelHint.provider,
        name: modelHint.name,
        contextWindow: inferContextWindow(modelHint.name),
      },
      reservedOutputTokens: this.reservedOutputTokens,
      mode: currentRole.seat === "lead" ? "lead" : "member",
    });
    const capabilityInspection = await this.capabilityDiscoveryService?.inspect({
      threadId: input.thread.threadId,
      roleId: currentRole.roleId,
      requestedCapabilities: inferRequestedCapabilities(currentRole),
      preferredWorkerKinds,
    });
    const assembly = await this.promptAssembler.assemble({
      thread: input.thread,
      flow: input.flow,
      role: currentRole,
      handoff: input.handoff,
      recentTurns: getRecentMessages(input.handoff.payload),
      threadSummary,
      threadSessionMemory,
      roleScratchpad,
      retrievedMemory,
      workerEvidence,
      budget,
    });
    const continuationSection = buildResolvedContinuationSection(
      continuationContext
        ? {
            continuityMode,
            continuationContext,
            roleScratchpad,
            threadSummary,
            threadSessionMemory,
          }
        : {
            continuityMode,
            roleScratchpad,
            threadSummary,
            threadSessionMemory,
          }
    );
    const parallelSection = parallelContext
      ? buildParallelContextSection(parallelContext)
      : null;
    const suggestedMentions = resolveSuggestedMentions({
      currentRole,
      remainingMembers,
      threadLeadRoleId: input.thread.leadRoleId,
      threadRoleIds: input.thread.roles.map((item) => item.roleId),
      ...(mergeContext ? { mergeContext } : {}),
      ...(parallelContext ? { parallelContext } : {}),
    });
    return {
      roleId: currentRole.roleId,
      roleName: currentRole.name,
      seat: currentRole.seat,
      systemPrompt: [this.buildCachedSystemPrompt(currentRole, profile.styleHints), "", assembly.systemPrompt].join("\n"),
      taskPrompt: [
        assembly.userPrompt,
        continuationSection,
        mergeContext ? buildMergeCoverageSection(mergeContext) : null,
        parallelSection,
        capabilityInspection ? buildCapabilityDigest(capabilityInspection) : null,
      ]
        .filter((section): section is string => Boolean(section))
        .join("\n\n"),
      outputContract,
      ...(preferredWorkerKinds.length > 0 ? { preferredWorkerKinds } : {}),
      ...(resumeTarget ? { resumeTarget } : {}),
      continuityMode,
      ...(continuationContext
        ? { continuationContext }
        : {}),
      ...(mergeContext ? { mergeContext } : {}),
      ...(parallelContext ? { parallelContext } : {}),
      suggestedMentions,
      ...(capabilityInspection ? { capabilityInspection } : {}),
      promptAssembly: {
        tokenEstimate: assembly.tokenEstimate,
        omittedSegments: assembly.omittedSegments,
        includedSegments: assembly.includedSegments,
        sectionOrder: assembly.sectionOrder,
        compactedSegments: assembly.compactedSegments,
        assemblyFingerprint: assembly.assemblyFingerprint,
        usedArtifacts: assembly.usedArtifacts,
        ...(assembly.envelopeHint ? { envelopeHint: assembly.envelopeHint } : {}),
      },
    };
  }

  private async resolveModelHint(role: RoleSlot): Promise<{ provider: string; name: string }> {
    const fallbackHint = getRoleModelHint(role);
    if (!this.modelSelectionDescriber) {
      return fallbackHint;
    }

    try {
      const selection = getRoleModelSelection(role);
      if (!selection.modelId && !selection.modelChainId) {
        return fallbackHint;
      }
      const described = await this.modelSelectionDescriber.describeSelection(selection);
      return {
        provider: described.primary.providerId,
        name: described.primary.model,
      };
    } catch {
      return fallbackHint;
    }
  }

  private buildCachedSystemPrompt(role: RoleSlot, styleHints: string[]): string {
    const cacheKey = JSON.stringify({
      roleId: role.roleId,
      name: role.name,
      seat: role.seat,
      styleHints,
    });
    const cached = this.systemPromptCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const built = buildSystemPrompt(role, styleHints);
    this.systemPromptCache.set(cacheKey, built);
    while (this.systemPromptCache.size > DefaultRolePromptPolicy.MAX_SYSTEM_PROMPT_CACHE_ENTRIES) {
      const oldestKey = this.systemPromptCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.systemPromptCache.delete(oldestKey);
    }
    return built;
  }
}

function buildSystemPrompt(role: RoleSlot, styleHints: string[]): string {
  if (role.seat === "lead") {
    return [
      `You are ${role.name}, the lead role in this team runtime.`,
      "Own delegation, convergence, and final delivery.",
      "When another role must act, mention exactly one next role.",
      `Style hints: ${styleHints.join(", ")}`,
    ].join("\n");
  }

  return [
    `You are ${role.name}, a specialist role in this team runtime.`,
    "Handle only your assigned slice.",
    "After contributing, hand control back to the lead role.",
    `Style hints: ${styleHints.join(", ")}`,
  ].join("\n");
}

function buildTaskPrompt(input: RoleActivationInput, role: RoleSlot, suggestedMentions: RoleId[]): string {
  const recent = getRecentMessages(input.handoff.payload)
    .slice(-3)
    .map((item) => `[${item.name}] ${item.content}`)
    .join("\n");

  return [
    `Activation type: ${input.handoff.activationType}`,
    `Current role: ${role.name}`,
    `Thread: ${input.thread.threadId}`,
    `Flow: ${input.flow.flowId}`,
    "",
    "Relay brief:",
    getRelayBrief(input.handoff.payload),
    "",
    "Recent messages:",
    recent || "(none)",
    "",
    `Suggested next mentions: ${suggestedMentions.join(", ") || "(none)"}`,
  ].join("\n");
}

function buildCapabilityDigest(input: CapabilityInspectionResult): string {
  const sections = ["Capability readiness:"];
  sections.push(
    `Workers: ${input.availableWorkers.join(", ") || "(none)"}`
  );

  if (input.connectorStates.length > 0) {
    sections.push(
      `Connectors: ${input.connectorStates
        .map((entry) => `${entry.provider}=${entry.authorized ? "authorized" : entry.available ? "available" : "missing"}`)
        .join(", ")}`
    );
  }

  if (input.apiStates.length > 0) {
    sections.push(
      `APIs: ${input.apiStates
        .map((entry) => `${entry.name}=${entry.ready ? "ready" : entry.configured ? "partial" : "missing"}`)
        .join(", ")}`
    );
  }

  if (input.transportPreferences.length > 0) {
    sections.push(
      `Transport order: ${input.transportPreferences
        .map((entry) => `${entry.capability}(${entry.orderedTransports.join(" > ")})`)
        .join("; ")}`
    );
  }

  if (input.unavailableCapabilities.length > 0) {
    sections.push(`Unavailable: ${input.unavailableCapabilities.join(", ")}`);
  }

  return sections.join("\n");
}

function buildContinuationContextDigest(
  input: DispatchContinuationContext
): string {
  return [
    "Continuation context:",
    `Source: ${input.source}`,
    input.workerType ? `Worker type: ${input.workerType}` : null,
    input.workerRunKey ? `Worker session: ${input.workerRunKey}` : null,
    input.summary ? `Summary: ${input.summary}` : null,
    input.browserSession?.sessionId ? `Browser session: ${input.browserSession.sessionId}` : null,
    input.browserSession?.targetId ? `Browser target: ${input.browserSession.targetId}` : null,
    input.browserSession?.resumeMode ? `Browser resume mode: ${input.browserSession.resumeMode}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildResolvedContinuationSection(input: {
  continuityMode: "fresh" | "prefer-existing" | "resume-existing";
  continuationContext?: DispatchContinuationContext;
  roleScratchpad: Awaited<ReturnType<RoleMemoryResolver["loadRoleScratchpad"]>>;
  threadSummary: Awaited<ReturnType<RoleMemoryResolver["loadThreadSummary"]>>;
  threadSessionMemory: Awaited<ReturnType<RoleMemoryResolver["loadThreadSessionMemory"]>>;
}): string | null {
  if (input.continuityMode === "fresh" && !input.continuationContext) {
    return null;
  }

  const lines = ["Execution continuity:"];
  if (input.continuationContext) {
    lines.push(...buildContinuationContextDigest(input.continuationContext).split("\n"));
  }

  if (input.roleScratchpad?.waitingOn) {
    lines.push(`Waiting on: ${input.roleScratchpad.waitingOn}`);
  }

  if (input.roleScratchpad?.pendingWork?.length) {
    lines.push(
      `Pending work: ${input.roleScratchpad.pendingWork.slice(-2).join(" | ")}`
    );
  }

  if (input.threadSessionMemory?.activeTasks?.length) {
    lines.push(`Active tasks: ${input.threadSessionMemory.activeTasks.slice(0, 2).join(" | ")}`);
  }

  if (input.threadSessionMemory?.recentDecisions?.length) {
    lines.push(
      `Recent decisions: ${input.threadSessionMemory.recentDecisions.slice(0, 2).join(" | ")}`
    );
  }

  const openQuestions = dedupeTextEntries([
    ...(input.threadSessionMemory?.openQuestions ?? []),
    ...(input.threadSummary?.openQuestions ?? []),
  ]);
  if (openQuestions.length > 0) {
    lines.push(
      `Open questions: ${openQuestions.slice(0, 2).join(" | ")}`
    );
  }

  if (input.threadSessionMemory?.continuityNotes?.length) {
    lines.push(`Continuity notes: ${input.threadSessionMemory.continuityNotes.slice(0, 2).join(" | ")}`);
  }

  if (input.threadSessionMemory?.constraints?.length) {
    lines.push(`Constraints: ${input.threadSessionMemory.constraints.slice(0, 2).join(" | ")}`);
  }

  if (input.threadSessionMemory?.latestJournalEntries?.length) {
    lines.push(`Recent journal: ${input.threadSessionMemory.latestJournalEntries.slice(-2).join(" | ")}`);
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

function dedupeTextEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function buildMergeCoverageSection(
  input: FanOutMergeContext
): string {
  return [
    "Merge coverage:",
    `Fan-out group: ${input.fanOutGroupId}`,
    `Expected roles: ${input.expectedRoleIds.join(", ") || "(none)"}`,
    input.completedRoleIds.length > 0 ? `Completed roles: ${input.completedRoleIds.join(", ")}` : null,
    input.failedRoleIds.length > 0 ? `Failed roles: ${input.failedRoleIds.join(", ")}` : null,
    input.cancelledRoleIds.length > 0 ? `Cancelled roles: ${input.cancelledRoleIds.join(", ")}` : null,
    input.missingRoleIds.length > 0 ? `Missing roles: ${input.missingRoleIds.join(", ")}` : null,
    input.duplicateRoleIds?.length ? `Duplicate roles: ${input.duplicateRoleIds.join(", ")}` : null,
    input.conflictRoleIds?.length ? `Conflict roles: ${input.conflictRoleIds.join(", ")}` : null,
    `Follow-up required: ${input.followUpRequired ? "yes" : "no"}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildParallelContextSection(
  input: ParallelOrchestrationContext
): string {
  if (input.kind === "research_shard") {
    return [
      "Parallel shard assignment:",
      `Group: ${input.fanOutGroupId}`,
      `Shard: ${input.shardIndex + 1}/${input.shardCount}`,
      `Assigned role: ${input.shardRoleId}`,
      `Coverage roles: ${input.expectedRoleIds.join(", ")}`,
      `Merge back to: ${input.mergeBackToRoleId}`,
      `Shard goal: ${input.shardGoal}`,
      "Only handle your shard. Do not pretend to finalize the whole task.",
    ].join("\n");
  }

  return [
    "Parallel merge packet:",
    `Group: ${input.fanOutGroupId}`,
    `Expected roles: ${input.expectedRoleIds.join(", ") || "(none)"}`,
    input.completedRoleIds.length > 0 ? `Completed roles: ${input.completedRoleIds.join(", ")}` : null,
    input.failedRoleIds.length > 0 ? `Failed roles: ${input.failedRoleIds.join(", ")}` : null,
    input.cancelledRoleIds.length > 0 ? `Cancelled roles: ${input.cancelledRoleIds.join(", ")}` : null,
    input.missingRoleIds.length > 0 ? `Missing roles: ${input.missingRoleIds.join(", ")}` : null,
    input.duplicateRoleIds.length > 0 ? `Duplicate roles: ${input.duplicateRoleIds.join(", ")}` : null,
    input.conflictRoleIds.length > 0 ? `Conflict roles: ${input.conflictRoleIds.join(", ")}` : null,
    input.shardSummaries.length > 0
      ? `Shard summaries: ${input.shardSummaries.map((item) => `${item.roleId}[${item.status}]: ${item.summary}`).join(" || ")}`
      : null,
    input.followUpRequired
      ? "This is a partial merge. Resolve missing, failed, or conflicting shards before treating the result as final."
      : "All shards are covered. Produce a single merged synthesis.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function resolveSuggestedMentions(input: {
  currentRole: RoleSlot;
  remainingMembers: RoleSlot[];
  threadLeadRoleId: RoleId;
  threadRoleIds: RoleId[];
  mergeContext?: FanOutMergeContext;
  parallelContext?: ParallelOrchestrationContext;
}): RoleId[] {
  const knownRoleIds = new Set(input.threadRoleIds);
  const sanitizeRoleIds = (roleIds: RoleId[]): RoleId[] =>
    uniqueRoleIds(roleIds).filter((roleId) => roleId !== input.currentRole.roleId && knownRoleIds.has(roleId));

  if (input.mergeContext?.followUpRequired) {
    const nextRoles = sanitizeRoleIds([
      ...input.mergeContext.missingRoleIds,
      ...input.mergeContext.failedRoleIds,
      ...input.mergeContext.cancelledRoleIds,
      ...(input.mergeContext.conflictRoleIds ?? []),
    ]);
    if (nextRoles.length > 0) {
      return nextRoles;
    }
  }

  if (input.parallelContext?.kind === "merge_synthesis" && input.parallelContext.followUpRequired) {
    const nextRoles = sanitizeRoleIds([
      ...input.parallelContext.missingRoleIds,
      ...input.parallelContext.failedRoleIds,
      ...input.parallelContext.cancelledRoleIds,
      ...input.parallelContext.conflictRoleIds,
    ]);
    if (nextRoles.length > 0) {
      return nextRoles;
    }
  }

  if (input.currentRole.seat === "lead") {
    return input.remainingMembers.slice(0, 1).map((item) => item.roleId);
  }

  return [input.threadLeadRoleId];
}

function buildOutputContract(role: RoleSlot, profile: { leadDirective: string; memberDirective: string; completionDirective: string }): string {
  if (role.seat === "lead") {
    return `${profile.leadDirective} ${profile.completionDirective}`;
  }

  return profile.memberDirective;
}

function inferContextWindow(modelName?: string): number {
  if (!modelName) {
    return 128_000;
  }

  if (/claude|gemini|gpt-5|opus|sonnet/i.test(modelName)) {
    return 1_000_000;
  }

  if (/kimi|minimax/i.test(modelName)) {
    return 256_000;
  }

  return 128_000;
}

function inferRequestedCapabilities(role: RoleSlot): string[] {
  const requested = new Set(role.capabilities ?? []);
  if (/operator|browser/i.test(role.name)) {
    requested.add("browser");
  }
  if (/shopify/i.test(role.name)) {
    requested.add("shopify");
  }
  if (/finance/i.test(role.name)) {
    requested.add("finance");
  }
  return [...requested];
}

function buildMemoryQuery(input: RoleActivationInput): string {
  const continuationContext = getContinuationContext(input.handoff.payload);
  return [
    continuationContext?.summary,
    getRelayBrief(input.handoff.payload),
    getInstructions(input.handoff.payload),
    ...getRecentMessages(input.handoff.payload).slice(-2).map((message) => message.content),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
}

function inferContinuityMode(input: RoleActivationInput): "fresh" | "prefer-existing" | "resume-existing" {
  const continuationContext = getContinuationContext(input.handoff.payload);
  if (continuationContext) {
    return "resume-existing";
  }

  const text = [
    getRelayBrief(input.handoff.payload),
    getInstructions(input.handoff.payload),
    ...getRecentMessages(input.handoff.payload).slice(-2).map((message) => message.content),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLowerCase();

  if (hasContinuationDirectiveSignal(text)) {
    return "prefer-existing";
  }

  return "fresh";
}

function inferPreferredWorkerKinds(role: RoleSlot): WorkerKind[] {
  const ordered: WorkerKind[] = [];
  const capabilities = new Set(role.capabilities ?? []);

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

  return ordered;
}

function uniqueRoleIds(roleIds: RoleId[]): RoleId[] {
  return [...new Set(roleIds)];
}

function inferPreferredWorkerKindsFromActivation(input: RoleActivationInput, role: RoleSlot): WorkerKind[] {
  const preferredWorkerKinds = getPreferredWorkerKinds(input.handoff.payload);
  if (preferredWorkerKinds.length) {
    return preferredWorkerKinds;
  }

  const explicit = extractExplicitWorkerPreference(getInstructions(input.handoff.payload));
  if (explicit.length > 0) {
    return explicit;
  }

  return inferPreferredWorkerKinds(role);
}

function extractExplicitWorkerPreference(instructions?: string): WorkerKind[] {
  if (!instructions) {
    return [];
  }

  const match = instructions.match(/preferred worker:\s*(browser|coder|finance|explore|harness)/i);
  if (!match?.[1]) {
    return [];
  }

  return [match[1].toLowerCase() as WorkerKind];
}

import { createHash } from "node:crypto";

import type {
  PromptSectionAuthority,
  PromptSectionBaselineBehavior,
  PromptSectionRuntimeReceipt,
  PromptSectionRuntimeState,
} from "@turnkeyai/core-types/team";

export const PROMPT_REGISTRY_PROTOCOL =
  "turnkeyai.prompt_registry.v1" as const;

export const PROMPT_ASSEMBLY_SEGMENTS = [
  "task-brief",
  "recent-turns",
  "thread-summary",
  "session-memory",
  "role-scratchpad",
  "retrieved-memory",
  "worker-evidence",
] as const;

export type PromptAssemblySegment =
  (typeof PROMPT_ASSEMBLY_SEGMENTS)[number];

export const PROMPT_ASSEMBLY_SECTION_IDS: Record<
  PromptAssemblySegment,
  string
> = {
  "task-brief": "prompt.assembly.task-brief",
  "recent-turns": "prompt.assembly.recent-turns",
  "thread-summary": "prompt.assembly.thread-summary",
  "session-memory": "prompt.assembly.session-memory",
  "role-scratchpad": "prompt.assembly.role-scratchpad",
  "retrieved-memory": "prompt.assembly.retrieved-memory",
  "worker-evidence": "prompt.assembly.worker-evidence",
};

export const TOOL_PROMPT_GROUP_SECTION_IDS = {
  general: "prompt.tools.general",
  sessions: "prompt.tools.sessions",
  web: "prompt.tools.web",
  artifacts: "prompt.tools.artifacts",
  permissions: "prompt.tools.permissions",
  memory: "prompt.tools.memory",
  tasks: "prompt.tools.tasks",
  browser: "prompt.tools.browser",
} as const;

export type ToolPromptSectionGroup =
  keyof typeof TOOL_PROMPT_GROUP_SECTION_IDS;

export type PromptSectionLifecycle =
  | "prompt-policy"
  | "assembly"
  | "tool-harness"
  | "dynamic-context"
  | "compaction"
  | "runtime-repair";

export interface PromptSectionDefinition {
  protocol: typeof PROMPT_REGISTRY_PROTOCOL;
  sectionId: string;
  version: string;
  owner: string;
  lifecycle: PromptSectionLifecycle;
  routeId: string;
  inputSchema: string;
  outputSchema: string;
  authority: PromptSectionAuthority;
  authorityKey: string;
  requiredCapability: string;
  tokenPolicy: {
    mode: "measured" | "bounded";
    maxTokens?: number;
  };
  baselineBehavior: PromptSectionBaselineBehavior;
}

export interface PromptRegistryAudit {
  protocol: typeof PROMPT_REGISTRY_PROTOCOL;
  registryVersion: string;
  definitionCount: number;
  reachableCount: number;
  unreachableSectionIds: string[];
  missingRouteIds: string[];
  valid: boolean;
}

export class PromptSectionRegistry {
  private readonly byId: Map<string, PromptSectionDefinition>;
  private readonly authorityOwners: Map<string, string>;

  constructor(
    readonly registryVersion: string,
    definitions: PromptSectionDefinition[],
  ) {
    if (!registryVersion.trim()) {
      throw new Error("prompt registry version is required");
    }
    this.byId = new Map();
    this.authorityOwners = new Map();
    for (const definition of definitions) {
      validateDefinition(definition);
      if (this.byId.has(definition.sectionId)) {
        throw new Error(
          `duplicate prompt section id: ${definition.sectionId}`,
        );
      }
      const authorityOwner = this.authorityOwners.get(
        definition.authorityKey,
      );
      if (authorityOwner) {
        throw new Error(
          `duplicate prompt authority key: ${definition.authorityKey} (${authorityOwner}, ${definition.sectionId})`,
        );
      }
      this.byId.set(definition.sectionId, structuredClone(definition));
      this.authorityOwners.set(
        definition.authorityKey,
        definition.sectionId,
      );
    }
  }

  definitions(): PromptSectionDefinition[] {
    return [...this.byId.values()].map((definition) =>
      structuredClone(definition)
    );
  }

  get(sectionId: string): PromptSectionDefinition {
    const definition = this.byId.get(sectionId);
    if (!definition) {
      throw new Error(`prompt section is not registered: ${sectionId}`);
    }
    return structuredClone(definition);
  }

  receipt(input: {
    sectionId: string;
    state: PromptSectionRuntimeState;
    estimatedTokens: number;
    reason?: string;
  }): PromptSectionRuntimeReceipt {
    const definition = this.get(input.sectionId);
    const estimatedTokens = Math.max(
      0,
      Number.isFinite(input.estimatedTokens)
        ? Math.ceil(input.estimatedTokens)
        : 0,
    );
    const maxTokens = definition.tokenPolicy.maxTokens;
    const overBudget =
      maxTokens !== undefined && estimatedTokens > maxTokens;
    return {
      sectionId: definition.sectionId,
      version: definition.version,
      owner: definition.owner,
      authority: definition.authority,
      requiredCapability: definition.requiredCapability,
      baselineBehavior: definition.baselineBehavior,
      state: input.state,
      estimatedTokens,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(overBudget ? { overBudget: true } : {}),
    };
  }

  audit(activeRouteIds: Iterable<string>): PromptRegistryAudit {
    const routes = new Set(activeRouteIds);
    const definitions = this.definitions();
    const unreachableSectionIds = definitions
      .filter((definition) => !routes.has(definition.routeId))
      .map((definition) => definition.sectionId)
      .sort();
    const registeredRoutes = new Set(
      definitions.map((definition) => definition.routeId),
    );
    const missingRouteIds = [...routes]
      .filter((routeId) => !registeredRoutes.has(routeId))
      .sort();
    return {
      protocol: PROMPT_REGISTRY_PROTOCOL,
      registryVersion: this.registryVersion,
      definitionCount: definitions.length,
      reachableCount: definitions.length - unreachableSectionIds.length,
      unreachableSectionIds,
      missingRouteIds,
      valid:
        unreachableSectionIds.length === 0 &&
        missingRouteIds.length === 0,
    };
  }
}

export const DEFAULT_PROMPT_SECTION_DEFINITIONS =
  buildDefaultPromptSectionDefinitions();

export const DEFAULT_PROMPT_SECTION_REGISTRY = new PromptSectionRegistry(
  "turnkeyai.prompt_registry.pack.v1",
  DEFAULT_PROMPT_SECTION_DEFINITIONS,
);

export const DEFAULT_ACTIVE_PROMPT_ROUTE_IDS = [
  ...PROMPT_ASSEMBLY_SEGMENTS.map((segment) => `assembly:${segment}`),
  "prompt-policy:role-system",
  "prompt-policy:output-contract",
  "tool-harness:general",
  "tool-harness:sessions",
  "tool-harness:web",
  "tool-harness:artifacts",
  "tool-harness:permissions",
  "tool-harness:memory",
  "tool-harness:tasks",
  "tool-harness:browser",
  "dynamic-context:full-delta",
  "compaction:checkpoint-projection",
  "compaction:summary",
  "runtime-repair:policy",
] as const;

export function auditDefaultPromptRegistry(): PromptRegistryAudit {
  return DEFAULT_PROMPT_SECTION_REGISTRY.audit(
    DEFAULT_ACTIVE_PROMPT_ROUTE_IDS,
  );
}

/**
 * Route ids for the lifecycle sections the runtime always assembles regardless
 * of which tool capabilities are enabled (prompt policy, context assembly,
 * dynamic context, compaction, runtime repair). Tool-harness routes are
 * derived separately from the live capability configuration.
 */
export const NON_TOOL_PROMPT_ROUTE_IDS = [
  ...PROMPT_ASSEMBLY_SEGMENTS.map((segment) => `assembly:${segment}`),
  "prompt-policy:role-system",
  "prompt-policy:output-contract",
  "dynamic-context:full-delta",
  "compaction:checkpoint-projection",
  "compaction:summary",
  "runtime-repair:policy",
] as const;

const TOOL_PROMPT_SECTION_ROUTE_BY_ID: Record<string, string> =
  Object.fromEntries(
    (Object.keys(TOOL_PROMPT_GROUP_SECTION_IDS) as ToolPromptSectionGroup[]).map(
      (group) => [TOOL_PROMPT_GROUP_SECTION_IDS[group], `tool-harness:${group}`],
    ),
  );

/**
 * Resolve the set of active prompt route ids from the live tool capability
 * configuration. Tool sections are supplied as section ids (what a
 * ToolCapabilityRegistry exposes via activePromptSectionIds); each is mapped to
 * its `tool-harness:<group>` route so the audit runs against the real runtime
 * shape. Section ids that do not map to a known tool route are passed through
 * verbatim so an unknown active section surfaces as a `missingRouteIds` entry.
 */
export function resolveActivePromptRouteIds(
  activeToolPromptSectionIds: Iterable<string>,
): string[] {
  const routes = new Set<string>(NON_TOOL_PROMPT_ROUTE_IDS);
  for (const sectionId of activeToolPromptSectionIds) {
    routes.add(TOOL_PROMPT_SECTION_ROUTE_BY_ID[sectionId] ?? sectionId);
  }
  return [...routes].sort();
}

function buildDefaultPromptSectionDefinitions(): PromptSectionDefinition[] {
  const definitions: PromptSectionDefinition[] =
    PROMPT_ASSEMBLY_SEGMENTS.map((segment) =>
      define({
        sectionId: PROMPT_ASSEMBLY_SECTION_IDS[segment],
        lifecycle: "assembly",
        routeId: `assembly:${segment}`,
        owner: "packages/role-runtime/src/prompt/prompt-assembler.ts",
        inputSchema: `PromptAssemblyInput.${segment}`,
        outputSchema: "bounded prompt text",
        authority:
          segment === "worker-evidence"
            ? "untrusted-evidence"
            : "context-projection",
        requiredCapability:
          segment === "retrieved-memory"
            ? "memory"
            : segment === "worker-evidence"
              ? "sessions"
              : "always",
        maxTokens:
          segment === "task-brief"
            ? 8_000
            : segment === "recent-turns"
              ? 6_000
              : 4_000,
        baselineBehavior:
          segment === "task-brief"
            ? "rehydrate-full"
            : "full-delta",
      })
    );
  definitions.push(
    define({
      sectionId: "prompt.role-system",
      lifecycle: "prompt-policy",
      routeId: "prompt-policy:role-system",
      owner: "packages/role-runtime/src/prompt-policy.ts",
      inputSchema: "RoleSlot + TeamThread",
      outputSchema: "system instruction text",
      authority: "instruction",
      requiredCapability: "always",
      maxTokens: 8_000,
      baselineBehavior: "static",
    }),
    define({
      sectionId: "prompt.output-contract",
      lifecycle: "prompt-policy",
      routeId: "prompt-policy:output-contract",
      owner: "packages/role-runtime/src/prompt-policy.ts",
      inputSchema: "RoleSlot + task",
      outputSchema: "output contract text",
      authority: "instruction",
      requiredCapability: "always",
      maxTokens: 2_000,
      baselineBehavior: "full-delta",
    }),
  );
  for (const group of Object.keys(
    TOOL_PROMPT_GROUP_SECTION_IDS,
  ) as ToolPromptSectionGroup[]) {
    definitions.push(
      define({
        sectionId: TOOL_PROMPT_GROUP_SECTION_IDS[group],
        lifecycle: "tool-harness",
        routeId: `tool-harness:${group}`,
        owner:
          "packages/role-runtime/src/tool-capability-registry.ts",
        inputSchema: "executable tool capability records",
        outputSchema: "tool guidance text",
        authority: "instruction",
        requiredCapability:
          group === "general" ? "always" : group,
        maxTokens: group === "sessions" ? 8_000 : 4_000,
        baselineBehavior: "static",
      }),
    );
  }
  definitions.push(
    define({
      sectionId: "prompt.dynamic-context",
      lifecycle: "dynamic-context",
      routeId: "dynamic-context:full-delta",
      owner:
        "packages/role-runtime/src/context/dynamic-context-baseline.ts",
      inputSchema: "RolePromptPacket + baseline receipts",
      outputSchema: "turnkeyai.dynamic_context.v1",
      authority: "context-projection",
      requiredCapability: "dynamic-context",
      maxTokens: 32_000,
      baselineBehavior: "full-delta",
    }),
    define({
      sectionId: "prompt.context-checkpoint",
      lifecycle: "compaction",
      routeId: "compaction:checkpoint-projection",
      owner:
        "packages/role-runtime/src/react-engine/compaction-controller.ts",
      inputSchema: "ContextCheckpointRecord",
      outputSchema: "turnkeyai.context_checkpoint.v2 projection",
      authority: "context-projection",
      requiredCapability: "compaction",
      maxTokens: 12_000,
      baselineBehavior: "rehydrate-full",
    }),
    define({
      sectionId: "prompt.checkpoint-summary",
      lifecycle: "compaction",
      routeId: "compaction:summary",
      owner:
        "packages/role-runtime/src/react-engine/runtime-checkpoint-summarizer.ts",
      inputSchema: "bounded ContextSourceGuard projection",
      outputSchema: "RuntimeCheckpointDraft",
      authority: "model-advisory",
      requiredCapability: "compaction",
      maxTokens: 16_000,
      baselineBehavior: "ephemeral",
    }),
    define({
      sectionId: "prompt.runtime-repair",
      lifecycle: "runtime-repair",
      routeId: "runtime-repair:policy",
      owner:
        "packages/role-runtime/src/runtime-policy/prompt-renderers.ts",
      inputSchema: "typed runtime facts",
      outputSchema: "bounded repair instruction",
      authority: "model-advisory",
      requiredCapability: "always",
      maxTokens: 8_000,
      baselineBehavior: "ephemeral",
    }),
  );
  return definitions;
}

function define(input: {
  sectionId: string;
  lifecycle: PromptSectionLifecycle;
  routeId: string;
  owner: string;
  inputSchema: string;
  outputSchema: string;
  authority: PromptSectionAuthority;
  requiredCapability: string;
  maxTokens: number;
  baselineBehavior: PromptSectionBaselineBehavior;
}): PromptSectionDefinition {
  const authorityKey = `prompt-section:${input.sectionId}`;
  const tokenPolicy = {
    mode: "bounded" as const,
    maxTokens: input.maxTokens,
  };
  return {
    protocol: PROMPT_REGISTRY_PROTOCOL,
    sectionId: input.sectionId,
    // Content-addressed version: derived from this section's declared contract
    // (owner, routes, schemas, authority, capability, token policy, baseline
    // behavior). Any registry-content drift changes the patch component, so a
    // stale receipt in a runtime journal becomes detectable by version mismatch.
    version: deriveContentVersion({
      sectionId: input.sectionId,
      lifecycle: input.lifecycle,
      routeId: input.routeId,
      owner: input.owner,
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      authority: input.authority,
      authorityKey,
      requiredCapability: input.requiredCapability,
      tokenPolicy,
      baselineBehavior: input.baselineBehavior,
    }),
    owner: input.owner,
    lifecycle: input.lifecycle,
    routeId: input.routeId,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    authority: input.authority,
    authorityKey,
    requiredCapability: input.requiredCapability,
    tokenPolicy,
    baselineBehavior: input.baselineBehavior,
  };
}

/**
 * Derive a deterministic, semver-shaped version from a section's declared
 * contract. The major/minor stay pinned at `1.0` (the registry protocol shape)
 * while the patch component is a stable 24-bit digest of the contract content.
 * Editing any contract field (schema, authority, token budget, owner, ...)
 * shifts the patch, making registry-content drift observable in receipts.
 */
function deriveContentVersion(
  contract: Omit<PromptSectionDefinition, "protocol" | "version">,
): string {
  const digest = createHash("sha1")
    .update(
      JSON.stringify({
        sectionId: contract.sectionId,
        lifecycle: contract.lifecycle,
        routeId: contract.routeId,
        owner: contract.owner,
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        authority: contract.authority,
        authorityKey: contract.authorityKey,
        requiredCapability: contract.requiredCapability,
        tokenPolicy: contract.tokenPolicy,
        baselineBehavior: contract.baselineBehavior,
      }),
    )
    .digest("hex")
    .slice(0, 6);
  return `1.0.${parseInt(digest, 16)}`;
}

function validateDefinition(definition: PromptSectionDefinition): void {
  if (definition.protocol !== PROMPT_REGISTRY_PROTOCOL) {
    throw new Error(`invalid prompt section protocol: ${definition.sectionId}`);
  }
  if (
    !definition.sectionId.trim() ||
    !definition.owner.trim() ||
    !definition.routeId.trim() ||
    !definition.inputSchema.trim() ||
    !definition.outputSchema.trim() ||
    !definition.authorityKey.trim() ||
    !definition.requiredCapability.trim()
  ) {
    throw new Error(`incomplete prompt section definition: ${definition.sectionId}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(definition.version)) {
    throw new Error(`invalid prompt section version: ${definition.sectionId}`);
  }
  if (
    definition.tokenPolicy.maxTokens !== undefined &&
    (!Number.isFinite(definition.tokenPolicy.maxTokens) ||
      definition.tokenPolicy.maxTokens <= 0)
  ) {
    throw new Error(`invalid prompt token policy: ${definition.sectionId}`);
  }
}

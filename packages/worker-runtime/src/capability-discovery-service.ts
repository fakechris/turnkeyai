import type {
  ApiCapabilityState,
  CapabilityDiscoveryService,
  CapabilityInspectionInput,
  CapabilityInspectionResult,
  ConnectorCapabilityState,
  SkillCapabilityState,
  TransportKind,
  TransportPreference,
  WorkerKind,
} from "@turnkeyai/core-types/team";

interface ConnectorConfig {
  provider: string;
  capability?: string;
  available?: boolean;
  authorized?: boolean;
  authEnvVar?: string;
}

interface ApiConfig {
  name: string;
  capability?: string;
  requiredEnvVars?: string[];
}

interface SkillConfig {
  skillId: string;
  capability?: string;
  installed: boolean;
}

interface DefaultCapabilityDiscoveryServiceOptions {
  availableWorkers: WorkerKind[] | (() => WorkerKind[] | Promise<WorkerKind[]>);
  connectors?: ConnectorConfig[];
  apis?: ApiConfig[];
  skills?: SkillConfig[];
  transportPreferences?: Record<string, TransportKind[]>;
  now?: () => number;
}

export class DefaultCapabilityDiscoveryService implements CapabilityDiscoveryService {
  private readonly availableWorkers: DefaultCapabilityDiscoveryServiceOptions["availableWorkers"];
  private readonly connectors: ConnectorConfig[];
  private readonly apis: ApiConfig[];
  private readonly skills: SkillConfig[];
  private readonly transportPreferences: Record<string, TransportKind[]>;
  private readonly now: () => number;

  constructor(options: DefaultCapabilityDiscoveryServiceOptions) {
    this.availableWorkers = options.availableWorkers;
    this.connectors = options.connectors ?? defaultConnectors();
    this.apis = options.apis ?? defaultApis();
    this.skills = options.skills ?? [];
    this.transportPreferences = options.transportPreferences ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  async inspect(input: CapabilityInspectionInput): Promise<CapabilityInspectionResult> {
    const requested = normalizeCapabilities(input.requestedCapabilities);
    const availableWorkers = await this.resolveAvailableWorkers();

    const connectorStates = this.connectors
      .filter((entry) => isCapabilityRelevant(entry.capability, entry.provider, requested))
      .map((entry) => resolveConnectorState(entry));

    const apiStates = this.apis
      .filter((entry) => isCapabilityRelevant(entry.capability, entry.name, requested))
      .map((entry) => resolveApiState(entry));

    const skillStates = this.skills
      .filter((entry) => isCapabilityRelevant(entry.capability, entry.skillId, requested))
      .map((entry) => ({
        skillId: entry.skillId,
        installed: entry.installed,
      }));

    const transportPreferences = requested.map((capability) =>
      resolveTransportPreference(capability, this.transportPreferences[capability])
    );

    return {
      availableWorkers,
      connectorStates,
      apiStates,
      skillStates,
      transportPreferences,
      unavailableCapabilities: requested.filter(
        (capability) =>
          !availableWorkers.includes(capability as WorkerKind) &&
          !this.connectors.some(
            (entry) =>
              isCapabilityRelevant(entry.capability, entry.provider, [capability]) &&
              resolveConnectorState(entry).available
          ) &&
          !this.apis.some(
            (entry) =>
              isCapabilityRelevant(entry.capability, entry.name, [capability]) &&
              resolveApiState(entry).configured
          ) &&
          !this.skills.some(
            (entry) => isCapabilityRelevant(entry.capability, entry.skillId, [capability]) && entry.installed
          )
      ),
      generatedAt: this.now(),
    };
  }

  private async resolveAvailableWorkers(): Promise<WorkerKind[]> {
    if (typeof this.availableWorkers === "function") {
      const resolved = await this.availableWorkers();
      return [...resolved];
    }

    return [...this.availableWorkers];
  }
}

function normalizeCapabilities(input: string[]): string[] {
  return [...new Set(input.map((item) => item.trim()).filter((item) => item.length > 0))];
}

function isCapabilityRelevant(capability: string | undefined, fallback: string, requested: string[]): boolean {
  if (requested.length === 0) {
    return true;
  }

  return requested.includes(capability ?? fallback);
}

function resolveConnectorState(input: ConnectorConfig): ConnectorCapabilityState {
  const authorized =
    input.authorized ??
    (input.authEnvVar ? Boolean(process.env[input.authEnvVar]?.trim()) : false);
  const available = input.available ?? (authorized || !input.authEnvVar);
  const issues: string[] = [];
  const suggestedActions: string[] = [];

  if (!available) {
    issues.push(`${input.provider} connector is unavailable`);
  }
  if (!authorized) {
    issues.push(`${input.provider} connector is not authorized`);
    if (input.authEnvVar) {
      suggestedActions.push(`set ${input.authEnvVar}`);
    }
  }

  return {
    provider: input.provider,
    available,
    authorized,
    ...(issues.length > 0 ? { issues } : {}),
    ...(suggestedActions.length > 0 ? { suggestedActions } : {}),
  };
}

function resolveApiState(input: ApiConfig): ApiCapabilityState {
  const requiredEnvVars = input.requiredEnvVars ?? [];
  const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]?.trim());
  const configured = missingEnvVars.length === 0;
  const issues = configured ? [] : missingEnvVars.map((name) => `missing ${name}`);

  return {
    name: input.name,
    configured,
    ready: configured,
    ...(issues.length > 0 ? { issues } : {}),
    ...(issues.length > 0 ? { suggestedActions: missingEnvVars.map((name) => `set ${name}`) } : {}),
  };
}

function resolveTransportPreference(
  capability: string,
  override: TransportKind[] | undefined
): TransportPreference {
  if (override && override.length > 0) {
    return {
      capability,
      orderedTransports: override,
    };
  }

  if (capability === "browser") {
    return {
      capability,
      orderedTransports: ["browser"],
    };
  }

  if (/research|explore/i.test(capability)) {
    return {
      capability,
      orderedTransports: ["official_api", "business_tool", "browser"],
    };
  }

  if (/shopify|publish|catalog|listing|social|marketing/i.test(capability)) {
    return {
      capability,
      orderedTransports: ["official_api", "business_tool", "browser"],
    };
  }

  return {
    capability,
    orderedTransports: ["business_tool", "official_api", "browser"],
  };
}

function defaultConnectors(): ConnectorConfig[] {
  return [
    { provider: "browser", available: true, authorized: true, capability: "browser" },
    { provider: "shopify", capability: "shopify", authEnvVar: "SHOPIFY_ACCESS_TOKEN" },
    { provider: "x", capability: "social-publish", authEnvVar: "X_API_KEY" },
    { provider: "instagram", capability: "social-publish", authEnvVar: "INSTAGRAM_ACCESS_TOKEN" },
    { provider: "google-workspace", capability: "workspace", authEnvVar: "GOOGLE_WORKSPACE_CLIENT_ID" },
    { provider: "exa", capability: "research", authEnvVar: "EXA_API_KEY" },
  ];
}

function defaultApis(): ApiConfig[] {
  return [
    { name: "shopify-admin", capability: "shopify", requiredEnvVars: ["SHOPIFY_STORE_URL", "SHOPIFY_ACCESS_TOKEN"] },
    { name: "exa-search", capability: "research", requiredEnvVars: ["EXA_API_KEY"] },
    { name: "x-publish", capability: "social-publish", requiredEnvVars: ["X_API_KEY"] },
    {
      name: "instagram-publish",
      capability: "social-publish",
      requiredEnvVars: ["INSTAGRAM_ACCESS_TOKEN"],
    },
  ];
}

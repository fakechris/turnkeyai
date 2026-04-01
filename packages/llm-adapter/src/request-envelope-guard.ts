import type { GenerateTextInput, ModelProtocol, RequestEnvelopeDiagnostics, ResolvedModelConfig } from "./types";

export interface RequestEnvelopeLimits {
  maxMessages: number;
  maxPromptChars: number;
  maxPromptBytes: number;
  maxMetadataBytes: number;
  maxArtifactCount: number;
  maxToolCount: number;
  maxToolSchemaBytes: number;
  maxToolResultCount: number;
  maxToolResultBytes: number;
  maxInlineAttachmentBytes: number;
  maxInlineImageCount: number;
  maxInlineImageBytes: number;
  maxInlinePdfCount: number;
  maxInlinePdfBytes: number;
  maxMultimodalPartCount: number;
  maxSerializedBytes: number;
}

export const DEFAULT_REQUEST_ENVELOPE_LIMITS: RequestEnvelopeLimits = {
  maxMessages: 16,
  maxPromptChars: 120_000,
  maxPromptBytes: 180_000,
  maxMetadataBytes: 24_000,
  maxArtifactCount: 24,
  maxToolCount: 16,
  maxToolSchemaBytes: 64_000,
  maxToolResultCount: 12,
  maxToolResultBytes: 40_000,
  maxInlineAttachmentBytes: 2_000_000,
  maxInlineImageCount: 8,
  maxInlineImageBytes: 1_500_000,
  maxInlinePdfCount: 2,
  maxInlinePdfBytes: 1_500_000,
  maxMultimodalPartCount: 24,
  maxSerializedBytes: 220_000,
};

const OPENAI_SAFE_LIMITS: Partial<RequestEnvelopeLimits> = {
  maxToolCount: 16,
  maxToolSchemaBytes: 72_000,
  maxToolResultCount: 12,
  maxToolResultBytes: 48_000,
  maxInlineAttachmentBytes: 2_500_000,
  maxInlineImageCount: 10,
  maxInlineImageBytes: 2_000_000,
  maxInlinePdfCount: 3,
  maxInlinePdfBytes: 2_000_000,
  maxMultimodalPartCount: 20,
  maxSerializedBytes: 240_000,
};

const ANTHROPIC_SAFE_LIMITS: Partial<RequestEnvelopeLimits> = {
  maxToolCount: 12,
  maxToolSchemaBytes: 56_000,
  maxToolResultCount: 10,
  maxToolResultBytes: 36_000,
  maxInlineAttachmentBytes: 1_500_000,
  maxInlineImageCount: 6,
  maxInlineImageBytes: 1_000_000,
  maxInlinePdfCount: 2,
  maxInlinePdfBytes: 1_200_000,
  maxMultimodalPartCount: 12,
  maxSerializedBytes: 200_000,
};

export class RequestEnvelopeOverflowError extends Error {
  readonly code = "REQUEST_ENVELOPE_OVERFLOW";
  readonly retryable = false;
  readonly details: {
    diagnostics: RequestEnvelopeDiagnostics;
    limits: RequestEnvelopeLimits;
    source: "local_guard" | "provider";
    providerStatus?: number;
    providerMessage?: string;
  };

  constructor(input: {
    diagnostics: RequestEnvelopeDiagnostics;
    limits?: Partial<RequestEnvelopeLimits>;
    source?: "local_guard" | "provider";
    providerStatus?: number;
    providerMessage?: string;
  }) {
    const limits = {
      ...DEFAULT_REQUEST_ENVELOPE_LIMITS,
      ...(input.limits ?? {}),
    };
    const over = input.diagnostics.overLimitKeys.join(", ");
    super(
      `request envelope exceeds safe limits: ${over} | messages=${input.diagnostics.messageCount} promptBytes=${input.diagnostics.promptBytes} totalBytes=${input.diagnostics.totalSerializedBytes} artifacts=${input.diagnostics.artifactCount}`
    );
    this.name = "RequestEnvelopeOverflowError";
    this.details = {
      diagnostics: input.diagnostics,
      limits,
      source: input.source ?? "local_guard",
      ...(input.providerStatus != null ? { providerStatus: input.providerStatus } : {}),
      ...(input.providerMessage ? { providerMessage: input.providerMessage } : {}),
    };
  }
}

export function buildRequestEnvelopeDiagnostics(
  input: GenerateTextInput,
  limits?: Partial<RequestEnvelopeLimits>
): RequestEnvelopeDiagnostics {
  const resolvedLimits = {
    ...DEFAULT_REQUEST_ENVELOPE_LIMITS,
    ...(limits ?? {}),
  };
  const promptChars = input.messages.reduce((total, item) => total + item.content.length, 0);
  const promptBytes = Buffer.byteLength(
    JSON.stringify(
      input.messages.map((item) => ({
        role: item.role,
        content: item.content,
      }))
    ),
    "utf8"
  );
  const metadataBytes = input.metadata ? Buffer.byteLength(JSON.stringify(input.metadata), "utf8") : 0;
  const artifactCount = input.envelope?.artifactIds?.length ?? 0;
  const toolCount = input.envelope?.toolCount ?? 0;
  const toolSchemaBytes = input.envelope?.toolSchemaBytes ?? 0;
  const toolResultCount = input.envelope?.toolResultCount ?? 0;
  const toolResultBytes = input.envelope?.toolResultBytes ?? 0;
  const inlineAttachmentBytes = input.envelope?.inlineAttachmentBytes ?? 0;
  const inlineImageCount = input.envelope?.inlineImageCount ?? 0;
  const inlineImageBytes = input.envelope?.inlineImageBytes ?? 0;
  const inlinePdfCount = input.envelope?.inlinePdfCount ?? 0;
  const inlinePdfBytes = input.envelope?.inlinePdfBytes ?? 0;
  const multimodalPartCount = input.envelope?.multimodalPartCount ?? 0;
  const totalSerializedBytes = Buffer.byteLength(
    JSON.stringify({
      modelId: input.modelId,
      messages: input.messages,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      metadata: input.metadata,
      envelope: input.envelope,
    }),
    "utf8"
  );

  const diagnostics: RequestEnvelopeDiagnostics = {
    messageCount: input.messages.length,
    promptChars,
    promptBytes,
    metadataBytes,
    artifactCount,
    toolCount,
    toolSchemaBytes,
    toolResultCount,
    toolResultBytes,
    inlineAttachmentBytes,
    inlineImageCount,
    inlineImageBytes,
    inlinePdfCount,
    inlinePdfBytes,
    multimodalPartCount,
    totalSerializedBytes,
    overLimitKeys: [],
  };

  if (diagnostics.messageCount > resolvedLimits.maxMessages) {
    diagnostics.overLimitKeys.push("messageCount");
  }
  if (diagnostics.promptChars > resolvedLimits.maxPromptChars) {
    diagnostics.overLimitKeys.push("promptChars");
  }
  if (diagnostics.promptBytes > resolvedLimits.maxPromptBytes) {
    diagnostics.overLimitKeys.push("promptBytes");
  }
  if (diagnostics.metadataBytes > resolvedLimits.maxMetadataBytes) {
    diagnostics.overLimitKeys.push("metadataBytes");
  }
  if (diagnostics.artifactCount > resolvedLimits.maxArtifactCount) {
    diagnostics.overLimitKeys.push("artifactCount");
  }
  if (diagnostics.toolCount > resolvedLimits.maxToolCount) {
    diagnostics.overLimitKeys.push("toolCount");
  }
  if (diagnostics.toolSchemaBytes > resolvedLimits.maxToolSchemaBytes) {
    diagnostics.overLimitKeys.push("toolSchemaBytes");
  }
  if (diagnostics.toolResultCount > resolvedLimits.maxToolResultCount) {
    diagnostics.overLimitKeys.push("toolResultCount");
  }
  if (diagnostics.toolResultBytes > resolvedLimits.maxToolResultBytes) {
    diagnostics.overLimitKeys.push("toolResultBytes");
  }
  if (diagnostics.inlineAttachmentBytes > resolvedLimits.maxInlineAttachmentBytes) {
    diagnostics.overLimitKeys.push("inlineAttachmentBytes");
  }
  if (diagnostics.inlineImageCount > resolvedLimits.maxInlineImageCount) {
    diagnostics.overLimitKeys.push("inlineImageCount");
  }
  if (diagnostics.inlineImageBytes > resolvedLimits.maxInlineImageBytes) {
    diagnostics.overLimitKeys.push("inlineImageBytes");
  }
  if (diagnostics.inlinePdfCount > resolvedLimits.maxInlinePdfCount) {
    diagnostics.overLimitKeys.push("inlinePdfCount");
  }
  if (diagnostics.inlinePdfBytes > resolvedLimits.maxInlinePdfBytes) {
    diagnostics.overLimitKeys.push("inlinePdfBytes");
  }
  if (diagnostics.multimodalPartCount > resolvedLimits.maxMultimodalPartCount) {
    diagnostics.overLimitKeys.push("multimodalPartCount");
  }
  if (diagnostics.totalSerializedBytes > resolvedLimits.maxSerializedBytes) {
    diagnostics.overLimitKeys.push("totalSerializedBytes");
  }

  return diagnostics;
}

export function resolveRequestEnvelopeLimits(
  model?: Pick<ResolvedModelConfig, "protocol" | "providerId" | "model"> | null,
  overrides?: Partial<RequestEnvelopeLimits>
): RequestEnvelopeLimits {
  const protocolPreset = resolveProtocolPreset(model?.protocol);
  const providerPreset = resolveProviderPreset(model?.providerId);
  return {
    ...DEFAULT_REQUEST_ENVELOPE_LIMITS,
    ...protocolPreset,
    ...providerPreset,
    ...(overrides ?? {}),
  };
}

const PROVIDER_SIZE_FAILURE_RE =
  /\b(request (?:entity )?too large|payload too large|context length|context window|max(?:imum)? context|prompt too long|too many tokens|input is too long|token limit|maximum input|input length|request size)\b/i;

export function isProviderSizeLikeFailure(input: { status?: number; message?: string }): boolean {
  if (input.status === 413) {
    return true;
  }
  return PROVIDER_SIZE_FAILURE_RE.test(input.message ?? "");
}

export function buildProviderRequestEnvelopeOverflowError(input: {
  request: GenerateTextInput;
  status?: number;
  message?: string;
  limits?: Partial<RequestEnvelopeLimits>;
  model?: Pick<ResolvedModelConfig, "protocol" | "providerId" | "model"> | null;
}): RequestEnvelopeOverflowError {
  return new RequestEnvelopeOverflowError({
    diagnostics: buildRequestEnvelopeDiagnostics(input.request, resolveRequestEnvelopeLimits(input.model, input.limits)),
    source: "provider",
    limits: resolveRequestEnvelopeLimits(input.model, input.limits),
    ...(input.status != null ? { providerStatus: input.status } : {}),
    ...(input.message ? { providerMessage: input.message } : {}),
  });
}

export function assertRequestEnvelopeWithinLimits(
  input: GenerateTextInput,
  limits?: Partial<RequestEnvelopeLimits>,
  model?: Pick<ResolvedModelConfig, "protocol" | "providerId" | "model"> | null
): RequestEnvelopeDiagnostics {
  const resolvedLimits = resolveRequestEnvelopeLimits(model, limits);
  const diagnostics = buildRequestEnvelopeDiagnostics(input, resolvedLimits);
  if (diagnostics.overLimitKeys.length > 0) {
    throw new RequestEnvelopeOverflowError(
      {
        diagnostics,
        limits: resolvedLimits,
      }
    );
  }
  return diagnostics;
}

function resolveProtocolPreset(protocol: ModelProtocol | undefined): Partial<RequestEnvelopeLimits> {
  switch (protocol) {
    case "anthropic-compatible":
      return ANTHROPIC_SAFE_LIMITS;
    case "openai-compatible":
      return OPENAI_SAFE_LIMITS;
    default:
      return {};
  }
}

function resolveProviderPreset(providerId: string | undefined): Partial<RequestEnvelopeLimits> {
  const normalized = providerId?.toLowerCase() ?? "";
  if (normalized.includes("anthropic") || normalized.includes("claude")) {
    return ANTHROPIC_SAFE_LIMITS;
  }
  if (normalized.includes("openai") || normalized.includes("gpt")) {
    return OPENAI_SAFE_LIMITS;
  }
  return {};
}

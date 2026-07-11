export type ModelProtocol = "openai-compatible" | "anthropic-compatible";
export type ModelApiType = "openai" | "anthropic";

export interface ModelConfigEntry {
  id: string;
  label: string;
  providerId: string;
  protocol: ModelProtocol;
  model: string;
  baseURL?: string;
  baseURLEnv?: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  contextWindowTokens?: number;
  promptCacheMode?: "off" | "active";
  aliases?: string[];
  enabled?: boolean;
}

export interface ModelChainEntry {
  id: string;
  primary: string;
  fallbacks?: string[];
  aliases?: string[];
  enabled?: boolean;
}

export interface NamedModelConfigEntry extends Omit<ModelConfigEntry, "id" | "protocol"> {
  id?: string;
  protocol?: ModelProtocol;
  apiType?: ModelApiType | ModelProtocol;
}

export interface NamedModelChainEntry extends Omit<ModelChainEntry, "id"> {
  id?: string;
}

export interface ModelCatalog {
  defaultModelId?: string;
  defaultModelChainId?: string;
  models: ModelConfigEntry[] | Record<string, NamedModelConfigEntry>;
  modelChains?: ModelChainEntry[] | Record<string, NamedModelChainEntry>;
}

export interface ResolvedModelConfig extends Omit<ModelConfigEntry, "baseURL"> {
  baseURL: string;
  apiKey: string;
}

export interface ModelSelection {
  chainId?: string;
  primaryModelId: string;
  fallbackModelIds: string[];
}

export interface LLMTextBlock {
  type: "text";
  text: string;
}

export interface LLMToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock | LLMToolResultBlock;

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | LLMContentBlock[];
  /** Provider-neutral link from a tool result message to the model's tool call. */
  toolCallId?: string;
  /** Optional tool/function name for OpenAI-compatible tool messages. */
  name?: string;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LLMToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      name: string;
    };

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RequestEnvelopeHint {
  artifactIds?: string[];
  toolCount?: number;
  toolSchemaBytes?: number;
  toolResultCount?: number;
  toolResultBytes?: number;
  inlineAttachmentBytes?: number;
  inlineImageCount?: number;
  inlineImageBytes?: number;
  inlinePdfCount?: number;
  inlinePdfBytes?: number;
  multimodalPartCount?: number;
}

export interface RequestEnvelopeDiagnostics {
  messageCount: number;
  promptChars: number;
  promptBytes: number;
  metadataBytes: number;
  artifactCount: number;
  toolCount: number;
  toolSchemaBytes: number;
  toolResultCount: number;
  toolResultBytes: number;
  inlineAttachmentBytes: number;
  inlineImageCount: number;
  inlineImageBytes: number;
  inlinePdfCount: number;
  inlinePdfBytes: number;
  multimodalPartCount: number;
  totalSerializedBytes: number;
  estimatedInputTokens?: number;
  inputTokenLimit?: number;
  overLimitKeys: Array<
    | "messageCount"
    | "promptChars"
    | "promptBytes"
    | "metadataBytes"
    | "artifactCount"
    | "toolCount"
    | "toolSchemaBytes"
    | "toolResultCount"
    | "toolResultBytes"
    | "inlineAttachmentBytes"
    | "inlineImageCount"
    | "inlineImageBytes"
    | "inlinePdfCount"
    | "inlinePdfBytes"
    | "multimodalPartCount"
    | "totalSerializedBytes"
    | "estimatedInputTokens"
  >;
}

export interface GenerateTextInput {
  modelId?: string;
  modelChainId?: string;
  signal?: AbortSignal;
  /** Absolute runtime deadline shared by every physical provider attempt. */
  deadlineAt?: number;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  toolChoice?: LLMToolChoice;
  temperature?: number;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
  envelope?: RequestEnvelopeHint;
  /** Internal provider transport heartbeat used to reset the gateway idle timer. */
  onProviderActivity?: (activity?: ProviderActivityKind) => void;
  /** Internal physical-provider lifecycle signal for durable runtime tracing. */
  onProviderLifecycle?: (
    event: ProviderLifecycleEvent,
  ) => void | Promise<void>;
}

export type ProviderActivityKind = "headers" | "body" | "event";

interface ProviderLifecycleEventBase {
  at: number;
  attempt: number;
  modelId: string;
  providerId: string;
  protocol: ModelProtocol;
}

export type ProviderLifecycleEvent =
  | (ProviderLifecycleEventBase & { kind: "attempt_started" })
  | (ProviderLifecycleEventBase & {
      kind: "activity";
      activity: ProviderActivityKind;
    })
  | (ProviderLifecycleEventBase & {
      kind: "attempt_failed";
      code: string;
      message: string;
      retryable: boolean;
    })
  | (ProviderLifecycleEventBase & {
      kind: "retry_wait";
      code: string;
      retry: number;
      delayMs: number;
    })
  | (ProviderLifecycleEventBase & { kind: "attempt_completed" });

export type ProviderRequestErrorCode =
  | "authentication"
  | "not_found"
  | "rate_limit"
  | "server_error"
  | "network_error"
  | "timeout"
  | "deadline_exceeded"
  | "provider_error";

export class ProviderRequestError extends Error {
  readonly status: number | undefined;
  readonly code: ProviderRequestErrorCode;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    input: {
      status?: number;
      code: ProviderRequestErrorCode;
      retryAfterMs?: number;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = input.status;
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs;
    this.retryable = input.retryable;
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}

export interface ModelRetryDiagnostics {
  modelId: string;
  attempts: number;
  retries: number;
  errors: string[];
}

export interface RetryDiagnostics {
  totalAttempts: number;
  totalRetries: number;
  models: ModelRetryDiagnostics[];
}

export interface LLMTokenUsage {
  inputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  contentBlocks?: LLMContentBlock[];
  toolCalls?: LLMToolCall[];
  modelId: string;
  modelChainId?: string;
  providerId: string;
  protocol: ModelProtocol;
  adapterName: string;
  attemptedModelIds?: string[];
  stopReason?: string;
  usage?: LLMTokenUsage;
  requestEnvelope?: RequestEnvelopeDiagnostics;
  retryDiagnostics?: RetryDiagnostics;
  raw: unknown;
}

export interface ProtocolClient {
  supports(protocol: ModelProtocol): boolean;
  generate(model: ResolvedModelConfig, input: GenerateTextInput): Promise<GenerateTextResult>;
}

export interface ModelCatalogSource {
  load(): Promise<ModelCatalog>;
}
